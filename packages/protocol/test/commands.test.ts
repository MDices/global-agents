import { describe, it, expect } from "vitest";
import { RelayCommandSchema, newEnvelope } from "../src/index.js";
const env = () => newEnvelope("relay/vps");
describe("comandos", () => {
  it("session.create exige cwd, name, prompt e permissionMode válido", () => {
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.create", commandId: "c", cwd: "/p", name: "x", prompt: "oi", permissionMode: "plan" }).success).toBe(true);
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.create", commandId: "c", cwd: "/p", name: "x", prompt: "oi", permissionMode: "yolo" }).success).toBe(false);
  });
  it("session.send limita text a 100 kB", () => {
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.send", commandId: "c", sessionId: "u", text: "a".repeat(100_001) }).success).toBe(false);
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.send", commandId: "c", sessionId: "u", text: "oi" }).success).toBe(true);
  });
  it("permission.decide só aceita allow|deny", () => {
    expect(RelayCommandSchema.safeParse({ ...env(), type: "permission.decide", commandId: "c", requestId: "r", behavior: "maybe" }).success).toBe(false);
  });
});
