import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProjects } from "../src/projects/discover.js";

function tree(dirs: string[]): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ga-disc-")));
  for (const d of dirs) mkdirSync(join(base, d), { recursive: true });
  return base;
}

describe("discoverProjects", () => {
  it("1º nível sempre; 2º nível só repositórios git; nada no 3º", async () => {
    const root = tree(["gestai/.git", "gestai/src", "work/app/.git", "work/notas", "work/fundo/repo/.git", "pessoal"]);
    writeFileSync(join(root, "work", "worktree-arquivo"), "");
    mkdirSync(join(root, "work", "wt"));
    writeFileSync(join(root, "work", "wt", ".git"), "gitdir: /x"); // worktree: .git é arquivo
    expect(await discoverProjects([root])).toEqual([
      join(root, "gestai"), join(root, "pessoal"), join(root, "work"), join(root, "work", "app"), join(root, "work", "wt"),
    ]);
  });

  it("ignora ocultas e node_modules/dist/etc., nos dois níveis", async () => {
    const root = tree([".cache", "node_modules/pkg/.git", "dist", "app/.git", "work/.oculto/.git", "work/node_modules/.git", "work/vendor/.git"]);
    expect(await discoverProjects([root])).toEqual([join(root, "app"), join(root, "work")]);
  });

  it.skipIf(process.platform === "win32")("não segue symlinks (nem no 1º nem no 2º nível)", async () => {
    const root = tree(["real"]);
    const fora = tree(["repo/.git", "x"]);
    symlinkSync(fora, join(root, "atalho"));
    symlinkSync(join(fora, "repo"), join(root, "real", "repo-link"));
    expect(await discoverProjects([root])).toEqual([join(root, "real")]);
  });

  it("para no limite", async () => {
    const root = tree(Array.from({ length: 10 }, (_, i) => `p${i}/r/.git`));
    const r = await discoverProjects([root], { limit: 5 });
    expect(r).toHaveLength(5);
    expect(r).toEqual([join(root, "p0"), join(root, "p0", "r"), join(root, "p1"), join(root, "p1", "r"), join(root, "p2")]);
  });

  it("várias raízes em ordem; raiz inexistente é ignorada; sem repetição", async () => {
    const a = tree(["x"]);
    const b = tree(["y"]);
    expect(await discoverProjects([a, join(a, "nao-existe"), b, a])).toEqual([join(a, "x"), join(b, "y")]);
  });
});
