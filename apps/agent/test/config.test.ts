import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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

  it("rejeita relayUrl que não é ws/wss", () => {
    const p = tmpConfig({ relayUrl: "http://x", token: "t", projects: [] });
    expect(() => loadConfig(p)).toThrow(/relayUrl/);
  });
});
