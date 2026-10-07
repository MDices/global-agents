import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeStatePath, grantTrust } from "../src/claude/trust.js";

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
