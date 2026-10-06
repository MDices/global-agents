import { spawn } from "node:child_process";

export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE"));
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runClaude(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; claudeBin?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.claudeBin ?? "claude", args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: cleanEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // processo já encerrado
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    const ms = opts.timeoutMs ?? 30000;
    const t = setTimeout(() => {
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), 2000);
      reject(new Error(`claude ${args[0]} excedeu ${ms} ms`));
    }, ms);
    child.on("error", (e) => {
      clearTimeout(t);
      clearTimeout(killTimer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      clearTimeout(killTimer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
