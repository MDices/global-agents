import type { AgentEvent } from "@global-agents/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { portInUseMessage, startHookServer, type HookDecision, type PermissionPayload } from "../src/hooks/server.js";

const lookupName = (): string | undefined => undefined;
const prompt = { session_id: "s1", transcript_path: "/t", cwd: "/home/x/proj", hook_event_name: "UserPromptSubmit", permission_mode: "default", prompt: "oi" };
const perm = {
  session_id: "s1", transcript_path: "/t", cwd: "/home/x/proj", hook_event_name: "PermissionRequest", permission_mode: "default",
  tool_name: "Bash", tool_input: { command: "rm -rf build", description: "limpa" }, tool_use_id: "tu1", permission_suggestions: [],
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function start(onPermission?: (p: PermissionPayload, respond: (d: HookDecision | null) => void, signal: AbortSignal) => void) {
  const onEvents = vi.fn<(evs: AgentEvent[]) => void>();
  const srv = await startHookServer({ port: 0, machine: "fedora/leonardo", lookupName, onEvents, ...(onPermission ? { onPermission } : {}) });
  close = srv.close;
  const url = `http://127.0.0.1:${srv.port}`;
  const post = (body: string) => fetch(`${url}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body });
  return { srv, onEvents, url, post };
}

describe("startHookServer", () => {
  it("POST /hook UserPromptSubmit → 204 e onEvents com 2 eventos", async () => {
    const { onEvents, post } = await start();
    const res = await post(JSON.stringify(prompt));
    expect(res.status).toBe(204);
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(onEvents.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("GET /health → ok", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });

  it("corpo inválido → 400", async () => {
    const { post, onEvents } = await start();
    expect((await post("{")).status).toBe(400);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("PermissionRequest fica pendente até respond(allow) → 200 com decisão", async () => {
    let respond: ((d: HookDecision | null) => void) | undefined;
    let got: PermissionPayload | undefined;
    const { post } = await start((p, r) => { got = p; respond = r; });
    const pending = post(JSON.stringify(perm));
    await vi.waitFor(() => expect(respond).toBeDefined());
    expect(got).toMatchObject({ session_id: "s1", tool_name: "Bash", tool_input: { command: "rm -rf build" } });
    respond?.({ behavior: "allow" });
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hookSpecificOutput: { hookEventName: string; decision: HookDecision } };
    expect(body.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(body.hookSpecificOutput.decision.behavior).toBe("allow");
  });

  it("PermissionRequest respondido com null → 204 corpo vazio", async () => {
    let respond: ((d: HookDecision | null) => void) | undefined;
    const { post } = await start((_p, r) => { respond = r; });
    const pending = post(JSON.stringify(perm));
    await vi.waitFor(() => expect(respond).toBeDefined());
    respond?.(null);
    const res = await pending;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("PermissionRequest sem onPermission → 204 imediato", async () => {
    const { post } = await start();
    expect((await post(JSON.stringify(perm))).status).toBe(204);
  });

  it("cliente desconecta antes da resposta → signal abortado; respond depois é ignorado", async () => {
    let respond: ((d: HookDecision | null) => void) | undefined;
    let signal: AbortSignal | undefined;
    const { url } = await start((_p, r, s) => { respond = r; signal = s; });
    const ac = new AbortController();
    const req = fetch(`${url}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(perm), signal: ac.signal });
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    ac.abort();
    await expect(req).rejects.toThrow();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(() => respond?.({ behavior: "allow" })).not.toThrow();
  });

  it("respond antes do fim da conexão não aborta o signal", async () => {
    let signal: AbortSignal | undefined;
    const { post } = await start((_p, r, s) => { signal = s; r({ behavior: "deny" }); });
    expect((await post(JSON.stringify(perm))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(signal?.aborted).toBe(false);
  });

  it("close() responde 204 às pendências sem abortar o signal", async () => {
    let signal: AbortSignal | undefined;
    const { srv, post } = await start((_p, _r, s) => { signal = s; });
    const pending = post(JSON.stringify(perm));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await srv.close();
    close = undefined;
    expect((await pending).status).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(signal?.aborted).toBe(false);
  });

  it("close() responde 204 às pendências", async () => {
    const { srv, post } = await start(() => {});
    const pending = post(JSON.stringify(perm));
    await new Promise((r) => setTimeout(r, 50));
    await srv.close();
    close = undefined;
    expect((await pending).status).toBe(204);
  });
});

describe("porta dos hooks ocupada", () => {
  it("EADDRINUSE vira erro em português com a porta e como resolver", async () => {
    const { srv } = await start();
    const err = await startHookServer({ port: srv.port, machine: "m", lookupName, onEvents: () => undefined }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain(`porta ${srv.port}`);
    expect(err?.message).toContain("já existe outro agente");
    expect((err?.cause as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
  });

  it("a instrução muda por plataforma", () => {
    expect(portInUseMessage(48476, "win32")).toContain("Get-CimInstance Win32_Process");
    expect(portInUseMessage(48476, "linux")).toContain("systemctl --user restart global-agents");
  });
});
