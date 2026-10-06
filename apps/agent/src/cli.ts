#!/usr/bin/env node
import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_PATH, installConfig, loadConfig, saveConfig } from "./config.js";
import { defaultDeps, runDoctor } from "./doctor.js";
import { installHooks, scriptCommandFor, uninstallHooks } from "./hooks/install.js";
import { machineId } from "./machine.js";
import { createAgent } from "./main.js";
import { installUnit, uninstallUnit, unitPath } from "./service/systemd.js";

const USAGE = `uso: global-agents <comando> [opções]

comandos:
  install --relay <url> --token <token> [--fingerprint <fp>] [--project <dir>]... [--service]
            grava a config, copia os scripts de hook e instala os hooks do Claude Code;
            --service (Linux) também grava a unidade systemd --user
  uninstall [--service]
            remove os hooks do Claude Code (a config é mantida); --service remove a unidade systemd
  run       roda o agente em primeiro plano
  doctor    diagnostica o ambiente (claude, hooks, sockets, relay); sai 1 se algo falhar
  status    mostra a config (sem o token) e se o agente está rodando

opção global: --config <arquivo> (padrão ${DEFAULT_CONFIG_PATH})`;

class UsageError extends Error {}

interface Args {
  flags: Map<string, string[]>;
  service: boolean;
}

const KNOWN = new Set(["--relay", "--token", "--fingerprint", "--project", "--config"]);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string[]>();
  let service = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] ?? "";
    if (k === "--service") { service = true; continue; }
    if (!KNOWN.has(k)) throw new UsageError(`opção desconhecida: ${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`a opção ${k} precisa de um valor`);
    flags.set(k, [...(flags.get(k) ?? []), v]);
    i++;
  }
  return { flags, service };
}

function one(a: Args, k: string): string | undefined {
  const v = a.flags.get(k);
  if (v !== undefined && v.length > 1) throw new UsageError(`a opção ${k} só pode aparecer uma vez`);
  return v?.[0];
}

function configPath(a: Args): string {
  return resolve(one(a, "--config") ?? DEFAULT_CONFIG_PATH);
}

function installService(configFile: string): void {
  if (process.platform !== "linux") {
    console.log("nota: --service só existe no Linux (systemd --user); nada foi feito nesta plataforma");
    return;
  }
  const cli = fileURLToPath(import.meta.url);
  const path = unitPath(process.env, homedir());
  const custom = configFile === resolve(DEFAULT_CONFIG_PATH) ? undefined : configFile;
  if (installUnit(path, process.execPath, cli, custom) === "unchanged") console.log(`unidade já instalada em ${path}`);
  else console.log(`unidade gravada em ${path}`);
  console.log(`\npara ativar (não executei nada), rode:
  systemctl --user daemon-reload && systemctl --user enable --now global-agents
  loginctl enable-linger $USER

o linger mantém o agente rodando e o inicia no boot mesmo sem uma sessão aberta.\n\nse trocar a versão do Node, reexecute 'install --service' para atualizar o caminho do Node na unidade.`);
}

function uninstallService(): void {
  if (process.platform !== "linux") {
    console.log("nota: --service só existe no Linux (systemd --user); nada foi feito nesta plataforma");
    return;
  }
  const path = unitPath(process.env, homedir());
  const r = uninstallUnit(path);
  if (r === "absent") console.log(`nenhuma unidade em ${path}`);
  else if (r === "foreign") console.warn(`aviso: ${path} não é do global-agents; mantida`);
  else console.log(`unidade removida de ${path}`);
  if (r !== "foreign") console.log("\npara parar e desativar, rode (antes de remover, se ainda estiver ativa):\n  systemctl --user disable --now global-agents");
}

function install(a: Args): void {
  const relayUrl = one(a, "--relay");
  const token = one(a, "--token");
  if (relayUrl === undefined || token === undefined) throw new UsageError("install exige --relay e --token");
  const fingerprint = one(a, "--fingerprint");
  const path = configPath(a);
  // Reinstalar mantém o que não foi passado agora (machineName, porta, dataDir…).
  const previous = existsSync(path) ? loadConfig(path) : undefined;
  const projects = (a.flags.get("--project") ?? []).map((p) => resolve(p));
  const { cfg, warnings } = installConfig(previous, {
    relayUrl, token, projects, ...(fingerprint !== undefined ? { fingerprint } : {}),
  });
  for (const w of warnings) console.warn(`aviso: ${w}`);
  saveConfig(cfg, path);
  console.log(`config gravada em ${path}`);

  const scriptsSrc = fileURLToPath(new URL("./hooks/scripts/", import.meta.url));
  if (!existsSync(scriptsSrc)) throw new Error(`scripts de hook não encontrados em ${scriptsSrc}; rode o build do agente`);
  const hooksDir = join(cfg.dataDir, "hooks");
  cpSync(scriptsSrc, hooksDir, { recursive: true });
  console.log(`scripts de hook copiados para ${hooksDir}`);

  const r = installHooks({ scriptCommand: scriptCommandFor(process.platform, hooksDir) });
  if (r.changes.length === 0) console.log(`hooks já estavam instalados em ${r.path}`);
  else {
    console.log(`hooks em ${r.path}:`);
    for (const c of r.changes) console.log(`  - ${c}`);
  }
  if (a.service) installService(path);
}

function uninstall(a: Args): void {
  const r = uninstallHooks();
  if (r.removed.length === 0) console.log("nenhum hook do global-agents encontrado");
  else console.log(`hooks removidos: ${r.removed.join(", ")}`);
  console.warn("aviso: crossSessionInbound foi mantido em ~/.claude/settings.json; remova manualmente se quiser");
  if (a.service) uninstallService();
}

async function run(a: Args): Promise<void> {
  const cfg = loadConfig(configPath(a));
  const agent = createAgent(cfg);
  await agent.start();
  console.log(`agente ${machineId(cfg)} rodando; hooks em http://127.0.0.1:${cfg.port} e relay ${cfg.relayUrl}`);
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    console.log("encerrando o agente…");
    agent.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function status(a: Args): Promise<number> {
  const path = configPath(a);
  const cfg = loadConfig(path);
  console.log(`config:      ${path}`);
  console.log(`máquina:     ${machineId(cfg)}`);
  console.log(`relay:       ${cfg.relayUrl}`);
  console.log(`certificado: ${cfg.relayCertFingerprint !== undefined ? `fixado (${cfg.relayCertFingerprint})` : "não fixado"}`);
  console.log(`projetos:    ${cfg.projects.length > 0 ? cfg.projects.join(", ") : "nenhum"}`);
  console.log(`porta local: ${cfg.port}`);
  console.log(`dados:       ${cfg.dataDir}`);
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { ok?: unknown; version?: unknown };
    if (res.ok && body.ok === true) {
      console.log(`agente:      rodando (versão ${typeof body.version === "string" ? body.version : "desconhecida"})`);
      return 0;
    }
  } catch {
    // não está rodando
  }
  console.log("agente:      não está rodando");
  return 1;
}

async function doctor(a: Args): Promise<number> {
  const path = configPath(a);
  let claudeBin: string | undefined;
  try { claudeBin = loadConfig(path).claudeBin; } catch { /* o check de config reporta */ }
  const checks = await runDoctor(defaultDeps(path, claudeBin));
  for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name.padEnd(24)} ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed === 0 ? "\ntudo certo" : `\n${failed} problema(s) encontrado(s)`);
  return failed === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return cmd === undefined ? 1 : 0;
  }
  const a = parseArgs(rest);
  if (a.service && cmd !== "install" && cmd !== "uninstall") throw new UsageError("--service só vale para install e uninstall");
  switch (cmd) {
    case "install":
      install(a);
      return 0;
    case "uninstall":
      if (a.flags.size > 0) throw new UsageError("uninstall só aceita --service");
      uninstall(a);
      return 0;
    case "run":
      await run(a);
      return -1; // continua rodando até SIGINT/SIGTERM
    case "status":
      return status(a);
    case "doctor":
      return doctor(a);
    default:
      throw new UsageError(`comando desconhecido: ${cmd}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { if (code >= 0) process.exitCode = code; },
  (e: unknown) => {
    console.error(`erro: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof UsageError) console.error(`\n${USAGE}`);
    process.exit(1);
  },
);
