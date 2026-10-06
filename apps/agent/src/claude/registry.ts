import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionRegistry {
  pid: number;
  sessionId: string;
  messagingSocketPath: string;
  peerToken?: string;
  name?: string;
  peerProtocol?: number;
}

export function readRegistry(pid: number, sessionsDir = join(homedir(), ".claude", "sessions")): SessionRegistry | undefined {
  try {
    const file = join(sessionsDir, `${pid}.json`);
    if (!existsSync(file)) return undefined;
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof j["messagingSocketPath"] !== "string" || typeof j["sessionId"] !== "string") return undefined;
    const reg: SessionRegistry = { pid, sessionId: j["sessionId"], messagingSocketPath: j["messagingSocketPath"] };
    if (typeof j["name"] === "string") reg.name = j["name"];
    if (typeof j["peerProtocol"] === "number") reg.peerProtocol = j["peerProtocol"];
    const keyFile = readdirSync(sessionsDir).find((f) => f.startsWith(`${pid}.`) && f.endsWith(".key"));
    if (keyFile !== undefined) {
      const k = JSON.parse(readFileSync(join(sessionsDir, keyFile), "utf8")) as Record<string, unknown>;
      if (typeof k["peerToken"] === "string") reg.peerToken = k["peerToken"];
    }
    return reg;
  } catch {
    return undefined;
  }
}
