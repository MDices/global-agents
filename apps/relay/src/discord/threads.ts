import { SessionStateSchema, type SessionState } from "@global-agents/protocol";
import type { Db } from "../db.js";
import type { DiscordPort, EmbedSpec } from "./bot.js";

export const STATE_EMOJI: Record<SessionState, string> = { working: "🟢", waiting: "🟡", done: "⚪", error: "🔴" };
const STATE_LABEL: Record<SessionState, string> = {
  working: "🟢 trabalhando",
  waiting: "🟡 esperando",
  done: "⚪ ociosa",
  error: "🔴 erro",
};
const THREAD_NAME_MAX = 100;
/** Intervalo mínimo entre duas edições do mesmo canal/thread (o Discord aceita ~2 a cada 10 min). */
export const CHANNEL_EDIT_INTERVAL_MS = 300_000;

/** Corta em `max` code units sem deixar meio par substituto no fim. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

export function threadName(name: string, state: SessionState): string {
  return truncate(`${STATE_EMOJI[state]} ${name}`, THREAD_NAME_MAX);
}

export function parseState(raw: string | null | undefined): SessionState | undefined {
  const r = SessionStateSchema.safeParse(raw);
  return r.success ? r.data : undefined;
}

interface UpdaterSlot {
  desired: string | undefined;
  applied: string | undefined;
  inflight: boolean;
  lastStart: number;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Aplica valores (nome de thread, tópico de canal) por chave sem acumular fila no Discord: no máximo **uma**
 * chamada em andamento por chave, intervalo mínimo entre inícios, e só o último valor desejado é aplicado. Quando
 * a chamada em voo termina (sucesso ou erro) e o desejado ainda difere do aplicado, agenda a próxima.
 */
export class LatestOnlyUpdater {
  private readonly slots = new Map<string, UpdaterSlot>();
  private disposed = false;

  constructor(
    private readonly apply: (key: string, value: string) => Promise<void>,
    private readonly log: (msg: string) => void,
    private readonly intervalMs = CHANNEL_EDIT_INTERVAL_MS,
  ) {}

  /** Informa o valor que já está no Discord (sem chamada), se a chave ainda não tem estado. */
  seed(key: string, applied: string | null): void {
    if (applied === null || this.slots.has(key)) return;
    this.slots.set(key, { desired: applied, applied, inflight: false, lastStart: Number.NEGATIVE_INFINITY, timer: undefined });
  }

  set(key: string, value: string): void {
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = { desired: undefined, applied: undefined, inflight: false, lastStart: Number.NEGATIVE_INFINITY, timer: undefined };
      this.slots.set(key, slot);
    }
    slot.desired = value;
    this.pump(slot, key);
  }

  dispose(): void {
    this.disposed = true;
    for (const slot of this.slots.values()) {
      if (slot.timer !== undefined) clearTimeout(slot.timer);
      slot.timer = undefined;
    }
  }

  private pump(slot: UpdaterSlot, key: string): void {
    if (this.disposed || slot.inflight) return; // ao terminar, a chamada em voo chama pump de novo
    if (slot.desired === undefined || slot.desired === slot.applied) {
      if (slot.timer !== undefined) clearTimeout(slot.timer);
      slot.timer = undefined;
      return;
    }
    if (slot.timer !== undefined) return; // o timer pendente aplica o valor mais recente
    const wait = slot.lastStart + this.intervalMs - Date.now();
    if (wait > 0) {
      slot.timer = setTimeout(() => { slot.timer = undefined; this.pump(slot, key); }, wait);
      slot.timer.unref();
      return;
    }
    const value = slot.desired;
    slot.inflight = true;
    slot.lastStart = Date.now();
    this.apply(key, value)
      .then(() => { slot.applied = value; })
      .catch((e: unknown) => { this.log(`falha ao aplicar "${value}" em ${key}: ${(e as Error).message}`); })
      .finally(() => { slot.inflight = false; this.pump(slot, key); });
  }
}

export interface ThreadSession {
  sessionId: string;
  name: string;
  cwd?: string;
  bgId?: string;
  /** Conta Anthropic; sem ela, usa a conta gravada da máquina naquele momento. */
  account?: string;
  /** Estado inicial (emoji do nome); padrão `done` (⚪). */
  state?: SessionState;
}

export interface ThreadRegistryOptions {
  db: Db;
  port: DiscordPort;
  /** Devolve o canal da máquina, criando-o se preciso. */
  channelFor: (machine: string) => Promise<string>;
  log?: (msg: string) => void;
}

interface ThreadInfo {
  threadId: string;
  /** Nome/estado desejados (o último pedido); aplicados no máximo 1×/30 s. */
  name: string;
  state: SessionState;
}

function introEmbed(s: ThreadSession, state: SessionState, account: string | null): EmbedSpec {
  const fields = [
    { name: "Pasta", value: truncate(`\`${s.cwd ?? "—"}\``, 1024), inline: true },
    { name: "Conta", value: truncate(account ?? "—", 1024), inline: true },
    { name: "Estado", value: STATE_LABEL[state], inline: true },
  ];
  if (s.bgId !== undefined) {
    fields.push({ name: "Abrir no terminal", value: truncate(`\`claude attach ${s.bgId}\``, 1024), inline: false });
  }
  const kind = s.bgId !== undefined ? "sessão em background" : "sessão interativa";
  return { title: truncate(`Sessão ${s.name}`, 256), fields, footer: truncate(`${kind} · id ${s.sessionId}`, 2048) };
}

/**
 * Uma thread por sessão no canal da máquina.
 *
 * - `ensureThread` nunca cria duas threads para o mesmo `sessionId`: chamadas concorrentes compartilham a mesma
 *   promessa, e a thread gravada no banco é reaproveitada (restart do relay).
 * - O nome é `<emoji do estado> <nome da sessão>`; renomeações (por estado ou por nome) passam por um
 *   `LatestOnlyUpdater`: no máximo 1 rename em voo por thread, intervalo mínimo de 300 s, só o último nome aplicado.
 */
export class ThreadRegistry {
  private readonly db: Db;
  private readonly port: DiscordPort;
  private readonly channelFor: (machine: string) => Promise<string>;
  private readonly log: (msg: string) => void;
  private readonly byThread = new Map<string, ThreadInfo>();
  private readonly bySession = new Map<string, string>();
  private readonly creating = new Map<string, Promise<string>>();
  private readonly renamer: LatestOnlyUpdater;

  constructor(opts: ThreadRegistryOptions) {
    this.db = opts.db;
    this.port = opts.port;
    this.channelFor = opts.channelFor;
    this.log = opts.log ?? ((m) => { console.error(m); });
    this.renamer = new LatestOnlyUpdater((threadId, name) => this.port.renameThread(threadId, name), this.log);
  }

  /** Thread já conhecida da sessão (memória ou banco), sem criar. */
  threadOf(sessionId: string): string | undefined {
    return this.bySession.get(sessionId) ?? this.db.sessions.get(sessionId)?.threadId ?? undefined;
  }

  ensureThread(machine: string, s: ThreadSession): Promise<string> {
    const known = this.bySession.get(s.sessionId);
    if (known !== undefined) return Promise.resolve(known);
    const inflight = this.creating.get(s.sessionId);
    if (inflight !== undefined) return inflight;

    const row = this.db.sessions.get(s.sessionId);
    if (row !== undefined && row.threadId !== null) {
      this.register(s.sessionId, row.threadId, row.name ?? s.name, parseState(row.state) ?? "done");
      return Promise.resolve(row.threadId);
    }

    const p = this.create(machine, s, s.state ?? parseState(row?.state) ?? "done").finally(() => {
      this.creating.delete(s.sessionId);
    });
    this.creating.set(s.sessionId, p);
    return p;
  }

  setState(threadId: string, state: SessionState): void {
    const info = this.byThread.get(threadId);
    if (info === undefined) return;
    info.state = state;
    this.schedule(info);
  }

  /** Troca o nome da sessão mantendo o emoji atual; nunca cria thread. */
  rename(sessionId: string, newName: string): void {
    const threadId = this.bySession.get(sessionId);
    const info = threadId === undefined ? undefined : this.byThread.get(threadId);
    if (info === undefined) return;
    info.name = newName;
    this.schedule(info);
  }

  dispose(): void {
    this.renamer.dispose();
  }

  private async create(machine: string, s: ThreadSession, state: SessionState): Promise<string> {
    const channelId = await this.channelFor(machine);
    const { threadId } = await this.port.createThread(channelId, threadName(s.name, state));
    this.db.sessions.upsert({
      sessionId: s.sessionId, machine, name: s.name, threadId, state, updatedAt: Date.now(),
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      ...(s.bgId !== undefined ? { bgId: s.bgId } : {}),
    });
    this.register(s.sessionId, threadId, s.name, state);
    const account = s.account ?? this.db.machines.getByName(machine)?.claudeAccount ?? null;
    try {
      await this.port.postEmbed(threadId, introEmbed(s, state, account));
    } catch (e) {
      this.log(`${machine}: falha ao postar a mensagem inicial da thread ${threadId}: ${(e as Error).message}`);
    }
    return threadId;
  }

  private register(sessionId: string, threadId: string, name: string, state: SessionState): void {
    this.bySession.set(sessionId, threadId);
    this.byThread.set(threadId, { threadId, name, state });
    this.renamer.seed(threadId, threadName(name, state));
  }

  private schedule(info: ThreadInfo): void {
    this.renamer.set(info.threadId, threadName(info.name, info.state));
  }
}
