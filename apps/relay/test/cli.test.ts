import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMachine, runCli } from "../src/cli.js";
import { hashToken, MachineExistsError, openDb, relayDbPath, TokenInUseError, type Db } from "../src/db.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-cli-"));
  db = openDb(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Roda a CLI capturando a saída. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { DATA_DIR: dir }, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("addMachine", () => {
  it("gera token de 32 bytes em hex e grava só o hash", () => {
    const token = addMachine(db, "fedora/leonardo");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const m = db.machines.getByName("fedora/leonardo");
    expect(m?.tokenHash).toBe(hashToken(token));
    expect(m?.tokenHash).not.toBe(token);
  });

  it("recusa nome fora de hostname/usuario", () => {
    expect(() => addMachine(db, "Fedora")).toThrow(/hostname\/usuario/);
    expect(() => addMachine(db, "fedora/Leo")).toThrow(/hostname\/usuario/);
  });

  it("máquina existente exige --force; com force troca o token", () => {
    const t1 = addMachine(db, "fedora/leonardo");
    expect(() => addMachine(db, "fedora/leonardo")).toThrow(MachineExistsError);
    const t2 = addMachine(db, "fedora/leonardo", { force: true });
    expect(t2).not.toBe(t1);
    expect(db.machines.getByTokenHash(hashToken(t1))).toBeUndefined();
    expect(db.machines.getByTokenHash(hashToken(t2))?.name).toBe("fedora/leonardo");
  });

  it("token cujo hash já pertence a outra máquina vira TokenInUseError (não o erro cru do SQLite)", () => {
    addMachine(db, "fedora/leonardo", { token: "abc" });
    const e = (() => { try { addMachine(db, "mac/leo", { token: "abc" }); } catch (x) { return x; } return undefined; })();
    expect(e).toBeInstanceOf(TokenInUseError);
    expect((e as Error).message).toMatch(/já pertence/);
    expect((e as Error).message).not.toContain("abc");
    addMachine(db, "mac/leo", { token: "def" });
    expect(() => addMachine(db, "mac/leo", { token: "abc", force: true })).toThrow(TokenInUseError);
  });
});

describe("db: remove e backup", () => {
  it("machines.remove apaga e diz se existia", () => {
    addMachine(db, "fedora/leonardo");
    expect(db.machines.remove("fedora/leonardo")).toBe(true);
    expect(db.machines.remove("fedora/leonardo")).toBe(false);
    expect(db.machines.list()).toEqual([]);
  });
});

describe("CLI relay", () => {
  it("machine add imprime o token uma vez, com aviso; machine list não mostra hash nem token", async () => {
    const add = await cli("machine", "add", "fedora/leonardo");
    expect(add.code).toBe(0);
    const token = /\b([0-9a-f]{64})\b/.exec(add.out)?.[1];
    expect(token).toBeDefined();
    expect(add.out).toMatch(/não será mostrado de novo/);

    const list = await cli("machine", "list");
    expect(list.code).toBe(0);
    expect(list.out).toContain("fedora/leonardo");
    expect(list.out).toContain("nunca");
    expect(list.out).not.toContain(token ?? "-");
    expect(list.out).not.toContain(hashToken(token ?? ""));
    expect(list.out).not.toMatch(/[0-9a-f]{64}/);
  });

  it("machine add de máquina existente sem --force falha com mensagem em português", async () => {
    await cli("machine", "add", "fedora/leonardo");
    const again = await cli("machine", "add", "fedora/leonardo");
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/--force/);
    const forced = await cli("machine", "add", "fedora/leonardo", "--force");
    expect(forced.code).toBe(0);
  });

  it("machine rm remove; rm de inexistente falha", async () => {
    await cli("machine", "add", "fedora/leonardo");
    expect((await cli("machine", "rm", "fedora/leonardo")).code).toBe(0);
    expect((await cli("machine", "list")).out).not.toContain("fedora/leonardo");
    const rm = await cli("machine", "rm", "fedora/leonardo");
    expect(rm.code).toBe(1);
    expect(rm.err).toMatch(/não encontrada/);
  });

  it("fingerprint cria o certificado em DATA_DIR e imprime o SHA-256 (95 caracteres), estável", async () => {
    const a = await cli("fingerprint");
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(a.out).toHaveLength(95);
    expect((await cli("fingerprint")).out).toBe(a.out);
  });

  it("backup grava <dataDir>/backups/<data>.db com VACUUM INTO, legível", async () => {
    await cli("machine", "add", "fedora/leonardo");
    const b = await cli("backup");
    expect(b.code).toBe(0);
    const files = readdirSync(join(dir, "backups"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}\.db$/);
    expect(b.out).toContain(files[0] ?? "?");
    const copy = openDb(join(dir, "backups", files[0] ?? ""));
    expect(copy.machines.list().map((m) => m.name)).toEqual(["fedora/leonardo"]);
    copy.close();
    expect(existsSync(relayDbPath(dir))).toBe(true);
  });

  it("comando desconhecido ou sem argumentos sai com 1 e mostra o uso", async () => {
    const r = await cli("machine", "explode");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/uso: relay/);
    expect((await cli()).code).toBe(1);
  });
});
