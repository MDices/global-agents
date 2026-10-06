import { createHook } from "node:async_hooks";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEnvelope, serialize, type AgentEvent } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { addMachine } from "../src/cli.js";
import type { RelayConfig } from "../src/config.js";
import { openDb, relayDbPath } from "../src/db.js";
import { startRelay, type Relay } from "../src/main.js";
import { FakeDiscordPort } from "./helpers/fake-discord.js";

const M = "fedora/leonardo";
const SID = "0b7c2f1e-1111-4a5b-9c8d-000000000001";

type Body<T extends AgentEvent["type"]> = Omit<Extract<AgentEvent, { type: T }>, "v" | "id" | "ts" | "machine" | "type">;
const ev = <T extends AgentEvent["type"]>(type: T, body: Body<T>): AgentEvent =>
  ({ ...newEnvelope(M), type, ...body }) as AgentEvent;

/**
 * Rastreia, via `async_hooks`, os recursos que indicam vazamento (servidores e sockets TCP, e timers — inclusive os
 * `unref`'d, que `process.getActiveResourcesInfo()` não lista) criados a partir de `track()`. Timers do próprio
 * vitest (`vi.waitFor`, timeout do teste) ficam de fora pela pilha de criação. `TLSWRAP` não entra: ele só emite
 * `destroy` quando o GC o coleta; o socket TCP por baixo dele (`TCPWRAP`) é o que precisa estar fechado.
 */
const LEAKY = new Set(["TCPSERVERWRAP", "TCPWRAP", "Timeout"]);
let tracking: Map<number, string> | undefined;
/** O primeiro frame fora do Node (quem chamou `setTimeout`/`setInterval`) é do vitest? */
const createdByVitest = (stack: string): boolean => {
  const caller = stack.split("\n").slice(1).find((l) => !l.includes("node:") && !l.includes("async_hooks"));
  return caller !== undefined && /[/\\]vitest[/\\]|@vitest/.test(caller);
};
createHook({
  init(id, type) {
    if (tracking === undefined || !LEAKY.has(type)) return;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 30;
    const stack = new Error().stack ?? "";
    Error.stackTraceLimit = limit;
    if (type === "Timeout" && createdByVitest(stack)) return;
    tracking.set(id, type);
  },
  destroy(id) { tracking?.delete(id); },
}).enable();

function track(): void { tracking = new Map(); }

/**
 * Espera os fechamentos assíncronos (callbacks de close do libuv) e confere que nenhum recurso criado desde `track()`
 * continua vivo. Não usa timers para esperar: eles mesmos entrariam na contagem.
 */
async function expectNoLeaks(): Promise<void> {
  const live = (): string[] => [...(tracking ?? new Map<number, string>()).values()].sort();
  const deadline = Date.now() + 2_000;
  while (live().length > 0 && Date.now() < deadline) await new Promise((r) => setImmediate(r));
  expect(live()).toEqual([]);
  tracking = undefined;
}

let dataDir: string;
let token: string;
let logs: string[];
let port: FakeDiscordPort;

const cfg = (): RelayConfig => ({
  discordToken: "nao-usado", guildId: "g", categoryName: "global-agents", allowedUserIds: ["u"],
  dataDir, port: 0, logLevel: "info",
});
const deps = () => ({ port, log: (level: string, msg: string) => { logs.push(`${level} ${msg}`); } });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ga-relay-"));
  const db = openDb(relayDbPath(dataDir));
  token = addMachine(db, M);
  db.close();
  logs = [];
  port = new FakeDiscordPort();
});
afterEach(() => { tracking = undefined; rmSync(dataDir, { recursive: true, force: true }); });

function connect(relay: Relay, bearer: string): WebSocket {
  return new WebSocket(`wss://127.0.0.1:${relay.port}/ws`, {
    rejectUnauthorized: false,
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

describe("startRelay com agente falso", () => {
  it("hello → canal; session.list → thread; prompt e reply → 2 posts; agente cai → tópico offline", async () => {
    track();
    const relay = await startRelay(cfg(), deps());
    expect(relay.port).toBeGreaterThan(0);
    expect(relay.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(logs).toContain(`info fingerprint do certificado: ${relay.fingerprint}`);
    expect(logs.join("\n")).not.toContain(token);

    const ws = connect(relay, token);
    await once(ws, "open");
    const send = (e: AgentEvent): void => { ws.send(serialize(e)); };
    send(ev("agent.hello", { version: "0.1.0", os: "linux", osUser: "leonardo", claudeVersion: "2.1.291",
      claudeAccount: "leonardo@exemplo.com.br", projects: ["~/dev/work/gestai"] }));
    send(ev("session.list", { sessions: [{ sessionId: SID, name: "gestai", cwd: "~/dev/work/gestai", kind: "interactive", status: "busy" }] }));
    send(ev("turn.prompt", { sessionId: SID, text: "roda os testes", source: "terminal" }));
    send(ev("turn.reply", { sessionId: SID, text: "Todos os 42 testes passaram.", stopReason: "end_turn" }));

    await vi.waitFor(() => { expect(port.of("post")).toHaveLength(2); });
    expect(port.of("ensureChannel")).toEqual([
      { op: "ensureChannel", name: "fedora-leonardo", topic: "fedora/leonardo · Linux · Claude Code 2.1.291 · leonardo@exemplo.com.br" },
    ]);
    const channelId = "ch-1";
    expect(port.of("createThread")).toEqual([{ op: "createThread", channelId, name: "🟢 gestai" }]);
    const [prompt, reply] = port.of("post");
    expect(prompt?.text).toBe("> 🧑 **prompt:** roda os testes");
    expect(reply?.text).toBe("Todos os 42 testes passaram.");
    expect(prompt?.targetId).toBe(reply?.targetId);
    expect(port.of("postEmbed")).toHaveLength(1);
    expect(port.of("editChannelTopic")).toEqual([]);

    const wsClosed = once(ws, "close");
    ws.close();
    await wsClosed;
    await vi.waitFor(() => {
      const edits = port.of("editChannelTopic");
      expect(edits).toHaveLength(1);
      expect(edits[0]?.channelId).toBe(channelId);
      expect(edits[0]?.topic).toMatch(/^🔴 máquina offline desde \d{2}:\d{2} · fedora\/leonardo · Linux/);
    });

    await relay.close();
    await expectNoLeaks();
    expect(logs.join("\n")).not.toContain(token);
  });

  it("token inválido recebe HTTP 401 antes do upgrade", async () => {
    track();
    const relay = await startRelay(cfg(), deps());
    const ws = connect(relay, "token-errado");
    const [, res] = (await once(ws, "unexpected-response")) as [unknown, IncomingMessage];
    expect(res.statusCode).toBe(401);
    const sockClosed = once(res.socket, "close");
    res.destroy();
    await sockClosed;
    await relay.close();
    await expectNoLeaks();
    expect(logs.join("\n")).not.toContain("token-errado");
  });

  it("close() com o agente ainda conectado encerra tudo e não deixa handles abertos", async () => {
    track();
    const relay = await startRelay(cfg(), deps());
    const ws = connect(relay, token);
    await once(ws, "open");
    const closed = once(ws, "close");
    await relay.close();
    const [code] = (await closed) as [number];
    expect(code).toBe(1001);
    await expectNoLeaks();
  });

  it("falha na subida (porta ocupada) desfaz o que já abriu e rejeita", async () => {
    const a = await startRelay(cfg(), deps());
    try {
      track();
      await expect(startRelay({ ...cfg(), port: a.port }, deps())).rejects.toThrow(/EADDRINUSE/);
      await expectNoLeaks();
    } finally {
      await a.close();
    }
  });
});
