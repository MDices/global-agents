import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, type AgentConfig } from "../src/config.js";
import { defaultFetchHealth, healthUrlFor, runDoctor, type DoctorDeps, type HealthResult } from "../src/doctor.js";

const PEM = readFileSync(new URL("./fixtures/relay-test.pem", import.meta.url));
const KEY = readFileSync(new URL("./fixtures/relay-test.key", import.meta.url));
const FP = new X509Certificate(PEM).fingerprint256;

const EVENTS = ["UserPromptSubmit", "Notification", "Stop", "SessionEnd", "PermissionRequest"];
const goodSettings = (): Record<string, unknown> => ({
  crossSessionInbound: "accept",
  hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: "bash /x/global-agents-hook.sh" }] }]])),
});

function cfg(extra: Record<string, unknown> = {}): AgentConfig {
  return parseConfig({ relayUrl: "wss://10.0.0.1:8443/ws", token: "segredo", ...extra });
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadConfig: () => cfg({ relayCertFingerprint: FP }),
    run: (args) => Promise.resolve(args[0] === "--version"
      ? { code: 0, stdout: "2.1.291 (Claude Code)\n", stderr: "" }
      : { code: 0, stdout: "[]", stderr: "" }),
    readSettings: () => goodSettings(),
    existsDir: () => true,
    listKeyFiles: () => ["1.abc.key"],
    fetchHealth: (): Promise<HealthResult> => Promise.resolve({ status: 200, body: '{"ok":true}', fingerprint: FP }),
    platform: "linux",
    uid: 1000,
    ...over,
  };
}

const by = async (d: DoctorDeps, name: string) => {
  const c = (await runDoctor(d)).find((x) => x.name.startsWith(name));
  if (c === undefined) throw new Error(`check ${name} ausente`);
  return c;
};

describe("runDoctor", () => {
  it("tudo certo → 8 checks ok na ordem", async () => {
    const r = await runDoctor(deps());
    expect(r.map((c) => c.name)).toEqual([
      "config", "versão do Claude Code", "claude agents --json", "hooks", "crossSessionInbound", "sockets", "relay alcançável", "fingerprint do relay",
    ]);
    expect(r.filter((c) => !c.ok)).toEqual([]);
  });

  it("config ausente → falha, relay não é checado, o resto roda", async () => {
    const r = await runDoctor(deps({ loadConfig: () => { throw new Error("config não encontrada"); } }));
    expect(r[0]).toMatchObject({ ok: false });
    expect(r[0]?.detail).toContain("config não encontrada");
    expect(r.find((c) => c.name === "relay alcançável")).toMatchObject({ ok: false });
    expect(r.find((c) => c.name === "hooks")?.ok).toBe(true);
  });

  it("nunca vaza o token", async () => {
    const r = await runDoctor(deps());
    expect(JSON.stringify(r)).not.toContain("segredo");
  });

  it("versão 2.1.200 → falha mencionando a mínima (Linux 2.1.224)", async () => {
    const c = await by(deps({ run: () => Promise.resolve({ code: 0, stdout: "2.1.200 (Claude Code)", stderr: "" }) }), "versão");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("2.1.224");
  });

  it("Windows exige 2.1.234", async () => {
    const run = (): Promise<{ code: number; stdout: string; stderr: string }> => Promise.resolve({ code: 0, stdout: "2.1.230 (Claude Code)", stderr: "" });
    const w = await by(deps({ run, platform: "win32" }), "versão");
    expect(w.ok).toBe(false);
    expect(w.detail).toContain("2.1.234");
    expect((await by(deps({ run }), "versão")).ok).toBe(true);
  });

  it("versão ilegível ou claude ausente → falha", async () => {
    expect((await by(deps({ run: () => Promise.resolve({ code: 0, stdout: "???", stderr: "" }) }), "versão")).ok).toBe(false);
    const c = await by(deps({ run: () => Promise.reject(new Error("ENOENT")) }), "versão");
    expect(c).toMatchObject({ ok: false });
    expect(c.detail).toContain("ENOENT");
  });

  it("claude agents --json: ok com lista; falha com código ≠ 0 ou JSON inválido", async () => {
    const mk = (code: number, stdout: string) => deps({ run: (a) => Promise.resolve(a[0] === "--version" ? { code: 0, stdout: "2.1.291", stderr: "" } : { code, stdout, stderr: "boom" }) });
    expect((await by(mk(0, "[]"), "claude agents")).ok).toBe(true);
    expect((await by(mk(1, "[]"), "claude agents")).ok).toBe(false);
    expect((await by(mk(0, "não é json"), "claude agents")).ok).toBe(false);
  });

  it("hooks: falha listando os eventos sem o marcador", async () => {
    const s = goodSettings();
    delete (s["hooks"] as Record<string, unknown>)["Stop"];
    const c = await by(deps({ readSettings: () => s }), "hooks");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Stop");
    expect(c.detail).not.toContain("SessionEnd");
  });

  it("hooks: comando sem o marcador não conta; settings ilegível falha", async () => {
    const s = goodSettings();
    (s["hooks"] as Record<string, unknown>)["Notification"] = [{ hooks: [{ type: "command", command: "echo oi" }] }];
    expect((await by(deps({ readSettings: () => s }), "hooks")).detail).toContain("Notification");
    const c = await by(deps({ readSettings: () => { throw new Error("JSON ruim"); } }), "hooks");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("JSON ruim");
  });

  it("crossSessionInbound: só 'accept' passa", async () => {
    expect((await by(deps(), "crossSessionInbound")).ok).toBe(true);
    const c = await by(deps({ readSettings: () => ({ ...goodSettings(), crossSessionInbound: "ask" }) }), "crossSessionInbound");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("ask");
    expect((await by(deps({ readSettings: () => ({}) }), "crossSessionInbound")).ok).toBe(false);
  });

  it("sockets (Linux): /run/user/<uid>/cc-socks, com fallback em /tmp", async () => {
    const seen: string[] = [];
    expect((await by(deps({ existsDir: (p) => { seen.push(p); return p === "/tmp/cc-socks-1000"; } }), "sockets")).ok).toBe(true);
    expect(seen).toEqual(["/run/user/1000/cc-socks", "/tmp/cc-socks-1000"]);
    const c = await by(deps({ existsDir: () => false }), "sockets");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("/run/user/1000/cc-socks");
  });

  it("sockets (Windows): .key existe → ok; nenhum → ok com nota", async () => {
    expect(await by(deps({ platform: "win32" }), "sockets")).toMatchObject({ ok: true });
    const c = await by(deps({ platform: "win32", listKeyFiles: () => [] }), "sockets");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("nenhuma sessão aberta");
  });

  it("relay inalcançável / status 500 / corpo errado → falha; fingerprint não é avaliado", async () => {
    const down = deps({ fetchHealth: () => Promise.reject(new Error("ECONNREFUSED")) });
    const c = await by(down, "relay alcançável");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("ECONNREFUSED");
    expect((await by(down, "fingerprint")).ok).toBe(false);
    expect((await by(deps({ fetchHealth: () => Promise.resolve({ status: 500, body: "", fingerprint: FP }) }), "relay alcançável")).ok).toBe(false);
    expect((await by(deps({ fetchHealth: () => Promise.resolve({ status: 200, body: "<html>", fingerprint: FP }) }), "relay alcançável")).ok).toBe(false);
  });

  it("fingerprint: diferente falha com texto claro; sem pin falha com a dica de reinstalar com --fingerprint", async () => {
    const other = deps({ fetchHealth: () => Promise.resolve({ status: 200, body: '{"ok":true}', fingerprint: "AA:BB" }) });
    const c = await by(other, "fingerprint");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("outro certificado");
    expect((await by(other, "relay alcançável")).ok).toBe(true);
    const unpinned = await by(deps({ loadConfig: () => cfg() }), "fingerprint");
    expect(unpinned.ok).toBe(false);
    expect(unpinned.detail).toContain("não fixado");
    expect(unpinned.detail).toContain("install");
    expect(unpinned.detail).toContain("--fingerprint");
    expect(unpinned.detail).toContain("fingerprint");
    const unpinnedDown = await by(deps({ loadConfig: () => cfg(), fetchHealth: () => Promise.reject(new Error("self-signed certificate")) }), "fingerprint");
    expect(unpinnedDown.ok).toBe(false);
    expect(unpinnedDown.detail).toContain("--fingerprint");
    const plain = await by(deps({ loadConfig: () => cfg({ relayUrl: "ws://10.0.0.1:8080/ws" }) }), "fingerprint");
    expect(plain.ok).toBe(true);
    expect(plain.detail).toContain("sem TLS");
  });

  it("fetchHealth recebe a URL https derivada e o fingerprint", async () => {
    let got: [string, string | undefined] | undefined;
    await runDoctor(deps({ fetchHealth: (u, f) => { got = [u, f]; return Promise.resolve({ status: 200, body: '{"ok":true}', fingerprint: FP }); } }));
    expect(got).toEqual(["https://10.0.0.1:8443/health", FP]);
  });
});

describe("healthUrlFor", () => {
  it("wss→https e ws→http, trocando o caminho por /health", () => {
    expect(healthUrlFor("wss://host:8443/ws")).toBe("https://host:8443/health");
    expect(healthUrlFor("ws://host:80/ws")).toBe("http://host/health");
  });
});

describe("defaultFetchHealth (TLS real)", () => {
  let srv: Server | undefined;
  afterEach(() => { srv?.close(); srv = undefined; });
  const start = async (): Promise<string> => {
    srv = createServer({ cert: PEM, key: KEY }, (req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => srv?.listen(0, "127.0.0.1", r));
    return `https://127.0.0.1:${(srv.address() as AddressInfo).port}/health`;
  };

  it("certificado autoassinado: devolve status, corpo e o fingerprint apresentado", async () => {
    const url = await start();
    const r = await defaultFetchHealth(url);
    expect(r.status).toBe(200);
    expect(r.body).toContain("ok");
    expect(r.fingerprint).toBe(FP);
  });

  it("no doctor: fingerprint certo ok, errado falha", async () => {
    const url = await start();
    const real = (u: string, f?: string) => defaultFetchHealth(u, f, 2000);
    const base = { loadConfig: () => cfg({ relayUrl: url.replace("https", "wss").replace("/health", "/ws"), relayCertFingerprint: FP }), fetchHealth: real };
    expect((await by(deps(base), "fingerprint")).ok).toBe(true);
    expect((await by(deps(base), "relay alcançável")).ok).toBe(true);
    const wrong = FP.replace(/^../, FP.startsWith("00") ? "11" : "00");
    const bad = deps({ ...base, loadConfig: () => cfg({ relayUrl: url.replace("https", "wss").replace("/health", "/ws"), relayCertFingerprint: wrong }) });
    expect((await by(bad, "fingerprint")).ok).toBe(false);
  });

  it("porta fechada rejeita", async () => {
    await expect(defaultFetchHealth("https://127.0.0.1:1/health", undefined, 2000)).rejects.toThrow();
  });
});
