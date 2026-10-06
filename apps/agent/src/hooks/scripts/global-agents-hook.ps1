# global-agents: encaminha o payload do hook ao agente local. Nunca bloqueia o Claude Code.
# Lê e envia UTF-8 explícito (o stdin padrão usa a code page OEM). Sai 0 em qualquer caminho.
try {
  $payload = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)).ReadToEnd()
  $port = if ($env:GLOBAL_AGENTS_PORT) { $env:GLOBAL_AGENTS_PORT } else { '48476' }
  $max = if ($payload -match '"hook_event_name"\s*:\s*"PermissionRequest"') { 1800 } else { 2 }
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/hook" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec $max -UseBasicParsing
  if ($r.Content) { Write-Output $r.Content }
} catch {}
exit 0
