import {
  ApplicationCommandOptionType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import {
  newEnvelope, PermissionModeSchema, SLASH_ALLOWLIST, SlashCommandNameSchema, type PermissionMode, type RelayCommand,
} from "@global-agents/protocol";
import { z } from "zod";
import type { CommandBridge, CommandCallbacks, SubmitResult } from "../commands.js";
import type { Db, Machine } from "../db.js";
import { isSilenced, type Router } from "../router.js";
import type { DiscordPort, EmbedSpec } from "./bot.js";
import { chunkText } from "./chunk.js";
import { parseState, STATE_EMOJI, truncate, type ThreadRegistry } from "./threads.js";

export const NOT_ALLOWED_TEXT = "sem permissão";
export const NOT_MACHINE_CHANNEL_TEXT = "use este comando no canal de uma máquina";
export const NOT_SESSION_THREAD_TEXT = "use este comando dentro da thread de uma sessão";
export const NO_PROJECTS_TEXT = "esta máquina não informou projetos; rode global-agents install --project <pasta>";
export const OFFLINE_TEXT = "máquina offline; o pedido fica na fila por 1 h";
export const CREATING_TEXT = "criando sessão…";
/** Validade dos botões de confirmação do `/parar`. */
export const CONFIRM_TIMEOUT_MS = 60_000;

const MENTION_USAGE_TEXT = "escreva o pedido depois da menção, por exemplo: @global-agents roda os testes";
const CONFIRM_EXPIRED_TEXT = "este pedido expirou; rode /parar de novo";
const QUEUE_FAILED_TEXT = "❌ não foi possível enfileirar o pedido; tente de novo";
const NO_SESSION_ID_TEXT = "❌ a máquina não devolveu o id da sessão";
const CONTENT_MAX = 2000;
const EMBED_DESCRIPTION_MAX = 4096;
/** Limites do Discord: 25 sugestões de autocomplete e 25 sessões no `/sessoes`; valor de sugestão ≤ 100. */
const LIST_MAX = 25;
const CHOICE_MAX = 100;
const PROMPT_MAX = 4000;
const NAME_WORDS = 6;
const NAME_MAX = 60;
/** Limite de `args` do `/claude` (o mesmo do protocolo). */
const SLASH_ARGS_MAX = 500;
/** Fatia da tela por mensagem: cabeçalho `🛠️ /<comando>` + 2 cercas + sufixo de parte cabem em 2000. */
const SCREEN_CHUNK = 1900;
const FENCE = "```";
const CLAUDE_HINT: Record<(typeof SLASH_ALLOWLIST)[number], string> = {
  compact: "resume a conversa (args: instruções de foco)",
  usage: "uso do plano",
  cost: "custo da sessão",
  hooks: "hooks configurados",
  status: "versão, modelo e conta",
  context: "uso do contexto",
  model: "modelo atual (args: alias para trocar)",
};
const MODE_HINT: Record<PermissionMode, string> = {
  default: "pede permissão para tudo",
  acceptEdits: "edita arquivos sem perguntar",
  plan: "só planeja, não altera nada",
  bypassPermissions: "não pede nenhuma permissão",
};

/**
 * Definição dos comandos do guild. O `/filtro` usa subcomandos (`conta email:<e-mail>`, `desligar`, `ver`): o
 * Discord não aceita um comando com opções soltas e subcomandos ao mesmo tempo, então `/filtro off` virou
 * `/filtro desligar` e `/filtro` sem argumento virou `/filtro ver`.
 */
export const SLASH_COMMANDS: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    name: "novo",
    description: "Cria uma sessão do Claude Code nesta máquina",
    options: [
      { type: ApplicationCommandOptionType.String, name: "prompt", description: "O que a sessão deve fazer", required: true, max_length: PROMPT_MAX },
      { type: ApplicationCommandOptionType.String, name: "projeto", description: "Pasta do projeto (padrão: a primeira da máquina)", autocomplete: true },
      {
        type: ApplicationCommandOptionType.String, name: "modo", description: "Modo de permissão (padrão: default)",
        choices: PermissionModeSchema.options.map((m) => ({ name: `${m} · ${MODE_HINT[m]}`, value: m })),
      },
    ],
  },
  { name: "sessoes", description: "Lista as sessões desta máquina" },
  { name: "parar", description: "Encerra a sessão desta thread (só sessões em background)" },
  {
    name: "filtro",
    description: "Silencia sessões de outras contas neste canal",
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand, name: "conta", description: "Só mostra sessões desta conta",
        options: [{ type: ApplicationCommandOptionType.String, name: "email", description: "E-mail da conta Anthropic", required: true, max_length: 254 }],
      },
      { type: ApplicationCommandOptionType.Subcommand, name: "desligar", description: "Mostra sessões de qualquer conta" },
      { type: ApplicationCommandOptionType.Subcommand, name: "ver", description: "Mostra o estado do filtro" },
    ],
  },
  {
    name: "claude",
    description: "Roda um comando do Claude Code na sessão desta thread (só sessões em background)",
    options: [
      {
        type: ApplicationCommandOptionType.String, name: "comando", description: "Comando do Claude Code", required: true,
        choices: SLASH_ALLOWLIST.map((c) => ({ name: `/${c} · ${CLAUDE_HINT[c]}`, value: c })),
      },
      { type: ApplicationCommandOptionType.String, name: "args", description: "Argumentos do comando (opcional)", max_length: SLASH_ARGS_MAX },
    ],
  },
];

export interface SlashButton {
  customId: string;
  label: string;
  style: "danger" | "secondary";
  disabled?: boolean;
}

/** Conteúdo de uma resposta, independente da biblioteca. `buttons: []` tira os botões da mensagem. */
export interface SlashView {
  content?: string;
  embeds?: EmbedSpec[];
  buttons?: SlashButton[];
}

export interface SlashUser {
  id: string;
  username: string;
}

interface InteractionBase {
  id: string;
  channelId: string;
  user: SlashUser;
}

export interface CommandInteraction extends InteractionBase {
  kind: "command";
  commandName: string;
  options: {
    getString(name: string): string | null;
    getSubcommand(): string | null;
  };
  reply(view: SlashView, ephemeral: boolean): Promise<unknown>;
  editReply(view: SlashView): Promise<unknown>;
}

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export interface AutocompleteInteraction extends InteractionBase {
  kind: "autocomplete";
  commandName: string;
  focused: { name: string; value: string };
  respond(choices: AutocompleteChoice[]): Promise<unknown>;
}

export interface ButtonInteraction extends InteractionBase {
  kind: "button";
  customId: string;
  /** Edita a mensagem que tem o botão (resposta ao clique). */
  update(view: SlashView): Promise<unknown>;
  /** Edita de novo a mesma mensagem, depois do `update`. */
  editReply(view: SlashView): Promise<unknown>;
  reply(view: SlashView, ephemeral: boolean): Promise<unknown>;
}

export type SlashInteraction = CommandInteraction | AutocompleteInteraction | ButtonInteraction;

/** Mensagem que menciona o bot fora de thread, já sem a menção. */
export interface MentionMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  isBot: boolean;
  text: string;
}

export interface SlashDeps {
  db: Db;
  threads: Pick<ThreadRegistry, "ensureThread">;
  bridge: Pick<CommandBridge, "submit">;
  router: Pick<Router, "projectsOf" | "refreshTopic">;
  port: Pick<DiscordPort, "reply" | "post">;
  /** Só estes usuários usam os comandos (nunca o canal decide). */
  allowedUserIds: readonly string[];
  /** `machine` do envelope dos comandos que saem do relay. */
  relayMachine?: string;
  log?: (msg: string) => void;
}

export interface SlashHandler {
  /** Slash command, autocomplete ou botão; nunca rejeita. */
  onInteraction(i: SlashInteraction): Promise<void>;
  /** Menção ao bot no canal de uma máquina: vira `/novo prompt:<texto>` com os padrões; nunca rejeita. */
  onMention(m: MentionMessage): Promise<void>;
  /** Resolve quando as chamadas ao Discord já disparadas terminaram. */
  idle(): Promise<void>;
  /** Desliga os timers de confirmação pendentes. */
  dispose(): void;
}

/** Nome da sessão a partir do prompt: 6 primeiras palavras, minúsculas, acentos mantidos, o resto vira `-`, ≤ 60. */
export function sessionName(prompt: string): string {
  const words = prompt.normalize("NFC").trim().split(/\s+/).slice(0, NAME_WORDS).join(" ");
  const slug = words.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_]+/gu, "-").replace(/^-+|-+$/g, "");
  const cut = truncate(slug, NAME_MAX).replace(/-+$/, "");
  return cut === "" ? "sessao" : cut;
}

/** Tira a menção ao bot (`<@id>` ou `<@!id>`) do texto da mensagem. */
export function stripMention(content: string, botId: string): string {
  const id = botId.replace(/[^0-9A-Za-z]/g, "");
  return content.replace(new RegExp(`\\s*<@!?${id}>\\s*`, "g"), " ").trim();
}

const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** `há 8 min`, `há 2 h`, `há 3 d` (ou `agora`). */
function ago(ts: number, now: number): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`;
}

const escapeMd = (s: string): string => s.replace(/([\\*_~`|>])/g, "\\$1");
const text = (s: string): SlashView => ({ content: truncate(s, CONTENT_MAX) });
const failure = (reason: string): string => truncate(`❌ ${reason}`, CONTENT_MAX);

/**
 * Mensagens da thread com o resultado de um `/claude`: `🛠️ /<comando>` e a tela em blocos de código (≤ 2000 cada).
 * Crases triplas da tela ganham um espaço de largura zero para não fechar o bloco.
 */
export function slashResultMessages(command: string, screen: string): string[] {
  const safe = screen.replace(/`{3,}/g, (m) => m.split("").join("\u200b"));
  return chunkText(safe, SCREEN_CHUNK).map((chunk, i) => {
    const part = /\n-# \(parte \d+\/\d+\)$/.exec(chunk);
    const body = part === null ? chunk : chunk.slice(0, part.index);
    return `${i === 0 ? `🛠️ /${command}\n` : ""}${FENCE}\n${body}\n${FENCE}${part?.[0] ?? ""}`;
  });
}

const ScreenSchema = z.object({ screen: z.string() });

const CreatedSchema = z.object({ sessionId: z.string().min(1), bgId: z.string().min(1).optional() });

/** Onde mostrar o andamento de um pedido: edição da resposta efêmera, ou reply à mensagem da menção. */
type Show = (text: string) => void;

interface StopConfirm {
  interaction: CommandInteraction;
  sessionId: string;
  machine: string;
  timer: NodeJS.Timeout;
}

const stopButtons = (id: string, disabled: boolean): SlashButton[] => [
  { customId: `parar:confirmar:${id}`, label: "Parar sessão", style: "danger", ...(disabled ? { disabled } : {}) },
  { customId: `parar:cancelar:${id}`, label: "Cancelar", style: "secondary", ...(disabled ? { disabled } : {}) },
];

/**
 * Slash commands e menção ao bot.
 *
 * - Toda interação passa pela allowlist (`sem permissão`, efêmero; autocomplete sem sugestões; menção ignorada).
 * - `/novo` e a menção mandam `session.create` pela ponte de comandos (mesma fila offline de 1 h); o `commandId` é o
 *   id da interação/mensagem. No ack, a thread nasce com o `bgId` e a resposta vira o link dela. O token de uma
 *   interação vale 15 min: se o pedido ficar mais que isso na fila, a thread nasce mesmo assim e a edição falha (log).
 * - `projeto` só aceita as pastas do último `agent.hello` da máquina (o agente não confere a pasta).
 * - `/parar` pede confirmação com botões que valem 60 s; confirmado, manda `session.stop`.
 * - `/filtro` grava `machines.filter_account` e reaplica o tópico do canal; o router silencia a máquina.
 * - As chamadas ao Discord de uma mesma interação são feitas em série; falhas vão para `log`.
 */
export function createSlashHandler(deps: SlashDeps): SlashHandler {
  const { db, port } = deps;
  const allowed = new Set(deps.allowedUserIds);
  const relayMachine = deps.relayMachine ?? "relay/vps";
  const log = deps.log ?? ((m: string) => { console.error(m); });
  const chains = new Map<string, Promise<void>>();
  const confirms = new Map<string, StopConfirm>();

  /** Enfileira uma chamada ao Discord na cadeia de `key`; erro vira log. */
  const discord = (key: string, label: string, fn: () => Promise<unknown>): void => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn).then(
      () => undefined,
      (e: unknown) => { log(`${label} (${key}): ${(e as Error).message}`); },
    );
    chains.set(key, next);
    void next.then(() => { if (chains.get(key) === next) chains.delete(key); });
  };

  const reply = (i: CommandInteraction | ButtonInteraction, view: SlashView, ephemeral = true): void => {
    discord(i.id, "falha ao responder", () => i.reply(view, ephemeral));
  };

  const afterSubmit = (r: SubmitResult, show: Show): void => {
    if (r === "queued") show(OFFLINE_TEXT);
    else if (r === "failed") show(QUEUE_FAILED_TEXT);
  };

  /** Valida e monta o `session.create`; devolve o texto de erro quando não dá. */
  const planCreate = (
    machine: Machine, prompt: string, projeto: string | null, modo: string | null, commandId: string,
  ): { cmd: Extract<RelayCommand, { type: "session.create" }> } | { error: string } => {
    const trimmed = prompt.trim();
    if (trimmed === "") return { error: "o prompt não pode ser vazio" };
    const projects = deps.router.projectsOf(machine.name);
    const first = projects[0];
    if (first === undefined) return { error: NO_PROJECTS_TEXT };
    const cwd = projeto ?? first;
    if (!projects.includes(cwd)) return { error: `projeto desconhecido nesta máquina: ${cwd}; escolha um dos sugeridos` };
    const mode = PermissionModeSchema.safeParse(modo ?? "default");
    if (!mode.success) return { error: `modo inválido: ${modo ?? ""}` };
    return {
      cmd: {
        ...newEnvelope(relayMachine), type: "session.create", commandId,
        cwd, name: sessionName(trimmed), prompt: trimmed, permissionMode: mode.data,
      },
    };
  };

  /** Envia o `session.create`; no ack cria a thread (com `bgId`) e mostra o link. */
  const submitCreate = (machine: string, cmd: Extract<RelayCommand, { type: "session.create" }>, key: string, show: Show): void => {
    const cb: CommandCallbacks = {
      onAck(result) {
        const created = CreatedSchema.safeParse(result ?? {});
        if (!created.success) {
          show(NO_SESSION_ID_TEXT);
          return;
        }
        const { sessionId, bgId } = created.data;
        discord(key, "falha ao criar a thread", async () => {
          let threadId: string;
          try {
            threadId = await deps.threads.ensureThread(machine, {
              sessionId, name: cmd.name, cwd: cmd.cwd, state: "working", ...(bgId !== undefined ? { bgId } : {}),
            });
          } catch (e) {
            log(`${machine}: falha ao criar a thread da sessão ${sessionId}: ${(e as Error).message}`);
            show(failure(`sessão criada, mas a thread não pôde ser criada: ${(e as Error).message}`));
            return;
          }
          // A thread pode ter nascido antes pelo `session.status` (sem `bgId`): grava o `bgId` para o `/sessoes`.
          const row = db.sessions.get(sessionId);
          if (bgId !== undefined && row !== undefined && row.bgId === null) {
            db.sessions.upsert({ sessionId, machine: row.machine, bgId, state: row.state, updatedAt: row.updatedAt });
          }
          show(`✅ Sessão criada: <#${threadId}>`);
        });
      },
      onError(reason) { show(failure(reason)); },
    };
    afterSubmit(deps.bridge.submit(machine, cmd, cb), show);
  };

  const machineOr = (i: CommandInteraction): Machine | undefined => {
    const m = db.machines.getByChannel(i.channelId);
    if (m === undefined) reply(i, text(NOT_MACHINE_CHANNEL_TEXT));
    return m;
  };

  const onNovo = (i: CommandInteraction): void => {
    const machine = machineOr(i);
    if (machine === undefined) return;
    const plan = planCreate(machine, i.options.getString("prompt") ?? "", i.options.getString("projeto"), i.options.getString("modo"), i.id);
    if ("error" in plan) {
      reply(i, text(plan.error));
      return;
    }
    reply(i, text(CREATING_TEXT));
    submitCreate(machine.name, plan.cmd, i.id, (t) => {
      discord(i.id, "falha ao editar a resposta", () => i.editReply(text(t)));
    });
  };

  const onSessoes = (i: CommandInteraction): void => {
    const machine = machineOr(i);
    if (machine === undefined) return;
    const rows = db.sessions.listByMachine(machine.name);
    if (rows.length === 0) {
      reply(i, text(`nenhuma sessão registrada em ${machine.name}`));
      return;
    }
    const now = Date.now();
    const shown = rows.slice(0, LIST_MAX);
    const lines = shown.map((s) => {
      const emoji = STATE_EMOJI[parseState(s.state) ?? "done"];
      const name = escapeMd(s.name ?? `sessão ${s.sessionId.slice(0, 8)}`);
      const link = s.threadId === null ? "" : ` · <#${s.threadId}>`;
      const attach = s.bgId === null ? "" : ` · \`claude attach ${s.bgId}\``;
      return `${emoji} **${name}**${link}\n\`${s.cwd ?? "—"}\` · ${ago(s.updatedAt, now)}${attach}`;
    });
    const count = rows.length > shown.length
      ? `${shown.length} de ${rows.length} sessões`
      : `${rows.length} ${rows.length === 1 ? "sessão" : "sessões"}`;
    const filter = machine.filterAccount === null ? "filtro de conta desligado" : `filtro: ${machine.filterAccount}`;
    reply(i, {
      embeds: [{
        title: truncate(`${count} em ${machine.name}`, 256),
        description: truncate(lines.join("\n"), EMBED_DESCRIPTION_MAX),
        footer: `atualizado às ${hhmm(new Date(now))} · ${filter}`,
      }],
    });
  };

  const onParar = (i: CommandInteraction): void => {
    const session = db.sessions.getByThread(i.channelId);
    if (session === undefined) {
      reply(i, text(NOT_SESSION_THREAD_TEXT));
      return;
    }
    const name = escapeMd(session.name ?? session.sessionId.slice(0, 8));
    const timer = setTimeout(() => {
      if (!confirms.delete(i.id)) return;
      discord(i.id, "falha ao expirar a confirmação", () =>
        i.editReply({ content: "tempo esgotado; a sessão continua", buttons: stopButtons(i.id, true) }));
    }, CONFIRM_TIMEOUT_MS);
    timer.unref();
    confirms.set(i.id, { interaction: i, sessionId: session.sessionId, machine: session.machine, timer });
    reply(i, {
      content: truncate(`Parar a sessão **${name}**? O processo do Claude Code é encerrado e a thread fica como histórico.`, CONTENT_MAX),
      buttons: stopButtons(i.id, false),
    });
  };

  const onStopButton = (b: ButtonInteraction, action: string, id: string): void => {
    const pending = confirms.get(id);
    if (pending === undefined) {
      reply(b, text(CONFIRM_EXPIRED_TEXT));
      return;
    }
    if (pending.interaction.user.id !== b.user.id) {
      reply(b, text(NOT_ALLOWED_TEXT));
      return;
    }
    confirms.delete(id);
    clearTimeout(pending.timer);
    if (action !== "confirmar") {
      discord(b.id, "falha ao cancelar", () => b.update({ content: "cancelado; a sessão continua", buttons: [] }));
      return;
    }
    discord(b.id, "falha ao confirmar", () => b.update({ content: "⏹ parando a sessão…", buttons: [] }));
    const show: Show = (t) => { discord(b.id, "falha ao editar a resposta", () => b.editReply(text(t))); };
    const cmd: RelayCommand = { ...newEnvelope(relayMachine), type: "session.stop", commandId: id, sessionId: pending.sessionId };
    afterSubmit(deps.bridge.submit(pending.machine, cmd, {
      onAck() { show(`⏹ Sessão parada por ${b.user.username} às ${hhmm(new Date())}.`); },
      onError(reason) { show(failure(reason)); },
    }), show);
  };

  const onClaude = (i: CommandInteraction): void => {
    const session = db.sessions.getByThread(i.channelId);
    if (session === undefined) {
      reply(i, text(NOT_SESSION_THREAD_TEXT));
      return;
    }
    const raw = i.options.getString("comando") ?? "";
    const parsed = SlashCommandNameSchema.safeParse(raw);
    if (!parsed.success) {
      reply(i, text(failure(`comando não permitido: /${raw}; use um de ${SLASH_ALLOWLIST.map((c) => `/${c}`).join(", ")}`)));
      return;
    }
    const command = parsed.data;
    const args = (i.options.getString("args") ?? "").trim();
    if (/[\r\n]/.test(args) || args.length > SLASH_ARGS_MAX) {
      reply(i, text(failure(`args inválidos: uma linha só, até ${SLASH_ARGS_MAX} caracteres`)));
      return;
    }
    reply(i, text(`executando /${command}…`));
    const show: Show = (t) => { discord(i.id, "falha ao editar a resposta", () => i.editReply(text(t))); };
    const threadId = i.channelId;
    const cmd: RelayCommand = {
      ...newEnvelope(relayMachine), type: "session.slash", commandId: i.id, sessionId: session.sessionId, command,
      ...(args !== "" ? { args } : {}),
    };
    afterSubmit(deps.bridge.submit(session.machine, cmd, {
      onAck(result) {
        const r = ScreenSchema.safeParse(result ?? {});
        if (!r.success) {
          show(failure("a máquina não devolveu a tela do comando"));
          return;
        }
        for (const m of slashResultMessages(command, r.data.screen)) {
          discord(i.id, "falha ao postar o resultado", () => port.post(threadId, m));
        }
        show(`✅ /${command} concluído; resultado na thread`);
      },
      onError(reason) { show(failure(reason)); },
    }), show);
  };

  const onFiltro = (i: CommandInteraction): void => {
    const machine = machineOr(i);
    if (machine === undefined) return;
    const current = machine.claudeAccount ?? "desconhecida";
    switch (i.options.getSubcommand()) {
      case "conta": {
        const email = (i.options.getString("email") ?? "").trim();
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
          reply(i, text("informe um e-mail válido, por exemplo: /filtro conta email:voce@exemplo.com"));
          return;
        }
        db.machines.setFilterAccount(machine.name, email);
        deps.router.refreshTopic(machine.name);
        reply(i, text(
          `🔇 Filtro ligado neste canal: só aparecem sessões da conta **${escapeMd(email)}**. Sessões de outras contas ficam em silêncio até \`/filtro desligar\`.`,
        ), false);
        return;
      }
      case "desligar":
        db.machines.setFilterAccount(machine.name, null);
        deps.router.refreshTopic(machine.name);
        reply(i, text("🔊 Filtro desligado. Todas as sessões da máquina voltam a aparecer, de qualquer conta."), false);
        return;
      case "ver":
        if (machine.filterAccount === null) {
          reply(i, text(`🔊 filtro desligado: aparecem sessões de qualquer conta (conta atual da máquina: ${current})`));
        } else {
          const state = isSilenced(db, machine.name) ? "em silêncio" : "aparecendo";
          reply(i, text(
            `🔇 filtro ligado: só aparecem sessões da conta **${escapeMd(machine.filterAccount)}** (conta atual da máquina: ${current}, ${state})`,
          ));
        }
        return;
      default:
        reply(i, text("use /filtro conta, /filtro desligar ou /filtro ver"));
    }
  };

  const onAutocomplete = (a: AutocompleteInteraction): void => {
    const respond = (choices: AutocompleteChoice[]): void => {
      discord(a.id, "falha ao sugerir", () => a.respond(choices));
    };
    const machine = db.machines.getByChannel(a.channelId);
    if (!allowed.has(a.user.id) || machine === undefined || a.commandName !== "novo" || a.focused.name !== "projeto") {
      respond([]);
      return;
    }
    const typed = a.focused.value.toLowerCase();
    respond(deps.router.projectsOf(machine.name)
      .filter((p) => p.length <= CHOICE_MAX && p.toLowerCase().includes(typed))
      .slice(0, LIST_MAX)
      .map((p) => ({ name: p, value: p })));
  };

  const onInteraction = (i: SlashInteraction): void => {
    if (i.kind === "autocomplete") {
      onAutocomplete(i);
      return;
    }
    if (!allowed.has(i.user.id)) {
      reply(i, text(NOT_ALLOWED_TEXT));
      return;
    }
    if (i.kind === "button") {
      const m = /^parar:(confirmar|cancelar):(.+)$/.exec(i.customId);
      if (m?.[1] === undefined || m[2] === undefined) {
        reply(i, text(CONFIRM_EXPIRED_TEXT));
        return;
      }
      onStopButton(i, m[1], m[2]);
      return;
    }
    switch (i.commandName) {
      case "novo": onNovo(i); return;
      case "sessoes": onSessoes(i); return;
      case "parar": onParar(i); return;
      case "filtro": onFiltro(i); return;
      case "claude": onClaude(i); return;
      default: reply(i, text(`comando desconhecido: /${i.commandName}`));
    }
  };

  const onMention = (m: MentionMessage): void => {
    if (m.isBot || !allowed.has(m.authorId)) return;
    const machine = db.machines.getByChannel(m.channelId);
    if (machine === undefined) return;
    const show: Show = (t) => {
      discord(m.messageId, "falha ao responder", () => port.reply(m.channelId, m.messageId, truncate(t, CONTENT_MAX)));
    };
    if (m.text.trim() === "") {
      show(MENTION_USAGE_TEXT);
      return;
    }
    const plan = planCreate(machine, m.text, null, null, m.messageId);
    if ("error" in plan) {
      show(plan.error);
      return;
    }
    submitCreate(machine.name, plan.cmd, m.messageId, show);
  };

  /** Nenhum caminho pode derrubar quem chamou (listener do Discord). */
  const guard = (label: string, fn: () => void): Promise<void> => {
    try {
      fn();
    } catch (e) {
      log(`${label}: ${(e as Error).message}`);
    }
    return Promise.resolve();
  };

  return {
    onInteraction: (i) => guard(`interação ${i.id}`, () => { onInteraction(i); }),
    onMention: (m) => guard(`menção ${m.messageId}`, () => { onMention(m); }),
    async idle() {
      while (chains.size > 0) await Promise.all(chains.values());
    },
    dispose() {
      for (const c of confirms.values()) clearTimeout(c.timer);
      confirms.clear();
    },
  };
}
