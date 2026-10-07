import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Nome aceito para cada pasta criada pelo `/novo criar:true`. */
export const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const NOT_EXISTS_TEXT = "pasta não existe; use criar:true no /novo para criá-la";
export const NO_DEV_ROOT_TEXT = "esta máquina não tem pasta dev; rode global-agents install --dev-root <pasta>";

/** O que a resolução usa de `node:path` (o real é o da plataforma; os testes injetam `path.win32`). */
export type PathApi = Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "dirname" | "sep">;

/** O que a resolução usa do disco (o real é `node:fs/promises`). */
export interface WorkspaceFs {
  /** `true` se o caminho existe sem seguir symlink (um symlink quebrado existe). */
  exists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  mkdirp(p: string): Promise<void>;
}

export interface WorkspacePolicy {
  /** Raízes dev absolutas: tudo dentro delas pode ser usado (e criado). */
  devRoots: readonly string[];
  /** Projetos explícitos da config (compatibilidade): permitidos mesmo fora das raízes, mas nunca criados. */
  projects: readonly string[];
  path?: PathApi;
  fs?: WorkspaceFs;
}

export interface ResolvedWorkspace {
  /** Caminho absoluto onde a sessão abre. */
  cwd: string;
  /** Raiz dev que contém a pasta; ausente quando ela só foi aceita por estar na lista `projects`. */
  root?: string;
  /** Caminhos reais da pasta (o resolvido e o `realpath`, sem repetição): onde gravar a confiança se preciso. */
  trustPaths: string[];
  created: boolean;
}

const nodeFs: WorkspaceFs = {
  async exists(p) {
    try {
      await lstat(p);
      return true;
    } catch {
      return false;
    }
  },
  realpath: (p) => realpath(p),
  async mkdirp(p) {
    await mkdir(p, { recursive: true });
  },
};

const isWin = (p: PathApi): boolean => p.sep === "\\";

/** Compara caminhos como o SO compara: sem diferenciar maiúsculas no Windows. */
function key(p: PathApi, s: string): string {
  return isWin(p) ? s.toLowerCase() : s;
}

/**
 * `target` está dentro de `root` (ou é a própria raiz)? Os dois já devem ser absolutos e reais (`realpath`). No
 * Windows a comparação ignora maiúsculas; drive diferente dá caminho absoluto em `relative` e cai fora.
 */
export function isInside(root: string, target: string, p: PathApi = path): boolean {
  const rel = p.relative(key(p, root), key(p, target));
  if (rel === "") return true;
  if (p.isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  return first !== "..";
}

/** Primeiro ancestral existente de `abs` (ele mesmo, se existir) e os segmentos que faltam abaixo dele. */
async function nearestExisting(abs: string, p: PathApi, fs: WorkspaceFs): Promise<{ existing: string; missing: string[] }> {
  const missing: string[] = [];
  let cur = abs;
  while (!(await fs.exists(cur))) {
    const parent = p.dirname(cur);
    if (parent === cur) break; // chegou à raiz do disco sem achar nada (drive inexistente)
    missing.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ""));
    cur = parent;
  }
  return { existing: cur, missing };
}

async function realOrUndefined(fs: WorkspaceFs, p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

/**
 * Decide onde abrir uma sessão pedida pelo Discord. É a fronteira de confiança: o relay só confere o formato.
 *
 * - `cwd` absoluto ou relativo; relativo resolve contra a primeira raiz dev.
 * - Permitido se estiver dentro de alguma raiz dev ou na lista `projects` explícita. "Dentro" compara o `realpath` do
 *   ancestral existente mais próximo com o `realpath` da raiz: symlink que sai da raiz é negado; a própria raiz vale.
 * - Pasta inexistente só é criada com `create`, dentro de uma raiz, e cada segmento novo precisa casar `SEGMENT_RE`.
 *
 * Erros saem em português e vão para o usuário no Discord.
 */
export async function resolveWorkspace(cwd: string, create: boolean, policy: WorkspacePolicy): Promise<ResolvedWorkspace> {
  const p = policy.path ?? path;
  const fs = policy.fs ?? nodeFs;
  const roots = policy.devRoots.map((r) => p.resolve(r));
  let abs: string;
  if (p.isAbsolute(cwd)) abs = p.resolve(cwd);
  else {
    const first = roots[0];
    if (first === undefined) throw new Error(`${NO_DEV_ROOT_TEXT} (ou informe um caminho absoluto de um projeto configurado)`);
    abs = p.resolve(first, cwd);
  }

  const { existing, missing } = await nearestExisting(abs, p, fs);
  const realExisting = await realOrUndefined(fs, existing);
  let root: string | undefined;
  let realRoot: string | undefined;
  if (realExisting !== undefined) {
    for (const r of roots) {
      const rr = await realOrUndefined(fs, r);
      if (rr !== undefined && isInside(rr, realExisting, p)) {
        root = r;
        realRoot = rr;
        break;
      }
    }
  }

  if (root === undefined) {
    const explicit = policy.projects.some((proj) => key(p, p.resolve(proj)) === key(p, abs));
    if (!explicit) {
      const where = roots.length > 0 ? `fora das pastas dev desta máquina (${roots.join(", ")})` : "fora das pastas permitidas (esta máquina não tem pasta dev)";
      throw new Error(`a pasta ${abs} está ${where} e não é um projeto configurado`);
    }
    if (missing.length > 0) throw new Error(`${NOT_EXISTS_TEXT} (${abs}); só dá para criar pastas dentro de uma pasta dev`);
    return { cwd: abs, trustPaths: [], created: false };
  }

  let created = false;
  if (missing.length > 0) {
    if (!create) throw new Error(`${NOT_EXISTS_TEXT} (${abs})`);
    for (const seg of missing) {
      if (!SEGMENT_RE.test(seg)) {
        throw new Error(`nome de pasta inválido: "${seg}"; use letras, números, ".", "_" ou "-", começando por letra ou número`);
      }
    }
    await fs.mkdirp(abs);
    created = true;
  }
  const real = await realOrUndefined(fs, abs);
  // Confere de novo depois do mkdir: a pasta final também tem que estar dentro da raiz.
  if (realRoot !== undefined && real !== undefined && !isInside(realRoot, real, p)) {
    throw new Error(`a pasta ${abs} aponta para fora da pasta dev ${root}`);
  }
  const trustPaths = real === undefined || real === abs ? [abs] : [abs, real];
  return { cwd: abs, root, trustPaths, created };
}
