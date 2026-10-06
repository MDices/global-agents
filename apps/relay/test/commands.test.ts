import { newEnvelope, RelayCommandSchema, type AgentEvent, type RelayCommand } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_TTL_MS,
  createCommandBridge,
  EXPIRED_TEXT,
  EXPIRY_INTERVAL_MS,
  REJECT_CLAUDE_COMMAND_TEXT,
  type CommandBridge,
  type ThreadMessage,
} from "../src/commands.js";
import { openDb, type Db } from "../src/db.js";
import { FakeDiscordPort } from "./helpers/fake-discord.js";

const M = "fedora/leonardo";
const OTHER = "toneli-pc/admin";
const THREAD = "th-1";
const SESSION = "7f3c2a91-0000-4000-8000-000000000001";
const ALLOWED = "user-leonardo";

/** Hub falso: `online` decide `isOnline`; `send` grava e devolve `sendResult` (padrão: igual a `online`). */
class FakeHub {
  online = new Set<string>();
  sent: { machine: string; cmd: RelayCommand }[] = [];
  sendResult: ((machine: string, n: number) => boolean) | undefined;
  isOnline(machine: string): boolean { return this.online.has(machine); }
  send(machine: string, cmd: RelayCommand): boolean {
    const ok = this.sendResult === undefined ? this.online.has(machine) : this.sendResult(machine, this.sent.length);
    if (ok) this.sent.push({ machine, cmd });
    return ok;
  }
}

let db: Db;
let port: FakeDiscordPort;
let hub: FakeHub;
let bridge: CommandBridge;
let log: ReturnType<typeof vi.fn<(msg: string) => void>>;

const msg = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  authorId: ALLOWED, threadId: THREAD, messageId: "m-1", content: "roda os testes", isBot: false, ...over,
});
const ack = (commandId: string, machine = M): AgentEvent => ({ ...newEnvelope(machine), type: "command.ack", commandId });
const err = (commandId: string, reason: string, machine = M): AgentEvent =>
  ({ ...newEnvelope(machine), type: "command.error", commandId, reason });
const settle = async (): Promise<void> => {
  await bridge.idle();
  await vi.advanceTimersByTimeAsync(0);
};
const ops = (): string[] =>
  port.calls.flatMap((c) => {
    switch (c.op) {
      case "react": return [`react ${c.channelId} ${c.messageId} ${c.emoji}`];
      case "removeReaction": return [`unreact ${c.channelId} ${c.messageId} ${c.emoji}`];
      case "reply": return [`reply ${c.channelId} ${c.messageId} ${c.text}`];
      case "post": return [`post ${c.targetId} ${c.text}`];
      default: return [];
    }
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T14:00:00Z"));
  db = openDb(":memory:");
  db.sessions.upsert({ sessionId: SESSION, machine: M, name: "correcoes-bugs", threadId: THREAD, state: "done", updatedAt: 1 });
  port = new FakeDiscordPort();
  hub = new FakeHub();
  log = vi.fn<(msg: string) => void>();
  bridge = createCommandBridge({ db, hub, port, allowedUserIds: [ALLOWED], log });
});

afterEach(() => {
  bridge.dispose();
  db.close();
  vi.useRealTimers();
});

describe("onThreadMessage: filtros", () => {
  it("autor fora da allowlist → nada enviado, nada no Discord, nada na fila", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg({ authorId: "intruso" }));
    await settle();
    expect(hub.sent).toEqual([]);
    expect(port.calls).toEqual([]);
    expect(db.pendingCommands.listDue(M)).toEqual([]);
  });

  it("autor fora da allowlist com a máquina offline → nem fila nem ⏳", async () => {
    await bridge.onThreadMessage(msg({ authorId: "intruso" }));
    await settle();
    expect(port.calls).toEqual([]);
    expect(db.pendingCommands.listDue(M)).toEqual([]);
  });

  it("bot (mesmo com id na allowlist) é ignorado", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg({ isBot: true }));
    await settle();
    expect(hub.sent).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("thread que não é de nenhuma sessão é ignorada", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg({ threadId: "th-desconhecida" }));
    await settle();
    expect(hub.sent).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("mensagem sem texto (só anexo) é ignorada", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg({ content: "   \n " }));
    await settle();
    expect(hub.sent).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it.each(["/compact", "!ls", "  /clear"])("%j → ❌ e resposta, nada enviado", async (content) => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg({ content }));
    await settle();
    expect(hub.sent).toEqual([]);
    expect(db.pendingCommands.listDue(M)).toEqual([]);
    expect(ops()).toEqual([`react ${THREAD} m-1 ❌`, `reply ${THREAD} m-1 ${REJECT_CLAUDE_COMMAND_TEXT}`]);
    expect(REJECT_CLAUDE_COMMAND_TEXT).toBe("comandos do Claude não são aceitos aqui; use /claude dentro da thread");
  });
});

describe("máquina online", () => {
  it("envia session.send com commandId = id da mensagem, sem reação até o ack", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg({ content: "roda os testes\ne me diz o resultado" }));
    await settle();
    expect(hub.sent).toHaveLength(1);
    const { machine, cmd } = hub.sent[0]!;
    expect(machine).toBe(M);
    expect(RelayCommandSchema.safeParse(cmd).success).toBe(true);
    expect(cmd).toMatchObject({
      type: "session.send", commandId: "m-1", sessionId: SESSION, text: "roda os testes\ne me diz o resultado", machine: "relay/vps",
    });
    expect(port.calls).toEqual([]);
    expect(db.pendingCommands.listDue(M)).toEqual([]);
  });

  it("command.ack → ✅ na mensagem (sem mexer em ⏳ que nunca foi posto)", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg());
    await bridge.onAck(M, ack("m-1"));
    await settle();
    expect(ops()).toEqual([`react ${THREAD} m-1 ✅`]);
  });

  it("command.error → ❌ e resposta com a razão", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg());
    await bridge.onAck(M, err("m-1", "sessão encerrada; use /novo para continuar"));
    await settle();
    expect(ops()).toEqual([`react ${THREAD} m-1 ❌`, `reply ${THREAD} m-1 ❌ sessão encerrada; use /novo para continuar`]);
  });

  it("razão longa vira várias respostas de até 2000 caracteres", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg());
    await bridge.onAck(M, err("m-1", "falha ao injetar o prompt na sessão ".repeat(150)));
    await settle();
    const replies = port.of("reply");
    expect(replies.length).toBeGreaterThan(1);
    for (const r of replies) expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(replies[0]?.text.startsWith("❌ ")).toBe(true);
  });

  it("ack repetido ou de comando desconhecido não faz nada", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg());
    await bridge.onAck(M, ack("m-1"));
    await bridge.onAck(M, ack("m-1"));
    await bridge.onAck(M, ack("nao-existe"));
    await settle();
    expect(ops()).toEqual([`react ${THREAD} m-1 ✅`]);
  });

  it("ack vindo de outra máquina é ignorado", async () => {
    hub.online.add(M);
    await bridge.onThreadMessage(msg());
    await bridge.onAck(OTHER, ack("m-1", OTHER));
    await settle();
    expect(port.calls).toEqual([]);
    await bridge.onAck(M, ack("m-1"));
    await settle();
    expect(ops()).toEqual([`react ${THREAD} m-1 ✅`]);
  });

  it("eventos que não são ack/erro são ignorados", async () => {
    await bridge.onAck(M, { ...newEnvelope(M), type: "agent.warning", message: "x" });
    await settle();
    expect(port.calls).toEqual([]);
  });

  it("isOnline mas o envio falha (conexão caiu agora) → vai para a fila com ⏳", async () => {
    hub.online.add(M);
    hub.sendResult = () => false;
    await bridge.onThreadMessage(msg());
    await settle();
    expect(db.pendingCommands.listDue(M).map((c) => c.commandId)).toEqual(["m-1"]);
    expect(ops()).toEqual([`react ${THREAD} m-1 ⏳`]);
  });
});

describe("máquina offline", () => {
  it("vai para a fila (expira em 1 h) e reage ⏳", async () => {
    await bridge.onThreadMessage(msg());
    await settle();
    expect(hub.sent).toEqual([]);
    const due = db.pendingCommands.listDue(M);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ commandId: "m-1", machine: M, discordMessageId: "m-1", expiresAt: Date.now() + COMMAND_TTL_MS });
    expect(COMMAND_TTL_MS).toBe(3_600_000);
    expect(ops()).toEqual([`react ${THREAD} m-1 ⏳`]);
  });

  it("onMachineOnline drena em ordem com o commandId original e esvazia a fila", async () => {
    await bridge.onThreadMessage(msg({ messageId: "m-1", content: "primeiro" }));
    vi.advanceTimersByTime(1000);
    await bridge.onThreadMessage(msg({ messageId: "m-2", content: "segundo" }));
    await settle();
    const queued = db.pendingCommands.listDue(M).map((c) => RelayCommandSchema.parse(JSON.parse(c.payload)));
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    await settle();
    expect(hub.sent.map((s) => [s.cmd.commandId, (s.cmd as Extract<RelayCommand, { type: "session.send" }>).text]))
      .toEqual([["m-1", "primeiro"], ["m-2", "segundo"]]);
    // reenvio idêntico (mesmo envelope): a deduplicação do agente por commandId continua valendo
    expect(hub.sent.map((s) => s.cmd)).toEqual(queued);
    expect(db.pendingCommands.listDue(M)).toEqual([]);
  });

  it("ack de comando drenado troca ⏳ por ✅", async () => {
    await bridge.onThreadMessage(msg());
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    await bridge.onAck(M, ack("m-1"));
    await settle();
    expect(ops()).toEqual([`react ${THREAD} m-1 ⏳`, `unreact ${THREAD} m-1 ⏳`, `react ${THREAD} m-1 ✅`]);
  });

  it("erro de comando drenado troca ⏳ por ❌ e responde com a razão", async () => {
    await bridge.onThreadMessage(msg());
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    await bridge.onAck(M, err("m-1", "sessão não encontrada"));
    await settle();
    expect(ops()).toEqual([
      `react ${THREAD} m-1 ⏳`, `unreact ${THREAD} m-1 ⏳`, `react ${THREAD} m-1 ❌`, `reply ${THREAD} m-1 ❌ sessão não encontrada`,
    ]);
  });

  it("se a máquina cai no meio da drenagem, o resto fica na fila", async () => {
    for (const id of ["m-1", "m-2", "m-3"]) {
      await bridge.onThreadMessage(msg({ messageId: id }));
      vi.advanceTimersByTime(10);
    }
    hub.online.add(M);
    hub.sendResult = (_m, n) => n < 1; // o primeiro passa, o segundo falha
    await bridge.onMachineOnline(M);
    await settle();
    expect(hub.sent.map((s) => s.cmd.commandId)).toEqual(["m-1"]);
    expect(db.pendingCommands.listDue(M).map((c) => c.commandId)).toEqual(["m-2", "m-3"]);
  });

  it("drenagem de uma máquina não mexe na fila de outra", async () => {
    db.sessions.upsert({ sessionId: "s-outra", machine: OTHER, threadId: "th-2", state: "done", updatedAt: 1 });
    await bridge.onThreadMessage(msg({ messageId: "m-1" }));
    await bridge.onThreadMessage(msg({ messageId: "m-9", threadId: "th-2" }));
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    await settle();
    expect(hub.sent.map((s) => s.cmd.commandId)).toEqual(["m-1"]);
    expect(db.pendingCommands.listDue(OTHER).map((c) => c.commandId)).toEqual(["m-9"]);
  });

  it("máquina volta entre a checagem e a gravação na fila → drena na hora", async () => {
    // isOnline responde false na checagem do envio e true logo depois (o `online` já passou com a fila vazia)
    let calls = 0;
    hub.isOnline = (machine: string): boolean => {
      calls++;
      if (calls > 1) hub.online.add(machine);
      return calls > 1;
    };
    await bridge.onThreadMessage(msg());
    await settle();
    expect(hub.sent.map((s) => s.cmd.commandId)).toEqual(["m-1"]);
    expect(db.pendingCommands.listDue(M)).toEqual([]);
  });

  it("payload inválido na fila é descartado com log, sem travar os seguintes", async () => {
    db.pendingCommands.add({ commandId: "lixo", machine: M, payload: "{não é json", createdAt: Date.now() - 5, expiresAt: Date.now() + 1000 });
    await bridge.onThreadMessage(msg());
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    await settle();
    expect(hub.sent.map((s) => s.cmd.commandId)).toEqual(["m-1"]);
    expect(db.pendingCommands.listDue(M)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("lixo"));
  });

  it("⏳ ainda em voo quando o ack chega: a remoção espera a reação terminar", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const react = port.react.bind(port);
    port.react = async (channelId, messageId, emoji) => {
      if (emoji === "⏳") await slow;
      order.push(`react ${emoji}`);
      await react(channelId, messageId, emoji);
    };
    const unreact = port.removeReaction.bind(port);
    port.removeReaction = async (channelId, messageId, emoji) => {
      order.push(`unreact ${emoji}`);
      await unreact(channelId, messageId, emoji);
    };
    await bridge.onThreadMessage(msg());
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    await bridge.onAck(M, ack("m-1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    release();
    await settle();
    expect(order).toEqual(["react ⏳", "unreact ⏳", "react ✅"]);
  });
});

describe("expiração", () => {
  it("a cada 60 s: comando com mais de 1 h troca ⏳ por ❌ e responde que expirou", async () => {
    bridge.start();
    await bridge.onThreadMessage(msg());
    await settle();
    await vi.advanceTimersByTimeAsync(COMMAND_TTL_MS - EXPIRY_INTERVAL_MS);
    await settle();
    expect(ops()).toEqual([`react ${THREAD} m-1 ⏳`]);
    await vi.advanceTimersByTimeAsync(2 * EXPIRY_INTERVAL_MS);
    await settle();
    expect(EXPIRY_INTERVAL_MS).toBe(60_000);
    expect(EXPIRED_TEXT).toBe("comando expirou: máquina offline por mais de 1 h");
    expect(ops()).toEqual([
      `react ${THREAD} m-1 ⏳`, `unreact ${THREAD} m-1 ⏳`, `react ${THREAD} m-1 ❌`, `reply ${THREAD} m-1 ${EXPIRED_TEXT}`,
    ]);
    expect(db.pendingCommands.listDue(M, 0)).toEqual([]);
    // a máquina voltando depois não reenvia o expirado
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    expect(hub.sent).toEqual([]);
  });

  it("máquina que volta com comando já vencido (antes do tick) não o envia e avisa na hora", async () => {
    await bridge.onThreadMessage(msg());
    vi.advanceTimersByTime(COMMAND_TTL_MS + 1);
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    await settle();
    expect(hub.sent).toEqual([]);
    expect(ops()).toContain(`reply ${THREAD} m-1 ${EXPIRED_TEXT}`);
  });

  it("expirado de sessão que sumiu do banco: log, sem quebrar", async () => {
    db.pendingCommands.add({
      commandId: "orfao", machine: M, discordMessageId: "orfao", createdAt: Date.now(), expiresAt: Date.now() + 10,
      payload: JSON.stringify({ ...newEnvelope("relay/vps"), type: "session.send", commandId: "orfao", sessionId: "sumiu", text: "oi" }),
    });
    bridge.start();
    await vi.advanceTimersByTimeAsync(EXPIRY_INTERVAL_MS);
    await settle();
    expect(port.calls).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("orfao"));
  });

  it("dispose para o loop", async () => {
    bridge.start();
    await bridge.onThreadMessage(msg());
    bridge.dispose();
    await vi.advanceTimersByTimeAsync(COMMAND_TTL_MS + 2 * EXPIRY_INTERVAL_MS);
    await settle();
    expect(ops()).toEqual([`react ${THREAD} m-1 ⏳`]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("falhas do Discord", () => {
  it("erro em react/reply vai para o log e não rejeita", async () => {
    port.react = () => Promise.reject(new Error("Missing Permissions"));
    port.reply = () => Promise.reject(new Error("Unknown Message"));
    await expect(bridge.onThreadMessage(msg({ content: "/compact" }))).resolves.toBeUndefined();
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Missing Permissions"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Unknown Message"));
  });
});
