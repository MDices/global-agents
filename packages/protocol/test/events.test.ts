import { describe, it, expect } from "vitest";
import { AgentEventSchema, newEnvelope } from "../src/index.js";
const env = () => newEnvelope("fedora/leonardo");
describe("eventos", () => {
  it("aceita agent.hello completo", () => {
    const r = AgentEventSchema.safeParse({ ...env(), type: "agent.hello", version: "0.1.0", os: "linux", osUser: "leonardo",
      claudeVersion: "2.1.291", claudeAccount: "leo@x.com", projects: ["/home/leonardo/dev"] });
    expect(r.success).toBe(true);
  });
  it("agent.hello sem devRoots continua válido (agente anterior às raízes dev) e com devRoots também", () => {
    const base = { ...env(), type: "agent.hello", version: "0.1.0", os: "linux", osUser: "leonardo", projects: [] };
    const legado = AgentEventSchema.safeParse(base);
    expect(legado.success).toBe(true);
    expect(legado.success && legado.data.type === "agent.hello" ? legado.data.devRoots : "x").toBeUndefined();
    const novo = AgentEventSchema.safeParse({ ...base, devRoots: ["/home/leonardo/dev"] });
    expect(novo.success && novo.data.type === "agent.hello" ? novo.data.devRoots : undefined).toEqual(["/home/leonardo/dev"]);
    expect(AgentEventSchema.safeParse({ ...base, devRoots: "/home/leonardo/dev" }).success).toBe(false);
  });
  it("agent.projects exige devRoots e projects como listas de texto", () => {
    expect(AgentEventSchema.safeParse({ ...env(), type: "agent.projects", devRoots: ["/d"], projects: ["/d/a", "/d/b/repo"] }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...env(), type: "agent.projects", devRoots: [], projects: [] }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...env(), type: "agent.projects", projects: [] }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...env(), type: "agent.projects", devRoots: [], projects: [1] }).success).toBe(false);
  });
  it("aceita session.list com campos opcionais ausentes", () => {
    const r = AgentEventSchema.safeParse({ ...env(), type: "session.list", sessions: [
      { sessionId: "u1", name: "a", cwd: "/p", kind: "interactive", status: "busy" },
      { sessionId: "u2", name: "b", cwd: "/p", kind: "background", status: "waiting", state: "blocked", waitingFor: "permission prompt", bgId: "85285a68" } ] });
    expect(r.success).toBe(true);
  });
  it("aceita session.status sem name (agente novo que só sabe o nome da pasta)", () => {
    const r = AgentEventSchema.safeParse({ ...env(), type: "session.status", sessionId: "u", cwd: "/", state: "done" });
    expect(r.success && r.data.type === "session.status" && r.data.name).toBeUndefined();
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
  it("team.update com membros e tarefas (owner opcional)", () => {
    const r = AgentEventSchema.safeParse({ ...env(), type: "team.update", leadSessionId: "l1", team: "session-l1",
      members: [{ name: "alpha", state: "working" }, { name: "beta", state: "idle" }, { name: "gama", state: "ended" }],
      tasks: [{ id: "1", subject: "contar", status: "pending" }, { id: "2", subject: "listar", status: "completed", owner: "beta" }] });
    expect(r.success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...env(), type: "team.update", leadSessionId: "l1", team: "t",
      members: [{ name: "alpha", state: "sleeping" }], tasks: [] }).success).toBe(false);
  });
  it("team.event com campos opcionais e kind fechado", () => {
    for (const kind of ["task_created", "task_completed", "teammate_idle", "teammate_reply", "teammate_ended", "teammate_permission"]) {
      expect(AgentEventSchema.safeParse({ ...env(), type: "team.event", leadSessionId: "l1", kind }).success).toBe(true);
    }
    expect(AgentEventSchema.safeParse({ ...env(), type: "team.event", leadSessionId: "l1", kind: "task_completed",
      teammate: "alpha", taskId: "1", subject: "contar", text: "ok" }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...env(), type: "team.event", leadSessionId: "l1", kind: "teammate_spawned" }).success).toBe(false);
  });
});
