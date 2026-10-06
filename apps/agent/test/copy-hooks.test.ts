import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("scripts/copy-hooks.mjs", () => {
  it("recria dist/hooks/scripts a partir de src/hooks/scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "ga-copy-"));
    try {
      mkdirSync(join(root, "src/hooks/scripts"), { recursive: true });
      mkdirSync(join(root, "dist/hooks/scripts"), { recursive: true });
      writeFileSync(join(root, "src/hooks/scripts/a.sh"), "a");
      writeFileSync(join(root, "src/hooks/scripts/b.ps1"), "b");
      writeFileSync(join(root, "dist/hooks/scripts/velho.txt"), "x");
      execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/copy-hooks.mjs", import.meta.url))], { cwd: root });
      expect(readdirSync(join(root, "dist/hooks/scripts")).sort()).toEqual(["a.sh", "b.ps1"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
