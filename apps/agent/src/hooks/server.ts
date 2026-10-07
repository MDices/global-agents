import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentEvent } from "@global-agents/protocol";
import { z } from "zod";
import { isTeammatePayload, mapHookPayload, type MapperContext } from "./mapper.js";

export interface PermissionPayload {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: unknown;
}

export interface HookDecision {
  behavior: "allow" | "deny";
}

export interface HookServerOptions {
  port: number;
  machine: string;
  lookupName: MapperContext["lookupName"];
  /** Sessão presente no inventário? Usado no filtro de teammates (padrão: nenhuma). */
  isKnownSession?: (sessionId: string) => boolean;
  onEvents: (evs: AgentEvent[]) => void;
  /**
   * Todo payload de hook (menos `PermissionRequest`), antes do mapper, com a classificação de teammate. Payload de
   * teammate vai só para cá: nunca vira `session.*`/`turn.*`.
   */
  onTeamPayload?: (payload: Record<string, unknown>, teammate: boolean) => void;
  /**
   * `PermissionRequest`: a resposta HTTP fica pendente até `respond`. `signal` aborta se o cliente (o script do hook)
   * desconectar antes de qualquer resposta — aí não há mais a quem responder. `close()` não aborta.
   */
  onPermission?: (payload: PermissionPayload, respond: (d: HookDecision | null) => void, signal: AbortSignal) => void;
}

export interface HookServer {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

const PermissionSchema = z
  .object({ session_id: z.string(), cwd: z.string(), tool_name: z.string(), tool_input: z.unknown(), permission_suggestions: z.unknown() })
  .passthrough();

function agentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

/** Mensagem do `EADDRINUSE` na porta dos hooks: quem usa a porta e como liberar, por plataforma. */
export function portInUseMessage(port: number, platform: NodeJS.Platform = process.platform): string {
  const como =
    platform === "win32"
      ? `No Windows, encerre o node.exe antigo do agente (o /End do Agendador não derruba o node filho) e inicie de novo:\n  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'dist.cli.js.{1,3}run' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\n  schtasks /Run /TN global-agents`
      : platform === "linux"
        ? "No Linux, reinicie o serviço: systemctl --user restart global-agents"
        : "Encerre o processo antigo do agente e inicie de novo.";
  return `a porta ${port} (127.0.0.1) dos hooks já está em uso: provavelmente já existe outro agente (ou outro programa) rodando nela. ${como}\nSe for outro programa, troque a porta com "port" no config.json.`;
}

export function startHookServer(opts: HookServerOptions): Promise<HookServer> {
  const version = agentVersion();
  const pending = new Set<ServerResponse>();

  const handleHook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req);
    if (raw === undefined) return send(res, 413);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return send(res, 400);
    }
    if (typeof payload !== "object" || payload === null) return send(res, 400);

    if ((payload as Record<string, unknown>)["hook_event_name"] === "PermissionRequest") {
      const perm = PermissionSchema.safeParse(payload);
      if (opts.onPermission === undefined || !perm.success) return send(res, 204);
      const p = perm.data;
      const permission: PermissionPayload = { session_id: p.session_id, cwd: p.cwd, tool_name: p.tool_name, tool_input: p.tool_input };
      if (p.permission_suggestions !== undefined) permission.permission_suggestions = p.permission_suggestions;
      const disconnected = new AbortController();
      pending.add(res);
      res.on("close", () => {
        if (pending.delete(res)) disconnected.abort();
      });
      const respond = (d: HookDecision | null): void => {
        if (!pending.delete(res)) return;
        if (d === null) send(res, 204);
        else send(res, 200, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } });
      };
      try {
        opts.onPermission(permission, respond, disconnected.signal);
      } catch {
        respond(null);
      }
      return;
    }

    send(res, 204);
    const teammate = isTeammatePayload(payload, opts.isKnownSession ?? (() => false));
    try {
      opts.onTeamPayload?.(payload as Record<string, unknown>, teammate);
    } catch {
      // idem: o painel do time nunca derruba o hook
    }
    if (teammate) return;
    const evs = mapHookPayload(payload, { machine: opts.machine, lookupName: opts.lookupName });
    if (evs.length > 0) {
      try {
        opts.onEvents(evs);
      } catch {
        // o hook nunca falha por causa de um consumidor com erro
      }
    }
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "POST" && path === "/hook") {
      handleHook(req, res).catch(() => send(res, 500));
    } else if (req.method === "GET" && path === "/health") {
      send(res, 200, { ok: true, version });
    } else {
      send(res, 404);
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => {
      reject((e as NodeJS.ErrnoException).code === "EADDRINUSE" ? new Error(portInUseMessage(opts.port), { cause: e }) : e);
    };
    server.once("error", onError);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", onError);
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const res of pending) {
              if (!res.headersSent) res.setHeader("connection", "close");
              send(res, 204);
            }
            pending.clear();
            server.close(() => done());
            server.closeIdleConnections();
          }),
      });
    });
  });
}
