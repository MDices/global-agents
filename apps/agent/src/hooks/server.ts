import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentEvent } from "@global-agents/protocol";
import { z } from "zod";
import { isTeammatePayload, mapHookPayload } from "./mapper.js";

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
  lookupName: (sessionId: string) => string | undefined;
  onEvents: (evs: AgentEvent[]) => void;
  onPermission?: (payload: PermissionPayload, respond: (d: HookDecision | null) => void) => void;
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
      pending.add(res);
      res.on("close", () => pending.delete(res));
      const respond = (d: HookDecision | null): void => {
        if (!pending.delete(res)) return;
        if (d === null) send(res, 204);
        else send(res, 200, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } });
      };
      try {
        opts.onPermission(permission, respond);
      } catch {
        respond(null);
      }
      return;
    }

    send(res, 204);
    if (isTeammatePayload(payload)) return; // teammates de um time: tratamento completo na T29
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
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
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
