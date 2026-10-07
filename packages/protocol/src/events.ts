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
export const TeamMemberStateSchema = z.enum(["working", "idle", "ended"]);
export type TeamMemberState = z.infer<typeof TeamMemberStateSchema>;
export const TeamEventKindSchema = z.enum(["task_created", "task_completed", "teammate_idle", "teammate_reply", "teammate_ended", "teammate_permission"]);
export type TeamEventKind = z.infer<typeof TeamEventKindSchema>;
export const TeamMemberSchema = z.object({ name: z.string(), state: TeamMemberStateSchema });
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export const TeamTaskSchema = z.object({ id: z.string(), subject: z.string(), status: z.enum(["pending", "completed"]), owner: z.string().optional() });
export type TeamTask = z.infer<typeof TeamTaskSchema>;
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => EnvelopeSchema.extend({ type: z.literal(type), ...shape });
export const AgentEventSchema = z.discriminatedUnion("type", [
  ev("agent.hello", { version: z.string(), os: z.enum(["linux", "win32", "darwin"]), osUser: z.string(), claudeVersion: z.string().optional(),
    claudeAccount: z.string().optional(), projects: z.array(z.string()),
    /** Pastas raiz de desenvolvimento; ausente = agente anterior às raízes dev (o relay mantém a validação antiga). */
    devRoots: z.array(z.string()).optional() }),
  /** Raízes dev e projetos descobertos dentro delas (caminhos absolutos); enviado na conexão e quando a lista muda. */
  ev("agent.projects", { devRoots: z.array(z.string()), projects: z.array(z.string()) }),
  ev("agent.warning", { message: z.string(), sessionId: z.string().optional() }),
  ev("session.list", { sessions: z.array(SessionInfoSchema) }),
  ev("session.status", { sessionId: z.string(), name: z.string(), cwd: z.string(), state: SessionStateSchema, snippet: z.string().optional() }),
  ev("turn.prompt", { sessionId: z.string(), text: z.string(), source: z.enum(["terminal", "remote"]) }),
  ev("turn.reply", { sessionId: z.string(), text: z.string(), stopReason: z.string().optional() }),
  ev("permission.request", { sessionId: z.string(), requestId: z.string(), tool: z.string(), description: z.string(), inputPreview: z.string(), expiresAt: z.string().datetime({ offset: true }) }),
  ev("permission.resolved", { requestId: z.string(), by: z.enum(["remote", "terminal", "timeout"]), behavior: PermissionBehaviorSchema.optional() }),
  ev("team.update", { leadSessionId: z.string(), team: z.string(), members: z.array(TeamMemberSchema), tasks: z.array(TeamTaskSchema) }),
  ev("team.event", { leadSessionId: z.string(), kind: TeamEventKindSchema, teammate: z.string().optional(), taskId: z.string().optional(),
    subject: z.string().optional(), text: z.string().optional() }),
  ev("command.ack", { commandId: z.string(), result: z.record(z.unknown()).optional() }),
  ev("command.error", { commandId: z.string(), reason: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
