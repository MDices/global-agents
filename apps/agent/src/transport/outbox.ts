import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentEventSchema, parseLine, serialize, type AgentEvent } from "@global-agents/protocol";

export interface OutboxOptions {
  /** Tamanho máximo do arquivo em bytes (padrão 50 MB). */
  maxBytes?: number;
  /** Chamado para cada linha inválida pulada (para log). */
  onSkip?: (line: string, error: string) => void;
}

export interface DrainResult { sent: number; skipped: number }

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** Tipos que só são descartados por `maxBytes` em último caso. */
const PROTECTED = new Set<string>(["turn.reply", "permission.request"]);

type Parsed = { ok: true; event: AgentEvent } | { ok: false; error: string };

function parseEvent(line: string): Parsed {
  const r = parseLine(line);
  if (!r.ok) return { ok: false, error: r.error };
  const ev = AgentEventSchema.safeParse(r.message);
  return ev.success ? { ok: true, event: ev.data } : { ok: false, error: "não é um AgentEvent" };
}

/** Lê o arquivo; ausente → buffer vazio. */
function readOrEmpty(file: string): Buffer {
  try { return readFileSync(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw e;
  }
}

/** Linhas não vazias, sem o `\n`. */
function splitLines(text: string): string[] {
  return text.split("\n").filter((l) => l !== "");
}

/**
 * Fila de eventos em disco (`<dir>/outbox.jsonl`) para quando o relay está fora.
 * `append` é síncrono; `drain` envia em ordem, para no primeiro erro e regrava o restante de forma atômica.
 */
export class Outbox {
  private readonly file: string;
  private readonly tmp: string;
  private readonly maxBytes: number;
  private readonly onSkip: ((line: string, error: string) => void) | undefined;
  private inflight: Promise<DrainResult> | undefined;

  constructor(dir: string, opts: OutboxOptions = {}) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "outbox.jsonl");
    this.tmp = join(dir, "outbox.jsonl.tmp");
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onSkip = opts.onSkip;
  }

  /** Tamanho atual do arquivo em bytes (0 se não existe). */
  size(): number {
    try { return statSync(this.file).size; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
  }

  append(ev: AgentEvent): void {
    const line = serialize(ev);
    // Durante um drain o arquivo só cresce; o limite é aplicado quando o drain regrava.
    if (this.inflight === undefined && this.size() + Buffer.byteLength(line) > this.maxBytes) {
      this.rewrite(this.evict(splitLines(readOrEmpty(this.file).toString("utf8")), line));
      return;
    }
    appendFileSync(this.file, line);
  }

  /** Drena o arquivo. Se já houver um drain em andamento, devolve a mesma promessa. */
  drain(send: (ev: AgentEvent) => Promise<void>): Promise<DrainResult> {
    if (this.inflight !== undefined) return this.inflight;
    // Marca o drain como ativo antes de qualquer leitura ou send: doDrain só começa no próximo microtask,
    // então append (sem eviction) e drain reentrante já enxergam `inflight` durante o 1.º send.
    const p = Promise.resolve().then(() => this.doDrain(send)).finally(() => { this.inflight = undefined; });
    this.inflight = p;
    return p;
  }

  private async doDrain(send: (ev: AgentEvent) => Promise<void>): Promise<DrainResult> {
    const snapshot = readOrEmpty(this.file);
    let skipped = 0;
    const parsed: { event: AgentEvent; line: string }[] = [];
    for (const line of splitLines(snapshot.toString("utf8"))) {
      const r = parseEvent(line);
      if (r.ok) parsed.push({ event: r.event, line });
      else { skipped++; this.onSkip?.(line, r.error); }
    }
    // Colapso: de cada sequência contígua de session.list fica só o último.
    const queue = parsed.filter((p, i) => p.event.type !== "session.list" || parsed[i + 1]?.event.type !== "session.list");

    let sent = 0;
    for (const item of queue) {
      try { await send(item.event); } catch { break; }
      sent++;
    }

    // Preserva o que foi anexado enquanto os envios aconteciam. Com a eviction suspensa o arquivo só cresce;
    // se mesmo assim não começar com o snapshot (mexido por fora), mantém toda linha que não estava no snapshot.
    const current = readOrEmpty(this.file);
    const tail = current.subarray(0, snapshot.length).equals(snapshot)
      ? splitLines(current.subarray(snapshot.length).toString("utf8"))
      : (() => { const seen = new Set(splitLines(snapshot.toString("utf8"))); return splitLines(current.toString("utf8")).filter((l) => !seen.has(l)); })();
    const remaining = [...queue.slice(sent).map((q) => q.line), ...tail];
    const bytes = remaining.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    this.rewrite(bytes > this.maxBytes ? this.evict(remaining, "") : remaining.map((l) => l + "\n").join(""));
    return { sent, skipped };
  }

  /**
   * Descarta as linhas mais antigas até `lines + extra` caber: primeiro as que não são
   * `turn.reply`/`permission.request` (linhas inválidas também), depois qualquer uma. Devolve o novo conteúdo.
   * Desce até 90% de `maxBytes` (folga) para não reescrever o arquivo inteiro a cada `append` quando cheio.
   */
  private evict(lines: string[], extra: string): string {
    const all = extra === "" ? [...lines] : [...lines, extra.replace(/\n$/, "")];
    const target = Math.floor(this.maxBytes * 0.9);
    const keep = all.map(() => true);
    let total = all.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    const isProtected = (l: string): boolean => { const r = parseEvent(l); return r.ok && PROTECTED.has(r.event.type); };
    for (const anyType of [false, true]) {
      for (let i = 0; i < all.length && total > target; i++) {
        const l = all[i];
        if (l === undefined || !keep[i] || (!anyType && isProtected(l))) continue;
        keep[i] = false;
        total -= Buffer.byteLength(l) + 1;
      }
    }
    return all.filter((_, i) => keep[i]).map((l) => l + "\n").join("");
  }

  private rewrite(content: string): void {
    writeFileSync(this.tmp, content);
    renameSync(this.tmp, this.file);
  }
}
