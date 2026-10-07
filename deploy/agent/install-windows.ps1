<#
.SYNOPSIS
  Instala o agente global-agents no Windows (rodar dentro do repositório clonado, como o usuário logado).
.EXAMPLE
  .\deploy\agent\install-windows.ps1 -Relay wss://relay.exemplo:8443/ws -Fingerprint AA:BB:... -DevRoot C:\dev
.EXAMPLE
  .\deploy\agent\install-windows.ps1 -Relay wss://relay.exemplo:8443/ws -Fingerprint AA:BB:... -Project C:\dev\meu-projeto -DevRoot C:\dev,D:\trabalho
.EXAMPLE
  .\deploy\agent\install-windows.ps1 -DevRoot C:\dev
  Com o agente já instalado (depois de um git pull): refaz o build, troca as pastas dev sem pedir token e reinicia o agente.
.NOTES
  Sem config gravada (%USERPROFILE%\.global-agents\config.json), -Relay é obrigatório e o token é pedido. Com config,
  -Relay, -Token e -Fingerprint são opcionais: o que não for passado fica como estava.
#>
param(
  [ValidatePattern('^wss?://')][string]$Relay,
  [System.Security.SecureString]$Token,
  [string]$Fingerprint,
  [string[]]$Project = @(),
  # Pastas raiz de desenvolvimento: tudo dentro delas pode virar sessão pelo /novo (inclusive pasta nova, criar:true).
  [string[]]$DevRoot = @(),
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false  # PS 7.3+: o doctor pode sair com 1 sem lançar
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$configFile = Join-Path $env:USERPROFILE '.global-agents\config.json'
$hasConfig = Test-Path $configFile
if (-not $hasConfig -and -not $Relay) { throw "sem config em ${configFile}: a primeira instalação precisa de -Relay (e do token)" }
# Token: o passado em -Token, ou o de GLOBAL_AGENTS_TOKEN (o node herda), ou pedido só na primeira instalação.
$envToken = -not [string]::IsNullOrEmpty($env:GLOBAL_AGENTS_TOKEN)
if (-not $Token -and -not $envToken -and -not $hasConfig) { $Token = Read-Host -AsSecureString 'Token do relay' }

function Get-VersionFrom([string]$text) {
  $m = [regex]::Match($text, '\d+\.\d+\.\d+')
  if (-not $m.Success) { throw "não consegui ler a versão em: $text" }
  return [version]$m.Value
}
function Invoke-Native([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$what falhou (código $LASTEXITCODE)" }
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cli = Join-Path $repo 'apps\agent\dist\cli.js'

Write-Host '== 1. pré-requisitos'
$node = Get-VersionFrom ((node --version) | Out-String)
if ($node -lt [version]'24.0.0') { throw "Node $node encontrado; é preciso Node >= 24" }
Write-Host "Node $node ok"
$claude = Get-VersionFrom ((claude --version) | Out-String)
if ($claude -lt [version]'2.1.234') { throw "Claude Code $claude encontrado; é preciso >= 2.1.234" }
Write-Host "Claude Code $claude ok"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm não encontrado (npm i -g pnpm ou corepack enable)' }

# Sempre refaz dependências e build (a não ser com -SkipBuild): depois de um git pull o dist antigo não serve.
if (-not $SkipBuild) {
  Write-Host '== 2. dependências e build'
  Push-Location $repo
  try {
    Invoke-Native 'pnpm install' { pnpm install }
    Invoke-Native 'pnpm build' { pnpm --filter '@global-agents/agent...' build }
  } finally { Pop-Location }
}
if (-not (Test-Path $cli)) { throw "não achei $cli; rode sem -SkipBuild" }

Write-Host '== 3. configuração, hooks e inicialização no logon (Agendador de Tarefas)'
$installArgs = @($cli, 'install', '--service', '--apply')
if ($Relay) { $installArgs += @('--relay', $Relay) }
if ($Fingerprint) { $installArgs += @('--fingerprint', $Fingerprint) }
foreach ($p in $Project) { $installArgs += @('--project', $p) }
foreach ($d in $DevRoot) { $installArgs += @('--dev-root', $d) }
if ($Token) {
  # O token só existe no ambiente durante este passo (pnpm install/build não o herdam).
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
  try {
    $env:GLOBAL_AGENTS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    Invoke-Native 'install' { node @installArgs }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Item Env:GLOBAL_AGENTS_TOKEN -ErrorAction SilentlyContinue
  }
} else {
  # Sem -Token: vale o GLOBAL_AGENTS_TOKEN do ambiente, se houver; senão a CLI reaproveita o token da config.
  Invoke-Native 'install' { node @installArgs }
}

Write-Host '== 4. (re)iniciar o agente com a config nova'
# /End falha se a tarefa não estiver rodando (primeira instalação): não é erro. Continue local porque, no
# PowerShell 5.1, stderr de comando nativo com Stop vira exceção.
& { $ErrorActionPreference = 'Continue'; schtasks /End /TN global-agents 2>&1 | Out-Null }
# O /End derruba só o conhost da tarefa: o node.exe filho sobrevive, segura a porta dos hooks e o novo agente sai sem
# aviso. Encerra os nodes que rodam o cli.js deste repositório (pelo CommandLine, que o Get-Process do 5.1 não tem).
$cliRe = '(^|[\s\x22])' + [regex]::Escape($cli) + '\x22?\s+run(\s|$)'
$orfaos = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $cliRe })
foreach ($o in $orfaos) { Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue }
$limite = (Get-Date).AddSeconds(5)
do {
  $vivos = @($orfaos | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | ForEach-Object { $_.ProcessId })
  if ($vivos.Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
} while ((Get-Date) -lt $limite)
Write-Host "node(s) antigo(s) do agente encerrado(s): $($orfaos.Count - $vivos.Count)"
if ($vivos.Count -gt 0) {
  $ids = $vivos -join ','
  Write-Host "ERRO: o(s) node(s) PID $ids não encerrou(aram) em 5 s e segue(m) segurando a porta dos hooks; não vou iniciar o agente novo." -ForegroundColor Red
  Write-Host "Encerre à mão (talvez num PowerShell como administrador) e rode de novo: Stop-Process -Id $ids -Force" -ForegroundColor Red
  exit 1
}
Start-Sleep -Seconds 1
Invoke-Native 'schtasks /Run' { schtasks /Run /TN global-agents }

Write-Host '== 5. doctor'
Start-Sleep -Seconds 3
node $cli doctor
if ($LASTEXITCODE -ne 0) { Write-Warning 'doctor encontrou problemas; veja a saída acima' }
Write-Host 'Pronto. Confira no Discord (docs\windows.md, seção "Verificar").'
