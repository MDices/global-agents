import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, get, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEnvelope, parseLine, serialize, type AgentEvent, type RelayCommand } from "@global-agents/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import { hashToken, openDb, type Db } from "../src/db.js";
import { ensureCert } from "../src/tls.js";
import { AgentHub } from "../src/ws/server.js";

const M = "fedora/leonardo";
const TOKEN = "tok-fedora";
const M2 = "mac/leo";
const TOKEN2 = "tok-mac";

const hello = (machine = M): AgentEvent => ({
  ...newEnvelope(machine), type: "agent.hello", version: "0.1.0", os: "linux", osUser: "leonardo",
  claudeVersion: "2.1.0", projects: [],
});
const cmd = (machine = M): RelayCommand => ({
  ...newEnvelope(machine), type: "session.stop", commandId: "c1", sessionId: "s1",
});
const text = (d: RawData): string => (Buffer.isBuffer(d) ? d.toString("utf8") : Buffer.concat(d as Buffer[]).toString("utf8"));

let dir: string;
let tlsOpts: { key: string; cert: string };
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-ws-"));
  const c = ensureCert(dir);
  tlsOpts = { key: c.key, cert: c.cert };
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

let db: Db;
let server: Server;
let hub: AgentHub;
let port: number;
const clients: WebSocket[] = [];

async function start(pingMs?: number): Promise<void> {
  server = createServer(tlsOpts);
  hub = new AgentHub(pingMs === undefined ? { db, server } : { db, server, pingMs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
}

function connect(token: string | null = TOKEN, path = "/ws", extra: ClientOptions = {}): WebSocket {
  const headers: Record<string, string> = token === null ? {} : { Authorization: `Bearer ${token}` };
  const ws = new WebSocket(`wss://127.0.0.1:${port}${path}`, { rejectUnauthorized: false, headers, ...extra });
  clients.push(ws);
  return ws;
}

/** Resolve com o status HTTP da resposta que recusou o upgrade. */
function rejectedStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => reject(new Error("não deveria abrir")));
    ws.on("error", () => { /* esperado após destroy */ });
    ws.on("unexpected-response", (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
  });
}

beforeEach(() => {
  db = openDb(":memory:");
  db.machines.upsert({ name: M, tokenHash: hashToken(TOKEN) });
  db.machines.upsert({ name: M2, tokenHash: hashToken(TOKEN2) });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  hub.close();
  server.closeAllConnections();
  server.close();
  await once(server, "close");
  db.close();
});

describe("AgentHub", () => {
  it("token válido conecta; hello com machine certo emite event e online e toca last_seen/meta", async () => {
    await start();
    const online = once(hub, "online");
    const event = once(hub, "event");
    const ws = connect();
    await once(ws, "open");
    ws.send(serialize(hello()));
    expect(await online).toEqual([M]);
    const [machine, ev] = (await event) as [string, AgentEvent];
    expect(machine).toBe(M);
    expect(ev.type).toBe("agent.hello");
    expect(hub.isOnline(M)).toBe(true);
    expect(hub.onlineMachines()).toEqual([M]);
    const row = db.machines.getByName(M);
    expect(row?.lastSeen).toBeTypeOf("number");
    expect(row?.os).toBe("linux");
    expect(row?.claudeVersion).toBe("2.1.0");
  });

  it("token inválido recebe 401 antes do upgrade e nada fica online", async () => {
    await start();
    let onlineCount = 0;
    hub.on("online", () => { onlineCount++; });
    expect(await rejectedStatus(connect("errado"))).toBe(401);
    expect(await rejectedStatus(connect(null))).toBe(401);
    expect(onlineCount).toBe(0);
    expect(hub.onlineMachines()).toEqual([]);
  });

  it("path diferente de /ws recebe 404 antes do upgrade", async () => {
    await start();
    expect(await rejectedStatus(connect(TOKEN, "/outro"))).toBe(404);
  });

  it("machine divergente no envelope fecha com 4002 e emite offline", async () => {
    await start();
    const ws = connect();
    await once(ws, "open");
    const offline = once(hub, "offline");
    const closed = once(ws, "close");
    ws.send(serialize(hello(M2)));
    const [code] = (await closed) as [number, Buffer];
    expect(code).toBe(4002);
    expect(await offline).toEqual([M]);
    expect(hub.onlineMachines()).toEqual([]);
  });

  it("send entrega o comando como linha válida; máquina offline devolve false", async () => {
    await start();
    const ws = connect();
    await once(ws, "open");
    const msg = once(ws, "message");
    expect(hub.send(M, cmd())).toBe(true);
    const [data] = (await msg) as [RawData];
    const line = text(data);
    expect(line.endsWith("\n")).toBe(true);
    const r = parseLine(line.trim());
    expect(r.ok && r.message.type).toBe("session.stop");
    expect(hub.send("x/y", cmd("x/y"))).toBe(false);
    expect(hub.send(M2, cmd(M2))).toBe(false);
  });

  it("segunda conexão da mesma máquina derruba a primeira com 4003; offline só da conexão atual", async () => {
    await start();
    const offlines: string[] = [];
    const onlines: string[] = [];
    hub.on("offline", (m) => offlines.push(m));
    hub.on("online", (m) => onlines.push(m));
    const a = connect();
    await once(a, "open");
    const aClosed = once(a, "close");
    const b = connect();
    await once(b, "open");
    const [code, reason] = (await aClosed) as [number, Buffer];
    expect(code).toBe(4003);
    expect(reason.toString()).toBe("substituída por nova conexão");
    expect(hub.onlineMachines()).toEqual([M]);
    expect(offlines).toEqual([]);
    expect(onlines).toEqual([M]);

    // comandos vão para a conexão nova
    const msg = once(b, "message");
    expect(hub.send(M, cmd())).toBe(true);
    await msg;

    const offline = once(hub, "offline");
    b.close();
    expect(await offline).toEqual([M]);
    expect(hub.isOnline(M)).toBe(false);
    expect(offlines).toEqual([M]);
  });

  it("linha inválida e comando vindo do agente emitem warning sem derrubar a conexão", async () => {
    await start();
    const warnings: string[] = [];
    hub.on("warning", (w) => warnings.push(w));
    const ws = connect();
    await once(ws, "open");
    const event = once(hub, "event");
    ws.send("não é json\n");
    ws.send(serialize(cmd()));
    ws.send(serialize(hello()));
    await event;
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).not.toContain(TOKEN);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("várias linhas num único frame viram vários eventos", async () => {
    await start();
    const events: AgentEvent[] = [];
    hub.on("event", (_m, ev) => events.push(ev));
    const ws = connect();
    await once(ws, "open");
    const second = new Promise<void>((resolve) => { hub.on("event", () => { if (events.length === 2) resolve(); }); });
    ws.send(serialize(hello()) + serialize(hello()));
    await second;
    expect(events).toHaveLength(2);
  });

  it("heartbeat derruba conexão que não responde ping", async () => {
    await start(50);
    const ws = connect(TOKEN, "/ws", { autoPong: false });
    await once(ws, "open");
    const offline = once(hub, "offline");
    const closed = once(ws, "close");
    expect(await offline).toEqual([M]);
    const [code] = (await closed) as [number, Buffer];
    expect(code).toBe(1006);
  });

  it("GET /health responde 200 {ok:true} sem autenticação", async () => {
    await start();
    const body = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      get({ host: "127.0.0.1", port, path: "/health", rejectUnauthorized: false, agent: false }, (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { b += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      }).on("error", reject);
    });
    expect(body.status).toBe(200);
    expect(JSON.parse(body.body)).toEqual({ ok: true });
  });
});
