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
const RENAME_WINDOW_MS = 30_000;

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
  appliedName: string;
  lastRenameAt: number;
  timer: NodeJS.Timeout | undefined;
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
 * - O nome é `<emoji do estado> <nome da sessão>`; renomeações (por estado ou por nome) acontecem no máximo 1× a
 *   cada 30 s por thread — dentro da janela, só o último pedido é aplicado quando ela abrir.
 */
export class ThreadRegistry {
  private readonly db: Db;
  private readonly port: DiscordPort;
  private readonly channelFor: (machine: string) => Promise<string>;
  private readonly log: (msg: string) => void;
  private readonly byThread = new Map<string, ThreadInfo>();
  private readonly bySession = new Map<string, string>();
  private readonly creating = new Map<string, Promise<string>>();

  constructor(opts: ThreadRegistryOptions) {
    this.db = opts.db;
    this.port = opts.port;
    this.channelFor = opts.channelFor;
    this.log = opts.log ?? ((m) => { console.error(m); });
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
    for (const info of this.byThread.values()) {
      if (info.timer !== undefined) clearTimeout(info.timer);
      info.timer = undefined;
    }
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
    this.byThread.set(threadId, {
      threadId, name, state, appliedName: threadName(name, state), lastRenameAt: Number.NEGATIVE_INFINITY, timer: undefined,
    });
  }

  private schedule(info: ThreadInfo): void {
    if (threadName(info.name, info.state) === info.appliedName) {
      if (info.timer !== undefined) clearTimeout(info.timer);
      info.timer = undefined;
      return;
    }
    if (info.timer !== undefined) return; // o timer pendente aplica o pedido mais recente
    const wait = info.lastRenameAt + RENAME_WINDOW_MS - Date.now();
    if (wait <= 0) {
      this.apply(info);
      return;
    }
    info.timer = setTimeout(() => { this.apply(info); }, wait);
    info.timer.unref();
  }

  private apply(info: ThreadInfo): void {
    info.timer = undefined;
    const target = threadName(info.name, info.state);
    if (target === info.appliedName) return;
    const previous = info.appliedName;
    info.appliedName = target;
    info.lastRenameAt = Date.now();
    this.port.renameThread(info.threadId, target).catch((e: unknown) => {
      if (info.appliedName === target) info.appliedName = previous;
      this.log(`falha ao renomear a thread ${info.threadId} para "${target}": ${(e as Error).message}`);
    });
  }
}
