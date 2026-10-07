import { describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../src/claude/exec.js";
import type { Inventory, SessionInfo } from "../src/claude/inventory.js";
import { SessionNotVisibleError, spawnSession, WorkspaceNotTrustedError } from "../src/claude/spawn.js";
import { SessionNotFoundError, stopSession } from "../src/claude/stop.js";

const OK_OUT =
  "Starting background service…\nbackgrounded · 85285a68 · nome\n  claude attach 85285a68    open in this terminal\n  claude stop 85285a68      stop this session\n";
const ok = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "" });

function fakeInventory(): { inventory: Pick<Inventory, "waitFor">; waitFor: ReturnType<typeof vi.fn> } {
  const waitFor = vi.fn(
    (pred: (s: SessionInfo) => boolean): Promise<SessionInfo> => {
      const s = { sessionId: "85285a68-454d-4000-8000-000000000000", bgId: "85285a68" } as SessionInfo;
      return pred(s) ? Promise.resolve(s) : Promise.reject(new Error("pred"));
    },
  );
  return { inventory: { waitFor } as unknown as Pick<Inventory, "waitFor">, waitFor };
}

const input = { cwd: process.cwd(), name: "nome", prompt: "prompt", permissionMode: "plan" as const };

describe("spawnSession", () => {
  it("roda --bg, extrai o id curto e espera o inventário", async () => {
    const run = vi.fn().mockResolvedValue(ok(OK_OUT));
    const { inventory, waitFor } = fakeInventory();
    const r = await spawnSession(input, { run, inventory });
    expect(r).toEqual({ sessionId: "85285a68-454d-4000-8000-000000000000", bgId: "85285a68" });
    expect(run).toHaveBeenCalledWith(["--bg", "--name", "nome", "--permission-mode", "plan", "--", "prompt"], {
      cwd: process.cwd(),
      timeoutMs: 60000,
    });
    expect(waitFor.mock.calls[0]?.[1]).toBe(30000);
  });

  it("prompt começando com - vai após `--`", async () => {
    const run = vi.fn().mockResolvedValue(ok(OK_OUT));
    const { inventory } = fakeInventory();
    await spawnSession({ ...input, prompt: "--help" }, { run, inventory });
    expect(run.mock.calls[0]?.[0]).toEqual(["--bg", "--name", "nome", "--permission-mode", "plan", "--", "--help"]);
  });

  it("extrai o id da variante idle", async () => {
    const run = vi.fn().mockResolvedValue(ok("backgrounded · fe6d8df0 · ga-dash1 (idle — send a prompt to start)\n"));
    const waitFor = vi.fn().mockResolvedValue({ sessionId: "s", bgId: "fe6d8df0" });
    const r = await spawnSession(input, { run, inventory: { waitFor } as unknown as Pick<Inventory, "waitFor"> });
    expect(r.bgId).toBe("fe6d8df0");
  });

  it("waitFor rejeitado → SessionNotVisibleError com bgId", async () => {
    const run = vi.fn().mockResolvedValue(ok(OK_OUT));
    const waitFor = vi.fn().mockRejectedValue(new Error("timeout"));
    const e = await spawnSession(input, { run, inventory: { waitFor } as unknown as Pick<Inventory, "waitFor"> }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SessionNotVisibleError);
    expect((e as SessionNotVisibleError).bgId).toBe("85285a68");
    expect((e as Error).message).toContain("claude attach 85285a68");
  });

  it("usa a linha `claude attach` como fallback", async () => {
    const run = vi.fn().mockResolvedValue(ok("  claude attach deadbeef    open\n"));
    const waitFor = vi.fn().mockResolvedValue({ sessionId: "s", bgId: "deadbeef" });
    await expect(spawnSession(input, { run, inventory: { waitFor } as unknown as Pick<Inventory, "waitFor"> })).resolves.toEqual({
      sessionId: "s",
      bgId: "deadbeef",
    });
  });

  it("pasta não confiável → WorkspaceNotTrustedError", async () => {
    const run = vi.fn().mockResolvedValue(ok("Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.", 1));
    const { inventory } = fakeInventory();
    const p = spawnSession(input, { run, inventory });
    await expect(p).rejects.toBeInstanceOf(WorkspaceNotTrustedError);
    await expect(p).rejects.toThrow(/não é confiável.*`claude`/);
  });

  describe("confiança em pasta de raiz dev", () => {
    const NOT_TRUSTED = ok("Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.", 1);

    it("recusa por confiança com trustPaths → grava a confiança e tenta uma vez mais", async () => {
      const run = vi.fn().mockResolvedValueOnce(NOT_TRUSTED).mockResolvedValueOnce(ok(OK_OUT));
      const trust = vi.fn(() => Promise.resolve(true));
      const { inventory } = fakeInventory();
      const r = await spawnSession({ ...input, trustPaths: ["/d/app", "/real/d/app"] }, { run, inventory, trust });
      expect(r.bgId).toBe("85285a68");
      expect(trust).toHaveBeenCalledWith(["/d/app", "/real/d/app"]);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("continua sem confiança depois de gravar → WorkspaceNotTrustedError, sem terceira tentativa", async () => {
      const run = vi.fn().mockResolvedValue(NOT_TRUSTED);
      const { inventory } = fakeInventory();
      await expect(spawnSession({ ...input, trustPaths: ["/d/app"] }, { run, inventory, trust: () => Promise.resolve(true) }))
        .rejects.toBeInstanceOf(WorkspaceNotTrustedError);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("trust devolve false (estado ilegível) → não tenta de novo", async () => {
      const run = vi.fn().mockResolvedValue(NOT_TRUSTED);
      const { inventory } = fakeInventory();
      await expect(spawnSession({ ...input, trustPaths: ["/d/app"] }, { run, inventory, trust: () => Promise.resolve(false) }))
        .rejects.toBeInstanceOf(WorkspaceNotTrustedError);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("sem trustPaths (pasta fora das raízes) → nunca grava confiança", async () => {
      const run = vi.fn().mockResolvedValue(NOT_TRUSTED);
      const trust = vi.fn(() => Promise.resolve(true));
      const { inventory } = fakeInventory();
      await expect(spawnSession(input, { run, inventory, trust })).rejects.toBeInstanceOf(WorkspaceNotTrustedError);
      expect(trust).not.toHaveBeenCalled();
    });

    it("pasta já confiável → não grava nada", async () => {
      const run = vi.fn().mockResolvedValue(ok(OK_OUT));
      const trust = vi.fn(() => Promise.resolve(true));
      const { inventory } = fakeInventory();
      await spawnSession({ ...input, trustPaths: ["/d/app"] }, { run, inventory, trust });
      expect(trust).not.toHaveBeenCalled();
    });
  });

  it("cwd inexistente falha antes de executar", async () => {
    const run = vi.fn();
    const { inventory } = fakeInventory();
    await expect(spawnSession({ ...input, cwd: "/nao/existe/mesmo" }, { run, inventory })).rejects.toThrow("pasta não encontrada: /nao/existe/mesmo");
    expect(run).not.toHaveBeenCalled();
  });

  it("cwd que é arquivo também falha", async () => {
    const run = vi.fn();
    const { inventory } = fakeInventory();
    await expect(spawnSession({ ...input, cwd: import.meta.filename }, { run, inventory })).rejects.toThrow(/pasta não encontrada/);
  });

  it("saída sem id → Error com o começo da saída", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: "x".repeat(500), stderr: "boom" });
    const { inventory } = fakeInventory();
    const e = await spawnSession(input, { run, inventory }).catch((x: unknown) => x as Error);
    expect(e.message.length).toBeLessThan(400);
    expect(e.message).toContain("xxx");
  });
});

describe("stopSession", () => {
  it("resolve com `stopped <id>`", async () => {
    const run = vi.fn().mockResolvedValue(ok("stopped 85285a68\n"));
    await expect(stopSession("85285a68", { run })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(["stop", "85285a68"]);
  });
  it("`No job matching` → SessionNotFoundError", async () => {
    const run = vi.fn().mockResolvedValue(ok("No job matching 'deadbeef'. Run 'claude agents' to list running sessions.\n", 1));
    await expect(stopSession("deadbeef", { run })).rejects.toBeInstanceOf(SessionNotFoundError);
  });
  it("bgId inválido é rejeitado sem executar", async () => {
    const run = vi.fn();
    await expect(stopSession("--all", { run })).rejects.toThrow(/bgId inválido/);
    expect(run).not.toHaveBeenCalled();
  });
  it("falha desconhecida → Error", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "kaput" });
    await expect(stopSession("85285a68", { run })).rejects.toThrow(/kaput/);
  });
});
