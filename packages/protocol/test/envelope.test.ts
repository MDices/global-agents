import { describe, it, expect } from "vitest";
import { newEnvelope, parseLine, serialize, MACHINE_RE } from "../src/index.js";

describe("envelope", () => {
  it("gera v=1, id uuid, ts ISO com fuso e machine", () => {
    const e = newEnvelope("fedora/leonardo");
    expect(e.v).toBe(1);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(e.ts).toISOString()).not.toThrow();
    expect(e.ts.endsWith("Z")).toBe(true);
    expect(e.machine).toBe("fedora/leonardo");
  });
  it("valida o formato hostname/usuario", () => {
    expect(MACHINE_RE.test("toneli-pc/admin")).toBe(true);
    expect(MACHINE_RE.test("ToneliPC")).toBe(false);
    expect(MACHINE_RE.test("a/b/c")).toBe(false);
  });
  it("parseLine recusa JSON inválido, versão errada e type desconhecido", () => {
    expect(parseLine("{").ok).toBe(false);
    const base = { ...newEnvelope("x/y"), type: "session.status", sessionId: "s", name: "n", cwd: "/", state: "done" };
    expect(parseLine(JSON.stringify({ ...base, v: 2 })).ok).toBe(false);
    expect(parseLine(JSON.stringify({ ...base, type: "nope" })).ok).toBe(false);
    expect(parseLine(JSON.stringify(base)).ok).toBe(true);
  });
  it("serialize produz uma linha terminada em \\n e parseLine a lê de volta", () => {
    const msg = { ...newEnvelope("x/y"), type: "session.status" as const, sessionId: "s", name: "n", cwd: "/", state: "working" as const };
    const line = serialize(msg);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    const r = parseLine(line.trim());
    expect(r.ok && r.message.type === "session.status" && r.message.state).toBe("working");
  });
});
