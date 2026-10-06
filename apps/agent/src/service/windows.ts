/** Inicialização no Windows via Agendador de Tarefas ("ao logon" do usuário atual): sem senha, roda na sessão do usuário (pipes e ~/.claude são por usuário). */
export const TASK_NAME = "global-agents";

export interface TaskOptions { node: string; cli: string; config?: string }

export function serviceBackend(platform: NodeJS.Platform): "systemd" | "schtasks" | "none" {
  return platform === "linux" ? "systemd" : platform === "win32" ? "schtasks" : "none";
}

/** Comando que o Agendador executa: `"node" "cli" run [--config "cfg"]`. */
export function buildTaskCommand(o: TaskOptions): string {
  const cfg = o.config === undefined ? "" : ` --config "${o.config}"`;
  return `"${o.node}" "${o.cli}" run${cfg}`;
}

export function schtasksCreateArgs(o: TaskOptions): string[] {
  return ["/Create", "/TN", TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", buildTaskCommand(o), "/F"];
}

export function schtasksDeleteArgs(): string[] {
  return ["/Delete", "/TN", TASK_NAME, "/F"];
}

/** Linha para colar no cmd.exe: argumentos com espaço/aspas vão entre aspas, aspas internas viram \". */
export function formatCommandLine(file: string, args: string[]): string {
  const q = (a: string): string => (a === "" || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return [file, ...args.map(q)].join(" ");
}

export interface WindowsServiceRun extends TaskOptions {
  action: "install" | "uninstall";
  apply: boolean;
  log: (line: string) => void;
  exec: (file: string, args: string[]) => Promise<void>;
}

export async function runWindowsService(r: WindowsServiceRun): Promise<void> {
  const args = r.action === "install" ? schtasksCreateArgs(r) : schtasksDeleteArgs();
  if (!r.apply) {
    r.log(`para ${r.action === "install" ? "registrar" : "remover"} a tarefa "${TASK_NAME}" (não executei nada), rode no cmd.exe:\n  ${formatCommandLine("schtasks", args)}\n\nou repita o comando com --apply para eu executar o schtasks (sem passar por shell).`);
    return;
  }
  await r.exec("schtasks", args);
  r.log(r.action === "install"
    ? `tarefa "${TASK_NAME}" registrada: o agente inicia no próximo logon deste usuário. Para iniciar agora: schtasks /Run /TN ${TASK_NAME}`
    : `tarefa "${TASK_NAME}" removida (se o agente está rodando, encerre o processo node ou faça logoff)`);
}
