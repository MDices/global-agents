import { newEnvelope, RelayCommandSchema, type AgentEvent, type RelayCommand } from "@global-agents/protocol";
import type { Db, PendingCommand } from "./db.js";
import type { DiscordPort } from "./discord/bot.js";
import { chunkText } from "./discord/chunk.js";
import type { AgentHub } from "./ws/server.js";

/** Quanto um comando para máquina offline espera na fila antes de expirar. */
export const COMMAND_TTL_MS = 3_600_000;
/** Intervalo do loop que expira a fila. */
export const EXPIRY_INTERVAL_MS = 60_000;
export const REJECT_CLAUDE_COMMAND_TEXT = "comandos do Claude não são aceitos aqui; use /claude dentro da thread";
export const EXPIRED_TEXT = "comando expirou: máquina offline por mais de 1 h";

const QUEUED = "⏳";
const OK = "✅";
const FAIL = "❌";

/** Mensagem postada numa thread do Discord, já reduzida ao que a ponte usa. */
export interface ThreadMessage {
  authorId: string;
  threadId: string;
  messageId: string;
  content: string;
  isBot: boolean;
}

export interface CommandBridgeDeps {
  db: Db;
  hub: Pick<AgentHub, "send" | "isOnline">;
  port: DiscordPort;
  /** Só mensagens destes autores viram comando (nunca o canal decide). */
  allowedUserIds: readonly string[];
  /** `machine` do envelope dos comandos que saem do relay. */
  relayMachine?: string;
  log?: (msg: string) => void;
}

/** Quem pediu um comando que não nasceu de mensagem de thread (slash command, menção): recebe o desfecho. */
export interface CommandCallbacks {
  onAck(result: Record<string, unknown> | undefined): void;
  /** Razão do `command.error`, ou o aviso de expiração na fila. */
  onError(reason: string): void;
}

/** `sent`: entregue à máquina; `queued`: máquina offline, na fila por 1 h; `failed`: não deu para enfileirar. */
export type SubmitResult = "sent" | "queued" | "failed";

export interface CommandBridge {
  /**
   * Envia um comando com origem por callback, com a mesma fila offline das mensagens de thread (sem reações). A
   * origem fica só em memória: se o relay reiniciar com o comando na fila, o ack após a drenagem é ignorado.
   */
  submit(machine: string, cmd: RelayCommand, cb: CommandCallbacks): SubmitResult;
  /** Mensagem nova numa thread; nunca rejeita. */
  onThreadMessage(msg: ThreadMessage): Promise<void>;
  /** Evento de agente; só `command.ack`/`command.error` de comandos enviados por aqui têm efeito. */
  onAck(machine: string, ev: AgentEvent): Promise<void>;
  /** Drena a fila da máquina que acabou de conectar, em ordem de chegada. */
  onMachineOnline(machine: string): Promise<void>;
  /** Expira a fila agora (o loop chama a cada 60 s). */
  expire(): Promise<void>;
  /** Liga o loop de expiração. */
  start(): void;
  /** Resolve quando as chamadas ao Discord já disparadas terminaram. */
  idle(): Promise<void>;
  /** Para o loop de expiração. */
  dispose(): void;
}

/** De onde veio o comando: mensagem de thread (reações) ou callback (slash command, menção). */
type Origin = { kind: "thread"; threadId: string } | { kind: "callback"; cb: CommandCallbacks };

/** Comando enviado aguardando ack: a origem e, para mensagem de thread, se ela tem ⏳ para tirar. */
interface Inflight {
  machine: string;
  origin: Origin;
  queued: boolean;
  sentAt: number;
}

/**
 * Ponte thread do Discord → `session.send` na máquina.
 *
 * - Só autores da allowlist, nunca bots; threads que não são de sessão são ignoradas em silêncio.
 * - Texto começando com `/` ou `!` é recusado (❌ + resposta), nada é enviado.
 * - `commandId` é o id da mensagem do Discord: a máquina deduplica por ele, então um reenvio da fila é seguro.
 * - Online: envia e só reage no ack (✅) ou no erro (❌ + razão). Offline: grava em `pending_commands` com validade de
 *   1 h e reage ⏳; quando a máquina conecta, a fila é reenviada como foi gravada (mesmo envelope). O que passar de
 *   1 h troca ⏳ por ❌ com aviso.
 * - `submit` leva a mesma fila a comandos de slash command/menção: a origem é um callback (sem reações), que recebe o
 *   ack, o erro ou o aviso de expiração.
 * - As chamadas ao Discord de uma mesma mensagem são feitas em série (o ⏳ nunca é removido antes de ter sido posto);
 *   falhas vão para `log`.
 */
export function createCommandBridge(deps: CommandBridgeDeps): CommandBridge {
  const { db, hub, port } = deps;
  const allowed = new Set(deps.allowedUserIds);
  const relayMachine = deps.relayMachine ?? "relay/vps";
  const log = deps.log ?? ((m: string) => { console.error(m); });
  const inflight = new Map<string, Inflight>();
  /** Callbacks dos comandos na fila (por `commandId`), até a drenagem ou a expiração. */
  const queuedCallbacks = new Map<string, CommandCallbacks>();
  const chains = new Map<string, Promise<void>>();
  let timer: NodeJS.Timeout | undefined;

  /** Enfileira uma chamada ao Discord na cadeia da mensagem; erro vira log. */
  const discord = (messageId: string, label: string, fn: () => Promise<unknown>): void => {
    const prev = chains.get(messageId) ?? Promise.resolve();
    const next = prev.then(fn).then(
      () => undefined,
      (e: unknown) => { log(`${label} (mensagem ${messageId}): ${(e as Error).message}`); },
    );
    chains.set(messageId, next);
    void next.then(() => { if (chains.get(messageId) === next) chains.delete(messageId); });
  };

  const replyAll = (threadId: string, messageId: string, text: string): void => {
    for (const chunk of chunkText(text)) {
      discord(messageId, "falha ao responder", () => port.reply(threadId, messageId, chunk));
    }
  };

  /** Thread da sessão alvo de um comando da fila. */
  const threadOfCommand = (cmd: RelayCommand): string | undefined =>
    cmd.type === "session.send" ? (db.sessions.get(cmd.sessionId)?.threadId ?? undefined) : undefined;

  const parsePayload = (row: PendingCommand): RelayCommand | undefined => {
    try {
      const r = RelayCommandSchema.safeParse(JSON.parse(row.payload));
      return r.success ? r.data : undefined;
    } catch {
      return undefined;
    }
  };

  const expire = (): void => {
    const now = Date.now();
    for (const row of db.pendingCommands.expireBefore(now)) {
      const cb = queuedCallbacks.get(row.commandId);
      if (cb !== undefined) {
        queuedCallbacks.delete(row.commandId);
        callback(row.commandId, () => { cb.onError(EXPIRED_TEXT); });
        continue;
      }
      const cmd = parsePayload(row);
      const threadId = cmd === undefined ? undefined : threadOfCommand(cmd);
      const messageId = row.discordMessageId ?? row.commandId;
      if (threadId === undefined) {
        log(`${row.machine}: comando ${row.commandId} expirou, mas a thread da sessão não foi encontrada`);
        continue;
      }
      discord(messageId, "falha ao tirar ⏳", () => port.removeReaction(threadId, messageId, QUEUED));
      discord(messageId, "falha ao reagir", () => port.react(threadId, messageId, FAIL));
      replyAll(threadId, messageId, EXPIRED_TEXT);
    }
    // Comando enviado que nunca recebeu resposta (a máquina caiu antes do ack): não segura memória para sempre.
    for (const [commandId, f] of inflight) {
      if (now - f.sentAt > COMMAND_TTL_MS) inflight.delete(commandId);
    }
  };

  const drain = (machine: string): void => {
    expire(); // o que venceu enquanto a máquina estava fora é avisado já, não reenviado
    for (const row of db.pendingCommands.listDue(machine)) {
      const cmd = parsePayload(row);
      if (cmd === undefined) {
        log(`${machine}: comando ${row.commandId} na fila com payload inválido; descartado`);
        db.pendingCommands.remove(row.commandId);
        continue;
      }
      if (!hub.send(machine, cmd)) return; // caiu de novo: o resto espera a próxima conexão
      db.pendingCommands.remove(row.commandId);
      const cb = queuedCallbacks.get(cmd.commandId);
      queuedCallbacks.delete(cmd.commandId);
      const threadId = threadOfCommand(cmd);
      if (cb !== undefined) {
        inflight.set(cmd.commandId, { machine, origin: { kind: "callback", cb }, queued: true, sentAt: Date.now() });
      } else if (threadId !== undefined) {
        inflight.set(cmd.commandId, { machine, origin: { kind: "thread", threadId }, queued: true, sentAt: Date.now() });
      }
    }
  };

  const onThreadMessage = (msg: ThreadMessage): void => {
    if (msg.isBot || !allowed.has(msg.authorId)) return;
    const session = db.sessions.getByThread(msg.threadId);
    if (session === undefined) return;
    const text = msg.content;
    const head = text.trimStart();
    if (head === "") return;
    const { threadId, messageId } = msg;
    if (head.startsWith("/") || head.startsWith("!")) {
      discord(messageId, "falha ao reagir", () => port.react(threadId, messageId, FAIL));
      replyAll(threadId, messageId, REJECT_CLAUDE_COMMAND_TEXT);
      return;
    }

    const cmd: RelayCommand = { ...newEnvelope(relayMachine), type: "session.send", commandId: messageId, sessionId: session.sessionId, text };
    dispatch(session.machine, cmd, { kind: "thread", threadId });
  };

  /** Envia já, ou grava na fila (1 h) e avisa a origem; drena se a máquina conectou no meio do caminho. */
  const dispatch = (machine: string, cmd: RelayCommand, origin: Origin): SubmitResult => {
    const { commandId } = cmd;
    if (hub.isOnline(machine) && hub.send(machine, cmd)) {
      inflight.set(commandId, { machine, origin, queued: false, sentAt: Date.now() });
      return "sent";
    }
    const now = Date.now();
    try {
      db.pendingCommands.add({
        commandId, machine, payload: JSON.stringify(cmd), createdAt: now, expiresAt: now + COMMAND_TTL_MS,
        ...(origin.kind === "thread" ? { discordMessageId: commandId } : {}),
      });
    } catch (e) {
      log(`${machine}: falha ao enfileirar o comando ${commandId}: ${(e as Error).message}`);
      return "failed";
    }
    if (origin.kind === "thread") {
      const { threadId } = origin;
      discord(commandId, "falha ao reagir", () => port.react(threadId, commandId, QUEUED));
    } else {
      queuedCallbacks.set(commandId, origin.cb);
    }
    // A máquina pode ter conectado entre a checagem e a gravação: o `online` já drenou a fila vazia.
    if (hub.isOnline(machine)) drain(machine);
    return "queued";
  };

  /** Chama o callback de uma origem; se ele lançar, só loga. */
  const callback = (commandId: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      log(`callback do comando ${commandId}: ${(e as Error).message}`);
    }
  };

  const onAck = (machine: string, ev: AgentEvent): void => {
    if (ev.type !== "command.ack" && ev.type !== "command.error") return;
    const f = inflight.get(ev.commandId);
    if (f === undefined || f.machine !== machine) return;
    inflight.delete(ev.commandId);
    if (f.origin.kind === "callback") {
      const { cb } = f.origin;
      callback(ev.commandId, ev.type === "command.ack" ? () => { cb.onAck(ev.result); } : () => { cb.onError(ev.reason); });
      return;
    }
    const { threadId } = f.origin;
    const messageId = ev.commandId;
    if (f.queued) discord(messageId, "falha ao tirar ⏳", () => port.removeReaction(threadId, messageId, QUEUED));
    if (ev.type === "command.ack") {
      discord(messageId, "falha ao reagir", () => port.react(threadId, messageId, OK));
      return;
    }
    discord(messageId, "falha ao reagir", () => port.react(threadId, messageId, FAIL));
    replyAll(threadId, messageId, `${FAIL} ${ev.reason}`);
  };

  /** Nenhum caminho da ponte pode derrubar quem chamou (listener do Discord ou do hub). */
  const guard = (label: string, fn: () => void): Promise<void> => {
    try {
      fn();
    } catch (e) {
      log(`${label}: ${(e as Error).message}`);
    }
    return Promise.resolve();
  };

  return {
    submit(machine, cmd, cb) {
      try {
        return dispatch(machine, cmd, { kind: "callback", cb });
      } catch (e) {
        log(`${machine}: ${cmd.type} ${cmd.commandId}: ${(e as Error).message}`);
        return "failed";
      }
    },
    onThreadMessage: (msg) => guard(`mensagem ${msg.messageId}`, () => { onThreadMessage(msg); }),
    onAck: (machine, ev) => guard(`${machine}: ${ev.type}`, () => { onAck(machine, ev); }),
    onMachineOnline: (machine) => guard(`${machine}: fila`, () => { drain(machine); }),
    expire: () => guard("expiração da fila", expire),
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => { void guard("expiração da fila", expire); }, EXPIRY_INTERVAL_MS);
      timer.unref();
    },
    async idle() {
      while (chains.size > 0) await Promise.all(chains.values());
    },
    dispose() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
