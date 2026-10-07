import { EventEmitter } from "node:events";
import { isIP, type createConnection } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { parseLine, RelayCommandSchema, serialize, type AgentEvent, type RelayCommand } from "@global-agents/protocol";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import type { Outbox } from "./outbox.js";

export interface RelayClientOptions {
  /** `wss://<ip>:8443/ws`. */
  url: string;
  token: string;
  /** SHA-256 do certificado autoassinado do relay (`AA:BB:…`, sem diferenciar maiúsculas). */
  certFingerprint?: string;
  outbox: Outbox;
  /** Gera o `agent.hello` enviado no início de cada conexão. */
  hello: () => AgentEvent;
  backoff?: { minMs?: number; maxMs?: number };
  pingMs?: number;
}

export interface RelayClientEvents {
  command: [RelayCommand];
  connected: [];
  disconnected: [];
  warning: [string];
}

/**
 * `createConnection` para o `ws` que fixa o certificado pelo fingerprint SHA-256.
 *
 * Não dá para usar `checkServerIdentity`: o Node só o chama depois que a cadeia valida, e um certificado
 * autoassinado nunca valida — com `rejectUnauthorized: false` ele simplesmente não é chamado. Aqui o handshake
 * TLS aceita qualquer certificado e, no `secureConnect` (antes de qualquer byte do pedido HTTP, que carrega o
 * token, ser escrito), compara o fingerprint e destrói o socket se não conferir.
 */
function pinnedConnect(expected: string): (opts: ConnectionOptions) => TLSSocket {
  const want = expected.toUpperCase();
  return (opts) => {
    const o: ConnectionOptions = { ...opts, rejectUnauthorized: false };
    // Igual ao tlsConnect do próprio ws: sem `path` e sem SNI para IP (evita o DEP0123).
    delete o.path;
    if (!o.servername && o.servername !== "" && o.host !== undefined) o.servername = isIP(o.host) ? "" : o.host;
    const socket = tlsConnect(o);
    socket.once("secureConnect", () => {
      const got = socket.getPeerCertificate().fingerprint256;
      if (got?.toUpperCase() !== want) socket.destroy(new Error(`fingerprint do certificado do relay não confere (esperado ${expected}, recebido ${got ?? "nenhum"})`));
    });
    return socket;
  };
}

function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * Conexão de saída com o relay. Ordem garantida a cada (re)conexão: `hello`, depois o outbox em ordem, e só então
 * os eventos novos — até o outbox esvaziar, `send()` grava no outbox em vez de escrever no socket.
 */
export class RelayClient extends EventEmitter<RelayClientEvents> {
  private readonly url: string;
  private readonly wsOptions: ClientOptions;
  private readonly outbox: Outbox;
  private readonly makeHello: () => AgentEvent;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly pingMs: number;

  private ws: WebSocket | undefined;
  /** Socket aberto, hello enviado e outbox drenado. */
  private ready = false;
  private started = false;
  private stopped = false;
  private nextDelay: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private awaitingPong = false;

  constructor(opts: RelayClientOptions) {
    super();
    this.url = opts.url;
    this.outbox = opts.outbox;
    this.makeHello = opts.hello;
    this.minMs = opts.backoff?.minMs ?? 1000;
    this.maxMs = opts.backoff?.maxMs ?? 60_000;
    this.pingMs = opts.pingMs ?? 30_000;
    this.nextDelay = this.minMs;
    this.wsOptions = { headers: { Authorization: `Bearer ${opts.token}` } };
    if (opts.certFingerprint !== undefined) {
      this.wsOptions.rejectUnauthorized = false;
      // @types/ws tipa como `typeof net.createConnection` (sobrecargas); o ws só usa a forma (opções) → socket.
      this.wsOptions.createConnection = pinnedConnect(opts.certFingerprint) as unknown as typeof createConnection;
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    const ws = this.ws;
    if (ws === undefined) return;
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }

  isConnected(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Escreve se a conexão está pronta; senão (ou se a escrita falhar) guarda no outbox. */
  send(ev: AgentEvent): void {
    const ws = this.ws;
    if (!this.ready || ws === undefined || ws.readyState !== WebSocket.OPEN) {
      this.outbox.append(ev);
      return;
    }
    ws.send(serialize(ev), (err) => { if (err) this.outbox.append(ev); });
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, this.wsOptions);
    } catch (e) {
      this.emit("warning", `relay: url inválida: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    this.ready = false;
    let opened = false;
    ws.on("error", (e) => { this.emit("warning", `relay: ${e.message}`); });
    ws.on("open", () => {
      if (this.ws !== ws) return;
      opened = true;
      this.nextDelay = this.minMs;
      this.startHeartbeat(ws);
      void this.handshake(ws);
    });
    ws.on("pong", () => { this.awaitingPong = false; });
    ws.on("message", (data) => { this.onMessage(data); });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.ready = false;
      this.stopHeartbeat();
      if (opened) this.emit("disconnected");
      this.scheduleReconnect();
    });
  }

  /** hello → outbox (repetindo enquanto chegarem eventos durante a drenagem) → pronto. */
  private async handshake(ws: WebSocket): Promise<void> {
    const sendRaw = (ev: AgentEvent): Promise<void> => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) { reject(new Error("relay desconectado")); return; }
      ws.send(serialize(ev), (err) => { if (err) reject(err); else resolve(); });
    });
    try {
      await sendRaw(this.makeHello());
      while (this.ws === ws && ws.readyState === WebSocket.OPEN && this.outbox.size() > 0) {
        const r = await this.outbox.drain(sendRaw);
        // Nada andou e ainda há conteúdo: o socket falhou ou o drain devolvido era o de uma conexão anterior
        // ainda em andamento. Derruba esta conexão para não ficar aberta sem nunca ficar pronta.
        if (r.sent === 0 && r.skipped === 0 && this.outbox.size() > 0) { if (this.ws === ws) ws.terminate(); return; }
      }
    } catch (e) {
      this.emit("warning", `relay: falha no envio inicial: ${(e as Error).message}`);
      if (this.ws === ws) ws.terminate();
      return;
    }
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    this.ready = true;
    this.emit("connected");
  }

  private onMessage(data: RawData): void {
    for (const line of toText(data).split("\n")) {
      if (line.trim() === "") continue;
      const r = parseLine(line);
      if (!r.ok) { this.emit("warning", `relay: linha inválida: ${r.error}`); continue; }
      const cmd = RelayCommandSchema.safeParse(r.message);
      if (cmd.success) this.emit("command", cmd.data);
      else this.emit("warning", `relay: mensagem não é um comando: ${r.message.type}`);
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        this.emit("warning", `relay: sem pong em ${this.pingMs} ms; reconectando`);
        ws.terminate();
        return;
      }
      this.awaitingPong = true;
      ws.ping();
    }, this.pingMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = Math.round(this.nextDelay * (0.8 + Math.random() * 0.4));
    this.nextDelay = Math.min(this.maxMs, this.nextDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
