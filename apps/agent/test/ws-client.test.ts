import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEnvelope, parseLine, serialize, type AgentEvent, type Message, type RelayCommand } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayClient } from "../src/transport/client.js";
import { Outbox } from "../src/transport/outbox.js";

const MACHINE = "fedora/leonardo";
const PEM = readFileSync(new URL("./fixtures/relay-test.pem", import.meta.url));
const KEY = readFileSync(new URL("./fixtures/relay-test.key", import.meta.url));
const FINGERPRINT = new X509Certificate(PEM).fingerprint256;

function hello(): AgentEvent {
  return { ...newEnvelope(MACHINE), type: "agent.hello", version: "0.1.0", os: "linux", osUser: "leonardo", projects: [] };
}
function reply(text: string): AgentEvent {
  return { ...newEnvelope(MACHINE), type: "turn.reply", sessionId: "s1", text };
}
function sendCmd(): RelayCommand {
  return { ...newEnvelope("relay/relay"), type: "session.send", commandId: "c1", sessionId: "s1", text: "oi" };
}

/** Uma conexão aceita pelo servidor falso, com as linhas recebidas já validadas. */
interface Conn { ws: WebSocket; req: IncomingMessage; lines: Message[] }

/** Servidor `ws` falso (HTTP ou HTTPS) em porta 0 que registra conexões e mensagens. */
class FakeRelay {
  readonly conns: Conn[] = [];
  readonly wss: WebSocketServer;
  private readonly sockets = new Set<Socket>();
  constructor(readonly server: HttpServer | HttpsServer) {
    this.wss = new WebSocketServer({ server });
    server.on("connection", (s: Socket) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    this.wss.on("connection", (ws, req) => {
      const conn: Conn = { ws, req, lines: [] };
      this.conns.push(conn);
      ws.on("message", (data: Buffer) => {
        for (const line of data.toString("utf8").split("\n")) {
          if (line === "") continue;
          const r = parseLine(line);
          if (r.ok) conn.lines.push(r.message);
        }
      });
    });
  }
  static async start(tls = false): Promise<FakeRelay> {
    const relay = new FakeRelay(tls ? createHttpsServer({ cert: PEM, key: KEY }) : createHttpServer());
    await new Promise<void>((res) => relay.server.listen(0, "127.0.0.1", res));
    return relay;
  }
  url(tls = false): string {
    return `${tls ? "wss" : "ws"}://127.0.0.1:${(this.server.address() as AddressInfo).port}/ws`;
  }
  /** Tipos recebidos numa conexão. */
  types(i: number): string[] { return (this.conns[i]?.lines ?? []).map((m) => m.type); }
  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((res) => this.wss.close(() => res()));
    this.server.closeAllConnections();
    await new Promise<void>((res) => this.server.close(() => res()));
  }
}

let dir: string;
let relay: FakeRelay | undefined;
let client: RelayClient | undefined;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ws-client-")); });
afterEach(async () => {
  client?.stop();
  client = undefined;
  await relay?.close();
  relay = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function makeClient(url: string, extra: { certFingerprint?: string; pingMs?: number } = {}): { c: RelayClient; outbox: Outbox; warnings: string[] } {
  const outbox = new Outbox(dir);
  const c = new RelayClient({ url, token: "tok", outbox, hello, backoff: { minMs: 20, maxMs: 200 }, pingMs: extra.pingMs ?? 1000,
    ...(extra.certFingerprint !== undefined ? { certFingerprint: extra.certFingerprint } : {}) });
  const warnings: string[] = [];
  c.on("warning", (w: string) => warnings.push(w));
  client = c;
  return { c, outbox, warnings };
}

describe("RelayClient", () => {
  it("conecta com Bearer e manda hello como primeira linha", async () => {
    relay = await FakeRelay.start();
    const { c } = makeClient(relay.url());
    const connected = vi.fn();
    c.on("connected", connected);
    c.start();
    await vi.waitFor(() => { expect(relay?.types(0)).toEqual(["agent.hello"]); });
    expect(relay.conns[0]?.req.headers.authorization).toBe("Bearer tok");
    await vi.waitFor(() => { expect(connected).toHaveBeenCalledTimes(1); });
    expect(c.isConnected()).toBe(true);
  });

  it("send() antes de conectar vai pro outbox e é entregue depois: hello, outbox, novos", async () => {
    relay = await FakeRelay.start();
    const { c, outbox } = makeClient(relay.url());
    c.send(reply("a"));
    c.send(reply("b"));
    expect(c.isConnected()).toBe(false);
    expect(outbox.size()).toBeGreaterThan(0);
    c.on("connected", () => { c.send(reply("c")); });
    c.start();
    await vi.waitFor(() => { expect(relay?.conns[0]?.lines).toHaveLength(4); });
    const lines = relay.conns[0]?.lines ?? [];
    expect(lines.map((m) => m.type)).toEqual(["agent.hello", "turn.reply", "turn.reply", "turn.reply"]);
    expect(lines.slice(1).map((m) => (m.type === "turn.reply" ? m.text : ""))).toEqual(["a", "b", "c"]);
    expect(outbox.size()).toBe(0);
  });

  it("eventos produzidos durante a drenagem não furam a fila", async () => {
    relay = await FakeRelay.start();
    const { c, outbox } = makeClient(relay.url());
    for (const t of ["a", "b", "c"]) c.send(reply(t));
    // Assim que o hello chega ao servidor o cliente está drenando: o que for enviado agora vai depois do outbox.
    relay.wss.once("connection", (ws) => { ws.once("message", () => { c.send(reply("d")); }); });
    c.start();
    await vi.waitFor(() => { expect(relay?.conns[0]?.lines).toHaveLength(5); });
    const texts = (relay.conns[0]?.lines ?? []).slice(1).map((m) => (m.type === "turn.reply" ? m.text : ""));
    expect(texts).toEqual(["a", "b", "c", "d"]);
    expect(outbox.size()).toBe(0);
  });

  it("comando válido vira 'command'; lixo vira 'warning' e a conexão continua", async () => {
    relay = await FakeRelay.start();
    const { c, warnings } = makeClient(relay.url());
    const commands: RelayCommand[] = [];
    c.on("command", (cmd: RelayCommand) => commands.push(cmd));
    c.start();
    await vi.waitFor(() => { expect(c.isConnected()).toBe(true); });
    const server = relay.conns[0]?.ws;
    server?.send("lixo\n");
    server?.send(serialize(reply("evento não é comando")));
    const cmd = sendCmd();
    server?.send(serialize(cmd));
    await vi.waitFor(() => { expect(commands).toEqual([cmd]); });
    expect(warnings).toHaveLength(2);
    expect(c.isConnected()).toBe(true);
    c.send(reply("ainda vivo"));
    await vi.waitFor(() => { expect(relay?.types(0)).toEqual(["agent.hello", "turn.reply"]); });
    expect(relay.conns).toHaveLength(1);
  });

  it("servidor fecha → reconecta em menos de minMs*4 e reenvia hello", async () => {
    relay = await FakeRelay.start();
    const { c } = makeClient(relay.url());
    const disconnected = vi.fn();
    c.on("disconnected", disconnected);
    c.start();
    await vi.waitFor(() => { expect(c.isConnected()).toBe(true); });
    const closedAt = Date.now();
    relay.conns[0]?.ws.close();
    await vi.waitFor(() => { expect(relay?.types(1)).toEqual(["agent.hello"]); }, { timeout: 1000, interval: 2 });
    expect(Date.now() - closedAt).toBeLessThan(20 * 4 + 40); // folga para o handshake local
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("evento enviado com a conexão caída vai pro outbox e é entregue na reconexão, sem duplicar", async () => {
    relay = await FakeRelay.start();
    const { c } = makeClient(relay.url());
    c.start();
    await vi.waitFor(() => { expect(c.isConnected()).toBe(true); });
    c.send(reply("1"));
    await vi.waitFor(() => { expect(relay?.types(0)).toEqual(["agent.hello", "turn.reply"]); });
    c.once("disconnected", () => { c.send(reply("2")); });
    relay.conns[0]?.ws.close();
    await vi.waitFor(() => { expect(relay?.types(1)).toEqual(["agent.hello", "turn.reply"]); });
    const all = relay.conns.flatMap((k) => k.lines).filter((m) => m.type === "turn.reply").map((m) => (m.type === "turn.reply" ? m.text : ""));
    expect(all).toEqual(["1", "2"]);
  });

  it("sem pong → 'disconnected' e reconecta", async () => {
    relay = await FakeRelay.start();
    const { c } = makeClient(relay.url(), { pingMs: 50 });
    const disconnected = vi.fn();
    c.on("disconnected", disconnected);
    c.start();
    await vi.waitFor(() => { expect(c.isConnected()).toBe(true); });
    // Pausa o socket do servidor: o ping nunca é lido, então não há pong.
    (relay.conns[0]?.ws as unknown as { _socket: Socket })._socket.pause();
    await vi.waitFor(() => { expect(disconnected).toHaveBeenCalledTimes(1); }, { timeout: 1000 });
    await vi.waitFor(() => { expect(relay?.types(1)).toEqual(["agent.hello"]); }, { timeout: 1000 });
  });

  it("falha no envio inicial derruba a conexão em vez de ficar aberta sem nunca ficar pronta", async () => {
    relay = await FakeRelay.start();
    let calls = 0;
    const c = new RelayClient({ url: relay.url(), token: "tok", outbox: new Outbox(dir), backoff: { minMs: 20, maxMs: 200 }, pingMs: 1000,
      hello: () => { calls++; if (calls === 1) throw new Error("hello quebrou"); return hello(); } });
    const warnings: string[] = [];
    c.on("warning", (w: string) => warnings.push(w));
    client = c;
    c.start();
    await vi.waitFor(() => { expect(relay?.types(1)).toEqual(["agent.hello"]); });
    await vi.waitFor(() => { expect(c.isConnected()).toBe(true); });
    expect(warnings.some((w) => w.includes("hello quebrou"))).toBe(true);
  });

  it("stop() fecha com 1000 e não reconecta", async () => {
    relay = await FakeRelay.start();
    const { c } = makeClient(relay.url());
    c.start();
    await vi.waitFor(() => { expect(c.isConnected()).toBe(true); });
    const code = new Promise<number>((res) => relay?.conns[0]?.ws.on("close", (n: number) => res(n)));
    c.stop();
    expect(await code).toBe(1000);
    expect(c.isConnected()).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.conns).toHaveLength(1);
  });

  it("relay fora do ar: agenda reconexão com backoff e conecta quando sobe", async () => {
    relay = await FakeRelay.start();
    const url = relay.url();
    const port = Number(new URL(url).port);
    await relay.close();
    relay = undefined;
    const { c } = makeClient(url);
    c.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(c.isConnected()).toBe(false);
    const server = createHttpServer();
    relay = new FakeRelay(server);
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));
    await vi.waitFor(() => { expect(relay?.types(0)).toEqual(["agent.hello"]); }, { timeout: 2000 });
  });

  describe("TLS com pinning", () => {
    it("fingerprint certo conecta", async () => {
      relay = await FakeRelay.start(true);
      const { c, warnings } = makeClient(relay.url(true), { certFingerprint: FINGERPRINT.toLowerCase() });
      c.start();
      await vi.waitFor(() => { expect(relay?.types(0)).toEqual(["agent.hello"]); });
      expect(relay.conns[0]?.req.headers.authorization).toBe("Bearer tok");
      expect(warnings).toEqual([]);
    });

    it("fingerprint errado emite 'warning' com 'fingerprint' e não conecta (nem envia o token)", async () => {
      relay = await FakeRelay.start(true);
      const requests = vi.fn();
      relay.server.on("upgrade", requests);
      relay.server.on("request", requests);
      const wrong = FINGERPRINT.replace(/^[0-9A-F]{2}/, (h) => (h === "00" ? "11" : "00"));
      const { c, warnings } = makeClient(relay.url(true), { certFingerprint: wrong });
      c.start();
      await vi.waitFor(() => { expect(warnings.some((w) => w.includes("fingerprint"))).toBe(true); });
      // Continua tentando (backoff), mas nunca completa o handshake HTTP.
      await vi.waitFor(() => { expect(warnings.filter((w) => w.includes("fingerprint")).length).toBeGreaterThanOrEqual(2); });
      expect(c.isConnected()).toBe(false);
      expect(relay.conns).toHaveLength(0);
      expect(requests).not.toHaveBeenCalled();
    });

    it("sem certFingerprint usa verificação TLS normal e recusa o autoassinado", async () => {
      relay = await FakeRelay.start(true);
      const { c, warnings } = makeClient(relay.url(true));
      c.start();
      await vi.waitFor(() => { expect(warnings.length).toBeGreaterThan(0); });
      expect(c.isConnected()).toBe(false);
      expect(relay.conns).toHaveLength(0);
    });
  });
});
