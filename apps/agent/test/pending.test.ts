import { AgentEventSchema, type AgentEvent, type SessionInfo } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookDecision, PermissionPayload } from "../src/hooks/server.js";
import { PendingPermissions } from "../src/permissions/pending.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");

const payload = (over: Partial<PermissionPayload> = {}): PermissionPayload => ({
  session_id: "s1", cwd: "/home/x/proj", tool_name: "Bash",
  tool_input: { command: "curl -s https://example.com", description: "Baixa a página" }, ...over,
});

let sessions: SessionInfo[];
let events: AgentEvent[];
let pending: PendingPermissions;

const waiting = (): SessionInfo => ({ sessionId: "s1", cwd: "/home/x/proj", name: "n", kind: "background", status: "waiting" });
const withStatus = (status: SessionInfo["status"]): SessionInfo => ({ ...waiting(), ...(status !== undefined ? { status } : {}) });

function make(opts: { ttlMs?: number; terminalPollMs?: number } = {}): PendingPermissions {
  return new PendingPermissions({
    machine: "fedora/leonardo",
    inventory: { find: (id) => sessions.find((s) => s.sessionId === id) },
    emit: (ev) => { events.push(AgentEventSchema.parse(ev)); },
    ...opts,
  });
}

const resolved = () => events.filter((e) => e.type === "permission.resolved");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sessions = [waiting()];
  events = [];
  pending = make();
});
afterEach(() => {
  pending.close();
  vi.useRealTimers();
});

describe("PendingPermissions", () => {
  it("open emite permission.request; decide(allow) responde, emite resolved remote; segundo decide → false", () => {
    const respond = vi.fn<(d: HookDecision | null) => void>();
    const id = pending.open(payload(), respond);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "permission.request", machine: "fedora/leonardo", sessionId: "s1", requestId: id, tool: "Bash",
      description: "Baixa a página", inputPreview: "curl -s https://example.com",
      expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    });
    expect(pending.decide(id, "allow")).toBe(true);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ behavior: "allow" });
    expect(resolved()).toEqual([expect.objectContaining({ requestId: id, by: "remote", behavior: "allow" })]);
    expect(pending.decide(id, "deny")).toBe(false);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
  });

  it("decide de requestId desconhecido → false sem exceção", () => {
    expect(pending.decide("desconhecido", "allow")).toBe(false);
    expect(events).toEqual([]);
  });

  it("sessão sai de waiting para idle → respond(null) e resolved by=terminal", () => {
    const respond = vi.fn<(d: HookDecision | null) => void>();
    const id = pending.open(payload(), respond);
    vi.advanceTimersByTime(2000); // viu waiting: armado
    expect(respond).not.toHaveBeenCalled();
    sessions = [withStatus("idle")];
    vi.advanceTimersByTime(2000);
    expect(respond).toHaveBeenCalledExactlyOnceWith(null);
    expect(resolved()).toEqual([expect.objectContaining({ requestId: id, by: "terminal" })]);
    expect(resolved()[0]).not.toHaveProperty("behavior");
    expect(pending.decide(id, "allow")).toBe(false);
  });

  it("30 min sem decisão → respond(deny) e resolved by=timeout behavior=deny", () => {
    const respond = vi.fn<(d: HookDecision | null) => void>();
    const id = pending.open(payload(), respond);
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ behavior: "deny" });
    expect(resolved()).toEqual([expect.objectContaining({ requestId: id, by: "timeout", behavior: "deny" })]);
    expect(pending.size).toBe(0);
  });

  it("inputPreview de tool_input de 10 kB fica com <= 3500 chars e termina em …", () => {
    pending.open(payload({ tool_name: "Write", tool_input: { file_path: "/a", content: "x".repeat(10_000) } }), vi.fn());
    const ev = events[0];
    if (ev?.type !== "permission.request") throw new Error("esperava permission.request");
    expect(ev.inputPreview.length).toBeLessThanOrEqual(3500);
    expect(ev.inputPreview.endsWith("…")).toBe(true);
    expect(ev.inputPreview.startsWith('{"file_path":"/a","content":"xxx')).toBe(true);
    expect(ev.description).toBe("");
  });

  it("Bash com comando longo também trunca; tool_input não-objeto vira JSON compacto", () => {
    pending.open(payload({ tool_input: { command: "a".repeat(5000) } }), vi.fn());
    pending.open(payload({ tool_name: "X", tool_input: 42 }), vi.fn());
    pending.open(payload({ tool_name: "Y", tool_input: undefined }), vi.fn());
    const previews = events.map((e) => (e.type === "permission.request" ? e.inputPreview : ""));
    expect(previews[0]).toBe(`${"a".repeat(3499)}…`);
    expect(previews[1]).toBe("42");
    expect(previews[2]).toBe("");
  });

  it("sessão ainda fora do inventário logo após open não conta como decidida", () => {
    sessions = [];
    const respond = vi.fn<(d: HookDecision | null) => void>();
    const id = pending.open(payload(), respond);
    vi.advanceTimersByTime(4000); // dois polls sem a sessão: ainda não armado
    expect(respond).not.toHaveBeenCalled();
    sessions = [waiting()];
    vi.advanceTimersByTime(2000); // 6 s: viu waiting, arma
    expect(respond).not.toHaveBeenCalled();
    sessions = [withStatus("busy")];
    vi.advanceTimersByTime(2000);
    expect(respond).toHaveBeenCalledExactlyOnceWith(null);
    expect(resolved()).toEqual([expect.objectContaining({ requestId: id, by: "terminal" })]);
  });

  it("sessão que nunca aparece: arma aos 10 s e resolve no 2º poll ausente", () => {
    sessions = [];
    const respond = vi.fn<(d: HookDecision | null) => void>();
    pending.open(payload(), respond);
    vi.advanceTimersByTime(10_000); // arma; 1ª ausência
    expect(respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000); // 2ª ausência consecutiva
    expect(respond).toHaveBeenCalledExactlyOnceWith(null);
    expect(resolved()).toEqual([expect.objectContaining({ by: "terminal" })]);
  });

  it("sessão some por um poll só e volta em waiting: não resolve", () => {
    const respond = vi.fn<(d: HookDecision | null) => void>();
    pending.open(payload(), respond);
    vi.advanceTimersByTime(2000);
    sessions = [];
    vi.advanceTimersByTime(2000);
    sessions = [waiting()];
    vi.advanceTimersByTime(2000);
    sessions = [];
    vi.advanceTimersByTime(2000);
    expect(respond).not.toHaveBeenCalled();
  });

  it("sessão presente mas ainda busy antes de 10 s não resolve (não armado)", () => {
    sessions = [withStatus("busy")];
    const respond = vi.fn<(d: HookDecision | null) => void>();
    pending.open(payload(), respond);
    vi.advanceTimersByTime(8000);
    expect(respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000); // 10 s: arma e vê busy
    expect(respond).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("cliente HTTP desconecta antes da decisão → descarta sem responder e emite resolved by=terminal", () => {
    const respond = vi.fn<(d: HookDecision | null) => void>();
    const ac = new AbortController();
    const id = pending.open(payload(), respond, ac.signal);
    ac.abort();
    expect(respond).not.toHaveBeenCalled();
    expect(resolved()).toEqual([expect.objectContaining({ requestId: id, by: "terminal" })]);
    expect(pending.decide(id, "allow")).toBe(false);
    vi.advanceTimersByTime(30 * 60_000);
    expect(resolved()).toHaveLength(1);
  });

  it("signal já abortado no open → resolve na hora como terminal", () => {
    const respond = vi.fn<(d: HookDecision | null) => void>();
    pending.open(payload(), respond, AbortSignal.abort());
    expect(respond).not.toHaveBeenCalled();
    expect(resolved()).toEqual([expect.objectContaining({ by: "terminal" })]);
    expect(pending.size).toBe(0);
  });

  it("close() responde null a todas, não emite mais nada e limpa os timers", () => {
    const r1 = vi.fn<(d: HookDecision | null) => void>();
    const r2 = vi.fn<(d: HookDecision | null) => void>();
    const ac = new AbortController();
    const id = pending.open(payload(), r1, ac.signal);
    pending.open(payload({ session_id: "s2" }), r2);
    const before = events.length;
    pending.close();
    expect(r1).toHaveBeenCalledExactlyOnceWith(null);
    expect(r2).toHaveBeenCalledExactlyOnceWith(null);
    ac.abort();
    vi.advanceTimersByTime(60 * 60_000);
    expect(events).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(pending.decide(id, "allow")).toBe(false);
  });

  it("respond que lança não impede a emissão nem quebra decide", () => {
    const id = pending.open(payload(), () => { throw new Error("boom"); });
    expect(pending.decide(id, "deny")).toBe(true);
    expect(resolved()).toEqual([expect.objectContaining({ by: "remote", behavior: "deny" })]);
  });

  it("ttlMs e terminalPollMs configuráveis", () => {
    pending.close();
    pending = make({ ttlMs: 5000, terminalPollMs: 100_000 });
    const respond = vi.fn<(d: HookDecision | null) => void>();
    const id = pending.open(payload(), respond);
    const ev = events[0];
    if (ev?.type !== "permission.request") throw new Error("esperava permission.request");
    expect(ev.expiresAt).toBe(new Date(NOW.getTime() + 5000).toISOString());
    vi.advanceTimersByTime(5000);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ behavior: "deny" });
    expect(resolved()).toEqual([expect.objectContaining({ requestId: id, by: "timeout" })]);
  });
});
