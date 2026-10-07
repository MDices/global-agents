import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Arquivo de estado global do Claude Code, onde fica a confiança por pasta (`projects[<pasta>].hasTrustDialogAccepted`).
 * Com `CLAUDE_CONFIG_DIR` ele mora nessa pasta; sem, em `~/.claude.json`.
 */
export function claudeStatePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env["CLAUDE_CONFIG_DIR"];
  return dir !== undefined && dir !== "" ? join(dir, ".claude.json") : join(home, ".claude.json");
}

/**
 * Chaves de `projects` como o Claude Code as lê. No Windows ele troca `\` por `/` (`C:/Users/Leo/Dev/app`); a letra
 * do drive vai maiúscula, como o `realpath` devolve. Também grava a forma NFC quando ela difere (o Claude Code faz o
 * mesmo ao marcar confiança), para nomes com acento vindos em NFD.
 */
export function trustKeys(paths: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const k = platform === "win32" ? p.replaceAll("\\", "/").replace(/^[a-z]:/, (d) => d.toUpperCase()) : p;
    for (const v of [k, k.normalize("NFC")]) if (!out.includes(v)) out.push(v);
  }
  return out;
}

export interface GrantTrustOptions {
  file?: string;
  platform?: NodeJS.Platform;
  /** Quanto esperar pela trava do Claude Code antes de desistir (padrão 2 s). */
  lockWaitMs?: number;
  /** Só para testes: roda entre gravar o temporário e reler o original (simula outra gravação no meio). */
  beforeRename?: () => Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Conteúdo novo com as chaves confiáveis; `undefined` = arquivo ilegível; igual ao `raw` = nada a mudar. */
function merged(raw: string, keys: readonly string[]): string | undefined {
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(state)) return undefined;
  const projects = isRecord(state["projects"]) ? { ...state["projects"] } : {};
  let changed = false;
  for (const k of keys) {
    const entry = projects[k];
    if (isRecord(entry) && entry["hasTrustDialogAccepted"] === true) continue;
    projects[k] = { ...(isRecord(entry) ? entry : {}), hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return raw;
  return JSON.stringify({ ...state, projects }, null, 2) + (raw.endsWith("\n") ? "\n" : "");
}

/** Pega a mesma trava do Claude Code (`proper-lockfile`: a pasta `<arquivo>.lock`); `false` se não vier a tempo. */
async function acquireLock(lock: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lock);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) return false;
      await sleep(50);
    }
  }
}

/**
 * Marca `paths` como confiáveis no estado do Claude Code, do jeito que a própria mensagem de erro do Claude Code
 * ensina (`projects[<pasta>].hasTrustDialogAccepted: true`), com as chaves no formato dele (`trustKeys`).
 *
 * - Segue symlink do arquivo (dotfiles): escreve no alvo real.
 * - Pega a trava do Claude Code (`<arquivo>.lock`) por até `lockWaitMs`; ocupada além disso → `false`, nada gravado.
 * - Mantém todos os outros campos; escreve num temporário na mesma pasta, relê o original logo antes do `rename` e,
 *   se ele mudou no meio (quem não respeita a trava), refaz a mescla uma vez; mudou de novo → `false`.
 * - Arquivo ausente ou que não é um JSON de objeto → `false` sem gravar (melhor falhar com a instrução de confiança
 *   do que criar ou estragar o estado do Claude Code).
 */
export async function grantTrust(paths: readonly string[], opts: GrantTrustOptions = {}): Promise<boolean> {
  let file: string;
  try {
    file = await realpath(opts.file ?? claudeStatePath());
  } catch {
    return false;
  }
  const keys = trustKeys(paths, opts.platform);
  const lock = `${file}.lock`;
  if (!(await acquireLock(lock, opts.lockWaitMs ?? 2000))) return false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await readFile(file, "utf8");
      const out = merged(raw, keys);
      if (out === undefined) return false;
      if (out === raw) return true;
      const mode = (await stat(file)).mode & 0o777;
      const tmp = join(dirname(file), `.claude.json.global-agents-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
      try {
        await writeFile(tmp, out, { mode });
        await opts.beforeRename?.();
        if ((await readFile(file, "utf8")) !== raw) continue; // alguém gravou no meio: refaz a mescla
        await rename(tmp, file);
        return true;
      } finally {
        await rm(tmp, { force: true });
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}
