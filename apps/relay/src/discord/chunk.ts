/** Fatiamento de texto para o limite de mensagem do Discord (UTF-16 code units). */

const EMPTY_TEXT = "(sem texto na resposta)";
// Pior caso do sufixo "\n-# (parte i/n)" com até 4 dígitos em i e n.
const SUFFIX_RESERVE = "\n-# (parte 9999/9999)".length;
const MAX_INFO = 200;
const FENCE_OPEN_RE = /^ {0,3}(`{3,})([^`]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})[ \t]*$/;

interface Fence {
  readonly ticks: number;
  readonly info: string;
}

/** Aplica as linhas de `body` ao estado de cerca aberta e devolve o novo estado. */
function scanFences(body: string, open: Fence | null): Fence | null {
  let state = open;
  for (const line of body.split("\n")) {
    if (state === null) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m !== null) state = { ticks: (m[1] ?? "").length, info: (m[2] ?? "").trim().slice(0, MAX_INFO) };
    } else {
      const m = FENCE_CLOSE_RE.exec(line);
      if (m !== null && (m[1] ?? "").length >= state.ticks) state = null;
    }
  }
  return state;
}

const fenceLine = (f: Fence): string => "`".repeat(f.ticks) + f.info;

function findCut(rest: string, room: number): { cut: number; skip: number } {
  for (const sep of ["\n\n", "\n", " "]) {
    const idx = rest.lastIndexOf(sep, room);
    if (idx > 0) return { cut: idx, skip: sep.length };
  }
  let cut = room;
  const code = rest.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff && cut > 1) cut -= 1; // não separa par substituto
  return { cut, skip: 0 };
}

export function chunkText(text: string, limit = 1900): string[] {
  if (text.trim() === "") return [EMPTY_TEXT];
  if (text.length <= limit) return [text];

  // Pior caso para fechar uma cerca: "\n" + a maior sequência de crases no texto.
  const closeLen = 1 + Math.max(3, ...(text.match(/^ {0,3}`{3,}/gm) ?? []).map((m) => m.trim().length));
  const bodies: string[] = [];
  let pos = 0;
  let open: Fence | null = null;

  while (pos < text.length) {
    const prefix = open === null ? "" : `${fenceLine(open)}\n`;
    const rest = text.slice(pos);
    const base = limit - SUFFIX_RESERVE - prefix.length;

    if (rest.length <= base) {
      bodies.push(prefix + rest);
      break;
    }

    const room = Math.max(1, base - closeLen);
    const { cut, skip } = findCut(rest, room);
    const body = rest.slice(0, cut);
    const after = scanFences(body, open);
    bodies.push(prefix + body + (after === null ? "" : `\n${"`".repeat(after.ticks)}`));
    open = after;
    pos += cut + skip;
  }

  if (bodies.length === 1) return bodies;
  const n = bodies.length;
  return bodies.map((b, i) => `${b}\n-# (parte ${i + 1}/${n})`);
}
