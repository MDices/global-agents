# global-agents — spike Windows (rodar no Toneli-PC, PowerShell 7 ou 5.1, Claude Code >= 2.1.234)
# Objetivo: confirmar no Windows nativo (1) claude agents --json, (2) claude --bg/attach,
# (3) injeção de prompt no named pipe de inbox de uma sessão, com a linha de auth obrigatória.
# Não altera settings. Cria uma sessão de teste e a remove no fim.
$ErrorActionPreference = "Continue"
$Name = "spk-win-" + (Get-Random -Maximum 9999)
$ClaudeDir = Join-Path $HOME ".claude"

Write-Host "== 1. versão"; claude --version
Write-Host "== 2. agents --json (antes)"; claude agents --json | Out-String | Write-Host

Write-Host "== 3. criar sessão em background"
$out = claude --bg --name $Name --permission-mode plan "Responda apenas OK." 2>&1 | Out-String
Write-Host $out
$id = [regex]::Match($out, '[0-9a-f]{8}').Value
Start-Sleep -Seconds 30

Write-Host "== 4. localizar registro da sessão"
$rows = claude agents --json | ConvertFrom-Json
$row = $rows | Where-Object { $_.name -eq $Name }
$row | ConvertTo-Json | Write-Host
$pidSess = $row.pid
$reg = Get-Content (Join-Path $ClaudeDir "sessions\$pidSess.json") -Raw | ConvertFrom-Json
Write-Host "messagingSocketPath = $($reg.messagingSocketPath)"
$keyFile = Get-ChildItem (Join-Path $ClaudeDir "sessions") -Filter "$pidSess.*.key" | Select-Object -First 1
$peerToken = $null
if ($keyFile) { $peerToken = (Get-Content $keyFile.FullName -Raw | ConvertFrom-Json).peerToken; Write-Host "peerToken do .key: $peerToken" }

# Nome do pipe: a doc fala em "named pipe" e o registro traz o caminho; normalizamos para \\.\pipe\<nome>
$pipePath = $reg.messagingSocketPath
$pipeName = $pipePath -replace '^\\\\\.\\pipe\\', '' -replace '^\\\\\?\\pipe\\', ''
Write-Host "pipeName = $pipeName"

function Send-Inbox([string]$token, [string]$word) {
  $msg = @{
    msgV = 1; msg_id = [guid]::NewGuid().ToString(); type = "user"; priority = "next"; from = "global-agents-daemon"
    message = @{ role = "user"; content = "<cross-session-message from=`"global-agents-daemon`" from-name=`"discord:leonardo`">`nTeste Windows: responda apenas a palavra $word.`n</cross-session-message>" }
  } | ConvertTo-Json -Compress -Depth 5
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(5000)
    $w = New-Object System.IO.StreamWriter($pipe); $w.AutoFlush = $true; $w.NewLine = "`n"
    if ($token) { $w.WriteLine((@{ type = "auth"; token = $token } | ConvertTo-Json -Compress)) }
    $w.WriteLine($msg)
    Start-Sleep -Milliseconds 500
    Write-Host "enviado ($word) token=$([bool]$token)"
  } catch { Write-Host "falha ao enviar ($word): $($_.Exception.Message)" }
  finally { $pipe.Dispose() }
}

Write-Host "== 5a. injeção com peerToken do .key"; if ($peerToken) { Send-Inbox $peerToken "ECHO" }
Start-Sleep -Seconds 25
Write-Host "== 5b. injeção sem auth (deve ser recusada no Windows)"; Send-Inbox $null "FOXTROT"
Start-Sleep -Seconds 25

Write-Host "== 6. transcript"
$proj = Get-ChildItem (Join-Path $ClaudeDir "projects") -Directory | ForEach-Object { Get-ChildItem $_.FullName -Filter "$($row.sessionId).jsonl" } | Select-Object -First 1
Get-Content $proj.FullName | ForEach-Object {
  try { $o = $_ | ConvertFrom-Json } catch { return }
  if ($o.type -in @("user","assistant")) {
    $c = $o.message.content
    $t = if ($c -is [string]) { $c } else { ($c | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text }) -join " " }
    Write-Host ("   {0}: {1}" -f $o.type.ToUpper(), ($t -replace "`n"," ").Substring(0, [Math]::Min(120, $t.Length)))
  }
}
Write-Host "== 7. attach manual (opcional): claude attach $id   — depois volte e rode a limpeza abaixo"
Write-Host "== 8. limpeza"; claude stop $id; claude rm $id
Write-Host "Cole toda esta saída de volta no chat."
