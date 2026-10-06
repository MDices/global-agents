import xtermHeadless from "@xterm/headless";
import * as nodePty from "node-pty";
import type { SlashCommandName } from "@global-agents/protocol";
import { cleanEnv } from "./exec.js";
import { BUSY_TEXT, SLASH_WHILE_BUSY } from "./slash-rules.js";

export { BUSY_TEXT, SLASH_WHILE_BUSY };

// `@xterm/headless` é um bundle CommonJS: o import nomeado não resolve em ESM.
const { Terminal } = xtermHeadless;
type Term = InstanceType<typeof Terminal>;

const COLS = 120;
const ROWS = 40;
/** Quantas linhas da tela renderizada voltam no máximo. */
const MAX_LINES = 60;
const PROMPT_MARK = "❯";
/**
 * Borda de cima dos diálogos do Claude Code. Na 2.1.292 a tela ociosa não tem `▔`; a borda de `/usage` e `/model` traz
 * `◐ medium · /effort` e continua sendo a do diálogo.
 */
const DIALOG_BORDER = /▔{8,}/;
/** Rodapé (`/status`, `/hooks`, `/model`) ou abas do diálogo de configurações (`/usage` e `/cost` rolam e escondem o rodapé). */
const DIALOG_MARKS = [/esc to (cancel|close)/i, /Settings\s+Status\s+Config/];
/** Turno em andamento: spinner `✢ Sublimating… (3s · ↓ 117 tokens)` (intermitente) ou `esc to interrupt`. */
const BUSY_MARKS = [/…\s*\(\d+s\b/, /esc to interrupt/i];
/** Esc mandados no máximo para fechar um diálogo deixado aberto na sessão. */
const ORPHAN_ESC_MAX = 2;

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

/** Texto do diálogo aberto (da última borda `▔` até o fim), ou `undefined` se não há diálogo visível. */
export function dialogRegion(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!DIALOG_BORDER.test(lines[i] ?? "")) continue;
    const region = lines.slice(i).join("\n");
    return DIALOG_MARKS.some((m) => m.test(region)) ? region : undefined;
  }
  return undefined;
}

/**
 * O `❯` da caixa de input: logo abaixo da borda `─` da caixa. Não casa o `❯` dos prompts antigos no transcript nem o
 * cursor de seleção dentro de diálogos (`/model`, `/hooks`), que substituem a caixa enquanto estão abertos.
 */
export function hasInputPrompt(lines: string[]): boolean {
  return lines.some((l, i) => l.trimStart().startsWith(PROMPT_MARK) && (lines[i - 1] ?? "").trimStart().startsWith("─"));
}

/** A tela mostra um turno em andamento (spinner ou `esc to interrupt`). */
export const isBusyScreen = (lines: string[]): boolean => lines.some((l) => BUSY_MARKS.some((m) => m.test(l)));


/**
 * Roda um slash command do Claude Code numa sessão em background: abre `claude attach <bgId>` num pty, espera o
 * prompt, digita `/<comando>[ <args>]` + Enter, espera a tela parar, captura o texto renderizado, fecha o diálogo com
 * Esc (só se houver um visível) e desanexa com Ctrl+Z (a sessão continua rodando). Mata o pty se ele não sair.
 *
 * A tela "parou" quando não chega byte novo por `settleMs`, ou quando um diálogo visível (borda `▔` + rodapé ou abas)
 * não muda por `settleMs`: com a sessão ocupada o transcript é redesenhado sem parar e o silêncio de bytes nunca chega.
 * Fora de `usage`/`cost`/`status`, sessão em turno → `BUSY_TEXT` sem digitar nada.
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

  /**
   * Comandos que mexem na conversa só rodam com a sessão parada: spinner na tela → ocupada; e o pronto exige silêncio
   * (uma sessão em turno nunca fica quieta), então estourar o teto com o `❯` na tela também é "ocupada".
   * `usage`/`cost`/`status` aceitam o atalho "`❯` na tela há `readyQuietMs`".
   */
  const strict = !SLASH_WHILE_BUSY.has(input.command);
  /** Um diálogo resistiu aos Esc: o detach não manda mais nenhum. */
  let skipEsc = false;
  const waitReady = async (): Promise<void> => {
    const deadline = Date.now() + t.readyMs;
    let promptSince: number | undefined;
    let escSent = 0;
    let lastEscAt = 0;
    for (;;) {
      if (exitCode !== undefined) {
        const last = await lastLine();
        throw new Error(`claude attach saiu antes de a sessão abrir (código ${exitCode})${last === "" ? "" : `: ${last}`}`);
      }
      const now = Date.now();
      const lines = await renderLines(term);
      if (strict && isBusyScreen(lines)) throw new Error(BUSY_TEXT);
      // Diálogo deixado aberto por outro attach: digitar nele escolheria opções (no /model, Enter troca o modelo).
      if (dialogRegion(lines) !== undefined) {
        promptSince = undefined;
        if (escSent === 0 || now - lastEscAt >= t.readyQuietMs) {
          if (escSent >= ORPHAN_ESC_MAX) {
            skipEsc = true;
            throw new Error(`há um diálogo aberto na sessão; abra com claude attach ${input.bgId} e feche-o`);
          }
          send("\x1b");
          escSent++;
          lastEscAt = now;
        }
      } else if (hasInputPrompt(lines)) {
        promptSince ??= now;
        if (now - lastData >= t.readyQuietMs || (!strict && now - promptSince >= t.readyQuietMs)) return;
      }
      if (now >= deadline) {
        if (strict && promptSince !== undefined) throw new Error(BUSY_TEXT);
        throw new Error(`tempo esgotado esperando a sessão abrir (${Math.round(t.readyMs / 1000)} s)`);
      }
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
      const r = dialogRegion(lines) ?? "";
      if (r !== region) {
        region = r;
        regionSince = now;
      }
      const dialogStill = r !== "" && now - regionSince >= t.settleMs;
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
    // Esc só fecha diálogo: sem diálogo na tela ele interromperia um turno em andamento.
    if (!skipEsc && dialogRegion(await renderLines(term)) !== undefined) {
      send("\x1b");
      await sleep(t.escGapMs);
    }
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
