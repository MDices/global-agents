import { z } from "zod";
import { AgentEventSchema, type AgentEvent } from "./events.js";
import { RelayCommandSchema, type RelayCommand } from "./commands.js";
export * from "./envelope.js"; export * from "./events.js"; export * from "./commands.js";
export const PROTOCOL_VERSION = 1 as const;
export const MessageSchema = z.union([AgentEventSchema, RelayCommandSchema]);
export type Message = AgentEvent | RelayCommand;
export type ParseResult = { ok: true; message: Message } | { ok: false; error: string };
export function parseLine(line: string): ParseResult {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch (e) { return { ok: false, error: `JSON inválido: ${(e as Error).message}` }; }
  const r = MessageSchema.safeParse(raw);
  return r.success ? { ok: true, message: r.data } : { ok: false, error: r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
export function serialize(message: Message): string { return JSON.stringify(message) + "\n"; }
