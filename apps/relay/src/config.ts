export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RelayConfig {
  discordToken: string;
  guildId: string;
  categoryName: string;
  allowedUserIds: string[];
  dataDir: string;
  port: number;
  logLevel: LogLevel;
}

const LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

export function loadRelayConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const get = (k: string): string | undefined => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const allowedUserIds = (env["ALLOWED_USER_IDS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const missing: string[] = [];
  const discordToken = get("DISCORD_TOKEN");
  if (!discordToken) missing.push("DISCORD_TOKEN");
  const guildId = get("DISCORD_GUILD_ID");
  if (!guildId) missing.push("DISCORD_GUILD_ID");
  if (allowedUserIds.length === 0) missing.push("ALLOWED_USER_IDS");
  if (missing.length > 0 || !discordToken || !guildId) {
    throw new Error(`Variáveis de ambiente obrigatórias ausentes: ${missing.join(", ")}`);
  }

  const portRaw = get("PORT");
  const port = portRaw === undefined ? 8443 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT inválida: ${portRaw ?? ""}`);
  }

  const levelRaw = get("LOG_LEVEL") ?? "info";
  if (!LOG_LEVELS.includes(levelRaw)) {
    throw new Error(`LOG_LEVEL inválido: ${levelRaw} (use ${LOG_LEVELS.join("|")})`);
  }

  return {
    discordToken,
    guildId,
    categoryName: "global-agents",
    allowedUserIds,
    dataDir: get("DATA_DIR") ?? "/data",
    port,
    logLevel: levelRaw as LogLevel,
  };
}
