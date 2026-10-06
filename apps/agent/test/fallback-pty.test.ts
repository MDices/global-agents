import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runClaude } from "../src/claude/exec.js";
import { parsePtyOutput, resumeViaPty } from "../src/claude/fallback-pty.js";
import { Inventory } from "../src/claude/inventory.js";
import { loadSpawnPty, type PtyProcess, type SpawnPty, type SpawnPtyOptions } from "../src/claude/pty.js";
import { spawnSession } from "../src/claude/spawn.js";
import { stopSession } from "../src/claude/stop.js";
import { assistantSaid, transcriptPath, until } from "./helpers/transcript.js";

const E2E = process.env["GLOBAL_AGENTS_E2E"] === "1";

const ESC = "\x1b";
const ID = "a1b2c3d4";
/** Tela do Claude Code anexado: entra na tela alternativa e mostra a caixa de input. */
const ATTACHED =
  `${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[1m ▐▛███▜▌ Claude Code${ESC}[22m v2.1.292\r\n\r\n` +
  `${ESC}[38;2;136;136;136m────────────${ESC}[39m\r\n${ESC}[38;2;255;255;255m❯ ${ESC}[39m\r\n${ESC}[38;2;136;136;136m────────────${ESC}[39m`;
const SENT = `${ESC}[2mSent your prompt to the ${ESC}[1mbackground session${ESC}[22m (${ID}); opening it…${ESC}[0m\r\n`;
const NOT_SENT =
  `${ESC}[33mThat session is running in the background (${ID}). ${ESC}[1mYour prompt was not sent${ESC}[22m to it: ` +
  `it is waiting for an answer to a question.${ESC}[0m Opening it…\r\n`;
const NO_TTY = `That session is running in the background (${ID}). Run \`claude attach ${ID}\` to open it.\r\n`;

/** Bytes reais do `claude --resume` 2.1.292 num pty (capturados no e2e, caminho e plano trocados). */
const real = (name: string): string => JSON.parse(readFileSync(new URL(`./fixtures/fallback/${name}.json`, import.meta.url), "utf8")) as string;

/** Tempos curtos para os testes. */
const FAST = { timeoutMs: 1000, attachMs: 100, exitMs: 150, pollMs: 10 };

interface Script {
  /** Bytes emitidos logo após o spawn. */
  output?: string;
  /** Sai com este código logo depois de emitir `output`. */
  exitAfter?: number;
  /** Sai com código 0 ao receber `\x1a` (padrão: sim). */
  exitOnCtrlZ?: boolean;
}

class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  killed = false;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  private exited = false;

  constructor(private readonly script: Script) {
    setTimeout(() => {
      if (script.output !== undefined) this.emit(script.output);
      if (script.exitAfter !== undefined) this.exit(script.exitAfter);
    }, 5);
  }

  onData(cb: (d: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCbs.push(cb); }

  write(data: string): void {
    this.writes.push(data);
    if (data === "\x1a" && (this.script.exitOnCtrlZ ?? true)) setTimeout(() => { this.exit(0); }, 5);
  }

  kill(): void {
    this.killed = true;
    this.exit(1);
  }

  emit(d: string): void {
    if (!this.exited) for (const cb of this.dataCbs) cb(d);
  }

  private exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
}

function fake(script: Script): { spawnPty: SpawnPty; ptys: FakePty[]; calls: { file: string; args: string[]; opts: SpawnPtyOptions }[] } {
  const ptys: FakePty[] = [];
  const calls: { file: string; args: string[]; opts: SpawnPtyOptions }[] = [];
  const spawnPty: SpawnPty = (file, args, opts) => {
    calls.push({ file, args, opts });
    const p = new FakePty(script);
    ptys.push(p);
    return p;
  };
  return { spawnPty, ptys, calls };
}

describe("parsePtyOutput", () => {
  it("sem nenhuma das frases → undefined", () => {
    expect(parsePtyOutput("")).toBeUndefined();
    expect(parsePtyOutput(" ▐▛███▜▌ Claude Code v2.1.292\n❯ ")).toBeUndefined();
  });

  it("Sent your prompt to the background session → sent", () => {
    expect(parsePtyOutput(`Sent your prompt to the background session (${ID}); opening it…`)).toEqual({ kind: "sent" });
  });

  it("Your prompt was not sent to it: <motivo>. → refused só com o motivo (quebras de linha juntadas)", () => {
    const text = `outra coisa\n\nThat session is running in the background (${ID}). Your prompt was not sent\nto it: it starts with /. Run \`claude attach\`.\n\n❯ `;
    expect(parsePtyOutput(text)).toEqual({ kind: "refused", reason: "it starts with /." });
  });

  it("Your prompt was not sent sem motivo reconhecível → o parágrafo inteiro", () => {
    const text = `outra coisa\n\nThat session is busy (${ID}).\nYour prompt was not sent.\n\n❯ `;
    expect(parsePtyOutput(text)).toEqual({ kind: "refused", reason: `That session is busy (${ID}). Your prompt was not sent.` });
  });

  it("running in the background sem TTY (e not running…) → refused", () => {
    expect(parsePtyOutput(`That session is running in the background (${ID}). Run \`claude attach ${ID}\` …`)).toMatchObject({ kind: "refused" });
    expect(parsePtyOutput("That session is not running in the background.")).toEqual({
      kind: "refused", reason: "That session is not running in the background.",
    });
  });

  it("sucesso tem prioridade sobre a frase de sessão em background", () => {
    const text = `That session is running in the background (${ID}).\nSent your prompt to the background session (${ID}); opening it…`;
    expect(parsePtyOutput(text)).toEqual({ kind: "sent" });
  });
});

describe("resumeViaPty", () => {
  it("abre claude --resume <id> -- <texto> num pty com env limpo e TERM=xterm-256color", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "pai");
    vi.stubEnv("CLAUDECODE", "1");
    try {
      const f = fake({ output: SENT + ATTACHED });
      await resumeViaPty({ sessionId: "s-1", text: "-p oi", claudeBin: "/opt/claude", ...FAST }, { spawnPty: f.spawnPty });
      const c = f.calls[0];
      expect(c?.file).toBe("/opt/claude");
      expect(c?.args).toEqual(["--resume", "s-1", "--", "-p oi"]);
      expect(c?.opts.env["TERM"]).toBe("xterm-256color");
      expect(c?.opts.env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
      expect(c?.opts.env["CLAUDECODE"]).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sucesso seguido da tela alternativa do attach: resolve, manda só Ctrl+Z (nunca Esc) e não mata", async () => {
    const f = fake({ output: SENT + ATTACHED });
    await expect(resumeViaPty({ sessionId: "s-1", text: "oi", ...FAST }, { spawnPty: f.spawnPty })).resolves.toBeUndefined();
    expect(f.calls[0]?.file).toBe("claude");
    expect(f.ptys[0]?.writes).toEqual(["\x1a"]);
    expect(f.ptys[0]?.killed).toBe(false);
  });

  it("saída real de sucesso (Sending… → Sent… → tela alternativa do attach): resolve e desanexa com Ctrl+Z", async () => {
    const f = fake({ output: real("sent") });
    await resumeViaPty({ sessionId: "s-1", text: "oi", ...FAST }, { spawnPty: f.spawnPty });
    expect(f.ptys[0]?.writes).toEqual(["\x1a"]);
    expect(f.ptys[0]?.killed).toBe(false);
  });

  it("saída real de recusa de prompt com / (sai sozinho) → motivo curto, sem escrever nada", async () => {
    const f = fake({ output: real("refused"), exitAfter: 1 });
    await expect(resumeViaPty({ sessionId: "s-1", text: "/cost", ...FAST }, { spawnPty: f.spawnPty })).rejects.toThrow(
      /^o Claude recusou o prompt: a prompt starting with \/ would run as a command there\.$/,
    );
    expect(f.ptys[0]?.writes).toEqual([]);
  });

  it("Ctrl+Z só depois de o attach desenhar a caixa de input (antes ele seria só um ^Z ecoado)", async () => {
    const f = fake({ output: SENT });
    const run = resumeViaPty({ sessionId: "s-1", text: "oi", ...FAST, attachMs: 2000 }, { spawnPty: f.spawnPty });
    await new Promise((r) => setTimeout(r, 150));
    expect(f.ptys[0]?.writes).toEqual([]);
    f.ptys[0]?.emit(ATTACHED);
    await run;
    expect(f.ptys[0]?.writes).toEqual(["\x1a"]);
  });

  it("prompt recusado → rejeita com o motivo traduzido e ainda desanexa com Ctrl+Z", async () => {
    const f = fake({ output: NOT_SENT + ATTACHED });
    await expect(resumeViaPty({ sessionId: "s-1", text: "/compact", ...FAST }, { spawnPty: f.spawnPty })).rejects.toThrow(
      "o Claude recusou o prompt: it is waiting for an answer to a question.",
    );
    expect(f.ptys[0]?.writes).toEqual(["\x1a"]);
    expect(f.ptys[0]?.writes).not.toContain("\x1b");
  });

  it("sem TTY (sai com 1 e a frase de background) → recusa traduzida, sem escrever nada", async () => {
    const f = fake({ output: NO_TTY, exitAfter: 1 });
    await expect(resumeViaPty({ sessionId: "s-1", text: "oi", ...FAST }, { spawnPty: f.spawnPty })).rejects.toThrow(
      /^o Claude recusou o prompt: That session is running in the background/,
    );
    expect(f.ptys[0]?.writes).toEqual([]);
  });

  it("sai antes de qualquer frase → rejeita com o código e a última linha", async () => {
    const f = fake({ output: "error: session not found\r\n", exitAfter: 2 });
    await expect(resumeViaPty({ sessionId: "s-1", text: "oi", ...FAST }, { spawnPty: f.spawnPty })).rejects.toThrow(
      "claude --resume saiu sem confirmar o envio (código 2): error: session not found",
    );
  });

  it("nenhuma frase dentro do prazo → tempo esgotado; Ctrl+Z e, se não sair, kill", async () => {
    const f = fake({ output: ATTACHED, exitOnCtrlZ: false });
    const started = Date.now();
    await expect(resumeViaPty({ sessionId: "s-1", text: "oi", ...FAST, timeoutMs: 200 }, { spawnPty: f.spawnPty })).rejects.toThrow(
      "tempo esgotado esperando o claude --resume confirmar o envio (0.2 s)",
    );
    expect(Date.now() - started).toBeLessThan(1500);
    expect(f.ptys[0]?.writes).toEqual(["\x1a"]);
    expect(f.ptys[0]?.killed).toBe(true);
  });

  it("pty que não sai depois do Ctrl+Z é morto, mesmo no sucesso", async () => {
    const f = fake({ output: SENT, exitOnCtrlZ: false });
    await resumeViaPty({ sessionId: "s-1", text: "oi", ...FAST }, { spawnPty: f.spawnPty });
    expect(f.ptys[0]?.killed).toBe(true);
  });

  it("node-pty que não carrega → fallback indisponível", async () => {
    const loadSpawnPty = (): Promise<SpawnPty> => Promise.reject(new Error("Cannot find module 'node-pty'"));
    await expect(resumeViaPty({ sessionId: "s-1", text: "oi", ...FAST }, { loadSpawnPty })).rejects.toThrow(
      "fallback indisponível (node-pty não carregou)",
    );
  });

  it("spawn que lança (binário ausente) → rejeita com a mensagem", async () => {
    const spawnPty: SpawnPty = () => { throw new Error("File not found: /nada/claude"); };
    await expect(resumeViaPty({ sessionId: "s-1", text: "oi", claudeBin: "/nada/claude", ...FAST }, { spawnPty })).rejects.toThrow(
      "File not found: /nada/claude",
    );
  });
});

describe.skipIf(!E2E)("e2e: fallback por pty numa sessão claude --bg real", () => {
  it("resumeViaPty entrega o prompt (CHARLIE no transcript), recusa /cost e a sessão continua viva", { timeout: 300_000 }, async () => {
    const inventory = new Inventory({ pollMs: 1000 });
    inventory.start();
    const root = new URL("../../..", import.meta.url).pathname;
    const realSpawn = await loadSpawnPty();
    /** Quantas vezes o pty precisou ser morto (o Ctrl+Z deveria bastar). */
    let killed = 0;
    /** Grava os bytes do pty para imprimir com GLOBAL_AGENTS_E2E_PRINT=1 (fixtures de saída real). */
    let raw = "";
    const spawnPty: SpawnPty = (file, args, opts) => {
      raw = "";
      const p = realSpawn(file, args, opts);
      p.onData((d) => { raw += d; });
      return {
        onData: (cb) => p.onData(cb),
        onExit: (cb) => p.onExit(cb),
        write: (d) => { p.write(d); },
        kill: (sig) => {
          killed++;
          p.kill(sig);
        },
      };
    };
    const print = (label: string): void => {
      if (process.env["GLOBAL_AGENTS_E2E_PRINT"] === "1") console.log(`--- ${label} ---\n${JSON.stringify(raw)}`);
    };
    let bgId: string | undefined;
    try {
      const r = await spawnSession(
        { cwd: root, name: "ga-fallback-e2e", prompt: "Responda apenas OK.", permissionMode: "plan" },
        { run: runClaude, inventory },
      );
      bgId = r.bgId;
      const id = bgId;
      await inventory.waitFor((s) => s.bgId === id && s.status === "idle", 90_000);

      await resumeViaPty({ sessionId: r.sessionId, text: "Responda apenas a palavra CHARLIE." }, { spawnPty });
      print("enviado");
      expect(killed).toBe(0);
      await until(() => {
        const p = transcriptPath(r.sessionId);
        return p !== undefined && assistantSaid(p, "CHARLIE") ? true : undefined;
      }, 90_000, "resposta CHARLIE no transcript");

      await new Promise((res) => setTimeout(res, 2_500)); // deixa o inventário (poll de 1 s) ver o turno terminar
      await inventory.waitFor((s) => s.bgId === id && s.status === "idle", 60_000);
      await expect(resumeViaPty({ sessionId: r.sessionId, text: "/cost" }, { spawnPty })).rejects.toThrow(/^o Claude recusou o prompt: .*\//);
      print("recusado");

      // Ctrl+Z desanexou sem parar a sessão: ela continua no inventário.
      await new Promise((res) => setTimeout(res, 2_500));
      await inventory.waitFor((s) => s.bgId === id, 5_000);
    } finally {
      inventory.stop();
      if (bgId !== undefined) {
        await stopSession(bgId, { run: runClaude });
        await runClaude(["rm", bgId]);
      }
    }
  });
});
