import { EventEmitter } from "node:events";
import { newEnvelope, SLASH_ALLOWLIST, type AgentEvent, type RelayCommand } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandBridge, EXPIRED_TEXT, COMMAND_TTL_MS, type CommandBridge } from "../src/commands.js";
import { openDb, type Db } from "../src/db.js";
import { ThreadRegistry } from "../src/discord/threads.js";
import {
  CONFIRM_TIMEOUT_MS,
  CREATING_TEXT,
  NO_DEV_ROOT_TEXT,
  NO_PROJECTS_TEXT,
  NOT_ALLOWED_TEXT,
  NOT_MACHINE_CHANNEL_TEXT,
  NOT_SESSION_THREAD_TEXT,
  OFFLINE_TEXT,
  SLASH_COMMANDS,
  createSlashHandler,
  sessionName,
  slashResultMessages,
  stripMention,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  type SlashHandler,
  type SlashView,
} from "../src/discord/slash.js";
import { createRouter, machineChannelResolver, type Router } from "../src/router.js";
import type { AgentHubEvents } from "../src/ws/server.js";
import { FakeDiscordPort } from "./helpers/fake-discord.js";

const M = "fedora/leonardo";
const CH = "ch-1"; // primeiro canal do FakeDiscordPort
const ALLOWED = "user-leonardo";
const STRANGER = "user-estranho";
const PROJECTS = ["~/dev/work/gestai", "~/dev/work/global-agents", "~/dev/pessoal/dotfiles"];
const ACCOUNT = "leonardo@exemplo.com.br";

/** Hub falso: emissor de eventos para o router e `send`/`isOnline` para a ponte. */
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
const ev = <T extends AgentEvent["type"]>(type: T, body: Body<T>, machine = M): AgentEvent =>
  ({ ...newEnvelope(machine), type, ...body }) as AgentEvent;
const hello = (account = ACCOUNT): AgentEvent =>
  ev("agent.hello", { version: "0.1.0", os: "linux", osUser: "leonardo", claudeVersion: "2.1.291", claudeAccount: account, projects: PROJECTS });

let db: Db;
let port: FakeDiscordPort;
let hub: FakeHub;
let threads: ThreadRegistry;
let router: Router;
let bridge: CommandBridge;
let slash: SlashHandler;
let log: ReturnType<typeof vi.fn<(msg: string) => void>>;
let seq = 0;

type Reply = { view: SlashView; ephemeral: boolean };
interface FakeCommand extends CommandInteraction {
  replies: Reply[];
  edits: SlashView[];
}

function command(commandName: string, opts: Record<string, string | boolean> = {}, over: Partial<CommandInteraction> = {}): FakeCommand {
  const replies: Reply[] = [];
  const edits: SlashView[] = [];
  const { sub, ...rest } = opts;
  const strings = Object.fromEntries(Object.entries(rest).filter((e): e is [string, string] => typeof e[1] === "string"));
  const booleans = Object.fromEntries(Object.entries(rest).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
  return {
    kind: "command",
    id: `int-${++seq}`,
    commandName,
    channelId: CH,
    user: { id: ALLOWED, username: "leonardo" },
    options: {
      getString: (name) => strings[name] ?? null,
      getBoolean: (name) => booleans[name] ?? null,
      getSubcommand: () => (typeof sub === "string" ? sub : null),
    },
    reply: async (view, ephemeral) => { replies.push({ view, ephemeral }); },
    editReply: async (view) => { edits.push(view); },
    replies,
    edits,
    ...over,
  };
}

interface FakeButton extends ButtonInteraction {
  updates: SlashView[];
  edits: SlashView[];
  replies: Reply[];
}
function button(customId: string, userId = ALLOWED): FakeButton {
  const updates: SlashView[] = [];
  const edits: SlashView[] = [];
  const replies: Reply[] = [];
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

function autocomplete(value: string, userId = ALLOWED, name = "projeto"): AutocompleteInteraction & { choices: { name: string; value: string }[][] } {
  const choices: { name: string; value: string }[][] = [];
  return {
    kind: "autocomplete",
    id: `ac-${++seq}`,
    commandName: "novo",
    channelId: CH,
    user: { id: userId, username: "x" },
    focused: { name, value },
    respond: async (c) => { choices.push(c); },
    choices,
  };
}

const settle = async (): Promise<void> => {
  await router.idle();
  await slash.idle();
  await bridge.idle();
  await vi.advanceTimersByTimeAsync(0);
  await slash.idle();
};
const lastCmd = (): RelayCommand => {
  const c = hub.sent.at(-1)?.cmd;
  if (c === undefined) throw new Error("nada enviado");
  return c;
};
const ackOf = (commandId: string, result?: Record<string, unknown>): Promise<void> =>
  bridge.onAck(M, { ...newEnvelope(M), type: "command.ack", commandId, ...(result !== undefined ? { result } : {}) });
const errOf = (commandId: string, reason: string): Promise<void> =>
  bridge.onAck(M, { ...newEnvelope(M), type: "command.error", commandId, reason });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 6, 15, 10));
  seq = 0;
  db = openDb(":memory:");
  db.machines.upsert({ name: M, tokenHash: "h" });
  port = new FakeDiscordPort();
  // canal já existente com o tópico certo: o hello não edita nada
  port.presetChannel("fedora-leonardo", "fedora/leonardo · Linux · Claude Code 2.1.291 · leonardo@exemplo.com.br");
  hub = new FakeHub();
  log = vi.fn<(msg: string) => void>();
  threads = new ThreadRegistry({ db, port, channelFor: machineChannelResolver(db, port), log });
  router = createRouter({ db, port, threads, hub, log });
  bridge = createCommandBridge({ db, hub, port, allowedUserIds: [ALLOWED], log });
  slash = createSlashHandler({ db, threads, bridge, router, port, allowedUserIds: [ALLOWED], log });
  hub.online.add(M);
  hub.emit("event", M, hello());
  await router.idle();
  expect(db.machines.getByName(M)?.channelId).toBe(CH);
  port.calls.length = 0;
});

afterEach(() => {
  slash.dispose();
  bridge.dispose();
  router.dispose();
  threads.dispose();
  db.close();
  vi.useRealTimers();
});

describe("sessionName", () => {
  it("primeiras 6 palavras, minúsculas, acentos mantidos, o resto vira -", () => {
    expect(sessionName("Gera o relatório de Inadimplência de setembro por filial em CSV")).toBe("gera-o-relatório-de-inadimplência-de");
    expect(sessionName("  corrige   o bug #412 (urgente!)  ")).toBe("corrige-o-bug-412-urgente");
  });
  it("no máximo 60 caracteres, sem - no fim; vazio cai em sessao", () => {
    const n = sessionName("abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz");
    expect(n.length).toBeLessThanOrEqual(60);
    expect(n.endsWith("-")).toBe(false);
    expect(sessionName("!!! ???")).toBe("sessao");
    expect(sessionName("")).toBe("sessao");
  });
});

describe("stripMention", () => {
  it("tira <@id> e <@!id> do bot e apara o texto", () => {
    expect(stripMention("<@123> roda os testes", "123")).toBe("roda os testes");
    expect(stripMention("ei <@!123>   corrige o bug", "123")).toBe("ei corrige o bug");
    expect(stripMention("<@999> oi", "123")).toBe("<@999> oi");
  });
});

describe("SLASH_COMMANDS", () => {
  it("define /novo, /sessoes, /parar, /filtro e /claude com as opções combinadas", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(["novo", "sessoes", "parar", "filtro", "claude"]);
    const novo = SLASH_COMMANDS[0];
    expect(novo?.options?.map((o) => o.name)).toEqual(["prompt", "projeto", "modo", "criar"]);
    expect(novo?.options?.find((o) => o.name === "criar")).toMatchObject({
      type: 5, description: "Cria a pasta dentro da raiz dev se ela não existir",
    });
    for (const o of novo?.options ?? []) expect(o.description.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(novo)).toContain("\"max_length\":4000");
    expect(JSON.stringify(novo)).toContain("\"autocomplete\":true");
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"]) expect(JSON.stringify(novo)).toContain(`"value":"${mode}"`);
    expect(SLASH_COMMANDS[3]?.options?.map((o) => o.name)).toEqual(["conta", "desligar", "ver"]);
    const claude = SLASH_COMMANDS[4];
    expect(claude?.options?.map((o) => o.name)).toEqual(["comando", "args"]);
    const json = JSON.stringify(claude);
    for (const c of SLASH_ALLOWLIST) expect(json).toContain(`"value":"${c}"`);
    expect(json).not.toContain(`"value":"clear"`);
    expect(json).toContain("\"max_length\":500");
  });
});

describe("allowlist", () => {
  it("comando de quem não está na allowlist → efêmero sem permissão, nada enviado", async () => {
    const i = command("novo", { prompt: "oi" }, { user: { id: STRANGER, username: "x" } });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: NOT_ALLOWED_TEXT }, ephemeral: true }]);
    expect(hub.sent).toEqual([]);
  });
  it("autocomplete de quem não está na allowlist → nenhuma sugestão", async () => {
    const a = autocomplete("", STRANGER);
    await slash.onInteraction(a);
    await settle();
    expect(a.choices).toEqual([[]]);
  });
  it("botão de quem não está na allowlist → efêmero sem permissão", async () => {
    const b = button("parar:confirmar:int-x", STRANGER);
    await slash.onInteraction(b);
    await settle();
    expect(b.replies).toEqual([{ view: { content: NOT_ALLOWED_TEXT }, ephemeral: true }]);
    expect(hub.sent).toEqual([]);
  });
});

describe("/novo", () => {
  it("canal de máquina → efêmero criando sessão…, session.create com padrões (primeiro projeto, modo default)", async () => {
    const i = command("novo", { prompt: "Gera o relatório de inadimplência de setembro" });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: CREATING_TEXT }, ephemeral: true }]);
    const cmd = lastCmd();
    expect(hub.sent.at(-1)?.machine).toBe(M);
    expect(cmd).toMatchObject({
      type: "session.create", commandId: i.id, cwd: PROJECTS[0], name: "gera-o-relatório-de-inadimplência-de",
      prompt: "Gera o relatório de inadimplência de setembro", permissionMode: "default",
    });
  });

  it("projeto e modo escolhidos vão no comando", async () => {
    const i = command("novo", { prompt: "oi", projeto: PROJECTS[1] ?? "", modo: "acceptEdits" });
    await slash.onInteraction(i);
    expect(lastCmd()).toMatchObject({ cwd: PROJECTS[1], permissionMode: "acceptEdits" });
  });

  it("agente antigo (hello sem devRoots): projeto que a máquina não informou é recusado (esse agente não confere a pasta)", async () => {
    const i = command("novo", { prompt: "oi", projeto: "/etc" });
    await slash.onInteraction(i);
    await settle();
    expect(hub.sent).toEqual([]);
    expect(i.replies[0]?.ephemeral).toBe(true);
    expect(i.replies[0]?.view.content).toContain("projeto desconhecido");
  });

  it("ack → ensureThread com bgId e a resposta vira o link da thread", async () => {
    const spy = vi.spyOn(threads, "ensureThread");
    const i = command("novo", { prompt: "roda os testes", modo: "plan" });
    await slash.onInteraction(i);
    await ackOf(i.id, { sessionId: "sess-1", bgId: "b91e04d7" });
    await settle();
    expect(spy).toHaveBeenCalledWith(M, expect.objectContaining({ sessionId: "sess-1", bgId: "b91e04d7", name: "roda-os-testes", cwd: PROJECTS[0] }));
    const threadId = db.sessions.get("sess-1")?.threadId;
    expect(threadId).toBeTruthy();
    expect(db.sessions.get("sess-1")?.bgId).toBe("b91e04d7");
    expect(i.edits).toEqual([{ content: `✅ Sessão criada: <#${threadId}>` }]);
    expect(port.of("createThread")).toEqual([{ op: "createThread", channelId: CH, name: "🟢 roda-os-testes" }]);
  });

  it("ack sem sessionId → erro na resposta", async () => {
    const i = command("novo", { prompt: "oi" });
    await slash.onInteraction(i);
    await ackOf(i.id, {});
    await settle();
    expect(i.edits).toEqual([{ content: "❌ a máquina não devolveu o id da sessão" }]);
  });

  it("command.error → edita com ❌ razão", async () => {
    const i = command("novo", { prompt: "oi" });
    await slash.onInteraction(i);
    await errOf(i.id, "pasta não encontrada: ~/dev/work/gestai");
    await settle();
    expect(i.edits).toEqual([{ content: "❌ pasta não encontrada: ~/dev/work/gestai" }]);
    expect(port.of("createThread")).toEqual([]);
  });

  it("offline → fila e aviso; ao conectar, envia; o ack cria a thread", async () => {
    hub.online.delete(M);
    const i = command("novo", { prompt: "oi" });
    await slash.onInteraction(i);
    await settle();
    expect(hub.sent).toEqual([]);
    expect(db.pendingCommands.listDue(M).map((r) => r.commandId)).toEqual([i.id]);
    expect(i.edits).toEqual([{ content: OFFLINE_TEXT }]);
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    expect(lastCmd()).toMatchObject({ type: "session.create", commandId: i.id });
    await ackOf(i.id, { sessionId: "sess-2", bgId: "bg2" });
    await settle();
    expect(i.edits.at(-1)?.content).toMatch(/^✅ Sessão criada: <#th-\d+>$/);
  });

  it("offline por mais de 1 h → a resposta diz que expirou", async () => {
    hub.online.delete(M);
    const i = command("novo", { prompt: "oi" });
    await slash.onInteraction(i);
    vi.advanceTimersByTime(COMMAND_TTL_MS + 1);
    await bridge.expire();
    await settle();
    expect(i.edits.at(-1)).toEqual({ content: `❌ ${EXPIRED_TEXT}` });
  });

  it("fora de canal de máquina → efêmero use este comando no canal de uma máquina", async () => {
    const i = command("novo", { prompt: "oi" }, { channelId: "outro-canal" });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: NOT_MACHINE_CHANNEL_TEXT }, ephemeral: true }]);
    expect(hub.sent).toEqual([]);
  });

  it("máquina sem projetos → efêmero com a instrução do install", async () => {
    const r2 = createRouter({ db, port, threads, hub: new FakeHub(), log });
    const s2 = createSlashHandler({ db, threads, bridge, router: r2, port, allowedUserIds: [ALLOWED], log });
    const i = command("novo", { prompt: "oi" });
    await s2.onInteraction(i);
    await s2.idle();
    expect(i.replies).toEqual([{ view: { content: NO_PROJECTS_TEXT }, ephemeral: true }]);
    expect(NO_PROJECTS_TEXT).toBe("esta máquina não informou projetos; rode global-agents install --project <pasta>");
    s2.dispose();
    r2.dispose();
  });

  it("falha do Discord ao responder vai para o log e não rejeita", async () => {
    const i = command("novo", { prompt: "oi" }, { reply: () => Promise.reject(new Error("Unknown interaction")) });
    await expect(slash.onInteraction(i)).resolves.toBeUndefined();
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Unknown interaction"));
  });
});

describe("autocomplete de projeto", () => {
  it("sugere os projetos do último hello da máquina do canal, filtrando pelo texto", async () => {
    const all = autocomplete("");
    await slash.onInteraction(all);
    const some = autocomplete("WORK");
    await slash.onInteraction(some);
    await settle();
    expect(all.choices).toEqual([PROJECTS.map((p) => ({ name: p, value: p }))]);
    expect(some.choices).toEqual([[{ name: PROJECTS[0], value: PROJECTS[0] }, { name: PROJECTS[1], value: PROJECTS[1] }]]);
  });

  it("no máximo 25 sugestões", async () => {
    const many = Array.from({ length: 40 }, (_, k) => `~/p/${k}`);
    hub.emit("event", M, ev("agent.hello", { version: "0.1.0", os: "linux", osUser: "l", projects: many }));
    await router.idle();
    const a = autocomplete("");
    await slash.onInteraction(a);
    await settle();
    expect(a.choices[0]).toHaveLength(25);
  });

  it("fora de canal de máquina → nenhuma sugestão", async () => {
    const a = { ...autocomplete(""), channelId: "outro" };
    await slash.onInteraction(a);
    await settle();
    expect(a.choices).toEqual([[]]);
  });
});

describe("/novo com pastas dev", () => {
  const ROOT = "/home/leonardo/dev";
  const helloDev = (projects: string[], devRoots: string[]): AgentEvent =>
    ev("agent.hello", { version: "0.2.0", os: "linux", osUser: "leonardo", claudeAccount: ACCOUNT, projects, devRoots });
  const projectsEv = (devRoots: string[], projects: string[]): AgentEvent => ev("agent.projects", { devRoots, projects });
  const use = async (...events: AgentEvent[]): Promise<void> => {
    for (const e of events) hub.emit("event", M, e);
    await router.idle();
  };

  it("caminho relativo é repassado como foi digitado (quem resolve é o agente)", async () => {
    await use(helloDev([], [ROOT]));
    const i = command("novo", { prompt: "oi", projeto: " work/app-novo " });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: CREATING_TEXT }, ephemeral: true }]);
    expect(lastCmd()).toMatchObject({ type: "session.create", cwd: "work/app-novo" });
    expect(lastCmd()).not.toHaveProperty("create");
  });

  it("caminho absoluto fora das sugestões também é repassado (sem 'projeto desconhecido')", async () => {
    await use(helloDev([], [ROOT]));
    const i = command("novo", { prompt: "oi", projeto: "/etc" });
    await slash.onInteraction(i);
    await settle();
    expect(lastCmd()).toMatchObject({ cwd: "/etc" });
  });

  it("criar:true vira create: true no comando; criar:false não manda o campo", async () => {
    await use(helloDev([], [ROOT]));
    await slash.onInteraction(command("novo", { prompt: "oi", projeto: "app-novo", criar: true }));
    expect(lastCmd()).toMatchObject({ cwd: "app-novo", create: true });
    await slash.onInteraction(command("novo", { prompt: "oi", projeto: "app-novo", criar: false }));
    expect(lastCmd()).not.toHaveProperty("create");
  });

  it("sem projeto: primeiro projeto explícito; sem explícito, a primeira pasta dev", async () => {
    await use(helloDev(["/opt/legado"], [ROOT, "/srv/outra"]));
    await slash.onInteraction(command("novo", { prompt: "oi" }));
    expect(lastCmd()).toMatchObject({ cwd: "/opt/legado" });
    await use(helloDev([], [ROOT, "/srv/outra"]));
    await slash.onInteraction(command("novo", { prompt: "oi" }));
    expect(lastCmd()).toMatchObject({ cwd: ROOT });
  });

  it("sem projeto, sem explícito e sem pasta dev → erro novo com a instrução do --dev-root", async () => {
    await use(helloDev([], []));
    const i = command("novo", { prompt: "oi" });
    await slash.onInteraction(i);
    await settle();
    expect(hub.sent).toEqual([]);
    expect(i.replies).toEqual([{ view: { content: NO_DEV_ROOT_TEXT }, ephemeral: true }]);
    expect(NO_DEV_ROOT_TEXT).toBe("esta máquina não tem pasta dev; rode global-agents install --dev-root <pasta>");
  });

  it("projeto com caractere de controle ou longo demais → recusado no relay", async () => {
    await use(helloDev([], [ROOT]));
    for (const projeto of ["a\nb", "x\u0007", "a".repeat(1025)]) {
      const i = command("novo", { prompt: "oi", projeto });
      await slash.onInteraction(i);
      await settle();
      expect(i.replies[0]?.view.content).toContain("projeto inválido");
    }
    expect(hub.sent).toEqual([]);
  });

  it("agente antigo com criar:true → recusa explicando que precisa atualizar", async () => {
    const i = command("novo", { prompt: "oi", projeto: PROJECTS[0] ?? "", criar: true });
    await slash.onInteraction(i);
    await settle();
    expect(hub.sent).toEqual([]);
    expect(i.replies[0]?.view.content).toContain("atualize o agente");
  });

  it("o ack com cwd resolvido pelo agente vira o cwd da thread", async () => {
    await use(helloDev([], [ROOT]));
    const spy = vi.spyOn(threads, "ensureThread");
    const i = command("novo", { prompt: "oi", projeto: "work/app-novo", criar: true });
    await slash.onInteraction(i);
    await ackOf(i.id, { sessionId: "sess-9", bgId: "b9", cwd: `${ROOT}/work/app-novo` });
    await settle();
    expect(spy).toHaveBeenCalledWith(M, expect.objectContaining({ sessionId: "sess-9", cwd: `${ROOT}/work/app-novo` }));
  });

  it("offline: criar e o caminho relativo sobrevivem à fila e ao reenvio", async () => {
    await use(helloDev([], [ROOT]));
    hub.online.delete(M);
    const i = command("novo", { prompt: "oi", projeto: "app-novo", criar: true });
    await slash.onInteraction(i);
    await settle();
    expect(hub.sent).toEqual([]);
    hub.online.add(M);
    await bridge.onMachineOnline(M);
    expect(lastCmd()).toMatchObject({ type: "session.create", commandId: i.id, cwd: "app-novo", create: true });
  });

  it("menção usa o mesmo padrão (primeira pasta dev) e nunca cria", async () => {
    await use(helloDev([], [ROOT]));
    await slash.onMention({ messageId: "msg-1", channelId: CH, authorId: ALLOWED, isBot: false, text: "roda os testes" });
    expect(lastCmd()).toMatchObject({ cwd: ROOT });
    expect(lastCmd()).not.toHaveProperty("create");
  });

  describe("autocomplete", () => {
    it("explícitos + raízes + descobertos, filtrados e sem repetição; evento agent.projects atualiza as sugestões", async () => {
      await use(helloDev(["/opt/legado"], [ROOT]));
      const before = autocomplete("");
      await slash.onInteraction(before);
      await use(projectsEv([ROOT], [`${ROOT}/gestai`, `${ROOT}/work`, `${ROOT}/work/app`, "/opt/legado"]));
      const after = autocomplete("");
      await slash.onInteraction(after);
      const filtered = autocomplete("WORK");
      await slash.onInteraction(filtered);
      await settle();
      expect(before.choices[0]?.map((c) => c.value)).toEqual(["/opt/legado", ROOT]);
      expect(after.choices[0]?.map((c) => c.value)).toEqual(["/opt/legado", ROOT, `${ROOT}/gestai`, `${ROOT}/work`, `${ROOT}/work/app`]);
      expect(filtered.choices[0]?.map((c) => c.value)).toEqual(["WORK", `${ROOT}/work`, `${ROOT}/work/app`]);
    });

    it("texto que não bate com nada vira a primeira (e única) opção; texto igual a uma sugestão não ecoa", async () => {
      await use(helloDev([], [ROOT]), projectsEv([ROOT], [`${ROOT}/gestai`]));
      const novo = autocomplete("app-novo");
      await slash.onInteraction(novo);
      const igual = autocomplete(`${ROOT}/gestai`);
      await slash.onInteraction(igual);
      const vazio = autocomplete("   ");
      await slash.onInteraction(vazio);
      await settle();
      expect(novo.choices).toEqual([[{ name: "app-novo", value: "app-novo" }]]);
      expect(igual.choices).toEqual([[{ name: `${ROOT}/gestai`, value: `${ROOT}/gestai` }]]);
      expect(vazio.choices[0]?.map((c) => c.value)).toEqual([ROOT, `${ROOT}/gestai`]);
    });

    it("até 25 opções, valores ≤ 100 caracteres (eco longo demais não entra)", async () => {
      const many = Array.from({ length: 40 }, (_, k) => `${ROOT}/p${k}`);
      await use(helloDev([], [ROOT]), projectsEv([ROOT], [...many, `${ROOT}/${"x".repeat(120)}`]));
      const a = autocomplete("p");
      await slash.onInteraction(a);
      const longo = autocomplete("y".repeat(101));
      await slash.onInteraction(longo);
      await settle();
      expect(a.choices[0]).toHaveLength(25);
      expect(a.choices[0]?.[0]).toEqual({ name: "p", value: "p" });
      expect(a.choices[0]?.every((c) => c.value.length <= 100)).toBe(true);
      expect(longo.choices).toEqual([[]]);
    });

    it("agente antigo não ecoa o texto digitado (só aceita os projetos do hello)", async () => {
      const a = autocomplete("app-novo");
      await slash.onInteraction(a);
      await settle();
      expect(a.choices).toEqual([[]]);
    });

    it("hello de agente antigo depois de um novo apaga raízes e descobertos", async () => {
      await use(helloDev([], [ROOT]), projectsEv([ROOT], [`${ROOT}/gestai`]));
      await use(hello());
      expect(router.devRootsOf(M)).toBeUndefined();
      expect(router.discoveredOf(M)).toEqual([]);
    });
  });
});

describe("/sessoes", () => {
  it("embed efêmero com estado, nome, link da thread, pasta, há quanto tempo e attach", async () => {
    const now = Date.now();
    db.sessions.upsert({ sessionId: "s1", machine: M, name: "relatorio-inadimplencia", cwd: "~/dev/work/gestai", threadId: "th-9", bgId: "b91e04d7", state: "working", updatedAt: now - 8 * 60_000 });
    db.sessions.upsert({ sessionId: "s2", machine: M, name: "correcoes-bugs", cwd: "~/dev/work/gestai", state: "waiting", updatedAt: now - 2 * 3_600_000 });
    db.sessions.upsert({ sessionId: "s3", machine: "outra/maq", name: "nao-aparece", state: "done", updatedAt: now });
    const i = command("sessoes");
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toHaveLength(1);
    const r = i.replies[0];
    expect(r?.ephemeral).toBe(true);
    const embed = r?.view.embeds?.[0];
    expect(embed?.title).toBe("2 sessões em fedora/leonardo");
    const d = embed?.description ?? "";
    expect(d).toContain("🟢 **relatorio-inadimplencia** · <#th-9>");
    expect(d).toContain("`~/dev/work/gestai` · há 8 min · `claude attach b91e04d7`");
    expect(d).toContain("🟡 **correcoes-bugs**");
    expect(d).toContain("há 2 h");
    expect(d).not.toContain("nao-aparece");
    expect(embed?.footer).toBe("atualizado às 15:10 · filtro de conta desligado");
  });

  it("no máximo 25 sessões", async () => {
    for (let k = 0; k < 30; k++) db.sessions.upsert({ sessionId: `s${k}`, machine: M, name: `n${k}`, state: "done", updatedAt: k });
    const i = command("sessoes");
    await slash.onInteraction(i);
    await settle();
    const d = i.replies[0]?.view.embeds?.[0]?.description ?? "";
    expect(d.split("\n").filter((l) => l.startsWith("⚪"))).toHaveLength(25);
    expect(i.replies[0]?.view.embeds?.[0]?.title).toBe("25 de 30 sessões em fedora/leonardo");
  });

  it("sem sessões → aviso efêmero", async () => {
    const i = command("sessoes");
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: "nenhuma sessão registrada em fedora/leonardo" }, ephemeral: true }]);
  });

  it("fora de canal de máquina → aviso", async () => {
    const i = command("sessoes", {}, { channelId: "x" });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: NOT_MACHINE_CHANNEL_TEXT }, ephemeral: true }]);
  });
});

describe("/parar", () => {
  beforeEach(() => {
    db.sessions.upsert({ sessionId: "s-bg", machine: M, name: "migracao-boletos-v2", threadId: "th-sessao", bgId: "bg1", state: "working", updatedAt: Date.now() });
  });
  const parar = (): FakeCommand => command("parar", {}, { channelId: "th-sessao" });

  it("fora de thread mapeada → aviso, nada enviado", async () => {
    const i = command("parar");
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: NOT_SESSION_THREAD_TEXT }, ephemeral: true }]);
    expect(hub.sent).toEqual([]);
  });

  it("pede confirmação efêmera com botões; sem confirmar nada é enviado", async () => {
    const i = parar();
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toHaveLength(1);
    expect(i.replies[0]?.ephemeral).toBe(true);
    expect(i.replies[0]?.view.content).toContain("Parar a sessão **migracao-boletos-v2**?");
    expect(i.replies[0]?.view.buttons).toEqual([
      { customId: `parar:confirmar:${i.id}`, label: "Parar sessão", style: "danger" },
      { customId: `parar:cancelar:${i.id}`, label: "Cancelar", style: "secondary" },
    ]);
    expect(hub.sent).toEqual([]);
  });

  it("Cancelar → nada enviado, botões somem", async () => {
    const i = parar();
    await slash.onInteraction(i);
    const b = button(`parar:cancelar:${i.id}`);
    await slash.onInteraction(b);
    await settle();
    expect(b.updates).toEqual([{ content: "cancelado; a sessão continua", buttons: [] }]);
    expect(hub.sent).toEqual([]);
  });

  it("Parar sessão → session.stop; ack edita com quem parou", async () => {
    const i = parar();
    await slash.onInteraction(i);
    const b = button(`parar:confirmar:${i.id}`);
    await slash.onInteraction(b);
    expect(lastCmd()).toMatchObject({ type: "session.stop", sessionId: "s-bg", commandId: i.id });
    await ackOf(i.id);
    await settle();
    expect(b.updates).toEqual([{ content: "⏹ parando a sessão…", buttons: [] }]);
    expect(b.edits).toEqual([{ content: "⏹ Sessão parada por leonardo às 15:10." }]);
  });

  it("erro do agente (sessão interativa) → ❌ razão", async () => {
    const i = parar();
    await slash.onInteraction(i);
    const b = button(`parar:confirmar:${i.id}`);
    await slash.onInteraction(b);
    await errOf(i.id, "só sessões em background podem ser paradas pelo Discord");
    await settle();
    expect(b.edits).toEqual([{ content: "❌ só sessões em background podem ser paradas pelo Discord" }]);
  });

  it("confirmado com a máquina offline → fila e aviso", async () => {
    hub.online.delete(M);
    const i = parar();
    await slash.onInteraction(i);
    const b = button(`parar:confirmar:${i.id}`);
    await slash.onInteraction(b);
    await settle();
    expect(db.pendingCommands.listDue(M).map((r) => r.commandId)).toEqual([i.id]);
    expect(b.edits).toEqual([{ content: OFFLINE_TEXT }]);
  });

  it("depois de 60 s os botões são desligados e o clique não envia nada", async () => {
    const i = parar();
    await slash.onInteraction(i);
    await settle();
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    await settle();
    expect(i.edits).toEqual([{
      content: "tempo esgotado; a sessão continua",
      buttons: [
        { customId: `parar:confirmar:${i.id}`, label: "Parar sessão", style: "danger", disabled: true },
        { customId: `parar:cancelar:${i.id}`, label: "Cancelar", style: "secondary", disabled: true },
      ],
    }]);
    const b = button(`parar:confirmar:${i.id}`);
    await slash.onInteraction(b);
    await settle();
    expect(hub.sent).toEqual([]);
    expect(b.replies).toEqual([{ view: { content: "este pedido expirou; rode /parar de novo" }, ephemeral: true }]);
  });

  it("confirmar duas vezes envia uma só", async () => {
    const i = parar();
    await slash.onInteraction(i);
    await slash.onInteraction(button(`parar:confirmar:${i.id}`));
    await slash.onInteraction(button(`parar:confirmar:${i.id}`));
    expect(hub.sent).toHaveLength(1);
  });

  it("dispose limpa os timers de confirmação", async () => {
    await slash.onInteraction(parar());
    await settle();
    slash.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("/claude", () => {
  beforeEach(() => {
    db.sessions.upsert({ sessionId: "s-bg", machine: M, name: "migracao-boletos-v2", threadId: "th-sessao", bgId: "bg1", state: "working", updatedAt: Date.now() });
  });
  const claude = (opts: Record<string, string>, over: Partial<CommandInteraction> = {}): FakeCommand =>
    command("claude", opts, { channelId: "th-sessao", ...over });
  const posts = (): string[] => port.of("post").filter((p) => p.targetId === "th-sessao").map((p) => p.text);

  it("/claude comando:usage em thread mapeada → efêmero executando /usage… e session.slash", async () => {
    const i = claude({ comando: "usage" });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: "executando /usage…" }, ephemeral: true }]);
    expect(hub.sent.at(-1)?.machine).toBe(M);
    const cmd = lastCmd();
    expect(cmd).toMatchObject({ type: "session.slash", commandId: i.id, sessionId: "s-bg", command: "usage" });
    expect("args" in cmd).toBe(false);
  });

  it("args vão aparados no comando", async () => {
    const i = claude({ comando: "compact", args: "  foco em testes  " });
    await slash.onInteraction(i);
    expect(lastCmd()).toMatchObject({ type: "session.slash", command: "compact", args: "foco em testes" });
  });

  it("ack com tela de 3000 chars → 2 posts na thread em bloco de código, cada um ≤ 2000", async () => {
    const i = claude({ comando: "context" });
    await slash.onInteraction(i);
    const screen = Array.from({ length: 100 }, (_v, n) => `linha ${String(n).padStart(3, "0")} ${"x".repeat(19)}`).join("\n");
    expect(screen.length).toBeGreaterThanOrEqual(2900);
    await ackOf(i.id, { screen });
    await settle();
    const p = posts();
    expect(p).toHaveLength(2);
    expect(p[0]?.startsWith("🛠️ /context\n```\n")).toBe(true);
    for (const m of p) {
      expect(m.length).toBeLessThanOrEqual(2000);
      expect(m).toMatch(/```\n[\s\S]*\n```/);
      expect(m.match(/```/g)).toHaveLength(2);
    }
    expect(p[0]).toContain("linha 000");
    expect(p[1]).toContain("linha 099");
    expect(p[1]).toMatch(/```\n-# \(parte 2\/2\)$/);
  });

  it("ack com tela curta → um post com cabeçalho e bloco de código", async () => {
    const i = claude({ comando: "status" });
    await slash.onInteraction(i);
    await ackOf(i.id, { screen: "Version: 2.1.292" });
    await settle();
    expect(posts()).toEqual(["🛠️ /status\n```\nVersion: 2.1.292\n```"]);
    expect(i.edits).toEqual([{ content: "✅ /status concluído; resultado na thread" }]);
  });

  it("ack sem screen → ❌ no efêmero, nada na thread", async () => {
    const i = claude({ comando: "status" });
    await slash.onInteraction(i);
    await ackOf(i.id, {});
    await settle();
    expect(posts()).toEqual([]);
    expect(i.edits.at(-1)?.content).toMatch(/^❌/);
  });

  it("erro do agente → ❌ razão", async () => {
    const i = claude({ comando: "compact" });
    await slash.onInteraction(i);
    await errOf(i.id, "sessão ocupada; tente quando o turno terminar");
    await settle();
    expect(i.edits).toEqual([{ content: "❌ sessão ocupada; tente quando o turno terminar" }]);
    expect(posts()).toEqual([]);
  });

  it("fora de thread mapeada → efêmero, nada enviado", async () => {
    const i = command("claude", { comando: "usage" });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: NOT_SESSION_THREAD_TEXT }, ephemeral: true }]);
    expect(hub.sent).toEqual([]);
  });

  it("usuário fora da allowlist → sem permissão", async () => {
    const i = claude({ comando: "usage" }, { user: { id: STRANGER, username: "x" } });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: NOT_ALLOWED_TEXT }, ephemeral: true }]);
    expect(hub.sent).toEqual([]);
  });

  it("comando fora da allowlist ou args com quebra de linha/mais de 500 chars → recusado, nada enviado", async () => {
    for (const opts of [
      { comando: "clear" }, { comando: "compact", args: "a\nb" }, { comando: "compact", args: "a".repeat(501) },
      { comando: "compact", args: "a\x1bb" }, { comando: "compact", args: "a\x03b" }, { comando: "compact", args: "a\tb" },
    ]) {
      const i = claude(opts);
      await slash.onInteraction(i);
      await settle();
      expect(i.replies).toHaveLength(1);
      expect(i.replies[0]?.ephemeral).toBe(true);
      expect(i.replies[0]?.view.content).toMatch(/^❌/);
    }
    expect(hub.sent).toEqual([]);
  });

  it("máquina offline → fila e aviso", async () => {
    hub.online.delete(M);
    const i = claude({ comando: "usage" });
    await slash.onInteraction(i);
    await settle();
    expect(db.pendingCommands.listDue(M).map((r) => r.commandId)).toEqual([i.id]);
    expect(i.edits).toEqual([{ content: OFFLINE_TEXT }]);
  });
});

describe("slashResultMessages", () => {
  it("cercas dentro da tela não quebram o bloco de código", () => {
    const [m] = slashResultMessages("hooks", "antes\n```js\ncodigo\n```\ndepois");
    expect(m?.match(/```/g)).toHaveLength(2);
    expect(m).toContain("codigo");
  });
});

describe("/filtro", () => {
  it("conta → grava filter_account, avisa no canal e o tópico ganha · filtro: <conta>", async () => {
    const i = command("filtro", { sub: "conta", email: " trabalho@exemplo.com.br " });
    await slash.onInteraction(i);
    await settle();
    expect(db.machines.getByName(M)?.filterAccount).toBe("trabalho@exemplo.com.br");
    expect(i.replies).toEqual([{
      view: { content: "🔇 Filtro ligado neste canal: só aparecem sessões da conta **trabalho@exemplo.com.br**. Sessões de outras contas ficam em silêncio até `/filtro desligar`." },
      ephemeral: false,
    }]);
    expect(port.of("editChannelTopic").at(-1)?.topic).toBe(
      "fedora/leonardo · Linux · Claude Code 2.1.291 · leonardo@exemplo.com.br · filtro: trabalho@exemplo.com.br",
    );
  });

  it("com o filtro ligado, o router não cria thread nem posta para hello de outra conta; desligar volta ao normal", async () => {
    await slash.onInteraction(command("filtro", { sub: "conta", email: "trabalho@exemplo.com.br" }));
    hub.emit("event", M, hello("pessoal@exemplo.com.br"));
    hub.emit("event", M, ev("session.list", { sessions: [{ sessionId: "s1", name: "a", cwd: "~/x", kind: "interactive" }] }));
    hub.emit("event", M, ev("turn.reply", { sessionId: "s1", text: "oi", stopReason: "end_turn" }));
    hub.emit("event", M, ev("session.status", { sessionId: "s1", name: "a", cwd: "~/x", state: "working" }));
    await settle();
    expect(port.of("createThread")).toEqual([]);
    expect(port.of("post")).toEqual([]);

    // mesma conta do filtro (sem diferenciar maiúsculas) → aparece
    hub.emit("event", M, hello("Trabalho@Exemplo.com.br"));
    hub.emit("event", M, ev("session.list", { sessions: [{ sessionId: "s2", name: "b", cwd: "~/x", kind: "interactive" }] }));
    await settle();
    expect(port.of("createThread")).toHaveLength(1);

    hub.emit("event", M, hello("pessoal@exemplo.com.br"));
    const off = command("filtro", { sub: "desligar" });
    await slash.onInteraction(off);
    hub.emit("event", M, ev("session.list", { sessions: [{ sessionId: "s3", name: "c", cwd: "~/x", kind: "interactive" }] }));
    await settle();
    expect(db.machines.getByName(M)?.filterAccount).toBeNull();
    expect(off.replies).toEqual([{ view: { content: "🔊 Filtro desligado. Todas as sessões da máquina voltam a aparecer, de qualquer conta." }, ephemeral: false }]);
    expect(port.of("createThread")).toHaveLength(2);
  });

  it("ver → estado atual, efêmero", async () => {
    const a = command("filtro", { sub: "ver" });
    await slash.onInteraction(a);
    await slash.onInteraction(command("filtro", { sub: "conta", email: "trabalho@exemplo.com.br" }));
    const b = command("filtro", { sub: "ver" });
    await slash.onInteraction(b);
    await settle();
    expect(a.replies).toEqual([{ view: { content: "🔊 filtro desligado: aparecem sessões de qualquer conta (conta atual da máquina: leonardo@exemplo.com.br)" }, ephemeral: true }]);
    expect(b.replies).toEqual([{ view: { content: "🔇 filtro ligado: só aparecem sessões da conta **trabalho@exemplo.com.br** (conta atual da máquina: leonardo@exemplo.com.br, em silêncio)" }, ephemeral: true }]);
  });

  it("e-mail inválido → aviso efêmero, nada gravado", async () => {
    const i = command("filtro", { sub: "conta", email: "nao-e-email" });
    await slash.onInteraction(i);
    await settle();
    expect(db.machines.getByName(M)?.filterAccount).toBeNull();
    expect(i.replies[0]?.ephemeral).toBe(true);
    expect(i.replies[0]?.view.content).toContain("e-mail");
  });

  it("fora de canal de máquina → aviso", async () => {
    const i = command("filtro", { sub: "ver" }, { channelId: "x" });
    await slash.onInteraction(i);
    await settle();
    expect(i.replies).toEqual([{ view: { content: NOT_MACHINE_CHANNEL_TEXT }, ephemeral: true }]);
  });
});

describe("menção ao bot", () => {
  const mention = (text: string, over: Partial<{ authorId: string; channelId: string; isBot: boolean }> = {}) =>
    ({ messageId: `m-${++seq}`, channelId: CH, authorId: ALLOWED, isBot: false, text, ...over });
  const replies = (): string[] => port.of("reply").map((r) => `${r.channelId} ${r.messageId} ${r.text}`);

  it("no canal da máquina vira /novo com os padrões; o ack responde à mensagem com o link", async () => {
    const m = mention("roda os testes de integração");
    await slash.onMention(m);
    expect(lastCmd()).toMatchObject({
      type: "session.create", commandId: m.messageId, cwd: PROJECTS[0], permissionMode: "default", name: "roda-os-testes-de-integração",
      prompt: "roda os testes de integração",
    });
    await ackOf(m.messageId, { sessionId: "sess-m", bgId: "bgm" });
    await settle();
    const threadId = db.sessions.get("sess-m")?.threadId;
    expect(replies()).toEqual([`${CH} ${m.messageId} ✅ Sessão criada: <#${threadId}>`]);
  });

  it("offline → responde com o aviso da fila", async () => {
    hub.online.delete(M);
    const m = mention("oi");
    await slash.onMention(m);
    await settle();
    expect(replies()).toEqual([`${CH} ${m.messageId} ${OFFLINE_TEXT}`]);
  });

  it("erro → responde ❌ razão", async () => {
    const m = mention("oi");
    await slash.onMention(m);
    await errOf(m.messageId, "falhou");
    await settle();
    expect(replies()).toEqual([`${CH} ${m.messageId} ❌ falhou`]);
  });

  it("fora da allowlist, de bot ou fora de canal de máquina → ignorada", async () => {
    await slash.onMention(mention("oi", { authorId: STRANGER }));
    await slash.onMention(mention("oi", { isBot: true }));
    await slash.onMention(mention("oi", { channelId: "outro" }));
    await settle();
    expect(hub.sent).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("menção sem texto → explica o uso", async () => {
    const m = mention("");
    await slash.onMention(m);
    await settle();
    expect(hub.sent).toEqual([]);
    expect(replies()).toEqual([`${CH} ${m.messageId} escreva o pedido depois da menção, por exemplo: @global-agents roda os testes`]);
  });
});
