import { z } from "zod";
import { EnvelopeSchema } from "./envelope.js";
import { PermissionBehaviorSchema } from "./events.js";
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => EnvelopeSchema.extend({ type: z.literal(type), commandId: z.string().min(1), ...shape });
export const RelayCommandSchema = z.discriminatedUnion("type", [
  cmd("session.create", { cwd: z.string().min(1), name: z.string().min(1).max(100), prompt: z.string().min(1).max(100_000), permissionMode: PermissionModeSchema }),
  cmd("session.send", { sessionId: z.string().min(1), text: z.string().min(1).max(100_000) }),
  cmd("session.stop", { sessionId: z.string().min(1) }),
  cmd("permission.decide", { requestId: z.string().min(1), behavior: PermissionBehaviorSchema }),
]);
export type RelayCommand = z.infer<typeof RelayCommandSchema>;
