import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runClaude } from "../src/claude/exec.js";
import { injectPrompt } from "../src/claude/inject.js";
import { parseAgentsJson } from "../src/claude/inventory.js";
import { readRegistry, type SessionRegistry } from "../src/claude/registry.js";
import { assistantSaid, transcriptPath, until } from "./helpers/transcript.js";

// Só roda no Windows com GLOBAL_AGENTS_E2E=1: reproduz o spike de 2026-10-06 (named pipe + linha de auth com peerToken).
const RUN = process.platform === "win32" && process.env["GLOBAL_AGENTS_E2E"] === "1";
const NAME = "ga-win-e2e";

describe.skipIf(!RUN)("e2e Windows: injeção no named pipe de uma sessão claude --bg real", () => {
  it("prompt injetado (com auth peerToken) vira turno novo e a sessão responde BRAVO", { timeout: 240_000 }, async () => {
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
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
      expect(reg.messagingSocketPath).toMatch(/^\\\\[.?]\\pipe\\/);
      await injectPrompt(reg, "Responda apenas a palavra BRAVO.", { name: "discord:e2e" });
      await until(() => {
        const p = transcriptPath(reg.sessionId);
        return p !== undefined && assistantSaid(p, "BRAVO") ? true : undefined;
      }, 120_000, "resposta BRAVO no transcript");
    } finally {
      const id = bgId ?? NAME;
      await runClaude(["stop", id], { timeoutMs: 30_000 }).catch(() => undefined);
      await runClaude(["rm", id], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  });
});
