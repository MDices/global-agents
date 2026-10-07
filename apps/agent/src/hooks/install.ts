import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MARKER = "global-agents-hook";
const EVENTS = ["UserPromptSubmit", "Notification", "Stop", "SessionEnd", "PermissionRequest"] as const;
const DEFAULT_CROSS_SESSION = "accept";

export type InstallStatus = "installed" | "already-present" | "updated";

export interface HookOpts {
  settingsPath?: string;
}

function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strictObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new Error(`settings.json inválido: ${where} deveria ser um objeto`);
}

function strictArray(v: unknown, where: string): unknown[] {
  if (Array.isArray(v)) return v;
  throw new Error(`settings.json inválido: ${where} deveria ser um array`);
}

function timeoutFor(event: string): number {
  return event === "PermissionRequest" ? 1800 : 5;
}

/** Arquivo ausente → {}. JSON inválido propaga o erro (nunca sobrescrevemos config do usuário). */
function readJsonOrEmpty(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} não contém um objeto JSON`);
  }
  return parsed as Record<string, unknown>;
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function isOurs(entry: unknown): boolean {
  return asArray(asObject(entry)["hooks"]).some((h) => {
    const cmd = asObject(h)["command"];
    return typeof cmd === "string" && cmd.includes(MARKER);
  });
}

export function installHooks(opts: HookOpts & { scriptCommand: string }): {
  status: InstallStatus;
  path: string;
  changes: string[];
} {
  const path = opts.settingsPath ?? defaultSettingsPath();
  const settings = readJsonOrEmpty(path);
  const hooks = settings["hooks"] === undefined ? {} : strictObject(settings["hooks"], "hooks");
  const changes: string[] = [];
  let hadOurs = false;

  for (const ev of EVENTS) {
    const entries = hooks[ev] === undefined ? [] : strictArray(hooks[ev], `hooks.${ev}`);
    const timeout = timeoutFor(ev);
    if (entries.some(isOurs)) {
      hadOurs = true;
      let stale = false;
      for (const entry of entries) {
        for (const h of asArray(asObject(entry)["hooks"])) {
          const hook = h as Record<string, unknown>;
          const cmd = asObject(hook)["command"];
          if (typeof cmd !== "string" || !cmd.includes(MARKER)) continue;
          if (cmd !== opts.scriptCommand || hook["timeout"] !== timeout) {
            hook["command"] = opts.scriptCommand;
            hook["timeout"] = timeout;
            stale = true;
          }
        }
      }
      if (stale) changes.push(`hook ${ev} atualizado`);
      continue;
    }
    hooks[ev] = [...entries, { hooks: [{ type: "command", command: opts.scriptCommand, timeout }] }];
    changes.push(`adicionado hook ${ev}`);
  }
  if (changes.length > 0) settings["hooks"] = hooks;

  const current = settings["crossSessionInbound"];
  if (current === undefined) {
    settings["crossSessionInbound"] = DEFAULT_CROSS_SESSION;
    changes.push(`crossSessionInbound definido como ${DEFAULT_CROSS_SESSION}`);
  } else if (current !== DEFAULT_CROSS_SESSION) {
    changes.push(`crossSessionInbound mantido em ${JSON.stringify(current)}`);
  }

  const modified = changes.some((c) => !c.startsWith("crossSessionInbound mantido"));
  if (modified) writeJsonAtomic(path, settings);

  const status: InstallStatus = !modified ? "already-present" : hadOurs ? "updated" : "installed";
  return { status, path, changes };
}

export function uninstallHooks(opts: HookOpts = {}): { removed: string[] } {
  const path = opts.settingsPath ?? defaultSettingsPath();
  const removed: string[] = [];
  if (!existsSync(path)) return { removed };
  const settings = readJsonOrEmpty(path);
  const hooks = asObject(settings["hooks"]);

  for (const ev of Object.keys(hooks)) {
    const entries = asArray(hooks[ev]);
    const kept: unknown[] = [];
    let touched = false;
    for (const entry of entries) {
      if (!isOurs(entry)) {
        kept.push(entry);
        continue;
      }
      touched = true;
      const obj = asObject(entry);
      const rest = asArray(obj["hooks"]).filter((h) => {
        const cmd = asObject(h)["command"];
        return !(typeof cmd === "string" && cmd.includes(MARKER));
      });
      if (rest.length > 0) kept.push({ ...obj, hooks: rest });
    }
    if (!touched) continue;
    removed.push(ev);
    if (kept.length > 0) hooks[ev] = kept;
    else delete hooks[ev];
  }

  if (removed.length > 0) {
    settings["hooks"] = hooks;
    writeJsonAtomic(path, settings);
  }
  return { removed };
}

export function scriptCommandFor(platform: NodeJS.Platform, scriptsDir: string): string {
  if (platform === "win32") {
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptsDir}\\${MARKER}.ps1"`;
  }
  return `bash "${scriptsDir}/${MARKER}.sh"`;
}
