import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Convenção: campos opcionais/ausentes no banco são devolvidos como `T | null`
 * (nunca `undefined`); entradas opcionais usam `?:` e são gravadas como NULL.
 * Timestamps são INTEGER em milissegundos.
 */

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class MachineExistsError extends Error {
  constructor(public readonly machine: string) {
    super(`Máquina já registrada com outro token: ${machine}`);
    this.name = "MachineExistsError";
  }
}

/** O hash do token já pertence a outra máquina (o SQLite recusaria com UNIQUE em `machines.token_hash`). */
export class TokenInUseError extends Error {
  constructor(public readonly machine: string) {
    super(`Este token já pertence a outra máquina; gere outro token para ${machine}`);
    this.name = "TokenInUseError";
  }
}

/** Arquivo do banco do relay dentro do `DATA_DIR`. */
export function relayDbPath(dataDir: string): string {
  return join(dataDir, "relay.db");
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const isTokenHashConflict = (e: unknown): boolean =>
  (e as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_UNIQUE && /machines\.token_hash/.test((e as Error).message);

export interface Machine {
  name: string;
  tokenHash: string;
  channelId: string | null;
  lastSeen: number | null;
  os: string | null;
  claudeVersion: string | null;
  claudeAccount: string | null;
  filterAccount: string | null;
  /** Raízes dev do último `agent.hello`/`agent.projects`; `null` = agente anterior às raízes dev (ou nunca visto). */
  devRoots: string[] | null;
}
export interface MachineMeta {
  os?: string;
  claudeVersion?: string;
  claudeAccount?: string;
}
export interface Session {
  sessionId: string;
  machine: string;
  name: string | null;
  cwd: string | null;
  threadId: string | null;
  bgId: string | null;
  /** Mensagem do cabeçalho da thread (o embed da 1ª mensagem), para editá-la depois. */
  headerMessageId: string | null;
  state: string;
  updatedAt: number;
}
export interface SessionInput {
  sessionId: string;
  machine: string;
  name?: string;
  cwd?: string;
  threadId?: string;
  bgId?: string;
  state: string;
  updatedAt: number;
}
export interface Permission {
  requestId: string;
  sessionId: string;
  messageId: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: number | null;
}
export interface PendingCommand {
  commandId: string;
  machine: string;
  payload: string;
  createdAt: number;
  expiresAt: number;
  discordMessageId: string | null;
}

type Row = Record<string, SQLInputValue | null>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toMachine(r: Row): Machine {
  return {
    name: String(r["name"]),
    tokenHash: String(r["token_hash"]),
    channelId: str(r["channel_id"]),
    lastSeen: num(r["last_seen"]),
    os: str(r["os"]),
    claudeVersion: str(r["claude_version"]),
    claudeAccount: str(r["claude_account"]),
    filterAccount: str(r["filter_account"]),
    devRoots: parseRoots(r["dev_roots"]),
  };
}

/** Coluna JSON `dev_roots`; valor ilegível conta como ausente (modo antigo, o mais restritivo). */
function parseRoots(v: unknown): string[] | null {
  if (typeof v !== "string") return null;
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) && a.every((x) => typeof x === "string") ? a : null;
  } catch {
    return null;
  }
}
function toSession(r: Row): Session {
  return {
    sessionId: String(r["session_id"]),
    machine: String(r["machine"]),
    name: str(r["name"]),
    cwd: str(r["cwd"]),
    threadId: str(r["thread_id"]),
    bgId: str(r["bg_id"]),
    headerMessageId: str(r["header_message_id"]),
    state: String(r["state"]),
    updatedAt: Number(r["updated_at"]),
  };
}
function toPermission(r: Row): Permission {
  return {
    requestId: String(r["request_id"]),
    sessionId: String(r["session_id"]),
    messageId: str(r["message_id"]),
    status: String(r["status"]),
    decidedBy: str(r["decided_by"]),
    decidedAt: num(r["decided_at"]),
  };
}
function toCommand(r: Row): PendingCommand {
  return {
    commandId: String(r["command_id"]),
    machine: String(r["machine"]),
    payload: String(r["payload"]),
    createdAt: Number(r["created_at"]),
    expiresAt: Number(r["expires_at"]),
    discordMessageId: str(r["discord_message_id"]),
  };
}

/** Uma entrada por versão do esquema; nunca edite uma já publicada, acrescente outra. Exportado para os testes. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE machines (
     name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, channel_id TEXT, last_seen INTEGER,
     os TEXT, claude_version TEXT, claude_account TEXT, filter_account TEXT
   );
   CREATE TABLE sessions (
     session_id TEXT PRIMARY KEY, machine TEXT NOT NULL, name TEXT, cwd TEXT, thread_id TEXT,
     bg_id TEXT, state TEXT NOT NULL, updated_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_machine_updated ON sessions(machine, updated_at DESC);
   CREATE TABLE permissions (
     request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT,
     status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at INTEGER
   );
   CREATE TABLE pending_commands (
     command_id TEXT PRIMARY KEY, machine TEXT NOT NULL, payload TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, discord_message_id TEXT
   );
   CREATE INDEX pending_commands_machine ON pending_commands(machine, created_at);`,
  // 2: raízes dev por máquina (JSON), para o /novo saber, mesmo logo após um restart do relay, que o agente é novo
  `ALTER TABLE machines ADD COLUMN dev_roots TEXT;`,
  // 3: mensagem do cabeçalho da thread, para editá-lo quando chegam `bgId`/nome/pasta depois da criação
  `ALTER TABLE sessions ADD COLUMN header_message_id TEXT;`,
];

export interface Db {
  migrate(): void;
  close(): void;
  /** Cópia consistente do banco em `dest` (`VACUUM INTO`); o arquivo não pode existir. */
  backup(dest: string): void;
  machines: {
    /** Lança `MachineExistsError` (nome com outro token, sem `force`) ou `TokenInUseError` (hash de outra máquina). */
    upsert(m: { name: string; tokenHash: string }, opts?: { force?: boolean }): void;
    /** Apaga a máquina; `false` se não existia. */
    remove(name: string): boolean;
    getByName(name: string): Machine | undefined;
    getByTokenHash(tokenHash: string): Machine | undefined;
    /** Máquina cujo canal do Discord é `channelId`. */
    getByChannel(channelId: string): Machine | undefined;
    setChannel(name: string, channelId: string): void;
    /** Grava as raízes dev (`null` = agente antigo, sem raízes dev). */
    setDevRoots(name: string, devRoots: readonly string[] | null): void;
    /** Liga (`account`) ou desliga (`null`) o filtro de conta do canal da máquina. */
    setFilterAccount(name: string, account: string | null): void;
    touch(name: string, lastSeen: number, meta?: MachineMeta): void;
    list(): Machine[];
  };
  sessions: {
    /** Insere ou atualiza; a máquina de uma sessão existente nunca muda (um agente não toma a sessão de outro). */
    upsert(s: SessionInput): void;
    get(sessionId: string): Session | undefined;
    /** Sessão ligada à thread do Discord (a mais recente, se houver mais de uma). */
    getByThread(threadId: string): Session | undefined;
    setThread(sessionId: string, threadId: string): void;
    setHeaderMessage(sessionId: string, messageId: string): void;
    setState(sessionId: string, state: string, updatedAt: number): void;
    listByMachine(machine: string): Session[];
  };
  permissions: {
    create(p: { requestId: string; sessionId: string; messageId?: string }): void;
    get(requestId: string): Permission | undefined;
    /** Resolve só se ainda `pending`; devolve false se já decidida/inexistente. */
    resolve(requestId: string, status: string, decidedBy: string, decidedAt: number): boolean;
  };
  pendingCommands: {
    add(c: { commandId: string; machine: string; payload: string; createdAt: number; expiresAt: number; discordMessageId?: string }): void;
    /** Comandos ainda válidos da máquina (`expires_at >= now`), em ordem de chegada. */
    listDue(machine: string, now?: number): PendingCommand[];
    remove(commandId: string): void;
    expireBefore(ts: number): PendingCommand[];
  };
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  // busy_timeout primeiro: o relay no ar e a CLI (`docker compose exec … machine add`) escrevem no mesmo arquivo;
  // sem ele a segunda escrita falha na hora com "database is locked" em vez de esperar até 5 s pelo lock.
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const get = (sql: string, ...p: SQLInputValue[]): Row | undefined =>
    db.prepare(sql).get(...p) as Row | undefined;
  const all = (sql: string, ...p: SQLInputValue[]): Row[] => db.prepare(sql).all(...p) as Row[];
  const run = (sql: string, ...p: SQLInputValue[]): number =>
    Number(db.prepare(sql).run(...p).changes);

  function migrate(): void {
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = get("SELECT MAX(version) AS v FROM schema_version");
    const current = row?.["v"] === null || row?.["v"] === undefined ? 0 : Number(row["v"]);
    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v];
      if (sql === undefined) continue;
      db.exec("BEGIN");
      try {
        db.exec(sql);
        run("INSERT INTO schema_version (version) VALUES (?)", v + 1);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }
  migrate();

  const byName = (name: string): Machine | undefined => {
    const r = get("SELECT * FROM machines WHERE name = ?", name);
    return r && toMachine(r);
  };

  return {
    migrate,
    close: () => db.close(),
    backup(dest) {
      db.prepare("VACUUM INTO ?").run(dest);
    },
    machines: {
      upsert({ name, tokenHash }, opts) {
        const existing = byName(name);
        try {
          if (!existing) {
            run("INSERT INTO machines (name, token_hash) VALUES (?, ?)", name, tokenHash);
          } else if (existing.tokenHash !== tokenHash) {
            if (opts?.force !== true) throw new MachineExistsError(name);
            run("UPDATE machines SET token_hash = ? WHERE name = ?", tokenHash, name);
          }
        } catch (e) {
          if (isTokenHashConflict(e)) throw new TokenInUseError(name);
          throw e;
        }
      },
      remove: (name) => run("DELETE FROM machines WHERE name = ?", name) > 0,
      getByName: byName,
      getByTokenHash(tokenHash) {
        const r = get("SELECT * FROM machines WHERE token_hash = ?", tokenHash);
        return r && toMachine(r);
      },
      getByChannel(channelId) {
        const r = get("SELECT * FROM machines WHERE channel_id = ?", channelId);
        return r && toMachine(r);
      },
      setChannel(name, channelId) {
        run("UPDATE machines SET channel_id = ? WHERE name = ?", channelId, name);
      },
      setDevRoots(name, devRoots) {
        run("UPDATE machines SET dev_roots = ? WHERE name = ?", devRoots === null ? null : JSON.stringify(devRoots), name);
      },
      setFilterAccount(name, account) {
        run("UPDATE machines SET filter_account = ? WHERE name = ?", account, name);
      },
      touch(name, lastSeen, meta) {
        run(
          `UPDATE machines SET last_seen = ?, os = COALESCE(?, os),
             claude_version = COALESCE(?, claude_version), claude_account = COALESCE(?, claude_account)
           WHERE name = ?`,
          lastSeen, meta?.os ?? null, meta?.claudeVersion ?? null, meta?.claudeAccount ?? null, name,
        );
      },
      list: () => all("SELECT * FROM machines ORDER BY name").map(toMachine),
    },
    sessions: {
      upsert(s) {
        run(
          `INSERT INTO sessions (session_id, machine, name, cwd, thread_id, bg_id, state, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             name = COALESCE(excluded.name, name), cwd = COALESCE(excluded.cwd, cwd),
             thread_id = COALESCE(excluded.thread_id, thread_id), bg_id = COALESCE(excluded.bg_id, bg_id),
             state = excluded.state, updated_at = excluded.updated_at`,
          s.sessionId, s.machine, s.name ?? null, s.cwd ?? null, s.threadId ?? null, s.bgId ?? null, s.state, s.updatedAt,
        );
      },
      get(sessionId) {
        const r = get("SELECT * FROM sessions WHERE session_id = ?", sessionId);
        return r && toSession(r);
      },
      getByThread(threadId) {
        const r = get("SELECT * FROM sessions WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1", threadId);
        return r && toSession(r);
      },
      setThread(sessionId, threadId) {
        run("UPDATE sessions SET thread_id = ? WHERE session_id = ?", threadId, sessionId);
      },
      setHeaderMessage(sessionId, messageId) {
        run("UPDATE sessions SET header_message_id = ? WHERE session_id = ?", messageId, sessionId);
      },
      setState(sessionId, state, updatedAt) {
        run("UPDATE sessions SET state = ?, updated_at = ? WHERE session_id = ?", state, updatedAt, sessionId);
      },
      listByMachine: (machine) =>
        all("SELECT * FROM sessions WHERE machine = ? ORDER BY updated_at DESC", machine).map(toSession),
    },
    permissions: {
      create(p) {
        run("INSERT INTO permissions (request_id, session_id, message_id) VALUES (?, ?, ?)", p.requestId, p.sessionId, p.messageId ?? null);
      },
      get(requestId) {
        const r = get("SELECT * FROM permissions WHERE request_id = ?", requestId);
        return r && toPermission(r);
      },
      resolve: (requestId, status, decidedBy, decidedAt) =>
        run(
          "UPDATE permissions SET status = ?, decided_by = ?, decided_at = ? WHERE request_id = ? AND status = 'pending'",
          status, decidedBy, decidedAt, requestId,
        ) > 0,
    },
    pendingCommands: {
      add(c) {
        run(
          "INSERT INTO pending_commands (command_id, machine, payload, created_at, expires_at, discord_message_id) VALUES (?, ?, ?, ?, ?, ?)",
          c.commandId, c.machine, c.payload, c.createdAt, c.expiresAt, c.discordMessageId ?? null,
        );
      },
      // Complemento exato de `expireBefore` (`<`): nenhuma linha é ao mesmo tempo devida e expirada.
      listDue: (machine, now = Date.now()) =>
        all(
          "SELECT * FROM pending_commands WHERE machine = ? AND expires_at >= ? ORDER BY created_at, rowid", machine, now,
        ).map(toCommand),
      remove(commandId) {
        run("DELETE FROM pending_commands WHERE command_id = ?", commandId);
      },
      expireBefore(ts) {
        const rows = all("SELECT * FROM pending_commands WHERE expires_at < ? ORDER BY created_at, rowid", ts).map(toCommand);
        run("DELETE FROM pending_commands WHERE expires_at < ?", ts);
        return rows;
      },
    },
  };
}
