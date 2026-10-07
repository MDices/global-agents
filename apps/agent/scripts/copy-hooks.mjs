// Copia src/hooks/scripts para dist/hooks/scripts (multiplataforma; substitui `rm -rf && cp -r`).
// Resolve relativo ao cwd (o pnpm roda o postbuild na raiz do pacote).
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist/hooks/scripts", { recursive: true, force: true });
mkdirSync("dist/hooks", { recursive: true });
cpSync("src/hooks/scripts", "dist/hooks/scripts", { recursive: true });
