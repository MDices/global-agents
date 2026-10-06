import xtermHeadless from "@xterm/headless";
import * as nodePty from "node-pty";
import type { SlashCommandName } from "@global-agents/protocol";
import { cleanEnv } from "./exec.js";

// `@xterm/headless` é um bundle CommonJS: o import nomeado não resolve em ESM.
const { Terminal } = xtermHeadless;
type Term = InstanceType<typeof Terminal>;

const COLS = 120;
const ROWS = 40;
/** Quantas linhas da tela renderizada voltam no máximo. */
const MAX_LINES = 60;
const PROMPT_MARK = "❯";
/** Borda de cima dos diálogos do Claude Code (`/status`, `/usage`, `/cost`…). */
const DIALOG_BORDER = /▔{8,}/;

export interface SlashTimeouts {
  /** Teto para a sessão abrir (prompt `❯` na tela). */
  readyMs: number;
  /** Com o `❯` na tela: espera este silêncio, ou este tempo desde que ele apareceu, antes de digitar. */
  readyQuietMs: number;
  /** Depois do comando: pronto quando não chega byte novo (ou o diálogo não muda) por este tempo. */
  settleMs: number;
  /** Teto para o comando estabilizar (padrão: 120 s para `compact`, 20 s para os demais). */
  ceilingMs: number;
  /** Depois do Ctrl+Z, quanto esperar o `claude attach` sair antes de matar o pty. */
  exitMs: number;
  /** Pausa entre o texto do comando e o Enter. */
  typeGapMs: number;
  /** Pausa entre o Esc e o Ctrl+Z (sem ela, `\x1b\x1a` vira Alt+Ctrl+Z). */
  escGapMs: number;
  /** Intervalo de amostragem da tela. */
  pollMs: number;
}

export const DEFAULT_TIMEOUTS: Omit<SlashTimeouts, "ceilingMs"> = {
  readyMs: 15_000, readyQuietMs: 1_500, settleMs: 2_000, exitMs: 3_000, typeGapMs: 300, escGapMs: 300, pollMs: 100,
};
const CEILING_COMPACT_MS = 120_000;
const CEILING_DEFAULT_MS = 20_000;

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

export interface RunSlashInput {
  bgId: string;
  command: SlashCommandName;
  args?: string;
  claudeBin?: string;
  timeouts?: Partial<SlashTimeouts>;
}

const realSpawnPty: SpawnPty = (file, args, opts) => nodePty.spawn(file, args, opts);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Linhas do buffer ativo (normal ou alternativo), sem estilo, com espaços do fim cortados. */
async function renderLines(term: Term): Promise<string[]> {
  await new Promise<void>((r) => { term.write("", r); }); // espera o parser consumir o que já chegou
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out;
}

/** Tira as linhas vazias das pontas e fica com as últimas `MAX_LINES`. */
function toScreen(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  let start = 0;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  return lines.slice(Math.max(start, end - MAX_LINES), end).join("\n");
}

/** Trecho da tela que decide se ela "parou": o diálogo aberto, se houver; senão a tela toda. */
function watchedRegion(lines: string[]): string {
  let border = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (DIALOG_BORDER.test(lines[i] ?? "")) {
      border = i;
      break;
    }
  }
  return (border >= 0 ? lines.slice(border) : lines).join("\n");
}

const hasPrompt = (lines: string[]): boolean => lines.some((l) => l.trimStart().startsWith(PROMPT_MARK));

/**
 * Roda um slash command do Claude Code numa sessão em background: abre `claude attach <bgId>` num pty, espera o
 * prompt, digita `/<comando>[ <args>]` + Enter, espera a tela parar, captura o texto renderizado, fecha diálogos com
 * Esc e desanexa com Ctrl+Z (a sessão continua rodando). Mata o pty se ele não sair.
 *
 * A tela "parou" quando não chega byte novo por `settleMs`, ou quando um diálogo está aberto e o texto dele não muda
 * por `settleMs`: com a sessão ocupada o transcript é redesenhado sem parar e o silêncio de bytes nunca chega.
 */
export async function runSlash(input: RunSlashInput, deps: { spawnPty?: SpawnPty } = {}): Promise<{ screen: string }> {
  const t: SlashTimeouts = {
    ...DEFAULT_TIMEOUTS,
    ceilingMs: input.command === "compact" ? CEILING_COMPACT_MS : CEILING_DEFAULT_MS,
    ...input.timeouts,
  };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanEnv(process.env))) if (v !== undefined) env[k] = v;
  env["TERM"] = "xterm-256color";

  const spawnPty = deps.spawnPty ?? realSpawnPty;
  const pty = spawnPty(input.claudeBin ?? "claude", ["attach", input.bgId], { name: "xterm-256color", cols: COLS, rows: ROWS, env });
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

  let lastData = Date.now();
  let exitCode: number | undefined;
  let onExited: (() => void) | undefined;
  pty.onData((d) => {
    lastData = Date.now();
    term.write(d);
  });
  pty.onExit((e) => {
    exitCode = e.exitCode;
    onExited?.();
  });

  const lastLine = async (): Promise<string> => toScreen(await renderLines(term)).split("\n").at(-1)?.trim() ?? "";

  const waitReady = async (): Promise<void> => {
    const deadline = Date.now() + t.readyMs;
    let promptSince: number | undefined;
    for (;;) {
      if (exitCode !== undefined) {
        const last = await lastLine();
        throw new Error(`claude attach saiu antes de a sessão abrir (código ${exitCode})${last === "" ? "" : `: ${last}`}`);
      }
      const now = Date.now();
      if (hasPrompt(await renderLines(term))) {
        promptSince ??= now;
        if (now - lastData >= t.readyQuietMs || now - promptSince >= t.readyQuietMs) return;
      }
      if (now >= deadline) throw new Error(`tempo esgotado esperando a sessão abrir (${Math.round(t.readyMs / 1000)} s)`);
      await sleep(t.pollMs);
    }
  };

  const waitSettled = async (): Promise<string[]> => {
    const deadline = Date.now() + t.ceilingMs;
    let region = "";
    let regionSince = Date.now();
    for (;;) {
      await sleep(t.pollMs);
      const lines = await renderLines(term);
      if (exitCode !== undefined) throw new Error(`claude attach saiu durante o comando (código ${exitCode})`);
      const now = Date.now();
      const r = watchedRegion(lines);
      if (r !== region) {
        region = r;
        regionSince = now;
      }
      const dialogStill = DIALOG_BORDER.test(r) && now - regionSince >= t.settleMs;
      if (now - lastData >= t.settleMs || dialogStill) return lines;
      if (now >= deadline) throw new Error(`tempo esgotado esperando /${input.command} terminar (${Math.round(t.ceilingMs / 1000)} s)`);
    }
  };

  const send = (data: string): void => {
    try {
      pty.write(data);
    } catch {
      // pty já fechado
    }
  };

  const detach = async (): Promise<void> => {
    if (exitCode !== undefined) return;
    send("\x1b");
    await sleep(t.escGapMs);
    send("\x1a");
    const exited = await new Promise<boolean>((resolve) => {
      if (exitCode !== undefined) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => { resolve(false); }, t.exitMs);
      onExited = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    if (!exited) {
      try {
        pty.kill();
      } catch {
        // já saiu
      }
    }
  };

  try {
    await waitReady();
    send(`/${input.command}${input.args !== undefined && input.args !== "" ? ` ${input.args}` : ""}`);
    await sleep(t.typeGapMs);
    send("\r");
    lastData = Date.now(); // o silêncio conta a partir do Enter
    return { screen: toScreen(await waitSettled()) };
  } finally {
    await detach();
    term.dispose();
  }
}
