import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_REQUIRES_TEXT, installConfig, InstallUsageError, loadConfig, saveConfig } from "../src/config.js";

function tmpConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ga-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
}

describe("loadConfig", () => {
  it("aplica defaults", () => {
    const p = tmpConfig({ relayUrl: "wss://1.2.3.4:8443/ws", token: "t", projects: ["/x"] });
    const cfg = loadConfig(p);
    expect(cfg.port).toBe(48476);
    expect(cfg.claudeBin).toBe("claude");
    expect(cfg.projects).toEqual(["/x"]);
  });

  it("JSON malformado → erro sem trecho do conteúdo (não vaza o token)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, '{"relayUrl":"wss://1.2.3.4:8443/ws","token":"SEGREDO123",');
    let msg = "";
    try { loadConfig(p); } catch (e) { msg = (e as Error).message; }
    expect(msg).toBe(`config inválida em ${p}: JSON malformado`);
    expect(msg).not.toContain("SEGREDO");
  });

  it("rejeita relayUrl que não é ws/wss", () => {
    const p = tmpConfig({ relayUrl: "http://x", token: "t", projects: [] });
    expect(() => loadConfig(p)).toThrow(/relayUrl/);
  });
});

describe("saveConfig", () => {
  it.skipIf(process.platform === "win32")("força modo 0600 mesmo se o arquivo já existia aberto", () => {
    const p = tmpConfig({});
    chmodSync(p, 0o644);
    saveConfig({ relayUrl: "wss://1.2.3.4:8443/ws", token: "t", projects: [], devRoots: [], port: 48476, claudeBin: "claude", dataDir: "/d" }, p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

const FP = Array.from({ length: 32 }, () => "AB").join(":");

describe("installConfig", () => {
  it("relay mudou sem --fingerprint → descarta o pin antigo e avisa", () => {
    const p = tmpConfig({ relayUrl: "wss://1.2.3.4:8443/ws", relayCertFingerprint: FP, token: "t", machineName: "m", projects: ["/x"] });
    const { cfg, warnings } = installConfig(loadConfig(p), { relayUrl: "wss://5.6.7.8:8443/ws", token: "t2", projects: [] });
    saveConfig(cfg, p);
    const saved = loadConfig(p);
    expect(saved).not.toHaveProperty("relayCertFingerprint");
    expect(saved).toMatchObject({ relayUrl: "wss://5.6.7.8:8443/ws", token: "t2", machineName: "m", projects: ["/x"] });
    expect(warnings).toEqual(["relay mudou; o fingerprint anterior foi descartado — passe --fingerprint para fixar o certificado novo"]);
  });

  it("mesmo relay sem --fingerprint mantém o pin; relay novo com --fingerprint usa o novo", () => {
    const prev = loadConfig(tmpConfig({ relayUrl: "wss://1.2.3.4:8443/ws", relayCertFingerprint: FP, token: "t" }));
    const same = installConfig(prev, { relayUrl: "wss://1.2.3.4:8443/ws", token: "t", projects: [] });
    expect(same.cfg.relayCertFingerprint).toBe(FP);
    expect(same.warnings).toEqual([]);
    const fp2 = FP.replace(/^AB/, "CD");
    const other = installConfig(prev, { relayUrl: "wss://5.6.7.8:8443/ws", token: "t", fingerprint: fp2, projects: ["/y"] });
    expect(other.cfg).toMatchObject({ relayCertFingerprint: fp2, projects: ["/y"] });
    expect(other.warnings).toEqual([]);
  });

  it("sem config anterior aplica os padrões", () => {
    const { cfg } = installConfig(undefined, { relayUrl: "ws://h:1/ws", token: "t", projects: [] });
    expect(cfg).toMatchObject({ port: 48476, claudeBin: "claude", projects: [], devRoots: [] });
  });

  it("sem config anterior continua exigindo relay e token", () => {
    expect(() => installConfig(undefined, { token: "t", projects: [] })).toThrow(InstallUsageError);
    expect(() => installConfig(undefined, { relayUrl: "ws://h:1/ws", projects: [], devRoots: ["/d"] })).toThrow(INSTALL_REQUIRES_TEXT);
  });

  it("com config anterior, só --dev-root: reaproveita relay, token, fingerprint e projetos", () => {
    const prev = loadConfig(tmpConfig({ relayUrl: "wss://1.2.3.4:8443/ws", relayCertFingerprint: FP, token: "segredo", machineName: "m", projects: ["/x"] }));
    expect(prev.devRoots).toEqual([]);
    const { cfg, warnings } = installConfig(prev, { projects: [], devRoots: ["/home/u/dev", "/home/u/work"] });
    expect(cfg).toMatchObject({
      relayUrl: "wss://1.2.3.4:8443/ws", relayCertFingerprint: FP, token: "segredo", machineName: "m",
      projects: ["/x"], devRoots: ["/home/u/dev", "/home/u/work"],
    });
    expect(warnings).toEqual([]);
  });

  it("--dev-root e --project substituem a lista correspondente; ausentes mantêm a anterior", () => {
    const prev = loadConfig(tmpConfig({ relayUrl: "ws://h:1/ws", token: "t", projects: ["/x"], devRoots: ["/d1", "/d2"] }));
    expect(installConfig(prev, { projects: [] }).cfg).toMatchObject({ projects: ["/x"], devRoots: ["/d1", "/d2"] });
    expect(installConfig(prev, { projects: ["/y"] }).cfg).toMatchObject({ projects: ["/y"], devRoots: ["/d1", "/d2"] });
    expect(installConfig(prev, { projects: [], devRoots: ["/d3"] }).cfg).toMatchObject({ projects: ["/x"], devRoots: ["/d3"] });
  });

  it("token novo com config anterior substitui o salvo; --relay novo sem fingerprint ainda descarta o pin", () => {
    const prev = loadConfig(tmpConfig({ relayUrl: "wss://1.2.3.4:8443/ws", relayCertFingerprint: FP, token: "velho" }));
    expect(installConfig(prev, { token: "novo", projects: [] }).cfg).toMatchObject({ token: "novo", relayCertFingerprint: FP });
    const moved = installConfig(prev, { relayUrl: "wss://9.9.9.9:8443/ws", projects: [] });
    expect(moved.cfg).toMatchObject({ token: "velho", relayUrl: "wss://9.9.9.9:8443/ws" });
    expect(moved.cfg).not.toHaveProperty("relayCertFingerprint");
    expect(moved.warnings).toHaveLength(1);
  });
});
