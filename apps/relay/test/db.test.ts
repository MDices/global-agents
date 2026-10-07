import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, MachineExistsError, hashToken, openDb } from "../src/db.js";

describe("hashToken", () => {
  it("é sha256 hex determinístico", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("migrate", () => {
  it("é idempotente", () => {
    const db = openDb(":memory:");
    expect(() => db.migrate()).not.toThrow();
    expect(() => db.migrate()).not.toThrow();
  });
});

describe("migração 2 (dev_roots)", () => {
  it("sobre um banco da versão 1: acrescenta a coluna, mantém as linhas e começa sem raízes (modo antigo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-mig-"));
    const file = join(dir, "relay.db");
    const v1 = new DatabaseSync(file);
    v1.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    v1.exec(MIGRATIONS[0] ?? "");
    v1.exec("INSERT INTO schema_version (version) VALUES (1)");
    v1.exec("INSERT INTO machines (name, token_hash, os, channel_id) VALUES ('fedora/leonardo', 'h', 'linux', 'ch-1')");
    v1.close();
    const db = openDb(file);
    const m = db.machines.getByName("fedora/leonardo");
    expect(m).toMatchObject({ tokenHash: "h", os: "linux", channelId: "ch-1", devRoots: null });
    db.machines.setDevRoots("fedora/leonardo", ["/home/leonardo/dev"]);
    db.close();
    const again = openDb(file);
    expect(again.machines.getByName("fedora/leonardo")?.devRoots).toEqual(["/home/leonardo/dev"]);
    again.machines.setDevRoots("fedora/leonardo", null);
    expect(again.machines.getByName("fedora/leonardo")?.devRoots).toBeNull();
    again.machines.setDevRoots("fedora/leonardo", []);
    expect(again.machines.getByName("fedora/leonardo")?.devRoots).toEqual([]);
    again.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("machines", () => {
  it("upsert + getByTokenHash/getByName/list", () => {
    const db = openDb(":memory:");
    db.machines.upsert({ name: "fedora/leonardo", tokenHash: "h" });
    expect(db.machines.getByTokenHash("h")?.name).toBe("fedora/leonardo");
    expect(db.machines.getByName("fedora/leonardo")?.tokenHash).toBe("h");
    expect(db.machines.getByName("nope")).toBeUndefined();
    expect(db.machines.list()).toHaveLength(1);
  });

  it("mesmo nome e mesmo hash é no-op", () => {
    const db = openDb(":memory:");
    db.machines.upsert({ name: "m/u", tokenHash: "h" });
    db.machines.setChannel("m/u", "c1");
    expect(() => db.machines.upsert({ name: "m/u", tokenHash: "h" })).not.toThrow();
    expect(db.machines.getByName("m/u")?.channelId).toBe("c1");
  });

  it("mesmo nome com outro hash lança MachineExistsError, salvo force", () => {
    const db = openDb(":memory:");
    db.machines.upsert({ name: "m/u", tokenHash: "h1" });
    db.machines.setChannel("m/u", "c1");
    expect(() => db.machines.upsert({ name: "m/u", tokenHash: "h2" })).toThrow(MachineExistsError);
    expect(db.machines.getByName("m/u")?.tokenHash).toBe("h1");
    db.machines.upsert({ name: "m/u", tokenHash: "h2" }, { force: true });
    expect(db.machines.getByTokenHash("h2")?.channelId).toBe("c1");
    expect(db.machines.getByTokenHash("h1")).toBeUndefined();
  });

  it("setFilterAccount grava e limpa o filtro; getByChannel acha a máquina pelo canal", () => {
    const db = openDb(":memory:");
    db.machines.upsert({ name: "fedora/leonardo", tokenHash: "h" });
    expect(db.machines.getByName("fedora/leonardo")?.filterAccount).toBeNull();
    db.machines.setFilterAccount("fedora/leonardo", "x@y.com");
    expect(db.machines.getByName("fedora/leonardo")?.filterAccount).toBe("x@y.com");
    db.machines.setFilterAccount("fedora/leonardo", null);
    expect(db.machines.getByName("fedora/leonardo")?.filterAccount).toBeNull();
    expect(db.machines.getByChannel("ch-9")).toBeUndefined();
    db.machines.setChannel("fedora/leonardo", "ch-9");
    expect(db.machines.getByChannel("ch-9")?.name).toBe("fedora/leonardo");
  });

  it("touch grava metadados e last_seen", () => {
    const db = openDb(":memory:");
    db.machines.upsert({ name: "m/u", tokenHash: "h" });
    db.machines.touch("m/u", 1234, { os: "linux", claudeVersion: "2.1", claudeAccount: "a@b" });
    const m = db.machines.getByName("m/u");
    expect(m).toMatchObject({ lastSeen: 1234, os: "linux", claudeVersion: "2.1", claudeAccount: "a@b", filterAccount: null });
    db.machines.touch("m/u", 2000);
    expect(db.machines.getByName("m/u")).toMatchObject({ lastSeen: 2000, os: "linux" });
  });
});

describe("sessions", () => {
  it("upsert + setThread + get", () => {
    const db = openDb(":memory:");
    db.sessions.upsert({ sessionId: "s1", machine: "m/u", name: "n", cwd: "/w", state: "idle", updatedAt: 1 });
    db.sessions.setThread("s1", "t1");
    expect(db.sessions.get("s1")).toMatchObject({ threadId: "t1", bgId: null, name: "n" });
    db.sessions.upsert({ sessionId: "s1", machine: "m/u", state: "busy", updatedAt: 5 });
    expect(db.sessions.get("s1")).toMatchObject({ threadId: "t1", state: "busy", name: "n", updatedAt: 5 });
    db.sessions.setState("s1", "idle", 9);
    expect(db.sessions.get("s1")).toMatchObject({ state: "idle", updatedAt: 9 });
    expect(db.sessions.get("zzz")).toBeUndefined();
  });

  it("upsert nunca reatribui a máquina de uma sessão existente", () => {
    const db = openDb(":memory:");
    db.sessions.upsert({ sessionId: "s1", machine: "m/u", name: "n", state: "idle", updatedAt: 1 });
    db.sessions.upsert({ sessionId: "s1", machine: "x/y", name: "outra", state: "busy", updatedAt: 2 });
    expect(db.sessions.get("s1")?.machine).toBe("m/u");
  });

  it("listByMachine ordena por updated_at desc", () => {
    const db = openDb(":memory:");
    db.sessions.upsert({ sessionId: "a", machine: "m/u", state: "idle", updatedAt: 1 });
    db.sessions.upsert({ sessionId: "b", machine: "m/u", state: "idle", updatedAt: 3 });
    db.sessions.upsert({ sessionId: "c", machine: "m/u", state: "idle", updatedAt: 2 });
    db.sessions.upsert({ sessionId: "d", machine: "x/y", state: "idle", updatedAt: 9 });
    expect(db.sessions.listByMachine("m/u").map((s) => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("getByThread acha a sessão pela thread do Discord", () => {
    const db = openDb(":memory:");
    db.sessions.upsert({ sessionId: "s1", machine: "m/u", name: "um", state: "idle", updatedAt: 1, threadId: "t1" });
    db.sessions.upsert({ sessionId: "s2", machine: "x/y", name: "dois", state: "idle", updatedAt: 2, threadId: "t2" });
    db.sessions.upsert({ sessionId: "s3", machine: "x/y", state: "idle", updatedAt: 3 });
    expect(db.sessions.getByThread("t2")).toMatchObject({ sessionId: "s2", machine: "x/y", name: "dois" });
    expect(db.sessions.getByThread("t1")?.sessionId).toBe("s1");
    expect(db.sessions.getByThread("nenhuma")).toBeUndefined();
  });
});

describe("permissions", () => {
  it("create, get e resolve", () => {
    const db = openDb(":memory:");
    db.permissions.create({ requestId: "r1", sessionId: "s1", messageId: "msg" });
    expect(db.permissions.get("r1")).toMatchObject({ status: "pending", decidedBy: null });
    db.permissions.resolve("r1", "allow", "user1", 100);
    expect(db.permissions.get("r1")).toMatchObject({ status: "allow", decidedBy: "user1", decidedAt: 100 });
  });

  it("resolve só vale uma vez (retorna false na segunda)", () => {
    const db = openDb(":memory:");
    db.permissions.create({ requestId: "r1", sessionId: "s1", messageId: "msg" });
    expect(db.permissions.resolve("r1", "allow", "u1", 1)).toBe(true);
    expect(db.permissions.resolve("r1", "deny", "u2", 2)).toBe(false);
    expect(db.permissions.get("r1")?.decidedBy).toBe("u1");
  });
});

describe("pendingCommands", () => {
  it("add, listDue, remove", () => {
    const db = openDb(":memory:");
    db.pendingCommands.add({ commandId: "c1", machine: "m/u", payload: "{}", createdAt: 1, expiresAt: 100 });
    db.pendingCommands.add({ commandId: "c2", machine: "m/u", payload: "{}", createdAt: 2, expiresAt: 100, discordMessageId: "d" });
    db.pendingCommands.add({ commandId: "c3", machine: "o/o", payload: "{}", createdAt: 3, expiresAt: 100 });
    expect(db.pendingCommands.listDue("m/u", 50).map((c) => c.commandId)).toEqual(["c1", "c2"]);
    expect(db.pendingCommands.listDue("m/u", 50)[1]?.discordMessageId).toBe("d");
    db.pendingCommands.remove("c1");
    expect(db.pendingCommands.listDue("m/u", 50).map((c) => c.commandId)).toEqual(["c2"]);
  });

  it("expireBefore remove e devolve os expirados", () => {
    const db = openDb(":memory:");
    db.pendingCommands.add({ commandId: "old", machine: "m/u", payload: "{}", createdAt: 1, expiresAt: 10, discordMessageId: "dm" });
    db.pendingCommands.add({ commandId: "new", machine: "m/u", payload: "{}", createdAt: 1, expiresAt: 1000 });
    const removed = db.pendingCommands.expireBefore(50);
    expect(removed.map((c) => c.commandId)).toEqual(["old"]);
    expect(removed[0]?.discordMessageId).toBe("dm");
    expect(db.pendingCommands.listDue("m/u", 50).map((c) => c.commandId)).toEqual(["new"]);
  });

  it("listDue devolve só os não expirados, em ordem de chegada (FIFO)", () => {
    const db = openDb(":memory:");
    db.pendingCommands.add({ commandId: "b", machine: "m/u", payload: "{}", createdAt: 2, expiresAt: 1000 });
    db.pendingCommands.add({ commandId: "velho", machine: "m/u", payload: "{}", createdAt: 1, expiresAt: 10 });
    db.pendingCommands.add({ commandId: "a", machine: "m/u", payload: "{}", createdAt: 1, expiresAt: 1000 });
    db.pendingCommands.add({ commandId: "c", machine: "m/u", payload: "{}", createdAt: 2, expiresAt: 1000 });
    expect(db.pendingCommands.listDue("m/u", 50).map((c) => c.commandId)).toEqual(["a", "b", "c"]);
    // `expires_at` igual a agora ainda vale (expireBefore usa `<`): nenhuma linha é ao mesmo tempo devida e expirada.
    expect(db.pendingCommands.listDue("m/u", 10).map((c) => c.commandId)).toEqual(["velho", "a", "b", "c"]);
  });

  it("listDue sem `now` usa o relógio atual", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.pendingCommands.add({ commandId: "vencido", machine: "m/u", payload: "{}", createdAt: now - 10, expiresAt: now - 1 });
    db.pendingCommands.add({ commandId: "vale", machine: "m/u", payload: "{}", createdAt: now, expiresAt: now + 3_600_000 });
    expect(db.pendingCommands.listDue("m/u").map((c) => c.commandId)).toEqual(["vale"]);
  });
});

describe("concorrência entre conexões (relay no ar + CLI via docker compose exec)", () => {
  it("a segunda escrita espera o lock da outra conexão (busy_timeout) em vez de falhar com database is locked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-db-lock-"));
    const file = join(dir, "relay.db");
    try {
      openDb(file).close(); // cria o schema
      // Outra conexão (em outra thread, como o relay seria outro processo) segura um lock de escrita por ~200 ms.
      const holder = new Worker(
        `const { DatabaseSync } = require("node:sqlite");
         const { parentPort, workerData } = require("node:worker_threads");
         const db = new DatabaseSync(workerData);
         db.exec("BEGIN IMMEDIATE");
         db.prepare("INSERT INTO machines (name, token_hash) VALUES ('outra/maquina', 'h-outra')").run();
         parentPort.postMessage("locked");
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
         db.exec("COMMIT");
         db.close();`,
        { eval: true, workerData: file },
      );
      const exited = new Promise<number>((resolve) => { holder.once("exit", resolve); });
      await new Promise<void>((resolve, reject) => {
        holder.once("message", () => { resolve(); });
        holder.once("error", reject);
      });
      const db = openDb(file);
      const t0 = Date.now();
      try {
        db.machines.upsert({ name: "fedora/leonardo", tokenHash: "h" });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
        expect(db.machines.list().map((m) => m.name).sort()).toEqual(["fedora/leonardo", "outra/maquina"]);
      } finally {
        db.close();
      }
      expect(await exited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
