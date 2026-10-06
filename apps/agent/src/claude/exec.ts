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
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    const ms = opts.timeoutMs ?? 30000;
    const t = setTimeout(() => {
      child.kill();
      reject(new Error(`claude ${args[0]} excedeu ${ms} ms`));
    }, ms);
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
