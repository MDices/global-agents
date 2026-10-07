import { hostname, userInfo } from "node:os";

export function normalizePart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-");
}

export function machineId(cfg: { machineName?: string | undefined }, user = userInfo().username): string {
  return `${normalizePart(cfg.machineName ?? hostname())}/${normalizePart(user)}`;
}
