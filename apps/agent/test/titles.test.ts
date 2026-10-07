import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultProjectsDir, parseTitles, projectSlug, SessionNamer, TitleReader, transcriptPathFor,
} from "../src/claude/titles.js";

const custom = (t: string): string => JSON.stringify({ type: "custom-title", customTitle: t, sessionId: "s1" });
const ai = (t: string): string => JSON.stringify({ type: "ai-title", aiTitle: t, sessionId: "s1" });
const msg = (n: number): string => JSON.stringify({ type: "user", message: { role: "user", content: `mensagem ${n} ${"x".repeat(200)}` } });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "titles-")); });
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, lines: string[]): string => {
  const p = join(dir, name);
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
};

describe("projectSlug", () => {
  it("Linux: todo caractere fora de [A-Za-z0-9] vira - (como as pastas reais de ~/.claude/projects)", () => {
    expect(projectSlug("/home/leonardo/dev/work/gestai")).toBe("-home-leonardo-dev-work-gestai");
    expect(projectSlug("/home/leonardo/dev/work/gestai/.claude/worktrees/agent-aff6")).toBe("-home-leonardo-dev-work-gestai--claude-worktrees-agent-aff6");
    expect(projectSlug("/run/media/leonardo/421A73401A733051/DriveD/link-your-biz")).toBe("-run-media-leonardo-421A73401A733051-DriveD-link-your-biz");
  });

  it("Windows: C:\\Users\\… vira C--Users-… (a letra do drive fica como veio)", () => {
    expect(projectSlug("C:\\DriveD\\link-your-biz")).toBe("C--DriveD-link-your-biz");
    expect(projectSlug("c:\\DriveD\\global-pets")).toBe("c--DriveD-global-pets");
    expect(projectSlug("C:\\Users\\Leo\\dev\\gestai_hub")).toBe("C--Users-Leo-dev-gestai-hub");
  });

  it("transcriptPathFor monta <projects>/<slug>/<sessionId>.jsonl", () => {
    expect(transcriptPathFor("/home/x/proj", "s1", "/p")).toBe(join("/p", "-home-x-proj", "s1.jsonl"));
  });

  it("caminho longo (> 200): só a pasta com o mesmo prefixo, se for única", () => {
    const cwd = `/home/x/${"a".repeat(250)}`;
    const prefix = projectSlug(cwd).slice(0, 200);
    expect(transcriptPathFor(cwd, "s1", dir)).toBeUndefined();
    mkdirSync(join(dir, `${prefix}-hash1`));
    expect(transcriptPathFor(cwd, "s1", dir)).toBe(join(dir, `${prefix}-hash1`, "s1.jsonl"));
    mkdirSync(join(dir, `${prefix}-hash2`));
    expect(transcriptPathFor(cwd, "s1", dir)).toBeUndefined();
  });

  it("CLAUDE_CONFIG_DIR muda a pasta dos projetos", () => {
    expect(defaultProjectsDir({}, "/home/leo")).toBe(join("/home/leo", ".claude", "projects"));
    expect(defaultProjectsDir({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/leo")).toBe(join("/cfg", "projects"));
  });
});

describe("TitleReader", () => {
  it("o último custom-title vence o ai-title, mesmo com o ai-title escrito depois", () => {
    const p = file("a.jsonl", [ai("Gestai CRM roadmap"), custom("CRM"), msg(1), custom("CRM-Onda5"), ai("Gestai CRM roadmap")]);
    expect(new TitleReader().read(p)).toEqual({ customTitle: "CRM-Onda5", aiTitle: "Gestai CRM roadmap" });
  });

  it("só ai-title: vale o último", () => {
    const p = file("b.jsonl", [ai("primeiro"), msg(1), ai("CRM integração com GestAI Hub")]);
    expect(new TitleReader().read(p)).toEqual({ aiTitle: "CRM integração com GestAI Hub" });
  });

  it("nenhum dos dois, título vazio e linhas quebradas → {}", () => {
    const p = file("c.jsonl", [msg(1), custom("   "), "{\"type\":\"custom-title\",\"customTi", msg(2)]);
    expect(new TitleReader().read(p)).toEqual({});
  });

  it("arquivo inexistente → {} sem lançar", () => {
    expect(new TitleReader().read(join(dir, "nao-existe.jsonl"))).toEqual({});
  });

  it("arquivo grande: lê só o fim; título fora do trecho não é achado", () => {
    const filler = Array.from({ length: 400 }, (_, i) => msg(i)); // ~100 KB
    const p = file("d.jsonl", [custom("antigo"), ...filler, ai("recente"), ...filler.slice(0, 10)]);
    expect(new TitleReader(16 * 1024).read(p)).toEqual({ aiTitle: "recente" });
    expect(new TitleReader().read(p)).toEqual({ customTitle: "antigo", aiTitle: "recente" });
  });

  it("cache por size e mtime: sem mudança, não relê; com mtime novo, relê", () => {
    const p = file("e.jsonl", [ai("um")]);
    const r = new TitleReader();
    const t0 = new Date(Date.now() - 60_000);
    utimesSync(p, t0, t0);
    expect(r.read(p)).toEqual({ aiTitle: "um" });
    // mesmo tamanho e mesmo mtime: o cache vale (prova de que não releu)
    writeFileSync(p, `${ai("UM")}\n`);
    utimesSync(p, t0, t0);
    expect(r.read(p)).toEqual({ aiTitle: "um" });
    utimesSync(p, t0, new Date());
    expect(r.read(p)).toEqual({ aiTitle: "UM" });
  });

  it("parseTitles ignora linhas que só citam o tipo no texto", () => {
    const quoted = JSON.stringify({ type: "user", message: { content: '{"type":"custom-title","customTitle":"falso"}' } });
    expect(parseTitles(`${quoted}\n${ai("certo")}`)).toEqual({ aiTitle: "certo" });
  });
});

describe("SessionNamer", () => {
  const titles: Record<string, { customTitle?: string; aiTitle?: string }> = {};
  const namer = (): SessionNamer => new SessionNamer({ projectsDir: "/p", readTitles: (p) => titles[p] ?? {} });
  const slugPath = join("/p", "-home-x-proj", "s1.jsonl");

  beforeEach(() => { for (const k of Object.keys(titles)) delete titles[k]; });

  it("prioridade: custom-title > ai-title > nome do inventário > undefined", () => {
    const n = namer();
    expect(n.name("s1", "/home/x/proj", "")).toBeUndefined();
    expect(n.name("s1", "/home/x/proj", "proj-8d")).toBe("proj-8d");
    titles[slugPath] = { aiTitle: "CRM integração" };
    expect(n.name("s1", "/home/x/proj", "proj-8d")).toBe("CRM integração");
    titles[slugPath] = { aiTitle: "CRM integração", customTitle: "CRM-Onda5" };
    expect(n.name("s1", "/home/x/proj", "proj-8d")).toBe("CRM-Onda5");
  });

  it("transcript_path de um hook vale para o session.list da mesma sessão (cwd do hook pode ter mudado)", () => {
    const n = namer();
    titles["/outro/t.jsonl"] = { customTitle: "via-hook" };
    expect(n.name("s1", "/home/x/proj/sub", "proj-8d", "/outro/t.jsonl")).toBe("via-hook");
    n.remember("s1", "/outro/t.jsonl");
    expect(n.enrich([{ sessionId: "s1", name: "proj-8d", cwd: "/home/x/proj", kind: "interactive" }])[0]?.name).toBe("via-hook");
  });

  it("enrich mantém o nome do inventário quando não há título e não copia a sessão sem mudança", () => {
    const s = { sessionId: "s1", name: "proj-8d", cwd: "/home/x/proj", kind: "interactive" as const };
    const out = namer().enrich([s]);
    expect(out[0]).toBe(s);
  });
});
