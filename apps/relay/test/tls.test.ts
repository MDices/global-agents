import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCert } from "../src/tls.js";

describe("ensureCert", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("gera key/crt com fingerprint AA:BB:… e reaproveita na segunda chamada", () => {
    dir = mkdtempSync(join(tmpdir(), "ga-tls-"));
    const a = ensureCert(dir);
    const keyPath = join(dir, "tls", "relay.key");
    const crtPath = join(dir, "tls", "relay.crt");
    expect(a.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(a.fingerprint256).toHaveLength(95);
    expect(a.key).toContain("PRIVATE KEY");
    expect(a.cert).toContain("BEGIN CERTIFICATE");
    expect(readFileSync(crtPath, "utf8")).toBe(a.cert);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    const b = ensureCert(dir);
    expect(b.fingerprint256).toBe(a.fingerprint256);
    expect(b.cert).toBe(a.cert);
  });

  it("regenera se só um dos arquivos existir", () => {
    dir = mkdtempSync(join(tmpdir(), "ga-tls-"));
    const a = ensureCert(dir);
    rmSync(join(dir, "tls", "relay.key"));
    const b = ensureCert(dir);
    expect(b.fingerprint256).not.toBe(a.fingerprint256);
    expect(statSync(join(dir, "tls", "relay.key")).mode & 0o777).toBe(0o600);
  });
});
