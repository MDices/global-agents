import { z } from "zod";
import { EnvelopeSchema } from "./envelope.js";
export const SessionStateSchema = z.enum(["working", "waiting", "done", "error"]);
export type SessionState = z.infer<typeof SessionStateSchema>;
export const PermissionBehaviorSchema = z.enum(["allow", "deny"]);
export type PermissionBehavior = z.infer<typeof PermissionBehaviorSchema>;
export const SessionInfoSchema = z.object({
  sessionId: z.string().min(1), name: z.string(), cwd: z.string(),
  kind: z.enum(["interactive", "background"]), status: z.enum(["busy", "waiting", "idle"]).optional(),
  state: z.enum(["working", "blocked", "done", "failed", "stopped"]).optional(),
  waitingFor: z.string().optional(), bgId: z.string().optional(), pid: z.number().int().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => EnvelopeSchema.extend({ type: z.literal(type), ...shape });
export const AgentEventSchema = z.discriminatedUnion("type", [
  ev("agent.hello", { version: z.string(), os: z.enum(["linux", "win32", "darwin"]), osUser: z.string(), claudeVersion: z.string().optional(),
    claudeAccount: z.string().optional(), projects: z.array(z.string()) }),
  ev("agent.warning", { message: z.string(), sessionId: z.string().optional() }),
  ev("session.list", { sessions: z.array(SessionInfoSchema) }),
  ev("session.status", { sessionId: z.string(), name: z.string(), cwd: z.string(), state: SessionStateSchema, snippet: z.string().optional() }),
  ev("turn.prompt", { sessionId: z.string(), text: z.string(), source: z.enum(["terminal", "remote"]) }),
  ev("turn.reply", { sessionId: z.string(), text: z.string(), stopReason: z.string().optional() }),
  ev("permission.request", { sessionId: z.string(), requestId: z.string(), tool: z.string(), description: z.string(), inputPreview: z.string(), expiresAt: z.string().datetime({ offset: true }) }),
  ev("permission.resolved", { requestId: z.string(), by: z.enum(["remote", "terminal", "timeout"]), behavior: PermissionBehaviorSchema.optional() }),
  ev("command.ack", { commandId: z.string(), result: z.record(z.unknown()).optional() }),
  ev("command.error", { commandId: z.string(), reason: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
