import { describe, expect, it } from "vitest";
import { runClaude } from "../src/claude/exec.js";
import { Inventory } from "../src/claude/inventory.js";
import { spawnSession } from "../src/claude/spawn.js";
import { stopSession } from "../src/claude/stop.js";

const E2E = process.env["GLOBAL_AGENTS_E2E"] === "1";

describe.skipIf(!E2E)("spawn e2e (real)", () => {
  it("cria, para e remove uma sessão --bg", async () => {
    const inventory = new Inventory({ pollMs: 1000 });
    inventory.start();
    const root = new URL("../../..", import.meta.url).pathname;
    let bgId: string | undefined;
    try {
      const r = await spawnSession(
        { cwd: root, name: "ga-spawn-e2e", prompt: "Responda apenas OK.", permissionMode: "plan" },
        { run: runClaude, inventory },
      );
      bgId = r.bgId;
      const sessionId = r.sessionId;
      expect(bgId).toMatch(/^[0-9a-f]{8}$/);
      expect(sessionId.startsWith(bgId)).toBe(true);
    } finally {
      inventory.stop();
      if (bgId !== undefined) {
        await stopSession(bgId, { run: runClaude });
        await runClaude(["rm", bgId]);
      }
    }
  }, 120000);
});
