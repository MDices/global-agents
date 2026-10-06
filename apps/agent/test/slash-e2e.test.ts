import { describe, expect, it } from "vitest";
import { runClaude } from "../src/claude/exec.js";
import { Inventory } from "../src/claude/inventory.js";
import { runSlash } from "../src/claude/slash.js";
import { spawnSession } from "../src/claude/spawn.js";
import { stopSession } from "../src/claude/stop.js";

const E2E = process.env["GLOBAL_AGENTS_E2E"] === "1";

describe.skipIf(!E2E)("slash e2e (real)", () => {
  it("/status numa sessão --bg devolve a tela com a versão do Claude Code", async () => {
    const inventory = new Inventory({ pollMs: 1000 });
    inventory.start();
    const root = new URL("../../..", import.meta.url).pathname;
    let bgId: string | undefined;
    try {
      const r = await spawnSession(
        { cwd: root, name: "ga-slash-e2e", prompt: "Responda apenas OK.", permissionMode: "plan" },
        { run: runClaude, inventory },
      );
      bgId = r.bgId;
      const id = bgId;
      await inventory.waitFor((s) => s.bgId === id && s.status === "idle", 90_000);
      const { screen } = await runSlash({ bgId, command: "status" });
      if (process.env["GLOBAL_AGENTS_E2E_PRINT"] === "1") console.log(screen);
      expect(screen).toMatch(/2\.1\.|Status/);
      expect(screen).not.toContain("\x1b");
      // Ctrl+Z desanexou sem parar a sessão: ela continua no inventário.
      await new Promise((r) => setTimeout(r, 2_500)); // deixa o inventário (poll de 1 s) ver o estado pós-Ctrl+Z
      await inventory.waitFor((s) => s.bgId === id, 5_000);
    } finally {
      inventory.stop();
      if (bgId !== undefined) {
        await stopSession(bgId, { run: runClaude });
        await runClaude(["rm", bgId]);
      }
    }
  }, 180_000);
});
