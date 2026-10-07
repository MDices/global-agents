import { AgentEventSchema, type AgentEvent } from "@global-agents/protocol";
import { describe, expect, it } from "vitest";
import { mapHookPayload } from "../src/hooks/mapper.js";

const ctx = { machine: "fedora/leonardo", lookupName: (id: string) => (id === "s1" ? "correcoes-bugs" : undefined) };
const base = { session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: "/home/leonardo/dev/correcoes", permission_mode: "default" };

function map(payload: unknown): AgentEvent[] {
  const evs = mapHookPayload(payload, ctx);
  for (const e of evs) expect(AgentEventSchema.safeParse(e).success).toBe(true);
  return evs;
}

describe("mapHookPayload", () => {
  it("UserPromptSubmit → session.status(working) + turn.prompt(terminal)", () => {
    const evs = map({ ...base, hook_event_name: "UserPromptSubmit", prompt: "roda os testes" });
    expect(evs.map((e) => e.type)).toEqual(["session.status", "turn.prompt"]);
    expect(evs[0]).toMatchObject({ state: "working", name: "correcoes-bugs", machine: "fedora/leonardo" });
    expect(evs[1]).toMatchObject({ text: "roda os testes", source: "terminal", sessionId: "s1" });
  });

  it("prompt começando com <cross-session-message → source remote", () => {
    const evs = map({ ...base, hook_event_name: "UserPromptSubmit", prompt: '<cross-session-message from="x">oi</cross-session-message>' });
    expect(evs[1]).toMatchObject({ type: "turn.prompt", source: "remote" });
  });

  it("Stop sem last_assistant_message → turn.reply vazio + session.status(done)", () => {
    const evs = map({ ...base, hook_event_name: "Stop", stop_reason: "end_turn" });
    expect(evs[0]).toMatchObject({ type: "turn.reply", text: "", stopReason: "end_turn" });
    expect(evs[1]).toMatchObject({ type: "session.status", state: "done" });
  });

  it("Stop com last_assistant_message usa o texto", () => {
    const evs = map({ ...base, hook_event_name: "Stop", last_assistant_message: "pronto" });
    expect(evs[0]).toMatchObject({ type: "turn.reply", text: "pronto" });
    expect(evs[0]).not.toHaveProperty("stopReason");
  });

  it("Notification → session.status(waiting) com snippet", () => {
    const evs = map({ ...base, hook_event_name: "Notification", message: "Claude needs your permission" });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "session.status", state: "waiting", snippet: "Claude needs your permission" });
  });

  it("SessionEnd → session.status(done)", () => {
    const evs = map({ ...base, hook_event_name: "SessionEnd", reason: "exit" });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "session.status", state: "done" });
  });

  it("payload sem session_id → []", () => {
    const semId: Record<string, unknown> = { ...base, hook_event_name: "UserPromptSubmit", prompt: "x" };
    delete semId["session_id"];
    expect(map(semId)).toEqual([]);
  });

  it("PermissionRequest e eventos desconhecidos → []", () => {
    expect(map({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } })).toEqual([]);
    expect(map({ ...base, hook_event_name: "PreToolUse" })).toEqual([]);
    expect(map(null)).toEqual([]);
    expect(map("lixo")).toEqual([]);
  });

  it("sem nome no lookup → basename(cwd)", () => {
    const evs = map({ ...base, session_id: "zz", cwd: "/home/x/proj", hook_event_name: "SessionEnd" });
    expect(evs[0]).toMatchObject({ name: "proj" });
  });

  it("cwd Windows → basename win32", () => {
    const evs = map({ ...base, session_id: "zz", cwd: "C:\\Users\\leo\\proj-win", hook_event_name: "SessionEnd" });
    expect(evs[0]).toMatchObject({ name: "proj-win" });
  });
});
