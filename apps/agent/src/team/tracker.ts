import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newEnvelope, type AgentEvent, type TeamEventKind, type TeamMemberState } from "@global-agents/protocol";
import { z } from "zod";

/** Debounce do `team.update` por líder. */
export const TEAM_UPDATE_DEBOUNCE_MS = 2000;
/** Tamanho máximo do texto do `teammate_reply`. */
export const TEAMMATE_REPLY_MAX = 300;
/** Payloads guardados por sessão de teammate ainda sem prova de time. */
export const DEFERRED_MAX = 20;
/** Validade dos payloads guardados. */
export const DEFERRED_TTL_MS = 600_000;

export interface TeamTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TeamTrackerOptions {
  machine: string;
  emit: (ev: AgentEvent) => void;
  /** Sessão presente no inventário (valida o `leadSessionId` de um `config.json`). */
  isKnownSession?: (sessionId: string) => boolean;
  /** Onde ficam os `<team>/config.json` (padrão `~/.claude/teams`). */
  teamsDir?: string;
  debounceMs?: number;
  /** Relógio dos timers (padrão: os globais, com `unref`). */
  timers?: TeamTimers;
  /** Relógio da expiração dos pendentes (padrão `Date.now`). */
  now?: () => number;
}

const ConfigSchema = z.object({
  leadSessionId: z.string(),
  members: z.array(z.object({ name: z.string(), agentType: z.string().optional() }).passthrough()).optional(),
}).passthrough();
interface TeamConfig { team: string; leadSessionId: string; members: string[] }

interface Task { id: string; subject: string; status: "pending" | "completed"; owner?: string; announced: boolean }
interface Lead {
  id: string;
  /** Algum teammate já se ligou a este líder: o painel existe. */
  active: boolean;
  team: string | undefined;
  members: Map<string, TeamMemberState>;
  tasks: Map<string, Task>;
  timer: unknown;
}
interface Teammate { leadId: string | undefined; name: string | undefined; pendingReply: string | undefined }
interface Deferred { since: number; payloads: { event: string; p: Record<string, unknown> }[] }

const defaultTimers: TeamTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => { clearTimeout(h as NodeJS.Timeout); },
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Corta em `max` code units sem deixar meio par substituto no fim. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Acompanha times de agentes a partir dos hooks (de líder e de teammate) e emite `team.update`/`team.event` na
 * conta do líder. Teammates não têm thread: nada daqui vira `session.*`/`turn.*`.
 *
 * - Teammate → líder: `config.json` do time (`<teamsDir>/<team>/config.json`, só se o `leadSessionId` for uma
 *   sessão já vista como líder ou conhecida do inventário: diretórios velhos ficam no disco); senão o prefixo
 *   `session-<8 primeiros do id do líder>` do `team_name` entre os líderes vistos; senão o líder que por último
 *   emitiu `TaskCreated`/`UserPromptSubmit` — mas só com prova de time: `team_name`/`teammate_name` no payload ou
 *   um `config.json` com teammates para esse líder. Sem prova (ex.: `claude --agent` antes do poll do inventário),
 *   os payloads da sessão ficam guardados (até 20, por 10 min) e são reaplicados quando a prova chegar.
 * - Sessão que se mostra líder (hook sem marca de teammate) sai de `mates` e dos pendentes.
 * - Nome do teammate: `teammate_name` (TeammateIdle/TaskCompleted) ou, com o `config.json`, por eliminação (um só
 *   membro sem sessão e uma só sessão sem nome). A fala de um `Stop` sem nome espera o nome chegar.
 * - O painel (`team.update`) só existe quando o líder tem teammate e pelo menos um membro; tarefas criadas antes
 *   disso são anunciadas na ativação. Emissão com debounce de 2 s; `SessionEnd` do líder (ou o líder sumir do
 *   inventário, `syncInventory`) descarrega na hora e esquece o time.
 */
export class TeamTracker {
  private readonly machine: string;
  private readonly emitFn: (ev: AgentEvent) => void;
  private readonly isKnownSession: (sessionId: string) => boolean;
  private readonly teamsDir: string;
  private readonly debounceMs: number;
  private readonly timers: TeamTimers;
  private readonly leads = new Map<string, Lead>();
  private readonly mates = new Map<string, Teammate>();
  private readonly deferred = new Map<string, Deferred>();
  /** Sessões do último `syncInventory` (só quem já esteve no inventário pode ser esquecido por sumir dele). */
  private inventoried = new Set<string>();
  private readonly now: () => number;
  /** Sessões vistas como líder (hooks sem marca de teammate), candidatas ao prefixo do `team_name`. */
  private readonly seenLeads = new Set<string>();
  private lastActiveLead: string | undefined;
  private disposed = false;

  constructor(opts: TeamTrackerOptions) {
    this.machine = opts.machine;
    this.emitFn = opts.emit;
    this.isKnownSession = opts.isKnownSession ?? (() => false);
    this.teamsDir = opts.teamsDir ?? join(homedir(), ".claude", "teams");
    this.debounceMs = opts.debounceMs ?? TEAM_UPDATE_DEBOUNCE_MS;
    this.timers = opts.timers ?? defaultTimers;
    this.now = opts.now ?? Date.now;
  }

  /** Um payload de hook; `teammate` vem de `isTeammatePayload`. Nunca lança. */
  observe(payload: unknown, teammate: boolean): void {
    if (this.disposed || typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    const sid = str(p["session_id"]);
    const event = str(p["hook_event_name"]);
    if (sid === undefined || event === undefined) return;
    try {
      this.expireDeferred();
      if (teammate && !this.seenLeads.has(sid)) this.onTeammate(sid, event, p);
      else this.onLead(sid, event, p);
    } catch {
      // config.json corrompido, consumidor com erro: o hook nunca falha por causa do painel
    }
  }

  /** Emite agora os `team.update` pendentes. */
  flush(): void {
    for (const lead of this.leads.values()) if (lead.timer !== undefined) this.emitUpdate(lead);
  }

  /**
   * Sessões vivas no inventário (a cada `changed`). Líder que estava no inventário e sumiu é esquecido como no
   * `SessionEnd`; quem nunca apareceu nele (lag do poll) é mantido.
   */
  syncInventory(sessionIds: readonly string[]): void {
    if (this.disposed) return;
    const now = new Set(sessionIds);
    try {
      for (const id of this.inventoried) if (!now.has(id)) this.forgetLead(id);
      for (const id of now) this.notTeammate(id); // está no inventário: é sessão, não teammate
    } catch {
      // consumidor com erro: o poll do inventário segue
    }
    this.inventoried = now;
  }

  dispose(): void {
    this.disposed = true;
    for (const lead of this.leads.values()) this.cancel(lead);
  }

  // ---------------------------------------------------------------- líder

  private onLead(sid: string, event: string, p: Record<string, unknown>): void {
    this.seenLeads.add(sid);
    this.notTeammate(sid);
    switch (event) {
      case "UserPromptSubmit":
        this.lastActiveLead = sid;
        return;
      case "TaskCreated": {
        this.lastActiveLead = sid;
        const id = str(p["task_id"]);
        if (id === undefined) return;
        const lead = this.lead(sid);
        const task: Task = { id, subject: str(p["task_subject"]) ?? "", status: "pending", announced: false };
        lead.tasks.set(id, task);
        if (lead.active) {
          this.announce(lead, task);
          this.schedule(lead);
        }
        return;
      }
      case "Notification": {
        if (p["notification_type"] !== "permission_prompt") return;
        const lead = this.leads.get(sid);
        if (lead?.active === true && this.hasLiveTeammate(lead)) this.event(lead, "teammate_permission", {});
        return;
      }
      case "SessionEnd":
        this.forgetLead(sid);
        return;
      default:
        return;
    }
  }

  /** A sessão se mostrou líder/sessão comum: sai dos pendentes e de `mates` (soltando o time em que estava). */
  private notTeammate(sid: string): void {
    this.deferred.delete(sid);
    const asMate = this.mates.get(sid);
    if (asMate === undefined) return;
    this.mates.delete(sid);
    if (asMate.leadId !== undefined) this.release(asMate.leadId, sid);
  }

  /** Esquece o líder e tudo ligado a ele, descarregando o painel final se havia time. */
  private forgetLead(sid: string): void {
    const lead = this.leads.get(sid);
    if (lead !== undefined) {
      if (lead.active) this.emitUpdate(lead);
      this.cancel(lead);
      this.leads.delete(sid);
    }
    this.seenLeads.delete(sid);
    this.inventoried.delete(sid);
    for (const [mateId, m] of this.mates) if (m.leadId === sid) this.mates.delete(mateId);
    if (this.lastActiveLead === sid) this.lastActiveLead = undefined;
  }

  // ---------------------------------------------------------------- teammate

  private onTeammate(sid: string, event: string, p: Record<string, unknown>): void {
    let mate = this.mates.get(sid);
    if (mate === undefined) {
      const lead = this.resolve(undefined, p);
      if (lead === undefined) {
        this.defer(sid, event, p);
        return;
      }
      mate = { leadId: undefined, name: undefined, pendingReply: undefined };
      this.mates.set(sid, mate);
      this.attach(sid, mate, p, lead);
      const named = str(p["teammate_name"]);
      const bound = mate.leadId === undefined ? undefined : this.leads.get(mate.leadId);
      if (named !== undefined && bound !== undefined) this.bind(bound, mate, named);
      const held = this.deferred.get(sid);
      this.deferred.delete(sid);
      for (const d of held?.payloads ?? []) this.apply(sid, mate, d.event, d.p);
    } else {
      this.attach(sid, mate, p);
    }
    this.apply(sid, mate, event, p);
  }

  /** Guarda o payload de uma sessão de teammate ainda sem prova de time (SessionEnd: só esquece). */
  private defer(sid: string, event: string, p: Record<string, unknown>): void {
    if (event === "SessionEnd") {
      this.deferred.delete(sid);
      return;
    }
    let d = this.deferred.get(sid);
    if (d === undefined) {
      d = { since: this.now(), payloads: [] };
      this.deferred.set(sid, d);
    }
    if (d.payloads.length < DEFERRED_MAX) d.payloads.push({ event, p });
  }

  private expireDeferred(): void {
    const limit = this.now() - DEFERRED_TTL_MS;
    for (const [sid, d] of this.deferred) if (d.since < limit) this.deferred.delete(sid);
  }

  private apply(sid: string, mate: Teammate, event: string, p: Record<string, unknown>): void {
    const lead = mate.leadId === undefined ? undefined : this.leads.get(mate.leadId);
    if (lead === undefined) {
      if (event === "SessionEnd") this.mates.delete(sid);
      return;
    }

    const named = str(p["teammate_name"]);
    if (named !== undefined) this.bind(lead, mate, named);

    switch (event) {
      case "TaskCompleted": {
        const id = str(p["task_id"]);
        if (id === undefined) break;
        const subject = str(p["task_subject"]) ?? lead.tasks.get(id)?.subject ?? "";
        const task: Task = { id, subject, status: "completed", announced: true, ...(mate.name !== undefined ? { owner: mate.name } : {}) };
        lead.tasks.set(id, task);
        this.event(lead, "task_completed", { teammate: mate.name, taskId: id, subject });
        break;
      }
      case "TeammateIdle":
        if (mate.name !== undefined && lead.members.get(mate.name) !== "idle") {
          lead.members.set(mate.name, "idle");
          this.event(lead, "teammate_idle", { teammate: mate.name });
        }
        break;
      case "Stop": {
        const text = str(p["last_assistant_message"]);
        if (text === undefined) break;
        if (mate.name === undefined) this.bindByElimination(lead, sid, mate);
        if (mate.name !== undefined) this.event(lead, "teammate_reply", { teammate: mate.name, text: cut(text, TEAMMATE_REPLY_MAX) });
        else mate.pendingReply = cut(text, TEAMMATE_REPLY_MAX);
        break;
      }
      case "SessionEnd":
        if (mate.name === undefined) this.bindByElimination(lead, sid, mate);
        if (mate.name !== undefined) {
          lead.members.set(mate.name, "ended");
          this.event(lead, "teammate_ended", { teammate: mate.name });
        }
        this.mates.delete(sid);
        break;
      default:
        // qualquer outra atividade (ferramentas, prompt) tira o teammate do ocioso
        if (mate.name !== undefined && lead.members.get(mate.name) === "idle") lead.members.set(mate.name, "working");
        break;
    }
    this.schedule(lead);
  }

  /**
   * Líder do teammate pelo payload: `config.json` do `team_name`, prefixo, o líder atual do teammate (`current`) ou,
   * com prova de time (`team_name`/`teammate_name`, ou `config.json` do líder com teammates), o último líder ativo.
   */
  private resolve(current: string | undefined, p: Record<string, unknown>): { leadId: string; config: TeamConfig | undefined } | undefined {
    const team = str(p["team_name"]);
    const config = team === undefined ? undefined : this.readConfig(team);
    const leadId = config?.leadSessionId ?? (team === undefined ? undefined : this.leadByPrefix(team)) ?? current;
    if (leadId !== undefined) return { leadId, config };
    const last = this.lastActiveLead;
    if (last === undefined) return undefined;
    if (team !== undefined || str(p["teammate_name"]) !== undefined) return { leadId: last, config };
    const found = this.configOfLead(last);
    return found !== undefined && found.members.length > 0 ? { leadId: last, config: found } : undefined;
  }

  /** Liga (ou religa, quando o `team_name` aponta para outro líder) o teammate a um líder e ativa o painel. */
  private attach(sid: string, mate: Teammate, p: Record<string, unknown>, known?: { leadId: string; config: TeamConfig | undefined }): void {
    const team = str(p["team_name"]);
    const resolved = known ?? this.resolve(mate.leadId, p);
    if (resolved === undefined) return;
    const { leadId, config } = resolved;

    const previous = mate.leadId;
    if (previous !== leadId) {
      mate.leadId = leadId;
      if (previous !== undefined) this.release(previous, sid);
    }
    const lead = this.lead(leadId);
    if (team !== undefined) lead.team = team;
    if (!lead.active) this.activate(lead, config);
    else if (config !== undefined) this.addMembers(lead, config.members);
    if (mate.name !== undefined && !lead.members.has(mate.name)) lead.members.set(mate.name, "working");
  }

  private activate(lead: Lead, config: TeamConfig | undefined): void {
    lead.active = true;
    const cfg = config ?? this.configOfLead(lead.id);
    if (cfg !== undefined) {
      lead.team ??= cfg.team;
      this.addMembers(lead, cfg.members);
    }
    for (const task of lead.tasks.values()) if (!task.announced) this.announce(lead, task);
    this.schedule(lead);
  }

  /** O teammate saiu do líder `leadId`: se ele ficou sem ninguém, o painel some sem ter sido emitido. */
  private release(leadId: string, sid: string): void {
    const lead = this.leads.get(leadId);
    if (lead === undefined) return;
    const others = [...this.mates.entries()].some(([id, m]) => id !== sid && m.leadId === leadId);
    if (others || lead.members.size > 0) return;
    this.cancel(lead);
    lead.active = false;
  }

  private bind(lead: Lead, mate: Teammate, name: string): void {
    if (mate.name === name) return;
    mate.name = name;
    if (!lead.members.has(name) || lead.members.get(name) === "ended") lead.members.set(name, "working");
    const pending = mate.pendingReply;
    mate.pendingReply = undefined;
    if (pending !== undefined) this.event(lead, "teammate_reply", { teammate: name, text: pending });
  }

  /** Um só membro do líder sem sessão e uma só sessão do líder sem nome: são o mesmo. */
  private bindByElimination(lead: Lead, sid: string, mate: Teammate): void {
    const bound = new Set<string>();
    const unnamed: string[] = [];
    for (const [id, m] of this.mates) {
      if (m.leadId !== lead.id) continue;
      if (m.name === undefined) unnamed.push(id);
      else bound.add(m.name);
    }
    const free = [...lead.members.entries()].filter(([name, state]) => !bound.has(name) && state !== "ended").map(([name]) => name);
    const [only] = free;
    if (free.length === 1 && only !== undefined && unnamed.length === 1 && unnamed[0] === sid) this.bind(lead, mate, only);
  }

  // ---------------------------------------------------------------- resolução

  private isLeadCandidate(id: string): boolean {
    return this.seenLeads.has(id) || this.isKnownSession(id);
  }

  private leadByPrefix(team: string): string | undefined {
    const m = /^session-([0-9a-f]{8})$/.exec(team);
    if (m === null) return undefined;
    const prefix = m[1] ?? "";
    for (const id of this.seenLeads) if (id.startsWith(prefix)) return id;
    return undefined;
  }

  private parseConfig(team: string, raw: string): TeamConfig | undefined {
    const r = ConfigSchema.safeParse(JSON.parse(raw));
    if (!r.success || !this.isLeadCandidate(r.data.leadSessionId)) return undefined;
    const members = (r.data.members ?? []).filter((m) => m.agentType !== "team-lead" && m.name !== "team-lead").map((m) => m.name);
    return { team, leadSessionId: r.data.leadSessionId, members };
  }

  /** `config.json` do time, se existir e apontar para um líder plausível. */
  private readConfig(team: string): TeamConfig | undefined {
    if (team.includes("/") || team.includes("\\") || team === ".." || team === ".") return undefined;
    try {
      return this.parseConfig(team, readFileSync(join(this.teamsDir, team, "config.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  /** Procura o `config.json` cujo `leadSessionId` é o líder (o `team_name` ainda não chegou). */
  private configOfLead(leadId: string): TeamConfig | undefined {
    let dirs: string[];
    try {
      dirs = readdirSync(this.teamsDir);
    } catch {
      return undefined;
    }
    const preferred = `session-${leadId.slice(0, 8)}`;
    dirs.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
    for (const d of dirs) {
      const cfg = this.readConfig(d);
      if (cfg?.leadSessionId === leadId) return cfg;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- emissão

  private lead(id: string): Lead {
    let lead = this.leads.get(id);
    if (lead === undefined) {
      lead = { id, active: false, team: undefined, members: new Map(), tasks: new Map(), timer: undefined };
      this.leads.set(id, lead);
    }
    return lead;
  }

  private addMembers(lead: Lead, names: string[]): void {
    for (const n of names) if (!lead.members.has(n)) lead.members.set(n, "working");
  }

  private hasLiveTeammate(lead: Lead): boolean {
    for (const m of this.mates.values()) if (m.leadId === lead.id) return true;
    for (const s of lead.members.values()) if (s !== "ended") return true;
    return false;
  }

  private announce(lead: Lead, task: Task): void {
    task.announced = true;
    this.event(lead, "task_created", { taskId: task.id, subject: task.subject });
  }

  private event(lead: Lead, kind: TeamEventKind, f: { teammate?: string | undefined; taskId?: string; subject?: string; text?: string }): void {
    this.emitFn({
      ...newEnvelope(this.machine),
      type: "team.event",
      leadSessionId: lead.id,
      kind,
      ...(f.teammate !== undefined ? { teammate: f.teammate } : {}),
      ...(f.taskId !== undefined ? { taskId: f.taskId } : {}),
      ...(f.subject !== undefined ? { subject: f.subject } : {}),
      ...(f.text !== undefined ? { text: f.text } : {}),
    });
  }

  private schedule(lead: Lead): void {
    if (!lead.active || lead.members.size === 0 || lead.timer !== undefined || this.disposed) return;
    lead.timer = this.timers.setTimeout(() => {
      lead.timer = undefined;
      this.emitUpdate(lead);
    }, this.debounceMs);
  }

  private cancel(lead: Lead): void {
    if (lead.timer !== undefined) this.timers.clearTimeout(lead.timer);
    lead.timer = undefined;
  }

  private emitUpdate(lead: Lead): void {
    this.cancel(lead);
    if (this.disposed || lead.members.size === 0) return;
    this.emitFn({
      ...newEnvelope(this.machine),
      type: "team.update",
      leadSessionId: lead.id,
      team: lead.team ?? `session-${lead.id.slice(0, 8)}`,
      members: [...lead.members.entries()].map(([name, state]) => ({ name, state })),
      tasks: [...lead.tasks.values()].map((t) => ({ id: t.id, subject: t.subject, status: t.status, ...(t.owner !== undefined ? { owner: t.owner } : {}) })),
    });
  }
}
