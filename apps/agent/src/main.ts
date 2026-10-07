import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { newEnvelope, type AgentEvent, type RelayCommand, type SessionInfo } from "@global-agents/protocol";
import { runClaude } from "./claude/exec.js";
import { injectPrompt } from "./claude/inject.js";
import { Inventory, type RunFn } from "./claude/inventory.js";
import { readRegistry } from "./claude/registry.js";
import { spawnSession, type SpawnRun } from "./claude/spawn.js";
import { SessionNamer } from "./claude/titles.js";
import { grantTrust } from "./claude/trust.js";
import { resumeViaPty } from "./claude/fallback-pty.js";
import { runSlash } from "./claude/slash.js";
import { stopSession } from "./claude/stop.js";
import { createCommandHandler, type CommandDeps } from "./commands/handle.js";
import { normalizeDir, type AgentConfig } from "./config.js";
import { startHookServer, type HookServer } from "./hooks/server.js";
import { machineId } from "./machine.js";
import { PendingPermissions } from "./permissions/pending.js";
import { discoverProjects } from "./projects/discover.js";
import { recheckInside, resolveWorkspace } from "./projects/workspace.js";
import { TeamTracker } from "./team/tracker.js";
import { RelayClient, type RelayClientEvents, type RelayClientOptions } from "./transport/client.js";
import { Outbox } from "./transport/outbox.js";

export interface InventoryEvents {
  changed: [SessionInfo[]];
  error: [unknown];
}

/** O que o agente usa do inventário (o real é `Inventory`). */
export interface InventoryLike {
  start(): void;
  stop(): void;
  find(sessionId: string): SessionInfo | undefined;
  waitFor(pred: (s: SessionInfo) => boolean, timeoutMs: number): Promise<SessionInfo>;
  on<K extends keyof InventoryEvents>(event: K, fn: (...args: InventoryEvents[K]) => void): unknown;
  off<K extends keyof InventoryEvents>(event: K, fn: (...args: InventoryEvents[K]) => void): unknown;
}

/** O que o agente usa do cliente do relay (o real é `RelayClient`). */
export interface RelayClientLike {
  start(): void;
  stop(): void;
  send(ev: AgentEvent): void;
  on<K extends keyof RelayClientEvents>(event: K, fn: (...args: RelayClientEvents[K]) => void): unknown;
}

export interface AgentDeps {
  inventory: InventoryLike;
  /** Fábrica: o cliente precisa do `hello` e do outbox montados aqui. */
  client: (opts: RelayClientOptions) => RelayClientLike;
  hookServer: typeof startHookServer;
  /** Executa o `claude` (probes de versão e conta, `--bg`, `stop`). */
  run: SpawnRun;
  /** Intervalo da re-checagem de `claudeAccount` (padrão 60 s). */
  accountCheckMs: number;
  /** Substitui partes do despacho de comandos (testes). `onPermissionDecide` já vem ligado às permissões pendentes. */
  commands: Partial<Omit<CommandDeps, "machine" | "inventory">>;
  /** Pasta dos `config.json` de times (padrão `~/.claude/teams`). */
  teamsDir: string;
  /** Varre as raízes dev atrás de projetos (o real é `discoverProjects`). */
  discover: (roots: readonly string[]) => Promise<string[]>;
  /** Intervalo da nova varredura das raízes dev (padrão 5 min). */
  projectsScanMs: number;
  /** Nome das sessões pelos títulos do transcript (o real lê `~/.claude/projects`). */
  namer: SessionNamer;
}

export interface Agent {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function agentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function osName(): "linux" | "win32" | "darwin" {
  const p = process.platform;
  return p === "win32" || p === "darwin" ? p : "linux";
}

async function claudeVersion(run: RunFn): Promise<string | undefined> {
  try {
    const r = await run(["--version"]);
    return r.code === 0 ? /\d+\.\d+\.\d+\S*/.exec(r.stdout)?.[0] : undefined;
  } catch {
    return undefined;
  }
}

/** `claude auth status` → `email` do JSON, se houver (sai ≠ 0 quando deslogado; o JSON ainda vale). */
async function claudeAccount(run: RunFn): Promise<string | undefined> {
  try {
    const r = await run(["auth", "status"]);
    const j: unknown = JSON.parse(r.stdout);
    if (typeof j !== "object" || j === null) return undefined;
    const email = (j as Record<string, unknown>)["email"];
    return typeof email === "string" && email !== "" ? email : undefined;
  } catch {
    return undefined;
  }
}

export function createAgent(cfg: AgentConfig, deps: Partial<AgentDeps> = {}): Agent {
  const machine = machineId(cfg);
  // Config editada à mão pode ter `~/dev` ou `C:/dev`: tudo daqui em diante usa o caminho absoluto nativo.
  const devRoots = [...new Set(cfg.devRoots.map((r) => normalizeDir(r)))];
  const run: SpawnRun =
    deps.run ?? ((args, opts) => runClaude(args, { timeoutMs: 15000, ...opts, claudeBin: cfg.claudeBin }));
  const namer = deps.namer ?? new SessionNamer();
  const inventory: InventoryLike = deps.inventory ?? new Inventory({ run: (args) => run(args), enrich: (l) => namer.enrich(l) });
  const makeClient = deps.client ?? ((opts: RelayClientOptions) => new RelayClient(opts));
  const hookServerFactory = deps.hookServer ?? startHookServer;
  const accountCheckMs = deps.accountCheckMs ?? 60_000;
  const discover = deps.discover ?? ((roots: readonly string[]) => discoverProjects(roots));
  const projectsScanMs = deps.projectsScanMs ?? 300_000;
  let client: RelayClientLike | undefined;
  const permissions = new PendingPermissions({ machine, inventory, emit: (ev) => client?.send(ev) });
  const handleCommand = createCommandHandler({
    machine,
    inventory,
    inject: injectPrompt,
    workspace: (cwd, create) => resolveWorkspace(cwd, create, { devRoots, projects: cfg.projects }),
    recheck: (ws) => recheckInside(ws),
    spawn: (input) => spawnSession(input, { run, inventory, trust: (paths) => grantTrust(paths) }),
    stop: (bgId) => stopSession(bgId, { run }),
    readRegistry: (pid) => readRegistry(pid),
    slash: (input) => runSlash({ ...input, claudeBin: cfg.claudeBin }),
    resume: (input) => resumeViaPty({ ...input, claudeBin: cfg.claudeBin }),
    onWarning: (message, sessionId) => client?.send({ ...newEnvelope(machine), type: "agent.warning", message, sessionId }),
    onPermissionDecide: (requestId, behavior) => permissions.decide(requestId, behavior),
    ...deps.commands,
  });
  const version = agentVersion();
  const osUser = userInfo().username;

  let cVersion: string | undefined;
  let account: string | undefined;
  let hookServer: HookServer | undefined;
  let team: TeamTracker | undefined;
  let accountTimer: NodeJS.Timeout | undefined;
  let scanTimer: NodeJS.Timeout | undefined;
  /** Projetos descobertos na última varredura das raízes dev. */
  let discovered: string[] = [];
  let lastInventoryError = "";

  const hello = (): AgentEvent => ({
    ...newEnvelope(machine),
    type: "agent.hello",
    version,
    os: osName(),
    osUser,
    ...(cVersion !== undefined ? { claudeVersion: cVersion } : {}),
    ...(account !== undefined ? { claudeAccount: account } : {}),
    projects: cfg.projects,
    devRoots,
  });

  const projectsEvent = (): AgentEvent => ({ ...newEnvelope(machine), type: "agent.projects", devRoots, projects: discovered });

  /** Varre as raízes; devolve `true` se a lista mudou. Falha vira log e mantém a lista anterior. */
  const scanProjects = async (): Promise<boolean> => {
    if (devRoots.length === 0) return false;
    try {
      const next = await discover(devRoots);
      if (next.length === discovered.length && next.every((p, i) => p === discovered[i])) return false;
      discovered = next;
      return true;
    } catch (e) {
      console.warn(`global-agents: falha ao varrer as pastas dev: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
  const rescan = async (): Promise<void> => {
    if ((await scanProjects()) && client !== undefined) client.send(projectsEvent());
  };

  /** Mesma prioridade do `session.list` (o inventário já vem enriquecido): o nome não oscila entre hook e poll. */
  const lookupName = (sessionId: string, hint: { cwd: string; transcriptPath?: string }): string | undefined => {
    if (hint.transcriptPath !== undefined) namer.remember(sessionId, hint.transcriptPath);
    return namer.name(sessionId, hint.cwd, inventory.find(sessionId)?.name, hint.transcriptPath);
  };

  const onChanged = (sessions: SessionInfo[]): void => {
    team?.syncInventory(sessions.map((s) => s.sessionId));
    client?.send({ ...newEnvelope(machine), type: "session.list", sessions });
  };
  const onInventoryError = (e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === lastInventoryError) return; // o poll repete o mesmo erro a cada 5 s
    lastInventoryError = msg;
    console.warn(`global-agents: falha ao listar sessões do claude: ${msg}`);
  };
  const onCommand = (cmd: RelayCommand): void => {
    void handleCommand(cmd).then((ev) => client?.send(ev));
  };

  const recheckAccount = async (): Promise<void> => {
    const next = await claudeAccount(run);
    if (next === account || client === undefined) return;
    account = next;
    client.send(hello());
  };

  return {
    async start(): Promise<void> {
      [cVersion, account] = await Promise.all([claudeVersion(run), claudeAccount(run), scanProjects()]);

      const isKnownSession = (id: string): boolean => inventory.find(id) !== undefined;
      const tracker = new TeamTracker({
        machine,
        emit: (ev) => client?.send(ev),
        isKnownSession,
        ...(deps.teamsDir !== undefined ? { teamsDir: deps.teamsDir } : {}),
      });
      team = tracker;

      // Outbox e cliente existem antes do servidor de hooks escutar: um evento (inclusive `permission.request`) que
      // chegue logo depois do `listen` vai para o outbox (o cliente ainda não conectado grava lá) em vez de se perder.
      const outbox = new Outbox(cfg.dataDir, {
        onSkip: (_line, error) => { console.warn(`global-agents: linha inválida descartada do outbox (${error})`); },
      });
      const c = makeClient({
        url: cfg.relayUrl,
        token: cfg.token,
        ...(cfg.relayCertFingerprint !== undefined ? { certFingerprint: cfg.relayCertFingerprint } : {}),
        outbox,
        hello,
      });
      client = c;
      c.on("command", onCommand);
      // O relay guarda os projetos só em memória: a cada (re)conexão, depois do hello, manda a lista atual.
      c.on("connected", () => { client?.send(projectsEvent()); });
      c.on("warning", (msg) => { console.warn(`global-agents: ${msg}`); });

      try {
        hookServer = await hookServerFactory({
          port: cfg.port,
          machine,
          lookupName,
          isKnownSession,
          onEvents: (evs) => { for (const ev of evs) client?.send(ev); },
          onTeamPayload: (payload, teammate) => { tracker.observe(payload, teammate); },
          onPermission: (payload, respond, signal) => { permissions.open(payload, respond, signal); },
        });
      } catch (e) {
        c.stop();
        client = undefined;
        throw e;
      }
      c.start();

      inventory.on("error", onInventoryError);
      inventory.on("changed", onChanged);
      inventory.start();

      accountTimer = setInterval(() => { void recheckAccount(); }, accountCheckMs);
      if (devRoots.length > 0) {
        scanTimer = setInterval(() => { void rescan(); }, projectsScanMs);
        scanTimer.unref();
      }
    },

    async stop(): Promise<void> {
      if (accountTimer !== undefined) clearInterval(accountTimer);
      accountTimer = undefined;
      if (scanTimer !== undefined) clearInterval(scanTimer);
      scanTimer = undefined;
      inventory.stop();
      inventory.off("changed", onChanged);
      // o listener de "error" fica: um poll em andamento ainda pode emitir, e "error" sem ouvinte lança
      permissions.close();
      const srv = hookServer;
      hookServer = undefined;
      await srv?.close();
      team?.dispose();
      team = undefined;
      client?.stop();
      client = undefined;
    },
  };
}
