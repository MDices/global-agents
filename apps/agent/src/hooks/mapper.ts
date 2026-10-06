import { basename, win32 } from "node:path";
import { newEnvelope, type AgentEvent } from "@global-agents/protocol";
import { z } from "zod";

export interface MapperContext {
  machine: string;
  lookupName: (sessionId: string) => string | undefined;
}

const HookPayloadSchema = z.object({ hook_event_name: z.string(), session_id: z.string(), cwd: z.string() }).passthrough();

const CROSS_SESSION_PREFIX = "<cross-session-message";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function cwdName(cwd: string): string {
  return cwd.includes("\\") ? win32.basename(cwd) : basename(cwd);
}

/**
 * Payload de hook de um teammate de um time (vai só para o `TeamTracker`, nunca para `mapHookPayload`). `teammate_name` (TeammateIdle/TaskCompleted)
 * é sempre de teammate. `agent_type` também aparece em subagents da sessão normal (com o `session_id` dela) e em
 * sessões abertas com `--agent`; essas estão no inventário (`claude agents --json`), os teammates não — então
 * `agent_type` só conta como teammate quando a sessão é desconhecida.
 */
export function isTeammatePayload(payload: unknown, isKnownSession: (sessionId: string) => boolean): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (p["teammate_name"] !== undefined) return true;
  if (p["agent_type"] === undefined || p["agent_type"] === "") return false; // "" = subagent da própria sessão (SubagentStop)
  const sid = p["session_id"];
  return !(typeof sid === "string" && isKnownSession(sid));
}

export function mapHookPayload(payload: unknown, ctx: MapperContext): AgentEvent[] {
  const parsed = HookPayloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const sessionId = p.session_id;
  const cwd = p.cwd;
  const name = ctx.lookupName(sessionId) ?? cwdName(cwd);
  const status = (state: "working" | "waiting" | "done", snippet?: string): AgentEvent => ({
    ...newEnvelope(ctx.machine),
    type: "session.status",
    sessionId,
    name,
    cwd,
    state,
    ...(snippet !== undefined ? { snippet } : {}),
  });

  switch (p.hook_event_name) {
    case "UserPromptSubmit": {
      const text = str(p["prompt"]) ?? "";
      return [
        status("working"),
        {
          ...newEnvelope(ctx.machine),
          type: "turn.prompt",
          sessionId,
          text,
          source: text.startsWith(CROSS_SESSION_PREFIX) ? "remote" : "terminal",
        },
      ];
    }
    case "Notification":
      return [status("waiting", str(p["message"]))];
    case "Stop": {
      const stopReason = str(p["stop_reason"]);
      return [
        {
          ...newEnvelope(ctx.machine),
          type: "turn.reply",
          sessionId,
          text: str(p["last_assistant_message"]) ?? "",
          ...(stopReason !== undefined ? { stopReason } : {}),
        },
        status("done"),
      ];
    }
    case "SessionEnd":
      return [status("done")];
    default:
      return [];
  }
}
