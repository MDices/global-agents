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
    expect(list[2]).toMatchObject({ bgId: "85285a68", kind: "background", status: "waiting", waitingFor: "permission prompt" });
    const interactive = list.find((s) => s.kind === "interactive");
    expect(interactive?.name).toBe("correcoes-bugs");
    expect(interactive).not.toHaveProperty("bgId");
  });

  it("preserva cwd do windows", () => {
    expect(parseAgentsJson(windows)[0]?.cwd).toBe("C:\\Users\\Admin\\CDT\\gestai");
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
