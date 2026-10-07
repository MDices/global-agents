import { appendFileSync, existsSync, readFileSync, renameSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Arquivo de log do agente em `<dataDir>`: no Windows a tarefa é headless e stdout/stderr vão para o vazio. */
export const AGENT_LOG = "agent.log";
export const AGENT_LOG_MAX = 256 * 1024;

/**
 * Acrescenta uma linha `<data ISO> [nível] mensagem` (quebras de linha viram ` | `). Passou de 256 KB: renomeia para
 * `agent.log.1` (sobrescrevendo) e recomeça. Nunca lança: log falho não derruba o agente.
 */
export function appendAgentLog(dataDir: string, level: "info" | "erro", message: string, now: Date = new Date()): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, AGENT_LOG);
    if (existsSync(file) && statSync(file).size > AGENT_LOG_MAX) renameSync(file, `${file}.1`);
    appendFileSync(file, `${now.toISOString()} [${level}] ${message.replace(/\r?\n/g, " | ")}\n`);
  } catch {
    // sem log: o erro continua indo para o stderr
  }
}

/** Última linha `[erro]` do `agent.log`, ou `undefined`. */
export function lastErrorLine(dataDir: string): string | undefined {
  try {
    const lines = readFileSync(join(dataDir, AGENT_LOG), "utf8").split("\n");
    return lines.reverse().find((l) => l.includes(" [erro] "));
  } catch {
    return undefined;
  }
}
