import { z } from "zod";
import { EnvelopeSchema } from "./envelope.js";
import { PermissionBehaviorSchema } from "./events.js";
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
/** Slash commands do Claude Code que o Discord pode rodar numa sessão (v1, fechada). */
export const SLASH_ALLOWLIST = ["compact", "usage", "cost", "hooks", "status", "context", "model"] as const;
export const SlashCommandNameSchema = z.enum(SLASH_ALLOWLIST);
export type SlashCommandName = z.infer<typeof SlashCommandNameSchema>;
const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => EnvelopeSchema.extend({ type: z.literal(type), commandId: z.string().min(1), ...shape });
export const RelayCommandSchema = z.discriminatedUnion("type", [
  cmd("session.create", { cwd: z.string().min(1), name: z.string().min(1).max(100), prompt: z.string().min(1).max(100_000), permissionMode: PermissionModeSchema }),
  cmd("session.send", { sessionId: z.string().min(1), text: z.string().min(1).max(100_000) }),
  cmd("session.stop", { sessionId: z.string().min(1) }),
  cmd("session.slash", { sessionId: z.string().min(1), command: SlashCommandNameSchema, args: z.string().max(500).regex(/^[^\r\n]*$/, "sem quebras de linha").optional() }),
  cmd("permission.decide", { requestId: z.string().min(1), behavior: PermissionBehaviorSchema }),
]);
export type RelayCommand = z.infer<typeof RelayCommandSchema>;
