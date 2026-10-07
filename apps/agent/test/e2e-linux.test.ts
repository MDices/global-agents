import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { parseLine, type Message } from "@global-agents/protocol";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { runClaude } from "../src/claude/exec.js";
import { createAgent } from "../src/main.js";

// Só roda com GLOBAL_AGENTS_E2E=1: exige `claude` instalado e logado, e um diretório confiável (a raiz do repo).
const E2E = process.env["GLOBAL_AGENTS_E2E"] === "1";
const NAME = "ac-e2e";

function hooksInstalled(): boolean {
  const p = join(homedir(), ".claude", "settings.json");
  return existsSync(p) && readFileSync(p, "utf8").includes("global-agents-hook");
}

async function until<T>(fn: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timeout esperando ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!E2E)("e2e Linux: agente + claude --bg + relay falso", () => {
  it("session.list com ac-e2e e, com hooks instalados, turn.reply OK", { timeout: 240_000 }, async () => {
    const lines: Message[] = [];
    const http: Server = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer) => {
        for (const l of data.toString("utf8").split("\n")) {
          if (l === "") continue;
          const r = parseLine(l);
          if (r.ok) lines.push(r.message);
        }
      });
    });
    await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
    const dataDir = mkdtempSync(join(tmpdir(), "agent-e2e-"));
    const cwd = new URL("../../../", import.meta.url).pathname;
    const withHooks = hooksInstalled();
    const agent = createAgent({
      relayUrl: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`, token: "e2e", projects: [cwd], devRoots: [],
      // com os hooks da máquina instalados eles postam na porta padrão
      port: withHooks ? 48476 : 0, claudeBin: "claude", dataDir,
    });
    let bgId: string | undefined;
    try {
      await agent.start();
      const r = await runClaude(["--bg", "--name", NAME, "--permission-mode", "plan", "Responda apenas OK."], { cwd, timeoutMs: 60_000 });
      expect(r.code).toBe(0);
      const session = await until(() => {
        for (const m of lines) {
          if (m.type !== "session.list") continue;
          const s = m.sessions.find((x) => x.name === NAME);
          if (s !== undefined) return s;
        }
        return undefined;
      }, 60_000, `session.list com ${NAME}`);
      bgId = session.bgId;
      expect(lines[0]?.type).toBe("agent.hello");
      if (withHooks) {
        const reply = await until(
          () => lines.find((m) => m.type === "turn.reply" && m.sessionId === session.sessionId),
          180_000, "turn.reply",
        );
        expect(reply.type === "turn.reply" ? reply.text : "").toContain("OK");
      }
    } finally {
      const id = bgId ?? NAME;
      await runClaude(["stop", id], { timeoutMs: 30_000 }).catch(() => undefined);
      await runClaude(["rm", id], { timeoutMs: 30_000 }).catch(() => undefined);
      await agent.stop();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      http.closeAllConnections();
      await new Promise<void>((res) => http.close(() => res()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
