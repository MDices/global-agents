import { describe, it, expect } from "vitest";
import { RelayCommandSchema, SLASH_ALLOWLIST, newEnvelope } from "../src/index.js";
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
  describe("session.slash", () => {
    const slash = (over: Record<string, unknown>) => ({ ...env(), type: "session.slash", commandId: "c", sessionId: "s", command: "compact", ...over });
    it("allowlist fechada", () => {
      expect(SLASH_ALLOWLIST).toEqual(["compact", "usage", "cost", "hooks", "status", "context", "model"]);
    });
    it("compact (com e sem args) é válido", () => {
      expect(RelayCommandSchema.safeParse(slash({})).success).toBe(true);
      expect(RelayCommandSchema.safeParse(slash({ args: "foco em testes" })).success).toBe(true);
    });
    it("comando fora da allowlist é inválido", () => {
      expect(RelayCommandSchema.safeParse(slash({ command: "clear" })).success).toBe(false);
      expect(RelayCommandSchema.safeParse(slash({ command: "exit" })).success).toBe(false);
    });
    it("args com 501 chars ou quebra de linha é inválido", () => {
      expect(RelayCommandSchema.safeParse(slash({ args: "a".repeat(500) })).success).toBe(true);
      expect(RelayCommandSchema.safeParse(slash({ args: "a".repeat(501) })).success).toBe(false);
      expect(RelayCommandSchema.safeParse(slash({ args: "a\nb" })).success).toBe(false);
      expect(RelayCommandSchema.safeParse(slash({ args: "a\rb" })).success).toBe(false);
    });
    it("args com caracteres de controle é inválido (Esc, Ctrl+C, Ctrl+Z, tab, DEL)", () => {
      for (const c of ["\x1b", "\x03", "\x1a", "\t", "\x7f", "\x00"]) {
        expect(RelayCommandSchema.safeParse(slash({ args: `foco${c}x` })).success).toBe(false);
      }
      expect(RelayCommandSchema.safeParse(slash({ args: "foco em testes ✓ ação" })).success).toBe(true);
    });
  });
});
