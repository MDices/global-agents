import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
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
 * Lê os títulos do fim do transcript (`TITLE_TAIL_BYTES`), com cache por caminho: enquanto `size` e `mtime` não mudam,
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
      if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.titles;
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
      this.cache.delete(path);
      this.cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, titles });
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
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
}

/**
 * Nome da sessão mandado ao relay, por prioridade: 1. último `custom-title` (`/rename`); 2. último `ai-title`; 3. o
 * `name` do inventário (`claude agents --json`). Sem nenhum dos três, `undefined`: quem chama decide o fallback (o
 * `session.list` mantém o nome cru do inventário; o hook omite o nome, e o relay mantém o que já conhece).
 *
 * O transcript é o do `transcript_path` do último hook da sessão, quando houve; senão, o montado com o slug do `cwd`.
 */
export class SessionNamer {
  private readonly readTitles: (path: string) => SessionTitles;
  private readonly projectsDir: string;
  private readonly transcripts = new Map<string, string>();

  constructor(opts: SessionNamerOptions = {}) {
    const reader = new TitleReader();
    this.readTitles = opts.readTitles ?? ((p) => reader.read(p));
    this.projectsDir = opts.projectsDir ?? defaultProjectsDir();
  }

  /** Guarda o `transcript_path` vindo de um hook, para o `session.list` ler o mesmo arquivo. */
  remember(sessionId: string, transcriptPath: string): void {
    if (this.transcripts.get(sessionId) === transcriptPath) return;
    this.transcripts.delete(sessionId);
    this.transcripts.set(sessionId, transcriptPath);
    if (this.transcripts.size > CACHE_MAX) this.transcripts.delete(this.transcripts.keys().next().value as string);
  }

  /** Níveis 1 e 2 (títulos do transcript). */
  title(sessionId: string, cwd: string, transcriptPath?: string): string | undefined {
    const path = transcriptPath ?? this.transcripts.get(sessionId) ?? transcriptPathFor(cwd, sessionId, this.projectsDir);
    if (path === undefined) return undefined;
    const t = this.readTitles(path);
    return t.customTitle ?? t.aiTitle;
  }

  /** Níveis 1 a 3; `undefined` quando só restaria o nome da pasta. */
  name(sessionId: string, cwd: string, inventoryName: string | undefined, transcriptPath?: string): string | undefined {
    const t = this.title(sessionId, cwd, transcriptPath);
    if (t !== undefined) return t;
    return inventoryName !== undefined && inventoryName !== "" ? inventoryName : undefined;
  }

  /** Aplica os níveis 1 e 2 sobre a lista do inventário (o `name` cru dele é o nível 3). */
  enrich(list: SessionInfo[]): SessionInfo[] {
    return list.map((s) => {
      const t = this.title(s.sessionId, s.cwd);
      return t === undefined || t === s.name ? s : { ...s, name: t };
    });
  }
}
