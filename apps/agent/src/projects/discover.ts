import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Teto de projetos descobertos enviados ao relay (o autocomplete do Discord mostra 25 por vez). */
export const DISCOVER_LIMIT = 200;

/**
 * Pastas que nunca viram projeto: dependências e saídas de build comuns. Pastas ocultas (`.algo`) também são
 * ignoradas, à parte.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "bower_components", "vendor", "dist", "build", "out", "target", "coverage", "__pycache__", "venv",
]);

export interface DiscoverOptions {
  limit?: number;
}

const skip = (name: string): boolean => name.startsWith(".") || IGNORED_DIRS.has(name);

async function subdirs(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // raiz sumiu ou sem permissão: só não sugere nada dela
  }
  // `withFileTypes` usa lstat: symlink não é `isDirectory()`, então nunca é seguido.
  return entries.filter((e) => e.isDirectory() && !skip(e.name)).map((e) => e.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, ".git")); // pasta (clone) ou arquivo (worktree, submódulo)
    return true;
  } catch {
    return false;
  }
}

/**
 * Projetos dentro das raízes dev, em caminhos absolutos: as subpastas de 1º nível e, abaixo delas, os repositórios
 * git (pasta com `.git`) do 2º nível. Ignora ocultas e `IGNORED_DIRS`, não segue symlinks e para em `limit`.
 * A ordem é estável (alfabética, cada repositório logo depois da pasta que o contém), para comparar varreduras.
 */
export async function discoverProjects(roots: readonly string[], opts: DiscoverOptions = {}): Promise<string[]> {
  const limit = opts.limit ?? DISCOVER_LIMIT;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): boolean => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
    return out.length < limit;
  };
  for (const root of roots) {
    for (const name of await subdirs(root)) {
      const first = join(root, name);
      if (!add(first)) return out;
      for (const child of await subdirs(first)) {
        const second = join(first, child);
        if ((await isGitRepo(second)) && !add(second)) return out;
      }
    }
  }
  return out;
}
