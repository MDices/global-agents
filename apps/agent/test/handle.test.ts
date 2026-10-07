import { AgentEventSchema, newEnvelope, type AgentEvent, type RelayCommand, type SessionInfo, type SlashCommandName } from "@global-agents/protocol";
import { describe, expect, it, vi } from "vitest";
import { InboxFormatError, type InboxTarget } from "../src/claude/inject.js";
import type { SessionRegistry } from "../src/claude/registry.js";
import type { SpawnInput } from "../src/claude/spawn.js";
import { createCommandHandler, type CommandDeps, type ResumeInput, type SlashInput } from "../src/commands/handle.js";

const MACHINE = "leo/fedora";
const BG: SessionInfo = { sessionId: "s-bg", cwd: "/p", name: "bg", kind: "background", pid: 111, bgId: "a1b2c3d4" };
const INTER: SessionInfo = { sessionId: "s-int", cwd: "/p", name: "int", kind: "interactive", pid: 222 };
const BUSY: SessionInfo = { sessionId: "s-busy", cwd: "/p", name: "ocupada", kind: "background", status: "busy", pid: 333, bgId: "b0b0b0b0" };
const NOPID: SessionInfo = { sessionId: "s-nopid", cwd: "/p", name: "x", kind: "background", bgId: "deadbeef" };
const REG: Record<number, SessionRegistry> = {
  111: { pid: 111, sessionId: "s-bg", messagingSocketPath: "/run/cc/111.sock", peerToken: "tok-secreto", peerProtocol: 1 },
  222: { pid: 222, sessionId: "s-int", messagingSocketPath: "/run/cc/222.sock" },
  333: { pid: 333, sessionId: "s-busy", messagingSocketPath: "/run/cc/333.sock", peerProtocol: 1 },
};

function deps(over: Partial<CommandDeps> = {}) {
  const sessions = [BG, INTER, NOPID, BUSY];
  const d = {
    machine: MACHINE,
    inventory: { find: (id: string) => sessions.find((s) => s.sessionId === id) },
    inject: vi.fn<(t: InboxTarget, text: string, from: { name: string }) => Promise<void>>(() => Promise.resolve()),
    spawn: vi.fn<(i: SpawnInput) => Promise<{ sessionId: string; bgId: string }>>(() => Promise.resolve({ sessionId: "novo", bgId: "0badf00d" })),
    stop: vi.fn<(b: string) => Promise<void>>(() => Promise.resolve()),
    readRegistry: vi.fn((pid: number) => REG[pid]),
    slash: vi.fn<(i: SlashInput) => Promise<{ screen: string }>>(() => Promise.resolve({ screen: "Version: 2.1.292" })),
    resume: vi.fn<(i: ResumeInput) => Promise<void>>(() => Promise.resolve()),
    onWarning: vi.fn<(message: string, sessionId: string) => void>(),
    ...over,
  };
  return d;
}

const env = () => newEnvelope("relay/relay");
const send = (commandId: string, sessionId: string, text = "oi"): RelayCommand => ({ ...env(), type: "session.send", commandId, sessionId, text });
const stop = (commandId: string, sessionId: string): RelayCommand => ({ ...env(), type: "session.stop", commandId, sessionId });
const slashCmd = (commandId: string, sessionId: string, command: SlashCommandName, args?: string): RelayCommand =>
  ({ ...env(), type: "session.slash", commandId, sessionId, command, ...(args !== undefined ? { args } : {}) });

function expectValid(ev: AgentEvent): void {
  expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  expect(ev.machine).toBe(MACHINE);
}

describe("session.slash", () => {
  it("sessão em background → runSlash(bgId, comando, args) e ack com a tela", async () => {
    const d = deps();
    const ev = await createCommandHandler(d)(slashCmd("c1", "s-bg", "compact", "foco em testes"));
    expect(d.slash).toHaveBeenCalledWith({ bgId: "a1b2c3d4", command: "compact", args: "foco em testes" });
    expect(ev).toMatchObject({ type: "command.ack", commandId: "c1", result: { screen: "Version: 2.1.292" } });
    expectValid(ev);
  });

  it("a tela do ack passa pelo redact (caminho do socket e token do inbox)", async () => {
    const d = deps({ slash: vi.fn(() => Promise.resolve({ screen: "Peer address:  uds:/run/cc/111.sock\nToken tok-secreto\nEmail: a@b.c" })) });
    const ev = await createCommandHandler(d)(slashCmd("c1", "s-bg", "status"));
    expect(ev).toMatchObject({ type: "command.ack", result: { screen: "Peer address:  uds:<inbox>\nToken ***\nEmail: a@b.c" } });
  });

  it("sem args não passa args", async () => {
    const d = deps();
    await createCommandHandler(d)(slashCmd("c1", "s-bg", "status"));
    expect(d.slash).toHaveBeenCalledWith({ bgId: "a1b2c3d4", command: "status" });
  });

  it("sessão interativa → erro pedindo /bg, sem abrir o pty", async () => {
    const d = deps();
    const ev = await createCommandHandler(d)(slashCmd("c1", "s-int", "usage"));
    expect(ev).toMatchObject({
      type: "command.error",
      reason: "essa sessão está aberta num terminal; rode o comando lá ou mande-a para o fundo com /bg",
    });
    expect(d.slash).not.toHaveBeenCalled();
  });

  it("sessão busy + compact → erro ocupada", async () => {
    const d = deps();
    const ev = await createCommandHandler(d)(slashCmd("c1", "s-busy", "compact"));
    expect(ev).toMatchObject({ type: "command.error", reason: "sessão ocupada; tente quando o turno terminar" });
    expect(d.slash).not.toHaveBeenCalled();
  });

  it.each(["usage", "cost", "status"] as const)("sessão busy + %s → roda mesmo assim", async (command) => {
    const d = deps();
    const ev = await createCommandHandler(d)(slashCmd("c1", "s-busy", command));
    expect(ev.type).toBe("command.ack");
    expect(d.slash).toHaveBeenCalledWith({ bgId: "b0b0b0b0", command });
  });

  it.each(["hooks", "context", "model"] as const)("sessão busy + %s → erro ocupada", async (command) => {
    const d = deps();
    expect(await createCommandHandler(d)(slashCmd("c1", "s-busy", command))).toMatchObject({ type: "command.error", reason: expect.stringContaining("ocupada") });
  });

  it("sessão inexistente → não encontrada", async () => {
    const d = deps();
    expect(await createCommandHandler(d)(slashCmd("c1", "nada", "usage"))).toMatchObject({ type: "command.error", reason: "sessão não encontrada nesta máquina" });
  });

  it("falha do runSlash vira command.error com a mensagem", async () => {
    const d = deps({ slash: vi.fn(() => Promise.reject(new Error("tempo esgotado esperando /usage terminar (20 s)"))) });
    expect(await createCommandHandler(d)(slashCmd("c1", "s-bg", "usage")))
      .toMatchObject({ type: "command.error", reason: "tempo esgotado esperando /usage terminar (20 s)" });
  });

  it("dois comandos na mesma sessão ao mesmo tempo: o segundo é recusado (um attach por vez)", async () => {
    let release: (v: { screen: string }) => void = () => undefined;
    const d = deps();
    d.slash.mockImplementationOnce(() => new Promise<{ screen: string }>((r) => { release = r; }));
    const h = createCommandHandler(d);
    const first = h(slashCmd("c1", "s-bg", "usage"));
    const second = await h(slashCmd("c2", "s-bg", "cost"));
    expect(second).toMatchObject({ type: "command.error", reason: expect.stringContaining("já há um comando") });
    release({ screen: "ok" });
    expect(await first).toMatchObject({ type: "command.ack" });
    expect(await h(slashCmd("c3", "s-bg", "cost"))).toMatchObject({ type: "command.ack" });
    expect(d.slash).toHaveBeenCalledTimes(2);
  });
});

describe("session.send com formato do inbox mudado (fallback por pty)", () => {
  const formatChanged = () => vi.fn(() => Promise.reject(new InboxFormatError("protocolo de inbox não suportado (peerProtocol 2)")));
  const WARNING = "usando modo compatível: formato do inbox mudou";

  it("sessão em background → resume({ sessionId, text }), warning e ack", async () => {
    const d = deps({ inject: formatChanged() });
    const ev = await createCommandHandler(d)(send("c1", "s-bg", "faz isso"));
    expect(d.resume).toHaveBeenCalledWith({ sessionId: "s-bg", text: "faz isso" });
    expect(d.onWarning).toHaveBeenCalledWith(WARNING, "s-bg");
    expect(ev).toMatchObject({ type: "command.ack", commandId: "c1" });
    expectValid(ev);
  });

  it("warning uma vez por sessão: dois envios na mesma sessão avisam uma vez; outra sessão avisa de novo", async () => {
    const d = deps({ inject: formatChanged() });
    const h = createCommandHandler(d);
    await h(send("c1", "s-bg"));
    await h(send("c2", "s-bg"));
    expect(d.onWarning).toHaveBeenCalledTimes(1);
    await h(send("c3", "s-busy"));
    expect(d.onWarning).toHaveBeenCalledTimes(2);
    expect(d.onWarning).toHaveBeenLastCalledWith(WARNING, "s-busy");
    expect(d.resume).toHaveBeenCalledTimes(3);
  });

  it("sessão interativa → command.error pedindo o terminal, sem resume nem warning", async () => {
    const d = deps({ inject: formatChanged() });
    const ev = await createCommandHandler(d)(send("c1", "s-int"));
    expect(ev).toMatchObject({
      type: "command.error",
      reason: "formato do inbox mudou e a sessão é interativa; mande o prompt pelo terminal",
    });
    expect(d.resume).not.toHaveBeenCalled();
    expect(d.onWarning).not.toHaveBeenCalled();
  });

  it("resume falhando (recusa, node-pty ausente) → command.error com a mensagem, sem token", async () => {
    const d = deps({
      inject: formatChanged(),
      resume: vi.fn(() => Promise.reject(new Error("o Claude recusou o prompt: Your prompt was not sent tok-secreto"))),
    });
    const ev = await createCommandHandler(d)(send("c1", "s-bg"));
    expect(ev).toMatchObject({ type: "command.error", reason: "o Claude recusou o prompt: Your prompt was not sent ***" });
  });

  it("um attach por vez: resume com um /claude rodando na mesma sessão é recusado", async () => {
    let release = (): void => undefined;
    const d = deps({
      inject: formatChanged(),
      slash: vi.fn(() => new Promise<{ screen: string }>((r) => { release = () => { r({ screen: "" }); }; })),
    });
    const h = createCommandHandler(d);
    const first = h(slashCmd("c1", "s-bg", "status"));
    const ev = await h(send("c2", "s-bg"));
    expect(ev).toMatchObject({ type: "command.error", reason: "já há um comando do Claude rodando nessa sessão; espere ele terminar" });
    expect(d.resume).not.toHaveBeenCalled();
    release();
    await first;
  });

  it("outros erros do inject não acionam o fallback", async () => {
    const d = deps({ inject: vi.fn(() => Promise.reject(new Error("inbox da sessão indisponível (ENOENT)"))) });
    const ev = await createCommandHandler(d)(send("c1", "s-bg"));
    expect(ev).toMatchObject({ type: "command.error", reason: "inbox da sessão indisponível (ENOENT)" });
    expect(d.resume).not.toHaveBeenCalled();
  });
});

describe("createCommandHandler", () => {
  it("session.send para sessão existente injeta no socket do registro e devolve ack", async () => {
    const d = deps();
    const ev = await createCommandHandler(d)(send("c1", "s-bg", "faz isso"));
    expect(ev).toMatchObject({ type: "command.ack", commandId: "c1" });
    expect("result" in ev).toBe(false);
    expectValid(ev);
    expect(d.readRegistry).toHaveBeenCalledWith(111);
    expect(d.inject).toHaveBeenCalledWith(
      { messagingSocketPath: "/run/cc/111.sock", peerToken: "tok-secreto", peerProtocol: 1 },
      "faz isso",
      { name: "discord" },
    );
  });

  it("session.send para sessão interativa também é permitido", async () => {
    const d = deps();
    const ev = await createCommandHandler(d)(send("c1", "s-int"));
    expect(ev.type).toBe("command.ack");
    expect(d.inject.mock.calls[0]?.[0]).toEqual({ messagingSocketPath: "/run/cc/222.sock" });
  });

  it("session.send para sessão inexistente → error 'não encontrada'", async () => {
    const d = deps();
    const ev = await createCommandHandler(d)(send("c1", "nada"));
    expect(ev).toMatchObject({ type: "command.error", commandId: "c1", reason: "sessão não encontrada nesta máquina" });
    expectValid(ev);
    expect(d.inject).not.toHaveBeenCalled();
  });

  it("session.send sem pid ou sem registro → error 'sessão sem inbox'", async () => {
    const d = deps({ readRegistry: vi.fn(() => undefined) });
    const h = createCommandHandler(d);
    expect(await h(send("c1", "s-nopid"))).toMatchObject({ type: "command.error", reason: "sessão sem inbox (reinicie a sessão)" });
    expect(await h(send("c2", "s-bg"))).toMatchObject({ type: "command.error", reason: "sessão sem inbox (reinicie a sessão)" });
    expect(d.inject).not.toHaveBeenCalled();
  });

  it("inject lançando → command.error sem exceção, sem token nem caminho do socket", async () => {
    const d = deps({
      inject: vi.fn(() => Promise.reject(new Error("falha na conexão com o inbox da sessão: connect EACCES /run/cc/111.sock tok-secreto"))),
    });
    const ev = await createCommandHandler(d)(send("c1", "s-bg"));
    expect(ev.type).toBe("command.error");
    const reason = ev.type === "command.error" ? ev.reason : "";
    expect(reason).toContain("falha na conexão com o inbox da sessão");
    expect(reason).not.toContain("tok-secreto");
    expect(reason).not.toContain("/run/cc/111.sock");
    expectValid(ev);
  });

  it("exceção que não é Error vira command.error com String(e)", async () => {
    const d = deps({ stop: vi.fn(() => Promise.reject("quebrou")) });
    expect(await createCommandHandler(d)(stop("c1", "s-bg"))).toMatchObject({ type: "command.error", reason: "quebrou" });
  });

  it("session.create → spawn e ack com { sessionId, bgId }", async () => {
    const d = deps();
    const cmd: RelayCommand = { ...env(), type: "session.create", commandId: "c1", cwd: "/p", name: "n", prompt: "p", permissionMode: "plan" };
    const ev = await createCommandHandler(d)(cmd);
    expect(ev).toMatchObject({ type: "command.ack", commandId: "c1", result: { sessionId: "novo", bgId: "0badf00d" } });
    expectValid(ev);
    expect(d.spawn).toHaveBeenCalledWith({ cwd: "/p", name: "n", prompt: "p", permissionMode: "plan" });
  });

  it("session.create com spawn falhando → command.error com a mensagem", async () => {
    const d = deps({ spawn: vi.fn(() => Promise.reject(new Error("pasta não encontrada: /p"))) });
    const cmd: RelayCommand = { ...env(), type: "session.create", commandId: "c1", cwd: "/p", name: "n", prompt: "p", permissionMode: "default" };
    expect(await createCommandHandler(d)(cmd)).toMatchObject({ type: "command.error", reason: "pasta não encontrada: /p" });
  });

  it("session.stop em background → stop(bgId) e ack", async () => {
    const d = deps();
    const ev = await createCommandHandler(d)(stop("c1", "s-bg"));
    expect(ev).toMatchObject({ type: "command.ack", commandId: "c1" });
    expect(d.stop).toHaveBeenCalledWith("a1b2c3d4");
  });

  it("session.stop em interativa (sem bgId) → error com 'background'", async () => {
    const d = deps();
    const ev = await createCommandHandler(d)(stop("c1", "s-int"));
    expect(ev).toMatchObject({
      type: "command.error",
      reason: "só sessões em background podem ser paradas pelo Discord; use claude /exit no terminal",
    });
    expect(d.stop).not.toHaveBeenCalled();
  });

  it("session.stop em sessão inexistente → error 'não encontrada'", async () => {
    const d = deps();
    expect(await createCommandHandler(d)(stop("c1", "nada"))).toMatchObject({ type: "command.error", reason: "sessão não encontrada nesta máquina" });
  });

  describe("permission.decide", () => {
    const decide = (commandId: string): RelayCommand => ({ ...env(), type: "permission.decide", commandId, requestId: "r1", behavior: "allow" });

    it("sem onPermissionDecide → error 'permissões ainda não suportadas'", async () => {
      expect(await createCommandHandler(deps())(decide("c1"))).toMatchObject({ type: "command.error", reason: "permissões ainda não suportadas" });
    });

    it("onPermissionDecide true → ack; recebe requestId e behavior", async () => {
      const onPermissionDecide = vi.fn(() => true);
      const ev = await createCommandHandler(deps({ onPermissionDecide }))(decide("c1"));
      expect(ev).toMatchObject({ type: "command.ack", commandId: "c1" });
      expect(onPermissionDecide).toHaveBeenCalledWith("r1", "allow");
    });

    it("onPermissionDecide false → error 'pedido de permissão não encontrado ou já resolvido'", async () => {
      const ev = await createCommandHandler(deps({ onPermissionDecide: () => false }))(decide("c1"));
      expect(ev).toMatchObject({ type: "command.error", reason: "pedido de permissão não encontrado ou já resolvido" });
    });
  });

  describe("idempotência", () => {
    it("mesmo commandId duas vezes → inject chamado uma vez, mesma resposta", async () => {
      const d = deps();
      const h = createCommandHandler(d);
      const a = await h(send("dup", "s-bg"));
      const b = await h(send("dup", "s-bg"));
      expect(d.inject).toHaveBeenCalledTimes(1);
      expect(b).toBe(a);
    });

    it("erro também fica guardado (não reexecuta)", async () => {
      const d = deps({ inject: vi.fn(() => Promise.reject(new Error("x"))) });
      const h = createCommandHandler(d);
      const a = await h(send("dup", "s-bg"));
      expect(await h(send("dup", "s-bg"))).toBe(a);
      expect(d.inject).toHaveBeenCalledTimes(1);
    });

    it("duplicata chegando com o primeiro ainda em andamento recebe a mesma promise", async () => {
      let release!: () => void;
      const d = deps({ inject: vi.fn(() => new Promise<void>((r) => (release = r))) });
      const h = createCommandHandler(d);
      const p1 = h(send("dup", "s-bg"));
      const p2 = h(send("dup", "s-bg"));
      expect(p2).toBe(p1);
      release();
      expect(await p2).toBe(await p1);
      expect(d.inject).toHaveBeenCalledTimes(1);
    });

    it("guarda 500 respostas; a mais antiga sai quando entra a 501ª", async () => {
      const d = deps();
      const h = createCommandHandler(d);
      for (let i = 0; i < 501; i++) await h(send(`c${i}`, "s-bg"));
      expect(d.inject).toHaveBeenCalledTimes(501);
      await h(send("c500", "s-bg")); // recente: cache
      await h(send("c1", "s-bg")); // ainda dentro dos 500
      expect(d.inject).toHaveBeenCalledTimes(501);
      await h(send("c0", "s-bg")); // despejado: reexecuta
      expect(d.inject).toHaveBeenCalledTimes(502);
    });

    it("acesso renova a entrada (LRU, não FIFO)", async () => {
      const d = deps();
      const h = createCommandHandler(d);
      for (let i = 0; i < 500; i++) await h(send(`c${i}`, "s-bg"));
      await h(send("c0", "s-bg")); // renova c0
      await h(send("novo", "s-bg")); // despeja c1, não c0
      expect(d.inject).toHaveBeenCalledTimes(501);
      await h(send("c0", "s-bg"));
      expect(d.inject).toHaveBeenCalledTimes(501);
      await h(send("c1", "s-bg"));
      expect(d.inject).toHaveBeenCalledTimes(502);
    });
  });
});
