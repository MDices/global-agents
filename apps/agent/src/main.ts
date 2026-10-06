import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { newEnvelope, type AgentEvent, type RelayCommand, type SessionInfo } from "@global-agents/protocol";
import { runClaude } from "./claude/exec.js";
import { injectPrompt } from "./claude/inject.js";
import { Inventory, type RunFn } from "./claude/inventory.js";
import { readRegistry } from "./claude/registry.js";
import { spawnSession, type SpawnRun } from "./claude/spawn.js";
import { runSlash } from "./claude/slash.js";
import { stopSession } from "./claude/stop.js";
import { createCommandHandler, type CommandDeps } from "./commands/handle.js";
import type { AgentConfig } from "./config.js";
import { startHookServer, type HookServer } from "./hooks/server.js";
import { machineId } from "./machine.js";
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
  /** Substitui partes do despacho de comandos (testes; `onPermissionDecide` vem em T20). */
  commands: Partial<Omit<CommandDeps, "machine" | "inventory">>;
  /** Pasta dos `config.json` de times (padrão `~/.claude/teams`). */
  teamsDir: string;
}

export interface Agent {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function agentVersion(): string {
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
  const run: SpawnRun =
    deps.run ?? ((args, opts) => runClaude(args, { timeoutMs: 15000, ...opts, claudeBin: cfg.claudeBin }));
  const inventory: InventoryLike = deps.inventory ?? new Inventory({ claudeBin: cfg.claudeBin });
  const makeClient = deps.client ?? ((opts: RelayClientOptions) => new RelayClient(opts));
  const hookServerFactory = deps.hookServer ?? startHookServer;
  const accountCheckMs = deps.accountCheckMs ?? 60_000;
  const handleCommand = createCommandHandler({
    machine,
    inventory,
    inject: injectPrompt,
    spawn: (input) => spawnSession(input, { run, inventory }),
    stop: (bgId) => stopSession(bgId, { run }),
    readRegistry: (pid) => readRegistry(pid),
    slash: (input) => runSlash({ ...input, claudeBin: cfg.claudeBin }),
    ...deps.commands,
  });
  const version = agentVersion();
  const osUser = userInfo().username;

  let cVersion: string | undefined;
  let account: string | undefined;
  let client: RelayClientLike | undefined;
  let hookServer: HookServer | undefined;
  let team: TeamTracker | undefined;
  let accountTimer: NodeJS.Timeout | undefined;
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
  });

  const lookupName = (sessionId: string): string | undefined => {
    const name = inventory.find(sessionId)?.name;
    return name !== undefined && name !== "" ? name : undefined;
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
      [cVersion, account] = await Promise.all([claudeVersion(run), claudeAccount(run)]);

      const isKnownSession = (id: string): boolean => inventory.find(id) !== undefined;
      const tracker = new TeamTracker({
        machine,
        emit: (ev) => client?.send(ev),
        isKnownSession,
        ...(deps.teamsDir !== undefined ? { teamsDir: deps.teamsDir } : {}),
      });
      team = tracker;
      hookServer = await hookServerFactory({
        port: cfg.port,
        machine,
        lookupName,
        isKnownSession,
        onEvents: (evs) => { for (const ev of evs) client?.send(ev); },
        onTeamPayload: (payload, teammate) => { tracker.observe(payload, teammate); },
      });

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
      c.on("warning", (msg) => { console.warn(`global-agents: ${msg}`); });
      c.start();

      inventory.on("error", onInventoryError);
      inventory.on("changed", onChanged);
      inventory.start();

      accountTimer = setInterval(() => { void recheckAccount(); }, accountCheckMs);
    },

    async stop(): Promise<void> {
      if (accountTimer !== undefined) clearInterval(accountTimer);
      accountTimer = undefined;
      inventory.stop();
      inventory.off("changed", onChanged);
      // o listener de "error" fica: um poll em andamento ainda pode emitir, e "error" sem ouvinte lança
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
