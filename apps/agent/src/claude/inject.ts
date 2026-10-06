import { randomUUID } from "node:crypto";
import { connect } from "node:net";

/**
 * Injeção de prompt no inbox local de uma sessão do Claude Code.
 * Este é o ÚNICO arquivo do repositório que conhece o formato do fio do inbox (capturado no spike de 06/10/2026,
 * `peerProtocol: 1`). Se o formato mudar, só este arquivo muda; quem chama trata `InboxFormatError` com o fallback pty.
 */

const SUPPORTED_PROTOCOL = 1;
const TIMEOUT_MS = 5000;
const FROM = "global-agents";
const NAME_MAX = 64;
const NAME_FALLBACK = "discord";

export interface InboxTarget {
  messagingSocketPath: string;
  peerToken?: string;
  peerProtocol?: number;
}

/** O inbox fala uma versão de protocolo que este arquivo não conhece. */
export class InboxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxFormatError";
  }
}

/** O named pipe do Windows exige a linha de auth e não há `peerToken` para ela. */
export class InboxAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxAuthError";
  }
}

/** Named pipe do Windows (`\\.\pipe\…` ou `\\?\pipe\…`), detectado pelo caminho e não pela plataforma. */
export function isWindowsPipe(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith("\\\\.\\pipe\\") || p.startsWith("\\\\?\\pipe\\");
}

/** Escapa o texto para não fechar `<cross-session-message>` antes da hora. `&` primeiro para não escapar duas vezes. */
export function escapeForTag(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9:._@-]/g, "").slice(0, NAME_MAX);
  return s === "" ? NAME_FALLBACK : s;
}

/** Uma linha JSON terminada em `\n` que abre um turno novo na sessão. Exportado para teste. */
export function buildInboxLine(text: string, from: { name: string }): string {
  const content =
    `<cross-session-message from="${FROM}" from-name="${sanitizeName(from.name)}">\n` +
    `${escapeForTag(text)}\n</cross-session-message>`;
  const msg = {
    msgV: 1,
    msg_id: randomUUID(),
    type: "user",
    message: { role: "user", content },
    priority: "next",
    from: FROM,
  };
  return `${JSON.stringify(msg)}\n`;
}

function authLine(token: string): string {
  return `${JSON.stringify({ type: "auth", token })}\n`;
}

/**
 * Entrega `text` como novo turno da sessão. Envia a linha de auth sempre que houver `peerToken` (obrigatória no
 * named pipe do Windows, inofensiva no socket Unix), escreve a linha e fecha; o Claude não responde nada.
 * O prazo (`opts.timeoutMs`, padrão 5 s) cobre conexão + escrita + fechamento: um par que aceita e nunca lê não
 * prende a chamada. Mensagens de erro não trazem o caminho do socket nem o token.
 */
export async function injectPrompt(
  target: InboxTarget,
  text: string,
  from: { name: string },
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  if (target.peerProtocol !== undefined && target.peerProtocol !== SUPPORTED_PROTOCOL) {
    throw new InboxFormatError(`protocolo de inbox não suportado (peerProtocol ${target.peerProtocol})`);
  }
  if (isWindowsPipe(target.messagingSocketPath) && target.peerToken === undefined) {
    throw new InboxAuthError("named pipe do inbox exige peerToken (arquivo .key da sessão)");
  }
  const payload = (target.peerToken !== undefined ? authLine(target.peerToken) : "") + buildInboxLine(text, from);
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy(); // sucesso ou erro: não deixa fd meio-aberto
      if (err !== undefined) reject(err);
      else resolve();
    };
    const socket = connect(target.messagingSocketPath);
    const timer = setTimeout(
      () => finish(new Error(`tempo esgotado ao entregar no inbox da sessão (${timeoutMs} ms)`)),
      timeoutMs,
    );
    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") finish(new Error(`inbox da sessão indisponível (${e.code})`));
      else finish(new Error(`falha na conexão com o inbox da sessão (${e.code ?? "erro desconhecido"})`));
    });
    socket.once("connect", () => {
      // os tipos declaram `() => void`, mas o Node passa o erro da escrita quando ela falha
      socket.end(payload, (err?: NodeJS.ErrnoException | null) => {
        if (err !== undefined && err !== null) finish(new Error(`falha ao escrever no inbox da sessão (${err.code ?? "erro desconhecido"})`));
        else finish();
      });
    });
    socket.once("close", () => finish(new Error("conexão com o inbox fechada antes de concluir a escrita")));
  });
}
