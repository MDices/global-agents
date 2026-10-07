import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeStatePath, grantTrust as grant, trustKeys } from "../src/claude/trust.js";

/** Plataforma fixa em linux para o formato das chaves não depender de onde o teste roda. */
const grantTrust = (paths: string[], file: string, over: Parameters<typeof grant>[1] = {}) => grant(paths, { file, platform: "linux", ...over });

function stateFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ga-trust-"));
  const p = join(dir, ".claude.json");
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

describe("grantTrust", () => {
  it("marca as pastas, mantém os outros campos e entradas, e não deixa temporário", async () => {
    const original = { numStartups: 7, oauthAccount: { emailAddress: "a@b.c" }, projects: {
      "/d/velho": { allowedTools: ["Bash"], hasTrustDialogAccepted: false, lastCost: 1 },
      "/d/outro": { hasTrustDialogAccepted: true },
    } };
    const p = stateFile(JSON.stringify(original, null, 2));
    expect(await grantTrust(["/d/velho", "/d/novo"], p)).toBe(true);
    const after = JSON.parse(readFileSync(p, "utf8")) as typeof original & { projects: Record<string, unknown> };
    expect(after.numStartups).toBe(7);
    expect(after.oauthAccount).toEqual({ emailAddress: "a@b.c" });
    expect(after.projects["/d/velho"]).toEqual({ allowedTools: ["Bash"], hasTrustDialogAccepted: true, lastCost: 1 });
    expect(after.projects["/d/outro"]).toEqual({ hasTrustDialogAccepted: true });
    expect(after.projects["/d/novo"]).toEqual({ hasTrustDialogAccepted: true });
    expect(readdirSync(join(p, ".."))).toEqual([".claude.json"]);
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, "utf8").endsWith("}")).toBe(true); // sem quebra de linha final, como o original
  });

  it("já confiável → true sem regravar o arquivo", async () => {
    const content = JSON.stringify({ projects: { "/d/a": { hasTrustDialogAccepted: true } } }, null, 2) + "\n";
    const p = stateFile(content);
    const before = statSync(p).mtimeMs;
    expect(await grantTrust(["/d/a"], p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(content);
    expect(statSync(p).mtimeMs).toBe(before);
  });

  it("arquivo ausente, JSON quebrado ou não-objeto → false e nada gravado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-trust-"));
    expect(await grantTrust(["/d/a"], join(dir, ".claude.json"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    const broken = stateFile("{ quebrado");
    expect(await grantTrust(["/d/a"], broken)).toBe(false);
    expect(readFileSync(broken, "utf8")).toBe("{ quebrado");
    expect(await grantTrust(["/d/a"], stateFile("[]"))).toBe(false);
  });

  it("projects ausente vira objeto novo", async () => {
    const p = stateFile("{\"x\":1}\n");
    expect(await grantTrust(["/d/a"], p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ x: 1, projects: { "/d/a": { hasTrustDialogAccepted: true } } });
    expect(readFileSync(p, "utf8").endsWith("}\n")).toBe(true);
  });
});

describe("claudeStatePath", () => {
  it("usa CLAUDE_CONFIG_DIR quando definido, senão ~/.claude.json", () => {
    expect(claudeStatePath({}, "/home/u")).toBe(join("/home/u", ".claude.json"));
    expect(claudeStatePath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u")).toBe(join("/cfg", ".claude.json"));
    expect(claudeStatePath({ CLAUDE_CONFIG_DIR: "" }, "/home/u")).toBe(join("/home/u", ".claude.json"));
  });
});

describe("trustKeys", () => {
  it("Windows: barra normal e drive maiúsculo, como o Claude Code lê (C:\\Dev\\app → C:/Dev/app)", () => {
    expect(trustKeys(["C:\\Dev\\app"], "win32")).toEqual(["C:/Dev/app"]);
    expect(trustKeys(["c:\\Users\\Leo\\dev\\x", "C:\\Users\\Leo\\dev\\x"], "win32")).toEqual(["C:/Users/Leo/dev/x"]);
  });
  it("Linux/macOS: chave igual ao caminho", () => {
    expect(trustKeys(["/home/u/dev/app"], "linux")).toEqual(["/home/u/dev/app"]);
    expect(trustKeys(["/Users/u/dev/app"], "darwin")).toEqual(["/Users/u/dev/app"]);
  });
  it("acrescenta a forma NFC quando o caminho vem em NFD", () => {
    const nfd = "/home/u/dev/ac\u0327a\u0303o";
    expect(trustKeys([nfd], "linux")).toEqual([nfd, "/home/u/dev/ação"]);
  });
});

describe("grantTrust: trava, symlink e escrita concorrente", () => {
  it("Windows grava a chave com /", async () => {
    const p = stateFile("{}");
    expect(await grant(["C:\\Dev\\app"], { file: p, platform: "win32" })).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ projects: { "C:/Dev/app": { hasTrustDialogAccepted: true } } });
  });

  it("trava do Claude Code ocupada além do prazo → false, nada gravado, trava alheia mantida", async () => {
    const p = stateFile("{}");
    mkdirSync(`${p}.lock`);
    expect(await grantTrust(["/d/a"], p, { lockWaitMs: 120 })).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("{}");
    expect(lstatSync(`${p}.lock`).isDirectory()).toBe(true);
  });

  it("alguém grava no meio (sem respeitar a trava) → refaz a mescla uma vez e mantém a gravação dele", async () => {
    const p = stateFile(JSON.stringify({ numStartups: 1 }));
    let calls = 0;
    const ok = await grantTrust(["/d/a"], p, {
      beforeRename: () => {
        calls++;
        if (calls === 1) writeFileSync(p, JSON.stringify({ numStartups: 2 }));
        return Promise.resolve();
      },
    });
    expect(ok).toBe(true);
    expect(calls).toBe(2);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ numStartups: 2, projects: { "/d/a": { hasTrustDialogAccepted: true } } });
  });

  it("muda de novo na segunda tentativa → false, sem sobrescrever a gravação alheia", async () => {
    const p = stateFile(JSON.stringify({ n: 0 }));
    let n = 0;
    const ok = await grantTrust(["/d/a"], p, { beforeRename: () => { writeFileSync(p, JSON.stringify({ n: ++n })); return Promise.resolve(); } });
    expect(ok).toBe(false);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ n: 2 });
    expect(readdirSync(join(p, ".."))).toEqual([".claude.json"]);
  });

  it("pega e solta a trava (não sobra <arquivo>.lock)", async () => {
    const p = stateFile("{}");
    expect(await grantTrust(["/d/a"], p)).toBe(true);
    expect(readdirSync(join(p, ".."))).toEqual([".claude.json"]);
  });

  it.skipIf(process.platform === "win32")("arquivo symlink (dotfiles): escreve no alvo e mantém o link", async () => {
    const target = stateFile("{\"x\":1}");
    const dir = mkdtempSync(join(tmpdir(), "ga-trust-link-"));
    const link = join(dir, ".claude.json");
    symlinkSync(target, link);
    expect(await grantTrust(["/d/a"], link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ x: 1, projects: { "/d/a": { hasTrustDialogAccepted: true } } });
  });
});
