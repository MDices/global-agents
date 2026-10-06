import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEnvelope, type AgentEvent } from "@global-agents/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Outbox } from "../src/transport/outbox.js";

const MACHINE = "fedora/leonardo";

function status(n: number): AgentEvent {
  return { ...newEnvelope(MACHINE), type: "session.status", sessionId: `s${n}`, name: `sessão ${n}`, cwd: "/home/leonardo/dev/correcoes", state: "working" };
}
function reply(text: string): AgentEvent {
  return { ...newEnvelope(MACHINE), type: "turn.reply", sessionId: "s1", text };
}
function list(n: number): AgentEvent {
  return { ...newEnvelope(MACHINE), type: "session.list", sessions: [{ sessionId: `s${n}`, name: `n${n}`, cwd: "/tmp", kind: "interactive" }] };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "outbox-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function collector(): { got: AgentEvent[]; send: (ev: AgentEvent) => Promise<void> } {
  const got: AgentEvent[] = [];
  return { got, send: (ev) => { got.push(ev); return Promise.resolve(); } };
}

describe("Outbox", () => {
  it("append de 3 eventos e drain envia em ordem e esvazia o arquivo", async () => {
    const box = new Outbox(dir);
    const evs = [status(1), reply("oi"), status(2)];
    for (const e of evs) box.append(e);
    expect(box.size()).toBeGreaterThan(0);
    const { got, send } = collector();
    expect(await box.drain(send)).toEqual({ sent: 3, skipped: 0 });
    expect(got.map((e) => e.id)).toEqual(evs.map((e) => e.id));
    expect(box.size()).toBe(0);
  });

  it("linha corrompida no meio é pulada e contada, sem lançar", async () => {
    const skips: string[] = [];
    const box = new Outbox(dir, { onSkip: (line) => skips.push(line) });
    const a = status(1); const b = status(2);
    box.append(a);
    appendFileSync(join(dir, "outbox.jsonl"), '{"v":1,"id":\n');
    box.append(b);
    const { got, send } = collector();
    expect(await box.drain(send)).toEqual({ sent: 2, skipped: 1 });
    expect(got.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(skips).toEqual(['{"v":1,"id":']);
    expect(box.size()).toBe(0);
  });

  it("session.list consecutivos colapsam no último; separado por outro tipo é mantido", async () => {
    const box = new Outbox(dir);
    const lists = [list(1), list(2), list(3), list(4)];
    const r = reply("fim");
    for (const e of lists) box.append(e);
    box.append(r);
    const { got, send } = collector();
    expect(await box.drain(send)).toEqual({ sent: 2, skipped: 0 });
    expect(got.map((e) => e.id)).toEqual([lists[3]?.id, r.id]);

    const l1 = list(5); const mid = status(1); const l2 = list(6);
    for (const e of [l1, mid, l2]) box.append(e);
    const c2 = collector();
    expect(await box.drain(c2.send)).toEqual({ sent: 3, skipped: 0 });
    expect(c2.got.map((e) => e.id)).toEqual([l1.id, mid.id, l2.id]);
  });

  it("send rejeita no 2.º evento: para, mantém os 2 restantes e um novo drain os entrega", async () => {
    const box = new Outbox(dir);
    const evs = [status(1), status(2), reply("três")];
    for (const e of evs) box.append(e);
    const first: AgentEvent[] = [];
    const res = await box.drain((ev) => {
      if (ev.id === evs[1]?.id) return Promise.reject(new Error("socket caiu"));
      first.push(ev); return Promise.resolve();
    });
    expect(res).toEqual({ sent: 1, skipped: 0 });
    expect(first.map((e) => e.id)).toEqual([evs[0]?.id]);
    const lines = readFileSync(join(dir, "outbox.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    const { got, send } = collector();
    expect(await box.drain(send)).toEqual({ sent: 2, skipped: 0 });
    expect(got.map((e) => e.id)).toEqual([evs[1]?.id, evs[2]?.id]);
  });

  it("maxBytes 600: 20 session.status e 1 turn.reply — o turn.reply sobrevive", async () => {
    const box = new Outbox(dir, { maxBytes: 600 });
    const r = reply("resposta importante");
    for (let i = 0; i < 20; i++) {
      box.append(status(i));
      if (i === 2) box.append(r);
      expect(box.size()).toBeLessThanOrEqual(600);
    }
    const { got, send } = collector();
    await box.drain(send);
    expect(got.map((e) => e.id)).toContain(r.id);
    expect(got.at(-1)?.type).toBe("session.status");
    expect(got.length).toBeLessThan(21);
  });

  it("append durante um drain em andamento não se perde", async () => {
    const box = new Outbox(dir);
    const a = status(1); const late = reply("chegou durante o drain");
    box.append(a);
    const first: AgentEvent[] = [];
    await box.drain(async (ev) => { first.push(ev); box.append(late); await Promise.resolve(); });
    expect(first.map((e) => e.id)).toEqual([a.id]);
    const { got, send } = collector();
    expect(await box.drain(send)).toEqual({ sent: 1, skipped: 0 });
    expect(got.map((e) => e.id)).toEqual([late.id]);
  });

  it("drain sem arquivo devolve zeros", async () => {
    const box = new Outbox(join(dir, "novo"));
    const { send } = collector();
    expect(await box.drain(send)).toEqual({ sent: 0, skipped: 0 });
    expect(box.size()).toBe(0);
  });
});
