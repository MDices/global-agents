import { describe, it, expect } from "vitest";
import { AgentEventSchema, newEnvelope } from "../src/index.js";
const env = () => newEnvelope("fedora/leonardo");
describe("eventos", () => {
  it("aceita agent.hello completo", () => {
    const r = AgentEventSchema.safeParse({ ...env(), type: "agent.hello", version: "0.1.0", os: "linux", osUser: "leonardo",
      claudeVersion: "2.1.291", claudeAccount: "leo@x.com", projects: ["/home/leonardo/dev"] });
    expect(r.success).toBe(true);
  });
  it("aceita session.list com campos opcionais ausentes", () => {
    const r = AgentEventSchema.safeParse({ ...env(), type: "session.list", sessions: [
      { sessionId: "u1", name: "a", cwd: "/p", kind: "interactive", status: "busy" },
      { sessionId: "u2", name: "b", cwd: "/p", kind: "background", status: "waiting", state: "blocked", waitingFor: "permission prompt", bgId: "85285a68" } ] });
    expect(r.success).toBe(true);
  });
  it("recusa session.status com estado inválido", () => {
    expect(AgentEventSchema.safeParse({ ...env(), type: "session.status", sessionId: "u", name: "n", cwd: "/", state: "paused" }).success).toBe(false);
  });
  it("turn.reply aceita texto vazio (Claude pode terminar sem texto)", () => {
    expect(AgentEventSchema.safeParse({ ...env(), type: "turn.reply", sessionId: "u", text: "", stopReason: "end_turn" }).success).toBe(true);
  });
  it("permission.request exige expiresAt ISO", () => {
    const ok = AgentEventSchema.safeParse({ ...env(), type: "permission.request", sessionId: "u", requestId: "r1", tool: "Bash", description: "d", inputPreview: "ls", expiresAt: new Date().toISOString() });
    expect(ok.success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...env(), type: "permission.request", sessionId: "u", requestId: "r1", tool: "Bash", description: "d", inputPreview: "ls", expiresAt: "amanhã" }).success).toBe(false);
  });
  it("command.ack e command.error", () => {
    expect(AgentEventSchema.safeParse({ ...env(), type: "command.ack", commandId: "c1", result: { sessionId: "u" } }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...env(), type: "command.error", commandId: "c1", reason: "sessão encerrada" }).success).toBe(true);
  });
});
