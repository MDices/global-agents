import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const DEFAULT_DIR = join(homedir(), ".global-agents");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_DIR, "config.json");

const ConfigSchema = z.object({
  relayUrl: z.string().url().refine((u) => /^wss?:\/\//.test(u), "relayUrl deve começar com ws:// ou wss://"),
  relayCertFingerprint: z.string().regex(/^[0-9A-F:]{95}$/i).optional(),
  token: z.string().min(1),
  machineName: z.string().optional(),
  projects: z.array(z.string()).default([]),
  port: z.number().int().default(48476),
  claudeBin: z.string().default("claude"),
  dataDir: z.string().default(DEFAULT_DIR),
});

export type AgentConfig = z.infer<typeof ConfigSchema>;

/** Valida um objeto de config e preenche os padrões. */
export function parseConfig(raw: unknown): AgentConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`config inválida: ${issues}`);
  }
  return parsed.data;
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): AgentConfig {
  if (!existsSync(path)) throw new Error(`config não encontrada em ${path}; rode global-agents install`);
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function saveConfig(cfg: AgentConfig, path: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // mode só vale na criação; garante 0600 mesmo se o arquivo já existia mais aberto
  chmodSync(path, 0o600);
}
