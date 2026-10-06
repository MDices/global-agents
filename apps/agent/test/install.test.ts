import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installHooks, scriptCommandFor, uninstallHooks } from "../src/hooks/install.js";

const CMD = "bash /opt/ga/global-agents-hook.sh";
const PET = "bash /x/global-pets-claude-hook.sh";

function tmpSettings(content?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ga-inst-"));
  const p = join(dir, "settings.json");
  if (content !== undefined) writeFileSync(p, JSON.stringify(content, null, 2) + "\n");
  return p;
}

interface Settings {
  hooks: Record<string, { hooks: { type: string; command: string; timeout?: number }[] }[]>;
  crossSessionInbound?: string;
  permissions?: unknown;
}

function read(p: string): Settings {
  return JSON.parse(readFileSync(p, "utf8")) as Settings;
}

describe("installHooks", () => {
  it("cria o arquivo inexistente com os 5 eventos", () => {
    const p = tmpSettings();
    const r = installHooks({ settingsPath: p, scriptCommand: CMD });
    expect(r.status).toBe("installed");
    expect(r.path).toBe(p);
    const s = read(p);
    for (const ev of ["UserPromptSubmit", "Notification", "Stop", "SessionEnd", "PermissionRequest"]) {
      expect(s.hooks[ev]).toHaveLength(1);
    }
    expect(s.crossSessionInbound).toBe("accept");
    expect(s.hooks["PermissionRequest"]![0]!.hooks[0].timeout).toBe(1800);
    expect(s.hooks["Stop"]![0]!.hooks[0].timeout).toBe(5);
    expect(s.hooks["Stop"]![0]!.hooks[0].command).toBe(CMD);
    expect(r.changes).toContain("adicionado hook Stop");
    expect(r.changes).toContain("crossSessionInbound definido como accept");
  });

  it("preserva hook do global-pets e outras chaves", () => {
    const pet = { hooks: [{ type: "command", command: PET }] };
    const p = tmpSettings({ permissions: { allow: ["Bash(git *)"] }, hooks: { Stop: [pet] } });
    installHooks({ settingsPath: p, scriptCommand: CMD });
    const s = read(p);
    expect(s.hooks["Stop"]).toHaveLength(2);
    expect(s.hooks["Stop"]![0]!).toEqual(pet);
    expect(s.permissions).toEqual({ allow: ["Bash(git *)"] });
  });

  it("é idempotente byte a byte", () => {
    const p = tmpSettings();
    installHooks({ settingsPath: p, scriptCommand: CMD });
    const before = readFileSync(p);
    const r = installHooks({ settingsPath: p, scriptCommand: CMD });
    expect(r.status).toBe("already-present");
    expect(r.changes).toEqual([]);
    expect(readFileSync(p).equals(before)).toBe(true);
  });

  it("não sobrescreve crossSessionInbound explícito", () => {
    const p = tmpSettings({ crossSessionInbound: "hold" });
    const r = installHooks({ settingsPath: p, scriptCommand: CMD });
    expect(read(p).crossSessionInbound).toBe("hold");
    expect(r.changes).toContain('crossSessionInbound mantido em "hold"');
  });

  it("não deixa arquivo temporário para trás", () => {
    const p = tmpSettings();
    installHooks({ settingsPath: p, scriptCommand: CMD });
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });
});

describe("uninstallHooks", () => {
  it("remove só as entradas global-agents-hook", () => {
    const pet = { hooks: [{ type: "command", command: PET }] };
    const p = tmpSettings({ crossSessionInbound: "accept", hooks: { Stop: [pet] } });
    installHooks({ settingsPath: p, scriptCommand: CMD });
    const r = uninstallHooks({ settingsPath: p });
    expect(r.removed).toContain("Stop");
    const s = read(p);
    expect(s.hooks["Stop"]).toEqual([pet]);
    expect(s.hooks["PermissionRequest"]).toBeUndefined();
    expect(s.crossSessionInbound).toBe("accept");
  });
});

describe("scriptCommandFor", () => {
  it("monta o comando por plataforma", () => {
    expect(scriptCommandFor("win32", "C:\\ac\\hooks")).toMatch(/^powershell -NoProfile/);
    expect(scriptCommandFor("win32", "C:\\ac\\hooks")).toContain("C:\\ac\\hooks\\global-agents-hook.ps1");
    expect(scriptCommandFor("linux", "/d")).toBe("bash /d/global-agents-hook.sh");
  });
});
