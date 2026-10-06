import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runClaude } from "../src/claude/exec.js";
import { injectPrompt } from "../src/claude/inject.js";
import { parseAgentsJson } from "../src/claude/inventory.js";
import { readRegistry, type SessionRegistry } from "../src/claude/registry.js";

// Só roda com GLOBAL_AGENTS_E2E=1: exige `claude` instalado e logado, e um diretório confiável (a raiz do repo).
const E2E = process.env["GLOBAL_AGENTS_E2E"] === "1";
const NAME = "ga-inject-e2e";

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timeout esperando ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Procura `<sessionId>.jsonl` em qualquer pasta de `~/.claude/projects` (evita depender da codificação do cwd). */
function transcriptPath(sessionId: string): string | undefined {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function assistantSaid(path: string, word: string): boolean {
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l.includes('"assistant"')) continue;
    try {
      const j = JSON.parse(l) as { type?: unknown; message?: { content?: unknown } };
      if (j.type !== "assistant" || !Array.isArray(j.message?.content)) continue;
      for (const c of j.message.content as unknown[]) {
        const t = (c as { type?: unknown; text?: unknown }).text;
        if (typeof t === "string" && t.includes(word)) return true;
      }
    } catch {
      // linha parcial: ainda sendo escrita
    }
  }
  return false;
}

describe.skipIf(!E2E)("e2e: injeção no inbox de uma sessão claude --bg real", () => {
  it("prompt injetado vira turno novo e a sessão responde BRAVO", { timeout: 180_000 }, async () => {
    const cwd = new URL("../../../", import.meta.url).pathname;
    let bgId: string | undefined;
    try {
      const r = await runClaude(["--bg", "--name", NAME, "--permission-mode", "plan", "Responda apenas OK."], { cwd, timeoutMs: 60_000 });
      expect(r.code).toBe(0);
      const pid = await until(async () => {
        const a = await runClaude(["agents", "--json"], { timeoutMs: 15_000 });
        const s = parseAgentsJson(a.stdout).find((x) => x.name === NAME);
        if (s?.bgId !== undefined) bgId = s.bgId;
        return s?.pid;
      }, 60_000, `pid de ${NAME}`);
      const reg: SessionRegistry = await until(() => readRegistry(pid), 30_000, "registro da sessão");
      await injectPrompt(reg, "Responda apenas a palavra BRAVO.", { name: "discord:e2e" });
      await until(() => {
        const p = transcriptPath(reg.sessionId);
        return p !== undefined && assistantSaid(p, "BRAVO") ? true : undefined;
      }, 90_000, "resposta BRAVO no transcript");
    } finally {
      const id = bgId ?? NAME;
      await runClaude(["stop", id], { timeoutMs: 30_000 }).catch(() => undefined);
      await runClaude(["rm", id], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  });
});
