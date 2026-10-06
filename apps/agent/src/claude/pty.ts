import xtermHeadless from "@xterm/headless";
import { cleanEnv } from "./exec.js";

/**
 * Peças comuns aos dois usos de pty do agente (`/claude` via `claude attach`, e o fallback `claude --resume`):
 * tipos do pty, carga preguiçosa do `node-pty` (módulo nativo opcional: se não carregar, só esses recursos falham, e não
 * o agente inteiro), env limpo e renderização da tela com `@xterm/headless`.
 */

// `@xterm/headless` é um bundle CommonJS: o import nomeado não resolve em ESM.
export const { Terminal } = xtermHeadless;
export type Term = InstanceType<typeof Terminal>;

export const COLS = 120;
export const ROWS = 40;
/** Quantas linhas da tela renderizada voltam no máximo. */
const MAX_LINES = 60;
const PROMPT_MARK = "❯";

/** O que usamos de um pty (o real é o `IPty` do `node-pty`). */
export interface PtyProcess {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  write(data: string): void;
  kill(signal?: string): void;
}

export interface SpawnPtyOptions {
  name: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type SpawnPty = (file: string, args: string[], opts: SpawnPtyOptions) => PtyProcess;

let loaded: Promise<SpawnPty> | undefined;

/** Carrega o `node-pty` na primeira chamada. Rejeita (e tenta de novo na próxima) se o módulo nativo não carregar. */
export function loadSpawnPty(): Promise<SpawnPty> {
  loaded ??= import("node-pty").then(
    (m): SpawnPty => (file, args, opts) => m.spawn(file, args, opts),
    (e: unknown) => {
      loaded = undefined;
      throw new Error(`node-pty não carregou: ${e instanceof Error ? e.message : String(e)}`);
    },
  );
  return loaded;
}

/** Env do processo sem as variáveis da sessão do Claude que nos chamou, com `TERM=xterm-256color`. */
export function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanEnv(process.env))) if (v !== undefined) env[k] = v;
  env["TERM"] = "xterm-256color";
  return env;
}

/** Espera o parser do terminal consumir o que já chegou. */
const flush = (term: Term): Promise<void> => new Promise<void>((r) => { term.write("", r); });

type Buffer = Term["buffer"]["active"];

function bufferLines(buf: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out;
}

/** Como `bufferLines`, mas cada linha lógica quebrada pela largura do terminal volta numa linha só. */
function logicalLines(buf: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    const next = buf.getLine(i + 1);
    const text = line?.translateToString(next?.isWrapped !== true) ?? "";
    if (line?.isWrapped === true && out.length > 0) out[out.length - 1] += text;
    else out.push(text);
  }
  return out;
}

/** Linhas do buffer ativo (normal ou alternativo), sem estilo, com espaços do fim cortados. */
export async function renderLines(term: Term): Promise<string[]> {
  await flush(term);
  return bufferLines(term.buffer.active);
}

/**
 * Linhas lógicas (quebras de largura desfeitas) do buffer normal seguidas das do alternativo. O que um programa
 * imprime antes de abrir a tela cheia (`\x1b[?1049h`) fica só no buffer normal, invisível em `buffer.active` depois.
 */
export async function renderAllLines(term: Term): Promise<string[]> {
  await flush(term);
  return [...logicalLines(term.buffer.normal), ...logicalLines(term.buffer.alternate)];
}

/** Tira as linhas vazias das pontas e fica com as últimas `MAX_LINES`. */
export function toScreen(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  let start = 0;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  return lines.slice(Math.max(start, end - MAX_LINES), end).join("\n");
}

/**
 * O `❯` da caixa de input: logo abaixo da borda `─` da caixa. Não casa o `❯` dos prompts antigos no transcript nem o
 * cursor de seleção dentro de diálogos (`/model`, `/hooks`), que substituem a caixa enquanto estão abertos.
 */
export function hasInputPrompt(lines: string[]): boolean {
  return lines.some((l, i) => l.trimStart().startsWith(PROMPT_MARK) && (lines[i - 1] ?? "").trimStart().startsWith("─"));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Escreve no pty ignorando o erro de pty já fechado. */
export function safeWrite(pty: PtyProcess, data: string): void {
  try {
    pty.write(data);
  } catch {
    // pty já fechado
  }
}

/**
 * Desanexa um cliente do Claude Code com Ctrl+Z (a sessão em background continua) e mata o pty se ele não sair em
 * `exitMs`. Nunca manda Esc: sem diálogo na tela, Esc interromperia um turno em andamento.
 */
export async function detachAndReap(
  pty: PtyProcess,
  exit: { exited(): boolean; onExit(cb: () => void): void },
  exitMs: number,
): Promise<void> {
  if (exit.exited()) return;
  safeWrite(pty, "\x1a");
  const exited = await new Promise<boolean>((resolve) => {
    if (exit.exited()) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => { resolve(false); }, exitMs);
    exit.onExit(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    try {
      pty.kill();
    } catch {
      // já saiu
    }
  }
}
