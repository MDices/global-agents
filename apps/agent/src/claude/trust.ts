import { randomBytes } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Marca `paths` como confiáveis no estado do Claude Code, do jeito que a própria mensagem de erro do Claude Code
 * ensina (`projects[<pasta>].hasTrustDialogAccepted: true`). Mantém todos os outros campos; escreve num arquivo
 * temporário na mesma pasta e troca com `rename` (atômico), com o mesmo modo do original.
 *
 * Devolve `false` sem gravar nada se o arquivo não existe ou não é um JSON de objeto (melhor falhar com a instrução
 * de confiança do que criar ou estragar o estado do Claude Code).
 *
 * Corrida conhecida: o Claude Code relê o arquivo e mescla `projects` a cada gravação, mas não usamos a trava dele.
 * Se uma sessão aberta gravar entre a nossa leitura e o `rename`, a gravação dela se perde (contadores e caches;
 * a janela é de milissegundos); se ela gravar com uma leitura anterior à nossa, a nossa confiança se perde e a
 * sessão falha com a instrução de confiança, como antes.
 */
export async function grantTrust(paths: readonly string[], file: string = claudeStatePath()): Promise<boolean> {
  let raw: string;
  let mode: number;
  try {
    [raw, mode] = await Promise.all([readFile(file, "utf8"), stat(file).then((s) => s.mode & 0o777)]);
  } catch {
    return false;
  }
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(state)) return false;
  const projects = isRecord(state["projects"]) ? { ...state["projects"] } : {};
  let changed = false;
  for (const p of paths) {
    const entry = projects[p];
    if (isRecord(entry) && entry["hasTrustDialogAccepted"] === true) continue;
    projects[p] = { ...(isRecord(entry) ? entry : {}), hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return true;
  const out = JSON.stringify({ ...state, projects }, null, 2) + (raw.endsWith("\n") ? "\n" : "");
  const tmp = join(dirname(file), `.claude.json.global-agents-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, out, { mode });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return true;
}
