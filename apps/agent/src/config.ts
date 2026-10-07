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
  /** Pastas raiz de desenvolvimento (absolutas): tudo dentro delas pode virar sessão pelo `/novo`. */
  devRoots: z.array(z.string()).default([]),
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
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // a mensagem do V8 traz um trecho do conteúdo, que pode incluir o token
    if (e instanceof SyntaxError) throw new Error(`config inválida em ${path}: JSON malformado`);
    throw e;
  }
  return parseConfig(raw);
}

export const INSTALL_REQUIRES_TEXT = "install exige --relay e --token (ou a variável GLOBAL_AGENTS_TOKEN)";

/** Erro de uso do `install` (a CLI mostra o uso junto). */
export class InstallUsageError extends Error {}

export interface InstallInput {
  /** Ausente reaproveita o da config anterior (obrigatório sem config). */
  relayUrl?: string;
  /** Ausente reaproveita o da config anterior (obrigatório sem config). */
  token?: string;
  fingerprint?: string;
  /** Vazio mantém os projetos da config anterior. */
  projects: string[];
  /** Vazio mantém as raízes dev da config anterior. */
  devRoots?: string[];
}

/**
 * Config do `install`: mescla com a anterior. Com config anterior, `--relay`, token e `--fingerprint` são opcionais
 * (usa os salvos); sem ela, relay e token são obrigatórios. Relay novo sem `--fingerprint` descarta o pin antigo.
 */
export function installConfig(previous: AgentConfig | undefined, input: InstallInput): { cfg: AgentConfig; warnings: string[] } {
  const relayUrl = input.relayUrl ?? previous?.relayUrl;
  const token = input.token ?? previous?.token;
  if (relayUrl === undefined || token === undefined) throw new InstallUsageError(INSTALL_REQUIRES_TEXT);
  const warnings: string[] = [];
  const base: Partial<AgentConfig> = { ...previous };
  if (input.fingerprint === undefined && previous !== undefined && previous.relayUrl !== relayUrl && previous.relayCertFingerprint !== undefined) {
    delete base.relayCertFingerprint;
    warnings.push("relay mudou; o fingerprint anterior foi descartado — passe --fingerprint para fixar o certificado novo");
  }
  const devRoots = input.devRoots ?? [];
  const cfg = parseConfig({
    ...base,
    relayUrl,
    token,
    ...(input.fingerprint !== undefined ? { relayCertFingerprint: input.fingerprint } : {}),
    ...(input.projects.length > 0 ? { projects: input.projects } : {}),
    ...(devRoots.length > 0 ? { devRoots } : {}),
  });
  return { cfg, warnings };
}

export function saveConfig(cfg: AgentConfig, path: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // mode só vale na criação; garante 0600 mesmo se o arquivo já existia mais aberto
  chmodSync(path, 0o600);
}
