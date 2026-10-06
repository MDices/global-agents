import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAgentsJson, type RunFn } from "./claude/inventory.js";
import { loadConfig as defaultLoadConfig, type AgentConfig } from "./config.js";
import { runClaude } from "./claude/exec.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthResult {
  status: number;
  body: string;
  /** SHA-256 do certificado apresentado (só em https). */
  fingerprint?: string;
}

export interface DoctorDeps {
  loadConfig: () => AgentConfig;
  run: RunFn;
  readSettings: () => Record<string, unknown>;
  existsDir: (path: string) => boolean;
  /** Arquivos `~/.claude/sessions/*.key` (Windows). */
  listKeyFiles: () => string[];
  fetchHealth: (url: string, fingerprint?: string) => Promise<HealthResult>;
  platform: NodeJS.Platform;
  uid: number;
}

const MARKER = "global-agents-hook";
const EVENTS = ["UserPromptSubmit", "Notification", "Stop", "SessionEnd", "PermissionRequest"];
const MIN_VERSION = { win32: "2.1.234", other: "2.1.224" };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `wss://host:porta/ws` → `https://host:porta/health`. */
export function healthUrlFor(relayUrl: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/health";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * GET /health aceitando qualquer certificado (o relay é autoassinado) e devolvendo o fingerprint apresentado;
 * quem chama decide se confere. Nenhum header de autenticação é enviado.
 */
export function defaultFetchHealth(url: string, _fingerprint?: string, timeoutMs = 5000): Promise<HealthResult> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https:");
    const req = (isHttps ? request : httpRequest)(url, { method: "GET", ...(isHttps ? { rejectUnauthorized: false } : {}) }, (res) => {
      // o socket só existe enquanto a resposta não terminou
      const fp = (res.socket as { getPeerCertificate?: () => { fingerprint256?: string } } | null)?.getPeerCertificate?.().fingerprint256;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { if (body.length < 4096) body += d; });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body, ...(fp !== undefined ? { fingerprint: fp } : {}) });
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`sem resposta em ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

export function defaultDeps(configPath: string, claudeBin?: string): DoctorDeps {
  const sessions = join(homedir(), ".claude", "sessions");
  return {
    loadConfig: () => defaultLoadConfig(configPath),
    run: (args) => runClaude(args, { timeoutMs: 15000, ...(claudeBin !== undefined ? { claudeBin } : {}) }),
    readSettings: () => {
      const p = join(homedir(), ".claude", "settings.json");
      return existsSync(p) ? asObject(JSON.parse(readFileSync(p, "utf8"))) : {};
    },
    existsDir: existsSync,
    listKeyFiles: () => (existsSync(sessions) ? readdirSync(sessions).filter((f) => f.endsWith(".key")) : []),
    fetchHealth: defaultFetchHealth,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
  };
}

export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };

  let cfg: AgentConfig | undefined;
  try {
    cfg = d.loadConfig();
    add("config", true, `relay ${cfg.relayUrl}`);
  } catch (e) {
    add("config", false, msg(e));
  }

  const min = d.platform === "win32" ? MIN_VERSION.win32 : MIN_VERSION.other;
  try {
    const r = await d.run(["--version"]);
    const m = /(\d+\.\d+\.\d+)/.exec(r.stdout);
    if (r.code !== 0 || m?.[1] === undefined) add("versão do Claude Code", false, `não consegui ler a versão (${r.stdout.trim() || r.stderr.trim() || `código ${r.code}`})`);
    else if (cmpVersion(m[1], min) < 0) add("versão do Claude Code", false, `${m[1]} é anterior à mínima ${min}`);
    else add("versão do Claude Code", true, `${m[1]} (mínima ${min})`);
  } catch (e) {
    add("versão do Claude Code", false, `não consegui executar o claude: ${msg(e)}`);
  }

  try {
    const r = await d.run(["agents", "--json"]);
    let valid = false;
    try { valid = Array.isArray(JSON.parse(r.stdout)); } catch { /* inválido */ }
    if (r.code === 0 && valid) add("claude agents --json", true, `${parseAgentsJson(r.stdout).length} sessão(ões) listada(s)`);
    else add("claude agents --json", false, r.code !== 0 ? `código ${r.code}: ${r.stderr.trim()}` : "saída não é um JSON de lista");
  } catch (e) {
    add("claude agents --json", false, msg(e));
  }

  let settings: Record<string, unknown> | undefined;
  let settingsError = "";
  try {
    settings = d.readSettings();
  } catch (e) {
    settingsError = `não consegui ler ~/.claude/settings.json: ${msg(e)}`;
  }
  if (settings === undefined) {
    add("hooks", false, settingsError);
    add("crossSessionInbound", false, settingsError);
  } else {
    const hooks = asObject(settings["hooks"]);
    const missing = EVENTS.filter((ev) => {
      const entries = hooks[ev];
      return !(Array.isArray(entries) && entries.some((en) => {
        const hs = asObject(en)["hooks"];
        return Array.isArray(hs) && hs.some((h) => { const c = asObject(h)["command"]; return typeof c === "string" && c.includes(MARKER); });
      }));
    });
    add("hooks", missing.length === 0, missing.length === 0 ? `instalados nos ${EVENTS.length} eventos` : `faltando em: ${missing.join(", ")}; rode global-agents install`);
    const cs = settings["crossSessionInbound"];
    add("crossSessionInbound", cs === "accept", cs === "accept" ? "accept" : `está ${cs === undefined ? "ausente" : JSON.stringify(cs)}; precisa ser "accept"`);
  }

  if (d.platform === "win32") {
    const keys = d.listKeyFiles();
    add("sockets", true, keys.length > 0 ? `${keys.length} arquivo(s) .key em ~/.claude/sessions` : "nenhuma sessão aberta (sem arquivos .key em ~/.claude/sessions)");
  } else {
    const dirs = [`/run/user/${d.uid}/cc-socks`, `/tmp/cc-socks-${d.uid}`];
    const found = dirs.find((p) => d.existsDir(p));
    add("sockets", found !== undefined, found !== undefined ? found : `nenhum diretório encontrado (${dirs.join(" ou ")}); abra uma sessão do Claude Code`);
  }

  if (cfg === undefined) {
    add("relay alcançável", false, "sem config não há relay para testar");
    add("fingerprint do relay", false, "sem config não há relay para testar");
    return checks;
  }
  let health: HealthResult | undefined;
  try {
    const url = healthUrlFor(cfg.relayUrl);
    health = await d.fetchHealth(url, cfg.relayCertFingerprint);
    const ok = health.status === 200 && /"ok"\s*:\s*true/.test(health.body);
    add("relay alcançável", ok, ok ? `GET ${url} → 200` : `GET ${url} → ${health.status} com corpo inesperado`);
  } catch (e) {
    add("relay alcançável", false, msg(e));
  }
  const want = cfg.relayCertFingerprint;
  // Sem pin, o cliente `wss://` verifica o certificado pela cadeia de CAs e nunca conecta a um relay autoassinado.
  if (want === undefined && !cfg.relayUrl.startsWith("ws://")) {
    add("fingerprint do relay", false, "não fixado na config: o agente não conecta a um relay com certificado autoassinado. "
      + "Pegue o fingerprint na VPS (`docker compose exec relay node dist/cli.js fingerprint`) e rode de novo `install … --fingerprint <fp>`");
  } else if (health === undefined) add("fingerprint do relay", false, "relay inalcançável; não foi possível verificar");
  else if (want === undefined) add("fingerprint do relay", true, "relay sem TLS (ws://); fingerprint não se aplica");
  else if (health.fingerprint?.toUpperCase() === want.toUpperCase()) add("fingerprint do relay", true, "confere com o fixado");
  else add("fingerprint do relay", false, `o servidor apresentou outro certificado (esperado ${want}, recebido ${health.fingerprint ?? "nenhum"})`);
  return checks;
}
