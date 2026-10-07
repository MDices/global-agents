import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@global-agents/protocol";

/** Títulos da sessão gravados no transcript: `custom-title` (do `/rename`) e `ai-title` (o automático do Claude Code). */
export interface SessionTitles {
  customTitle?: string;
  aiTitle?: string;
}

/** Quanto do fim do transcript é lido: transcripts de 100 MB não podem custar caro a cada poll. */
export const TITLE_TAIL_BYTES = 256 * 1024;
/** O Claude Code corta o nome da pasta do projeto neste tamanho e acrescenta um hash que não dá para recalcular. */
const SLUG_MAX = 200;
const CACHE_MAX = 500;

/**
 * Nome da pasta do projeto em `~/.claude/projects`, como o Claude Code monta: todo caractere fora de `[A-Za-z0-9]`
 * vira `-`. Exemplos reais: `/home/leonardo/dev/work/gestai` → `-home-leonardo-dev-work-gestai`,
 * `…/gestai/.claude/worktrees/x` → `…-gestai--claude-worktrees-x` e `C:\DriveD\link-your-biz` →
 * `C--DriveD-link-your-biz` (a letra do drive fica como veio).
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** `session_id` seguro para montar caminho (`<id>.jsonl`): sem `/`, `\\`, `.` nem `..`. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

/** `~/.claude/projects`, ou `<CLAUDE_CONFIG_DIR>/projects`. */
export function defaultProjectsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env["CLAUDE_CONFIG_DIR"];
  return join(dir !== undefined && dir !== "" ? dir : join(home, ".claude"), "projects");
}

/**
 * Caminho do transcript de uma sessão montado a partir do `cwd` (sem o `transcript_path` de um hook). Pasta longa
 * demais (o Claude Code acrescenta um hash): procura a única pasta com o mesmo prefixo; sem ela, `undefined`.
 */
export function transcriptPathFor(cwd: string, sessionId: string, projectsDir: string): string | undefined {
  if (!isSafeSessionId(sessionId)) return undefined;
  const slug = projectSlug(cwd);
  if (slug.length <= SLUG_MAX) return join(projectsDir, slug, `${sessionId}.jsonl`);
  try {
    const prefix = `${slug.slice(0, SLUG_MAX)}-`;
    const hits = readdirSync(projectsDir).filter((d) => d.startsWith(prefix));
    return hits.length === 1 && hits[0] !== undefined ? join(projectsDir, hits[0], `${sessionId}.jsonl`) : undefined;
  } catch {
    return undefined;
  }
}

/** Último `custom-title` e último `ai-title` de um trecho de JSONL. Linha que não é JSON (a primeira, cortada) é ignorada. */
export function parseTitles(text: string): SessionTitles {
  const out: SessionTitles = {};
  for (const line of text.split("\n")) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof j !== "object" || j === null) continue;
    const o = j as Record<string, unknown>;
    const custom = o["customTitle"];
    const ai = o["aiTitle"];
    if (o["type"] === "custom-title" && typeof custom === "string" && custom.trim() !== "") out.customTitle = custom.trim();
    if (o["type"] === "ai-title" && typeof ai === "string" && ai.trim() !== "") out.aiTitle = ai.trim();
  }
  return out;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  titles: SessionTitles;
}

/**
 * Lê os títulos do fim do transcript (`TITLE_TAIL_BYTES`), com cache LRU por caminho: enquanto `size` e `mtime` não mudam,
 * não relê (o poll do inventário roda a cada 5 s). Título fora do trecho lido não é achado; tudo bem. Erro de leitura
 * (arquivo inexistente, sem permissão) devolve `{}` e nunca lança.
 */
export class TitleReader {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly tailBytes = TITLE_TAIL_BYTES) {}

  read(path: string): SessionTitles {
    let fd: number | undefined;
    try {
      const st = statSync(path);
      const hit = this.cache.get(path);
      if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        lruSet(this.cache, path, hit); // LRU: o acerto renova a posição
        return hit.titles;
      }
      fd = openSync(path, "r");
      const size = fstatSync(fd).size;
      const len = Math.min(size, this.tailBytes);
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, size - len + got);
        if (n === 0) break;
        got += n;
      }
      const titles = parseTitles(buf.subarray(0, got).toString("utf8"));
      lruSet(this.cache, path, { size: st.size, mtimeMs: st.mtimeMs, titles });
      return titles;
    } catch {
      return {};
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

export interface SessionNamerOptions {
  readTitles?: (path: string) => SessionTitles;
  projectsDir?: string;
  /** Relógio (testes). */
  now?: () => number;
}

/**
 * Nome automático que o Claude Code dá a sessões interativas sem nome: `<pasta>-<2 hex>` (`gestai-8d`,
 * `global-agents-23`; `nameSource: "derived"` em `~/.claude/sessions/<pid>.json`). Os 2 caracteres **não** são o
 * início do `sessionId` (`gestai-8d` é a sessão `872c5919…`, `gestai-e9` é a `e0e30914…`). O formato é conferido de
 * forma genérica, `^.+-[0-9a-f]{2}$`, sem comparar com a pasta do `cwd`: o `cwd` do inventário pode não ser a pasta
 * de onde o nome foi derivado, e um falso negativo traria de volta o nome opaco. Custo aceito: um `/rename` nesse
 * formato (`app-v2` não, `app-b2` sim) é tratado como automático e perde para o `ai-title`, mas só quando o
 * `custom-title` saiu dos 256 KB lidos.
 */
export function isAutoName(name: string): boolean {
  return /^.+-[0-9a-f]{2}$/.test(name);
}


/** Quanto esperar para procurar de novo o transcript de uma sessão que ainda não tem (ex.: aberta e nunca usada). */
const LOCATE_RETRY_MS = 60_000;

/**
 * Nome da sessão mandado ao relay, por prioridade:
 * 1. último `custom-title` do transcript (`/rename`);
 * 2. `name` do inventário (`claude agents --json`) quando **não** é o automático (ele já reflete o `/rename`, mesmo
 *    que o `custom-title` tenha saído dos últimos 256 KB lidos);
 * 3. último `ai-title` (título automático);
 * 4. `name` automático do inventário (`gestai-8d`).
 * Sem nenhum, `undefined`: o `session.list` mantém o nome cru do inventário e o hook omite o nome (o relay mantém o
 * que já conhece; para sessão desconhecida usa a pasta).
 *
 * O transcript é o do `transcript_path` do último hook da sessão; senão o do slug do `cwd`; senão (o `cwd` do
 * inventário pode não ser a pasta onde o transcript nasceu, e depois de um restart o agente ainda não viu hook)
 * procura `<sessionId>.jsonl` nas pastas de `~/.claude/projects`, no máximo 1×/min por sessão.
 */
export class SessionNamer {
  private readonly readTitles: (path: string) => SessionTitles;
  private readonly projectsDir: string;
  private readonly now: () => number;
  private readonly transcripts = new Map<string, string>();
  /** Nome e `cwd` crus do inventário, do último `enrich` (o inventário guarda a lista já enriquecida). */
  private readonly raw = new Map<string, { name: string; cwd: string }>();
  private readonly notFoundAt = new Map<string, number>();

  constructor(opts: SessionNamerOptions = {}) {
    const reader = new TitleReader();
    this.readTitles = opts.readTitles ?? ((p) => reader.read(p));
    this.projectsDir = opts.projectsDir ?? defaultProjectsDir();
    this.now = opts.now ?? Date.now;
  }

  /** Guarda o `transcript_path` vindo de um hook, para o `session.list` ler o mesmo arquivo. */
  remember(sessionId: string, transcriptPath: string): void {
    this.notFoundAt.delete(sessionId);
    if (this.transcripts.get(sessionId) === transcriptPath) return;
    lruSet(this.transcripts, sessionId, transcriptPath);
  }

  private locate(sessionId: string, cwd: string): string | undefined {
    const known = this.transcripts.get(sessionId);
    if (known !== undefined) return known;
    if (!isSafeSessionId(sessionId)) return undefined;
    const bySlug = transcriptPathFor(cwd, sessionId, this.projectsDir);
    if (bySlug !== undefined && existsSync(bySlug)) return bySlug;
    const last = this.notFoundAt.get(sessionId);
    if (last !== undefined && this.now() - last < LOCATE_RETRY_MS) return undefined;
    try {
      for (const d of readdirSync(this.projectsDir)) {
        const p = join(this.projectsDir, d, `${sessionId}.jsonl`);
        if (existsSync(p)) {
          this.remember(sessionId, p);
          return p;
        }
      }
    } catch {
      // sem pasta de projetos: cai no inventário
    }
    lruSet(this.notFoundAt, sessionId, this.now());
    return undefined;
  }

  private titles(sessionId: string, cwd: string, transcriptPath?: string): SessionTitles {
    const path = transcriptPath ?? this.locate(sessionId, cwd);
    return path === undefined ? {} : this.readTitles(path);
  }

  private pick(t: SessionTitles, inv: { name: string; cwd: string } | undefined): string | undefined {
    if (t.customTitle !== undefined) return t.customTitle;
    const name = inv?.name;
    if (name !== undefined && name !== "" && inv !== undefined && !isAutoName(name)) return name;
    if (t.aiTitle !== undefined) return t.aiTitle;
    return name !== undefined && name !== "" ? name : undefined;
  }

  /**
   * Nome para um hook. `inventoryName` (do inventário, já enriquecido) só vale se o `enrich` ainda não viu a sessão;
   * senão vale o nome cru guardado por ele.
   */
  name(sessionId: string, cwd: string, inventoryName: string | undefined, transcriptPath?: string): string | undefined {
    const inv = this.raw.get(sessionId) ?? (inventoryName !== undefined ? { name: inventoryName, cwd } : undefined);
    return this.pick(this.titles(sessionId, cwd, transcriptPath), inv);
  }

  /** Aplica a prioridade sobre a lista do inventário (guarda o nome cru de cada sessão). */
  enrich(list: SessionInfo[]): SessionInfo[] {
    return list.map((s) => {
      lruSet(this.raw, s.sessionId, { name: s.name, cwd: s.cwd });
      const n = this.pick(this.titles(s.sessionId, s.cwd), { name: s.name, cwd: s.cwd });
      return n === undefined || n === s.name ? s : { ...s, name: n };
    });
  }
}

/** `set` que move a chave para o fim (mais recente) e descarta a mais antiga além de `CACHE_MAX`. */
function lruSet<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > CACHE_MAX) m.delete(m.keys().next().value as K);
}
