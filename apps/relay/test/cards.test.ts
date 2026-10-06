import { EventEmitter } from "node:events";
import { newEnvelope, type AgentEvent, type RelayCommand } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import type { CardSpec } from "../src/discord/bot.js";
import {
  ALREADY_DECIDED_TEXT,
  EXPIRY_GRACE_MS,
  SWEEP_INTERVAL_MS,
  OFFLINE_DECIDE_TEXT,
  PREVIEW_MAX,
  buildPermissionCard,
  createPermissionFlow,
  type PermissionFlow,
} from "../src/discord/cards.js";
import { NOT_ALLOWED_TEXT, type ButtonInteraction, type SlashView } from "../src/discord/slash.js";
import { hhmm, ThreadRegistry } from "../src/discord/threads.js";
import { createRouter, machineChannelResolver, type Router } from "../src/router.js";
import type { AgentHubEvents } from "../src/ws/server.js";
import { FakeDiscordPort } from "./helpers/fake-discord.js";

const M = "fedora/leonardo";
const ALLOWED = "user-leonardo";
const ALLOWED_2 = "user-toneli";
const STRANGER = "user-estranho";
const SESSION = "sess-3c9a";
const REQ = "3c9a1b2c-0d4e-4f5a-8b6c-7d8e9f0a1b2c";
const NOW = new Date(2026, 9, 6, 14, 46);
const EXPIRES = new Date(NOW.getTime() + 29 * 60_000);

class FakeHub extends EventEmitter<AgentHubEvents> {
  online = new Set<string>();
  sent: { machine: string; cmd: RelayCommand }[] = [];
  isOnline(machine: string): boolean { return this.online.has(machine); }
  send(machine: string, cmd: RelayCommand): boolean {
    if (!this.online.has(machine)) return false;
    this.sent.push({ machine, cmd });
    return true;
  }
}

type Body<T extends AgentEvent["type"]> = Omit<Extract<AgentEvent, { type: T }>, "v" | "id" | "ts" | "machine" | "type">;
const ev = <T extends AgentEvent["type"]>(type: T, body: Body<T>): Extract<AgentEvent, { type: T }> =>
  ({ ...newEnvelope(M), type, ...body }) as Extract<AgentEvent, { type: T }>;

const request = (over: Partial<Body<"permission.request">> = {}): Extract<AgentEvent, { type: "permission.request" }> =>
  ev("permission.request", {
    sessionId: SESSION,
    requestId: REQ,
    tool: "Bash",
    description: "Rodar a suíte de specs de faturamento",
    inputPreview: "bundle exec rspec spec/services/faturamento",
    expiresAt: EXPIRES.toISOString(),
    ...over,
  });

type FakeButton = ButtonInteraction & { updates: SlashView[]; edits: SlashView[]; replies: { view: SlashView; ephemeral: boolean }[] };
let seq = 0;
function button(customId: string, userId = ALLOWED): FakeButton {
  const updates: SlashView[] = [];
  const edits: SlashView[] = [];
  const replies: { view: SlashView; ephemeral: boolean }[] = [];
  return {
    kind: "button",
    id: `btn-${++seq}`,
    customId,
    channelId: "th-sessao",
    user: { id: userId, username: "leonardo" },
    update: async (view) => { updates.push(view); },
    editReply: async (view) => { edits.push(view); },
    reply: async (view, ephemeral) => { replies.push({ view, ephemeral }); },
    updates,
    edits,
    replies,
  };
}

let db: Db;
let port: FakeDiscordPort;
let hub: FakeHub;
let threads: ThreadRegistry;
let router: Router;
let flow: PermissionFlow;
let log: ReturnType<typeof vi.fn<(msg: string) => void>>;

const settle = async (): Promise<void> => {
  await router.idle();
  await flow.idle();
};
const lastEdit = (): CardSpec => {
  const c = port.of("editCard").at(-1)?.card;
  if (c === undefined) throw new Error("nenhum card editado");
  return c;
};
const decidesSent = (): RelayCommand[] => hub.sent.map((s) => s.cmd).filter((c) => c.type === "permission.decide");
const ephemeralTexts = (b: FakeButton): string[] => b.replies.filter((r) => r.ephemeral).map((r) => r.view.content ?? "");

async function requestPosted(over: Partial<Body<"permission.request">> = {}): Promise<void> {
  hub.emit("event", M, request(over));
  await settle();
}
async function click(customId: string, userId = ALLOWED): Promise<FakeButton> {
  const b = button(customId, userId);
  await flow.onButton(b);
  await flow.idle();
  return b;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = openDb(":memory:");
  db.machines.upsert({ name: M, tokenHash: "h" });
  db.sessions.upsert({ sessionId: SESSION, machine: M, name: "correcoes-bugs", cwd: "/w", state: "working", updatedAt: 1 });
  port = new FakeDiscordPort();
  hub = new FakeHub();
  log = vi.fn<(msg: string) => void>();
  threads = new ThreadRegistry({ db, port, channelFor: machineChannelResolver(db, port), log });
  flow = createPermissionFlow({ db, hub, port, allowedUserIds: [ALLOWED, ALLOWED_2], log });
  router = createRouter({ db, port, threads, hub, log, permissions: flow });
  hub.online.add(M);
});

afterEach(() => {
  router.dispose();
  flow.dispose();
  threads.dispose();
  db.close();
  vi.useRealTimers();
});

describe("buildPermissionCard", () => {
  it("pendente: título com a ferramenta, descrição, prévia em bloco de código, expiração relativa, amarelo e 2 botões", () => {
    const card = buildPermissionCard(request(), "pending");
    expect(card.embed.title).toBe("🔐 Permissão: Bash");
    expect(card.embed.description).toContain("Rodar a suíte de specs de faturamento");
    expect(card.embed.description).toContain(`expira <t:${Math.floor(EXPIRES.getTime() / 1000)}:R>`);
    expect(card.embed.color).toBe(0xfee75c);
    expect(card.embed.fields?.[0]?.value).toBe("```\nbundle exec rspec spec/services/faturamento\n```");
    expect(card.buttons).toEqual([
      { customId: `perm:allow:${REQ}`, label: "Permitir", style: "success" },
      { customId: `perm:deny:${REQ}`, label: "Negar", style: "danger" },
    ]);
  });

  it("descrição vazia vira `sem descrição`", () => {
    expect(buildPermissionCard(request({ description: "" }), "pending").embed.description).toContain("sem descrição");
  });

  it("prévia de 5000 caracteres é cortada a 1000 com `…`", () => {
    const value = buildPermissionCard(request({ inputPreview: "x".repeat(5000) }), "pending").embed.fields?.[0]?.value ?? "";
    const inner = value.slice("```\n".length, -"\n```".length);
    expect(inner).toHaveLength(PREVIEW_MAX);
    expect(inner.endsWith("…")).toBe(true);
    expect(value.length).toBeLessThanOrEqual(1024);
  });

  it("corte nunca separa um par substituto", () => {
    const value = buildPermissionCard(request({ inputPreview: `${"a".repeat(PREVIEW_MAX - 2)}😀😀😀` }), "pending").embed.fields?.[0]?.value ?? "";
    const inner = value.slice("```\n".length, -"\n```".length);
    expect(inner).toBe(`${"a".repeat(PREVIEW_MAX - 2)}…`);
  });

  it("``` dentro da prévia é neutralizado e não fecha o bloco", () => {
    const value = buildPermissionCard(request({ inputPreview: "echo ```oi```" }), "pending").embed.fields?.[0]?.value ?? "";
    expect(value.slice(4, -4)).not.toContain("```");
    expect(value.slice(4, -4)).toContain("`​`​`");
  });

  it("desfechos: sem prévia nem botões, com a cor e a linha de quem decidiu", () => {
    const at = new Date(2026, 9, 6, 11, 46);
    const allow = buildPermissionCard(request(), { by: "remote", behavior: "allow", who: ALLOWED, at });
    expect(allow.embed.description).toContain(`✅ permitido por <@${ALLOWED}> às ${hhmm(at)} via Discord`);
    expect(allow.embed.fields ?? []).toEqual([]);
    expect(allow.buttons).toEqual([]);
    expect(allow.embed.color).toBe(0x57f287);
    expect(allow.embed.title).toBe("🔐 Permissão: Bash");
    const deny = buildPermissionCard(request(), { by: "remote", behavior: "deny", who: ALLOWED, at });
    expect(deny.embed.description).toContain(`⛔ negado por <@${ALLOWED}> às ${hhmm(at)} via Discord`);
    expect(deny.embed.color).toBe(0xed4245);
    const terminal = buildPermissionCard(request(), { by: "terminal", at });
    expect(terminal.embed.description).toContain("🖥️ decidido no terminal");
    expect(terminal.embed.color).toBe(0x99aab5);
    const noBehavior = buildPermissionCard(request(), { by: "remote", who: ALLOWED, at });
    expect(noBehavior.embed.description).toContain(`⛔ negado por <@${ALLOWED}>`);
    expect(noBehavior.embed.color).toBe(0xed4245);
    const timeout = buildPermissionCard(request(), { by: "timeout", behavior: "deny", at });
    expect(timeout.embed.description).toContain("⏳ expirou (negado automaticamente)");
    expect(timeout.embed.color).toBe(0xed4245);
  });
});

describe("fluxo de permissão", () => {
  it("permission.request posta o card na thread da sessão mencionando a allowlist e grava `permissions`", async () => {
    await requestPosted();
    const call = port.of("postCard")[0];
    expect(call?.card.embed.title).toContain("Bash");
    expect(call?.card.buttons).toHaveLength(2);
    expect(call?.card.content).toBe(`<@${ALLOWED}> <@${ALLOWED_2}>`);
    expect(call?.card.mentions).toEqual([ALLOWED, ALLOWED_2]);
    const threadId = db.sessions.get(SESSION)?.threadId;
    expect(threadId).toBeTruthy();
    expect(call?.threadId).toBe(threadId);
    expect(db.permissions.get(REQ)).toMatchObject({ sessionId: SESSION, status: "pending", messageId: expect.any(String) });
  });

  it("permission.request repetido não posta um segundo card", async () => {
    await requestPosted();
    await requestPosted();
    expect(port.of("postCard")).toHaveLength(1);
  });

  it("clique Permitir de usuário permitido: card em `decidindo…` e permission.decide allow", async () => {
    await requestPosted();
    const b = await click(`perm:allow:${REQ}`);
    expect(b.updates).toHaveLength(1);
    expect(b.updates[0]?.embeds?.[0]?.description).toContain("⏳ decidindo…");
    expect(b.updates[0]?.buttons?.every((x) => x.disabled === true)).toBe(true);
    expect(decidesSent()).toEqual([
      expect.objectContaining({ type: "permission.decide", commandId: `perm-${REQ}-allow`, requestId: REQ, behavior: "allow" }),
    ]);
    expect(hub.sent[0]?.machine).toBe(M);
  });

  it("segundo clique responde `já decidido` sem novo envio", async () => {
    await requestPosted();
    await click(`perm:allow:${REQ}`);
    const again = await click(`perm:deny:${REQ}`, ALLOWED_2);
    expect(ephemeralTexts(again)).toEqual([ALREADY_DECIDED_TEXT]);
    expect(again.updates).toEqual([]);
    expect(decidesSent()).toHaveLength(1);
  });

  it("permission.resolved remoto edita o card com quem clicou, sem botões, e resolve no banco", async () => {
    await requestPosted();
    await click(`perm:deny:${REQ}`);
    hub.emit("event", M, ev("permission.resolved", { requestId: REQ, by: "remote", behavior: "deny" }));
    await settle();
    const card = lastEdit();
    expect(card.embed.description).toContain(`⛔ negado por <@${ALLOWED}> às ${hhmm(NOW)} via Discord`);
    expect(card.buttons).toEqual([]);
    expect(card.embed.fields ?? []).toEqual([]);
    expect(port.of("editCard")[0]?.messageId).toBe(db.permissions.get(REQ)?.messageId);
    expect(db.permissions.get(REQ)).toMatchObject({ status: "denied", decidedBy: ALLOWED });
    const late = await click(`perm:allow:${REQ}`);
    expect(ephemeralTexts(late)).toEqual([ALREADY_DECIDED_TEXT]);
  });

  it("permission.resolved by=terminal edita o card com `terminal`", async () => {
    await requestPosted();
    hub.emit("event", M, ev("permission.resolved", { requestId: REQ, by: "terminal", behavior: "allow" }));
    await settle();
    expect(lastEdit().embed.description).toContain("🖥️ decidido no terminal");
    expect(lastEdit().buttons).toEqual([]);
    expect(db.permissions.get(REQ)?.status).toBe("terminal");
  });

  it("permission.resolved by=timeout edita o card com a expiração", async () => {
    await requestPosted();
    hub.emit("event", M, ev("permission.resolved", { requestId: REQ, by: "timeout", behavior: "deny" }));
    await settle();
    expect(lastEdit().embed.description).toContain("⏳ expirou (negado automaticamente)");
    expect(db.permissions.get(REQ)?.status).toBe("expired");
  });

  it("permission.resolved repetido edita uma vez só; desconhecido é ignorado", async () => {
    await requestPosted();
    const resolved = ev("permission.resolved", { requestId: REQ, by: "terminal" });
    hub.emit("event", M, resolved);
    hub.emit("event", M, resolved);
    hub.emit("event", M, ev("permission.resolved", { requestId: "outro", by: "timeout" }));
    await settle();
    expect(port.of("editCard")).toHaveLength(1);
  });

  it("usuário fora da allowlist recebe `sem permissão` e nada é enviado", async () => {
    await requestPosted();
    const b = await click(`perm:allow:${REQ}`, STRANGER);
    expect(ephemeralTexts(b)).toEqual([NOT_ALLOWED_TEXT]);
    expect(b.updates).toEqual([]);
    expect(hub.sent).toEqual([]);
  });

  it("máquina offline: efêmero `máquina offline; decida no terminal`, botões continuam e um novo clique funciona", async () => {
    await requestPosted();
    hub.online.delete(M);
    const b = await click(`perm:allow:${REQ}`);
    expect(ephemeralTexts(b)).toEqual([OFFLINE_DECIDE_TEXT]);
    expect(OFFLINE_DECIDE_TEXT).toBe("máquina offline; decida no terminal");
    expect([...b.updates, ...b.edits].every((v) => (v.buttons ?? []).every((x) => x.disabled !== true))).toBe(true);
    expect(hub.sent).toEqual([]);
    hub.online.add(M);
    await click(`perm:allow:${REQ}`);
    expect(decidesSent()).toHaveLength(1);
  });

  it("command.error do permission.decide: card volta a pendente com `⚠️ <razão>` e sem botões", async () => {
    await requestPosted();
    await click(`perm:allow:${REQ}`);
    flow.onCommandResult(M, { ...newEnvelope(M), type: "command.error", commandId: `perm-${REQ}-allow`, reason: "pedido de permissão não encontrado ou já resolvido" });
    await flow.idle();
    const card = lastEdit();
    expect(card.embed.description).toContain("⚠️ pedido de permissão não encontrado ou já resolvido");
    expect(card.embed.description).not.toContain("decidindo");
    expect(card.embed.color).toBe(0xfee75c);
    expect(card.buttons).toEqual([]);
    // um desfecho que chegue depois ainda edita o card
    hub.emit("event", M, ev("permission.resolved", { requestId: REQ, by: "terminal" }));
    await settle();
    expect(lastEdit().embed.description).toContain("🖥️ decidido no terminal");
  });

  it("command.ack e erros de outros comandos não mexem no card", async () => {
    await requestPosted();
    await click(`perm:allow:${REQ}`);
    flow.onCommandResult(M, { ...newEnvelope(M), type: "command.ack", commandId: `perm-${REQ}-allow` });
    flow.onCommandResult(M, { ...newEnvelope(M), type: "command.error", commandId: "msg-123", reason: "x" });
    await flow.idle();
    expect(port.of("editCard")).toEqual([]);
  });

  it("botão de pedido desconhecido responde `já decidido`", async () => {
    const b = await click("perm:allow:nao-existe");
    expect(ephemeralTexts(b)).toEqual([ALREADY_DECIDED_TEXT]);
    expect(hub.sent).toEqual([]);
  });

  it("falha ao postar o card vai para o log e não grava pedido", async () => {
    port.postCard = () => Promise.reject(new Error("sem acesso"));
    await requestPosted();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("sem acesso"));
    expect(db.permissions.get(REQ)).toBeUndefined();
  });

  it("desfecho de um pedido de antes do reinício do relay ainda edita o card", async () => {
    // pedido gravado por um relay anterior (memória perdida no reinício)
    db.sessions.setThread(SESSION, "th-antiga");
    db.permissions.create({ requestId: REQ, sessionId: SESSION, messageId: "msg-antiga" });
    hub.emit("event", M, ev("permission.resolved", { requestId: REQ, by: "timeout" }));
    await settle();
    const call = port.of("editCard")[0];
    expect(call).toMatchObject({ threadId: "th-antiga", messageId: "msg-antiga" });
    expect(call?.card.embed.description).toContain("⏳ expirou (negado automaticamente)");
    expect(call?.card.buttons).toEqual([]);
  });
});

describe("endurecimento", () => {
  const OTHER = "outra/maquina";
  const fromOther = <T extends AgentEvent>(e: T): T => ({ ...e, machine: OTHER });

  it("permission.request de outra máquina para a sessão é ignorado, sem thread nem card", async () => {
    hub.emit("event", OTHER, fromOther(request()));
    await settle();
    expect(port.of("postCard")).toEqual([]);
    expect(port.of("createThread")).toEqual([]);
    expect(db.permissions.get(REQ)).toBeUndefined();
  });

  it("permission.resolved de outra máquina não resolve nem edita o card", async () => {
    await requestPosted();
    hub.emit("event", OTHER, fromOther(ev("permission.resolved", { requestId: REQ, by: "terminal" })));
    await settle();
    expect(port.of("editCard")).toEqual([]);
    expect(db.permissions.get(REQ)?.status).toBe("pending");
  });

  it("command.error de outra máquina não mexe no card", async () => {
    await requestPosted();
    await click(`perm:allow:${REQ}`);
    flow.onCommandResult(OTHER, { ...newEnvelope(OTHER), type: "command.error", commandId: `perm-${REQ}-allow`, reason: "x" });
    await flow.idle();
    expect(port.of("editCard")).toEqual([]);
  });

  it("filtro de conta ligado depois do card não derruba o permission.resolved", async () => {
    await requestPosted();
    db.machines.setFilterAccount(M, "outra@conta.com");
    hub.emit("event", M, ev("permission.resolved", { requestId: REQ, by: "terminal" }));
    await settle();
    expect(lastEdit().embed.description).toContain("🖥️ decidido no terminal");
  });

  it("remote sem behavior é gravado como negado", async () => {
    await requestPosted();
    hub.emit("event", M, ev("permission.resolved", { requestId: REQ, by: "remote" }));
    await settle();
    expect(lastEdit().embed.description).toContain("⛔ negado");
    expect(db.permissions.get(REQ)?.status).toBe("denied");
  });

  it("varredura: pendente vencido há mais de 2 min vira expirado no card e no banco", async () => {
    flow.start();
    await requestPosted();
    await vi.advanceTimersByTimeAsync(EXPIRES.getTime() - NOW.getTime() + EXPIRY_GRACE_MS - SWEEP_INTERVAL_MS);
    await flow.idle();
    expect(port.of("editCard")).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * SWEEP_INTERVAL_MS); // o tick em 31 min ainda não passou da folga (estrito); o de 32 min expira
    await flow.idle();
    expect(port.of("editCard")).toHaveLength(1);
    expect(lastEdit().embed.description).toContain("⏳ expirou (negado automaticamente)");
    expect(lastEdit().buttons).toEqual([]);
    expect(db.permissions.get(REQ)?.status).toBe("expired");
    // um desfecho atrasado depois da varredura não edita de novo
    hub.emit("event", M, ev("permission.resolved", { requestId: REQ, by: "timeout" }));
    await settle();
    expect(port.of("editCard")).toHaveLength(1);
  });

  it("varredura sob demanda (reconexão) também expira; pedido ainda válido fica", async () => {
    await requestPosted();
    await flow.sweep();
    await flow.idle();
    expect(port.of("editCard")).toEqual([]);
    vi.setSystemTime(EXPIRES.getTime() + EXPIRY_GRACE_MS + 1);
    await flow.sweep();
    await flow.idle();
    expect(db.permissions.get(REQ)?.status).toBe("expired");
  });

  it("dispose desliga o loop da varredura", async () => {
    flow.start();
    flow.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
