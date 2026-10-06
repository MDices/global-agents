import { randomUUID } from "node:crypto";
import { z } from "zod";
export const MACHINE_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
export const EnvelopeSchema = z.object({
  v: z.literal(1), id: z.string().uuid(), ts: z.string().datetime({ offset: true }), machine: z.string().regex(MACHINE_RE),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;
export function newEnvelope(machine: string): Envelope {
  return { v: 1, id: randomUUID(), ts: new Date().toISOString(), machine };
}
