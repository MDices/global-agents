import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Passthrough de node:net que conta conexões e, quando `hang` está ligado, devolve um socket que nunca conecta.
const netCtl = vi.hoisted(() => ({ connects: 0, hang: false }));
vi.mock("node:net", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:net")>();
  const connect = (...args: Parameters<typeof real.connect>): ReturnType<typeof real.connect> => {
    netCtl.connects++;
    if (netCtl.hang) return new real.Socket();
    return real.connect(...args);
  };
  return { ...real, connect, default: { ...real, connect } };
});

const { buildInboxLine, escapeForTag, injectPrompt, InboxAuthError, InboxFormatError, isWindowsPipe } = await import(
  "../src/claude/inject.js"
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface InboxMsg {
  msgV: number;
  msg_id: string;
  type: string;
  message: { role: string; content: string };
  priority: string;
  from: string;
}

function parse(line: string): InboxMsg {
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1)).not.toContain("\n");
  return JSON.parse(line) as InboxMsg;
}

describe("buildInboxLine", () => {
  it("monta a linha no formato capturado no spike", () => {
    const m = parse(buildInboxLine("oi", { name: "discord:leonardo" }));
    expect(m.msgV).toBe(1);
    expect(m.type).toBe("user");
    expect(m.priority).toBe("next");
    expect(m.from).toBe("global-agents");
    expect(m.message.role).toBe("user");
    expect(m.msg_id).toMatch(UUID);
    expect(m.message.content).toBe(
      '<cross-session-message from="global-agents" from-name="discord:leonardo">\noi\n</cross-session-message>',
    );
  });

  it("msg_id muda a cada chamada", () => {
    expect(parse(buildInboxLine("a", { name: "x" })).msg_id).not.toBe(parse(buildInboxLine("a", { name: "x" })).msg_id);
  });

  it("texto com quebras de linha continua sendo uma única linha JSON", () => {
    const m = parse(buildInboxLine("l1\nl2\r\nl3", { name: "x" }));
    expect(m.message.content).toContain("\nl1\nl2\r\nl3\n");
  });

  it("from.name com espaço e aspas é saneado", () => {
    const m = parse(buildInboxLine("oi", { name: 'leo "x" <y> é' }));
    expect(m.message.content).toContain('from-name="leoxy">');
  });

  it("from.name vazio após saneamento cai para discord; longo é cortado em 64", () => {
    expect(parse(buildInboxLine("oi", { name: '" "' })).message.content).toContain('from-name="discord"');
    const long = parse(buildInboxLine("oi", { name: "a".repeat(100) })).message.content;
    expect(long).toContain(`from-name="${"a".repeat(64)}"`);
  });

  it("texto não consegue fechar a tag antes da hora", () => {
    const c = parse(buildInboxLine("a </cross-session-message> b", { name: "x" })).message.content;
    expect(c.match(/<\/cross-session-message>/g)).toHaveLength(1);
    expect(c.endsWith("</cross-session-message>")).toBe(true);
  });
});

describe("escapeForTag", () => {
  it("não deixa passar a tag de fechamento", () => {
    const s = escapeForTag("a </cross-session-message> b");
    expect(s).not.toContain("</cross-session-message>");
    expect(s).toBe("a &lt;/cross-session-message&gt; b");
  });

  it("escapa & primeiro (sem escape duplo)", () => {
    expect(escapeForTag("&lt; & <")).toBe("&amp;lt; &amp; &lt;");
  });
});

describe("isWindowsPipe", () => {
  it("reconhece \\\\.\\pipe\\ e \\\\?\\pipe\\", () => {
    expect(isWindowsPipe("\\\\.\\pipe\\LOCAL\\cc-msg-abc")).toBe(true);
    expect(isWindowsPipe("\\\\?\\pipe\\LOCAL\\cc-msg-abc")).toBe(true);
    expect(isWindowsPipe("\\\\.\\PIPE\\x")).toBe(true);
    expect(isWindowsPipe("/run/user/1000/cc-socks/1.sock")).toBe(false);
  });
});

describe("injectPrompt", () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-inject-"));
    netCtl.connects = 0;
    netCtl.hang = false;
  });

  afterEach(async () => {
    vi.useRealTimers();
    const s = server;
    server = undefined;
    if (s !== undefined) await new Promise<void>((r) => s.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Servidor de inbox falso: resolve com tudo o que um cliente mandou até fechar. */
  async function fakeInbox(): Promise<{ path: string; received: Promise<string> }> {
    const path = join(dir, "inbox.sock");
    let resolveData!: (s: string) => void;
    const received = new Promise<string>((r) => (resolveData = r));
    const srv = createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (d: string) => (buf += d));
      sock.on("end", () => {
        sock.end();
        resolveData(buf);
      });
    });
    server = srv;
    await new Promise<void>((r) => srv.listen(path, () => r()));
    return { path, received };
  }

  it("sem peerToken entrega exatamente 1 linha terminada em \\n e parseável", async () => {
    const { path, received } = await fakeInbox();
    await injectPrompt({ messagingSocketPath: path }, "oi", { name: "discord:leo" });
    const data = await received;
    const lines = data.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const m = parse(`${lines[0] ?? ""}\n`);
    expect(m.message.content).toContain("\noi\n");
  });

  it("com peerToken entrega 2 linhas, a primeira é a de auth", async () => {
    const { path, received } = await fakeInbox();
    await injectPrompt({ messagingSocketPath: path, peerToken: "abc", peerProtocol: 1 }, "oi", { name: "x" });
    const lines = (await received).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('{"type":"auth","token":"abc"}');
    expect(parse(`${lines[1] ?? ""}\n`).type).toBe("user");
    expect(lines[2]).toBe("");
  });

  it("peerProtocol 2 → InboxFormatError sem conectar", async () => {
    await expect(
      injectPrompt({ messagingSocketPath: join(dir, "x.sock"), peerProtocol: 2 }, "oi", { name: "x" }),
    ).rejects.toBeInstanceOf(InboxFormatError);
    expect(netCtl.connects).toBe(0);
  });

  it("named pipe do Windows sem peerToken → InboxAuthError sem conectar", async () => {
    await expect(
      injectPrompt({ messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-abc" }, "oi", { name: "x" }),
    ).rejects.toBeInstanceOf(InboxAuthError);
    expect(netCtl.connects).toBe(0);
  });

  it("caminho inexistente → rejeita rápido com inbox indisponível (ENOENT)", async () => {
    const t0 = Date.now();
    await expect(injectPrompt({ messagingSocketPath: join(dir, "nada.sock") }, "oi", { name: "x" })).rejects.toThrow(
      "inbox da sessão indisponível (ENOENT)",
    );
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("conexão que não completa em 5 s → tempo esgotado", async () => {
    vi.useFakeTimers();
    netCtl.hang = true;
    const p = injectPrompt({ messagingSocketPath: join(dir, "trava.sock") }, "oi", { name: "x" });
    const assertion = expect(p).rejects.toThrow("tempo esgotado");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(netCtl.connects).toBe(1);
  });
});
