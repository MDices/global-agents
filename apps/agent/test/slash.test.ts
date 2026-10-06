import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { dialogRegion, isBusyScreen, runSlash, type PtyProcess, type SlashTimeouts, type SpawnPty, type SpawnPtyOptions } from "../src/claude/slash.js";

/** Tempos curtos para os testes (os reais estão em `DEFAULT_TIMEOUTS`). */
const T: Partial<SlashTimeouts> = {
  readyMs: 1000, readyQuietMs: 60, settleMs: 120, ceilingMs: 800, exitMs: 150, typeGapMs: 5, escGapMs: 5, pollMs: 10,
};

const ESC = "\x1b";
const PROMPT_SCREEN =
  `${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[1m ▐▛███▜▌ Claude Code${ESC}[22m v2.1.292\r\n\r\n` +
  `${ESC}[38;2;136;136;136m────────────${ESC}[39m\r\n${ESC}[38;2;255;255;255m❯ ${ESC}[39m\r\n${ESC}[38;2;136;136;136m────────────${ESC}[39m${ESC}[4;3H`;

/** Telas reais do Claude Code 2.1.292 (renderizadas e sanitizadas). */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/slash/${name}.txt`, import.meta.url), "utf8");
const fixtureLines = (name: string): string[] => fixture(name).split("\n");
/** Bytes que desenham a fixture numa tela limpa. */
const draw = (name: string): string => `${ESC}[2J${ESC}[H${fixture(name).split("\n").join("\r\n")}`;

interface Script {
  /** Bytes emitidos logo após o spawn. */
  initial?: string;
  /** Reação a `\r` (o comando digitado). */
  onEnter?: (typed: string, pty: FakePty) => void;
  /** Sai com código 0 ao receber `\x1a` (padrão: sim). */
  exitOnCtrlZ?: boolean;
  /** Sai sozinho logo depois do spawn com este código. */
  exitAtStart?: number;
}

class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  killed = false;
  private typed = "";
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  private timers: NodeJS.Timeout[] = [];
  private exited = false;

  constructor(private readonly script: Script) {
    setTimeout(() => {
      if (script.exitAtStart !== undefined) {
        this.emit("erro: sessão não encontrada\r\n");
        this.exit(script.exitAtStart);
        return;
      }
      this.emit(script.initial ?? PROMPT_SCREEN);
    }, 5);
  }

  onData(cb: (d: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCbs.push(cb); }

  write(data: string): void {
    this.writes.push(data);
    if (data === "\r") {
      const typed = this.typed;
      this.typed = "";
      this.script.onEnter?.(typed, this);
    } else if (data === "\x1a") {
      if (this.script.exitOnCtrlZ ?? true) setTimeout(() => { this.exit(0); }, 5);
    } else if (data !== ESC) {
      this.typed += data;
      this.emit(data); // eco
    }
  }

  kill(): void {
    this.killed = true;
    this.exit(1);
  }

  emit(d: string): void {
    if (!this.exited) for (const cb of this.dataCbs) cb(d);
  }

  /** Emite `d()` a cada `ms` até sair. */
  every(ms: number, d: () => string): void {
    this.timers.push(setInterval(() => { this.emit(d()); }, ms));
  }

  private exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const t of this.timers) clearInterval(t);
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

const usageOutput = (_typed: string, pty: FakePty): void => {
  pty.emit(`\r\n${ESC}[32m  Uso da sessão: 42%${ESC}[0m\r\n  ${ESC}[1mReinicia às 21h${ESC}[0m\r\n`);
};
/** `/usage` real: diálogo de configurações (sem rodapé, com abas). */
const usageDialog = (_typed: string, pty: FakePty): void => { pty.emit(draw("usage")); };

describe("runSlash", () => {
  it("abre claude attach <bgId> num pty 120×40 com env limpo e TERM=xterm-256color", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "pai");
    vi.stubEnv("CLAUDECODE", "1");
    try {
      const f = fake({ onEnter: usageOutput });
      await runSlash({ bgId: "04e54412", command: "usage", claudeBin: "/opt/claude", timeouts: T }, { spawnPty: f.spawnPty });
      expect(f.calls).toHaveLength(1);
      const c = f.calls[0];
      expect(c?.file).toBe("/opt/claude");
      expect(c?.args).toEqual(["attach", "04e54412"]);
      expect(c?.opts.cols).toBe(120);
      expect(c?.opts.rows).toBe(40);
      expect(c?.opts.env["TERM"]).toBe("xterm-256color");
      expect(c?.opts.env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
      expect(c?.opts.env["CLAUDECODE"]).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("saída inline (sem diálogo): escreve /usage\\r e só Ctrl+Z, e devolve a tela sem ANSI", async () => {
    const f = fake({ onEnter: usageOutput });
    const { screen } = await runSlash({ bgId: "04e54412", command: "usage", timeouts: T }, { spawnPty: f.spawnPty });
    const pty = f.ptys[0];
    expect(pty?.writes.join("")).toBe("/usage\r\x1a");
    expect(pty?.killed).toBe(false);
    expect(screen).toContain("Uso da sessão: 42%");
    expect(screen).toContain("Reinicia às 21h");
    expect(screen).toContain("❯ /usage");
    expect(screen).not.toContain("\x1b");
    expect(screen).not.toMatch(/\[\d+m/);
    expect(screen.endsWith("\n")).toBe(false);
    expect(screen.split("\n").at(-1)?.trim()).not.toBe("");
  });

  it("diálogo real do /usage (abas, sem rodapé): escreve /usage\\r, Esc e Ctrl+Z", async () => {
    const f = fake({ initial: draw("idle"), onEnter: usageDialog });
    const { screen } = await runSlash({ bgId: "b1", command: "usage", timeouts: T }, { spawnPty: f.spawnPty });
    expect(f.ptys[0]?.writes.join("")).toBe("/usage\r\x1b\x1a");
    expect(f.ptys[0]?.writes.slice(-2)).toEqual(["\x1b", "\x1a"]);
    expect(screen).toContain("Total cost:");
  });

  it("compact com args escreve /compact foco em testes\\r e, sem diálogo, só Ctrl+Z", async () => {
    const f = fake({ onEnter: (_t, p) => { p.emit("\r\n  ⎿  Compacted\r\n"); } });
    const { screen } = await runSlash({ bgId: "b1", command: "compact", args: "foco em testes", timeouts: T }, { spawnPty: f.spawnPty });
    expect(f.ptys[0]?.writes.join("")).toBe("/compact foco em testes\r\x1a");
    expect(screen).toContain("Compacted");
  });

  it("pty que nunca estabiliza → rejeita com tempo esgotado dentro do teto; sem diálogo, sai só com Ctrl+Z (sem Esc)", async () => {
    let n = 0;
    const f = fake({ onEnter: (_t, p) => { p.every(10, () => `\r\nlinha ${++n}`); } });
    const started = Date.now();
    await expect(runSlash({ bgId: "b1", command: "compact", timeouts: { ...T, ceilingMs: 300 } }, { spawnPty: f.spawnPty }))
      .rejects.toThrow(/tempo esgotado/);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(f.ptys[0]?.writes.at(-1)).toBe("\x1a");
    expect(f.ptys[0]?.writes).not.toContain("\x1b");
  });

  it("sessão ocupada (bytes sem parar) com diálogo aberto: estabiliza pelo texto do diálogo", async () => {
    let n = 0;
    // O transcript (linha 1) é redesenhado o tempo todo; o diálogo, embaixo, fica parado.
    const f = fake({
      initial: PROMPT_SCREEN,
      onEnter: (_t, p) => {
        p.emit(`${ESC}[5;1H${fixture("status").split("\n").slice(1).join("\r\n")}`);
      },
    });
    const run = runSlash({ bgId: "b1", command: "status", timeouts: T }, { spawnPty: f.spawnPty });
    await vi.waitFor(() => { expect(f.ptys).toHaveLength(1); });
    f.ptys[0]?.every(10, () => `${ESC}7${ESC}[1;1H✻ Escrevendo… ${++n}s${ESC}8`);
    const { screen } = await run;
    expect(screen).toMatch(/Version:\s+2\.1\.292/);
    expect(f.ptys[0]?.writes.join("")).toBe("/status\r\x1b\x1a");
  });

  it("pty que não sai depois do Ctrl+Z é morto", async () => {
    const f = fake({ onEnter: usageOutput, exitOnCtrlZ: false });
    const { screen } = await runSlash({ bgId: "b1", command: "usage", timeouts: T }, { spawnPty: f.spawnPty });
    expect(screen).toContain("Uso da sessão");
    expect(f.ptys[0]?.killed).toBe(true);
  });

  it("attach que sai antes de a sessão abrir → rejeita com o código e a última linha", async () => {
    const f = fake({ exitAtStart: 1 });
    await expect(runSlash({ bgId: "b1", command: "usage", timeouts: T }, { spawnPty: f.spawnPty }))
      .rejects.toThrow(/claude attach saiu antes de a sessão abrir \(código 1\).*sessão não encontrada/);
    expect(f.ptys[0]?.writes).toEqual([]);
  });

  it("sem prompt ❯ → tempo esgotado esperando a sessão abrir; nada digitado e sem Esc", async () => {
    const f = fake({ initial: "carregando…" });
    await expect(runSlash({ bgId: "b1", command: "usage", timeouts: { ...T, readyMs: 200 } }, { spawnPty: f.spawnPty }))
      .rejects.toThrow(/tempo esgotado esperando a sessão abrir/);
    expect(f.ptys[0]?.writes).toEqual(["\x1a"]);
  });

  it("compact com spinner de turno na tela → ocupada, nada digitado, só Ctrl+Z", async () => {
    const f = fake({ initial: draw("busy"), onEnter: (_t, p) => { p.emit("Compacted"); } });
    await expect(runSlash({ bgId: "b1", command: "compact", timeouts: T }, { spawnPty: f.spawnPty }))
      .rejects.toThrow("sessão ocupada; tente quando o turno terminar");
    expect(f.ptys[0]?.writes).toEqual(["\x1a"]);
  });

  it("compact com a tela sempre mudando (turno escrevendo, spinner escondido) → ocupada no teto, nada digitado", async () => {
    let n = 0;
    const f = fake({ initial: draw("idle") });
    const run = runSlash({ bgId: "b1", command: "context", timeouts: { ...T, readyMs: 300 } }, { spawnPty: f.spawnPty });
    await vi.waitFor(() => { expect(f.ptys).toHaveLength(1); });
    f.ptys[0]?.every(10, () => `${ESC}7${ESC}[10;1H  linha ${++n} do texto${ESC}8`);
    await expect(run).rejects.toThrow("sessão ocupada; tente quando o turno terminar");
    expect(f.ptys[0]?.writes).toEqual(["\x1a"]);
  });

  it("usage com spinner de turno na tela → roda mesmo assim", async () => {
    const f = fake({ initial: draw("busy"), onEnter: usageDialog });
    const { screen } = await runSlash({ bgId: "b1", command: "usage", timeouts: T }, { spawnPty: f.spawnPty });
    expect(screen).toContain("Settings  Status");
    expect(f.ptys[0]?.writes.join("")).toBe("/usage\r\x1b\x1a");
  });

  it("compact na tela ociosa real: espera o fim da compactação (não captura Compacting…)", async () => {
    const f = fake({
      initial: draw("idle"),
      onEnter: (_t, p) => {
        let k = 0;
        const glyphs = ["✢", "✶", "✻", "✽"];
        const timer = setInterval(() => {
          if (++k <= 30) p.emit(`${ESC}[30;1H${glyphs[k % 4] ?? "*"} Compacting conversation… (${k}s)${ESC}[K`);
          else {
            clearInterval(timer);
            p.emit(`${ESC}[30;1H  ⎿  Compacted (ctrl+o to see full summary)${ESC}[K`);
          }
        }, 10);
      },
    });
    const { screen } = await runSlash({ bgId: "b1", command: "compact", timeouts: T }, { spawnPty: f.spawnPty });
    expect(screen).toContain("Compacted (ctrl+o to see full summary)");
    expect(screen).not.toContain("Compacting");
    expect(f.ptys[0]?.writes.join("")).toBe("/compact\r\x1a");
  });

  it("spawn que lança → rejeita com a mensagem", async () => {
    const spawnPty: SpawnPty = () => { throw new Error("posix_spawnp failed"); };
    await expect(runSlash({ bgId: "b1", command: "usage", timeouts: T }, { spawnPty })).rejects.toThrow(/posix_spawnp failed/);
  });

  it("tela longa: só as últimas 60 linhas, sem linhas vazias no fim", async () => {
    const lines = Array.from({ length: 100 }, (_v, i) => `item ${i + 1}`).join("\r\n");
    const f = fake({ initial: `❯ \r\n`, onEnter: (_t, p) => { p.emit(`\r\n${lines}\r\n\r\n\r\n`); } });
    const { screen } = await runSlash({ bgId: "b1", command: "context", timeouts: T }, { spawnPty: f.spawnPty });
    const out = screen.split("\n");
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.at(-1)).toBe("item 100");
  });
});

describe("detecção nas telas reais (2.1.292)", () => {
  it("tela ociosa: sem diálogo, sem turno", () => {
    expect(dialogRegion(fixtureLines("idle"))).toBeUndefined();
    expect(isBusyScreen(fixtureLines("idle"))).toBe(false);
  });
  it.each(["status", "usage", "hooks", "model"])("/%s: diálogo visível, sem turno", (name) => {
    const region = dialogRegion(fixtureLines(name));
    expect(region).toBeDefined();
    expect(region?.split("\n")[0]).toMatch(/^▔{8,}/);
    expect(isBusyScreen(fixtureLines(name))).toBe(false);
  });
  it("borda ▔ sem rodapé nem abas não conta como diálogo", () => {
    expect(dialogRegion(["texto", "▔".repeat(40) + " ◐ medium · /effort ▔", "❯ "])).toBeUndefined();
  });
  it("turno em andamento: spinner na tela", () => {
    expect(isBusyScreen(fixtureLines("busy"))).toBe(true);
    expect(isBusyScreen(["* Actioning… (12s · still thinking with medium effort)"])).toBe(true);
    expect(isBusyScreen(["  esc to interrupt"])).toBe(true);
    expect(isBusyScreen(["✻ Worked for 4s · done 18:36"])).toBe(false);
  });
});
