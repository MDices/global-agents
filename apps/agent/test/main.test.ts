import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventSchema, newEnvelope, type AgentEvent, type RelayCommand, type SessionInfo } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../src/claude/exec.js";
import type { AgentConfig } from "../src/config.js";
import { isTeammatePayload } from "../src/hooks/mapper.js";
import { startHookServer, type HookServerOptions } from "../src/hooks/server.js";
import { createAgent, type AgentDeps, type RelayClientLike } from "../src/main.js";
import type { RelayClientEvents, RelayClientOptions } from "../src/transport/client.js";

const TEAMMATE_STOP = {
  session_id: "89d41e5b-d50d-4b79-98b7-6ecf1bf4f7b5", cwd: "/home/leonardo/dev/work/global-agents", hook_event_name: "Stop",
  agent_type: "general-purpose", last_assistant_message: "alpha: docs tem 8 arquivos.", stop_hook_active: false,
};
const SESSION: SessionInfo = { sessionId: "s1", cwd: "/home/x/proj", name: "corrige-bugs", kind: "background" };

class FakeInventory extends EventEmitter {
  list: SessionInfo[] = [];
  start = vi.fn();
  stop = vi.fn();
  find(id: string): SessionInfo | undefined { return this.list.find((s) => s.sessionId === id); }
  waitFor(pred: (s: SessionInfo) => boolean): Promise<SessionInfo> {
    const hit = this.list.find(pred);
    return hit !== undefined ? Promise.resolve(hit) : Promise.reject(new Error("não apareceu"));
  }
  set(list: SessionInfo[]): void { this.list = list; this.emit("changed", list); }
}

class FakeClient extends EventEmitter<RelayClientEvents> implements RelayClientLike {
  sent: AgentEvent[] = [];
  stopped = false;
  constructor(readonly opts: RelayClientOptions) { super(); }
  start(): void { this.sent.push(this.opts.hello()); }
  stop(): void { this.stopped = true; }
  send(ev: AgentEvent): void { this.sent.push(ev); }
  types(): string[] { return this.sent.map((e) => e.type); }
}

let dir: string;
let agent: { stop(): Promise<void> } | undefined;
let accounts: string[];

function fakeRun(args: string[]): Promise<ExecResult> {
  if (args[0] === "--version") return Promise.resolve({ code: 0, stdout: "2.1.291 (Claude Code)\n", stderr: "" });
  if (args[0] === "auth") {
    const email = accounts.length > 1 ? accounts.shift() : accounts[0];
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email, orgName: "x" }), stderr: "" });
  }
  return Promise.resolve({ code: 1, stdout: "", stderr: "inesperado" });
}

async function setup(extra: Partial<AgentDeps> = {}, cfgOver: Partial<AgentConfig> = {}) {
  const cfg: AgentConfig = {
    relayUrl: "ws://127.0.0.1:1/ws", token: "segredo", machineName: "fedora", projects: ["/home/x/proj"],
    devRoots: [], port: 0, claudeBin: "claude", dataDir: dir, ...cfgOver,
  };
  const inventory = new FakeInventory();
  let client: FakeClient | undefined;
  let port = 0;
  const a = createAgent(cfg, {
    inventory,
    client: (opts) => (client = new FakeClient(opts)),
    hookServer: async (o: HookServerOptions) => { const s = await startHookServer(o); port = s.port; return s; },
    run: fakeRun,
    ...extra,
  });
  agent = a;
  await a.start();
  if (client === undefined) throw new Error("cliente não criado");
  const c: FakeClient = client;
  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { a, inventory, client: c, post };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-main-"));
  accounts = ["leo@example.com"];
});
afterEach(async () => {
  await agent?.stop();
  agent = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("createAgent", () => {
  it("start(): hello com versões, conta e projetos; depois session.list a cada changed", async () => {
    const { client, inventory } = await setup();
    expect(client.types()).toEqual(["agent.hello"]);
    const hello = client.sent[0];
    expect(AgentEventSchema.safeParse(hello).success).toBe(true);
    expect(hello).toMatchObject({
      type: "agent.hello", machine: expect.stringMatching(/^fedora\//), version: "0.1.0", os: process.platform,
      claudeVersion: "2.1.291", claudeAccount: "leo@example.com", projects: ["/home/x/proj"], devRoots: [],
    });
    expect(client.opts).toMatchObject({ url: "ws://127.0.0.1:1/ws", token: "segredo" });
    expect(inventory.start).toHaveBeenCalledTimes(1);

    inventory.set([SESSION]);
    expect(client.types()).toEqual(["agent.hello", "session.list"]);
    expect(client.sent[1]).toMatchObject({ type: "session.list", sessions: [SESSION] });
  });

  describe("raízes dev", () => {
    const ROOTS = ["/home/x/dev"];

    it("hello leva devRoots; a cada conexão vai um agent.projects com a lista descoberta", async () => {
      const discover = vi.fn(() => Promise.resolve(["/home/x/dev/a", "/home/x/dev/b/repo"]));
      const { client } = await setup({ discover }, { devRoots: ROOTS });
      expect(discover).toHaveBeenCalledWith(ROOTS);
      expect(client.sent[0]).toMatchObject({ type: "agent.hello", devRoots: ROOTS });
      client.emit("connected");
      client.emit("connected");
      expect(client.types()).toEqual(["agent.hello", "agent.projects", "agent.projects"]);
      const ev = client.sent[1];
      expect(AgentEventSchema.safeParse(ev).success).toBe(true);
      expect(ev).toMatchObject({ type: "agent.projects", devRoots: ROOTS, projects: ["/home/x/dev/a", "/home/x/dev/b/repo"] });
    });

    it("varre de novo a cada 5 min e só reenvia quando a lista muda", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const lists = [["/home/x/dev/a"], ["/home/x/dev/a"], ["/home/x/dev/a", "/home/x/dev/novo"]];
      const discover = vi.fn(() => Promise.resolve(lists.length > 1 ? lists.shift()! : lists[0]!));
      const { client } = await setup({ discover }, { devRoots: ROOTS });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(client.types()).toEqual(["agent.hello"]);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(client.types()).toEqual(["agent.hello", "agent.projects"]);
      expect(client.sent[1]).toMatchObject({ projects: ["/home/x/dev/a", "/home/x/dev/novo"] });
      expect(discover).toHaveBeenCalledTimes(3);
    });

    it("raiz editada à mão na config (~/dev, repetida) vira caminho absoluto no hello e na varredura", async () => {
      const discover = vi.fn(() => Promise.resolve([]));
      const { client } = await setup({ discover }, { devRoots: ["~/dev", join(homedir(), "dev")] });
      expect(client.sent[0]).toMatchObject({ devRoots: [join(homedir(), "dev")] });
      expect(discover).toHaveBeenCalledWith([join(homedir(), "dev")]);
    });

    it("sem raízes dev não varre nada (agent.projects na conexão vai vazio)", async () => {
      const discover = vi.fn(() => Promise.resolve(["/x"]));
      const { client } = await setup({ discover });
      client.emit("connected");
      expect(discover).not.toHaveBeenCalled();
      expect(client.sent[1]).toMatchObject({ type: "agent.projects", devRoots: [], projects: [] });
    });

    it("session.create passa pela contenção do agente: pasta fora das raízes vira command.error", async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-root-"));
      const spawn = vi.fn(() => Promise.resolve({ sessionId: "s", bgId: "b" }));
      const { client } = await setup({ discover: () => Promise.resolve([]), commands: { spawn } }, { devRoots: [root], projects: [] });
      const cmd: RelayCommand = { ...newEnvelope("relay/vps"), type: "session.create", commandId: "c1", cwd: tmpdir(), name: "n", prompt: "p", permissionMode: "plan" };
      client.emit("command", cmd);
      await vi.waitFor(() => { expect(client.types()).toContain("command.error"); });
      expect(client.sent.find((e) => e.type === "command.error")).toMatchObject({ reason: expect.stringContaining("fora das pastas dev") as unknown });
      expect(spawn).not.toHaveBeenCalled();
      rmSync(root, { recursive: true, force: true });
    });
  });

  it("hello omite claudeVersion/claudeAccount quando o claude falha", async () => {
    const { client } = await setup({ run: () => Promise.reject(new Error("ENOENT")) });
    const hello = client.sent[0];
    expect(AgentEventSchema.safeParse(hello).success).toBe(true);
    expect(hello).not.toHaveProperty("claudeVersion");
    expect(hello).not.toHaveProperty("claudeAccount");
  });

  it("POST de hook Stop → turn.reply e session.status enviados, com o nome do inventário", async () => {
    const { client, inventory, post } = await setup();
    inventory.set([SESSION]);
    const res = await post({ session_id: "s1", cwd: "/home/x/proj", hook_event_name: "Stop", last_assistant_message: "pronto" });
    expect(res.status).toBe(204);
    await vi.waitFor(() => { expect(client.types()).toEqual(["agent.hello", "session.list", "turn.reply", "session.status"]); });
    expect(client.sent[2]).toMatchObject({ type: "turn.reply", sessionId: "s1", text: "pronto" });
    expect(client.sent[3]).toMatchObject({ type: "session.status", sessionId: "s1", name: "corrige-bugs", state: "done" });
  });

  it("sessão sem nome no inventário cai no nome do diretório", async () => {
    const { client, inventory, post } = await setup();
    inventory.set([{ ...SESSION, name: "" }]);
    await post({ session_id: "s1", cwd: "/home/x/proj", hook_event_name: "SessionEnd" });
    await vi.waitFor(() => { expect(client.types()).toContain("session.status"); });
    expect(client.sent.at(-1)).toMatchObject({ type: "session.status", name: "proj" });
  });

  it("Stop de teammate (agent_type, sessão fora do inventário) é descartado", async () => {
    const { client, post } = await setup();
    expect((await post(TEAMMATE_STOP)).status).toBe(204);
    // um hook normal depois prova que o anterior já foi processado (e descartado)
    await post({ session_id: "s9", cwd: "/x/y", hook_event_name: "SessionEnd" });
    await vi.waitFor(() => { expect(client.types()).toEqual(["agent.hello", "session.status"]); });
    expect(client.sent[1]).toMatchObject({ sessionId: "s9" });
  });

  it("agent_type de subagent da sessão líder (no inventário) não é descartado → waiting", async () => {
    const { client, inventory, post } = await setup();
    inventory.set([SESSION]);
    await post({ session_id: "s1", cwd: "/home/x/proj", hook_event_name: "Notification", agent_type: "general-purpose", message: "precisa de permissão" });
    await vi.waitFor(() => { expect(client.types()).toEqual(["agent.hello", "session.list", "session.status"]); });
    expect(client.sent[2]).toMatchObject({ type: "session.status", sessionId: "s1", state: "waiting", snippet: "precisa de permissão" });
  });

  it("teammate_name é descartado mesmo com a sessão no inventário", async () => {
    const { client, inventory, post } = await setup();
    inventory.set([SESSION]);
    await post({ session_id: "s1", cwd: "/home/x/proj", hook_event_name: "Stop", teammate_name: "alpha", last_assistant_message: "x" });
    await post({ session_id: "s9", cwd: "/x/y", hook_event_name: "SessionEnd" });
    await vi.waitFor(() => { expect(client.types()).toEqual(["agent.hello", "session.list", "session.status"]); });
    expect(client.sent[2]).toMatchObject({ sessionId: "s9" });
  });

  it("fixture bg do time: teammates viram team.* (nunca session.*/turn.* deles); o líder segue normal", async () => {
    const lead = "72a1377b-4d94-4bf5-921c-e6311d55f837";
    const { client, inventory, post } = await setup({ teamsDir: join(dir, "teams") });
    inventory.set([{ sessionId: lead, cwd: "/home/leonardo/dev/work/global-agents", name: "ga-team-fixture", kind: "background" }]);
    const lines = readFileSync(new URL("./fixtures/team/team-hooks-bg.jsonl", import.meta.url), "utf8").split("\n").filter((l) => l !== "");
    for (const l of lines) await post(JSON.parse(l));
    await vi.waitFor(() => { expect(client.sent.some((e) => e.type === "team.update")).toBe(true); });
    const reply = client.sent.find((e) => e.type === "team.event" && e.kind === "teammate_reply");
    expect(reply).toMatchObject({ leadSessionId: lead, teammate: "alpha", text: "docs tem 10 arquivos." });
    const ofSession = client.sent.filter((e) => e.type.startsWith("session.") || e.type.startsWith("turn."));
    expect(ofSession.every((e) => !("sessionId" in e) || e.sessionId === lead)).toBe(true);
    expect(client.types()).toContain("turn.reply");
  });

  it("líder some do inventário (2 snapshots, > 60 s): o tracker descarrega o painel final na hora (syncInventory ligado)", async () => {
    const lead = "72a1377b-4d94-4bf5-921c-e6311d55f837";
    const { client, inventory, post } = await setup({ teamsDir: join(dir, "teams") });
    inventory.set([{ sessionId: lead, cwd: "/home/leonardo/dev/work/global-agents", name: "ga-team-fixture", kind: "background" }]);
    const lines = readFileSync(new URL("./fixtures/team/team-hooks-bg.jsonl", import.meta.url), "utf8").split("\n").filter((l) => l !== "");
    for (const l of lines.slice(0, 10)) await post(JSON.parse(l)); // até o TeammateIdle de alpha
    await vi.waitFor(() => { expect(client.sent.some((e) => e.type === "team.event" && e.kind === "teammate_idle")).toBe(true); });
    const before = client.sent.filter((e) => e.type === "team.update").length;
    vi.useFakeTimers({ toFake: ["Date"] });
    inventory.set([]);
    vi.setSystemTime(Date.now() + 61_000);
    inventory.set([]);
    expect(client.sent.filter((e) => e.type === "team.update")).toHaveLength(before + 1);
    expect(client.sent.filter((e) => e.type === "team.update").at(-1)).toMatchObject({ leadSessionId: lead, members: [{ name: "alpha", state: "idle" }] });
  });

  it("comando recebido passa pelo handler: session.stop sem bgId → command.error de background", async () => {
    const { client, inventory } = await setup();
    inventory.set([SESSION]);
    const cmd: RelayCommand = { ...newEnvelope("relay/relay"), type: "session.stop", commandId: "c42", sessionId: "s1" };
    client.emit("command", cmd);
    await vi.waitFor(() => { expect(client.sent.at(-1)).toMatchObject({ type: "command.error", commandId: "c42" }); });
    expect(client.sent.at(-1)).toMatchObject({ reason: expect.stringContaining("background") as unknown });
    expect(AgentEventSchema.safeParse(client.sent.at(-1)).success).toBe(true);
  });

  it("session.send chega ao inject com o registro da sessão e o relay recebe ack (uma vez só para commandId repetido)", async () => {
    const inject = vi.fn<NonNullable<AgentDeps["commands"]["inject"]>>(() => Promise.resolve());
    const { client, inventory } = await setup({
      commands: { inject, readRegistry: (pid) => ({ pid, sessionId: "s1", messagingSocketPath: "/run/x.sock" }) },
    });
    inventory.set([{ ...SESSION, pid: 77 }]);
    const cmd: RelayCommand = { ...newEnvelope("relay/relay"), type: "session.send", commandId: "c7", sessionId: "s1", text: "oi" };
    client.emit("command", cmd);
    client.emit("command", cmd);
    await vi.waitFor(() => { expect(client.sent.filter((e) => e.type === "command.ack")).toHaveLength(2); });
    expect(client.sent.at(-1)).toMatchObject({ type: "command.ack", commandId: "c7" });
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith({ messagingSocketPath: "/run/x.sock" }, "oi", { name: "discord" });
  });

  it("reenvia hello só quando claudeAccount muda (checagem a cada 60 s)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    accounts = ["leo@example.com", "leo@example.com", "outra@example.com"];
    const { client } = await setup();
    expect(client.types()).toEqual(["agent.hello"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.types()).toEqual(["agent.hello"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.types()).toEqual(["agent.hello", "agent.hello"]);
    expect(client.sent[1]).toMatchObject({ claudeAccount: "outra@example.com" });
    // o hello das próximas reconexões também leva a conta nova
    expect(client.opts.hello()).toMatchObject({ claudeAccount: "outra@example.com" });
  });

  it("PermissionRequest vira permission.request; permission.decide do relay responde o hook com a decisão", async () => {
    const { client, inventory, post } = await setup();
    inventory.set([{ ...SESSION, status: "waiting" }]);
    const hook = post({
      session_id: "s1", cwd: "/home/x/proj", hook_event_name: "PermissionRequest", permission_mode: "default",
      tool_name: "Bash", tool_input: { command: "ls", description: "lista" }, tool_use_id: "tu1", permission_suggestions: [],
    });
    await vi.waitFor(() => { expect(client.types()).toContain("permission.request"); });
    const req = client.sent.find((e) => e.type === "permission.request");
    if (req?.type !== "permission.request") throw new Error("sem permission.request");
    expect(req).toMatchObject({ sessionId: "s1", tool: "Bash", description: "lista", inputPreview: "ls" });
    const cmd: RelayCommand = { ...newEnvelope("relay/relay"), type: "permission.decide", commandId: "c9", requestId: req.requestId, behavior: "allow" };
    client.emit("command", cmd);
    const res = await hook;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    await vi.waitFor(() => { expect(client.sent.at(-1)).toMatchObject({ type: "command.ack", commandId: "c9" }); });
    expect(client.sent.find((e) => e.type === "permission.resolved")).toMatchObject({ requestId: req.requestId, by: "remote", behavior: "allow" });
    const again: RelayCommand = { ...cmd, commandId: "c10" };
    client.emit("command", again);
    await vi.waitFor(() => { expect(client.sent.at(-1)).toMatchObject({ type: "command.error", commandId: "c10" }); });
  });

  it("stop() responde 204 aos PermissionRequest pendentes sem emitir resolved", async () => {
    const { a, client, inventory, post } = await setup();
    inventory.set([{ ...SESSION, status: "waiting" }]);
    const hook = post({ session_id: "s1", cwd: "/home/x/proj", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
    await vi.waitFor(() => { expect(client.types()).toContain("permission.request"); });
    await a.stop();
    agent = undefined;
    expect((await hook).status).toBe(204);
    expect(client.types()).not.toContain("permission.resolved");
  });

  it("evento de hook que chega logo depois do listen (antes do fim do start) não se perde: vai ao cliente", async () => {
    const { client } = await setup({
      hookServer: async (o: HookServerOptions) => {
        let processed!: () => void;
        const done = new Promise<void>((r) => { processed = r; });
        const s = await startHookServer({ ...o, onEvents: (evs) => { o.onEvents(evs); processed(); } });
        const res = await fetch(`http://127.0.0.1:${s.port}/hook`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "s1", cwd: "/home/x/proj", hook_event_name: "Stop", last_assistant_message: "cedo" }),
        });
        expect(res.status).toBe(204);
        await done;
        return s;
      },
    });
    expect(client.sent.find((e) => e.type === "turn.reply")).toMatchObject({ sessionId: "s1", text: "cedo" });
  });

  it("falha ao subir o servidor de hooks: start() rejeita e o cliente criado antes é parado, sem conectar", async () => {
    let client: FakeClient | undefined;
    const started = vi.fn();
    const a = createAgent(
      { relayUrl: "ws://127.0.0.1:1/ws", token: "segredo", machineName: "fedora", projects: [], devRoots: [], port: 0, claudeBin: "claude", dataDir: dir },
      {
        inventory: new FakeInventory(),
        client: (opts) => { client = new FakeClient(opts); client.start = started; return client; },
        hookServer: () => Promise.reject(new Error("EADDRINUSE")),
        run: fakeRun,
      },
    );
    await expect(a.start()).rejects.toThrow("EADDRINUSE");
    expect(client?.stopped).toBe(true);
    expect(started).not.toHaveBeenCalled();
  });

  it("stop() para inventário, servidor de hooks e cliente", async () => {
    const { a, client, inventory, post } = await setup();
    await a.stop();
    agent = undefined;
    expect(inventory.stop).toHaveBeenCalledTimes(1);
    expect(client.stopped).toBe(true);
    await expect(post({ session_id: "s1", cwd: "/x", hook_event_name: "SessionEnd" })).rejects.toThrow();
    inventory.set([SESSION]);
    expect(client.types()).toEqual(["agent.hello"]);
  });
});

describe("isTeammatePayload", () => {
  const known = (id: string): boolean => id === "s1";
  it("teammate_name sempre; agent_type só fora do inventário; sessões comuns não", () => {
    expect(isTeammatePayload(TEAMMATE_STOP, known)).toBe(true);
    expect(isTeammatePayload({ ...TEAMMATE_STOP, session_id: "s1" }, known)).toBe(false);
    expect(isTeammatePayload({ session_id: "s1", hook_event_name: "TeammateIdle", teammate_name: "alpha" }, known)).toBe(true);
    expect(isTeammatePayload({ session_id: "s1", cwd: "/x", hook_event_name: "Stop" }, known)).toBe(false);
    expect(isTeammatePayload({ session_id: "s2", cwd: "/x", hook_event_name: "Stop" }, known)).toBe(false);
    expect(isTeammatePayload({ session_id: "s2", cwd: "/x", hook_event_name: "SubagentStop", agent_type: "" }, known)).toBe(false);
    expect(isTeammatePayload(null, known)).toBe(false);
    expect(isTeammatePayload("x", known)).toBe(false);
  });
});
