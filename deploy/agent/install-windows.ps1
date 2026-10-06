<#
.SYNOPSIS
  Instala o agente global-agents no Windows (rodar dentro do repositório clonado, como o usuário logado).
.EXAMPLE
  .\deploy\agent\install-windows.ps1 -Relay wss://relay.exemplo:8443 -Fingerprint AA:BB:... -Project C:\dev\meu-projeto
#>
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^wss?://')][string]$Relay,
  [System.Security.SecureString]$Token,
  [string]$Fingerprint,
  [string[]]$Project = @(),
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false  # PS 7.3+: o doctor pode sair com 1 sem lançar
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $Token) { $Token = Read-Host -AsSecureString 'Token do relay' }

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
$installArgs = @($cli, 'install', '--relay', $Relay, '--service', '--apply')
if ($Fingerprint) { $installArgs += @('--fingerprint', $Fingerprint) }
foreach ($p in $Project) { $installArgs += @('--project', $p) }
# O token só existe no ambiente durante este passo (pnpm install/build não o herdam).
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
try {
  $env:GLOBAL_AGENTS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  Invoke-Native 'install' { node @installArgs }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:GLOBAL_AGENTS_TOKEN -ErrorAction SilentlyContinue
}

Write-Host '== 4. iniciar agora (sem esperar o próximo logon)'
Invoke-Native 'schtasks /Run' { schtasks /Run /TN global-agents }

Write-Host '== 5. doctor'
Start-Sleep -Seconds 3
node $cli doctor
if ($LASTEXITCODE -ne 0) { Write-Warning 'doctor encontrou problemas; veja a saída acima' }
Write-Host 'Pronto. Confira no Discord (docs\windows.md, seção "Verificar").'
