import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { newEnvelope, type AgentEvent, type RelayCommand } from "@global-agents/protocol";
import { describe, expect, it, vi } from "vitest";
import { runClaude } from "../src/claude/exec.js";
import { Inventory } from "../src/claude/inventory.js";
import { stopSession } from "../src/claude/stop.js";
import { startHookServer, type HookServerOptions } from "../src/hooks/server.js";
import { createAgent, type RelayClientLike } from "../src/main.js";
import type { RelayClientEvents } from "../src/transport/client.js";

const E2E = process.env["GLOBAL_AGENTS_E2E"] === "1";

class FakeClient extends EventEmitter<RelayClientEvents> implements RelayClientLike {
  sent: AgentEvent[] = [];
  start(): void {}
  stop(): void {}
  send(ev: AgentEvent): void { this.sent.push(ev); }
}

/** Resultado (texto) de cada `tool_result` do transcript da sessão. */
function toolResults(sessionId: string): string[] {
  const projects = join(homedir(), ".claude", "projects");
  const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
  if (dir === undefined) return [];
  const out: string[] = [];
  for (const line of readFileSync(join(projects, dir, `${sessionId}.jsonl`), "utf8").split("\n")) {
    if (line === "") continue;
    const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as { type?: string; content?: unknown }[]) {
      if (c.type !== "tool_result") continue;
      out.push(typeof c.content === "string" ? c.content : JSON.stringify(c.content));
    }
  }
  return out;
}

describe.skipIf(!E2E)("permissões e2e (real)", () => {
  it("PermissionRequest de uma sessão --bg é segurado, permission.decide(allow) libera e a ferramenta roda", async () => {
    const root = new URL("../../..", import.meta.url).pathname;
    const script = new URL("../src/hooks/scripts/global-agents-hook.sh", import.meta.url).pathname;
    const dataDir = mkdtempSync(join(tmpdir(), "agent-perm-e2e-"));
    const inventory = new Inventory({ pollMs: 1000 });
    let client: FakeClient | undefined;
    let port = 0;
    const agent = createAgent(
      { relayUrl: "ws://127.0.0.1:1/ws", token: "x", machineName: "e2e", projects: [root], devRoots: [], port: 0, claudeBin: "claude", dataDir },
      {
        inventory,
        client: () => (client = new FakeClient()),
        hookServer: async (o: HookServerOptions) => { const s = await startHookServer(o); port = s.port; return s; },
      },
    );
    await agent.start();
    const c = client;
    if (c === undefined) throw new Error("cliente não criado");
    const settings = JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: `GLOBAL_AGENTS_PORT=${port} bash ${script}`, timeout: 1800 }] }] },
    });
    let bgId: string | undefined;
    try {
      const r = await runClaude(
        ["--bg", "--name", "ga-perm-e2e", "--permission-mode", "default", "--settings", settings, "--",
          "Rode exatamente este comando com a ferramenta Bash e responda só com a saída: curl -s -o /dev/null -w '%{http_code}' https://example.com"],
        { cwd: root, timeoutMs: 60000 },
      );
      bgId = /claude attach ([0-9a-f]{8})/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? /[·•]\s*([0-9a-f]{8})/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
      expect(bgId).toBeDefined();

      const req = await vi.waitFor(() => {
        const ev = c.sent.find((e) => e.type === "permission.request");
        if (ev?.type !== "permission.request") throw new Error("ainda sem permission.request");
        return ev;
      }, { timeout: 180_000, interval: 500 });
      expect(req.tool).toBe("Bash");
      expect(req.inputPreview).toContain("example.com");
      // premissa da vigia do terminal: com o hook segurando, o inventário mostra a sessão em waiting
      await vi.waitFor(() => { expect(inventory.find(req.sessionId)?.status).toBe("waiting"); }, { timeout: 15_000, interval: 500 });
      console.info(`e2e: inventário durante o pedido → ${JSON.stringify(inventory.find(req.sessionId))}`);

      const cmd: RelayCommand = { ...newEnvelope("relay/relay"), type: "permission.decide", commandId: "e2e-1", requestId: req.requestId, behavior: "allow" };
      c.emit("command", cmd);
      await vi.waitFor(() => { expect(c.sent.find((e) => e.type === "command.ack")).toMatchObject({ commandId: "e2e-1" }); });
      expect(c.sent.find((e) => e.type === "permission.resolved")).toMatchObject({ requestId: req.requestId, by: "remote", behavior: "allow" });

      await vi.waitFor(() => { expect(toolResults(req.sessionId).some((t) => t.includes("200"))).toBe(true); }, { timeout: 120_000, interval: 1000 });
      console.info(`e2e: tool_result → ${JSON.stringify(toolResults(req.sessionId))}`);
    } finally {
      await agent.stop();
      if (bgId !== undefined) {
        await stopSession(bgId, { run: runClaude }).catch(() => undefined);
        await runClaude(["rm", bgId]).catch(() => undefined);
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 360_000);
});
