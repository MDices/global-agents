import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installConfig, loadConfig, saveConfig } from "../src/config.js";

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
    saveConfig({ relayUrl: "wss://1.2.3.4:8443/ws", token: "t", projects: [], port: 48476, claudeBin: "claude", dataDir: "/d" }, p);
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
    expect(cfg).toMatchObject({ port: 48476, claudeBin: "claude", projects: [] });
  });
});
