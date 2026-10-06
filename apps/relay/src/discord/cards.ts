import { newEnvelope, type AgentEvent, type PermissionBehavior, type RelayCommand } from "@global-agents/protocol";
import type { Db } from "../db.js";
import type { AgentHub } from "../ws/server.js";
import type { CardSpec, DiscordPort, EmbedField } from "./bot.js";
import { NOT_ALLOWED_TEXT, type ButtonInteraction, type SlashView } from "./slash.js";
import { hhmm, truncate } from "./threads.js";

type PermissionRequest = Extract<AgentEvent, { type: "permission.request" }>;
type PermissionResolved = Extract<AgentEvent, { type: "permission.resolved" }>;

export const ALREADY_DECIDED_TEXT = "já decidido";
export const OFFLINE_DECIDE_TEXT = "máquina offline; decida no terminal";
/** Tamanho máximo da prévia dentro do bloco de código, com o `…` (o campo do embed aceita 1024). */
export const PREVIEW_MAX = 1000;

const YELLOW = 0xfee75c;
const GREEN = 0x57f287;
const RED = 0xed4245;
const GREY = 0x99aab5;
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 3500;
const FENCE = "```";
/** Quanto um pedido sem desfecho fica na memória depois de expirar (a máquina pode ter sumido sem avisar). */
const FORGET_AFTER_MS = 10 * 60_000;

/** O que o card mostra do pedido; sem `tool`, o card é o mínimo (pedido de antes de um reinício do relay). */
export interface CardRequest {
  requestId: string;
  tool?: string;
  description?: string;
  inputPreview?: string;
  expiresAt?: string;
}

export type CardOutcome = { by: PermissionResolved["by"]; behavior?: PermissionBehavior; who?: string; at: Date };
/** `pending`: botões ativos; `deciding`: botões desligados; `{ warning }`: pendente sem botões, com um aviso. */
export type CardState = "pending" | "deciding" | { warning: string } | CardOutcome;

const neutralizeFences = (s: string): string => s.replace(/`{3,}/g, (m) => m.split("").join("​"));

/** Prévia em bloco de código: ``` neutralizado, cortada em `PREVIEW_MAX` com `…` sem partir par substituto. */
function previewBlock(preview: string): string {
  const safe = neutralizeFences(preview);
  const cut = safe.length <= PREVIEW_MAX ? safe : `${truncate(safe, PREVIEW_MAX - 1)}…`;
  return `${FENCE}\n${cut}\n${FENCE}`;
}

function outcomeLine(o: CardOutcome): { line: string; color: number } {
  switch (o.by) {
    case "terminal": return { line: "🖥️ decidido no terminal", color: GREY };
    case "timeout": return { line: "⏳ expirou (negado automaticamente)", color: RED };
    case "remote": {
      const who = o.who === undefined ? "" : ` por <@${o.who}>`;
      return o.behavior === "deny"
        ? { line: `⛔ negado${who} às ${hhmm(o.at)} via Discord`, color: RED }
        : { line: `✅ permitido${who} às ${hhmm(o.at)} via Discord`, color: GREEN };
    }
  }
}

/**
 * Card do pedido de permissão. Pendente: descrição, `expira <t:…:R>`, prévia num bloco de código, amarelo, botões
 * Permitir/Negar. Desfecho: encolhe para a linha de quem decidiu + descrição, sem prévia nem botões.
 */
export function buildPermissionCard(req: CardRequest, state: CardState): CardSpec {
  const title = truncate(req.tool === undefined ? "🔐 Permissão" : `🔐 Permissão: ${req.tool}`, TITLE_MAX);
  const description = req.tool === undefined ? undefined : truncate(req.description?.trim() || "sem descrição", DESCRIPTION_MAX);
  if (typeof state === "object" && "by" in state) {
    const { line, color } = outcomeLine(state);
    return { embed: { title, description: description === undefined ? line : `${line}\n${description}`, color }, buttons: [] };
  }
  const lines = description === undefined ? [] : [description];
  const epoch = req.expiresAt === undefined ? NaN : Math.floor(Date.parse(req.expiresAt) / 1000);
  if (Number.isFinite(epoch)) lines.push(`expira <t:${epoch}:R>`);
  if (state === "deciding") lines.push("⏳ decidindo…");
  if (typeof state === "object") lines.push(`⚠️ ${truncate(state.warning, 300)}`);
  const fields: EmbedField[] = req.inputPreview ? [{ name: "Prévia", value: previewBlock(req.inputPreview) }] : [];
  const disabled = state === "deciding" ? { disabled: true } : {};
  return {
    embed: { title, description: lines.join("\n"), color: YELLOW, ...(fields.length > 0 ? { fields } : {}) },
    buttons: typeof state === "object" ? [] : [
      { customId: `perm:allow:${req.requestId}`, label: "Permitir", style: "success", ...disabled },
      { customId: `perm:deny:${req.requestId}`, label: "Negar", style: "danger", ...disabled },
    ],
  };
}

export interface PermissionFlowDeps {
  db: Db;
  hub: Pick<AgentHub, "send" | "isOnline">;
  port: Pick<DiscordPort, "postCard" | "editCard">;
  /** Só estes usuários decidem; todos são mencionados no card. */
  allowedUserIds: readonly string[];
  /** `machine` do envelope dos comandos que saem do relay. */
  relayMachine?: string;
  log?: (msg: string) => void;
}

export interface PermissionFlow {
  /** Posta o card na thread `threadId` e grava o pedido; pedido repetido é ignorado. Rejeita se o post falhar. */
  onRequest(machine: string, ev: PermissionRequest, threadId: string): Promise<void>;
  /** Clique em `perm:allow:<id>`/`perm:deny:<id>`. */
  onButton(i: ButtonInteraction): Promise<void>;
  /** Desfecho do agente: edita o card uma única vez; pedido desconhecido é ignorado. */
  onResolved(ev: PermissionResolved): Promise<void>;
  /** `command.error` de um `permission.decide` (commandId `perm-…`); o resto é ignorado. */
  onCommandResult(machine: string, ev: AgentEvent): void;
  /** Resolve quando as chamadas ao Discord já disparadas terminaram. */
  idle(): Promise<void>;
  dispose(): void;
}

interface Known {
  machine: string;
  threadId: string;
  req: CardRequest;
  expiresAt: number;
}

/**
 * Cards de permissão.
 *
 * - O card menciona a allowlist (push no celular); só ela decide (`sem permissão`, efêmero, para os outros).
 * - Clique: pedido não pendente (ou já com um clique em andamento) → `já decidido`; máquina offline → efêmero, card
 *   intacto; senão sai `permission.decide` com `commandId = perm-<requestId>-<behavior>` direto pelo hub (sem fila
 *   offline: o hook não espera 1 h) e o card vira `⏳ decidindo…` (botões desligados).
 * - `command.error` desse comando: o card volta a pendente com `⚠️ <razão>` e sem botões (o pedido sumiu no agente);
 *   a linha continua `pending` no banco, para um desfecho que ainda chegue editar o card.
 * - `permission.resolved`: `db.permissions.resolve` (só uma vez) e o card encolhe para o desfecho. Quem clicou fica só
 *   na memória até o desfecho; depois de um reinício do relay o card mínimo sai sem a ferramenta e sem o autor.
 * - As chamadas ao Discord de um mesmo pedido são feitas em série; falhas vão para `log`.
 */
export function createPermissionFlow(deps: PermissionFlowDeps): PermissionFlow {
  const { db, hub, port } = deps;
  const allowed = new Set(deps.allowedUserIds);
  const relayMachine = deps.relayMachine ?? "relay/vps";
  const log = deps.log ?? ((m: string) => { console.error(m); });
  const known = new Map<string, Known>();
  /** Clique aceito aguardando o desfecho: quem clicou e o `commandId`. */
  const deciding = new Map<string, { userId: string; commandId: string; machine: string }>();
  const chains = new Map<string, Promise<void>>();

  const discord = (key: string, label: string, fn: () => Promise<unknown>): void => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn).then(
      () => undefined,
      (e: unknown) => { log(`${label} (pedido ${key}): ${(e as Error).message}`); },
    );
    chains.set(key, next);
    void next.then(() => { if (chains.get(key) === next) chains.delete(key); });
  };

  const forgetExpired = (now: number): void => {
    for (const [id, k] of known) {
      if (k.expiresAt + FORGET_AFTER_MS < now) {
        known.delete(id);
        deciding.delete(id);
      }
    }
  };

  const view = (card: CardSpec): SlashView => ({ embeds: [card.embed], buttons: card.buttons });
  const reply = (i: ButtonInteraction, text: string): void => {
    discord(i.id, "falha ao responder", () => i.reply({ content: text }, true));
  };

  const onRequest = async (machine: string, ev: PermissionRequest, threadId: string): Promise<void> => {
    forgetExpired(Date.now());
    if (db.permissions.get(ev.requestId) !== undefined) return;
    const card = buildPermissionCard(ev, "pending");
    const mentions = [...allowed];
    const { messageId } = await port.postCard(threadId, {
      ...card,
      ...(mentions.length > 0 ? { content: mentions.map((id) => `<@${id}>`).join(" ") } : {}),
      mentions,
    });
    db.permissions.create({ requestId: ev.requestId, sessionId: ev.sessionId, messageId });
    const expiresAt = Date.parse(ev.expiresAt);
    known.set(ev.requestId, { machine, threadId, req: ev, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() });
  };

  const onButton = (i: ButtonInteraction): void => {
    const m = /^perm:(allow|deny):(.+)$/.exec(i.customId);
    if (!allowed.has(i.user.id)) {
      reply(i, NOT_ALLOWED_TEXT);
      return;
    }
    const behavior = m?.[1] === "deny" ? "deny" : "allow";
    const requestId = m?.[2];
    const row = requestId === undefined ? undefined : db.permissions.get(requestId);
    if (requestId === undefined || row?.status !== "pending" || deciding.has(requestId)) {
      reply(i, ALREADY_DECIDED_TEXT);
      return;
    }
    const k = known.get(requestId);
    const machine = k?.machine ?? db.sessions.get(row.sessionId)?.machine;
    if (machine === undefined || !hub.isOnline(machine)) {
      reply(i, OFFLINE_DECIDE_TEXT);
      return;
    }
    const commandId = `perm-${requestId}-${behavior}`;
    const cmd: RelayCommand = { ...newEnvelope(relayMachine), type: "permission.decide", commandId, requestId, behavior };
    // Envia antes de mexer no card: se a máquina caiu no meio, o card fica intacto e o aviso é efêmero.
    if (!hub.send(machine, cmd)) {
      reply(i, OFFLINE_DECIDE_TEXT);
      return;
    }
    deciding.set(requestId, { userId: i.user.id, commandId, machine });
    // Na mesma cadeia do pedido: um `command.error` ou desfecho rápido nunca é sobrescrito pelo `decidindo…`.
    const card = buildPermissionCard(k?.req ?? { requestId }, "deciding");
    discord(requestId, "falha ao marcar decidindo", () => i.update(view(card)));
  };

  const onResolved = (ev: PermissionResolved): void => {
    const row = db.permissions.get(ev.requestId);
    if (row === undefined) return;
    const d = deciding.get(ev.requestId);
    const status = ev.by === "terminal" ? "terminal" : ev.by === "timeout" ? "expired" : ev.behavior === "deny" ? "denied" : "allowed";
    const now = new Date();
    if (!db.permissions.resolve(ev.requestId, status, ev.by === "remote" ? (d?.userId ?? "discord") : ev.by, now.getTime())) return;
    const k = known.get(ev.requestId);
    known.delete(ev.requestId);
    deciding.delete(ev.requestId);
    const threadId = k?.threadId ?? db.sessions.get(row.sessionId)?.threadId ?? undefined;
    const messageId = row.messageId;
    if (threadId === undefined || messageId === null) {
      log(`pedido de permissão ${ev.requestId} resolvido, mas o card não foi encontrado`);
      return;
    }
    const outcome: CardOutcome = {
      by: ev.by, at: now,
      ...(ev.behavior !== undefined ? { behavior: ev.behavior } : {}),
      ...(d !== undefined && ev.by === "remote" ? { who: d.userId } : {}),
    };
    const card = buildPermissionCard(k?.req ?? { requestId: ev.requestId }, outcome);
    discord(ev.requestId, "falha ao editar o card", () => port.editCard(threadId, messageId, card));
  };

  const onCommandResult = (machine: string, ev: AgentEvent): void => {
    if (ev.type !== "command.error" || !ev.commandId.startsWith("perm-")) return;
    const requestId = /^perm-(.+)-(?:allow|deny)$/.exec(ev.commandId)?.[1];
    const d = requestId === undefined ? undefined : deciding.get(requestId);
    if (requestId === undefined || d?.commandId !== ev.commandId || d.machine !== machine) return;
    deciding.delete(requestId);
    const k = known.get(requestId);
    const row = db.permissions.get(requestId);
    const threadId = k?.threadId ?? (row === undefined ? undefined : db.sessions.get(row.sessionId)?.threadId ?? undefined);
    const messageId = row?.messageId ?? null;
    if (threadId === undefined || messageId === null) return;
    const card = buildPermissionCard(k?.req ?? { requestId }, { warning: ev.reason });
    discord(requestId, "falha ao editar o card", () => port.editCard(threadId, messageId, card));
  };

  const guard = (label: string, fn: () => void): Promise<void> => {
    try {
      fn();
    } catch (e) {
      log(`${label}: ${(e as Error).message}`);
    }
    return Promise.resolve();
  };

  return {
    onRequest,
    onButton: (i) => guard(`interação ${i.id}`, () => { onButton(i); }),
    onResolved: (ev) => guard(`permissão ${ev.requestId}`, () => { onResolved(ev); }),
    onCommandResult: (machine, ev) => { void guard(`${machine}: ${ev.type}`, () => { onCommandResult(machine, ev); }); },
    async idle() {
      while (chains.size > 0) await Promise.all(chains.values());
    },
    dispose() {
      known.clear();
      deciding.clear();
    },
  };
}
