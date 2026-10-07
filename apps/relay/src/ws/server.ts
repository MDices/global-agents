import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:https";
import type { Duplex } from "node:stream";
import { AgentEventSchema, parseLine, serialize, type AgentEvent, type RelayCommand } from "@global-agents/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { hashToken, type Db, type MachineMeta } from "../db.js";

export interface AgentHubOptions {
  db: Db;
  server: Server;
  /** Intervalo do ping de heartbeat; a conexão que não responder até o próximo é derrubada. */
  pingMs?: number;
}

export interface AgentHubEvents {
  event: [machine: string, event: AgentEvent];
  online: [machine: string];
  offline: [machine: string];
  warning: [message: string];
}

const WS_PATH = "/ws";
const STATUS_TEXT: Record<number, string> = { 401: "Unauthorized", 404: "Not Found" };

function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Recusa o upgrade com uma resposta HTTP de verdade (o cliente `ws` emite `unexpected-response`). */
function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}

/**
 * Hub das conexões dos agentes, pendurado no servidor HTTPS do relay.
 *
 * - O token (`Authorization: Bearer …`) é validado no evento `upgrade`, antes do handshake WebSocket: token
 *   ausente/desconhecido → HTTP 401; path diferente de `/ws` → HTTP 404. Recusar antes do upgrade (em vez de
 *   aceitar e fechar) evita que um agente mal configurado zere o backoff e reconecte a cada segundo.
 * - A conexão é associada à máquina do token assim que o upgrade é aceito; no máximo uma por máquina — a nova
 *   substitui a antiga, que é fechada com 4003. Todo envelope recebido precisa ter `machine` igual ao da máquina do
 *   token; se não tiver, a conexão é fechada com 4002.
 * - `online` só é emitido na transição offline→online (uma substituição não reemite); `offline` só quando fecha a
 *   conexão **atual** da máquina (o fechamento de uma conexão substituída é ignorado).
 * - Também responde `GET /health` → `200 {"ok":true}` (sem autenticação); qualquer outro request HTTP → 404.
 */
export class AgentHub extends EventEmitter<AgentHubEvents> {
  private readonly db: Db;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<string, WebSocket>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.handleUpgrade(req, socket, head);
  };
  private readonly onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    this.handleRequest(req, res);
  };
  private closed = false;

  constructor(opts: AgentHubOptions) {
    super();
    this.db = opts.db;
    this.server = opts.server;
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", this.onUpgrade);
    this.server.on("request", this.onRequest);
    this.heartbeat = setInterval(() => { this.tick(); }, opts.pingMs ?? 30_000);
    this.heartbeat.unref();
  }

  /** Envia um comando para a máquina; `false` se ela não tiver conexão aberta. */
  send(machine: string, cmd: RelayCommand): boolean {
    const ws = this.conns.get(machine);
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(serialize(cmd));
    return true;
  }

  isOnline(machine: string): boolean {
    return this.conns.get(machine)?.readyState === WebSocket.OPEN;
  }

  onlineMachines(): string[] {
    return [...this.conns.entries()].filter(([, ws]) => ws.readyState === WebSocket.OPEN).map(([m]) => m);
  }

  /** Para o heartbeat, solta os listeners do servidor e fecha todas as conexões (emitindo `offline`). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.server.off("upgrade", this.onUpgrade);
    this.server.off("request", this.onRequest);
    // Desassocia antes de fechar: os `close` assíncronos das conexões viram no-op (não tocam no banco depois).
    const conns = [...this.conns.entries()];
    this.conns.clear();
    for (const [machine, ws] of conns) {
      ws.close(1001, "relay encerrando");
      this.emit("offline", machine);
    }
    this.wss.close();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && pathOf(req) === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => { /* conexão caiu durante o upgrade; nada a fazer */ });
    if (this.closed) { socket.destroy(); return; }
    if (pathOf(req) !== WS_PATH) { rejectUpgrade(socket, 404); return; }
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    const token = m?.[1];
    const machine = token === undefined ? undefined : this.db.machines.getByTokenHash(hashToken(token))?.name;
    if (machine === undefined) {
      this.emit("warning", `conexão recusada de ${req.socket.remoteAddress ?? "?"}: token ausente ou inválido`);
      rejectUpgrade(socket, 401);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(machine, ws); });
  }

  private attach(machine: string, ws: WebSocket): void {
    const old = this.conns.get(machine);
    this.conns.set(machine, ws);
    this.alive.set(ws, true);
    this.touch(machine);

    ws.on("pong", () => { this.alive.set(ws, true); });
    ws.on("error", (e) => { this.emit("warning", `${machine}: ${e.message}`); });
    ws.on("message", (data) => { this.onMessage(machine, ws, data); });
    ws.on("close", () => {
      if (this.conns.get(machine) !== ws) return;
      this.conns.delete(machine);
      this.touch(machine);
      this.emit("offline", machine);
    });

    if (old === undefined) this.emit("online", machine);
    else old.close(4003, "substituída por nova conexão");
  }

  private onMessage(machine: string, ws: WebSocket, data: RawData): void {
    for (const line of toText(data).split("\n")) {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (line.trim() === "") continue;
      const r = parseLine(line);
      if (!r.ok) { this.emit("warning", `${machine}: linha inválida: ${r.error}`); continue; }
      if (r.message.machine !== machine) {
        this.emit("warning", `${machine}: envelope com machine "${r.message.machine}" diverge do token; fechando`);
        ws.close(4002, "machine do envelope não confere com o token");
        return;
      }
      const ev = AgentEventSchema.safeParse(r.message);
      if (!ev.success) { this.emit("warning", `${machine}: mensagem não é um evento de agente: ${r.message.type}`); continue; }
      this.touch(machine, ev.data.type === "agent.hello" ? helloMeta(ev.data) : undefined);
      this.emit("event", machine, ev.data);
    }
  }

  /** Atualiza `last_seen` (e metadados do hello); falha no banco vira `warning`, nunca derruba o processo. */
  private touch(machine: string, meta?: MachineMeta): void {
    try {
      this.db.machines.touch(machine, Date.now(), meta);
    } catch (e) {
      this.emit("warning", `${machine}: falha ao atualizar last_seen: ${(e as Error).message}`);
    }
  }

  private tick(): void {
    for (const ws of this.conns.values()) {
      if (this.alive.get(ws) !== true) { ws.terminate(); continue; }
      this.alive.set(ws, false);
      ws.ping();
    }
  }
}

function helloMeta(ev: Extract<AgentEvent, { type: "agent.hello" }>): MachineMeta {
  return {
    os: ev.os,
    ...(ev.claudeVersion !== undefined ? { claudeVersion: ev.claudeVersion } : {}),
    ...(ev.claudeAccount !== undefined ? { claudeAccount: ev.claudeAccount } : {}),
  };
}
