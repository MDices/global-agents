import type { EventEmitter } from "node:events";
import type { AgentEvent, SessionInfo, SessionState } from "@global-agents/protocol";
import type { Db } from "./db.js";
import type { DiscordPort } from "./discord/bot.js";
import { chunkText } from "./discord/chunk.js";
import { LatestOnlyUpdater, parseState, truncate, type ThreadRegistry, type ThreadSession } from "./discord/threads.js";
import type { AgentHubEvents } from "./ws/server.js";

type Log = (msg: string) => void;
type EventOf<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

const TOPIC_MAX = 1024;
const OS_LABEL: Record<string, string> = { linux: "Linux", win32: "Windows", darwin: "macOS" };

/** `fedora/leonardo` → `fedora-leonardo` (e qualquer caractere que o Discord não aceita em nome de canal vira `-`). */
export function channelName(machine: string): string {
  return machine.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

/**
 * `<hostname>/<usuario> · <SO> · Claude Code <versão> · <conta>`, a partir do que o banco sabe da máquina, com
 * `· filtro: <conta>` no fim quando o filtro de conta está ligado.
 */
export function machineTopic(db: Db, machine: string): string {
  const m = db.machines.getByName(machine);
  const os = m?.os == null ? "—" : (OS_LABEL[m.os] ?? m.os);
  const filter = m?.filterAccount == null ? "" : ` · filtro: ${m.filterAccount}`;
  return truncate(`${machine} · ${os} · Claude Code ${m?.claudeVersion ?? "—"} · ${m?.claudeAccount ?? "—"}${filter}`, TOPIC_MAX);
}

const sameAccount = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A máquina está silenciada: há filtro de conta e a conta do último `hello` é outra (ou desconhecida). Comparação
 * sem diferenciar maiúsculas.
 */
export function isSilenced(db: Db, machine: string): boolean {
  const m = db.machines.getByName(machine);
  if (m?.filterAccount == null) return false;
  return m.claudeAccount === null || !sameAccount(m.claudeAccount, m.filterAccount);
}

const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Canal da máquina: o gravado no banco, ou garante um (`ensureChannel`) e grava. Concorrência por máquina deduplicada. */
export function machineChannelResolver(db: Db, port: DiscordPort): (machine: string) => Promise<string> {
  const inflight = new Map<string, Promise<string>>();
  return (machine) => {
    const known = db.machines.getByName(machine)?.channelId;
    if (known != null) return Promise.resolve(known);
    const pending = inflight.get(machine);
    if (pending !== undefined) return pending;
    const p = port.ensureChannel(channelName(machine), machineTopic(db, machine))
      .then(({ channelId }) => {
        db.machines.setChannel(machine, channelId);
        return channelId;
      })
      .finally(() => { inflight.delete(machine); });
    inflight.set(machine, p);
    return p;
  };
}

/** Estado do emoji a partir do `SessionInfo` do `session.list`; `undefined` quando a lista não diz nada. */
export function stateFromInfo(s: SessionInfo): SessionState | undefined {
  if (s.state === "failed") return "error";
  if (s.status === "busy") return "working";
  if (s.status === "waiting") return "waiting";
  if (s.status === "idle") return "done";
  switch (s.state) {
    case "working": return "working";
    case "blocked": return "waiting";
    case "done":
    case "stopped": return "done";
    default: return undefined;
  }
}

/** Prompt do terminal como citação: `> 🧑 **prompt:** …`, com `> ` em toda linha de toda fatia (≤ 2000 chars). */
export function quotePrompt(text: string): string[] {
  const quoted = text.split("\n").map((l, i) => (i === 0 ? `> 🧑 **prompt:** ${l}` : `> ${l}`)).join("\n");
  return chunkText(quoted).map((chunk) =>
    chunk.split("\n").map((l) => (l.startsWith("> ") || /^-# \(parte \d+\/\d+\)$/.test(l) ? l : `> ${l}`)).join("\n"),
  );
}

export interface RouterDeps {
  db: Db;
  port: DiscordPort;
  threads: ThreadRegistry;
  hub: EventEmitter<AgentHubEvents>;
  log?: Log;
}

export interface Router {
  /** Pastas de projeto informadas no último `agent.hello` da máquina. */
  projectsOf(machine: string): string[];
  /** Reaplica o tópico do canal da máquina (ex.: o filtro de conta mudou), pelo mesmo controle de rate limit. */
  refreshTopic(machine: string): void;
  /** Resolve quando todos os eventos já recebidos foram processados. */
  idle(): Promise<void>;
  dispose(): void;
}

/**
 * Liga os eventos do hub ao Discord. Os eventos de cada máquina são processados em série (ordem garantida: thread
 * antes do post, fatias em sequência). Edição de tópico nunca é aguardada no caminho dos eventos: `hello`, `online`
 * e `offline` só atualizam o tópico desejado de um `LatestOnlyUpdater` por canal (no máximo 1 edição em voo,
 * intervalo mínimo de 300 s, só o último valor aplicado). Com filtro de conta ligado e a conta da máquina diferente,
 * nada de sessão é postado nem vira thread (o hello passa). Erros vão para `log`, nunca derrubam o processo nem
 * travam a fila.
 */
export function createRouter(deps: RouterDeps): Router {
  const { db, port, threads, hub } = deps;
  const log: Log = deps.log ?? ((m) => { console.error(m); });
  const channelFor = machineChannelResolver(db, port);
  const projects = new Map<string, string[]>();
  /** Desde quando a máquina está offline (para o tópico); ausente = online ou nunca vista. */
  const offlineSince = new Map<string, Date>();
  const queues = new Map<string, Promise<void>>();
  const topics = new LatestOnlyUpdater((channelId, topic) => port.editChannelTopic(channelId, topic), log);

  const enqueue = (key: string, label: string, fn: () => Promise<void>): void => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn).catch((e: unknown) => { log(`${label}: ${(e as Error).message}`); });
    queues.set(key, next);
    void next.then(() => { if (queues.get(key) === next) queues.delete(key); });
  };

  const postAll = async (target: string, chunks: string[]): Promise<void> => {
    for (const c of chunks) await port.post(target, c);
  };

  /** Thread da sessão; se ainda não existe, cria com o que o banco sabe (ou um nome derivado do id). */
  const threadFor = (machine: string, sessionId: string): Promise<string> => {
    const row = db.sessions.get(sessionId);
    const state = parseState(row?.state);
    const s: ThreadSession = {
      sessionId,
      name: row?.name ?? `sessão ${sessionId.slice(0, 8)}`,
      ...(row?.cwd != null ? { cwd: row.cwd } : {}),
      ...(row?.bgId != null ? { bgId: row.bgId } : {}),
      ...(state !== undefined ? { state } : {}),
    };
    return threads.ensureThread(machine, s);
  };

  const onHello = async (machine: string, e: EventOf<"agent.hello">): Promise<void> => {
    db.machines.touch(machine, Date.now(), {
      os: e.os,
      ...(e.claudeVersion !== undefined ? { claudeVersion: e.claudeVersion } : {}),
      ...(e.claudeAccount !== undefined ? { claudeAccount: e.claudeAccount } : {}),
    });
    projects.set(machine, [...e.projects]);
    const desired = machineTopic(db, machine);
    const { channelId, topic } = await port.ensureChannel(channelName(machine), desired);
    db.machines.setChannel(machine, channelId);
    topics.seed(channelId, topic);
    topics.set(channelId, desired);
  };

  const onSessionList = async (machine: string, e: EventOf<"session.list">): Promise<void> => {
    for (const s of e.sessions) {
      const state = stateFromInfo(s);
      const threadId = await threads.ensureThread(machine, {
        sessionId: s.sessionId, name: s.name, cwd: s.cwd,
        ...(s.bgId !== undefined ? { bgId: s.bgId } : {}),
        ...(state !== undefined ? { state } : {}),
      });
      threads.rename(s.sessionId, s.name);
      if (state !== undefined) threads.setState(threadId, state);
      db.sessions.upsert({
        sessionId: s.sessionId, machine, name: s.name, cwd: s.cwd, updatedAt: Date.now(),
        state: state ?? db.sessions.get(s.sessionId)?.state ?? "done",
        ...(s.bgId !== undefined ? { bgId: s.bgId } : {}),
      });
    }
  };

  const onStatus = async (machine: string, e: EventOf<"session.status">): Promise<void> => {
    const threadId = await threads.ensureThread(machine, { sessionId: e.sessionId, name: e.name, cwd: e.cwd, state: e.state });
    threads.rename(e.sessionId, e.name);
    threads.setState(threadId, e.state);
    db.sessions.upsert({ sessionId: e.sessionId, machine, name: e.name, cwd: e.cwd, state: e.state, updatedAt: Date.now() });
  };

  const onPrompt = async (machine: string, e: EventOf<"turn.prompt">): Promise<void> => {
    if (e.source !== "terminal") return; // prompt remoto: a própria mensagem do usuário já está na thread (reação no ack)
    await postAll(await threadFor(machine, e.sessionId), quotePrompt(e.text));
  };

  const onReply = async (machine: string, e: EventOf<"turn.reply">): Promise<void> => {
    await postAll(await threadFor(machine, e.sessionId), chunkText(e.text));
  };

  const onWarning = async (machine: string, e: EventOf<"agent.warning">): Promise<void> => {
    const thread = e.sessionId === undefined ? undefined : threads.threadOf(e.sessionId);
    await postAll(thread ?? (await channelFor(machine)), chunkText(`⚠️ ${e.message}`));
  };

  const handle = (machine: string, e: AgentEvent): Promise<void> => {
    // Filtro de conta: nada de thread nem post para a máquina enquanto a conta dela for outra. O hello sempre passa
    // (é ele que atualiza a conta); aviso sem sessão é da máquina, não de uma sessão, e também passa.
    if (e.type !== "agent.hello" && !(e.type === "agent.warning" && e.sessionId === undefined) && isSilenced(db, machine)) {
      return Promise.resolve();
    }
    switch (e.type) {
      case "agent.hello": return onHello(machine, e);
      case "session.list": return onSessionList(machine, e);
      case "session.status": return onStatus(machine, e);
      case "turn.prompt": return onPrompt(machine, e);
      case "turn.reply": return onReply(machine, e);
      case "agent.warning": return onWarning(machine, e);
      default: return Promise.resolve(); // acks: ponte de comandos (commands.ts); permissões: tarefas seguintes
    }
  };

  const setTopic = (machine: string): void => {
    const channelId = db.machines.getByName(machine)?.channelId;
    if (channelId == null) return; // máquina ainda sem canal: o hello cria com o tópico certo
    const topic = machineTopic(db, machine);
    const since = offlineSince.get(machine);
    topics.set(channelId, since !== undefined ? truncate(`🔴 máquina offline desde ${hhmm(since)} · ${topic}`, TOPIC_MAX) : topic);
  };

  const onEvent = (machine: string, e: AgentEvent): void => {
    enqueue(`events:${machine}`, `${machine}: ${e.type}`, () => handle(machine, e));
  };
  const onOnline = (machine: string): void => { offlineSince.delete(machine); setTopic(machine); };
  const onOffline = (machine: string): void => { offlineSince.set(machine, new Date()); setTopic(machine); };

  hub.on("event", onEvent);
  hub.on("online", onOnline);
  hub.on("offline", onOffline);

  return {
    projectsOf: (machine) => [...(projects.get(machine) ?? [])],
    refreshTopic: setTopic,
    async idle() {
      while (queues.size > 0) await Promise.all(queues.values());
    },
    dispose() {
      topics.dispose();
      hub.off("event", onEvent);
      hub.off("online", onOnline);
      hub.off("offline", onOffline);
    },
  };
}
