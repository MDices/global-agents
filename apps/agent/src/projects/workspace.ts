import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { noDevRootText } from "@global-agents/protocol";

/** Nome aceito para cada pasta criada pelo `/novo nova_pasta:<nome>`. */
export const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const NOT_EXISTS_TEXT = "pasta não existe; use nova_pasta:<nome> no /novo para criá-la";
/** `create` com pasta que já existe: `typed` é o que o usuário digitou em `nova_pasta`. */
const existsText = (typed: string): string => `a pasta ${typed} já existe; use projeto:${typed} para abri-la`;
/** Nomes que o Windows reserva (com ou sem extensão): `CON`, `NUL`, `COM1`, `lpt9.txt`… */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

/** O que a resolução usa de `node:path` (o real é o da plataforma; os testes injetam `path.win32`). */
export type PathApi = Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "dirname" | "join" | "sep">;

/** O que a resolução usa do disco (o real é `node:fs/promises`). */
export interface WorkspaceFs {
  /** `true` se o caminho existe sem seguir symlink (um symlink quebrado existe). */
  exists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  /** `true` se o caminho (seguindo symlink) é uma pasta. */
  isDirectory(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
}

export interface WorkspacePolicy {
  /** Raízes dev absolutas: tudo dentro delas pode ser usado (e criado). */
  devRoots: readonly string[];
  /** Projetos explícitos da config (compatibilidade): permitidos mesmo fora das raízes, mas nunca criados. */
  projects: readonly string[];
  path?: PathApi;
  fs?: WorkspaceFs;
  /** Home para expandir `~` digitado no Discord (padrão: o do usuário do agente). */
  home?: string;
}

export interface ResolvedWorkspace {
  /** Caminho absoluto onde a sessão abre. */
  cwd: string;
  /** Raiz dev que contém a pasta; ausente quando ela só foi aceita por estar na lista `projects`. */
  root?: string;
  /** `realpath` da raiz no momento da checagem (para `recheckInside`). */
  realRoot?: string;
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
  async isDirectory(p) {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
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
 *   `create` com pasta que já existe é erro (quem quer abri-la usa `projeto`, sem `create`).
 *
 * Erros saem em português e vão para o usuário no Discord.
 */
export async function resolveWorkspace(cwd: string, create: boolean, policy: WorkspacePolicy): Promise<ResolvedWorkspace> {
  const p = policy.path ?? path;
  const fs = policy.fs ?? nodeFs;
  const roots = policy.devRoots.map((r) => p.resolve(r));
  // `~` e `~/…` (ou `~\…`) digitados no Discord são o home do usuário do agente, como no `install --dev-root`.
  const typed = cwd === "~" ? (policy.home ?? homedir()) : /^~[\\/]/.test(cwd) ? p.join(policy.home ?? homedir(), cwd.slice(2)) : cwd;
  let abs: string;
  if (p.isAbsolute(typed)) abs = p.resolve(typed);
  else {
    const first = roots[0];
    if (first === undefined) {
      const os = isWin(p) ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
      throw new Error(`${noDevRootText(os)} (ou informe um caminho absoluto de um projeto configurado)`);
    }
    abs = p.resolve(first, typed);
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
    if (create) throw new Error(existsText(cwd));
    return { cwd: abs, trustPaths: [], created: false };
  }

  // O ancestral existente precisa ser pasta: `README.md/sub` daria ENOTDIR cru no mkdir (ou no --bg).
  if (!(await fs.isDirectory(existing))) throw new Error(`${existing} não é uma pasta`);
  let created = false;
  if (create && missing.length === 0) throw new Error(existsText(cwd));
  if (missing.length > 0) {
    if (!create) throw new Error(`${NOT_EXISTS_TEXT} (${abs})`);
    for (const seg of missing) {
      if (!SEGMENT_RE.test(seg)) {
        throw new Error(`nome de pasta inválido: "${seg}"; use letras, números, ".", "_" ou "-", começando por letra ou número`);
      }
      if (isWin(p) && (WIN_RESERVED_RE.test(seg) || seg.endsWith("."))) {
        throw new Error(`nome de pasta inválido no Windows: "${seg}" (nome reservado ou terminado em ponto)`);
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
  return { cwd: abs, root, ...(realRoot !== undefined ? { realRoot } : {}), trustPaths, created };
}

/**
 * Confere de novo, imediatamente antes de abrir a sessão, que a pasta ainda está dentro da raiz (alguém com escrita na
 * raiz pode ter trocado a pasta por um symlink depois do `resolveWorkspace`). Sem raiz (projeto explícito) não há o
 * que conferir.
 */
export async function recheckInside(ws: ResolvedWorkspace, opts: { path?: PathApi; fs?: WorkspaceFs } = {}): Promise<void> {
  if (ws.realRoot === undefined) return;
  const p = opts.path ?? path;
  const real = await realOrUndefined(opts.fs ?? nodeFs, ws.cwd);
  if (real === undefined || !isInside(ws.realRoot, real, p)) {
    throw new Error(`a pasta ${ws.cwd} mudou e não está mais dentro da pasta dev ${ws.root ?? ""}; nada foi aberto`);
  }
}
