import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installUnit, quoteExecArg, renderUnit, uninstallUnit, unitPath, UNIT_TEMPLATE,
} from "../src/service/systemd.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ga-unit-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NODE = "/usr/bin/node";
const CLI = "/home/u/.global-agents/app/dist/cli.js";

describe("renderUnit", () => {
  it("gera as três seções com os valores esperados", () => {
    const t = renderUnit(NODE, CLI);
    expect(t).toContain("[Unit]\nDescription=global-agents (Claude Code ↔ Discord)\nAfter=network-online.target\nWants=network-online.target");
    expect(t).toContain(`[Service]\nExecStart=${NODE} ${CLI} run\nRestart=on-failure\nRestartSec=5\nEnvironment=NODE_ENV=production`);
    expect(t).toContain("[Install]\nWantedBy=default.target");
    expect(t).not.toMatch(/token/i);
  });

  it("cita caminhos com espaço e escapa % e aspas", () => {
    expect(quoteExecArg("/a b/node")).toBe('"/a b/node"');
    expect(quoteExecArg("/a/100%/x")).toBe("/a/100%%/x");
    expect(quoteExecArg("/a/$HOME/x")).toBe("/a/$$HOME/x");
    expect(quoteExecArg("/a b/${X}")).toBe('"/a b/$${X}"');
    expect(quoteExecArg("/a\\b")).toBe('"/a\\\\b"');
    expect(quoteExecArg('/a"b')).toBe('"/a\\"b"');
    expect(renderUnit("/o p/node", CLI)).toContain(`ExecStart="/o p/node" ${CLI} run`);
  });

  it("config padrão não aparece; config customizada vira --config absoluto (com aspas se preciso)", () => {
    expect(renderUnit(NODE, CLI)).toContain(`${CLI} run\n`);
    expect(renderUnit(NODE, CLI, "/etc/ga/c.json")).toContain(`ExecStart=${NODE} ${CLI} run --config /etc/ga/c.json\n`);
    expect(renderUnit(NODE, CLI, "/a b/c.json")).toContain(`run --config "/a b/c.json"\n`);
  });

  it("o template estático em deploy/ é o mesmo texto da função", () => {
    const file = readFileSync(new URL("../../../deploy/agent/global-agents.service", import.meta.url), "utf8");
    expect(file).toBe(UNIT_TEMPLATE);
    expect(file.replace("%NODE%", NODE).replace("%CLI%", CLI).replace("%CONFIG%", "")).toBe(renderUnit(NODE, CLI));
  });
});

describe("unitPath", () => {
  it("respeita XDG_CONFIG_HOME e cai em ~/.config", () => {
    expect(unitPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u")).toBe("/x/cfg/systemd/user/global-agents.service");
    expect(unitPath({}, "/home/u")).toBe("/home/u/.config/systemd/user/global-agents.service");
    expect(unitPath({ XDG_CONFIG_HOME: "relativo" }, "/home/u")).toBe("/home/u/.config/systemd/user/global-agents.service");
  });
});

describe("installUnit / uninstallUnit", () => {
  it("grava, é idempotente e atualiza quando o conteúdo muda", () => {
    const path = join(tmp(), "systemd/user/global-agents.service");
    expect(installUnit(path, NODE, CLI)).toBe("written");
    expect(readFileSync(path, "utf8")).toBe(renderUnit(NODE, CLI));
    expect(installUnit(path, NODE, CLI)).toBe("unchanged");
    expect(installUnit(path, "/opt/node", CLI)).toBe("written");
    expect(readFileSync(path, "utf8")).toContain("ExecStart=/opt/node ");
  });

  it("uninstall remove só a unidade nossa", () => {
    const d = tmp();
    const path = join(d, "global-agents.service");
    expect(uninstallUnit(path)).toBe("absent");
    installUnit(path, NODE, CLI);
    expect(uninstallUnit(path)).toBe("removed");
    expect(existsSync(path)).toBe(false);
    mkdirSync(d, { recursive: true });
    const foreign = "[Unit]\nDescription=outra coisa\n# veja global-agents\n[Service]\nExecStart=/bin/true\n";
    writeFileSync(path, foreign);
    expect(uninstallUnit(path)).toBe("foreign");
    expect(installUnit(path, NODE, CLI)).toBe("foreign");
    expect(readFileSync(path, "utf8")).toBe(foreign);
  });
});
