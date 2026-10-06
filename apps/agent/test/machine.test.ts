import { MACHINE_RE } from "@global-agents/protocol";
import { describe, expect, it } from "vitest";
import { machineId, normalizePart } from "../src/machine.js";

describe("machine", () => {
  it("machineId normaliza nome e usuário", () => {
    expect(machineId({ machineName: "Toneli PC" }, "Admin")).toBe("toneli-pc/admin");
  });
  it("machineId default casa com MACHINE_RE", () => {
    expect(MACHINE_RE.test(machineId({}, "leonardo"))).toBe(true);
  });
  it("normalizePart", () => {
    expect(normalizePart("Léo_PC 01")).toBe("l-o_pc-01");
  });
});
