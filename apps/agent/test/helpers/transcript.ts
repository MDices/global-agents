import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Procura `<sessionId>.jsonl` em qualquer pasta de `~/.claude/projects` (evita depender da codificação do cwd). */
export function transcriptPath(sessionId: string): string | undefined {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Alguma mensagem do assistente no transcript contém `word`. */
export function assistantSaid(path: string, word: string): boolean {
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l.includes('"assistant"')) continue;
    try {
      const j = JSON.parse(l) as { type?: unknown; message?: { content?: unknown } };
      if (j.type !== "assistant" || !Array.isArray(j.message?.content)) continue;
      for (const c of j.message.content as unknown[]) {
        const t = (c as { type?: unknown; text?: unknown }).text;
        if (typeof t === "string" && t.includes(word)) return true;
      }
    } catch {
      // linha parcial: ainda sendo escrita
    }
  }
  return false;
}

/** Repete `fn` a cada 500 ms até devolver algo diferente de `undefined`. */
export async function until<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timeout esperando ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
