import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@global-agents/protocol";
import type { ExecResult } from "../src/claude/exec.js";
import { Inventory, parseAgentsJson } from "../src/claude/inventory.js";

const fixtures = join(import.meta.dirname, "fixtures");
const linux = readFileSync(join(fixtures, "agents-linux.json"), "utf8");
const windows = readFileSync(join(fixtures, "agents-windows.json"), "utf8");

describe("parseAgentsJson", () => {
  it("normaliza a saída do linux", () => {
    const list = parseAgentsJson(linux);
    expect(list).toHaveLength(3);
    expect(list.find((x) => x.bgId === "85285a68")).toMatchObject({ bgId: "85285a68", kind: "background", status: "waiting", waitingFor: "permission prompt" });
    const interactive = list.find((x) => x.name === "correcoes-bugs");
    expect(interactive?.kind).toBe("interactive");
    expect(interactive).not.toHaveProperty("bgId");
  });

  it("preserva cwd do windows", () => {
    expect(parseAgentsJson(windows)[0]?.cwd).toBe("C:\\Users\\Admin\\CDT\\gestai");
  });

  describe("tolerância a campos opcionais", () => {
    const base = { sessionId: "aaaa1111-0000-4000-8000-000000000001", cwd: "/tmp/x", kind: "interactive", name: "t" };
    const one = (row: Record<string, unknown>): SessionInfo[] => parseAgentsJson(JSON.stringify([row]));

    it("pid: null e status: null → linha mantida, campos ausentes", () => {
      const list = one({ ...base, pid: null, status: null });
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty("pid");
      expect(list[0]).not.toHaveProperty("status");
    });

    it("state desconhecido → linha mantida, state ausente", () => {
      const list = one({ ...base, state: "starting", status: "busy" });
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty("state");
      expect(list[0]?.status).toBe("busy");
    });

    it("kind desconhecido → deduzido pela presença de id", () => {
      expect(one({ ...base, kind: "remote" })[0]?.kind).toBe("interactive");
      expect(one({ ...base, kind: null, id: "aaaa1111" })[0]).toMatchObject({ kind: "background", bgId: "aaaa1111" });
    });

    it("sem sessionId ou sem cwd → linha descartada", () => {
      expect(one({ ...base, sessionId: undefined })).toEqual([]);
      expect(one({ ...base, cwd: undefined })).toEqual([]);
      expect(one({ ...base, sessionId: null })).toEqual([]);
    });
  });

  it("JSON inválido → []", () => {
    expect(parseAgentsJson("")).toEqual([]);
    expect(parseAgentsJson("not json")).toEqual([]);
  });
});

describe("Inventory", () => {
  it("emite changed só quando a lista muda e waitFor resolve", async () => {
    const outputs = [windows, windows, linux];
    let i = 0;
    const run = (): Promise<ExecResult> => Promise.resolve({ code: 0, stdout: outputs[Math.min(i++, outputs.length - 1)] ?? "", stderr: "" });
    const inv = new Inventory({ pollMs: 10, run });
    const sizes: number[] = [];
    const errors: unknown[] = [];
    inv.on("changed", (list: SessionInfo[]) => sizes.push(list.length));
    inv.on("error", (e: unknown) => errors.push(e));
    inv.start();
    try {
      const s = await inv.waitFor((x) => x.name === "correcoes-bugs", 2000);
      expect(s.pid).toBe(2172608);
      expect(sizes).toEqual([1, 3]);
      expect(inv.find("85285a68-454d-45d5-aa79-4c7a4cd594d4")?.bgId).toBe("85285a68");
      expect(inv.current()).toHaveLength(3);
      expect(errors).toEqual([]);
    } finally {
      inv.stop();
    }
  });

  it("enrich roda a cada poll: só o nome enriquecido mudar (um /rename) já emite changed", async () => {
    let title = "CRM integração";
    const inv = new Inventory({
      run: () => Promise.resolve({ code: 0, stdout: windows, stderr: "" }),
      enrich: (l) => l.map((s, i) => (i === 0 ? { ...s, name: title } : s)),
    });
    const seen: string[] = [];
    inv.on("changed", (l: SessionInfo[]) => { seen.push(l[0]?.name ?? ""); });
    await inv.poll();
    await inv.poll();
    title = "CRM-Onda5";
    await inv.poll();
    expect(seen).toEqual(["CRM integração", "CRM-Onda5"]);
    expect(inv.current()[0]?.name).toBe("CRM-Onda5");
  });

  it("waitFor rejeita no timeout", async () => {
    const inv = new Inventory({ pollMs: 10, run: () => Promise.resolve({ code: 0, stdout: windows, stderr: "" }) });
    inv.start();
    try {
      await expect(inv.waitFor((x) => x.name === "nunca", 50)).rejects.toThrow("sessão não apareceu no inventário a tempo");
    } finally {
      inv.stop();
    }
  });

  it("poll emite error sem lançar quando o comando falha", async () => {
    const inv = new Inventory({ run: () => Promise.reject(new Error("boom")) });
    const errors: unknown[] = [];
    inv.on("error", (e: unknown) => errors.push(e));
    await expect(inv.poll()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
