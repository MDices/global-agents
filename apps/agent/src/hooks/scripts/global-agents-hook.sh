#!/usr/bin/env bash
# global-agents: encaminha o payload do hook ao agente local. Nunca bloqueia o Claude Code.
# Depende só de bash, curl e grep (sem jq). Sai 0 em qualquer caminho.
PAYLOAD=$(cat 2>/dev/null)
PORT="${GLOBAL_AGENTS_PORT:-48476}"
MAX=2
if printf '%s' "$PAYLOAD" | grep -Eq '"hook_event_name"[[:space:]]*:[[:space:]]*"PermissionRequest"' 2>/dev/null; then
  MAX=1800
fi
RESP=$(printf '%s' "$PAYLOAD" | curl -sS -m "$MAX" -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${PORT}/hook" 2>/dev/null) || true
if [ -n "$RESP" ]; then printf '%s\n' "$RESP"; fi
exit 0
