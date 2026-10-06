import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readRegistry } from "../src/claude/registry.js";

const fixtures = join(import.meta.dirname, "fixtures");

describe("readRegistry", () => {
  // os fixtures têm prefixo "session-"; no disco real os arquivos são <pid>.json e <pid>.<hash>.key
  let sessionsDir: string;
  beforeAll(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "ga-sessions-"));
    copyFileSync(join(fixtures, "session-2323142.json"), join(sessionsDir, "2323142.json"));
    copyFileSync(join(fixtures, "session-2323142.abc.key"), join(sessionsDir, "2323142.abc.key"));
  });

  it("lê .json e extrai peerToken do .key", () => {
    const r = readRegistry(2323142, sessionsDir);
    expect(r?.pid).toBe(2323142);
    expect(r?.messagingSocketPath).toBe("/run/user/1000/cc-socks/2323142.sock");
    expect(r?.peerToken).toBe("67c71d8bdf91eaa635ce4a50de5fe44c");
    expect(r?.sessionId.startsWith("6c66")).toBe(true);
    expect(r?.name).toBe("global-agents-80");
    expect(r?.peerProtocol).toBe(1);
  });

  it("pid sem registro → undefined", () => {
    expect(readRegistry(1, sessionsDir)).toBeUndefined();
  });
});
