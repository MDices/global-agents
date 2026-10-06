# global-agents Implementation Plan (índice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Observar e comandar sessões do Claude Code de vários PCs (Linux e Windows) a partir do Discord, via um agente local fino por máquina e um relay isolado na VPS.

**Architecture:** Três pacotes num monorepo pnpm: `packages/protocol` (envelope JSON validado com zod), `apps/agent` (hooks → agente local → WebSocket de saída; inventário via `claude agents --json`; injeção via socket/pipe de inbox; `claude --bg` para criar sessões; hook `PermissionRequest` segurado para aprovação remota) e `apps/relay` (servidor WSS com TLS autoassinado na porta 8443, SQLite, bot discord.js com canal por máquina e thread por sessão).

**Tech Stack:** TypeScript 5, Node 24 LTS, pnpm 10, vitest, zod 3, `ws` 8, `discord.js` 14, `node:sqlite`, `node-pty` (fallback), Docker Compose (relay), systemd --user (Linux) e WinSW (Windows) para o agente.

**Spec:** `docs/superpowers/specs/2026-10-06-global-agents-design.md` (ler inteira antes de qualquer tarefa; pesquisa e spikes em `docs/research/2026-10-06-pesquisa-tecnologias.md`).

## Partes do plano

| Parte | Marco | Arquivo | Tarefas |
|---|---|---|---|
| 1 | M1 Observar (Linux) | `2026-10-06-global-agents-plan-part1-observar.md` | T01–T14 |
| 2 | M2 Comandar | `2026-10-06-global-agents-plan-part2-comandar.md` | T15–T19 |
| 3 | M3 Permissões, M4 Windows, M5 Deploy | `2026-10-06-global-agents-plan-part3-permissoes-windows-deploy.md` | T20–T27 |

Executar na ordem. Cada parte termina com software que funciona sozinho (M1: ver sessões deste PC no Discord).

## Modelo de execução (spec §10)

Cada tarefa traz a etiqueta **`[S]`** (Sonnet) ou **`[O]`** (Opus). O coordenador (sessão de planejamento) **não escreve
código**: despacha um subagente implementador no modelo da etiqueta, depois um subagente revisor (Opus para tarefas
`[O]`, Sonnet para `[S]`) com o diff e a tarefa, e só então segue. O implementador recebe: o texto da tarefa, a spec,
este índice (seções Global Constraints e Review Focus) e o comando de teste. Regras para o implementador:

1. TDD estrito: escrever o teste, vê-lo falhar, implementar o mínimo, vê-lo passar, commitar. Nunca pular o "falhar".
2. Não tocar em arquivos fora de **Files** da tarefa sem justificar no relatório final.
3. Terminar com `pnpm -r typecheck && pnpm -r lint && pnpm -r test` verdes e relatar a saída real.
4. Mensagens de commit em português, prefixo convencional (`feat:`, `test:`, `chore:`), rodapé
   `Co-Authored-By: Claude <modelo> <noreply@anthropic.com>`.

## Global Constraints

- Node `>=24.0.0` (`engines`), pnpm `>=10`, TypeScript `strict: true`, ESM (`"type": "module"`), sem `any` não justificado.
- Envelope: todo objeto no fio tem `v: 1`, `id` (uuid v4), `ts` (ISO 8601 com fuso), `machine` no formato `hostname/usuario` (minúsculas, `[a-z0-9._-]`, separador `/`).
- Hooks **nunca** bloqueiam o Claude Code: timeout de 2 s no POST local, `exit 0` em todo caminho; exceção única é `PermissionRequest`, que aguarda até 1800 s e imprime a decisão.
- Porta do agente local: `48476` em `127.0.0.1` (global-pets usa `48475`; não colidir). Porta do relay: `8443`, `0.0.0.0`, TLS próprio.
- O **único** arquivo que conhece o formato de linha do inbox (`msgV: 1`) é `apps/agent/src/claude/inject.ts`.
- O agente limpa toda variável `CLAUDE_CODE_*` e `CLAUDECODE` do ambiente antes de executar `claude` (spike: sessão filha não registra inbox nem salva transcript).
- Texto de `session.send` que comece com `/` ou `!` é recusado no relay com `command.error` (`reason: "comandos do Claude não são aceitos"`).
- Discord: mensagens com no máximo 1900 caracteres de texto; renomear thread no máximo 1×/30 s por thread; gate de autorização sempre pelo **autor** (user ID), nunca pelo canal.
- `commandId` idempotente: reenvio devolve o mesmo `ack` sem reexecutar.
- Nada do global-agents referencia o outro projeto da VPS; a única mudança fora de `~/global-agents` é a regra de firewall da porta 8443.
- Textos voltados ao usuário (Discord, CLI) em português do Brasil com acentuação correta.

## Review Focus

Entradas que a spec implica, nenhum teste de tarefa cobriria por padrão, e que vão morder primeiro. Cada linha ganhou um teste na tarefa dona (indicada):

1. **`last_assistant_message` vazio ou só com blocos de tool** (Claude termina o turno sem texto): o relay deve postar `(sem texto na resposta)` em vez de mensagem vazia, que o Discord rejeita. → T12 (chunk) e T05 (mapper).
2. **Dois PCs com o mesmo hostname** (ex.: dois notebooks "desktop"): `machine` inclui o usuário do SO, e o relay recusa um segundo token para o mesmo `machine` só com `relay machine add --force`. → T10 (db) e T11 (ws auth).
3. **Sessão renomeada no meio** (`/rename`): a thread existente deve ser renomeada, não duplicada; chave é sempre `sessionId`. → T13 (threads).
4. **Payload de hook de versão nova com campos a mais ou a menos**: o mapper ignora campos desconhecidos e exige só `session_id`, `cwd`, `hook_event_name`; falta de `last_assistant_message` vira `turn.reply` com texto vazio. → T05.
5. **Outbox com arquivo corrompido** (queda de energia no meio de uma escrita): a linha inválida é pulada e registrada, as demais drenam; nunca trava o agente na subida. → T07.
6. **Texto injetado com `</cross-session-message>` dentro** (prompt injection na tag): o `inject.ts` escapa `<` em `&lt;` dentro do conteúdo. → T15.
7. **Decisão de permissão para `requestId` já resolvido ou desconhecido**: responder `command.error` e não travar o hook; clique duplicado no botão é idempotente. → T20 e T21.

## Estrutura de arquivos (decisão fechada; tarefas referenciam estes caminhos)

```
package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts  eslint.config.js  .gitignore
packages/protocol/
  src/envelope.ts      # base do envelope (v, id, ts, machine) + helpers newEnvelope(), parseLine()
  src/events.ts        # schemas zod dos eventos agente→relay
  src/commands.ts      # schemas zod dos comandos relay→agente
  src/index.ts
  test/*.test.ts
apps/agent/
  src/config.ts        # ~/.global-agents/config.json (zod)
  src/machine.ts       # machineId(): hostname/usuario
  src/claude/exec.ts   # runClaude(args): child_process com env limpo
  src/claude/registry.ts   # lê ~/.claude/sessions/<pid>.json e .key
  src/claude/inventory.ts  # claude agents --json → SessionInfo[]; poll + diff
  src/claude/spawn.ts      # claude --bg ...
  src/claude/inject.ts     # ÚNICO lugar do formato msgV:1 (socket/pipe)
  src/claude/fallback-pty.ts
  src/claude/stop.ts
  src/hooks/scripts/global-agents-hook.sh
  src/hooks/scripts/global-agents-hook.ps1
  src/hooks/install.ts     # merge idempotente em ~/.claude/settings.json
  src/hooks/server.ts      # HTTP 127.0.0.1:48476 /hook, /health
  src/hooks/mapper.ts      # payload de hook → eventos do protocolo
  src/permissions/pending.ts
  src/transport/outbox.ts  # JSONL em disco
  src/transport/client.ts  # ws com pinning, heartbeat, backoff
  src/commands/handle.ts   # dispatch de comandos recebidos
  src/doctor.ts
  src/cli.ts               # install | uninstall | run | status | doctor
  src/main.ts              # compõe tudo (run)
  test/**
apps/relay/
  src/config.ts        # env/arquivo: DISCORD_TOKEN, ALLOWED_USER_IDS, DATA_DIR, PORT
  src/db.ts            # node:sqlite, migrações, repositórios
  src/tls.ts           # gera/carrega cert autoassinado, fingerprint
  src/ws/server.ts     # WSS, auth por token, registro de conexões por machine
  src/discord/chunk.ts # fatiamento ≤1900 por parágrafo
  src/discord/bot.ts   # client discord.js, intents, login
  src/discord/threads.ts # canal por máquina, thread por sessão, rename com rate limit
  src/discord/cards.ts   # embed+botões de permissão
  src/discord/slash.ts   # /novo /sessoes /parar /filtro
  src/router.ts        # eventos → Discord
  src/commands.ts      # Discord → comandos; fila pending_commands
  src/cli.ts           # relay machine add|rm|list, relay backup
  src/main.ts
  test/**
deploy/relay/Dockerfile  deploy/relay/docker-compose.yml  deploy/relay/.env.example
deploy/agent/global-agents.service  deploy/agent/global-agents-winsw.xml
docs/install.md
```
