# global-agents — Plano parte 1: M1 Observar (Linux)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Leia antes o índice `2026-10-06-global-agents-plan.md` (Global Constraints, Review Focus, estrutura de arquivos) e a spec.

**Goal:** Ao fim desta parte, as sessões do Claude Code deste PC Linux aparecem num servidor Discord: um canal para a máquina, uma thread por sessão, com prompts digitados no terminal, estados e respostas finais.

**Entrega verificável:** rodar `global-agents install && global-agents run` aqui, abrir `claude` em qualquer pasta, digitar um prompt, e ver a thread no Discord com prompt, estado e resposta.

Etiquetas: `[S]` Sonnet, `[O]` Opus (spec §10).

---

### Task T01 `[S]`: Scaffold do monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `eslint.config.js`, `.gitignore`, `.nvmrc`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/index.ts`
- Create: `apps/agent/package.json`, `apps/agent/tsconfig.json`, `apps/agent/src/main.ts`
- Create: `apps/relay/package.json`, `apps/relay/tsconfig.json`, `apps/relay/src/main.ts`
- Test: `packages/protocol/test/smoke.test.ts`

**Interfaces:**
- Produces: scripts raiz `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`; alias de workspace `@global-agents/protocol`.

- [ ] **Step 1: Arquivos raiz**

`package.json`:
```json
{
  "name": "global-agents",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0", "pnpm": ">=10" },
  "packageManager": "pnpm@10.17.0",
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "@typescript-eslint/eslint-plugin": "^8.40.0",
    "@typescript-eslint/parser": "^8.40.0",
    "eslint": "^9.34.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```
`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```
`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "esModuleInterop": true, "skipLibCheck": true, "declaration": true, "sourceMap": true,
    "types": ["node"]
  }
}
```
`vitest.workspace.ts`:
```ts
export default ["packages/*", "apps/*"];
```
`eslint.config.js`:
```js
import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
export default [
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser, parserOptions: { sourceType: "module" } },
    plugins: { "@typescript-eslint": tseslint },
    rules: { ...tseslint.configs.recommended.rules, "@typescript-eslint/no-explicit-any": "error" },
  },
];
```
`.gitignore`: `node_modules/`, `dist/`, `*.log`, `.env`, `coverage/`. `.nvmrc`: `24`.

- [ ] **Step 2: Pacotes**

`packages/protocol/package.json`:
```json
{
  "name": "@global-agents/protocol", "version": "0.1.0", "type": "module",
  "main": "./dist/index.js", "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit", "lint": "eslint src test", "test": "vitest run" },
  "dependencies": { "zod": "^3.25.0" }
}
```
`packages/protocol/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src"] }`.
`packages/protocol/src/index.ts`: `export const PROTOCOL_VERSION = 1 as const;`

`apps/agent/package.json` (mesmo padrão; nome `@global-agents/agent`, `"bin": { "global-agents": "./dist/cli.js" }`, dependências `@global-agents/protocol: "workspace:*"`, `zod`, `ws ^8.18.0`; devDeps `@types/ws`). `apps/relay/package.json` (nome `@global-agents/relay`, `"bin": { "relay": "./dist/cli.js" }`, deps `@global-agents/protocol`, `zod`, `ws`, `discord.js ^14.27.0`). Ambos `tsconfig.json` iguais ao do protocol. `src/main.ts` de cada um: `console.log("global-agents agent");` / `console.log("global-agents relay");`.

- [ ] **Step 3: Teste de fumaça (falha primeiro)**

`packages/protocol/test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";
describe("protocol", () => { it("expõe a versão 1", () => { expect(PROTOCOL_VERSION).toBe(1); }); });
```
Run: `pnpm install && pnpm -r test` → antes de criar `index.ts` falha com "Cannot find module"; depois passa.

- [ ] **Step 4: Gate e commit**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test` → tudo verde.
```bash
git add -A && git commit -m "chore: scaffold do monorepo pnpm (protocol, agent, relay)"
```

---

### Task T02 `[S]`: Protocolo — envelope, eventos e comandos

**Files:**
- Create: `packages/protocol/src/envelope.ts`, `packages/protocol/src/events.ts`, `packages/protocol/src/commands.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/envelope.test.ts`, `packages/protocol/test/events.test.ts`, `packages/protocol/test/commands.test.ts`

**Interfaces:**
- Produces:
  - `MACHINE_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/`
  - `newEnvelope(machine: string): { v: 1; id: string; ts: string; machine: string }`
  - `parseLine(line: string): ParseResult` onde `ParseResult = { ok: true; message: Message } | { ok: false; error: string }` e `Message = AgentEvent | RelayCommand`
  - `serialize(message: Message): string` (uma linha JSON + `\n`)
  - Tipos exportados: `SessionInfo`, `AgentEvent` (união discriminada por `type`), `RelayCommand`, e os schemas zod `AgentEventSchema`, `RelayCommandSchema`, `MessageSchema`.
  - Enumerações: `SessionState = "working" | "waiting" | "done" | "error"`, `PermissionBehavior = "allow" | "deny"`, `PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions"`.

- [ ] **Step 1: Testes do envelope (falham)**

`test/envelope.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { newEnvelope, parseLine, serialize, MACHINE_RE } from "../src/index.js";

describe("envelope", () => {
  it("gera v=1, id uuid, ts ISO com fuso e machine", () => {
    const e = newEnvelope("fedora/leonardo");
    expect(e.v).toBe(1);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(e.ts).toISOString()).not.toThrow();
    expect(e.ts.endsWith("Z")).toBe(true);
    expect(e.machine).toBe("fedora/leonardo");
  });
  it("valida o formato hostname/usuario", () => {
    expect(MACHINE_RE.test("toneli-pc/admin")).toBe(true);
    expect(MACHINE_RE.test("ToneliPC")).toBe(false);
    expect(MACHINE_RE.test("a/b/c")).toBe(false);
  });
  it("parseLine recusa JSON inválido, versão errada e type desconhecido", () => {
    expect(parseLine("{").ok).toBe(false);
    const base = { ...newEnvelope("x/y"), type: "session.status", sessionId: "s", name: "n", cwd: "/", state: "done" };
    expect(parseLine(JSON.stringify({ ...base, v: 2 })).ok).toBe(false);
    expect(parseLine(JSON.stringify({ ...base, type: "nope" })).ok).toBe(false);
    expect(parseLine(JSON.stringify(base)).ok).toBe(true);
  });
  it("serialize produz uma linha terminada em \\n e parseLine a lê de volta", () => {
    const msg = { ...newEnvelope("x/y"), type: "session.status" as const, sessionId: "s", name: "n", cwd: "/", state: "working" as const };
    const line = serialize(msg);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    const r = parseLine(line.trim());
    expect(r.ok && r.message.type === "session.status" && r.message.state).toBe("working");
  });
});
```

- [ ] **Step 2: Testes de eventos e comandos (falham)**

`test/events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AgentEventSchema, newEnvelope } from "../src/index.js";
const env = () => newEnvelope("fedora/leonardo");
describe("eventos", () => {
  it("aceita agent.hello completo", () => {
    const r = AgentEventSchema.safeParse({ ...env(), type: "agent.hello", version: "0.1.0", os: "linux", osUser: "leonardo",
      claudeVersion: "2.1.291", claudeAccount: "leo@x.com", projects: ["/home/leonardo/dev"] });
    expect(r.success).toBe(true);
  });
  it("aceita session.list com campos opcionais ausentes", () => {
    const r = AgentEventSchema.safeParse({ ...env(), type: "session.list", sessions: [
      { sessionId: "u1", name: "a", cwd: "/p", kind: "interactive", status: "busy" },
      { sessionId: "u2", name: "b", cwd: "/p", kind: "background", status: "waiting", state: "blocked", waitingFor: "permission prompt", bgId: "85285a68" } ] });
    expect(r.success).toBe(true);
  });
  it("recusa session.status com estado inválido", () => {
    expect(AgentEventSchema.safeParse({ ...env(), type: "session.status", sessionId: "u", name: "n", cwd: "/", state: "paused" }).success).toBe(false);
  });
  it("turn.reply aceita texto vazio (Claude pode terminar sem texto)", () => {
    expect(AgentEventSchema.safeParse({ ...env(), type: "turn.reply", sessionId: "u", text: "", stopReason: "end_turn" }).success).toBe(true);
  });
  it("permission.request exige expiresAt ISO", () => {
    const ok = AgentEventSchema.safeParse({ ...env(), type: "permission.request", sessionId: "u", requestId: "r1", tool: "Bash", description: "d", inputPreview: "ls", expiresAt: new Date().toISOString() });
    expect(ok.success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...env(), type: "permission.request", sessionId: "u", requestId: "r1", tool: "Bash", description: "d", inputPreview: "ls", expiresAt: "amanhã" }).success).toBe(false);
  });
  it("command.ack e command.error", () => {
    expect(AgentEventSchema.safeParse({ ...env(), type: "command.ack", commandId: "c1", result: { sessionId: "u" } }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...env(), type: "command.error", commandId: "c1", reason: "sessão encerrada" }).success).toBe(true);
  });
});
```
`test/commands.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RelayCommandSchema, newEnvelope } from "../src/index.js";
const env = () => newEnvelope("relay/vps");
describe("comandos", () => {
  it("session.create exige cwd, name, prompt e permissionMode válido", () => {
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.create", commandId: "c", cwd: "/p", name: "x", prompt: "oi", permissionMode: "plan" }).success).toBe(true);
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.create", commandId: "c", cwd: "/p", name: "x", prompt: "oi", permissionMode: "yolo" }).success).toBe(false);
  });
  it("session.send limita text a 100 kB", () => {
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.send", commandId: "c", sessionId: "u", text: "a".repeat(100_001) }).success).toBe(false);
    expect(RelayCommandSchema.safeParse({ ...env(), type: "session.send", commandId: "c", sessionId: "u", text: "oi" }).success).toBe(true);
  });
  it("permission.decide só aceita allow|deny", () => {
    expect(RelayCommandSchema.safeParse({ ...env(), type: "permission.decide", commandId: "c", requestId: "r", behavior: "maybe" }).success).toBe(false);
  });
});
```
Run: `pnpm --filter @global-agents/protocol test` → FAIL (exports inexistentes).

- [ ] **Step 3: Implementação**

`src/envelope.ts`:
```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
export const MACHINE_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
export const EnvelopeSchema = z.object({
  v: z.literal(1), id: z.string().uuid(), ts: z.string().datetime({ offset: true }), machine: z.string().regex(MACHINE_RE),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;
export function newEnvelope(machine: string): Envelope {
  return { v: 1, id: randomUUID(), ts: new Date().toISOString(), machine };
}
```
`src/events.ts`:
```ts
import { z } from "zod";
import { EnvelopeSchema } from "./envelope.js";
export const SessionStateSchema = z.enum(["working", "waiting", "done", "error"]);
export type SessionState = z.infer<typeof SessionStateSchema>;
export const PermissionBehaviorSchema = z.enum(["allow", "deny"]);
export type PermissionBehavior = z.infer<typeof PermissionBehaviorSchema>;
export const SessionInfoSchema = z.object({
  sessionId: z.string().min(1), name: z.string(), cwd: z.string(),
  kind: z.enum(["interactive", "background"]), status: z.enum(["busy", "waiting", "idle"]).optional(),
  state: z.enum(["working", "blocked", "done", "failed", "stopped"]).optional(),
  waitingFor: z.string().optional(), bgId: z.string().optional(), pid: z.number().int().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => EnvelopeSchema.extend({ type: z.literal(type), ...shape });
export const AgentEventSchema = z.discriminatedUnion("type", [
  ev("agent.hello", { version: z.string(), os: z.enum(["linux", "win32", "darwin"]), osUser: z.string(), claudeVersion: z.string().optional(),
    claudeAccount: z.string().optional(), projects: z.array(z.string()) }),
  ev("agent.warning", { message: z.string(), sessionId: z.string().optional() }),
  ev("session.list", { sessions: z.array(SessionInfoSchema) }),
  ev("session.status", { sessionId: z.string(), name: z.string(), cwd: z.string(), state: SessionStateSchema, snippet: z.string().optional() }),
  ev("turn.prompt", { sessionId: z.string(), text: z.string(), source: z.enum(["terminal", "remote"]) }),
  ev("turn.reply", { sessionId: z.string(), text: z.string(), stopReason: z.string().optional() }),
  ev("permission.request", { sessionId: z.string(), requestId: z.string(), tool: z.string(), description: z.string(), inputPreview: z.string(), expiresAt: z.string().datetime({ offset: true }) }),
  ev("permission.resolved", { requestId: z.string(), by: z.enum(["remote", "terminal", "timeout"]), behavior: PermissionBehaviorSchema.optional() }),
  ev("command.ack", { commandId: z.string(), result: z.record(z.unknown()).optional() }),
  ev("command.error", { commandId: z.string(), reason: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
```
`src/commands.ts`:
```ts
import { z } from "zod";
import { EnvelopeSchema } from "./envelope.js";
import { PermissionBehaviorSchema } from "./events.js";
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => EnvelopeSchema.extend({ type: z.literal(type), commandId: z.string().min(1), ...shape });
export const RelayCommandSchema = z.discriminatedUnion("type", [
  cmd("session.create", { cwd: z.string().min(1), name: z.string().min(1).max(100), prompt: z.string().min(1).max(100_000), permissionMode: PermissionModeSchema }),
  cmd("session.send", { sessionId: z.string().min(1), text: z.string().min(1).max(100_000) }),
  cmd("session.stop", { sessionId: z.string().min(1) }),
  cmd("permission.decide", { requestId: z.string().min(1), behavior: PermissionBehaviorSchema }),
]);
export type RelayCommand = z.infer<typeof RelayCommandSchema>;
```
`src/index.ts`:
```ts
import { z } from "zod";
import { AgentEventSchema, type AgentEvent } from "./events.js";
import { RelayCommandSchema, type RelayCommand } from "./commands.js";
export * from "./envelope.js"; export * from "./events.js"; export * from "./commands.js";
export const PROTOCOL_VERSION = 1 as const;
export const MessageSchema = z.union([AgentEventSchema, RelayCommandSchema]);
export type Message = AgentEvent | RelayCommand;
export type ParseResult = { ok: true; message: Message } | { ok: false; error: string };
export function parseLine(line: string): ParseResult {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch (e) { return { ok: false, error: `JSON inválido: ${(e as Error).message}` }; }
  const r = MessageSchema.safeParse(raw);
  return r.success ? { ok: true, message: r.data } : { ok: false, error: r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
export function serialize(message: Message): string { return JSON.stringify(message) + "\n"; }
```

- [ ] **Step 4: Verificar e commitar**

Run: `pnpm --filter @global-agents/protocol test && pnpm -r typecheck && pnpm -r lint` → PASS.
```bash
git add packages/protocol && git commit -m "feat(protocol): envelope v1, eventos e comandos com validação zod"
```

---

### Task T03 `[S]`: Agente — config, identidade da máquina e execução do `claude`

**Files:**
- Create: `apps/agent/src/config.ts`, `apps/agent/src/machine.ts`, `apps/agent/src/claude/exec.ts`
- Test: `apps/agent/test/config.test.ts`, `apps/agent/test/machine.test.ts`, `apps/agent/test/exec.test.ts`

**Interfaces:**
- Produces:
  - `AgentConfig = { relayUrl; relayCertFingerprint?; token; machineName?; projects: string[]; port (48476); claudeBin ("claude"); dataDir (~/.global-agents) }`
  - `loadConfig(path = ~/.global-agents/config.json): AgentConfig`, `saveConfig(cfg, path?)` (modo 0600).
  - `machineId(cfg, user = os.userInfo().username): string` → `hostname/usuario` normalizado; `normalizePart(s)` (minúsculas, fora de `[a-z0-9._-]` vira `-`, colapsa `--`).
  - `cleanEnv(env): env` sem `CLAUDE_CODE_*` nem `CLAUDECODE`.
  - `runClaude(args, { cwd?, timeoutMs = 30000, claudeBin = "claude" }): Promise<{ code; stdout; stderr }>` com `stdin: "ignore"`, `windowsHide: true`, env limpo.

- [ ] **Step 1: Testes (falham)**

`test/config.test.ts`: escreve um `config.json` temporário com `{ relayUrl: "wss://1.2.3.4:8443/ws", token: "t", projects: ["/x"] }`, chama `loadConfig(p)` e espera `port === 48476`, `claudeBin === "claude"`, `projects` igual. Segundo caso: `relayUrl: "http://x"` → `toThrow(/relayUrl/)`.

`test/machine.test.ts`: `machineId({ machineName: "Toneli PC" }, "Admin") === "toneli-pc/admin"`; `MACHINE_RE.test(machineId({}, "leonardo"))` verdadeiro; `normalizePart("Léo_PC 01") === "l-o_pc-01"`.

`test/exec.test.ts`: `cleanEnv({ PATH:"/bin", CLAUDE_CODE_SESSION_ID:"x", CLAUDECODE:"1", HOME:"/h" })` → `{ PATH:"/bin", HOME:"/h" }`; `runClaude(["-c","echo '{\"ok\":true}'"], { claudeBin: "sh" })` → `code 0` e `JSON.parse(stdout).ok === true`.

Run: `pnpm --filter @global-agents/agent test` → FAIL (módulos inexistentes).

- [ ] **Step 2: Implementação**

`src/config.ts`: schema zod com `relayUrl: z.string().url().refine(u => /^wss?:\/\//.test(u), "relayUrl deve começar com ws:// ou wss://")`, `relayCertFingerprint: z.string().regex(/^[0-9A-F:]{95}$/i).optional()`, `token: z.string().min(1)`, `machineName: z.string().optional()`, `projects: z.array(z.string()).default([])`, `port: z.number().int().default(48476)`, `claudeBin: z.string().default("claude")`, `dataDir: z.string().default(DEFAULT_DIR)`. `loadConfig` lança `config não encontrada em <path>; rode global-agents install` se o arquivo não existe e `config inválida: <issues>` se o parse falhar. `saveConfig` cria o diretório e grava com `mode: 0o600`.

`src/machine.ts`:
```ts
import { hostname, userInfo } from "node:os";
export function normalizePart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-");
}
export function machineId(cfg: { machineName?: string | undefined }, user = userInfo().username): string {
  return `${normalizePart(cfg.machineName ?? hostname())}/${normalizePart(user)}`;
}
```

`src/claude/exec.ts`:
```ts
import { spawn } from "node:child_process";
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE"));
}
export interface ExecResult { code: number; stdout: string; stderr: string }
export function runClaude(args: string[], opts: { cwd?: string; timeoutMs?: number; claudeBin?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.claudeBin ?? "claude", args, { cwd: opts.cwd, env: cleanEnv(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => (stdout += d)); child.stderr.on("data", d => (stderr += d));
    const ms = opts.timeoutMs ?? 30000;
    const t = setTimeout(() => { child.kill(); reject(new Error(`claude ${args[0]} excedeu ${ms} ms`)); }, ms);
    child.on("error", e => { clearTimeout(t); reject(e); });
    child.on("close", code => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
```

- [ ] **Step 3: Verificar e commitar**

Run: `pnpm --filter @global-agents/agent test && pnpm -r typecheck && pnpm -r lint` → PASS.
```bash
git add apps/agent && git commit -m "feat(agent): config, identidade hostname/usuario e execução do claude com env limpo"
```

---

### Task T04 `[O]`: Agente — registro de sessões e inventário (`claude agents --json`)

**Files:**
- Create: `apps/agent/src/claude/registry.ts`, `apps/agent/src/claude/inventory.ts`
- Create fixtures: `apps/agent/test/fixtures/agents-linux.json`, `agents-windows.json`, `session-2323142.json`, `session-2323142.abc.key`
- Test: `apps/agent/test/registry.test.ts`, `apps/agent/test/inventory.test.ts`

**Interfaces:**
- Consumes: `runClaude`/`ExecResult` (T03), `SessionInfo`/`SessionInfoSchema` (T02).
- Produces:
  - `readRegistry(pid: number, sessionsDir = ~/.claude/sessions): SessionRegistry | undefined` com `SessionRegistry = { pid; sessionId; messagingSocketPath; peerToken?; name?; peerProtocol? }`. Lê `<pid>.json`; procura `<pid>.*.key` e extrai `peerToken`.
  - `parseAgentsJson(raw: string): SessionInfo[]` — campo `id` da saída vira `bgId`; `name` ausente vira `""`; entradas inválidas são descartadas; saída ordenada por `sessionId`; JSON inválido → `[]`.
  - `class Inventory extends EventEmitter` — `constructor({ pollMs = 5000, run?, claudeBin? })`, `start()`, `stop()`, `poll()`, `current()`, `find(sessionId)`, `waitFor(pred, timeoutMs): Promise<SessionInfo>`; emite `"changed"` (lista) só quando o JSON normalizado muda, e `"error"` em falha do comando.

- [ ] **Step 1: Fixtures** (saídas reais dos spikes de 06/10)

`agents-linux.json`: três entradas: uma background `blocked` sem `pid` (`id: "dc63267c"`), uma interativa `busy` (`pid: 2172608`, `name: "correcoes-bugs"`), uma background `waiting`/`blocked`/`waitingFor: "permission prompt"` (`id: "85285a68"`, `sessionId: "85285a68-454d-45d5-aa79-4c7a4cd594d4"`).
`agents-windows.json`: uma entrada background `idle`/`done`, `cwd: "C:\\Users\\Admin\\CDT\\gestai"`, `id: "ccdcaa73"`.
`session-2323142.json`: `{"pid":2323142,"sessionId":"6c665779-5c10-4b08-adb5-fc13fd2987d6","cwd":"/home/leonardo/dev/work/global-agents","version":"2.1.291","peerProtocol":1,"kind":"interactive","messagingSocketPath":"/run/user/1000/cc-socks/2323142.sock","name":"global-agents-80","status":"busy"}`
`session-2323142.abc.key`: `{"peerToken":"67c71d8bdf91eaa635ce4a50de5fe44c","procStart":"130560421"}`

- [ ] **Step 2: Testes (falham)**

`registry.test.ts`: `readRegistry(2323142, fixturesDir)` devolve `messagingSocketPath` do fixture, `peerToken === "67c71d8b…"`, `sessionId` começando com `6c66`; `readRegistry(1, fixturesDir)` é `undefined`.

`inventory.test.ts`:
- `parseAgentsJson(linux)` tem 3 itens; o terceiro casa com `{ bgId: "85285a68", kind: "background", status: "waiting", waitingFor: "permission prompt" }`; o interativo não tem `bgId`.
- `parseAgentsJson(windows)[0].cwd === "C:\\Users\\Admin\\CDT\\gestai"`.
- `parseAgentsJson("")` e `parseAgentsJson("not json")` → `[]`.
- `Inventory` com `run` falso que devolve `[windows, windows, linux]` em sequência e `pollMs: 10`: `waitFor(s => s.name === "correcoes-bugs", 2000)` resolve; a lista de tamanhos emitidos em `changed` é `[1, 3]` (a repetição não emite).

Run: `pnpm --filter @global-agents/agent test` → FAIL.

- [ ] **Step 3: Implementação**

`registry.ts`: `existsSync` + `JSON.parse`; exige `messagingSocketPath` e `sessionId` strings; `readdirSync(sessionsDir).find(f => f.startsWith(`${pid}.`) && f.endsWith(".key"))`; qualquer exceção → `undefined`.

`inventory.ts`:
```ts
export function parseAgentsJson(raw: string): SessionInfo[] {
  let arr: unknown; try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: SessionInfo[] = [];
  for (const r of arr as Record<string, unknown>[]) {
    const c: Record<string, unknown> = { sessionId: r.sessionId, name: r.name ?? "", cwd: r.cwd, kind: r.kind,
      status: r.status, state: r.state, waitingFor: r.waitingFor, pid: r.pid, bgId: typeof r.id === "string" ? r.id : undefined };
    const p = SessionInfoSchema.safeParse(Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
    if (p.success) out.push(p.data);
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
```
`Inventory.poll()`: chama `run(["agents","--json"])` (padrão `runClaude` com `timeoutMs: 15000`), compara `JSON.stringify(next)` com o último, atualiza e emite `changed`. `start()` faz um `poll()` imediato e `setInterval`. `waitFor` resolve de imediato se já há match; senão escuta `changed` com `setTimeout` que rejeita com `sessão não apareceu no inventário a tempo`.

- [ ] **Step 4: Verificar e commitar**

Run: gate completo → PASS.
```bash
git add apps/agent && git commit -m "feat(agent): registro de sessões (.json/.key) e inventário via claude agents --json"
```

---

### Task T05 `[O]`: Agente — scripts de hook, servidor HTTP local e mapper de eventos

**Files:**
- Create: `apps/agent/src/hooks/scripts/global-agents-hook.sh`, `apps/agent/src/hooks/scripts/global-agents-hook.ps1`, `apps/agent/src/hooks/server.ts`, `apps/agent/src/hooks/mapper.ts`
- Test: `apps/agent/test/mapper.test.ts`, `apps/agent/test/hook-server.test.ts`, `apps/agent/test/hook-script.test.ts` (pula fora do Linux)

**Interfaces:**
- Consumes: `AgentEvent`, `newEnvelope` (T02).
- Produces:
  - `mapHookPayload(payload: unknown, ctx: { machine: string; lookupName: (sessionId: string) => string | undefined }): AgentEvent[]`
    - `UserPromptSubmit` → `[session.status(working), turn.prompt]`; `source: "remote"` quando `prompt` começa com `<cross-session-message`.
    - `Notification` → `[session.status(waiting, snippet = message)]`.
    - `Stop` → `[turn.reply(text = last_assistant_message ?? ""), session.status(done)]`.
    - `SessionEnd` → `[session.status(done)]`. `PermissionRequest` e desconhecidos → `[]` (permissão é tratada em T20).
    - Exige só `session_id`, `cwd`, `hook_event_name` (strings); ignora campos extras; `name` = `lookupName(session_id) ?? basename(cwd)`.
  - `startHookServer(opts: { port: number; machine: string; lookupName; onEvents: (evs: AgentEvent[]) => void; onPermission?: (payload: PermissionPayload, respond: (d: HookDecision | null) => void) => void }): Promise<{ close(): Promise<void> }>` em `127.0.0.1`: `POST /hook` lê JSON, responde `204` imediatamente para todo evento exceto `PermissionRequest`, que fica pendente até `respond(d)` (`200` com `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":d}}`, ou `204` se `null`); `GET /health` → `{ ok: true, version }`; corpo inválido → `400` (o script ignora).
  - `PermissionPayload = { session_id; cwd; tool_name; tool_input: unknown; permission_suggestions?: unknown }`, `HookDecision = { behavior: "allow" | "deny" }`.
- Scripts: leem o payload de stdin e fazem `POST http://127.0.0.1:${GLOBAL_AGENTS_PORT:-48476}/hook`; `--max-time 2` (ou 1800 quando `hook_event_name` é `PermissionRequest`); imprimem o corpo da resposta se não vazio; **`exit 0` em qualquer caminho**. O `.sh` usa só `curl` e `grep` (sem `jq`); o `.ps1` usa `Invoke-WebRequest` com `-TimeoutSec`.

- [ ] **Step 1: Testes do mapper (falham)**

`mapper.test.ts` com `ctx = { machine: "fedora/leonardo", lookupName: id => id === "s1" ? "correcoes-bugs" : undefined }`:
- `UserPromptSubmit` com `prompt: "roda os testes"` → tipos `["session.status","turn.prompt"]`; `evs[0]` casa `{ state: "working", name: "correcoes-bugs" }`; `evs[1]` casa `{ text: "roda os testes", source: "terminal", sessionId: "s1" }`.
- prompt começando com `<cross-session-message` → `source: "remote"`.
- `Stop` sem `last_assistant_message` e `stop_reason: "end_turn"` → `evs[0]` casa `{ type: "turn.reply", text: "", stopReason: "end_turn" }`, `evs[1]` casa `{ type: "session.status", state: "done" }`.
- `Notification` com `message: "Claude needs your permission"` → um `session.status` com `state: "waiting"` e `snippet` igual.
- payload sem `session_id` → `[]`; `hook_event_name: "PermissionRequest"` → `[]`; `session_id: "zz"` sem nome no lookup e `cwd: "/home/x/proj"` → `name === "proj"`.
- Todo evento retornado passa em `AgentEventSchema.safeParse`.

- [ ] **Step 2: Testes do servidor (falham)**

`hook-server.test.ts`: sobe em porta `0` (ler a porta real do retorno; adicionar `port` ao objeto retornado), faz `fetch POST /hook` com payload `UserPromptSubmit` → status `204` e `onEvents` chamado com 2 eventos; `GET /health` → `ok: true`; `POST /hook` com corpo `"{"` → `400`; `PermissionRequest`: dispara o POST sem aguardar, espera `onPermission` ser chamado, chama `respond({ behavior: "allow" })`, e o POST resolve `200` com `hookSpecificOutput.decision.behavior === "allow"`; outro `PermissionRequest` respondido com `null` → `204` corpo vazio.

- [ ] **Step 3: Teste do script (falha)**

`hook-script.test.ts` (`describe.skipIf(process.platform !== "linux")`): sobe o servidor de teste, roda `bash src/hooks/scripts/global-agents-hook.sh` com `GLOBAL_AGENTS_PORT` apontando pra ele e o payload no stdin → código de saída `0` e `onEvents` chamado; depois roda com `GLOBAL_AGENTS_PORT=1` (nada ouvindo) → ainda sai `0` em menos de 3 s.

- [ ] **Step 4: Implementação**

`global-agents-hook.sh`:
```bash
#!/usr/bin/env bash
# global-agents: encaminha o payload do hook ao agente local. Nunca bloqueia o Claude Code.
PAYLOAD=$(cat)
PORT="${GLOBAL_AGENTS_PORT:-48476}"
MAX=2
case "$PAYLOAD" in *'"hook_event_name":"PermissionRequest"'*|*'"hook_event_name": "PermissionRequest"'*) MAX=1800;; esac
RESP=$(printf '%s' "$PAYLOAD" | curl -sS -m "$MAX" -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${PORT}/hook" 2>/dev/null) || true
[ -n "$RESP" ] && printf '%s\n' "$RESP"
exit 0
```
`global-agents-hook.ps1`: equivalente com `$payload = [Console]::In.ReadToEnd()`, `$max = if ($payload -match '"hook_event_name":\s*"PermissionRequest"') { 1800 } else { 2 }`, `try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/hook" -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec $max -UseBasicParsing; if ($r.Content) { Write-Output $r.Content } } catch {}`, `exit 0`.

`mapper.ts`: valida com zod `{ hook_event_name: z.string(), session_id: z.string(), cwd: z.string() }.passthrough()`; monta eventos com `{ ...newEnvelope(ctx.machine), type, sessionId, name, cwd, ... }`; `basename` de `node:path` (usar `path.win32.basename` quando `cwd` contém `\`).

`server.ts`: `node:http` `createServer`, `listen(port, "127.0.0.1")`; lê o corpo até 1 MB; para `PermissionRequest` guarda `res` e chama `opts.onPermission(payload, decision => { … res.end() })`; se `onPermission` não existe, responde `204` na hora. `close()` fecha o servidor e responde `204` em pendências.

- [ ] **Step 5: Verificar e commitar**

Run: gate completo → PASS.
```bash
git add apps/agent && git commit -m "feat(agent): scripts de hook, servidor HTTP local e mapper de payloads para eventos"
```

---

### Task T06 `[S]`: Agente — instalador idempotente de hooks e settings

**Files:**
- Create: `apps/agent/src/hooks/install.ts`
- Test: `apps/agent/test/install.test.ts`

**Interfaces:**
- Produces:
  - `installHooks(opts: { settingsPath?: string; scriptCommand: string }): { status: "installed" | "already-present" | "updated"; path: string; changes: string[] }` — mescla em `~/.claude/settings.json`: para cada evento em `["UserPromptSubmit","Notification","Stop","SessionEnd","PermissionRequest"]` adiciona `{ hooks: [{ type: "command", command: scriptCommand, timeout: T }] }` (T = 1800 para `PermissionRequest`, 5 para os demais) se nenhuma entrada já contiver `global-agents-hook`; grava `crossSessionInbound: "accept"` se ausente. Escrita atômica (tmp + rename), preserva todas as outras chaves e entradas (inclusive hooks do global-pets).
  - `uninstallHooks(opts): { removed: string[] }` — remove só entradas cujo `command` contém `global-agents-hook`; **não** mexe em `crossSessionInbound` (avisar o usuário no CLI).
  - `scriptCommandFor(platform: NodeJS.Platform, scriptsDir: string): string` → Linux/macOS: `bash <dir>/global-agents-hook.sh`; Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File <dir>\global-agents-hook.ps1`.
- Referência de forma: `apps/desktop/electron/backend/hookInstaller.ts` do global-pets (mesma estratégia de merge, não copiar código do pet).

- [ ] **Step 1: Testes (falham)**

`install.test.ts`, cada caso com um `settings.json` temporário:
- arquivo inexistente → `status: "installed"`, cria os 5 eventos, `crossSessionInbound === "accept"`, `PermissionRequest[0].hooks[0].timeout === 1800`, `Stop[0].hooks[0].timeout === 5`.
- settings já com hook do global-pets em `Stop` (`command: "bash /x/global-pets-claude-hook.sh"`) e `permissions: { allow: ["Bash(git *)"] }` → após instalar, `Stop` tem 2 entradas, a do pet intacta na posição 0, `permissions` preservado.
- rodar duas vezes → segunda chamada `status: "already-present"` e conteúdo do arquivo idêntico byte a byte.
- settings com `crossSessionInbound: "hold"` → **não** sobrescreve (respeita escolha explícita), `changes` contém aviso `crossSessionInbound mantido em "hold"`.
- `uninstallHooks` → remove só as entradas com `global-agents-hook`; a do pet permanece; `crossSessionInbound` permanece.
- `scriptCommandFor("win32", "C:\\ac\\hooks")` começa com `powershell -NoProfile`.

- [ ] **Step 2: Implementação**

Funções internas `readJsonOrEmpty`, `writeJsonAtomic`, `asObject`, `asArray`. Marcador de propriedade: `command.includes("global-agents-hook")`. Retorno `changes` lista em português o que mudou (`"adicionado hook Stop"`, `"crossSessionInbound definido como accept"`).

- [ ] **Step 3: Verificar e commitar**

Run: gate → PASS.
```bash
git add apps/agent && git commit -m "feat(agent): instalador idempotente dos hooks e de crossSessionInbound"
```

---

### Task T07 `[O]`: Agente — outbox em disco

**Files:**
- Create: `apps/agent/src/transport/outbox.ts`
- Test: `apps/agent/test/outbox.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `serialize`, `parseLine` (T02).
- Produces: `class Outbox` — `constructor(dir: string, opts?: { maxBytes?: number (padrão 50 MB) })`, `append(ev: AgentEvent): void` (síncrono, `appendFileSync` em `outbox.jsonl`), `drain(send: (ev: AgentEvent) => Promise<void>): Promise<{ sent: number; skipped: number }>` (lê em ordem, envia um a um, para no primeiro erro mantendo o restante, trunca o arquivo com o que sobrou), `size(): number`. Regras: linhas inválidas são puladas e contadas em `skipped` (registrar em log); eventos `session.list` consecutivos são colapsados no `drain`, só o último é enviado; ao ultrapassar `maxBytes`, descarta os mais antigos que não sejam `turn.reply` ou `permission.request`.

- [ ] **Step 1: Testes (falham)**

- `append` de 3 eventos e `drain` com `send` que grava num array → `sent 3`, ordem preservada, arquivo vazio depois.
- arquivo com uma linha corrompida no meio (`{"v":1,"id":`) → `drain` devolve `skipped 1`, `sent 2`, não lança.
- 4 `session.list` seguidos + 1 `turn.reply` → `drain` envia 2 (último `session.list` e o `turn.reply`).
- `send` rejeita no 2.º evento → `sent 1`, arquivo mantém os 2 restantes; novo `drain` com `send` que funciona envia os 2.
- `maxBytes: 600` com 20 `session.status` e 1 `turn.reply` → após `append`s, `drain` ainda entrega o `turn.reply`.

- [ ] **Step 2: Implementação**

Usar `readFileSync` + `split("\n")`, `parseLine` por linha, escrita do restante com `writeFileSync` em `outbox.jsonl.tmp` + `renameSync`. Colapso de `session.list`: percorrer a lista e manter só o último índice de cada sequência contígua de `session.list`.

- [ ] **Step 3: Verificar e commitar**

```bash
git add apps/agent && git commit -m "feat(agent): outbox em disco com colapso de session.list e tolerância a linhas corrompidas"
```

---

### Task T08 `[O]`: Agente — cliente WebSocket com pinning, heartbeat e backoff

**Files:**
- Create: `apps/agent/src/transport/client.ts`
- Test: `apps/agent/test/ws-client.test.ts`

**Interfaces:**
- Consumes: `Outbox` (T07), `AgentEvent`, `RelayCommand`, `parseLine`, `serialize` (T02).
- Produces: `class RelayClient extends EventEmitter` — `constructor({ url, token, certFingerprint?, outbox, hello: () => AgentEvent, backoff?: { minMs = 1000, maxMs = 60000 }, pingMs = 30000 })`; `start()`, `stop()`, `send(ev: AgentEvent): void` (se conectado, escreve; senão, `outbox.append`), `isConnected()`. Emite `"command"` com `RelayCommand` validado, `"connected"`, `"disconnected"`, `"warning"` (string). Comportamento: ao conectar envia `hello()` e drena o outbox; `Authorization: Bearer <token>` no handshake; se `certFingerprint` definido, usa `checkServerIdentity` para comparar o `fingerprint256` do certificado e recusa se diferente (`rejectUnauthorized: false` só nesse caso, porque o cert é autoassinado); ping a cada `pingMs`, termina a conexão se não houver pong em `pingMs`; reconecta com backoff exponencial e jitter; linha recebida que não valida → `"warning"`, nunca lança.

- [ ] **Step 1: Testes (falham)**

Servidor `ws` falso em porta 0 nos testes (sem TLS para os casos funcionais):
- conecta, recebe `hello` como primeira linha, header `authorization` igual a `Bearer tok`.
- `send()` antes de conectar vai pro outbox e é entregue após conectar (ordem: hello, depois outbox, depois novos).
- servidor envia um comando `session.send` válido → evento `"command"` com o objeto; envia `"lixo"` → `"warning"` e a conexão continua.
- servidor fecha → cliente reconecta em menos de `minMs * 4` (usar `minMs: 20`) e reenvia `hello`.
- servidor para de responder ping (interceptar e não dar pong é difícil com `ws`; alternativa: `pingMs: 50` e servidor que `pause()` o socket) → cliente emite `"disconnected"` e reconecta.
- TLS: servidor `https` + `ws` com certificado autoassinado gerado no teste (`node:crypto` `generateKeyPairSync` + `selfsigned`? **Não adicionar dependência**: usar um certificado de fixture `test/fixtures/relay-test.pem` + `.key` commitado, gerado uma vez com `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=global-agents-test`); fingerprint certo conecta; fingerprint errado emite `"warning"` contendo `fingerprint` e não conecta.

- [ ] **Step 2: Implementação**

Pontos de atenção: `new WebSocket(url, { headers, rejectUnauthorized: !certFingerprint, checkServerIdentity: certFingerprint ? (_h, cert) => cert.fingerprint256.toUpperCase() === certFingerprint.toUpperCase() ? undefined : new Error("fingerprint do relay não confere") : undefined })`; `ws.on("pong")` zera o relógio; `terminate()` no timeout; `setTimeout` de reconexão com `Math.min(maxMs, cur * 2) * (0.8 + Math.random() * 0.4)`; `stop()` cancela timers e fecha com código 1000.

- [ ] **Step 3: Verificar e commitar**

```bash
git add apps/agent && git commit -m "feat(agent): cliente WebSocket com pinning de certificado, heartbeat, backoff e drenagem do outbox"
```

---

### Task T09 `[O]`: Agente — composição (`run`), CLI `install|run|status` e teste de integração local

**Files:**
- Create: `apps/agent/src/main.ts` (substitui o stub), `apps/agent/src/cli.ts`
- Test: `apps/agent/test/main.test.ts`, `apps/agent/test/e2e-linux.test.ts` (só com `GLOBAL_AGENTS_E2E=1`)

**Interfaces:**
- Consumes: tudo de T03–T08.
- Produces: `createAgent(cfg: AgentConfig, deps?: Partial<{ inventory; client; hookServer }>): { start(): Promise<void>; stop(): Promise<void> }` que: sobe `Inventory` e, a cada `changed`, envia `session.list`; sobe `startHookServer` e encaminha `onEvents` → `client.send`; `lookupName` consulta o inventário; monta `hello` com `version` (do package.json), `os`, `osUser`, `claudeVersion` (`claude --version`), `claudeAccount` (`claude auth status` → campo `email` do JSON, se houver), `projects` da config; reenvia `hello` quando `claudeAccount` muda (checar a cada 60 s). Comandos recebidos vão para `handleCommand` (T15) — nesta tarefa, qualquer comando responde `command.error` com `reason: "comandos ainda não suportados"`.
- CLI (`cli.ts`, sem dependência de framework; `process.argv[2]`): `install --relay <url> --token <t> [--fingerprint <fp>] [--project <dir>]...` (grava config, copia scripts para `<dataDir>/hooks/`, chama `installHooks`), `uninstall`, `run`, `status` (GET `/health` local + resumo da config sem o token). Saída em português.

- [ ] **Step 1: Testes (falham)**

`main.test.ts` com `Inventory` e `RelayClient` falsos injetados: ao `start()`, o cliente recebe `hello` seguido de `session.list` quando o inventário emite; um POST de hook `Stop` no servidor local resulta em `turn.reply` e `session.status` enviados ao cliente; um comando recebido gera `command.error` com a razão acima.

`e2e-linux.test.ts` (pulado sem `GLOBAL_AGENTS_E2E=1`; exige `claude` instalado e diretório confiável): sobe um relay falso `ws` local, `createAgent` com config apontando para ele, roda `claude --bg --name ac-e2e --permission-mode plan "Responda apenas OK."` via `runClaude`, espera receber `session.list` contendo `ac-e2e` e, se os hooks estiverem instalados na máquina, um `turn.reply` com `OK`; no fim `claude stop` e `claude rm`.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/agent && git commit -m "feat(agent): composição do agente, CLI install/run/status e e2e Linux opcional"
```

---

### Task T10 `[S]`: Relay — config e banco SQLite

**Files:**
- Create: `apps/relay/src/config.ts`, `apps/relay/src/db.ts`
- Test: `apps/relay/test/db.test.ts`, `apps/relay/test/config.test.ts`

**Interfaces:**
- Produces:
  - `RelayConfig = { discordToken; guildId; categoryName ("global-agents"); allowedUserIds: string[]; dataDir ("/data"); port (8443); logLevel }` via `loadRelayConfig(env = process.env)` (variáveis `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `ALLOWED_USER_IDS` separado por vírgula, `DATA_DIR`, `PORT`, `LOG_LEVEL`); erro claro quando falta obrigatória.
  - `openDb(path: string): Db` usando `node:sqlite` (`DatabaseSync`), com `migrate()` idempotente (tabela `schema_version`). Tabelas conforme spec §6.1: `machines(name PK, token_hash, channel_id, last_seen, os, claude_version, claude_account, filter_account)`, `sessions(session_id PK, machine, name, cwd, thread_id, bg_id, state, updated_at)`, `permissions(request_id PK, session_id, message_id, status, decided_by, decided_at)`, `pending_commands(command_id PK, machine, payload, created_at, expires_at, discord_message_id)`.
  - Repositórios tipados: `db.machines.upsert/getByName/getByTokenHash/setChannel/touch/list`, `db.sessions.upsert/get/setThread/setState/listByMachine`, `db.permissions.create/get/resolve`, `db.pendingCommands.add/listDue(machine)/remove/expireBefore(ts)`.
  - `hashToken(token: string): string` (sha256 hex).

- [ ] **Step 1: Testes (falham)**

- `loadRelayConfig({})` lança mencionando `DISCORD_TOKEN`; com tudo definido, `allowedUserIds` vira array e `port` número.
- `openDb(":memory:")`: `migrate()` duas vezes não falha; `machines.upsert({ name: "fedora/leonardo", tokenHash: "h" })` + `getByTokenHash("h")` devolve; segundo `upsert` com mesmo `name` e outro `tokenHash` **lança** `MachineExistsError` a menos que `{ force: true }` (Review Focus 2).
- `sessions.upsert` + `setThread` + `get` devolve `thread_id`; `listByMachine` ordena por `updated_at desc`.
- `pendingCommands.add` com `expiresAt` no passado → `expireBefore(now)` remove e devolve a lista removida (para o bot editar as reações).

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/relay && git commit -m "feat(relay): config por ambiente e banco SQLite com migrações e repositórios"
```

---

### Task T11 `[O]`: Relay — TLS autoassinado e servidor WebSocket autenticado

**Files:**
- Create: `apps/relay/src/tls.ts`, `apps/relay/src/ws/server.ts`
- Test: `apps/relay/test/tls.test.ts`, `apps/relay/test/ws-server.test.ts`

**Interfaces:**
- Consumes: `Db`, `hashToken` (T10); `parseLine`, `serialize`, `AgentEvent`, `RelayCommand` (T02).
- Produces:
  - `ensureCert(dataDir: string): { key: string; cert: string; fingerprint256: string }` — se não existir `<dataDir>/tls/relay.key|relay.crt`, gera via `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=global-agents-relay` (child_process; o container terá `openssl`), senão carrega; calcula fingerprint com `new X509Certificate(cert).fingerprint256`.
  - `class AgentHub extends EventEmitter` — `constructor({ db, server: https.Server })`, aceita upgrade em `/ws`, valida `Authorization: Bearer <token>` contra `machines.token_hash` (fecha com 4001 se inválido), associa a conexão ao `machine` (e recusa com 4002 se o `machine` do primeiro envelope não bater com o da máquina do token), mantém no máximo uma conexão por máquina (a nova substitui a antiga), `touch` em `last_seen`. Métodos: `send(machine, cmd: RelayCommand): boolean` (false se offline), `isOnline(machine)`, `onlineMachines()`. Emite `"event"` `(machine, AgentEvent)`, `"online"`/`"offline"` `(machine)`; linha inválida → `"warning"` e ignora.

- [ ] **Step 1: Testes (falham)**

- `ensureCert(tmp)` cria arquivos, devolve fingerprint no formato `AA:BB:…` (95 chars); segunda chamada devolve o mesmo fingerprint.
- `AgentHub` sobre `https.createServer` com o cert gerado, porta 0; cliente `ws` com `rejectUnauthorized: false`: token válido conecta e um `agent.hello` com `machine` certo emite `"event"` e `"online"`; token inválido fecha com código 4001; `machine` divergente fecha com 4002; `send(machine, cmd)` chega no cliente como linha válida; `send("x/y", …)` para máquina offline devolve `false`; segunda conexão da mesma máquina derruba a primeira e `onlineMachines()` tem 1 item.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/relay && git commit -m "feat(relay): certificado autoassinado e hub WebSocket autenticado por token de máquina"
```

---

### Task T12 `[S]`: Relay — fatiamento de texto para o Discord

**Files:**
- Create: `apps/relay/src/discord/chunk.ts`
- Test: `apps/relay/test/chunk.test.ts`

**Interfaces:**
- Produces: `chunkText(text: string, limit = 1900): string[]` — texto vazio ou só espaços → `["(sem texto na resposta)"]` (Review Focus 1); prefere cortar em `\n\n`, depois `\n`, depois espaço, por fim corte duro; nunca quebra dentro de um bloco ``` ``` sem fechar e reabrir o bloco na fatia seguinte (preservando a linguagem: ```` ```ts ````); cada fatia tem `length <= limit`; `n` fatias > 1 recebem sufixo `\n_(parte i/n)_` contado dentro do limite.

- [ ] **Step 1: Testes (falham)**

- `chunkText("")` e `chunkText("  \n")` → `["(sem texto na resposta)"]`.
- texto de 100 chars → uma fatia igual ao texto, sem sufixo.
- 3 parágrafos de 800 chars → 2 fatias cortadas em `\n\n`, ambas `<= 1900`, sufixos `(parte 1/2)` e `(parte 2/2)`.
- bloco ```` ```ts ```` de 3000 chars → a fatia 1 termina com ```` ``` ```` e a fatia 2 começa com ```` ```ts ````.
- palavra única de 5000 chars → corte duro em fatias `<= 1900`.
- propriedade: para 50 textos aleatórios (seed fixo), `join` das fatias sem sufixos e sem cercas reinseridas reconstrói o texto original ignorando espaços de borda.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/relay && git commit -m "feat(relay): fatiamento de respostas para o limite do Discord preservando blocos de código"
```

---

### Task T13 `[O]`: Relay — bot Discord: canais por máquina, threads por sessão, roteamento de eventos

**Files:**
- Create: `apps/relay/src/discord/bot.ts`, `apps/relay/src/discord/threads.ts`, `apps/relay/src/router.ts`
- Test: `apps/relay/test/threads.test.ts`, `apps/relay/test/router.test.ts`

**Interfaces:**
- Consumes: `Db` (T10), `AgentHub` (T11), `chunkText` (T12), eventos (T02).
- Produces:
  - `createBot(cfg): { client: Client; ready: Promise<void> }` com intents `Guilds`, `GuildMessages`, `MessageContent`; login com `cfg.discordToken`.
  - Interface `DiscordPort` (para testar sem rede): `ensureChannel(name, topic): Promise<{ channelId }>`, `createThread(channelId, name, firstMessage): Promise<{ threadId }>`, `renameThread(threadId, name)`, `post(threadOrChannelId, text): Promise<{ messageId }>`, `editChannelTopic(channelId, topic)`. Implementação real `DiscordJsPort(client, guildId, categoryName)` e, nos testes, `FakeDiscordPort` que grava chamadas.
  - `class ThreadRegistry` — `ensureThread(machine, session: { sessionId; name; cwd; bgId?; account? }): Promise<threadId>` (cria com nome `⚪ <name>` e primeira mensagem com cwd, conta e `claude attach <bgId>` quando houver); `setState(threadId, state)` renomeia com emoji `🟢 working | 🟡 waiting | ⚪ done | 🔴 error` **no máximo 1×/30 s por thread** (acumula o último estado e aplica quando a janela abrir); `rename(sessionId, newName)` quando `session.list` traz nome diferente (Review Focus 3: nunca cria segunda thread).
  - `createRouter({ db, port, threads, hub })` que assina `hub.on("event")` e: `agent.hello` → `ensureChannel("#<host>-<user>", topic com SO/versão/conta)` e salva `channel_id`, `claude_account`, `projects`; `session.list` → upsert de sessões, `rename` se mudou, cria threads para sessões novas (**todas**, sem filtro); `session.status` → `setState`; `turn.prompt` `source=terminal` → posta `> 🧑 **prompt:** …` (fatiado); `source=remote` → posta só `💬 via Discord`; `turn.reply` → `chunkText` e posta cada fatia; `agent.warning` → posta `⚠️ …` na thread ou canal; `"offline"` → `editChannelTopic` com `máquina offline desde <hora>`; `"online"` → restaura o tópico.

- [ ] **Step 1: Testes (falham)**

`threads.test.ts` com `FakeDiscordPort` e relógio falso (`vi.useFakeTimers()`): `ensureThread` duas vezes para o mesmo `sessionId` cria uma só thread; `setState` chamado 5 vezes em 1 s gera 1 `renameThread` imediato e 1 após 30 s com o último estado; `rename` muda o nome mantendo o emoji atual.

`router.test.ts`: sequência `agent.hello` → `ensureChannel` chamado com nome `fedora-leonardo` e tópico contendo `2.1.291`; `session.list` com 2 sessões → 2 threads; `turn.prompt` → `post` na thread com `🧑`; `turn.reply` de 4000 chars → 3 `post`s; `turn.reply` vazio → `post("(sem texto na resposta)")`; `session.list` com nome alterado → `renameThread`, não `createThread`; `hub` emite `offline` → `editChannelTopic` contendo `offline`.

- [ ] **Step 2: Implementação e commit**

Observações: `threadAutoArchiveDuration: 10080`; nome da thread truncado a 100 chars; `post` deve aguardar o `Retry-After` do discord.js (o client já faz fila por rota, não implementar fila própria aqui).

```bash
git add apps/relay && git commit -m "feat(relay): bot Discord com canal por máquina, thread por sessão e roteamento de eventos"
```

---

### Task T14 `[O]`: Relay — composição, CLI `machine add`, Dockerfile e integração com agente falso

**Files:**
- Create: `apps/relay/src/main.ts` (substitui o stub), `apps/relay/src/cli.ts`, `deploy/relay/Dockerfile`, `deploy/relay/docker-compose.yml`, `deploy/relay/.env.example`
- Test: `apps/relay/test/integration.test.ts`

**Interfaces:**
- Consumes: T10–T13.
- Produces: `startRelay(cfg, deps?: { port?: DiscordPort })` sobe `ensureCert`, `https` na `cfg.port`, `AgentHub`, bot e router; imprime o fingerprint do certificado no log de subida (o usuário copia para o `global-agents install --fingerprint`). CLI: `relay machine add <hostname/usuario> [--force]` (gera token aleatório de 32 bytes em hex, grava hash, imprime o token uma única vez), `relay machine rm <name>`, `relay machine list`, `relay fingerprint`, `relay backup` (copia o `.db` com `VACUUM INTO` para `<dataDir>/backups/<data>.db`).
- Compose: serviço `relay` (build do Dockerfile, `ports: "8443:8443"`, `volumes: ./data:/data`, `env_file: .env`, `restart: unless-stopped`, `mem_limit: 512m`, `cpus: 0.5`, `logging: json-file max-size 10m max-file 3`). Dockerfile `node:24-alpine` + `apk add openssl`, `pnpm install --frozen-lockfile --prod`, `CMD ["node","apps/relay/dist/main.js"]`.

- [ ] **Step 1: Teste de integração (falha)**

`integration.test.ts`: `startRelay` com `FakeDiscordPort`, porta 0, `dataDir` temporário; `relay machine add fedora/leonardo` via função exportada `addMachine(db, name)` → token; agente falso (cliente `ws`, `rejectUnauthorized: false`, header Bearer) envia `agent.hello`, `session.list` (1 sessão), `turn.prompt`, `turn.reply` → o `FakeDiscordPort` registra `ensureChannel`, `createThread`, 2 `post`s; derruba o agente → `editChannelTopic` com `offline`.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/relay deploy && git commit -m "feat(relay): composição, CLI de máquinas, Dockerfile e compose isolado"
```

---

## Entrega do M1 (checklist manual, Leonardo + coordenador)

1. Na VPS: `mkdir ~/global-agents && cd ~/global-agents`, copiar `deploy/relay/*`, preencher `.env` (token do bot, guild, `ALLOWED_USER_IDS`), `sudo iptables -I INPUT -p tcp --dport 8443 -m state --state NEW -j ACCEPT` + persistir (`netfilter-persistent`), liberar 8443 na security list da Oracle, `docker compose up -d`, `docker compose exec relay node apps/relay/dist/cli.js machine add fedora/leonardo` e `… fingerprint`.
2. Neste PC: `pnpm --filter @global-agents/agent build && node apps/agent/dist/cli.js install --relay wss://163.176.107.229:8443/ws --token <t> --fingerprint <fp> --project ~/dev/work/global-agents`, depois `node apps/agent/dist/cli.js run`.
3. Abrir `claude` em qualquer pasta, mandar um prompt; conferir no Discord o canal `#fedora-leonardo`, a thread, o prompt, o estado e a resposta fatiada.
