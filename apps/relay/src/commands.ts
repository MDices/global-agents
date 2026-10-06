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

export interface CommandBridge {
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

/** Comando enviado aguardando ack: onde reagir e se a mensagem tem ⏳ para tirar. */
interface Inflight {
  machine: string;
  threadId: string;
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
 * - As chamadas ao Discord de uma mesma mensagem são feitas em série (o ⏳ nunca é removido antes de ter sido posto);
 *   falhas vão para `log`.
 */
export function createCommandBridge(deps: CommandBridgeDeps): CommandBridge {
  const { db, hub, port } = deps;
  const allowed = new Set(deps.allowedUserIds);
  const relayMachine = deps.relayMachine ?? "relay/vps";
  const log = deps.log ?? ((m: string) => { console.error(m); });
  const inflight = new Map<string, Inflight>();
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
      const threadId = threadOfCommand(cmd);
      if (threadId !== undefined) {
        inflight.set(cmd.commandId, { machine, threadId, queued: true, sentAt: Date.now() });
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

    const machine = session.machine;
    const cmd: RelayCommand = { ...newEnvelope(relayMachine), type: "session.send", commandId: messageId, sessionId: session.sessionId, text };
    if (hub.isOnline(machine) && hub.send(machine, cmd)) {
      inflight.set(messageId, { machine, threadId, queued: false, sentAt: Date.now() });
      return;
    }
    const now = Date.now();
    try {
      db.pendingCommands.add({
        commandId: messageId, machine, payload: JSON.stringify(cmd), createdAt: now, expiresAt: now + COMMAND_TTL_MS, discordMessageId: messageId,
      });
    } catch (e) {
      log(`${machine}: falha ao enfileirar o comando ${messageId}: ${(e as Error).message}`);
      return;
    }
    discord(messageId, "falha ao reagir", () => port.react(threadId, messageId, QUEUED));
    // A máquina pode ter conectado entre a checagem e a gravação: o `online` já drenou a fila vazia.
    if (hub.isOnline(machine)) drain(machine);
  };

  const onAck = (machine: string, ev: AgentEvent): void => {
    if (ev.type !== "command.ack" && ev.type !== "command.error") return;
    const f = inflight.get(ev.commandId);
    if (f === undefined || f.machine !== machine) return;
    inflight.delete(ev.commandId);
    const { threadId } = f;
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
