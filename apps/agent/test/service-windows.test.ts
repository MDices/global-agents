import { describe, expect, it } from "vitest";
import {
  TASK_NAME, buildTaskCommand, formatCommandLine, runWindowsService, schtasksCreateArgs, schtasksDeleteArgs, serviceBackend,
} from "../src/service/windows.js";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const CLI = "C:\\Users\\João Silva\\global-agents\\apps\\agent\\dist\\cli.js";

describe("buildTaskCommand", () => {
  it("cita node e cli e termina em run, sem config", () => {
    expect(buildTaskCommand({ node: NODE, cli: CLI })).toBe(`"${NODE}" "${CLI}" run`);
  });
  it("inclui --config entre aspas quando informado", () => {
    const cfg = "C:\\Users\\João Silva\\.global-agents\\config.json";
    expect(buildTaskCommand({ node: NODE, cli: CLI, config: cfg })).toBe(`"${NODE}" "${CLI}" run --config "${cfg}"`);
  });
});

describe("schtasksCreateArgs / schtasksDeleteArgs", () => {
  it("monta argv sem shell, com o comando como único argumento de /TR", () => {
    const cmd = buildTaskCommand({ node: NODE, cli: CLI });
    expect(schtasksCreateArgs({ node: NODE, cli: CLI })).toEqual([
      "/Create", "/TN", TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", cmd, "/F",
    ]);
  });
  it("delete usa /F", () => {
    expect(schtasksDeleteArgs()).toEqual(["/Delete", "/TN", "global-agents", "/F"]);
  });
});

describe("formatCommandLine", () => {
  it("escapa aspas internas com \\\" e cita args com espaço (cmd.exe)", () => {
    const line = formatCommandLine("schtasks", schtasksCreateArgs({ node: NODE, cli: CLI }));
    expect(line).toContain(`/TR "\\"${NODE}\\" \\"${CLI}\\" run"`);
    expect(line.startsWith("schtasks /Create /TN global-agents /SC ONLOGON /RL LIMITED /TR ")).toBe(true);
    expect(line.endsWith(" /F")).toBe(true);
  });
});

describe("serviceBackend", () => {
  it("roteia por plataforma", () => {
    expect(serviceBackend("linux")).toBe("systemd");
    expect(serviceBackend("win32")).toBe("schtasks");
    expect(serviceBackend("darwin")).toBe("none");
  });
});

describe("runWindowsService", () => {
  it("sem apply só imprime e não executa", async () => {
    const calls: string[][] = [];
    const out: string[] = [];
    await runWindowsService({ action: "install", apply: false, node: NODE, cli: CLI, log: (s) => out.push(s), exec: async (_f, a) => { calls.push(a); } });
    expect(calls).toEqual([]);
    expect(out.join("\n")).toContain("schtasks /Create");
    expect(out.join("\n")).toContain("--apply");
  });
  it("com apply chama exec com schtasks e o argv", async () => {
    const calls: Array<[string, string[]]> = [];
    await runWindowsService({ action: "install", apply: true, node: NODE, cli: CLI, config: "C:\\c.json", log: () => undefined, exec: async (f, a) => { calls.push([f, a]); } });
    expect(calls).toEqual([["schtasks", schtasksCreateArgs({ node: NODE, cli: CLI, config: "C:\\c.json" })]]);
  });
  it("uninstall com apply remove a tarefa", async () => {
    const calls: Array<[string, string[]]> = [];
    await runWindowsService({ action: "uninstall", apply: true, node: NODE, cli: CLI, log: () => undefined, exec: async (f, a) => { calls.push([f, a]); } });
    expect(calls).toEqual([["schtasks", schtasksDeleteArgs()]]);
  });
});
