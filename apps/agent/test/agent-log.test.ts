import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_LOG, AGENT_LOG_MAX, appendAgentLog, lastErrorLine } from "../src/agent-log.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ga-log-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("agent.log", () => {
  it("grava linhas com data/hora e nível; quebras viram ' | '", () => {
    const d = tmp();
    appendAgentLog(d, "info", "agente iniciado (versão 1.0.0, PID 7)", new Date("2026-10-07T12:00:00Z"));
    appendAgentLog(d, "erro", "a porta 48476\nem uso", new Date("2026-10-07T12:00:01Z"));
    expect(readFileSync(join(d, AGENT_LOG), "utf8")).toBe(
      "2026-10-07T12:00:00.000Z [info] agente iniciado (versão 1.0.0, PID 7)\n2026-10-07T12:00:01.000Z [erro] a porta 48476 | em uso\n",
    );
  });
  it("cria o diretório se não existir e nunca lança", () => {
    const d = join(tmp(), "novo", "sub");
    appendAgentLog(d, "erro", "x");
    expect(existsSync(join(d, AGENT_LOG))).toBe(true);
    expect(() => appendAgentLog(join(d, AGENT_LOG, "impossivel"), "erro", "x")).not.toThrow();
  });
  it("passou de 256 KB: renomeia para agent.log.1 (sobrescrevendo) e recomeça", () => {
    const d = tmp();
    writeFileSync(join(d, `${AGENT_LOG}.1`), "velho\n");
    writeFileSync(join(d, AGENT_LOG), "x".repeat(AGENT_LOG_MAX + 1));
    appendAgentLog(d, "erro", "novo");
    expect(statSync(join(d, `${AGENT_LOG}.1`)).size).toBe(AGENT_LOG_MAX + 1);
    expect(readFileSync(join(d, AGENT_LOG), "utf8")).toMatch(/^\S+ \[erro\] novo\n$/);
  });
  it("lastErrorLine devolve a última linha [erro] (ignora info) ou undefined", () => {
    const d = tmp();
    expect(lastErrorLine(d)).toBeUndefined();
    appendAgentLog(d, "erro", "primeiro");
    appendAgentLog(d, "erro", "segundo");
    appendAgentLog(d, "info", "iniciado");
    expect(lastErrorLine(d)).toMatch(/\[erro\] segundo$/);
  });
});
