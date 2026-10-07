import {
  newEnvelope, type AgentEvent, type PermissionBehavior, type RelayCommand, type SessionInfo, type SlashCommandName,
} from "@global-agents/protocol";
import { InboxFormatError, type InboxTarget } from "../claude/inject.js";
import { BUSY_TEXT, SLASH_WHILE_BUSY } from "../claude/slash-rules.js";
import type { SessionRegistry } from "../claude/registry.js";
import type { SpawnInput } from "../claude/spawn.js";
import type { ResolvedWorkspace } from "../projects/workspace.js";

/** Respostas guardadas por `commandId` (inclui comandos ainda em andamento). */
const CACHE_SIZE = 500;
/** Nome mostrado na sessão como remetente; o relay ainda não manda o usuário do Discord. */
const FROM_NAME = "discord";

const NOT_FOUND = "sessão não encontrada nesta máquina";
const NO_INBOX = "sessão sem inbox (reinicie a sessão)";
const NOT_BACKGROUND = "só sessões em background podem ser paradas pelo Discord; use claude /exit no terminal";
const NO_PERMISSIONS = "permissões ainda não suportadas";
const PERMISSION_GONE = "pedido de permissão não encontrado ou já resolvido";
const SLASH_INTERACTIVE = "essa sessão está aberta num terminal; rode o comando lá ou mande-a para o fundo com /bg";
const SLASH_RUNNING = "já há um comando do Claude rodando nessa sessão; espere ele terminar";
const INBOX_CHANGED_INTERACTIVE = "formato do inbox mudou e a sessão é interativa; mande o prompt pelo terminal";
const COMPAT_WARNING = "usando modo compatível: formato do inbox mudou";

export interface SlashInput {
  bgId: string;
  command: SlashCommandName;
  args?: string;
}

export interface ResumeInput {
  sessionId: string;
  text: string;
}

export interface CommandDeps {
  machine: string;
  inventory: { find(sessionId: string): SessionInfo | undefined };
  inject: (target: InboxTarget, text: string, from: { name: string }) => Promise<void>;
  /**
   * Resolve e confere a pasta do `session.create` (o real é `resolveWorkspace` com as raízes dev e os projetos da
   * config). É a fronteira de confiança: o relay só confere o formato.
   */
  workspace: (cwd: string, create: boolean) => Promise<ResolvedWorkspace>;
  /** Confere de novo a contenção logo antes de cada `--bg` (o real é `recheckInside`). */
  recheck: (ws: ResolvedWorkspace) => Promise<void>;
  spawn: (input: SpawnInput) => Promise<{ sessionId: string; bgId: string }>;
  stop: (bgId: string) => Promise<void>;
  readRegistry: (pid: number) => SessionRegistry | undefined;
  /** Roda o slash command via `claude attach` (o real é `runSlash` com o `claudeBin` da config). */
  slash: (input: SlashInput) => Promise<{ screen: string }>;
  /** Fallback quando o inbox muda de formato: `claude --resume` num pty (o real é `resumeViaPty` com o `claudeBin`). */
  resume: (input: ResumeInput) => Promise<void>;
  /** Vira `agent.warning` no relay. */
  onWarning?: (message: string, sessionId: string) => void;
  /** `true` se o pedido existia e foi resolvido agora (T20). */
  onPermissionDecide?: (requestId: string, behavior: PermissionBehavior) => boolean;
}

export type CommandHandler = (cmd: RelayCommand) => Promise<AgentEvent>;

/** Falha esperada: vira `command.error` com esta mensagem. */
class CommandError extends Error {}

/** Tira do texto o token e o caminho do socket do inbox, caso alguma camada abaixo os tenha incluído. */
function redact(msg: string, reg: SessionRegistry | undefined): string {
  let out = msg;
  if (reg?.peerToken !== undefined && reg.peerToken !== "") out = out.split(reg.peerToken).join("***");
  if (reg !== undefined && reg.messagingSocketPath !== "") out = out.split(reg.messagingSocketPath).join("<inbox>");
  return out;
}

/**
 * Despacha os comandos do relay. Sempre resolve com `command.ack` ou `command.error`, nunca rejeita.
 * Idempotente por `commandId`: um reenvio (inclusive enquanto o primeiro ainda roda) recebe a mesma promise.
 */
export function createCommandHandler(deps: CommandDeps): CommandHandler {
  const cache = new Map<string, Promise<AgentEvent>>();
  /** `bgId` com um `claude attach` aberto por nós: uma sessão não aguenta dois clientes anexados. */
  const attached = new Set<string>();
  /** Sessões que já receberam o aviso de modo compatível nesta execução do agente. */
  const warned = new Set<string>();

  const ack = (commandId: string, result?: Record<string, unknown>): AgentEvent => ({
    ...newEnvelope(deps.machine),
    type: "command.ack",
    commandId,
    ...(result !== undefined ? { result } : {}),
  });
  const error = (commandId: string, reason: string): AgentEvent => ({
    ...newEnvelope(deps.machine),
    type: "command.error",
    commandId,
    reason,
  });

  const findSession = (sessionId: string): SessionInfo => {
    const s = deps.inventory.find(sessionId);
    if (s === undefined) throw new CommandError(NOT_FOUND);
    return s;
  };

  const execute = async (cmd: RelayCommand): Promise<AgentEvent> => {
    let reg: SessionRegistry | undefined;
    try {
      switch (cmd.type) {
        case "session.send": {
          const s = findSession(cmd.sessionId);
          reg = s.pid !== undefined ? deps.readRegistry(s.pid) : undefined;
          if (reg === undefined) throw new CommandError(NO_INBOX);
          const target: InboxTarget = {
            messagingSocketPath: reg.messagingSocketPath,
            ...(reg.peerToken !== undefined ? { peerToken: reg.peerToken } : {}),
            ...(reg.peerProtocol !== undefined ? { peerProtocol: reg.peerProtocol } : {}),
          };
          try {
            await deps.inject(target, cmd.text, { name: FROM_NAME });
          } catch (e) {
            if (!(e instanceof InboxFormatError)) throw e;
            // O formato do fio mudou: só sessões em background têm o caminho humano `claude --resume`.
            if (s.bgId === undefined) throw new CommandError(INBOX_CHANGED_INTERACTIVE);
            if (attached.has(s.bgId)) throw new CommandError(SLASH_RUNNING);
            if (!warned.has(s.sessionId)) {
              warned.add(s.sessionId);
              deps.onWarning?.(COMPAT_WARNING, s.sessionId);
            }
            const bgId = s.bgId;
            attached.add(bgId);
            try {
              await deps.resume({ sessionId: s.sessionId, text: cmd.text });
            } finally {
              attached.delete(bgId);
            }
          }
          return ack(cmd.commandId);
        }
        case "session.create": {
          const ws = await deps.workspace(cmd.cwd, cmd.create === true);
          const r = await deps.spawn({
            cwd: ws.cwd, name: cmd.name, prompt: cmd.prompt, permissionMode: cmd.permissionMode,
            // Só pasta dentro de raiz dev pode ganhar confiança automática do Claude Code (e só ela tem raiz a reconferir).
            ...(ws.root !== undefined ? { trustPaths: ws.trustPaths, guard: () => deps.recheck(ws) } : {}),
          });
          return ack(cmd.commandId, { sessionId: r.sessionId, bgId: r.bgId, cwd: ws.cwd });
        }
        case "session.stop": {
          const s = findSession(cmd.sessionId);
          if (s.bgId === undefined) throw new CommandError(NOT_BACKGROUND);
          await deps.stop(s.bgId);
          return ack(cmd.commandId);
        }
        case "session.slash": {
          const s = findSession(cmd.sessionId);
          if (s.bgId === undefined) throw new CommandError(SLASH_INTERACTIVE);
          reg = s.pid !== undefined ? deps.readRegistry(s.pid) : undefined;
          if (s.status === "busy" && !SLASH_WHILE_BUSY.has(cmd.command)) throw new CommandError(BUSY_TEXT);
          if (attached.has(s.bgId)) throw new CommandError(SLASH_RUNNING);
          const bgId = s.bgId;
          attached.add(bgId);
          try {
            const r = await deps.slash({ bgId, command: cmd.command, ...(cmd.args !== undefined ? { args: cmd.args } : {}) });
            return ack(cmd.commandId, { screen: redact(r.screen, reg) });
          } finally {
            attached.delete(bgId);
          }
        }
        case "permission.decide": {
          if (deps.onPermissionDecide === undefined) throw new CommandError(NO_PERMISSIONS);
          if (!deps.onPermissionDecide(cmd.requestId, cmd.behavior)) throw new CommandError(PERMISSION_GONE);
          return ack(cmd.commandId);
        }
      }
    } catch (e) {
      return error(cmd.commandId, redact(e instanceof Error ? e.message : String(e), reg));
    }
  };

  return (cmd) => {
    const hit = cache.get(cmd.commandId);
    if (hit !== undefined) {
      cache.delete(cmd.commandId); // reinsere no fim: LRU
      cache.set(cmd.commandId, hit);
      return hit;
    }
    const p = execute(cmd);
    if (cache.size >= CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cmd.commandId, p);
    return p;
  };
}
