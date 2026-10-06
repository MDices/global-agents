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
