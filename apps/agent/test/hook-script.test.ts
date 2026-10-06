import { spawn } from "node:child_process";
import { join } from "node:path";
import type { AgentEvent } from "@global-agents/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHookServer } from "../src/hooks/server.js";

const script = join(import.meta.dirname, "..", "src", "hooks", "scripts", "global-agents-hook.sh");
const payload = JSON.stringify({ session_id: "s1", transcript_path: "/t", cwd: "/home/x/proj", hook_event_name: "UserPromptSubmit", permission_mode: "default", prompt: "oi" });
const permPayload = JSON.stringify({ session_id: "s1", transcript_path: "/t", cwd: "/home/x/proj", hook_event_name: "PermissionRequest", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tu1" });

function runScript(port: number, stdin: string): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("bash", [script], { env: { ...process.env, GLOBAL_AGENTS_PORT: String(port) } });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    child.stdin.end(stdin);
  });
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

describe.skipIf(process.platform !== "linux")("global-agents-hook.sh", () => {
  it("encaminha o payload ao servidor e sai 0", async () => {
    const onEvents = vi.fn<(evs: AgentEvent[]) => void>();
    const srv = await startHookServer({ port: 0, machine: "fedora/leonardo", lookupName: () => undefined, onEvents });
    close = srv.close;
    const r = await runScript(srv.port, payload);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(onEvents).toHaveBeenCalledTimes(1);
  });

  it("PermissionRequest imprime a decisão no stdout", async () => {
    const srv = await startHookServer({
      port: 0, machine: "fedora/leonardo", lookupName: () => undefined, onEvents: () => {},
      onPermission: (_p, respond) => setTimeout(() => respond({ behavior: "deny" }), 2500),
    });
    close = srv.close;
    const r = await runScript(srv.port, permPayload);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } });
  }, 10_000);

  it("nada ouvindo → ainda sai 0 em menos de 3 s", async () => {
    const r = await runScript(1, payload);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ms).toBeLessThan(3000);
  });
});
