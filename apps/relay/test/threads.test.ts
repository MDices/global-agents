import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { ThreadRegistry, threadName } from "../src/discord/threads.js";
import { FakeDiscordPort } from "./helpers/fake-discord.js";

const M = "fedora/leonardo";
const S = { sessionId: "s1", name: "correcoes-bugs", cwd: "~/dev/work/gestai" };

let db: Db;
let port: FakeDiscordPort;
let reg: ThreadRegistry;
let log: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T14:00:00Z"));
  db = openDb(":memory:");
  db.machines.upsert({ name: M, tokenHash: "h" });
  db.machines.touch(M, Date.now(), { os: "linux", claudeVersion: "2.1.291", claudeAccount: "leonardo@exemplo.com.br" });
  db.machines.setChannel(M, "ch-1");
  port = new FakeDiscordPort();
  log = vi.fn();
  reg = new ThreadRegistry({ db, port, channelFor: async () => "ch-1", log });
});
afterEach(() => {
  reg.dispose();
  db.close();
  vi.useRealTimers();
});

describe("threadName", () => {
  it("usa o emoji do estado e trunca a 100 caracteres", () => {
    expect(threadName("x", "working")).toBe("🟢 x");
    expect(threadName("x", "waiting")).toBe("🟡 x");
    expect(threadName("x", "done")).toBe("⚪ x");
    expect(threadName("x", "error")).toBe("🔴 x");
    const long = threadName("a".repeat(300), "done");
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.startsWith("⚪ aaa")).toBe(true);
  });

  it("não parte par substituto ao truncar", () => {
    const name = threadName("a".repeat(96) + "😀😀", "done");
    expect(name.length).toBeLessThanOrEqual(100);
    expect(/[\uD800-\uDBFF]$/.test(name)).toBe(false);
  });
});

describe("ThreadRegistry.ensureThread", () => {
  it("cria a thread com ⚪ por padrão, grava o thread_id e posta o embed inicial", async () => {
    const id = await reg.ensureThread(M, S);
    expect(port.of("createThread")).toEqual([{ op: "createThread", channelId: "ch-1", name: "⚪ correcoes-bugs" }]);
    expect(db.sessions.get("s1")?.threadId).toBe(id);
    const embeds = port.of("postEmbed");
    expect(embeds).toHaveLength(1);
    expect(embeds[0]?.targetId).toBe(id);
    const e = embeds[0]!.embed;
    expect(e.title).toBe("Sessão correcoes-bugs");
    expect(e.fields).toEqual([
      { name: "Pasta", value: "`~/dev/work/gestai`", inline: true },
      { name: "Conta", value: "leonardo@exemplo.com.br", inline: true },
      { name: "Estado", value: "⚪ ociosa", inline: true },
    ]);
    expect(port.of("post")).toHaveLength(0);
  });

  it("sessão em background ganha a linha `claude attach <bgId>` e o estado inicial dá o emoji", async () => {
    await reg.ensureThread(M, { ...S, bgId: "7f3c2a91", state: "waiting" });
    expect(port.of("createThread")[0]?.name).toBe("🟡 correcoes-bugs");
    const e = port.of("postEmbed")[0]!.embed;
    expect(e.fields).toContainEqual({ name: "Estado", value: "🟡 esperando", inline: true });
    expect(e.fields).toContainEqual({ name: "Abrir no terminal", value: "`claude attach 7f3c2a91`", inline: false });
    expect(e.footer).toContain("background");
  });

  it("sem conta conhecida mostra —; a conta explícita tem precedência", async () => {
    db.machines.upsert({ name: "mac/leo", tokenHash: "h2" });
    await reg.ensureThread("mac/leo", { ...S, sessionId: "s2" });
    expect(port.of("postEmbed")[0]!.embed.fields).toContainEqual({ name: "Conta", value: "—", inline: true });
    await reg.ensureThread(M, { ...S, sessionId: "s3", account: "outra@exemplo.com" });
    expect(port.of("postEmbed")[1]!.embed.fields).toContainEqual({ name: "Conta", value: "outra@exemplo.com", inline: true });
  });

  it("duas chamadas para o mesmo sessionId criam uma só thread", async () => {
    const a = await reg.ensureThread(M, S);
    const b = await reg.ensureThread(M, S);
    expect(a).toBe(b);
    expect(port.of("createThread")).toHaveLength(1);
  });

  it("chamadas concorrentes para o mesmo sessionId criam uma só thread", async () => {
    port.createDelayMs = 50;
    const p = Promise.all([reg.ensureThread(M, S), reg.ensureThread(M, S), reg.ensureThread(M, S)]);
    await vi.advanceTimersByTimeAsync(50);
    const ids = await p;
    expect(new Set(ids).size).toBe(1);
    expect(port.of("createThread")).toHaveLength(1);
    expect(port.of("postEmbed")).toHaveLength(1);
  });

  it("reaproveita a thread gravada no banco (restart do relay)", async () => {
    db.sessions.upsert({ sessionId: "s1", machine: M, name: "correcoes-bugs", threadId: "th-old", state: "working", updatedAt: 1 });
    expect(await reg.ensureThread(M, S)).toBe("th-old");
    expect(port.of("createThread")).toHaveLength(0);
    // o estado conhecido vem do banco: setState("working") não renomeia
    reg.setState("th-old", "working");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.of("renameThread")).toHaveLength(0);
  });

  it("falha na criação não fica em cache: a próxima chamada tenta de novo", async () => {
    const orig = port.createThread.bind(port);
    port.createThread = vi.fn().mockRejectedValueOnce(new Error("503")).mockImplementation(orig);
    await expect(reg.ensureThread(M, S)).rejects.toThrow("503");
    await expect(reg.ensureThread(M, S)).resolves.toMatch(/^th-/);
  });
});

describe("ThreadRegistry.setState", () => {
  it("5 chamadas em 1 s geram 1 rename imediato e 1 após 300 s com o último estado", async () => {
    const id = await reg.ensureThread(M, S);
    reg.setState(id, "working");
    await vi.advanceTimersByTimeAsync(200);
    reg.setState(id, "waiting");
    await vi.advanceTimersByTimeAsync(200);
    reg.setState(id, "working");
    await vi.advanceTimersByTimeAsync(200);
    reg.setState(id, "error");
    await vi.advanceTimersByTimeAsync(200);
    reg.setState(id, "waiting");
    await vi.advanceTimersByTimeAsync(200);
    expect(port.of("renameThread")).toEqual([{ op: "renameThread", threadId: id, name: "🟢 correcoes-bugs" }]);

    await vi.advanceTimersByTimeAsync(298_999);
    expect(port.of("renameThread")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(port.of("renameThread")).toEqual([
      { op: "renameThread", threadId: id, name: "🟢 correcoes-bugs" },
      { op: "renameThread", threadId: id, name: "🟡 correcoes-bugs" },
    ]);
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(port.of("renameThread")).toHaveLength(2);
  });

  it("20 mudanças em 10 min com rename lento: no máximo 1 em voo e ≤ 3 chamadas, a última com o estado final", async () => {
    const id = await reg.ensureThread(M, S);
    let inFlight = 0;
    let maxInFlight = 0;
    const names: string[] = [];
    port.renameThread = vi.fn(async (_t: string, name: string) => {
      names.push(name);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 90_000));
      inFlight--;
    });
    const states = ["working", "waiting"] as const;
    for (let i = 0; i < 20; i++) {
      reg.setState(id, states[i % 2]!);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(maxInFlight).toBe(1);
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names.length).toBeLessThanOrEqual(3);
    expect(names.at(-1)).toBe("🟡 correcoes-bugs"); // estado final da sequência (i = 19)
  });

  it("depois de um erro, tenta de novo só após o intervalo", async () => {
    const id = await reg.ensureThread(M, S);
    const rename = vi.fn().mockRejectedValueOnce(new Error("500")).mockResolvedValue(undefined);
    port.renameThread = rename;
    reg.setState(id, "working");
    await vi.advanceTimersByTimeAsync(299_000);
    expect(rename).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenLastCalledWith(id, "🟢 correcoes-bugs");
  });

  it("estado igual ao aplicado não renomeia", async () => {
    const id = await reg.ensureThread(M, S);
    reg.setState(id, "done");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.of("renameThread")).toHaveLength(0);
  });

  it("voltar ao estado aplicado dentro da janela cancela o rename pendente", async () => {
    const id = await reg.ensureThread(M, S);
    reg.setState(id, "working");
    reg.setState(id, "waiting");
    reg.setState(id, "working");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.of("renameThread")).toHaveLength(1);
  });

  it("depois que a janela abre, o próximo estado renomeia na hora", async () => {
    const id = await reg.ensureThread(M, S);
    reg.setState(id, "working");
    await vi.advanceTimersByTimeAsync(301_000);
    reg.setState(id, "done");
    await vi.advanceTimersByTimeAsync(0);
    expect(port.of("renameThread").map((c) => c.name)).toEqual(["🟢 correcoes-bugs", "⚪ correcoes-bugs"]);
  });

  it("thread desconhecida é ignorada", async () => {
    reg.setState("th-nada", "working");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.of("renameThread")).toHaveLength(0);
  });

  it("erro no rename vai para o log, sem rejeição solta", async () => {
    const id = await reg.ensureThread(M, S);
    port.renameThread = vi.fn().mockRejectedValue(new Error("missing access"));
    reg.setState(id, "working");
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("missing access"));
  });
});

describe("ThreadRegistry.rename", () => {
  it("muda o nome mantendo o emoji atual, sem criar thread nova", async () => {
    const id = await reg.ensureThread(M, S);
    reg.setState(id, "waiting");
    await vi.advanceTimersByTimeAsync(300_000);
    reg.rename("s1", "bugs-faturamento");
    await vi.advanceTimersByTimeAsync(0);
    expect(port.of("renameThread").at(-1)).toEqual({ op: "renameThread", threadId: id, name: "🟡 bugs-faturamento" });
    expect(port.of("createThread")).toHaveLength(1);
  });

  it("respeita o intervalo de 300 s e se combina com o estado mais recente", async () => {
    const id = await reg.ensureThread(M, S);
    reg.setState(id, "working");
    reg.rename("s1", "novo-nome");
    reg.setState(id, "done");
    await vi.advanceTimersByTimeAsync(0);
    expect(port.of("renameThread")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(port.of("renameThread").map((c) => c.name)).toEqual(["🟢 correcoes-bugs", "⚪ novo-nome"]);
  });

  it("mesmo nome ou sessão sem thread não faz nada", async () => {
    await reg.ensureThread(M, S);
    reg.rename("s1", "correcoes-bugs");
    reg.rename("s-inexistente", "x");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.of("renameThread")).toHaveLength(0);
    expect(port.of("createThread")).toHaveLength(1);
  });
});
