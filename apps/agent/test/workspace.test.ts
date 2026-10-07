import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInside, NO_DEV_ROOT_TEXT, NOT_EXISTS_TEXT, resolveWorkspace, type WorkspaceFs } from "../src/projects/workspace.js";

/** Raiz dev temporária real (com `realpath`: o tmp do macOS é symlink) e uma pasta de fora. */
function sandbox(): { base: string; root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ga-ws-")));
  const root = join(base, "dev");
  const outside = join(base, "fora");
  mkdirSync(join(root, "gestai"), { recursive: true });
  mkdirSync(outside);
  return { base, root, outside };
}

const posixOnly = it.skipIf(process.platform === "win32");

describe("resolveWorkspace", () => {
  it("pasta existente dentro da raiz → permitida, sem criar", async () => {
    const { root } = sandbox();
    const r = await resolveWorkspace(join(root, "gestai"), false, { devRoots: [root], projects: [] });
    expect(r).toEqual({ cwd: join(root, "gestai"), root, trustPaths: [join(root, "gestai")], created: false });
  });

  it("a própria raiz conta como permitida", async () => {
    const { root } = sandbox();
    expect((await resolveWorkspace(root, false, { devRoots: [root], projects: [] })).cwd).toBe(root);
  });

  it("relativo resolve contra a primeira raiz", async () => {
    const { root, base } = sandbox();
    const second = join(base, "outra");
    mkdirSync(join(second, "gestai"), { recursive: true });
    expect((await resolveWorkspace("gestai", false, { devRoots: [root, second], projects: [] })).cwd).toBe(join(root, "gestai"));
  });

  it("relativo sem raiz dev → erro pedindo --dev-root", async () => {
    await expect(resolveWorkspace("gestai", false, { devRoots: [], projects: [] })).rejects.toThrow(NO_DEV_ROOT_TEXT);
  });

  it("pasta fora das raízes → negada", async () => {
    const { root, outside } = sandbox();
    await expect(resolveWorkspace(outside, false, { devRoots: [root], projects: [] })).rejects.toThrow(/está fora das pastas dev/);
  });

  it("`..` que sai da raiz → negado (também com create)", async () => {
    const { root } = sandbox();
    await expect(resolveWorkspace("../fora", false, { devRoots: [root], projects: [] })).rejects.toThrow(/fora das pastas dev/);
    await expect(resolveWorkspace("gestai/../../fora/nova", true, { devRoots: [root], projects: [] })).rejects.toThrow(/fora das pastas dev/);
  });

  it("prefixo parecido não conta como dentro (dev-velho não está em dev)", async () => {
    const { root, base } = sandbox();
    mkdirSync(join(base, "dev-velho"));
    await expect(resolveWorkspace(join(base, "dev-velho"), false, { devRoots: [root], projects: [] })).rejects.toThrow(/fora/);
  });

  posixOnly("symlink dentro da raiz apontando para fora → negado, inclusive para criar abaixo dele", async () => {
    const { root, outside } = sandbox();
    symlinkSync(outside, join(root, "atalho"));
    await expect(resolveWorkspace(join(root, "atalho"), false, { devRoots: [root], projects: [] })).rejects.toThrow(/fora das pastas dev/);
    await expect(resolveWorkspace("atalho/novo", true, { devRoots: [root], projects: [] })).rejects.toThrow(/fora das pastas dev/);
    expect(existsSync(join(outside, "novo"))).toBe(false);
  });

  posixOnly("raiz com symlink no caminho → pastas dentro dela continuam permitidas", async () => {
    const { root, base } = sandbox();
    const link = join(base, "atalho-dev");
    symlinkSync(root, link);
    const r = await resolveWorkspace("gestai", false, { devRoots: [link], projects: [] });
    expect(r.cwd).toBe(join(link, "gestai"));
    expect(r.trustPaths).toEqual([join(link, "gestai"), join(root, "gestai")]);
    const novo = await resolveWorkspace("app-novo", true, { devRoots: [link], projects: [] });
    expect(novo.created).toBe(true);
    expect(existsSync(join(root, "app-novo"))).toBe(true);
  });

  it("pasta inexistente sem create → erro claro, nada criado", async () => {
    const { root } = sandbox();
    await expect(resolveWorkspace("work/app-novo", false, { devRoots: [root], projects: [] })).rejects.toThrow(NOT_EXISTS_TEXT);
    expect(existsSync(join(root, "work"))).toBe(false);
  });

  it("pasta inexistente com create → cria recursivo", async () => {
    const { root } = sandbox();
    const r = await resolveWorkspace("work/app-novo", true, { devRoots: [root], projects: [] });
    expect(r).toMatchObject({ cwd: join(root, "work", "app-novo"), root, created: true });
    expect(existsSync(join(root, "work", "app-novo"))).toBe(true);
  });

  it("pasta já existente com create → só usa", async () => {
    const { root } = sandbox();
    const r = await resolveWorkspace("gestai", true, { devRoots: [root], projects: [] });
    expect(r).toMatchObject({ cwd: join(root, "gestai"), created: false });
  });

  it("nome inválido em segmento novo → negado, nada criado", async () => {
    const { root } = sandbox();
    for (const bad of ["-x", ".oculta", "com espaço", "a$b", "work/_x"]) {
      await expect(resolveWorkspace(bad, true, { devRoots: [root], projects: [] })).rejects.toThrow(/nome de pasta inválido/);
    }
    expect(existsSync(join(root, "work"))).toBe(false);
    // segmento já existente não é revalidado (pastas antigas podem ter qualquer nome)
    mkdirSync(join(root, "Pasta Antiga"));
    expect((await resolveWorkspace("Pasta Antiga/nova_1.0", true, { devRoots: [root], projects: [] })).created).toBe(true);
  });

  it("projeto explícito fora das raízes → permitido; inexistente não é criado", async () => {
    const { root, outside, base } = sandbox();
    expect((await resolveWorkspace(outside, false, { devRoots: [root], projects: [outside] })).cwd).toBe(outside);
    expect((await resolveWorkspace(outside, false, { devRoots: [], projects: [outside] })).trustPaths).toEqual([]);
    const ghost = join(base, "sumiu");
    await expect(resolveWorkspace(ghost, true, { devRoots: [root], projects: [ghost] })).rejects.toThrow(NOT_EXISTS_TEXT);
    expect(existsSync(ghost)).toBe(false);
  });

  it("arquivo comum no caminho → não cria por cima", async () => {
    const { root } = sandbox();
    writeFileSync(join(root, "arquivo"), "x");
    await expect(resolveWorkspace("arquivo/nova", true, { devRoots: [root], projects: [] })).rejects.toThrow();
  });
});

/** Disco falso do Windows: pastas existentes (em minúsculas) e `realpath` identidade. */
function winFs(dirs: string[]): WorkspaceFs & { made: string[] } {
  const set = new Set(dirs.map((d) => d.toLowerCase()));
  const made: string[] = [];
  return {
    made,
    exists: (p) => Promise.resolve(set.has(p.toLowerCase())),
    realpath: (p) => (set.has(p.toLowerCase()) ? Promise.resolve(p) : Promise.reject(new Error("ENOENT"))),
    mkdirp: (p) => { made.push(p); set.add(p.toLowerCase()); return Promise.resolve(); },
  };
}

describe("resolveWorkspace no Windows (path.win32 injetado)", () => {
  const W = path.win32;
  const disk = ["C:\\", "C:\\Users", "C:\\Users\\Leo", "C:\\Users\\Leo\\Dev", "C:\\Users\\Leo\\Dev\\Gestai", "C:\\Outro"];

  it("compara sem diferenciar maiúsculas", async () => {
    const fs = winFs(disk);
    const r = await resolveWorkspace("c:\\users\\leo\\dev\\gestai", false, { devRoots: ["C:\\Users\\Leo\\Dev"], projects: [], path: W, fs });
    expect(r.root).toBe("C:\\Users\\Leo\\Dev");
    const rel = await resolveWorkspace("work\\app-novo", true, { devRoots: ["C:\\Users\\Leo\\Dev"], projects: [], path: W, fs });
    expect(rel.cwd).toBe("C:\\Users\\Leo\\Dev\\work\\app-novo");
    expect(fs.made).toEqual(["C:\\Users\\Leo\\Dev\\work\\app-novo"]);
  });

  it("fora da raiz, outro drive e `..` → negados", async () => {
    const fs = winFs([...disk, "D:\\", "D:\\Users\\Leo\\Dev"]);
    const policy = { devRoots: ["C:\\Users\\Leo\\Dev"], projects: [], path: W, fs };
    await expect(resolveWorkspace("C:\\Outro", false, policy)).rejects.toThrow(/fora/);
    await expect(resolveWorkspace("D:\\Users\\Leo\\Dev", false, policy)).rejects.toThrow(/fora/);
    await expect(resolveWorkspace("..\\..\\Outro", false, policy)).rejects.toThrow(/fora/);
  });

  it("projeto explícito casa sem diferenciar maiúsculas", async () => {
    const fs = winFs(disk);
    const r = await resolveWorkspace("c:\\outro", false, { devRoots: [], projects: ["C:\\Outro"], path: W, fs });
    expect(r.cwd).toBe("c:\\outro");
  });
});

describe("isInside", () => {
  it("posix", () => {
    expect(isInside("/a/dev", "/a/dev", path.posix)).toBe(true);
    expect(isInside("/a/dev", "/a/dev/x/y", path.posix)).toBe(true);
    expect(isInside("/a/dev", "/a/dev-velho", path.posix)).toBe(false);
    expect(isInside("/a/dev", "/a", path.posix)).toBe(false);
    expect(isInside("/a/dev", "/a/dev/..x", path.posix)).toBe(true);
  });
  it("win32", () => {
    expect(isInside("C:\\Dev", "c:\\dev\\x", path.win32)).toBe(true);
    expect(isInside("C:\\Dev", "D:\\Dev\\x", path.win32)).toBe(false);
  });
});
