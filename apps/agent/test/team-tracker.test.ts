import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventSchema, type AgentEvent } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTeammatePayload } from "../src/hooks/mapper.js";
import { startHookServer, type HookServer } from "../src/hooks/server.js";
import { TeamTracker } from "../src/team/tracker.js";

type Payload = Record<string, unknown>;
type TeamEvent = Extract<AgentEvent, { type: "team.event" }>;
type TeamUpdate = Extract<AgentEvent, { type: "team.update" }>;

const load = (name: string): Payload[] =>
  readFileSync(new URL(`./fixtures/team/${name}`, import.meta.url), "utf8").split("\n").filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Payload);

const BG = load("team-hooks-bg.jsonl");
const TMUX = load("team-hooks-tmux.jsonl");
const BG_LEAD = "72a1377b-4d94-4bf5-921c-e6311d55f837";
const BG_ALPHA = "f3a02894-1c01-454f-9817-a28585ee7299";
const BG_BETA = "a8cd1e80-0b0b-4832-a0f3-ae390bf6bd2b";
const TMUX_LEAD = "f3b5450f-e3d7-4070-9bcd-de9e6d16e98b";
const TMUX_ALPHA = "26fc5fb7-d849-40c8-b233-3f31838836f8";
const TMUX_BETA = "55cb4fc6-c517-4882-becc-6e44b77be82b";
const LEADS = new Set([BG_LEAD, TMUX_LEAD]);
const isKnown = (id: string): boolean => LEADS.has(id);

let teamsDir: string;
let sent: AgentEvent[];
let tracker: TeamTracker;

const make = (): TeamTracker => new TeamTracker({ machine: "fedora/leonardo", emit: (e) => { sent.push(e); }, isKnownSession: isKnown, teamsDir });
const replay = (t: TeamTracker, payloads: Payload[]): void => {
  for (const p of payloads) t.observe(p, isTeammatePayload(p, isKnown));
};
const events = (): TeamEvent[] => sent.filter((e): e is TeamEvent => e.type === "team.event");
const updates = (): TeamUpdate[] => sent.filter((e): e is TeamUpdate => e.type === "team.update");
const brief = (e: TeamEvent): Partial<TeamEvent> => {
  const { kind, teammate, taskId, subject, text } = e;
  return { kind, ...(teammate !== undefined ? { teammate } : {}), ...(taskId !== undefined ? { taskId } : {}),
    ...(subject !== undefined ? { subject } : {}), ...(text !== undefined ? { text } : {}) };
};
const plantConfig = (team: string, leadSessionId: string, names: string[]): void => {
  mkdirSync(join(teamsDir, team), { recursive: true });
  const members = [
    { agentId: `team-lead@${team}`, name: "team-lead", agentType: "team-lead", tmuxPaneId: "leader" },
    ...names.map((name, i) => ({ agentId: `${name}@${team}`, name, agentType: "general-purpose", tmuxPaneId: `%${i + 1}` })),
  ];
  writeFileSync(join(teamsDir, team, "config.json"), JSON.stringify({ name: team, leadSessionId, members }));
};

beforeEach(() => {
  vi.useFakeTimers();
  teamsDir = mkdtempSync(join(tmpdir(), "teams-"));
  sent = [];
  tracker = make();
});
afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
  rmSync(teamsDir, { recursive: true, force: true });
});

describe("TeamTracker — fixture bg (líder --bg, teammates in-process)", () => {
  it("sem config.json: líder pela última atividade; eventos na ordem, reply real de alpha, tarefas concluídas", () => {
    replay(tracker, BG);
    expect(sent.every((e) => AgentEventSchema.safeParse(e).success)).toBe(true);
    expect(sent.every((e) => (e.type === "team.event" || e.type === "team.update") && e.leadSessionId === BG_LEAD)).toBe(true);
    expect(events().map(brief)).toEqual([
      { kind: "task_created", taskId: "1", subject: "contar arquivos em docs" },
      { kind: "task_created", taskId: "2", subject: "listar pastas de apps" },
      { kind: "task_completed", teammate: "alpha", taskId: "1", subject: "contar arquivos em docs" },
      { kind: "teammate_reply", teammate: "alpha", text: "docs tem 10 arquivos." },
      { kind: "teammate_idle", teammate: "alpha" },
      { kind: "task_completed", teammate: "beta", taskId: "2", subject: "listar pastas de apps" },
      { kind: "teammate_reply", teammate: "beta", text: "Apps: agent, relay." },
      { kind: "teammate_idle", teammate: "beta" },
      { kind: "teammate_reply", teammate: "alpha", text: "Encerrando." },
      { kind: "teammate_reply", teammate: "beta", text: "Tarefa concluída com sucesso. Encerrando." },
      { kind: "teammate_ended", teammate: "alpha" },
      { kind: "teammate_ended", teammate: "beta" },
    ]);
    // o SessionEnd do líder descarrega o painel final na hora
    expect(updates().at(-1)).toMatchObject({
      leadSessionId: BG_LEAD, team: "session-6370870f",
      members: [{ name: "alpha", state: "ended" }, { name: "beta", state: "ended" }],
      tasks: [
        { id: "1", subject: "contar arquivos em docs", status: "completed", owner: "alpha" },
        { id: "2", subject: "listar pastas de apps", status: "completed", owner: "beta" },
      ],
    });
  });

  it("com config.json do time: nome e membros desde o início", () => {
    plantConfig("session-6370870f", BG_LEAD, ["alpha", "beta"]);
    replay(tracker, BG.slice(0, 5)); // ... TaskCreated ×2 e SessionStart de alpha
    vi.advanceTimersByTime(2000);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({
      team: "session-6370870f",
      members: [{ name: "alpha", state: "working" }, { name: "beta", state: "working" }],
      tasks: [{ id: "1", status: "pending" }, { id: "2", status: "pending" }],
    });
    expect(updates()[0]?.tasks[0]).not.toHaveProperty("owner");
  });

  it("config.json velho (líder que não é sessão vista nem conhecida) é ignorado", () => {
    plantConfig("session-6370870f", "deadbeef-0000-0000-0000-000000000000", ["zeta"]);
    replay(tracker, BG);
    expect(sent.every((e) => "leadSessionId" in e && e.leadSessionId === BG_LEAD)).toBe(true);
    expect(updates().at(-1)?.members.map((m) => m.name)).toEqual(["alpha", "beta"]);
  });

  it("team.update tem debounce de 2 s: várias mudanças viram uma emissão", () => {
    replay(tracker, BG.slice(0, 9)); // até o Stop de alpha
    expect(updates()).toHaveLength(0);
    vi.advanceTimersByTime(1999);
    expect(updates()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ members: [{ name: "alpha", state: "working" }], tasks: [{ status: "completed", owner: "alpha" }, { status: "pending" }] });
    vi.advanceTimersByTime(10_000);
    expect(updates()).toHaveLength(1);
  });
});

describe("TeamTracker — fixture tmux (líder interativo, --teammate-mode tmux)", () => {
  it("com config.json: alpha/beta, permissão do teammate, reply de beta adiado até saber o nome, alpha por eliminação", () => {
    plantConfig("session-f3b5450f", TMUX_LEAD, ["alpha", "beta"]);
    replay(tracker, TMUX);
    expect(sent.every((e) => AgentEventSchema.safeParse(e).success)).toBe(true);
    expect(events().map(brief)).toEqual([
      { kind: "teammate_permission" },
      { kind: "teammate_reply", teammate: "beta", text: "beta: concluída — agent, relay" },
      { kind: "teammate_idle", teammate: "beta" },
      { kind: "teammate_ended", teammate: "alpha" },
      { kind: "teammate_ended", teammate: "beta" },
    ]);
    expect(updates().at(-1)).toMatchObject({
      leadSessionId: TMUX_LEAD, team: "session-f3b5450f",
      members: [{ name: "alpha", state: "ended" }, { name: "beta", state: "ended" }], tasks: [],
    });
  });

  it("sem config.json: vínculo adiado até o team_name (prefixo session-<8>); só beta é nomeado", () => {
    replay(tracker, TMUX);
    expect(sent.every((e) => "leadSessionId" in e && e.leadSessionId === TMUX_LEAD)).toBe(true);
    // sem config, o permission_prompt chega antes de qualquer prova de time: não vira teammate_permission
    expect(events().map(brief)).toEqual([
      { kind: "teammate_reply", teammate: "beta", text: "beta: concluída — agent, relay" },
      { kind: "teammate_idle", teammate: "beta" },
      { kind: "teammate_ended", teammate: "beta" },
    ]);
    expect(updates().at(-1)).toMatchObject({ team: "session-f3b5450f", members: [{ name: "beta", state: "ended" }] });
  });

  it("prefixo do team_name vence a última atividade quando aponta para outro líder conhecido", () => {
    const other = "aaaaaaaa-1111-2222-3333-444444444444";
    LEADS.add(other);
    try {
      tracker.observe({ session_id: TMUX_LEAD, cwd: "/x", hook_event_name: "SessionStart", source: "startup" }, false);
      tracker.observe({ session_id: other, cwd: "/x", hook_event_name: "UserPromptSubmit", prompt: "oi" }, false);
      tracker.observe({ session_id: TMUX_BETA, cwd: "/x", hook_event_name: "SessionStart", agent_type: "general-purpose" }, true);
      tracker.observe({ session_id: TMUX_BETA, cwd: "/x", hook_event_name: "TeammateIdle", teammate_name: "beta", team_name: "session-f3b5450f" }, true);
      tracker.flush();
      expect(events().at(-1)).toMatchObject({ kind: "teammate_idle", teammate: "beta", leadSessionId: TMUX_LEAD });
      expect(updates().at(-1)).toMatchObject({ leadSessionId: TMUX_LEAD, members: [{ name: "beta", state: "idle" }] });
      vi.advanceTimersByTime(5000);
      expect(sent.filter((e) => "leadSessionId" in e && e.leadSessionId === other)).toEqual([]);
    } finally {
      LEADS.delete(other);
    }
  });
});

describe("TeamTracker — regras", () => {
  const lead = (extra: Payload): Payload => ({ session_id: BG_LEAD, cwd: "/x", ...extra });
  const mate = (extra: Payload): Payload => ({ session_id: BG_ALPHA, cwd: "/x", agent_type: "general-purpose", ...extra });

  it("teammate_reply corta last_assistant_message em 300 caracteres; Stop vazio não gera linha", () => {
    tracker.observe(lead({ hook_event_name: "UserPromptSubmit", prompt: "time" }), false);
    tracker.observe(mate({ hook_event_name: "TeammateIdle", teammate_name: "alpha", team_name: "session-x" }), true);
    tracker.observe(mate({ hook_event_name: "Stop", last_assistant_message: "é".repeat(400) }), true);
    tracker.observe(mate({ hook_event_name: "Stop", last_assistant_message: "" }), true);
    const replies = events().filter((e) => e.kind === "teammate_reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toHaveLength(300);
  });

  it("permission_prompt do líder sem time ativo não vira teammate_permission", () => {
    tracker.observe(lead({ hook_event_name: "UserPromptSubmit", prompt: "oi" }), false);
    tracker.observe(lead({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "x" }), false);
    expect(sent).toEqual([]);
  });

  it("TaskCreated de líder sem teammates não emite nada (lista de tarefas comum)", () => {
    tracker.observe(lead({ hook_event_name: "TaskCreated", task_id: "1", task_subject: "s" }), false);
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  it("TeammateIdle repetido não repete a linha; atividade do teammate o volta para working", () => {
    tracker.observe(lead({ hook_event_name: "UserPromptSubmit", prompt: "time" }), false);
    const idle = mate({ hook_event_name: "TeammateIdle", teammate_name: "alpha", team_name: "session-x" });
    tracker.observe(idle, true);
    tracker.observe(idle, true);
    expect(events().filter((e) => e.kind === "teammate_idle")).toHaveLength(1);
    tracker.observe(mate({ hook_event_name: "PreToolUse", tool_name: "Bash" }), true);
    tracker.flush();
    expect(updates().at(-1)?.members).toEqual([{ name: "alpha", state: "working" }]);
    tracker.observe(idle, true);
    expect(events().filter((e) => e.kind === "teammate_idle")).toHaveLength(2);
  });

  it("dispose cancela o debounce pendente", () => {
    tracker.observe(lead({ hook_event_name: "UserPromptSubmit", prompt: "time" }), false);
    tracker.observe(mate({ hook_event_name: "TeammateIdle", teammate_name: "alpha", team_name: "session-x" }), true);
    tracker.dispose();
    vi.advanceTimersByTime(5000);
    expect(updates()).toHaveLength(0);
  });
});

describe("servidor de hooks + tracker: nada de teammate vira session.*/turn.*", () => {
  let server: HookServer | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it.each([["bg", BG, [BG_ALPHA, BG_BETA]], ["tmux", TMUX, [TMUX_ALPHA, TMUX_BETA]]] as const)(
    "replay %s pelo HTTP", async (_name, payloads, mates) => {
      vi.useRealTimers();
      const out: AgentEvent[] = [];
      const t = new TeamTracker({ machine: "m", emit: (e) => { out.push(e); }, isKnownSession: isKnown, teamsDir });
      server = await startHookServer({
        port: 0, machine: "m", lookupName: () => undefined, isKnownSession: isKnown,
        onEvents: (evs) => { out.push(...evs); },
        onTeamPayload: (p, teammate) => { t.observe(p, teammate); },
      });
      for (const p of payloads) {
        const res = await fetch(`http://127.0.0.1:${server.port}/hook`, { method: "POST", body: JSON.stringify(p) });
        expect(res.status).toBe(204);
      }
      t.dispose();
      const leaked = out.filter((e) => (e.type.startsWith("session.") || e.type.startsWith("turn.")) && "sessionId" in e && mates.includes(e.sessionId as never));
      expect(leaked).toEqual([]);
      expect(out.some((e) => e.type === "team.event")).toBe(true);
      expect(out.some((e) => e.type === "turn.reply")).toBe(true); // o líder continua normal
    });
});

describe("TeamTracker — memória", () => {
  it("teammate sem líder conhecido não gera nada e é esquecido no SessionEnd", () => {
    const t = new TeamTracker({ machine: "m", emit: (e) => { sent.push(e); }, teamsDir });
    t.observe({ session_id: "x1", cwd: "/x", hook_event_name: "SessionStart", agent_type: "general-purpose" }, true);
    t.observe({ session_id: "x1", cwd: "/x", hook_event_name: "Stop", agent_type: "general-purpose", last_assistant_message: "oi" }, true);
    t.observe({ session_id: "x1", cwd: "/x", hook_event_name: "SessionEnd", agent_type: "general-purpose" }, true);
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
    expect((t as unknown as { mates: Map<string, unknown> }).mates.size).toBe(0);
    t.dispose();
  });
});

describe("TeamTracker — vínculo só com evidência de time", () => {
  type Internals = { mates: Map<string, unknown>; deferred: Map<string, { payloads: unknown[] }>; leads: Map<string, unknown>; seenLeads: Set<string> };
  const inner = (t: TeamTracker): Internals => t as unknown as Internals;
  const AGENT = "c0ffee00-1111-2222-3333-444444444444";
  const lead = (extra: Payload): Payload => ({ session_id: BG_LEAD, cwd: "/x", ...extra });
  const agentX = (extra: Payload): Payload => ({ session_id: AGENT, cwd: "/x", agent_type: "revisor", ...extra });

  it("agent_type fora do inventário sem team_name, com outro líder ativo: nada emitido e permission_prompt segue do líder", () => {
    tracker.observe(lead({ hook_event_name: "UserPromptSubmit", prompt: "oi" }), false);
    tracker.observe(lead({ hook_event_name: "TaskCreated", task_id: "1", task_subject: "tarefa comum" }), false);
    tracker.observe(agentX({ hook_event_name: "SessionStart", source: "startup" }), true);
    tracker.observe(agentX({ hook_event_name: "Stop", last_assistant_message: "feito" }), true);
    tracker.observe(lead({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "x" }), false);
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
    expect(inner(tracker).mates.size).toBe(0);
  });

  it("sessão adiada que vira líder (UserPromptSubmit ou inventário) sai de mates e dos pendentes", () => {
    tracker.observe(agentX({ hook_event_name: "SessionStart" }), true);
    expect(inner(tracker).deferred.has(AGENT)).toBe(true);
    tracker.observe(agentX({ hook_event_name: "UserPromptSubmit", prompt: "oi" }), false); // já no inventário
    expect(inner(tracker).deferred.has(AGENT)).toBe(false);
    expect(inner(tracker).mates.has(AGENT)).toBe(false);
  });

  it("sessão adiada que aparece no inventário sai dos pendentes mesmo sem novo hook", () => {
    tracker.observe(agentX({ hook_event_name: "SessionStart" }), true);
    tracker.syncInventory([AGENT]);
    expect(inner(tracker).deferred.has(AGENT)).toBe(false);
  });

  it("teammate já vinculado que passa a ser líder é solto do time", () => {
    tracker.observe(lead({ hook_event_name: "UserPromptSubmit", prompt: "time" }), false);
    tracker.observe(agentX({ hook_event_name: "TeammateIdle", teammate_name: "x", team_name: "session-x" }), true);
    expect(inner(tracker).mates.has(AGENT)).toBe(true);
    tracker.observe({ session_id: AGENT, cwd: "/x", hook_event_name: "TaskCreated", task_id: "9", task_subject: "s" }, false);
    expect(inner(tracker).mates.has(AGENT)).toBe(false);
  });

  it("pendentes: no máximo 20 por sessão e expiram em 10 min", () => {
    tracker.observe(lead({ hook_event_name: "UserPromptSubmit", prompt: "time" }), false);
    tracker.observe(agentX({ hook_event_name: "Stop", last_assistant_message: "velho" }), true);
    for (let i = 0; i < 30; i++) tracker.observe(agentX({ hook_event_name: "PreToolUse" }), true);
    expect(inner(tracker).deferred.get(AGENT)?.payloads).toHaveLength(20);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    tracker.observe(agentX({ hook_event_name: "TeammateIdle", teammate_name: "x", team_name: "session-x" }), true);
    expect(events().map((e) => e.kind)).toEqual(["teammate_idle"]); // o "velho" expirou com os pendentes
  });

  it("painel só com membro: líder ativo sem nenhum membro não emite team.update", () => {
    tracker.observe(lead({ hook_event_name: "UserPromptSubmit", prompt: "time" }), false);
    tracker.observe(agentX({ hook_event_name: "TaskCompleted", task_id: "1", task_subject: "s", team_name: "session-x" }), true);
    vi.advanceTimersByTime(5000);
    tracker.observe(lead({ hook_event_name: "SessionEnd" }), false);
    expect(updates()).toEqual([]);
  });
});

describe("TeamTracker — liberação de estado", () => {
  type Internals = { mates: Map<string, unknown>; deferred: Map<string, unknown>; leads: Map<string, unknown>; seenLeads: Set<string> };
  const inner = (t: TeamTracker): Internals => t as unknown as Internals;

  it("SessionEnd do líder libera leads, seenLeads e mates", () => {
    replay(tracker, BG.slice(0, -1));
    expect(inner(tracker).leads.size).toBeGreaterThan(0);
    replay(tracker, BG.slice(-1));
    const i = inner(tracker);
    expect([i.leads.size, i.seenLeads.size, i.mates.size, i.deferred.size]).toEqual([0, 0, 0, 0]);
  });

  it("líder que some do inventário é esquecido (painel final emitido)", () => {
    replay(tracker, BG.slice(0, 9));
    tracker.syncInventory([BG_LEAD]);
    tracker.syncInventory([]);
    const i = inner(tracker);
    expect([i.leads.size, i.seenLeads.size, i.mates.size]).toEqual([0, 0, 0]);
    expect(updates().at(-1)).toMatchObject({ leadSessionId: BG_LEAD, members: [{ name: "alpha" }] });
  });

  it("sessão vista mas que ainda não entrou no inventário não é esquecida pelo poll", () => {
    replay(tracker, BG.slice(0, 4));
    tracker.syncInventory([]);
    expect(inner(tracker).leads.has(BG_LEAD)).toBe(true);
  });
});
