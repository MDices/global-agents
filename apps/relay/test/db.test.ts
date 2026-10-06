import { describe, expect, it } from "vitest";
import { MachineExistsError, hashToken, openDb } from "../src/db.js";

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

  it("listByMachine ordena por updated_at desc", () => {
    const db = openDb(":memory:");
    db.sessions.upsert({ sessionId: "a", machine: "m/u", state: "idle", updatedAt: 1 });
    db.sessions.upsert({ sessionId: "b", machine: "m/u", state: "idle", updatedAt: 3 });
    db.sessions.upsert({ sessionId: "c", machine: "m/u", state: "idle", updatedAt: 2 });
    db.sessions.upsert({ sessionId: "d", machine: "x/y", state: "idle", updatedAt: 9 });
    expect(db.sessions.listByMachine("m/u").map((s) => s.sessionId)).toEqual(["b", "c", "a"]);
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
    expect(db.pendingCommands.listDue("m/u").map((c) => c.commandId)).toEqual(["c1", "c2"]);
    expect(db.pendingCommands.listDue("m/u")[1]?.discordMessageId).toBe("d");
    db.pendingCommands.remove("c1");
    expect(db.pendingCommands.listDue("m/u").map((c) => c.commandId)).toEqual(["c2"]);
  });

  it("expireBefore remove e devolve os expirados", () => {
    const db = openDb(":memory:");
    db.pendingCommands.add({ commandId: "old", machine: "m/u", payload: "{}", createdAt: 1, expiresAt: 10, discordMessageId: "dm" });
    db.pendingCommands.add({ commandId: "new", machine: "m/u", payload: "{}", createdAt: 1, expiresAt: 1000 });
    const removed = db.pendingCommands.expireBefore(50);
    expect(removed.map((c) => c.commandId)).toEqual(["old"]);
    expect(removed[0]?.discordMessageId).toBe("dm");
    expect(db.pendingCommands.listDue("m/u").map((c) => c.commandId)).toEqual(["new"]);
  });
});
