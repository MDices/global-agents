import { newEnvelope, type AgentEvent, type PermissionBehavior, type RelayCommand, type SessionInfo } from "@global-agents/protocol";
import type { InboxTarget } from "../claude/inject.js";
import type { SessionRegistry } from "../claude/registry.js";
import type { SpawnInput } from "../claude/spawn.js";

/** Respostas guardadas por `commandId` (inclui comandos ainda em andamento). */
const CACHE_SIZE = 500;
/** Nome mostrado na sessão como remetente; o relay ainda não manda o usuário do Discord. */
const FROM_NAME = "discord";

const NOT_FOUND = "sessão não encontrada nesta máquina";
const NO_INBOX = "sessão sem inbox (reinicie a sessão)";
const NOT_BACKGROUND = "só sessões em background podem ser paradas pelo Discord; use claude /exit no terminal";
const NO_PERMISSIONS = "permissões ainda não suportadas";
const PERMISSION_GONE = "pedido de permissão não encontrado ou já resolvido";

export interface CommandDeps {
  machine: string;
  inventory: { find(sessionId: string): SessionInfo | undefined };
  inject: (target: InboxTarget, text: string, from: { name: string }) => Promise<void>;
  spawn: (input: SpawnInput) => Promise<{ sessionId: string; bgId: string }>;
  stop: (bgId: string) => Promise<void>;
  readRegistry: (pid: number) => SessionRegistry | undefined;
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
          await deps.inject(target, cmd.text, { name: FROM_NAME });
          return ack(cmd.commandId);
        }
        case "session.create": {
          const r = await deps.spawn({ cwd: cmd.cwd, name: cmd.name, prompt: cmd.prompt, permissionMode: cmd.permissionMode });
          return ack(cmd.commandId, { sessionId: r.sessionId, bgId: r.bgId });
        }
        case "session.stop": {
          const s = findSession(cmd.sessionId);
          if (s.bgId === undefined) throw new CommandError(NOT_BACKGROUND);
          await deps.stop(s.bgId);
          return ack(cmd.commandId);
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
