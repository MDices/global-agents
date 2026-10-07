import type { SpawnRun } from "./spawn.js";

export class SessionNotFoundError extends Error {
  constructor(bgId: string) {
    super(`nenhuma sessão em background com o id ${bgId}`);
    this.name = "SessionNotFoundError";
  }
}

export async function stopSession(bgId: string, deps: { run: SpawnRun }): Promise<void> {
  if (!/^[0-9a-f]{8}$/.test(bgId)) throw new Error(`bgId inválido: ${bgId}`);
  const r = await deps.run(["stop", bgId]);
  const out = `${r.stdout}\n${r.stderr}`;
  if (out.includes("No job matching")) throw new SessionNotFoundError(bgId);
  if (r.code !== 0) throw new Error(`claude stop falhou: ${out.trim().slice(0, 300)}`);
}
