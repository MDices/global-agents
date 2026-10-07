import { describe, it, expect } from "vitest";
import { RelayCommandSchema, SLASH_ALLOWLIST, newEnvelope } from "../src/index.js";
const env = () => newEnvelope("relay/vps");
describe("comandos", () => {
  it("session.create exige cwd, name, prompt e permissionMode válido", () => {
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.create", commandId: "c", cwd: "/p", name: "x", prompt: "oi", permissionMode: "plan" }).success).toBe(true);
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.create", commandId: "c", cwd: "/p", name: "x", prompt: "oi", permissionMode: "yolo" }).success).toBe(false);
  });
  it("session.create: create é opcional e booleano; cwd relativo é aceito; cwd até 4096", () => {
    const base = { ...env(), type: "session.create", commandId: "c", cwd: "work/app-novo", name: "x", prompt: "oi", permissionMode: "default" };
    expect(RelayCommandSchema.safeParse(base).success).toBe(true);
    const comCreate = RelayCommandSchema.safeParse({ ...base, create: true });
    expect(comCreate.success && comCreate.data.type === "session.create" ? comCreate.data.create : undefined).toBe(true);
    expect(RelayCommandSchema.safeParse({ ...base, create: "sim" }).success).toBe(false);
    expect(RelayCommandSchema.safeParse({ ...base, cwd: "a".repeat(4097) }).success).toBe(false);
  });
  it("schema de session.create sem create (agente antigo) descarta a chave create em vez de recusar", () => {
    const antigo = RelayCommandSchema.options.find((o) => o.shape.type.value === "session.create");
    expect(antigo).toBeDefined();
    const semCreate = antigo!.omit({ create: true } as never);
    const r = semCreate.safeParse({ ...env(), type: "session.create", commandId: "c", cwd: "/p", name: "x", prompt: "oi", permissionMode: "plan", create: true });
    expect(r.success).toBe(true);
    expect(r.success ? (r.data as Record<string, unknown>)["create"] : "x").toBeUndefined();
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

describe("noDevRootText", () => {
  it("comando por sistema, com como reiniciar o agente", async () => {
    const { noDevRootText } = await import("../src/index.js");
    expect(noDevRootText("linux")).toBe("esta máquina não tem pasta dev; rode `global-agents install --dev-root ~/dev` e reinicie o agente com `systemctl --user restart global-agents`");
    expect(noDevRootText("win32")).toBe("esta máquina não tem pasta dev; rode `.\\deploy\\agent\\install-windows.ps1 -DevRoot C:\\dev` (o script grava a pasta e reinicia o agente sozinho)");
    expect(noDevRootText("darwin")).toContain("e reinicie o agente");
    expect(noDevRootText(null)).toBe(noDevRootText("linux"));
    expect(noDevRootText(undefined)).toBe(noDevRootText("linux"));
  });
});
