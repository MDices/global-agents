/**
 * Inicialização no Windows via Agendador de Tarefas ("ao logon" do usuário atual, token interativo, sem senha e sem
 * elevação): roda na sessão do usuário (pipes e ~/.claude são por usuário). A tarefa vem de um XML porque o
 * `schtasks /SC ONLOGON` sem XML cria gatilho "qualquer usuário" (exige elevação), limite de 72h e regras de bateria.
 */
export const TASK_NAME = "global-agents";

export interface TaskOptions { node: string; cli: string; config?: string }

export interface TaskXmlOptions {
  /** `DOMÍNIO\usuário` (USERDOMAIN\USERNAME). */
  userId: string;
  /** Executável da ação (`conhost.exe`). */
  command: string;
  args: string;
  workingDir: string;
}

export function serviceBackend(platform: NodeJS.Platform): "systemd" | "schtasks" | "none" {
  return platform === "linux" ? "systemd" : platform === "win32" ? "schtasks" : "none";
}

/** `DOMÍNIO\usuário` a partir do ambiente; sem domínio, só o usuário. */
export function windowsUserId(env: NodeJS.ProcessEnv): string {
  const user = env["USERNAME"];
  if (user === undefined || user === "") throw new Error("USERNAME não definido; não sei para qual usuário registrar a tarefa");
  const dom = env["USERDOMAIN"];
  return dom !== undefined && dom !== "" ? `${dom}\\${user}` : user;
}

/** Argumentos da ação: `conhost --headless` evita a janela de console (Windows 10 1809+/11). */
export function buildTaskArgs(o: TaskOptions): string {
  const cfg = o.config === undefined ? "" : ` --config "${o.config}"`;
  return `--headless "${o.node}" "${o.cli}" run${cfg}`;
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildTaskXml(o: TaskXmlOptions): string {
  const user = xmlEscape(o.userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>global-agents (Claude Code ↔ Discord)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(o.command)}</Command>
      <Arguments>${xmlEscape(o.args)}</Arguments>
      <WorkingDirectory>${xmlEscape(o.workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** O Agendador espera UTF-16 LE com BOM. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

export function schtasksCreateArgs(xmlPath: string): string[] {
  return ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"];
}
export function schtasksEndArgs(): string[] {
  return ["/End", "/TN", TASK_NAME];
}
export function schtasksDeleteArgs(): string[] {
  return ["/Delete", "/TN", TASK_NAME, "/F"];
}

export interface WindowsServiceRun extends TaskOptions {
  action: "install" | "uninstall";
  apply: boolean;
  userId: string;
  workingDir: string;
  log: (line: string) => void;
  exec: (file: string, args: string[]) => Promise<void>;
  /** Grava o XML num arquivo temporário e devolve o caminho e uma função de limpeza. */
  writeTemp: (name: string, data: Buffer) => { path: string; cleanup: () => void };
}

export async function runWindowsService(r: WindowsServiceRun): Promise<void> {
  if (r.action === "install") {
    const xml = buildTaskXml({ userId: r.userId, command: "conhost.exe", args: buildTaskArgs(r), workingDir: r.workingDir });
    if (!r.apply) {
      r.log(`tarefa "${TASK_NAME}" (não executei nada). XML que seria registrado:\n\n${xml}\nrepita o comando com --apply para gravar o XML (UTF-16) e executar:\n  schtasks /Create /TN ${TASK_NAME} /XML <arquivo> /F`);
      return;
    }
    const tmp = r.writeTemp(`${TASK_NAME}-task.xml`, encodeTaskXml(xml));
    try {
      await r.exec("schtasks", schtasksCreateArgs(tmp.path));
    } finally {
      tmp.cleanup();
    }
    r.log(`tarefa "${TASK_NAME}" registrada para ${r.userId}: o agente inicia no próximo logon, sem janela de console. Para iniciar agora: schtasks /Run /TN ${TASK_NAME}`);
    return;
  }
  if (!r.apply) {
    r.log(`para remover a tarefa "${TASK_NAME}" (não executei nada), rode no cmd.exe:\n  schtasks /End /TN ${TASK_NAME}\n  schtasks /Delete /TN ${TASK_NAME} /F\n\nou repita o comando com --apply.`);
    return;
  }
  await r.exec("schtasks", schtasksEndArgs()).catch(() => undefined); // não estar rodando não é erro
  await r.exec("schtasks", schtasksDeleteArgs());
  r.log(`tarefa "${TASK_NAME}" parada e removida`);
}
