import { EventEmitter } from "node:events";
import { SessionInfoSchema, type SessionInfo } from "@global-agents/protocol";
import { runClaude, type ExecResult } from "./exec.js";

const OPTIONAL_FIELDS = ["status", "state", "waitingFor", "pid", "bgId"] as const;

/** Normaliza uma linha; só a descarta se `sessionId` ou `cwd` não forem strings. Opcionais inválidos/null são omitidos. */
function normalizeRow(o: Record<string, unknown>): SessionInfo | undefined {
  const sessionId = o["sessionId"];
  const cwd = o["cwd"];
  if (typeof sessionId !== "string" || typeof cwd !== "string") return undefined;
  const bgId = typeof o["id"] === "string" ? o["id"] : undefined;
  const kind = SessionInfoSchema.shape.kind.safeParse(o["kind"]);
  const c: Record<string, unknown> = {
    sessionId, cwd, name: typeof o["name"] === "string" ? o["name"] : "",
    kind: kind.success ? kind.data : bgId !== undefined ? "background" : "interactive",
  };
  const raw: Record<(typeof OPTIONAL_FIELDS)[number], unknown> = {
    status: o["status"], state: o["state"], waitingFor: o["waitingFor"], pid: o["pid"], bgId,
  };
  for (const k of OPTIONAL_FIELDS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (SessionInfoSchema.shape[k].safeParse(v).success) c[k] = v;
  }
  const p = SessionInfoSchema.safeParse(c);
  return p.success ? p.data : undefined;
}

export function parseAgentsJson(raw: string): SessionInfo[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: SessionInfo[] = [];
  for (const r of arr as unknown[]) {
    if (typeof r !== "object" || r === null) continue;
    const s = normalizeRow(r as Record<string, unknown>);
    if (s !== undefined) out.push(s);
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export type RunFn = (args: string[]) => Promise<ExecResult>;

export class Inventory extends EventEmitter {
  private readonly pollMs: number;
  private readonly run: RunFn;
  private readonly enrich: (list: SessionInfo[]) => SessionInfo[];
  private list: SessionInfo[] = [];
  private lastJson = "[]";
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  /**
   * `enrich`: ajusta a lista antes da comparação (ex.: nome pelo título do transcript). Roda a cada poll, então uma
   * mudança só do enriquecimento (um `/rename`) também emite `changed`.
   */
  constructor(opts: { pollMs?: number; run?: RunFn; claudeBin?: string; enrich?: (list: SessionInfo[]) => SessionInfo[] } = {}) {
    super();
    this.pollMs = opts.pollMs ?? 5000;
    this.enrich = opts.enrich ?? ((l) => l);
    const claudeBin = opts.claudeBin;
    this.run = opts.run ?? ((args) => runClaude(args, { timeoutMs: 15000, ...(claudeBin !== undefined ? { claudeBin } : {}) }));
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    if (this.polling) return; // evita polls sobrepostos fora de ordem
    this.polling = true;
    try {
      const r = await this.run(["agents", "--json"]);
      if (r.code !== 0) throw new Error(`claude agents --json saiu com código ${r.code}: ${r.stderr.trim()}`);
      const next = this.enrich(parseAgentsJson(r.stdout));
      const json = JSON.stringify(next);
      if (json === this.lastJson) return;
      this.lastJson = json;
      this.list = next;
      this.emit("changed", next);
    } catch (e) {
      this.emit("error", e);
    } finally {
      this.polling = false;
    }
  }

  current(): SessionInfo[] {
    return this.list;
  }

  find(sessionId: string): SessionInfo | undefined {
    return this.list.find((s) => s.sessionId === sessionId);
  }

  waitFor(pred: (s: SessionInfo) => boolean, timeoutMs: number): Promise<SessionInfo> {
    const hit = this.list.find(pred);
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const onChanged = (list: SessionInfo[]): void => {
        const m = list.find(pred);
        if (m === undefined) return;
        clearTimeout(t);
        this.off("changed", onChanged);
        resolve(m);
      };
      const t = setTimeout(() => {
        this.off("changed", onChanged);
        reject(new Error("sessão não apareceu no inventário a tempo"));
      }, timeoutMs);
      this.on("changed", onChanged);
    });
  }
}
