import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const UNIT_NAME = "global-agents.service";

/** Fonte única da unidade; deploy/agent/global-agents.service é uma cópia verificada por teste. */
export const UNIT_TEMPLATE = `[Unit]
Description=global-agents (Claude Code ↔ Discord)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%NODE% %CLI% run%CONFIG%
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

/** Regras do systemd: `%` vira `%%`; com espaço/aspas/barra invertida o argumento vai entre aspas. */
export function quoteExecArg(arg: string): string {
  const s = arg.replace(/%/g, "%%");
  if (!/[\s"'\\]/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `configPath` só entra na unidade quando não é o padrão (o chamador passa undefined nesse caso). */
export function renderUnit(node: string, cli: string, configPath?: string): string {
  const cfg = configPath === undefined ? "" : ` --config ${quoteExecArg(configPath)}`;
  return UNIT_TEMPLATE.replace("%NODE%", () => quoteExecArg(node)).replace("%CLI%", () => quoteExecArg(cli))
    .replace("%CONFIG%", () => cfg);
}

export function unitPath(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "systemd", "user", UNIT_NAME);
}

export function installUnit(path: string, node: string, cli: string, configPath?: string): "written" | "unchanged" {
  const text = renderUnit(node, cli, configPath);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return "unchanged";
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
  return "written";
}

export function uninstallUnit(path: string): "removed" | "absent" | "foreign" {
  if (!existsSync(path)) return "absent";
  if (!readFileSync(path, "utf8").includes("global-agents")) return "foreign";
  rmSync(path);
  return "removed";
}
