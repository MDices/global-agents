import { accessSync, constants, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Events, type Client, type Interaction, type Message } from "discord.js";
import type { AgentEvent } from "@global-agents/protocol";
import { createCommandBridge } from "./commands.js";
import { loadRelayConfig, type LogLevel, type RelayConfig } from "./config.js";
import { openDb, relayDbPath } from "./db.js";
import { createBot, DiscordJsPort, registerSlashCommands, toSlashInteraction, type DiscordPort } from "./discord/bot.js";
import { createSlashHandler, stripMention } from "./discord/slash.js";
import { ThreadRegistry } from "./discord/threads.js";
import { createRouter, machineChannelResolver } from "./router.js";
import { ensureCert } from "./tls.js";
import { AgentHub } from "./ws/server.js";

export type RelayLog = (level: LogLevel, msg: string) => void;

export interface RelayDeps {
  /** Porta do Discord já pronta (testes); sem ela, o relay faz login com `cfg.discordToken`. */
  port?: DiscordPort;
  log?: RelayLog;
}

export interface Relay {
  /** SHA-256 do certificado (`AA:BB:…`), o valor do `global-agents install --fingerprint`. */
  fingerprint: string;
  /** Porta efetivamente escutada (útil com `cfg.port = 0`). */
  port: number;
  close(): Promise<void>;
}

/** Quanto `close()` espera os eventos já recebidos irem para o Discord antes de fechar o banco. */
const DRAIN_MS = 5_000;

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function consoleLog(min: LogLevel): RelayLog {
  const floor = LEVELS.indexOf(min);
  return (level, msg) => {
    if (LEVELS.indexOf(level) < floor) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
}

/**
 * Garante que `dir` existe e é gravável antes de abrir o banco. O caso típico é o primeiro deploy: o bind mount
 * `./data:/data` criado pelo Docker como root, com o contêiner rodando como `node` (uid 1000).
 */
function assertWritableDataDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch {
    const uid = process.getuid?.() ?? "atual";
    throw new Error(`diretório de dados ${dir} não é gravável pelo usuário ${uid}; rode: sudo install -d -o 1000 -g 1000 <caminho no host>`);
  }
}

/**
 * Sobe o relay: banco → certificado → HTTPS → hub dos agentes → bot do Discord → roteador → `listen`.
 * Se qualquer passo falhar, desfaz os anteriores e rejeita. `close()` encerra roteador → hub → servidor →
 * (drenagem da fila, até 5 s) → bot → banco e não deixa handles abertos. Tokens nunca vão para o log.
 */
export async function startRelay(cfg: RelayConfig, deps: RelayDeps = {}): Promise<Relay> {
  const log = deps.log ?? consoleLog(cfg.logLevel);
  const cleanup: (() => void | Promise<void>)[] = [];
  const unwind = async (): Promise<void> => {
    while (cleanup.length > 0) {
      const step = cleanup.pop();
      try {
        await step?.();
      } catch (e) {
        log("warn", `falha ao encerrar: ${(e as Error).message}`);
      }
    }
  };

  try {
    assertWritableDataDir(cfg.dataDir);
    const db = openDb(relayDbPath(cfg.dataDir));
    cleanup.push(() => { db.close(); });

    const { key, cert, fingerprint256 } = ensureCert(cfg.dataDir);
    log("info", `fingerprint do certificado: ${fingerprint256}`);

    const server = createServer({ key, cert });
    cleanup.push(() => new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
      server.closeIdleConnections();
    }));

    const hub = new AgentHub({ db, server });
    hub.on("warning", (m) => { log("warn", m); });
    cleanup.push(() => { hub.close(); });

    let port = deps.port;
    let client: Client | undefined;
    if (port === undefined) {
      const bot = createBot(cfg, (m) => { log("error", m); });
      // Logo acima do `db.close`: o bot é o penúltimo a sair (depois do servidor e da drenagem da fila).
      cleanup.splice(1, 0, () => bot.client.destroy());
      await bot.ready;
      log("info", `discord: conectado como ${bot.client.user?.tag ?? "?"}`);
      port = new DiscordJsPort(bot.client, cfg.guildId, cfg.categoryName);
      client = bot.client;
    }

    const routerLog = (m: string): void => { log("warn", m); };
    const threads = new ThreadRegistry({ db, port, channelFor: machineChannelResolver(db, port), log: routerLog });
    const router = createRouter({ db, port, threads, hub, log: routerLog });
    const bridge = createCommandBridge({ db, hub, port, allowedUserIds: cfg.allowedUserIds, log: routerLog });
    const slash = createSlashHandler({ db, threads, bridge, router, port, allowedUserIds: cfg.allowedUserIds, log: routerLog });
    // Com hub e servidor já fechados, espera (com teto) o que já estava na fila ir para o Discord, antes de
    // derrubar o bot e fechar o banco: fica logo acima do bot (ou do `db.close`, quando a porta é injetada).
    cleanup.splice(deps.port === undefined ? 2 : 1, 0, async () => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all([router.idle(), bridge.idle(), slash.idle()]), new Promise<void>((r) => { timer = setTimeout(r, DRAIN_MS); })]);
      clearTimeout(timer);
    });
    cleanup.push(() => { threads.dispose(); });
    cleanup.push(() => { router.dispose(); });

    // Mensagens nas threads viram `session.send`; acks reagem na mensagem; a fila drena quando a máquina conecta.
    const onAgentEvent = (machine: string, ev: AgentEvent): void => {
      if (ev.type === "command.ack" || ev.type === "command.error") void bridge.onAck(machine, ev);
    };
    const onMachineOnline = (machine: string): void => { void bridge.onMachineOnline(machine); };
    hub.on("event", onAgentEvent);
    hub.on("online", onMachineOnline);
    bridge.start();
    cleanup.push(() => {
      slash.dispose();
      bridge.dispose();
      hub.off("event", onAgentEvent);
      hub.off("online", onMachineOnline);
    });
    if (client !== undefined) {
      const discord = client;
      registerSlashCommands(discord, cfg.guildId).then(
        () => { log("info", "discord: comandos /novo, /sessoes, /parar e /filtro registrados no servidor"); },
        (e: unknown) => { log("error", `discord: falha ao registrar os slash commands: ${(e as Error).message}`); },
      );
      const onInteraction = (interaction: Interaction): void => {
        const i = toSlashInteraction(interaction);
        if (i !== undefined) void slash.onInteraction(i);
      };
      discord.on(Events.InteractionCreate, onInteraction);
      cleanup.push(() => { discord.off(Events.InteractionCreate, onInteraction); });
      const onMessage = (message: Message): void => {
        if (!message.channel.isThread()) {
          // Menção explícita ao bot (`<@id>` no texto; responder a uma mensagem do bot não conta) vira `/novo`.
          const botId = discord.user?.id;
          if (botId === undefined || !message.inGuild() || !new RegExp(`<@!?${botId}>`).test(message.content)) return;
          void slash.onMention({
            messageId: message.id,
            channelId: message.channelId,
            authorId: message.author.id,
            isBot: message.author.bot || message.system,
            text: stripMention(message.content, botId),
          });
          return;
        }
        void bridge.onThreadMessage({
          authorId: message.author.id,
          threadId: message.channelId,
          messageId: message.id,
          content: message.content,
          isBot: message.author.bot || message.system, // mensagens de sistema nunca viram prompt
        });
      };
      discord.on(Events.MessageCreate, onMessage);
      cleanup.push(() => { discord.off(Events.MessageCreate, onMessage); });
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => { server.off("listening", onListening); reject(e); };
      const onListening = (): void => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(cfg.port);
    });
    const bound = (server.address() as AddressInfo).port;
    log("info", `relay escutando em https://0.0.0.0:${bound} (agentes em /ws)`);

    let closing: Promise<void> | undefined;
    return {
      fingerprint: fingerprint256,
      port: bound,
      close: () => (closing ??= unwind()),
    };
  } catch (e) {
    await unwind();
    throw e;
  }
}

/** Só executa quando chamado como programa (os testes importam `startRelay`). */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cfg = loadRelayConfig(process.env);
  const log = consoleLog(cfg.logLevel);
  const relay = await startRelay(cfg, { log });
  const stop = (signal: string): void => {
    log("info", `${signal} recebido; encerrando`);
    const force = setTimeout(() => {
      log("error", "encerramento passou de 10 s; saindo à força");
      process.exit(1);
    }, 10_000);
    force.unref();
    relay.close().then(
      () => { process.exit(0); },
      (e: unknown) => { log("error", `falha ao encerrar: ${(e as Error).message}`); process.exit(1); },
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (invokedDirectly()) {
  main().catch((e: unknown) => {
    console.error(`erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
