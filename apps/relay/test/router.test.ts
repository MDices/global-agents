import { EventEmitter } from "node:events";
import { newEnvelope, type AgentEvent, type SessionInfo } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { ThreadRegistry } from "../src/discord/threads.js";
import { createRouter, machineChannelResolver, type Router } from "../src/router.js";
import type { AgentHubEvents } from "../src/ws/server.js";
import { FakeDiscordPort } from "./helpers/fake-discord.js";

const M = "fedora/leonardo";
const TOPIC = "fedora/leonardo · Linux · Claude Code 2.1.291 · leonardo@exemplo.com.br";

type Body<T extends AgentEvent["type"]> = Omit<Extract<AgentEvent, { type: T }>, "v" | "id" | "ts" | "machine" | "type">;
const ev = <T extends AgentEvent["type"]>(type: T, body: Body<T>, machine = M): AgentEvent =>
  ({ ...newEnvelope(machine), type, ...body }) as AgentEvent;

const hello = (machine = M): AgentEvent =>
  ev("agent.hello", { version: "0.1.0", os: "linux", osUser: "leonardo", claudeVersion: "2.1.291",
    claudeAccount: "leonardo@exemplo.com.br", projects: ["~/dev/work/gestai"] }, machine);
const info = (sessionId: string, name: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId, name, cwd: "~/dev/work/gestai", kind: "interactive", ...extra });

let db: Db;
let port: FakeDiscordPort;
let hub: EventEmitter<AgentHubEvents>;
let threads: ThreadRegistry;
let router: Router;
let log: ReturnType<typeof vi.fn>;

const emit = (e: AgentEvent): void => { hub.emit("event", e.machine, e); };
const settle = async (): Promise<void> => {
  await router.idle();
  await vi.advanceTimersByTimeAsync(0);
};
const threadOf = (sessionId: string): string => {
  const t = db.sessions.get(sessionId)?.threadId;
  if (t === null || t === undefined) throw new Error(`sem thread para ${sessionId}`);
  return t;
};
const postsTo = (id: string): string[] => port.of("post").filter((c) => c.targetId === id).map((c) => c.text);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 6, 18, 40));
  db = openDb(":memory:");
  db.machines.upsert({ name: M, tokenHash: "h" });
  db.machines.upsert({ name: "mac/leo", tokenHash: "h2" });
  port = new FakeDiscordPort();
  hub = new EventEmitter<AgentHubEvents>();
  log = vi.fn();
  threads = new ThreadRegistry({ db, port, channelFor: machineChannelResolver(db, port), log });
  router = createRouter({ db, port, threads, hub, log });
});
afterEach(() => {
  router.dispose();
  threads.dispose();
  db.close();
  vi.useRealTimers();
});

describe("agent.hello", () => {
  it("garante o canal fedora-leonardo com o tópico da máquina e grava channel_id e conta", async () => {
    emit(hello());
    await settle();
    expect(port.of("ensureChannel")).toEqual([{ op: "ensureChannel", name: "fedora-leonardo", topic: TOPIC }]);
    expect(port.of("ensureChannel")[0]?.topic).toContain("2.1.291");
    const m = db.machines.getByName(M);
    expect(m?.channelId).toBe("ch-1");
    expect(m?.claudeAccount).toBe("leonardo@exemplo.com.br");
    expect(router.projectsOf(M)).toEqual(["~/dev/work/gestai"]);
    expect(port.of("post")).toHaveLength(0);
  });

  it("campos ausentes viram — no tópico; SO mapeado para nome legível", async () => {
    emit(ev("agent.hello", { version: "0.1.0", os: "win32", osUser: "admin", projects: [] }, "mac/leo"));
    await settle();
    expect(port.of("ensureChannel")[0]).toEqual({ op: "ensureChannel", name: "mac-leo", topic: "mac/leo · Windows · Claude Code — · —" });
  });
});

describe("sessões e threads", () => {
  beforeEach(async () => {
    emit(hello());
    await settle();
  });

  it("session.list com 2 sessões cria 2 threads (sem filtro de conta)", async () => {
    emit(ev("session.list", { sessions: [
      info("s1", "correcoes-bugs", { status: "busy" }),
      info("s2", "deploy-homolog", { kind: "background", bgId: "7f3c2a91", state: "blocked" }),
    ] }));
    await settle();
    expect(port.of("createThread")).toEqual([
      { op: "createThread", channelId: "ch-1", name: "🟢 correcoes-bugs" },
      { op: "createThread", channelId: "ch-1", name: "🟡 deploy-homolog" },
    ]);
    const embeds = port.of("postEmbed");
    expect(embeds).toHaveLength(2);
    expect(embeds[1]?.embed.fields).toContainEqual({ name: "Abrir no terminal", value: "`claude attach 7f3c2a91`", inline: false });
    expect(embeds[0]?.embed.fields?.some((f) => f.name === "Abrir no terminal")).toBe(false);
    expect(db.sessions.listByMachine(M)).toHaveLength(2);
  });

  it("session.list com nome alterado renomeia a thread e não cria outra", async () => {
    emit(ev("session.list", { sessions: [info("s1", "correcoes-bugs")] }));
    await settle();
    emit(ev("session.list", { sessions: [info("s1", "bugs-faturamento")] }));
    await settle();
    expect(port.of("createThread")).toHaveLength(1);
    expect(port.of("renameThread")).toEqual([{ op: "renameThread", threadId: threadOf("s1"), name: "⚪ bugs-faturamento" }]);
    expect(db.sessions.get("s1")?.name).toBe("bugs-faturamento");
  });

  it("session.status renomeia com o emoji do estado", async () => {
    emit(ev("session.list", { sessions: [info("s1", "correcoes-bugs")] }));
    await settle();
    emit(ev("session.status", { sessionId: "s1", name: "correcoes-bugs", cwd: "~/dev/work/gestai", state: "working" }));
    await settle();
    expect(port.of("renameThread")).toEqual([{ op: "renameThread", threadId: threadOf("s1"), name: "🟢 correcoes-bugs" }]);
    expect(db.sessions.get("s1")?.state).toBe("working");
  });

  it("session.status de sessão nova cria a thread já com o emoji do estado", async () => {
    emit(ev("session.status", { sessionId: "s5", name: "nova", cwd: "/tmp", state: "error" }));
    await settle();
    expect(port.of("createThread")).toEqual([{ op: "createThread", channelId: "ch-1", name: "🔴 nova" }]);
    expect(port.of("renameThread")).toHaveLength(0);
  });

  it("eventos simultâneos da mesma sessão nova criam uma só thread", async () => {
    port.createDelayMs = 20;
    emit(ev("session.status", { sessionId: "s7", name: "x", cwd: "/tmp", state: "working" }));
    emit(ev("turn.prompt", { sessionId: "s7", text: "oi", source: "terminal" }));
    emit(ev("session.list", { sessions: [info("s7", "x")] }));
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(port.of("createThread")).toHaveLength(1);
    expect(postsTo(threadOf("s7"))).toEqual(["> 🧑 **prompt:** oi"]);
  });

  it("turn.prompt do terminal vira citação com 🧑 em todas as linhas", async () => {
    emit(ev("session.list", { sessions: [info("s1", "correcoes-bugs")] }));
    await settle();
    emit(ev("turn.prompt", { sessionId: "s1", text: "investiga o rspec\ne corrige\n\nmas não commita", source: "terminal" }));
    await settle();
    expect(postsTo(threadOf("s1"))).toEqual(["> 🧑 **prompt:** investiga o rspec\n> e corrige\n> \n> mas não commita"]);
  });

  it("turn.prompt longo é fatiado; toda linha citada e toda mensagem ≤ 2000", async () => {
    emit(ev("session.list", { sessions: [info("s1", "correcoes-bugs")] }));
    await settle();
    const manyLines = Array.from({ length: 900 }, (_, i) => `l${i}`).join("\n");
    const noSpaces = "x".repeat(5000);
    emit(ev("turn.prompt", { sessionId: "s1", text: manyLines, source: "terminal" }));
    emit(ev("turn.prompt", { sessionId: "s1", text: noSpaces, source: "terminal" }));
    await settle();
    const posts = postsTo(threadOf("s1"));
    expect(posts.length).toBeGreaterThan(3);
    expect(posts[0]?.startsWith("> 🧑 **prompt:** l0\n")).toBe(true);
    for (const p of posts) {
      expect(p.length).toBeLessThanOrEqual(2000);
      for (const line of p.split("\n")) {
        expect(line.startsWith("> ") || /^-# \(parte \d+\/\d+\)$/.test(line)).toBe(true);
      }
    }
    const rebuilt = posts.filter((p) => p.includes("x")).map((p) => p.replace(/\n-# \(parte \d+\/\d+\)$/, "").replace(/^> (🧑 \*\*prompt:\*\* )?/gm, "")).join("");
    expect(rebuilt).toBe(noSpaces);
  });

  it("turn.prompt remoto não posta nada", async () => {
    emit(ev("session.list", { sessions: [info("s1", "correcoes-bugs")] }));
    await settle();
    emit(ev("turn.prompt", { sessionId: "s1", text: "oi", source: "remote" }));
    await settle();
    expect(port.of("post")).toHaveLength(0);
  });

  it("turn.reply de 4000 chars vira 3 posts em ordem; markdown passa intacto", async () => {
    emit(ev("session.list", { sessions: [info("s1", "correcoes-bugs")] }));
    await settle();
    const text = Array.from({ length: 40 }, (_, i) => `**p${String(i).padStart(2, "0")}** ${"a".repeat(92)}`).join("\n");
    expect(text.length).toBeGreaterThanOrEqual(3990);
    emit(ev("turn.reply", { sessionId: "s1", text }));
    await settle();
    const posts = postsTo(threadOf("s1"));
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => p.match(/-# \(parte (\d)\/3\)$/)?.[1])).toEqual(["1", "2", "3"]);
    expect(posts[0]?.startsWith("**p00** ")).toBe(true);
    for (const p of posts) expect(p.length).toBeLessThanOrEqual(2000);
  });

  it("turn.reply vazio posta (sem texto na resposta)", async () => {
    emit(ev("session.list", { sessions: [info("s1", "correcoes-bugs")] }));
    await settle();
    emit(ev("turn.reply", { sessionId: "s1", text: "" }));
    await settle();
    expect(postsTo(threadOf("s1"))).toEqual(["(sem texto na resposta)"]);
  });

  it("turn.reply de sessão desconhecida cria thread com nome derivado do id", async () => {
    emit(ev("turn.reply", { sessionId: "9b2c4e10-aaaa-bbbb", text: "pronto" }));
    await settle();
    expect(port.of("createThread")).toEqual([{ op: "createThread", channelId: "ch-1", name: "⚪ sessão 9b2c4e10" }]);
    expect(postsTo(threadOf("9b2c4e10-aaaa-bbbb"))).toEqual(["pronto"]);
  });

  it("agent.warning vai para a thread da sessão; sem thread, para o canal da máquina", async () => {
    emit(ev("session.list", { sessions: [info("s1", "correcoes-bugs")] }));
    await settle();
    emit(ev("agent.warning", { message: "Formato do inbox mudou", sessionId: "s1" }));
    emit(ev("agent.warning", { message: "sem sessão" }));
    emit(ev("agent.warning", { message: "sessão sem thread", sessionId: "s-x" }));
    await settle();
    expect(postsTo(threadOf("s1"))).toEqual(["⚠️ Formato do inbox mudou"]);
    expect(postsTo("ch-1")).toEqual(["⚠️ sem sessão", "⚠️ sessão sem thread"]);
    expect(port.of("createThread")).toHaveLength(1);
  });

  it("um handler que falha vai para o log e não trava os seguintes", async () => {
    const orig = port.post.bind(port);
    port.post = vi.fn().mockRejectedValueOnce(new Error("Missing Access")).mockImplementation(orig);
    emit(ev("agent.warning", { message: "um" }));
    emit(ev("agent.warning", { message: "dois" }));
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Missing Access"));
    expect(postsTo("ch-1")).toEqual(["⚠️ dois"]);
  });
});

describe("online/offline", () => {
  it("offline edita o tópico com a hora; online restaura", async () => {
    emit(hello());
    await settle();
    hub.emit("offline", M);
    await settle();
    expect(port.of("editChannelTopic")).toEqual([{ op: "editChannelTopic", channelId: "ch-1", topic: `🔴 máquina offline desde 18:40 · ${TOPIC}` }]);
    expect(port.of("editChannelTopic")[0]?.topic).toContain("offline");
    hub.emit("online", M);
    await settle();
    expect(port.of("editChannelTopic")[1]).toEqual({ op: "editChannelTopic", channelId: "ch-1", topic: TOPIC });
    expect(port.of("post")).toHaveLength(0);
  });

  it("máquina sem canal ainda: online/offline não fazem nada", async () => {
    hub.emit("online", M);
    hub.emit("offline", M);
    await settle();
    expect(port.calls).toHaveLength(0);
  });

  it("dispose solta os listeners do hub", async () => {
    router.dispose();
    emit(hello());
    await settle();
    expect(port.calls).toHaveLength(0);
  });
});
