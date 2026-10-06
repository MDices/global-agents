#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MACHINE_RE } from "@global-agents/protocol";
import { hashToken, MachineExistsError, openDb, relayDbPath, type Db } from "./db.js";
import { ensureCert } from "./tls.js";

const USAGE = `uso: relay <comando>

comandos:
  machine add <hostname/usuario> [--force]
                     registra a máquina e imprime o token (uma única vez); --force troca o token de uma existente
  machine rm <nome>  remove a máquina
  machine list       lista as máquinas (nome, último contato, SO, conta do Claude)
  fingerprint        imprime o fingerprint SHA-256 do certificado (cria o certificado se faltar)
  backup             copia o banco para <DATA_DIR>/backups/<data>.db

ambiente: DATA_DIR (padrão /data)`;

class UsageError extends Error {}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * Registra a máquina e devolve o token em claro (só o hash fica no banco). O nome precisa ser `hostname/usuario`
 * (`MACHINE_RE`). `token` só existe para testes; o padrão são 32 bytes aleatórios em hex.
 */
export function addMachine(db: Db, name: string, opts: { force?: boolean; token?: string } = {}): string {
  if (!MACHINE_RE.test(name)) {
    throw new UsageError(`nome de máquina inválido: "${name}" (use hostname/usuario, minúsculas, ex.: fedora/leonardo)`);
  }
  const token = opts.token ?? randomBytes(32).toString("hex");
  db.machines.upsert({ name, tokenHash: hashToken(token) }, { force: opts.force === true });
  return token;
}

const pad = (n: number): string => String(n).padStart(2, "0");
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function when(ms: number | null): string {
  if (ms === null) return "nunca";
  const d = new Date(ms);
  return `${stamp(d).slice(0, 10)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function withDb<T>(dataDir: string, fn: (db: Db) => T): T {
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(relayDbPath(dataDir));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function machineCmd(args: string[], dataDir: string, io: CliIo): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add": {
      const force = rest.includes("--force");
      const names = rest.filter((a) => a !== "--force");
      const unknown = names.find((a) => a.startsWith("--"));
      if (unknown !== undefined) throw new UsageError(`opção desconhecida: ${unknown}`);
      const [name] = names;
      if (name === undefined || names.length > 1) throw new UsageError("machine add exige exatamente um <hostname/usuario>");
      let token: string;
      try {
        token = withDb(dataDir, (db) => addMachine(db, name, { force }));
      } catch (e) {
        if (e instanceof MachineExistsError) throw new Error(`${e.message} (use --force para gerar um token novo)`);
        throw e;
      }
      io.out(`máquina ${name} registrada. token:`);
      io.out("");
      io.out(token);
      io.out("");
      io.out("guarde agora: o token não será mostrado de novo (o relay guarda só o hash).");
      return 0;
    }
    case "rm": {
      const [name, ...extra] = rest;
      if (name === undefined || extra.length > 0) throw new UsageError("machine rm exige exatamente um <nome>");
      if (!withDb(dataDir, (db) => db.machines.remove(name))) throw new Error(`máquina não encontrada: ${name}`);
      io.out(`máquina ${name} removida.`);
      return 0;
    }
    case "list": {
      if (rest.length > 0) throw new UsageError("machine list não aceita argumentos");
      const rows = withDb(dataDir, (db) => db.machines.list());
      if (rows.length === 0) {
        io.out("nenhuma máquina registrada.");
        return 0;
      }
      const table = [["MÁQUINA", "ÚLTIMO CONTATO", "SO", "CONTA CLAUDE"],
        ...rows.map((m) => [m.name, when(m.lastSeen), m.os ?? "—", m.claudeAccount ?? "—"])];
      const widths = table[0]?.map((_, i) => Math.max(...table.map((r) => (r[i] ?? "").length))) ?? [];
      for (const r of table) io.out(r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
      return 0;
    }
    default:
      throw new UsageError(sub === undefined ? "falta o subcomando de machine" : `subcomando desconhecido: machine ${sub}`);
  }
}

/** Executa a CLI; devolve o código de saída. Erros viram mensagem em `io.err` (nunca com token ou hash). */
export async function runCli(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const dataDir = env["DATA_DIR"]?.trim() || "/data";
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
        io.err(USAGE);
        return 1;
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case "machine":
        return machineCmd(rest, dataDir, io);
      case "fingerprint":
        if (rest.length > 0) throw new UsageError("fingerprint não aceita argumentos");
        io.out(ensureCert(dataDir).fingerprint256);
        return 0;
      case "backup": {
        if (rest.length > 0) throw new UsageError("backup não aceita argumentos");
        const dir = join(dataDir, "backups");
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, `${stamp(new Date())}.db`);
        if (existsSync(dest)) throw new Error(`o backup ${dest} já existe; tente de novo em 1 segundo`);
        withDb(dataDir, (db) => { db.backup(dest); });
        io.out(`backup gravado em ${dest}`);
        return 0;
      }
      default:
        throw new UsageError(`comando desconhecido: ${cmd}`);
    }
  } catch (e) {
    io.err(`erro: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof UsageError) io.err(`\n${USAGE}`);
    return 1;
  }
}

/** Só executa quando chamado como programa (o bin do pnpm é um symlink; os testes importam o módulo). */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const io: CliIo = { out: (l) => { console.log(l); }, err: (l) => { console.error(l); } };
  void runCli(process.argv.slice(2), process.env, io).then((code) => { process.exitCode = code; });
}
