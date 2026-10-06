import { randomUUID } from "node:crypto";
import { newEnvelope, type AgentEvent, type PermissionBehavior, type SessionInfo } from "@global-agents/protocol";
import type { HookDecision, PermissionPayload } from "../hooks/server.js";

const PREVIEW_MAX = 3500;
/** Sem ver a sessão `waiting`, a vigia do terminal só começa a valer depois disto (o inventário roda a cada 5 s). */
const ARM_AFTER_MS = 10_000;
/** Polls seguidos sem a sessão no inventário para considerar que ela acabou (decidido no terminal). */
const MISSING_POLLS = 2;

export interface PendingPermissionsOptions {
  machine: string;
  inventory: { find(sessionId: string): SessionInfo | undefined };
  emit: (ev: AgentEvent) => void;
  /** Expiração do pedido (padrão 30 min) → `deny`. */
  ttlMs?: number;
  /** Intervalo da vigia "decidido no terminal" (padrão 2 s). */
  terminalPollMs?: number;
}

type Outcome =
  | { by: "remote"; behavior: PermissionBehavior }
  | { by: "timeout" }
  | { by: "terminal"; respond: boolean }
  | { by: "close" };

interface Entry {
  requestId: string;
  sessionId: string;
  tool: string;
  respond: (d: HookDecision | null) => void;
  openedAt: number;
  armed: boolean;
  missing: number;
  ttl: NodeJS.Timeout;
  poll: NodeJS.Timeout;
  detach: () => void;
}

function truncate(s: string): string {
  return s.length <= PREVIEW_MAX ? s : `${s.slice(0, PREVIEW_MAX - 1)}…`;
}

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>)[key] : undefined;
}

/** Bash → o comando; demais ferramentas → JSON compacto do `tool_input`. Sempre `<= 3500` chars. */
export function inputPreview(tool: string, input: unknown): string {
  const command = field(input, "command");
  if (tool === "Bash" && typeof command === "string") return truncate(command);
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    json = undefined;
  }
  return truncate(json ?? "");
}

/**
 * Pedidos de permissão segurados (hook `PermissionRequest`). Cada um termina de um jeito só: decisão remota,
 * decisão no terminal (a sessão deixa de estar `waiting`), expiração (`deny`), desconexão do hook ou `close()`.
 * Nunca registra o conteúdo de `tool_input` (pode ter segredos).
 */
export class PendingPermissions {
  private readonly machine: string;
  private readonly inventory: PendingPermissionsOptions["inventory"];
  private readonly emit: (ev: AgentEvent) => void;
  private readonly ttlMs: number;
  private readonly terminalPollMs: number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: PendingPermissionsOptions) {
    this.machine = opts.machine;
    this.inventory = opts.inventory;
    this.emit = opts.emit;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.terminalPollMs = opts.terminalPollMs ?? 2000;
  }

  get size(): number {
    return this.entries.size;
  }

  open(payload: PermissionPayload, respond: (d: HookDecision | null) => void, signal?: AbortSignal): string {
    const requestId = randomUUID();
    const openedAt = Date.now();
    const description = field(payload.tool_input, "description");
    const onAbort = (): void => { this.settle(requestId, { by: "terminal", respond: false }); };
    const entry: Entry = {
      requestId,
      sessionId: payload.session_id,
      tool: payload.tool_name,
      respond,
      openedAt,
      armed: false,
      missing: 0,
      ttl: setTimeout(() => { this.settle(requestId, { by: "timeout" }); }, this.ttlMs).unref(),
      poll: setInterval(() => { this.check(requestId); }, this.terminalPollMs).unref(),
      detach: () => signal?.removeEventListener("abort", onAbort),
    };
    this.entries.set(requestId, entry);
    this.safeEmit({
      ...newEnvelope(this.machine),
      type: "permission.request",
      sessionId: payload.session_id,
      requestId,
      tool: payload.tool_name,
      description: typeof description === "string" ? description : "",
      inputPreview: inputPreview(payload.tool_name, payload.tool_input),
      expiresAt: new Date(openedAt + this.ttlMs).toISOString(),
    });
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return requestId;
  }

  /** `false` se o pedido não existe ou já foi resolvido. */
  decide(requestId: string, behavior: PermissionBehavior): boolean {
    return this.settle(requestId, { by: "remote", behavior });
  }

  /** Responde `null` (o prompt fica no terminal) a todos os pendentes, sem emitir nada. */
  close(): void {
    for (const id of [...this.entries.keys()]) this.settle(id, { by: "close" });
  }

  private check(requestId: string): void {
    const e = this.entries.get(requestId);
    if (e === undefined) return;
    const s = this.inventory.find(e.sessionId);
    if (!e.armed) {
      if (s?.status === "waiting") {
        e.armed = true;
        return;
      }
      if (Date.now() - e.openedAt < ARM_AFTER_MS) return;
      e.armed = true;
    }
    if (s === undefined) {
      e.missing += 1;
      if (e.missing >= MISSING_POLLS) this.settle(requestId, { by: "terminal", respond: true });
      return;
    }
    e.missing = 0;
    if (s.status !== "waiting") this.settle(requestId, { by: "terminal", respond: true });
  }

  private settle(requestId: string, outcome: Outcome): boolean {
    const e = this.entries.get(requestId);
    if (e === undefined) return false;
    this.entries.delete(requestId);
    clearTimeout(e.ttl);
    clearInterval(e.poll);
    e.detach();

    let decision: HookDecision | null | undefined;
    if (outcome.by === "remote") decision = { behavior: outcome.behavior };
    else if (outcome.by === "timeout") decision = { behavior: "deny" };
    else if (outcome.by === "close" || outcome.respond) decision = null;
    if (decision !== undefined) {
      try {
        e.respond(decision);
      } catch {
        console.warn(`global-agents: falha ao responder o pedido de permissão ${e.requestId} (${e.tool})`);
      }
    }

    if (outcome.by === "close") return true;
    this.safeEmit({
      ...newEnvelope(this.machine),
      type: "permission.resolved",
      requestId,
      by: outcome.by,
      ...(outcome.by === "remote" ? { behavior: outcome.behavior } : outcome.by === "timeout" ? { behavior: "deny" as const } : {}),
    });
    return true;
  }

  private safeEmit(ev: AgentEvent): void {
    try {
      this.emit(ev);
    } catch {
      // o hook nunca fica preso por causa de um consumidor com erro
    }
  }
}
