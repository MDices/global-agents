# global-agents: encaminha o payload do hook ao agente local. Nunca bloqueia o Claude Code.
# Sai 0 em qualquer caminho.
try {
  $payload = [Console]::In.ReadToEnd()
  $port = if ($env:GLOBAL_AGENTS_PORT) { $env:GLOBAL_AGENTS_PORT } else { '48476' }
  $max = if ($payload -match '"hook_event_name"\s*:\s*"PermissionRequest"') { 1800 } else { 2 }
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/hook" -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec $max -UseBasicParsing
  if ($r.Content) { Write-Output $r.Content }
} catch {}
exit 0
