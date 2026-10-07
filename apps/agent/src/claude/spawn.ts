import { stat } from "node:fs/promises";
import type { PermissionMode } from "@global-agents/protocol";
import type { ExecResult } from "./exec.js";
import type { Inventory } from "./inventory.js";

export class WorkspaceNotTrustedError extends Error {
  constructor(cwd: string) {
    super(`a pasta ${cwd} ainda não é confiável para o Claude Code; abra \`claude\` nela uma vez e aceite a confiança`);
    this.name = "WorkspaceNotTrustedError";
  }
}

export class SessionNotVisibleError extends Error {
  constructor(readonly bgId: string) {
    super(`sessão criada (${bgId}) mas não apareceu no inventário em 30 s; abra com: claude attach ${bgId}`);
    this.name = "SessionNotVisibleError";
  }
}

export type SpawnRun = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

export interface SpawnInput {
  cwd: string;
  name: string;
  prompt: string;
  permissionMode: PermissionMode;
  /**
   * Pasta dentro de uma raiz dev: se o Claude Code recusar por falta de confiança, estes caminhos são marcados como
   * confiáveis (`deps.trust`) e o `--bg` é tentado mais uma vez. Ausente ou vazio: nunca grava confiança.
   */
  trustPaths?: string[];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Extrai o id curto (8 hex) da saída de `claude --bg`. */
function parseBgId(output: string): string | undefined {
  return (/backgrounded\s*[·•]\s*([0-9a-f]{8})/.exec(output) ?? /claude attach ([0-9a-f]{8})/.exec(output))?.[1];
}

const NOT_TRUSTED = "Workspace not trusted";

export async function spawnSession(
  input: SpawnInput,
  deps: { run: SpawnRun; inventory: Pick<Inventory, "waitFor">; trust?: (paths: string[]) => Promise<boolean> },
): Promise<{ sessionId: string; bgId: string }> {
  if (!(await isDirectory(input.cwd))) throw new Error(`pasta não encontrada: ${input.cwd}`);
  const bg = async (): Promise<string> => {
    const r = await deps.run(["--bg", "--name", input.name, "--permission-mode", input.permissionMode, "--", input.prompt], {
      cwd: input.cwd,
      timeoutMs: 60000,
    });
    return `${r.stdout}\n${r.stderr}`;
  };
  let out = await bg();
  // Pasta nova sem git herda a confiança da raiz dev; repositório git (ou raiz não confiável) não herda.
  const trustPaths = input.trustPaths ?? [];
  if (out.includes(NOT_TRUSTED) && trustPaths.length > 0 && deps.trust !== undefined && (await deps.trust(trustPaths))) {
    out = await bg();
  }
  if (out.includes(NOT_TRUSTED)) throw new WorkspaceNotTrustedError(input.cwd);
  const bgId = parseBgId(out);
  if (bgId === undefined) throw new Error(`claude --bg não devolveu o id da sessão: ${out.trim().slice(0, 300)}`);
  const info = await deps.inventory.waitFor((s) => s.bgId === bgId, 30000).catch(() => {
    throw new SessionNotVisibleError(bgId);
  });
  return { sessionId: info.sessionId, bgId };
}
