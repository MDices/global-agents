import { describe, expect, it } from "vitest";
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
});
