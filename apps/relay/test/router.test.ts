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

  it("hello sem devRoots (agente antigo) → devRootsOf undefined; com devRoots → guarda a lista", async () => {
    emit(hello());
    await settle();
    expect(router.devRootsOf(M)).toBeUndefined();
    emit(ev("agent.hello", { version: "0.2.0", os: "linux", osUser: "leonardo", projects: [], devRoots: ["/home/leonardo/dev"] }));
    await settle();
    expect(router.devRootsOf(M)).toEqual(["/home/leonardo/dev"]);
    expect(router.discoveredOf(M)).toEqual([]);
  });

  it("raízes persistidas: um relay novo (restart) sobre o mesmo banco já sabe que o agente é novo", async () => {
    emit(ev("agent.hello", { version: "0.2.0", os: "linux", osUser: "leonardo", projects: [], devRoots: ["/home/leonardo/dev"] }));
    await settle();
    expect(db.machines.getByName(M)?.devRoots).toEqual(["/home/leonardo/dev"]);
    const restarted = createRouter({ db, port, threads, hub: new EventEmitter<AgentHubEvents>(), log: () => undefined });
    expect(restarted.devRootsOf(M)).toEqual(["/home/leonardo/dev"]);
    expect(restarted.discoveredOf(M)).toEqual([]);
    restarted.dispose();
  });

  it("agent.projects atualiza raízes e descobertos, sem postar nada, mesmo com a máquina silenciada", async () => {
    emit(hello());
    await settle();
    db.machines.setFilterAccount(M, "outra@exemplo.com");
    port.calls.length = 0;
    emit(ev("agent.projects", { devRoots: ["/d"], projects: ["/d/a", "/d/b/repo"] }));
    await settle();
    expect(router.devRootsOf(M)).toEqual(["/d"]);
    expect(router.discoveredOf(M)).toEqual(["/d/a", "/d/b/repo"]);
    expect(port.calls).toEqual([]);
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

  /** Thread já existente (como a do ack do `/novo` ou de uma atividade anterior). */
  const withThread = async (sessionId: string, name: string): Promise<void> => {
    await threads.ensureThread(M, { sessionId, name, cwd: "~/dev/work/gestai" });
    await settle();
  };

  it("session.list sozinho não cria thread: só grava as sessões (alimenta o /sessoes)", async () => {
    emit(ev("session.list", { sessions: [
      info("s1", "correcoes-bugs", { status: "busy" }),
      info("s2", "deploy-homolog", { kind: "background", bgId: "7f3c2a91", state: "blocked" }),
    ] }));
    await settle();
    expect(port.of("createThread")).toEqual([]);
    expect(port.of("postEmbed")).toEqual([]);
    expect(db.sessions.listByMachine(M).map((r) => [r.sessionId, r.name, r.state, r.bgId, r.threadId])).toEqual(
      expect.arrayContaining([["s1", "correcoes-bugs", "working", null, null], ["s2", "deploy-homolog", "waiting", "7f3c2a91", null]]),
    );
  });

  it("o primeiro evento de atividade cria a thread com nome, estado e bgId do session.list", async () => {
    emit(ev("session.list", { sessions: [
      info("s1", "correcoes-bugs", { status: "busy" }),
      info("s2", "deploy-homolog", { kind: "background", bgId: "7f3c2a91", state: "blocked" }),
    ] }));
    emit(ev("turn.reply", { sessionId: "s2", text: "pronto" }));
    await settle();
    expect(port.of("createThread")).toEqual([{ op: "createThread", channelId: "ch-1", name: "🟡 deploy-homolog" }]);
    const embeds = port.of("postEmbed");
    expect(embeds).toHaveLength(1);
    expect(embeds[0]?.embed.fields).toContainEqual({ name: "Abrir no terminal", value: "`claude attach 7f3c2a91`", inline: false });
    expect(postsTo(threadOf("s2"))).toEqual(["pronto"]);
  });

  it.each([
    ["working", "🟢"],
    ["waiting", "🟡"],
  ] as const)("session.status %s (prompt ou notificação) é atividade e cria a thread", async (state, emoji) => {
    emit(ev("session.list", { sessions: [info("s1", "CRM-Onda5")] }));
    emit(ev("session.status", { sessionId: "s1", name: "CRM-Onda5", cwd: "~/dev/work/gestai", state }));
    await settle();
    expect(port.of("createThread")).toEqual([{ op: "createThread", channelId: "ch-1", name: `${emoji} CRM-Onda5` }]);
  });

  it("session.status done (SessionEnd de sessão nunca usada) não cria thread", async () => {
    emit(ev("session.list", { sessions: [info("s1", "gestai-96")] }));
    emit(ev("session.status", { sessionId: "s1", name: "gestai-96", cwd: "~/dev/work/gestai", state: "done" }));
    await settle();
    expect(port.of("createThread")).toEqual([]);
    expect(db.sessions.get("s1")).toMatchObject({ state: "done", threadId: null });
  });

  it("depois de um restart do relay, o session.list renomeia a thread que só está no banco", async () => {
    await withThread("s1", "gestai-8d");
    router.dispose();
    threads.dispose();
    port.calls.length = 0;
    threads = new ThreadRegistry({ db, port, channelFor: machineChannelResolver(db, port), log });
    router = createRouter({ db, port, threads, hub, log });
    emit(ev("session.list", { sessions: [info("s1", "CRM integração com GestAI Hub")] }));
    await settle();
    expect(port.of("createThread")).toEqual([]);
    expect(port.of("renameThread")).toEqual([{ op: "renameThread", threadId: threadOf("s1"), name: "⚪ CRM integração com GestAI Hub" }]);
  });

  it("session.status sem name mantém o nome conhecido (não oscila para o nome da pasta)", async () => {
    emit(ev("session.list", { sessions: [info("s1", "CRM-Onda5")] }));
    emit(ev("session.status", { sessionId: "s1", cwd: "~/dev/work/gestai", state: "working" }));
    await settle();
    expect(port.of("createThread")).toEqual([{ op: "createThread", channelId: "ch-1", name: "🟢 CRM-Onda5" }]);
    emit(ev("session.status", { sessionId: "s1", cwd: "~/dev/work/gestai", state: "waiting" }));
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.of("renameThread")).toEqual([{ op: "renameThread", threadId: threadOf("s1"), name: "🟡 CRM-Onda5" }]);
    expect(db.sessions.get("s1")?.name).toBe("CRM-Onda5");
  });

  it("session.status sem name de sessão desconhecida cria a thread com o nome da pasta (Linux e Windows)", async () => {
    emit(ev("session.status", { sessionId: "s1", cwd: "/home/leonardo/dev/work/gestai", state: "working" }));
    emit(ev("session.status", { sessionId: "s2", cwd: "C:\\Users\\Leo\\dev\\gestai-hub", state: "working" }));
    await settle();
    expect(port.of("createThread").map((c) => c.name)).toEqual(["🟢 gestai", "🟢 gestai-hub"]);
  });

  it("session.list com nome alterado renomeia a thread e não cria outra", async () => {
    await withThread("s1", "correcoes-bugs");
    emit(ev("session.list", { sessions: [info("s1", "bugs-faturamento")] }));
    await settle();
    expect(port.of("createThread")).toHaveLength(1);
    expect(port.of("renameThread")).toEqual([{ op: "renameThread", threadId: threadOf("s1"), name: "⚪ bugs-faturamento" }]);
    expect(db.sessions.get("s1")?.name).toBe("bugs-faturamento");
  });

  it("session.status renomeia com o emoji do estado", async () => {
    await withThread("s1", "correcoes-bugs");
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
    await withThread("s1", "correcoes-bugs");
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

describe("times de agentes (thread do líder)", () => {
  type Member = { name: string; state: "working" | "idle" | "ended" };
  type Task = { id: string; subject: string; status: "pending" | "completed"; owner?: string };
  const update = (members: Member[], tasks: Task[] = []): AgentEvent =>
    ev("team.update", { leadSessionId: "s1", team: "session-6370870f", members, tasks });
  const panelPosts = (): string[] => postsTo(threadOf("s1")).filter((t) => t.startsWith("**👥 Time**"));

  beforeEach(async () => {
    emit(hello());
    emit(ev("session.list", { sessions: [info("s1", "lider")] }));
    await settle();
  });

  it("primeiro team.update posta o painel e fixa; os seguintes viram no máximo 1 edição a cada 5 s, com o último valor", async () => {
    emit(update([{ name: "alpha", state: "working" }, { name: "beta", state: "working" }],
      [{ id: "1", subject: "contar arquivos em docs", status: "pending" }, { id: "2", subject: "listar pastas de apps", status: "completed", owner: "beta" }]));
    await settle();
    const thread = threadOf("s1");
    expect(panelPosts()).toEqual([
      "**👥 Time** · session-6370870f · 2 teammates\n" +
      "**Membros:** 🟢 alpha trabalhando · 🟢 beta trabalhando\n" +
      "**Tarefas**\n" +
      "☐ contar arquivos em docs\n" +
      "☑ listar pastas de apps — beta\n" +
      "-# lider · fedora/leonardo · atualizado às 18:40",
    ]);
    expect(port.of("pin")).toEqual([{ op: "pin", channelId: thread, messageId: expect.stringMatching(/^msg-\d+$/) as string }]);

    for (const st of ["idle", "working", "idle"] as const) {
      emit(update([{ name: "alpha", state: st }, { name: "beta", state: "ended" }]));
      await settle();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(port.of("edit")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000); // 5 s desde o post
    expect(port.of("edit")).toHaveLength(1);
    expect(port.of("edit")[0]).toMatchObject({ channelId: thread, messageId: port.of("pin")[0]?.messageId });
    expect(port.of("edit")[0]?.text).toContain("**Membros:** 💤 alpha ocioso · ⚫ beta encerrado");
    expect(port.of("edit")[0]?.text).toContain("**Tarefas:** nenhuma");

    emit(update([{ name: "alpha", state: "ended" }, { name: "beta", state: "ended" }]));
    await settle();
    expect(port.of("edit")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(port.of("edit")).toHaveLength(2);
    expect(port.of("edit")[1]?.text).toContain("⚫ alpha encerrado");
    expect(panelPosts()).toHaveLength(1);
    expect(port.of("pin")).toHaveLength(1);
  });

  it("falha ao fixar só loga; o painel segue editável", async () => {
    port.pinImpl = () => Promise.reject(new Error("limite de 50 fixadas"));
    emit(update([{ name: "alpha", state: "working" }]));
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("limite de 50 fixadas"));
    emit(update([{ name: "alpha", state: "idle" }]));
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(port.of("edit")).toHaveLength(1);
  });

  it("team.event vira linha curta na thread do líder", async () => {
    const te = (kind: Extract<AgentEvent, { type: "team.event" }>["kind"], extra: Record<string, string> = {}): AgentEvent =>
      ev("team.event", { leadSessionId: "s1", kind, ...extra });
    emit(te("task_created", { taskId: "1", subject: "contar arquivos em docs" }));
    emit(te("task_completed", { teammate: "alpha", taskId: "1", subject: "contar arquivos em docs" }));
    emit(te("teammate_idle", { teammate: "beta" }));
    emit(te("teammate_reply", { teammate: "alpha", text: "docs tem 10 arquivos." }));
    emit(te("teammate_ended", { teammate: "alpha" }));
    emit(te("teammate_permission"));
    await settle();
    expect(postsTo(threadOf("s1"))).toEqual([
      "📋 tarefa criada: contar arquivos em docs",
      "✅ alpha concluiu: contar arquivos em docs",
      "💤 beta ocioso",
      "💬 alpha: docs tem 10 arquivos.",
      "⚫ alpha encerrado",
      "🟡 um teammate aguarda permissão no terminal do líder",
    ]);
  });

  it("teamMembersOf: membros do último team.update que não encerraram", async () => {
    expect(router.teamMembersOf("s1")).toEqual([]);
    emit(update([{ name: "alpha", state: "working" }, { name: "beta", state: "ended" }, { name: "gama", state: "idle" }]));
    await settle();
    expect(router.teamMembersOf("s1")).toEqual(["alpha", "gama"]);
  });

  it("máquina silenciada pelo filtro de conta não ganha painel nem linhas", async () => {
    db.machines.setFilterAccount(M, "outra@exemplo.com");
    emit(update([{ name: "alpha", state: "working" }]));
    emit(ev("team.event", { leadSessionId: "s1", kind: "teammate_permission" }));
    await settle();
    expect(port.of("createThread")).toEqual([]);
    expect(port.of("post")).toEqual([]);
    expect(port.of("pin")).toEqual([]);
  });
});

describe("dono da sessão (spoofing entre máquinas)", () => {
  const B = "mac/leo";

  beforeEach(async () => {
    emit(hello());
    emit(hello(B));
    await settle();
    emit(ev("session.list", { sessions: [info("sb", "sessao-de-b")] }, B));
    await settle();
    port.calls.length = 0;
    log.mockClear();
  });

  const intact = (): void => {
    expect(db.sessions.get("sb")).toMatchObject({ machine: B, name: "sessao-de-b" });
    expect(port.of("post")).toHaveLength(0);
    expect(port.of("createThread")).toHaveLength(0);
    expect(port.of("renameThread")).toHaveLength(0);
    expect(port.of("postEmbed")).toHaveLength(0);
  };

  it("session.status de outra máquina não posta, não renomeia e não reatribui a sessão", async () => {
    emit(ev("session.status", { sessionId: "sb", name: "sequestro", cwd: "/x", state: "working" }));
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    intact();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("sessão de outra máquina"));
  });

  it("turn.reply e turn.prompt de outra máquina não postam na thread dela", async () => {
    emit(ev("turn.reply", { sessionId: "sb", text: "resposta falsa" }));
    emit(ev("turn.prompt", { sessionId: "sb", text: "prompt falso", source: "terminal" }));
    await settle();
    intact();
  });

  it("session.list de outra máquina ignora só a sessão alheia; as próprias seguem", async () => {
    emit(ev("session.list", { sessions: [info("sb", "sequestro"), info("sa", "minha")] }));
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(db.sessions.get("sb")).toMatchObject({ machine: B, name: "sessao-de-b" });
    expect(db.sessions.get("sa")?.machine).toBe(M);
    expect(port.of("createThread")).toEqual([]);
    expect(port.of("renameThread")).toHaveLength(0);
  });

  it("agent.warning, team.update e team.event com sessão de outra máquina são ignorados", async () => {
    emit(ev("agent.warning", { message: "falso", sessionId: "sb" }));
    emit(ev("team.update", { leadSessionId: "sb", team: "t", members: [{ name: "alpha", state: "working" }], tasks: [] }));
    emit(ev("team.event", { leadSessionId: "sb", kind: "teammate_permission" }));
    await settle();
    intact();
    expect(router.teamMembersOf("sb")).toEqual([]);
  });

  it("os mesmos eventos vindos da dona continuam funcionando", async () => {
    emit(ev("session.status", { sessionId: "sb", name: "sessao-de-b", cwd: "/x", state: "working" }, B));
    emit(ev("turn.reply", { sessionId: "sb", text: "pronto" }, B));
    emit(ev("session.list", { sessions: [info("sb", "renomeada")] }, B));
    await settle();
    expect(postsTo(threadOf("sb"))).toEqual(["pronto"]);
    expect(db.sessions.get("sb")).toMatchObject({ machine: B, name: "renomeada" });
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
    expect(port.of("editChannelTopic")).toHaveLength(1); // intervalo mínimo de 300 s entre edições
    await vi.advanceTimersByTimeAsync(300_000);
    expect(port.of("editChannelTopic")[1]).toEqual({ op: "editChannelTopic", channelId: "ch-1", topic: TOPIC });
    expect(port.of("post")).toHaveLength(0);
  });

  it("hello com tópico igual ao do canal não edita o tópico", async () => {
    emit(hello());
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.of("editChannelTopic")).toHaveLength(0);
  });

  it("edição de tópico travada não segura as mensagens: hello seguido de turn.reply posta", async () => {
    port.presetChannel("fedora-leonardo", "tópico velho");
    port.topicEdit = () => new Promise<void>(() => { /* nunca resolve (rate limit esgotado) */ });
    emit(hello());
    emit(ev("turn.reply", { sessionId: "s1", text: "pronto" }));
    await settle();
    expect(port.of("editChannelTopic")).toEqual([{ op: "editChannelTopic", channelId: "ch-1", topic: TOPIC }]);
    expect(postsTo(threadOf("s1"))).toEqual(["pronto"]);
  });

  it("5 ciclos offline/online: no máximo 1 edição em voo e o último valor aplicado é o de online", async () => {
    emit(hello());
    await settle();
    port.topicEdit = () => new Promise<void>((r) => setTimeout(r, 90_000));
    for (let i = 0; i < 5; i++) {
      hub.emit("offline", M);
      await vi.advanceTimersByTimeAsync(20_000);
      hub.emit("online", M);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    await vi.advanceTimersByTimeAsync(1_800_000);
    const edits = port.of("editChannelTopic");
    expect(port.maxTopicsInFlight).toBe(1);
    expect(edits.length).toBeLessThanOrEqual(2);
    expect(edits.at(-1)?.topic).toBe(TOPIC);
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
