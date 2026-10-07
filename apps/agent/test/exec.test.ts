import { afterEach, describe, expect, it } from "vitest";
import { cleanEnv, runClaude } from "../src/claude/exec.js";

describe("exec", () => {
  it("cleanEnv remove variáveis do Claude Code", () => {
    expect(cleanEnv({ PATH: "/bin", CLAUDE_CODE_SESSION_ID: "x", CLAUDECODE: "1", HOME: "/h" })).toEqual({ PATH: "/bin", HOME: "/h" });
  });
  it("runClaude captura stdout", async () => {
    const r = await runClaude(["-c", "echo '{\"ok\":true}'"], { claudeBin: "sh" });
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { ok: boolean }).ok).toBe(true);
  });
  describe("env e timeout", () => {
    const saved = { a: process.env["CLAUDECODE"], b: process.env["CLAUDE_CODE_SESSION_ID"] };
    afterEach(() => {
      for (const [k, v] of [["CLAUDECODE", saved.a], ["CLAUDE_CODE_SESSION_ID", saved.b]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    it("env limpo chega ao filho", async () => {
      process.env["CLAUDECODE"] = "1";
      process.env["CLAUDE_CODE_SESSION_ID"] = "abc";
      const r = await runClaude(["-c", 'echo "$CLAUDECODE|$CLAUDE_CODE_SESSION_ID"'], { claudeBin: "sh" });
      expect(r.stdout).toBe("|\n");
    });
    it("rejeita no timeout nomeando o subcomando", async () => {
      await expect(runClaude(["-c", "sleep 5"], { claudeBin: "sh", timeoutMs: 100 })).rejects.toThrow(/excedeu/);
    });
  });
});
