#!/usr/bin/env node
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_PATH, installConfig, InstallUsageError, loadConfig, normalizeDir, saveConfig } from "./config.js";
import { appendAgentLog, AGENT_LOG, lastErrorLine } from "./agent-log.js";
import { defaultDeps, runDoctor } from "./doctor.js";
import { installHooks, scriptCommandFor, uninstallHooks } from "./hooks/install.js";
import { machineId } from "./machine.js";
import { agentVersion, createAgent } from "./main.js";
import { installUnit, uninstallUnit, unitPath } from "./service/systemd.js";
import { resolveToken } from "./token.js";
import { runWindowsService, serviceBackend, windowsUserId, type WindowsServiceRun } from "./service/windows.js";

const USAGE = `uso: global-agents <comando> [opções]

comandos:
  install [--relay <url>] [--token <token>] [--fingerprint <fp>] [--project <dir>]... [--dev-root <dir>]... [--no-dev-root] [--service]
            grava a config, copia os scripts de hook e instala os hooks do Claude Code;
            --dev-root (repetível) define as pastas raiz de desenvolvimento: tudo dentro delas
            pode virar sessão pelo /novo do Discord, inclusive pasta nova (criar:true), sem
            cadastrar projeto nenhum; aceita ~/dev, caminho relativo e, no Windows, C:/dev;
            com config já gravada, --relay, --token e --fingerprint são opcionais (usa os salvos),
            então "install --dev-root <dir>" só troca as raízes (sem config, --relay e token são
            obrigatórios); --project e --dev-root substituem a lista correspondente, e quem não
            for passado mantém a anterior; --no-dev-root apaga todas as raízes dev;
            --service também grava a unidade systemd --user (Linux) ou mostra o comando do
            Agendador de Tarefas ao logon (Windows; com --apply o schtasks é executado)
  uninstall [--service] [--apply]
            remove os hooks do Claude Code (a config é mantida); --service remove a unidade
            systemd (Linux) ou a tarefa agendada (Windows)
  run       roda o agente em primeiro plano
  doctor    diagnostica o ambiente (claude, hooks, sockets, relay); sai 1 se algo falhar
            o token também pode vir da variável GLOBAL_AGENTS_TOKEN (não fica no histórico do shell)
  status    mostra a config (sem o token) e se o agente está rodando

opção global: --config <arquivo> (padrão ${DEFAULT_CONFIG_PATH})`;

class UsageError extends Error {}

interface Args {
  flags: Map<string, string[]>;
  service: boolean;
  apply: boolean;
  noDevRoot: boolean;
}

const KNOWN = new Set(["--relay", "--token", "--fingerprint", "--project", "--dev-root", "--config"]);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string[]>();
  let service = false;
  let apply = false;
  let noDevRoot = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] ?? "";
    if (k === "--service") { service = true; continue; }
    if (k === "--apply") { apply = true; continue; }
    if (k === "--no-dev-root") { noDevRoot = true; continue; }
    if (!KNOWN.has(k)) throw new UsageError(`opção desconhecida: ${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`a opção ${k} precisa de um valor`);
    flags.set(k, [...(flags.get(k) ?? []), v]);
    i++;
  }
  return { flags, service, apply, noDevRoot };
}

function one(a: Args, k: string): string | undefined {
  const v = a.flags.get(k);
  if (v !== undefined && v.length > 1) throw new UsageError(`a opção ${k} só pode aparecer uma vez`);
  return v?.[0];
}

function configPath(a: Args): string {
  return resolve(one(a, "--config") ?? DEFAULT_CONFIG_PATH);
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
      // A saída do powershell.exe é interna (contagens/PIDs): o runWindowsService a interpreta e monta a mensagem.
      if (stdout.trim() !== "" && file !== "powershell.exe") console.log(stdout.trim());
      if (err) rej(new Error(`${file} falhou: ${stderr.trim() || err.message}`));
      else res(stdout);
    });
  });
}

function winRun(action: "install" | "uninstall", apply: boolean, cli: string, config?: string): WindowsServiceRun {
  return {
    action, apply, node: process.execPath, cli, ...(config !== undefined ? { config } : {}),
    userId: windowsUserId(process.env), workingDir: dirname(cli), log: console.log, exec: execFileAsync,
    writeTemp: (name, data) => {
      const dir = mkdtempSync(join(tmpdir(), "global-agents-"));
      const path = join(dir, name);
      writeFileSync(path, data);
      return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
  };
}

async function installService(configFile: string, apply: boolean): Promise<void> {
  const backend = serviceBackend(process.platform);
  if (backend === "none") {
    console.log("nota: --service só existe no Linux (systemd --user) e no Windows (Agendador de Tarefas); nada foi feito nesta plataforma");
    return;
  }
  const cli = fileURLToPath(import.meta.url);
  if (apply && backend === "systemd") console.warn("aviso: --apply só vale no Windows; no Linux nada é executado (rode os comandos systemctl impressos)");
  if (backend === "schtasks") {
    const custom = configFile === resolve(DEFAULT_CONFIG_PATH) ? undefined : configFile;
    await runWindowsService(winRun("install", apply, cli, custom));
    return;
  }
  const path = unitPath(process.env, homedir());
  const custom = configFile === resolve(DEFAULT_CONFIG_PATH) ? undefined : configFile;
  const r = installUnit(path, process.execPath, cli, custom);
  if (r === "foreign") throw new Error(`${path} já existe e não é do global-agents; não vou sobrescrever (remova ou renomeie o arquivo)`);
  console.log(r === "unchanged" ? `unidade já instalada em ${path}` : `unidade gravada em ${path}`);
  console.log(`\npara ativar (não executei nada), rode:
  systemctl --user daemon-reload && systemctl --user enable --now global-agents
  loginctl enable-linger $USER

o linger mantém o agente rodando e o inicia no boot mesmo sem uma sessão aberta.\n\nse trocar a versão do Node, reexecute 'install --service' para atualizar o caminho do Node na unidade.`);
}

async function uninstallService(apply: boolean): Promise<void> {
  const backend = serviceBackend(process.platform);
  if (backend === "none") {
    console.log("nota: --service só existe no Linux (systemd --user) e no Windows (Agendador de Tarefas); nada foi feito nesta plataforma");
    return;
  }
  if (apply && backend === "systemd") console.warn("aviso: --apply só vale no Windows; no Linux nada é executado (rode os comandos systemctl impressos)");
  if (backend === "schtasks") {
    await runWindowsService(winRun("uninstall", apply, fileURLToPath(import.meta.url)));
    return;
  }
  const path = unitPath(process.env, homedir());
  const r = uninstallUnit(path);
  if (r === "absent") console.log(`nenhuma unidade em ${path}`);
  else if (r === "foreign") console.warn(`aviso: ${path} não é do global-agents; mantida`);
  else console.log(`unidade removida de ${path}`);
  if (r !== "foreign") console.log("\npara parar e desativar, rode (a unidade já foi removida do disco):\n  systemctl --user disable --now global-agents && systemctl --user daemon-reload");
}

/** Avisa (sem falhar) sobre raiz dev que não existe ou não é pasta: ela pode ser criada depois. */
function checkDevRoots(roots: string[]): void {
  for (const r of roots) {
    let isDir = false;
    try { isDir = statSync(r).isDirectory(); } catch { /* não existe */ }
    if (!isDir) console.warn(`aviso: a pasta dev ${r} ${existsSync(r) ? "não é uma pasta" : "não existe"}; ela fica na config, mas o /novo só funciona nela depois que existir`);
  }
}

async function install(a: Args): Promise<void> {
  const relayUrl = one(a, "--relay");
  const token = resolveToken(one(a, "--token"), process.env);
  const fingerprint = one(a, "--fingerprint");
  const path = configPath(a);
  // Reinstalar mantém o que não foi passado agora (relay, token, fingerprint, machineName, porta, dataDir…).
  const previous = existsSync(path) ? loadConfig(path) : undefined;
  // `~`, relativo e (no Windows) `C:/dev` viram caminho absoluto nativo antes de ir para a config.
  const projects = (a.flags.get("--project") ?? []).map((p) => normalizeDir(p));
  const devRoots = [...new Set((a.flags.get("--dev-root") ?? []).map((p) => normalizeDir(p)))];
  checkDevRoots(devRoots);
  let result: ReturnType<typeof installConfig>;
  try {
    result = installConfig(previous, {
      projects, devRoots, ...(a.noDevRoot ? { clearDevRoots: true } : {}),
      ...(relayUrl !== undefined ? { relayUrl } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
    });
  } catch (e) {
    if (e instanceof InstallUsageError) throw new UsageError(e.message);
    throw e;
  }
  const { cfg, warnings } = result;
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
  if (a.service) await installService(path, a.apply);
}

async function uninstall(a: Args): Promise<void> {
  const r = uninstallHooks();
  if (r.removed.length === 0) console.log("nenhum hook do global-agents encontrado");
  else console.log(`hooks removidos: ${r.removed.join(", ")}`);
  console.warn("aviso: crossSessionInbound foi mantido em ~/.claude/settings.json; remova manualmente se quiser");
  if (a.service) await uninstallService(a.apply);
}

async function run(a: Args): Promise<void> {
  let dataDir = dirname(configPath(a));
  const fail = (e: unknown): never => {
    // Windows: a tarefa é headless, então o stderr some; o agent.log é onde o erro de inicialização fica visível.
    appendAgentLog(dataDir, "erro", `falha ao iniciar: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  };
  const cfg = (() => { try { return loadConfig(configPath(a)); } catch (e) { return fail(e); } })();
  dataDir = cfg.dataDir;
  const agent = createAgent(cfg);
  try { await agent.start(); } catch (e) { fail(e); }
  appendAgentLog(dataDir, "info", `agente iniciado (versão ${agentVersion()}, PID ${process.pid})`);
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
  console.log(`raízes dev:  ${cfg.devRoots.length > 0 ? cfg.devRoots.join(", ") : "nenhuma"}`);
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
  const last = lastErrorLine(cfg.dataDir);
  if (last !== undefined) console.log(`último erro: ${last}\n             (log completo: ${join(cfg.dataDir, AGENT_LOG)})`);
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
  if (a.apply && !a.service) throw new UsageError("--apply só vale junto com --service");
  if (a.noDevRoot && cmd !== "install") throw new UsageError("--no-dev-root só vale para install");
  switch (cmd) {
    case "install":
      await install(a);
      return 0;
    case "uninstall":
      if (a.flags.size > 0) throw new UsageError("uninstall só aceita --service e --apply");
      await uninstall(a);
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
