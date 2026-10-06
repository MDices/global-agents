import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const DEFAULT_DIR = join(homedir(), ".global-agents");
const DEFAULT_PATH = join(DEFAULT_DIR, "config.json");

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

export function loadConfig(path: string = DEFAULT_PATH): AgentConfig {
  if (!existsSync(path)) throw new Error(`config não encontrada em ${path}; rode global-agents install`);
  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`config inválida: ${issues}`);
  }
  return parsed.data;
}

export function saveConfig(cfg: AgentConfig, path: string = DEFAULT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
