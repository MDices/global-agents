import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultProjectsDir, isAutoName, parseTitles, projectSlug, SessionNamer, TitleReader, transcriptPathFor,
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

describe("isAutoName", () => {
  it("<pasta>-<2 hex> é automático (formato real de claude agents --json); o resto não", () => {
    expect(isAutoName("gestai-8d", "/home/leonardo/dev/work/gestai")).toBe(true);
    expect(isAutoName("global-agents-23", "/home/leonardo/dev/work/global-agents")).toBe(true);
    expect(isAutoName("gestai-hub-86", "C:\\Users\\Leo\\dev\\gestai-hub")).toBe(true);
    expect(isAutoName("CRM-Onda5", "/home/leonardo/dev/work/gestai")).toBe(false);
    expect(isAutoName("gestai", "/home/leonardo/dev/work/gestai")).toBe(false);
    expect(isAutoName("gestai-8dx", "/home/leonardo/dev/work/gestai")).toBe(false);
    expect(isAutoName("gestai-zz", "/home/leonardo/dev/work/gestai")).toBe(false);
    expect(isAutoName("outra-8d", "/home/leonardo/dev/work/gestai")).toBe(false);
  });
});

describe("SessionNamer", () => {
  const cwd = "/home/x/proj";
  let projects: string;
  let tpath: string;
  beforeEach(() => {
    projects = join(dir, "projects");
    mkdirSync(join(projects, "-home-x-proj"), { recursive: true });
    tpath = join(projects, "-home-x-proj", "s1.jsonl");
  });
  const write = (lines: string[]): void => { writeFileSync(tpath, `${lines.join("\n")}\n`); };
  const namer = (now?: () => number): SessionNamer => new SessionNamer({ projectsDir: projects, ...(now !== undefined ? { now } : {}) });
  const row = (name: string, extra: Partial<{ cwd: string }> = {}) => ({ sessionId: "s1", name, cwd, kind: "interactive" as const, ...extra });

  it("prioridade: custom-title > nome não automático do inventário > ai-title > nome automático > undefined", () => {
    const n = namer();
    expect(n.name("s1", cwd, "")).toBeUndefined();
    expect(n.name("s1", cwd, "proj-8d")).toBe("proj-8d");
    write([ai("CRM integração")]);
    expect(n.name("s1", cwd, "proj-8d")).toBe("CRM integração"); // automático perde para o ai-title
    expect(n.name("s1", cwd, "CRM-Onda5")).toBe("CRM-Onda5"); // /rename só no inventário vence o ai-title
    write([ai("CRM integração"), custom("Onda6")]);
    expect(n.name("s1", cwd, "CRM-Onda5")).toBe("Onda6");
  });

  it("/rename fora da janela lida: o inventário (não automático) segura o nome em vez do ai-title", () => {
    const filler = Array.from({ length: 2000 }, (_, i) => msg(i)); // ~450 KB, empurra o custom-title para fora
    write([custom("CRM-Onda5"), ...filler, ai("Gestai CRM roadmap")]);
    const [s] = namer().enrich([row("CRM-Onda5")]);
    expect(s?.name).toBe("CRM-Onda5");
  });

  it("enrich: o mesmo nome no session.list e no hook, mesmo com o inventário já enriquecido", () => {
    write([ai("CRM integração")]);
    const n = namer();
    const [s] = n.enrich([row("proj-8d")]);
    expect(s?.name).toBe("CRM integração");
    // o hook recebe o nome já enriquecido do inventário; o nome cru guardado pelo enrich é o que vale
    write([ai("CRM integração v2")]);
    expect(n.name("s1", cwd, s?.name, tpath)).toBe("CRM integração v2");
  });

  it("transcript_path de um hook vale para o session.list da mesma sessão (cwd do hook pode ter mudado)", () => {
    const other = join(dir, "t.jsonl");
    writeFileSync(other, `${custom("via-hook")}\n`);
    const n = namer();
    expect(n.name("s1", "/home/x/proj/sub", "proj-8d", other)).toBe("via-hook");
    n.remember("s1", other);
    expect(n.enrich([row("proj-8d")])[0]?.name).toBe("via-hook");
  });

  it("agente reiniciado, cwd do inventário diferente da pasta do transcript: acha <sessionId>.jsonl em projects", () => {
    mkdirSync(join(projects, "-home-x-outra"), { recursive: true });
    writeFileSync(join(projects, "-home-x-outra", "s1.jsonl"), `${ai("achado pelo id")}\n`);
    const n = namer();
    expect(n.enrich([row("proj-8d")])[0]?.name).toBe("achado pelo id");
  });

  it("sessão sem transcript: procura de novo só depois de 1 min", () => {
    let t = 0;
    const n = namer(() => t);
    const other = join(projects, "-home-x-outra");
    expect(n.enrich([row("proj-8d")])[0]?.name).toBe("proj-8d");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "s1.jsonl"), `${ai("apareceu")}\n`);
    t = 30_000;
    expect(n.enrich([row("proj-8d")])[0]?.name).toBe("proj-8d");
    t = 61_000;
    expect(n.enrich([row("proj-8d")])[0]?.name).toBe("apareceu");
  });

  it("enrich mantém a mesma sessão quando o nome não muda", () => {
    const s = row("proj-8d");
    expect(namer().enrich([s])[0]).toBe(s);
  });
});

describe("TitleReader LRU", () => {
  it("o acerto renova a posição: a entrada consultada sobrevive a 500 inserções", () => {
    const r = new TitleReader();
    const hot = file("hot.jsonl", [ai("quente")]);
    const t0 = new Date(Date.now() - 60_000);
    utimesSync(hot, t0, t0);
    r.read(hot);
    for (let i = 0; i < 499; i++) r.read(join(dir, `nao-existe-${i}.jsonl`)); // erro: não entra no cache
    const paths = Array.from({ length: 499 }, (_, i) => file(`f${i}.jsonl`, [ai(String(i))]));
    for (const [i, p] of paths.entries()) {
      r.read(p);
      if (i % 50 === 0) r.read(hot);
    }
    r.read(file("extra.jsonl", [ai("x")])); // estoura 500: sai a menos recente, não a quente
    writeFileSync(hot, `${ai("QUENTE")}\n`);
    utimesSync(hot, t0, t0);
    expect(r.read(hot)).toEqual({ aiTitle: "quente" });
  });
});
