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

/**
 * Aspas simples do PowerShell: dentro de '...' dobra-se a própria aspa. O PowerShell trata também U+2018, U+2019,
 * U+201A e U+201B (aspas tipográficas) como aspa simples; cada uma é dobrada com o mesmo caractere.
 */
export function psQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, (c) => c + c)}'`;
}

/** Regex (sintaxe igual em .NET e JS) em volta do `cli.js`: começa em início/espaço/aspa e termina em ` run`. */
export const ORPHAN_PREFIX = "(^|[\\s\\x22])";
export const ORPHAN_SUFFIX = "\\x22?\\s+run(\\s|$)";

/**
 * Script (PowerShell 5.1 e 7) que encerra os `node.exe` cuja linha de comando tem o `cli.js` desta instalação seguido
 * de ` run`. O `/End` do Agendador derruba só o `conhost` da tarefa: o node filho sobrevive e segura a porta dos hooks.
 * Sem aspas duplas (a aspa é `\x22` na regex) e sem texto em português: a saída é só `found=N alive=PID,PID` em ASCII,
 * que o TS interpreta (o powershell.exe escreve em OEM, não em UTF-8).
 */
export function killOrphanNodeScript(cli: string): string {
  return [
    `$re = ${psQuote(ORPHAN_PREFIX)} + [regex]::Escape(${psQuote(cli)}) + ${psQuote(ORPHAN_SUFFIX)}`,
    `$alvo = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match $re })`,
    `foreach ($p in $alvo) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }`,
    `$fim = (Get-Date).AddSeconds(5)`,
    `do { $vivos = @($alvo | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | ForEach-Object { $_.ProcessId }); if ($vivos.Count -eq 0) { break }; Start-Sleep -Milliseconds 200 } while ((Get-Date) -lt $fim)`,
    `Write-Output ('found=' + $alvo.Count + ' alive=' + ($vivos -join ','))`,
  ].join("; ");
}

export function killOrphanNodeArgs(cli: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", killOrphanNodeScript(cli)];
}

export interface OrphanResult { found: number; alive: number[] }

/** Interpreta a saída `found=N alive=1,2` do script; `undefined` se não reconhecer. */
export function parseOrphanOutput(out: string): OrphanResult | undefined {
  const m = /found=(\d+) alive=([\d,]*)/.exec(out);
  if (m === null) return undefined;
  return { found: Number(m[1]), alive: (m[2] ?? "").split(",").filter((x) => x !== "").map(Number) };
}

/** Comando equivalente para colar no PowerShell (modo sem `--apply`). */
export function killOrphanNodeHint(cli: string): string {
  return killOrphanNodeScript(cli);
}

export interface WindowsServiceRun extends TaskOptions {
  action: "install" | "uninstall";
  apply: boolean;
  userId: string;
  workingDir: string;
  log: (line: string) => void;
  /** Devolve a saída padrão (só a do `powershell.exe` é interpretada). */
  exec: (file: string, args: string[]) => Promise<string | void>;
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
    r.log(`tarefa "${TASK_NAME}" registrada para ${r.userId}: o agente inicia no próximo logon, sem janela de console. Para iniciar agora: schtasks /Run /TN ${TASK_NAME}\nse o agente JÁ estiver rodando, ele não é reiniciado e segue com a config antiga: use o .\\deploy\\agent\\install-windows.ps1, ou rode schtasks /End /TN ${TASK_NAME}, encerre o node.exe antigo (docs/windows.md, 'Solução de problemas') e então schtasks /Run /TN ${TASK_NAME}.\nse trocar a versão do Node, reexecute 'install --service --apply' para atualizar o caminho do Node na tarefa.`);
    return;
  }
  if (!r.apply) {
    r.log(`para remover a tarefa "${TASK_NAME}" (não executei nada), rode no cmd.exe:\n  schtasks /End /TN ${TASK_NAME}\n  schtasks /Delete /TN ${TASK_NAME} /F\n\no /End não derruba o node.exe filho; no PowerShell, encerre-o também:\n  ${killOrphanNodeHint(r.cli)}\n\nou repita o comando com --apply.`);
    return;
  }
  await r.exec("schtasks", schtasksEndArgs()).catch(() => undefined); // não estar rodando não é erro
  // O /End encerra só o conhost; o node filho fica órfão. Falha aqui é aviso, não erro.
  try {
    const res = parseOrphanOutput(String((await r.exec("powershell.exe", killOrphanNodeArgs(r.cli))) ?? ""));
    if (res === undefined) throw new Error("saída inesperada do PowerShell");
    r.log(`node(s) antigo(s) do agente encerrado(s): ${res.found - res.alive.length}`);
    if (res.alive.length > 0) {
      r.log(`aviso: o(s) node(s) PID ${res.alive.join(", ")} não encerrou(aram) em 5 s e segue(m) segurando a porta dos hooks; encerre à mão: Stop-Process -Id ${res.alive.join(",")} -Force (PowerShell, talvez como administrador)`);
    }
  } catch (e) {
    r.log(`aviso: não consegui encerrar o node órfão do agente (${e instanceof Error ? e.message : String(e)}); confira com o comando de diagnóstico em docs/windows.md`);
  }
  await r.exec("schtasks", schtasksDeleteArgs());
  r.log(`tarefa "${TASK_NAME}" parada e removida`);
}
