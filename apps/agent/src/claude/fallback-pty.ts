import {
  COLS, ROWS, Terminal, detachAndReap, hasInputPrompt, loadSpawnPty, ptyEnv, renderAllLines, renderLines, sleep, toScreen,
  type SpawnPty,
} from "./pty.js";

/**
 * Fallback de injeção quando o formato do inbox muda (`InboxFormatError`): o caminho humano oficial,
 * `claude --resume <sessionId> -- "<texto>"`, que numa sessão em background rodando manda o prompt como o próximo turno
 * e depois anexa. Ele recusa sem TTY, por isso o pty. Depois da resposta, Ctrl+Z desanexa (a sessão continua).
 */

const SENT = /Sent your prompt to the background session/;
/** `Your prompt was not sent to it` (prompt com `/`/`!`, ou sessão esperando resposta) e a recusa sem TTY. */
const REFUSED = [/Your prompt was not sent/, /running in the background/];
/** O motivo vem depois dos dois-pontos, até o fim da frase; o resto do parágrafo são conselhos de linha de comando. */
const NOT_SENT_REASON = /Your prompt was not sent to it:\s*(.+?\.)(?:\s|$)/;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_EXIT_MS = 3_000;
const DEFAULT_ATTACH_MS = 10_000;
const DEFAULT_POLL_MS = 100;

export const PTY_UNAVAILABLE = "fallback indisponível (node-pty não carregou)";

export type PtyOutcome = { kind: "sent" } | { kind: "refused"; reason: string };

/**
 * Lê o texto renderizado (sem ANSI) do `claude --resume`. Sucesso tem prioridade. Na recusa o motivo é a frase depois
 * de `Your prompt was not sent to it:`; sem ela, o parágrafo da frase casada (até a linha em branco), com as quebras de
 * linha juntadas.
 */
export function parsePtyOutput(text: string): PtyOutcome | undefined {
  if (SENT.test(text)) return { kind: "sent" };
  const lines = text.split("\n");
  const i = lines.findIndex((l) => REFUSED.some((r) => r.test(l)));
  if (i < 0) return undefined;
  let start = i;
  while (start > 0 && (lines[start - 1] ?? "").trim() !== "") start--;
  let end = i + 1;
  while (end < lines.length && (lines[end] ?? "").trim() !== "") end++;
  const paragraph = lines.slice(start, end).join(" ").replace(/\s+/g, " ").trim();
  return { kind: "refused", reason: NOT_SENT_REASON.exec(paragraph)?.[1] ?? paragraph };
}

export interface ResumeViaPtyInput {
  sessionId: string;
  text: string;
  claudeBin?: string;
  /** Teto para aparecer a frase de envio ou de recusa (padrão 20 s). */
  timeoutMs?: number;
  /**
   * Depois da frase, teto para o attach desenhar a caixa de input antes do Ctrl+Z (padrão 10 s). Antes disso o terminal
   * ainda está em modo canônico e o Ctrl+Z vira `^Z` ecoado, sem chegar ao Claude.
   */
  attachMs?: number;
  /** Depois do Ctrl+Z, quanto esperar o processo sair antes de matar o pty (padrão 3 s). */
  exitMs?: number;
  /** Intervalo de amostragem da tela (padrão 100 ms). */
  pollMs?: number;
}

export interface ResumeViaPtyDeps {
  spawnPty?: SpawnPty;
  /** Carga do `node-pty` (o real é `loadSpawnPty`); usado só sem `spawnPty`. */
  loadSpawnPty?: () => Promise<SpawnPty>;
}

/** Manda `text` à sessão em background `sessionId` por `claude --resume` num pty. Rejeita com a frase da recusa. */
export async function resumeViaPty(input: ResumeViaPtyInput, deps: ResumeViaPtyDeps = {}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exitMs = input.exitMs ?? DEFAULT_EXIT_MS;
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const attachMs = input.attachMs ?? DEFAULT_ATTACH_MS;

  let spawnPty = deps.spawnPty;
  if (spawnPty === undefined) {
    try {
      spawnPty = await (deps.loadSpawnPty ?? loadSpawnPty)();
    } catch {
      throw new Error(PTY_UNAVAILABLE);
    }
  }

  // `--` antes do texto: um prompt começando com `-` seria lido como opção.
  const pty = spawnPty(input.claudeBin ?? "claude", ["--resume", input.sessionId, "--", input.text], {
    name: "xterm-256color", cols: COLS, rows: ROWS, env: ptyEnv(),
  });
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  let exitCode: number | undefined;
  const exitCbs: (() => void)[] = [];
  pty.onData((d) => { term.write(d); });
  pty.onExit((e) => {
    exitCode = e.exitCode;
    for (const cb of exitCbs) cb();
  });

  const waitOutcome = async (): Promise<PtyOutcome> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // lê `exitCode` antes de renderizar: a saída que chegou antes do exit já está no terminal
      const exited = exitCode;
      const lines = await renderAllLines(term);
      const outcome = parsePtyOutput(lines.join("\n"));
      if (outcome !== undefined) return outcome;
      if (exited !== undefined) {
        const last = toScreen(lines).split("\n").at(-1)?.trim() ?? "";
        throw new Error(`claude --resume saiu sem confirmar o envio (código ${exited})${last === "" ? "" : `: ${last}`}`);
      }
      if (Date.now() >= deadline) throw new Error(`tempo esgotado esperando o claude --resume confirmar o envio (${timeoutMs / 1000} s)`);
      await sleep(pollMs);
    }
  };

  /** Espera o attach mostrar a caixa de input (ou o processo sair), até `attachMs`. */
  const waitAttached = async (): Promise<void> => {
    const deadline = Date.now() + attachMs;
    while (exitCode === undefined && Date.now() < deadline) {
      if (hasInputPrompt(await renderLines(term))) return;
      await sleep(pollMs);
    }
  };

  try {
    const outcome = await waitOutcome();
    await waitAttached();
    if (outcome.kind === "refused") throw new Error(`o Claude recusou o prompt: ${outcome.reason}`);
  } finally {
    await detachAndReap(pty, { exited: () => exitCode !== undefined, onExit: (cb) => { exitCbs.push(cb); } }, exitMs);
    term.dispose();
  }
}
