import { describe, expect, it } from "vitest";
import {
  TASK_NAME, buildTaskArgs, killOrphanNodeArgs, killOrphanNodeScript, buildTaskXml, encodeTaskXml, runWindowsService, schtasksCreateArgs, schtasksDeleteArgs,
  schtasksEndArgs, serviceBackend, windowsUserId, xmlEscape, type WindowsServiceRun,
} from "../src/service/windows.js";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const CLI = "C:\\Users\\João Silva\\global-agents\\apps\\agent\\dist\\cli.js";
const USER = "TONELI-PC\\Admin";

describe("buildTaskArgs", () => {
  it("usa conhost --headless e cita node/cli", () => {
    expect(buildTaskArgs({ node: NODE, cli: CLI })).toBe(`--headless "${NODE}" "${CLI}" run`);
  });
  it("inclui --config entre aspas", () => {
    expect(buildTaskArgs({ node: NODE, cli: CLI, config: "C:\\a b\\c.json" })).toBe(`--headless "${NODE}" "${CLI}" run --config "C:\\a b\\c.json"`);
  });
});

describe("buildTaskXml", () => {
  const xml = buildTaskXml({ userId: USER, command: "conhost.exe", args: buildTaskArgs({ node: NODE, cli: CLI }), workingDir: "C:\\x" });
  it("gatilho e principal do mesmo usuário, token interativo, sem elevação", () => {
    expect(xml.match(/<UserId>TONELI-PC\\Admin<\/UserId>/g)).toHaveLength(2);
    expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>TONELI-PC\\Admin<\/UserId>\s*<\/LogonTrigger>/);
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });
  it("configurações de daemon", () => {
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>/);
  });
  it("ação via conhost --headless com diretório de trabalho", () => {
    expect(xml).toContain("<Command>conhost.exe</Command>");
    expect(xml).toContain(`<Arguments>--headless &quot;${NODE}&quot; &quot;${CLI}&quot; run</Arguments>`);
    expect(xml).toContain("<WorkingDirectory>C:\\x</WorkingDirectory>");
  });
  it("escapa & < > e aspas nos valores", () => {
    expect(xmlEscape(`a&b<c>"d"'e'`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
    const x = buildTaskXml({ userId: "D\\a&b", command: "c", args: "<x>", workingDir: "C:\\R&D" });
    expect(x).toContain("D\\a&amp;b");
    expect(x).toContain("<Arguments>&lt;x&gt;</Arguments>");
    expect(x).toContain("C:\\R&amp;D");
  });
});

describe("encodeTaskXml", () => {
  it("UTF-16 LE com BOM, preservando acentos", () => {
    const b = encodeTaskXml("<a>João</a>");
    expect([b[0], b[1]]).toEqual([0xff, 0xfe]);
    expect(b.subarray(2).toString("utf16le")).toBe("<a>João</a>");
  });
});

describe("argv do schtasks e usuário", () => {
  it("create/end/delete", () => {
    expect(schtasksCreateArgs("C:\\t.xml")).toEqual(["/Create", "/TN", TASK_NAME, "/XML", "C:\\t.xml", "/F"]);
    expect(schtasksEndArgs()).toEqual(["/End", "/TN", "global-agents"]);
    expect(schtasksDeleteArgs()).toEqual(["/Delete", "/TN", "global-agents", "/F"]);
  });
  it("windowsUserId", () => {
    expect(windowsUserId({ USERDOMAIN: "PC", USERNAME: "Admin" })).toBe("PC\\Admin");
    expect(windowsUserId({ USERNAME: "Admin" })).toBe("Admin");
    expect(() => windowsUserId({})).toThrow();
  });
  it("serviceBackend", () => {
    expect(serviceBackend("linux")).toBe("systemd");
    expect(serviceBackend("win32")).toBe("schtasks");
    expect(serviceBackend("darwin")).toBe("none");
  });
});

describe("runWindowsService", () => {
  function mk(over: Partial<WindowsServiceRun>) {
    const calls: Array<[string, string[]]> = [];
    const out: string[] = [];
    const written: Array<{ name: string; data: Buffer }> = [];
    let cleaned = 0;
    const run: WindowsServiceRun = {
      action: "install", apply: false, node: NODE, cli: CLI, userId: USER, workingDir: "C:\\w",
      log: (s) => out.push(s),
      exec: async (f, a) => { calls.push([f, a]); },
      writeTemp: (name, data) => { written.push({ name, data }); return { path: "C:\\tmp\\t.xml", cleanup: () => { cleaned++; } }; },
      ...over,
    };
    return { run, calls, out, written, cleaned: () => cleaned };
  }
  it("install sem apply imprime o XML e não executa", async () => {
    const m = mk({});
    await runWindowsService(m.run);
    expect(m.calls).toEqual([]);
    expect(m.written).toEqual([]);
    expect(m.out.join("\n")).toContain("<LogonTrigger>");
    expect(m.out.join("\n")).toContain("--apply");
  });
  it("install com apply grava XML UTF-16, chama schtasks /XML e limpa", async () => {
    const m = mk({ apply: true });
    await runWindowsService(m.run);
    expect(m.calls).toEqual([["schtasks", schtasksCreateArgs("C:\\tmp\\t.xml")]]);
    expect(m.written[0]?.data[0]).toBe(0xff);
    expect(m.cleaned()).toBe(1);
  });
  it("limpa o temporário mesmo se o schtasks falhar", async () => {
    const m = mk({ apply: true, exec: async () => { throw new Error("boom"); } });
    await expect(runWindowsService(m.run)).rejects.toThrow("boom");
    expect(m.cleaned()).toBe(1);
  });
  it("uninstall com apply faz /End (ignorando falha) e depois /Delete", async () => {
    const calls: string[][] = [];
    const m = mk({ action: "uninstall", apply: true, exec: async (_f, a) => { calls.push(a); if (a[0] === "/End") throw new Error("não está rodando"); } });
    await runWindowsService(m.run);
    expect(calls).toEqual([schtasksEndArgs(), killOrphanNodeArgs(CLI), schtasksDeleteArgs()]);
  });
  it("uninstall: powershell sem shell, argumentos em array, filtrando pelo cli.js", async () => {
    const calls: Array<[string, string[]]> = [];
    const m = mk({ action: "uninstall", apply: true, exec: async (f, a) => { calls.push([f, a]); } });
    await runWindowsService(m.run);
    expect(calls[1]?.[0]).toBe("powershell.exe");
    expect(calls[1]?.[1].slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(calls[1]?.[1][3]).toContain(CLI);
  });
  it("uninstall: falha ao encerrar o node vira aviso e o /Delete continua", async () => {
    const calls: string[] = [];
    const m = mk({ action: "uninstall", apply: true, exec: async (f, a) => { calls.push(f === "schtasks" ? a[0]! : f); if (f === "powershell.exe") throw new Error("sem powershell"); } });
    await runWindowsService(m.run);
    expect(calls).toEqual(["/End", "powershell.exe", "/Delete"]);
    expect(m.out.join("\n")).toContain("aviso: não consegui encerrar o node órfão");
    expect(m.out.join("\n")).toContain("parada e removida");
  });
  it("uninstall sem apply imprime também o passo do node", async () => {
    const m = mk({ action: "uninstall" });
    await runWindowsService(m.run);
    expect(m.calls).toEqual([]);
    expect(m.out.join("\n")).toContain("Get-CimInstance Win32_Process");
  });
});

describe("killOrphanNodeScript", () => {
  it("escapa aspa simples do caminho e não usa aspas duplas", () => {
    const sc = killOrphanNodeScript("C:\\Users\\O'Neil\\cli.js");
    expect(sc).toContain("'C:\\Users\\O''Neil\\cli.js'");
    expect(sc).not.toContain('"');
    expect(sc).toContain("\\x22?\\s+run");
  });
});
