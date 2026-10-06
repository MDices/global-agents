# global-agents — design (2026-10-06)

Status: aprovado em conversa seção a seção (arquitetura, componentes/contrato, fluxo de dados); pesquisa e spikes em
`docs/research/2026-10-06-pesquisa-tecnologias.md`.

## 1. Objetivo

Um canal onde Leonardo, de qualquer lugar, **observa** o que cada sessão do Claude Code está fazendo em cada um dos
seus PCs (Linux e Windows) e **comanda**: manda prompts para sessões existentes, cria sessões novas, aprova ou nega
permissões. Primeira interface: Discord. Segunda interface, futura: global-pets, consumindo o mesmo stream de eventos.

Fora de escopo no v1: multiusuário, streaming token a token no Discord, anexos, voz, interface web própria, times
entre máquinas (o Duo do Victor cobre isso; agent teams dentro de uma sessão já funcionam na arquitetura escolhida).

## 2. Decisões estruturais

| Tema | Decisão | Motivo |
|---|---|---|
| Motor | **Tudo é sessão Claude Code**: sessões nascem no terminal ou via `claude --bg --name`; prompts entram pelo socket de inbox; `claude attach` abre no terminal | Zero código de motor; mesma sessão, plugins, memória; verificado Linux + Windows |
| Rede | Relay na VPS, porta própria 8443 com TLS autoassinado fixado nos agentes; agentes conectam **para fora** via WebSocket com token por máquina | Nada aberto nos PCs; Discord é sempre saída; independente do outro projeto da VPS |
| Entrada em sessões com bypass | `crossSessionInbound: "accept"` nas user settings de cada máquina | Explícito e auditável; sem autodeclaração de classe |
| Aprovação remota | Hook `PermissionRequest` segurado pelo agente até o clique no Discord | Verificado em sessão `--bg` sem ninguém anexado |
| Discord | Canal por máquina, thread por sessão, `/novo` no canal | Layout pedido pelo Leonardo |
| Formato de fio | Envelope JSON por linha, extensão do `session.status` do global-pets | Pet vira segundo consumidor sem segundo protocolo |
| Stack | TypeScript, Node 24 LTS, `ws`, `discord.js` 14, `node:sqlite`; monorepo pnpm | Mesma stack do global-pets; libs verificadas |
| Empacotamento | Sem compilar: `node` + pacote; Linux `systemd --user`, Windows WinSW | SEA/bun brigam com binário nativo |

## 3. Arquitetura

```
 PC (Linux ou Windows)                              VPS                         Discord
 ┌───────────────────────────────┐    WSS saída    ┌──────────────────────┐    gateway   ┌─────────┐
 │ Claude Code sessões           │ ──────────────▶ │ relay (Node)         │ ◀──────────▶ │ bot     │
 │  ├ hooks ──POST 127.0.0.1──┐  │ ◀────────────── │  ├ ws server + auth  │              │ canais  │
 │  └ inbox socket/pipe ◀──┐  │  │   comandos      │  ├ SQLite (mapas)    │              │ threads │
 │ agente local (Node)      │  │  │                 │  └ bot discord.js    │              └─────────┘
 │  ├ hooks/ (instalador)   │  │  │                 └──────────────────────┘
 │  ├ claude/ (inventário, spawn, injeção)                 ▲
 │  ├ permissions/ (segura PermissionRequest)              │ futuro: global-pets lê o mesmo
 │  └ transport/ (ws, outbox)                               │ stream direto do agente local
 └───────────────────────────────┘
```

Três componentes, dois pacotes implantáveis mais um pacote compartilhado:

- `packages/protocol`: tipos + validação (zod) do envelope. Sem I/O.
- `apps/agent`: agente local. Serviço de usuário, um por PC.
- `apps/relay`: relay + bot Discord, um processo na VPS.

## 4. Contrato de eventos (`packages/protocol`)

Uma linha JSON por mensagem. Todo envelope tem `v: 1`, `id` (uuid), `ts` (ISO 8601), `machine`
(`hostname/usuario-do-SO`, normalizado). O agente é instalado e roda **por usuário do SO**; trocar o login Anthropic
na mesma conta do SO não exige nada: hooks, settings, sockets e inventário são do usuário do SO. Eventos (agente → relay) e comandos (relay → agente):

### 4.1 Eventos

| `type` | Campos | Origem |
|---|---|---|
| `agent.hello` | `version`, `os`, `osUser`, `claudeVersion`, `claudeAccount` (e-mail de `claude auth status`), `projects[]` (cwds sugeridos para `/novo`) | conexão; reenviado quando a conta logada muda |
| `session.list` | `sessions[]` com `sessionId`, `name`, `cwd`, `kind`, `status`, `state?`, `waitingFor?`, `bgId?` | `claude agents --json`, na conexão e a cada mudança (poll 5 s com diff) |
| `session.status` | `sessionId`, `name`, `cwd`, `state` ∈ `working\|waiting\|done\|error`, `snippet?` | hooks `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd` |
| `turn.prompt` | `sessionId`, `text`, `source` ∈ `terminal\|remote` | hook `UserPromptSubmit` (`source=remote` quando o texto começa com a tag de cross-session) |
| `turn.reply` | `sessionId`, `text` (inteiro), `stopReason` | hook `Stop` (`last_assistant_message`) |
| `permission.request` | `sessionId`, `requestId`, `tool`, `description`, `inputPreview`, `expiresAt` | hook `PermissionRequest` |
| `permission.resolved` | `requestId`, `by` ∈ `remote\|terminal\|timeout`, `behavior` | agente |
| `command.ack` / `command.error` | `commandId`, `result?` / `reason` | resposta a comando |

### 4.2 Comandos

| `type` | Campos | Ação no agente |
|---|---|---|
| `session.create` | `commandId`, `cwd`, `name`, `prompt`, `permissionMode` | `claude --bg --name <name> --permission-mode <mode> "<prompt>"` com ambiente limpo de `CLAUDE_CODE_*`; resolve `sessionId` via `agents --json`; `ack` com `sessionId`, `bgId` |
| `session.send` | `commandId`, `sessionId`, `text` | injeta no inbox; `ack` quando a linha foi escrita |
| `session.stop` | `commandId`, `sessionId` | `claude stop <bgId>` (só bg); `error` para interativa |
| `permission.decide` | `commandId`, `requestId`, `behavior` ∈ `allow\|deny` | destrava o hook pendente |

Regras: `commandId` idempotente (reenvio recebe o mesmo `ack`); tamanho máximo de `text` 100 kB; o relay nunca
manda texto que comece com `/` ou `!` como `session.send` (vira erro "comandos do Claude não são aceitos").

## 5. Agente local (`apps/agent`)

### 5.1 `hooks/`

- Scripts `global-agents-hook.sh` (bash + `jq` opcional, sem `jq` manda o payload cru) e `global-agents-hook.ps1`.
  Fazem **só** um POST em `http://127.0.0.1:48476/hook` com o JSON de stdin e `hook_event_name`. Timeout 2 s,
  `exit 0` sempre. Exceção: `PermissionRequest` mantém a conexão aberta e imprime no stdout a decisão que o agente
  devolver (ou nada, se o agente mandar "deixa no terminal").
- Instalador `install` (CLI do agente): mescla em `~/.claude/settings.json` os hooks `UserPromptSubmit`,
  `Notification`, `Stop`, `SessionEnd`, `PermissionRequest` (este com `timeout: 1800`) e a chave
  `crossSessionInbound: "accept"`. Idempotente, atômico, preserva chaves alheias (portar `hookInstaller.ts` do
  global-pets). `uninstall` remove só o que é dele.
- Convivência com o hook do global-pets: entradas distintas no mesmo array; nenhum dos dois toca no outro.

### 5.2 `claude/`

- `inventory.ts`: roda `claude agents --json` (poll 5 s), normaliza, emite `session.list` só quando muda. Lê
  `~/.claude/sessions/<pid>.json` para `messagingSocketPath`; lê `<pid>.<hash>.key` para `peerToken` (Windows).
- `spawn.ts`: `session.create`. Limpa `CLAUDE_CODE_*` do env, roda `claude --bg …`, parseia o id curto, espera o
  `sessionId` aparecer no inventário (até 30 s).
- `inject.ts`: **único arquivo que conhece o formato `msgV: 1`**. Linux/macOS: Unix socket; Windows: named pipe com
  primeira linha `{"type":"auth","token":<peerToken>}`. Conteúdo:
  `<cross-session-message from="global-agents" from-name="discord:<usuario>">\n<texto>\n</cross-session-message>`.
  Verifica `peerProtocol === 1` no registro; se diferente, usa `fallback-pty.ts` (`claude --resume <id> "<texto>"`
  num pty via `node-pty`, aguarda "Sent your prompt", envia Ctrl+Z) e emite aviso.
- `stop.ts`: `claude stop <bgId>`.

### 5.3 `permissions/`

Servidor HTTP local recebe o POST do hook `PermissionRequest`, registra `requestId` (uuid próprio; o payload do hook
não traz um), emite `permission.request`, e **segura a resposta HTTP** até: chegar `permission.decide` (responde
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":…}}}`), a sessão deixar de estar
`waiting` no inventário (decidido no terminal → responde vazio, emite `permission.resolved by=terminal`), ou passar
`expiresAt` (30 min → `deny`, emite `resolved by=timeout`).

### 5.4 `transport/`

`ws` cliente para `wss://<relay>/ws`, header `Authorization: Bearer <token da máquina>`, ping/pong 30 s, backoff
exponencial 1 s → 60 s. **Outbox** em disco (JSONL em `~/.global-agents/outbox/`) para eventos enquanto offline,
drenado em ordem na reconexão; eventos `session.list` antigos são colapsados (só o último vale).

### 5.5 Configuração

`~/.global-agents/config.json`: `relayUrl`, `machineName`, `token`, `projects[]`, `port` (padrão 48476). CLI:
`global-agents install | uninstall | run | status | doctor`. `doctor` roda os checks dos spikes (versão do Claude,
`agents --json`, socket/pipe acessível, hooks presentes).

## 6. Relay + bot (`apps/relay`)

### 6.1 Persistência (`node:sqlite`)

| Tabela | Colunas |
|---|---|
| `machines` | `name` PK (`hostname/usuario-do-SO`), `token_hash`, `channel_id`, `last_seen`, `os`, `claude_version`, `claude_account`, `filter_account` |
| `sessions` | `session_id` PK, `machine`, `name`, `cwd`, `thread_id`, `bg_id`, `state`, `updated_at` |
| `permissions` | `request_id` PK, `session_id`, `message_id`, `status`, `decided_by`, `decided_at` |
| `pending_commands` | `command_id` PK, `machine`, `payload`, `created_at`, `expires_at`, `discord_message_id` |

### 6.2 Roteamento

- Evento com `sessionId` sem thread → cria thread no canal da máquina (nome = `name` truncado a 100), grava mapa,
  primeira mensagem: cwd, conta Anthropic logada na máquina naquele momento, `claude attach <bgId>` quando houver,
  estado. **Sem filtro automático por conta**: todas as sessões da máquina aparecem, de qualquer conta logada
  (decisão do Leonardo, 06/10). `/filtro conta:<e-mail>` é opcional e por canal, para silenciar threads de outras
  contas enquanto ativo; `/filtro off` desliga.
- `turn.prompt` → posta como citação `🧑 prompt` (ou `💬 via Discord` quando `source=remote`, sem repostar o texto).
- `turn.reply` → fatia em ≤ 1900 chars preferindo quebras de parágrafo; posta em sequência; atualiza emoji de estado
  no nome da thread (`🟢 working`, `🟡 waiting`, `⚪ done`, `🔴 error`) no máximo 1×/30 s por thread.
- `permission.request` → mensagem com embed (ferramenta, descrição, prévia em bloco de código até 1000 chars) e
  botões `Permitir` / `Negar`; clique → `permission.decide`; `permission.resolved` edita o card com o desfecho.
- Mensagem humana numa thread mapeada → `session.send` → reação ✅ no ack, ❌ no erro, ⏳ se máquina offline
  (comando vai para `pending_commands`, validade 1 h; ao expirar, edita a reação para ❌ e avisa).
- `/novo prompt:<texto> projeto:<cwd> modo:<default|acceptEdits|plan|bypassPermissions>` no canal → `session.create`
  → thread criada no `ack`. `/sessoes` lista as sessões vivas da máquina. `/parar` dentro da thread → `session.stop`.
- Máquina conecta pela primeira vez → cria o canal `#<machine>` na categoria configurada.

### 6.2.1 Comandos do Claude pela thread (`/claude`)

Pedido do Leonardo (06/10): rodar slash commands do Claude Code (ex.: `/compact`, `/usage`) a partir do Discord. O
socket de inbox entrega texto como "mensagem de outra sessão" e **não executa** slash commands, por desenho da
Anthropic. Caminho escolhido: o agente abre a sessão com `claude attach <bgId>` num pseudoterminal, digita o comando,
captura a tela renderizada, fecha diálogos com `Esc` e desanexa com `Ctrl+Z`.

- Slash command do Discord: `/claude comando:<choice> [args:<texto>]`, só dentro de thread mapeada.
- Allowlist fechada (v1): `compact` (args opcionais = instruções de foco), `usage`, `cost`, `hooks`, `status`,
  `context`, `model` (args opcional = alias). Qualquer outro valor é recusado; `clear`, `exit`, `resume`,
  `login`/`logout` e afins nunca entram.
- Só funciona em sessões **em background** (têm `bgId`). Sessão interativa aberta num terminal → resposta
  `essa sessão está aberta num terminal; rode o comando lá ou mande-a para o fundo com /bg`.
- Sessão com `status: busy` → recusa `sessão ocupada; tente quando o turno terminar` (exceto `usage`/`cost`/`status`,
  que não mexem na conversa).
- Resultado: texto da tela capturada, sem ANSI, postado na thread em bloco de código (fatiado pelo `chunkText`).
- Protocolo: comando `session.slash { commandId, sessionId, command, args? }`; resposta `command.ack` com
  `result.screen` ou `command.error`.

### 6.3 Segurança

- Allowlist de Discord user IDs em config; qualquer outro remetente é ignorado em silêncio (gate no **autor**, não no
  canal). Botões de permissão também checam o autor do clique.
- Token por máquina gerado pelo relay (`relay machine add <name>`), guardado como hash.
- Só a porta 8443 exposta; TLS terminado pelo relay com certificado autoassinado fixado (fingerprint) nos agentes.
- Intent `MessageContent` ligado no portal; bot com `Public Bot` desligado.

## 7. Fluxos ponta a ponta

1. **Observar**: hook → agente → `turn.prompt`/`session.status` → relay cria/acha thread → posta; `Stop` →
   `turn.reply` → fatias.
2. **Mandar prompt**: resposta na thread → allowlist → `session.send` → `inject.ts` → `ack` → ✅; resposta volta pelo
   fluxo 1. Offline → fila.
3. **Criar chat**: `/novo` → `session.create` → `spawn.ts` → `ack` com `sessionId` → thread ligada antes do primeiro
   `Stop`; primeira mensagem traz `claude attach <id>`.
4. **Aprovar permissão**: hook segurado → `permission.request` → card com botões → `permission.decide` → hook
   responde → `permission.resolved` → card editado.

## 8. Erros e resiliência

| Situação | Comportamento |
|---|---|
| Agente fora do ar | Hook falha o POST em 2 s e sai 0; Claude segue normal; `PermissionRequest` sem agente → hook não imprime nada → prompt fica no terminal |
| VPS fora do ar | Outbox em disco; drena em ordem na volta; `session.list` colapsado |
| Máquina offline para um comando | `pending_commands` por 1 h; ⏳ → ✅/❌ |
| Injeção falha (socket sumiu, sessão morreu) | `command.error` com motivo; ❌ e sugestão de `/novo` |
| `peerProtocol` ≠ 1 ou formato mudou | `fallback-pty.ts`; evento `agent.warning` visível na thread |
| Timeout da permissão (30 min) | `deny`; card marca "expirou" |
| Thread arquivada pelo Discord | Mensagem nova desarquiva automaticamente; relay não precisa agir |
| Rate limit do Discord | Fila por canal com respeito a `Retry-After`; edições de nome de thread ≤ 1×/30 s |

## 9. Testes

- `packages/protocol`: validação de todos os envelopes (válidos, campos faltando, versão errada).
- `apps/agent`: unit em `inventory` (fixtures reais do `agents --json` Linux e Windows), `inject` (servidor Unix/pipe
  falso captura a linha), `permissions` (segura/solta/expira), outbox (ordem, colapso, reinício), instalador (merge
  idempotente com settings que já têm o hook do global-pets). Integração opcional (`GLOBAL_AGENTS_E2E=1`): sessão
  `--bg` real, injeção e leitura do transcript, nas duas plataformas.
- `apps/relay`: unit em fatiamento, roteamento thread↔sessão, allowlist, fila de comandos; integração com um agente
  falso em WebSocket; bot testado contra um servidor Discord de teste do Leonardo com `DISCORD_TEST_GUILD`.
- Gate: `pnpm test` + `pnpm typecheck` + `pnpm lint` verdes antes de cada merge.

## 10. Modelo de execução (quem implementa)

O código será escrito por **subagentes**, não pela sessão de planejamento. Cada tarefa do plano recebe uma etiqueta
de dificuldade que define o modelo:

| Etiqueta | Modelo | Critério |
|---|---|---|
| `S` | Sonnet | Contrato claro, poucas decisões, testes unitários diretos: tipos/zod, fatiamento, SQLite, instalador, scripts de hook, config, CLI, compose, TLS autoassinado |
| `O` | Opus | Integração com comportamento externo não trivial ou concorrência: `inject.ts` (socket + pipe + fallback pty), `permissions/` (segurar HTTP com três saídas), `transport/` (outbox + reconexão), roteamento do bot com rate limit e fila, testes e2e com Claude real |

Toda tarefa entrega com testes (TDD), passa pelo gate da seção 9, e tem revisão por um segundo subagente antes do
merge. O planejador (esta sessão) só coordena, revisa e integra.

## 11. Marcos

1. **M1 Observar**: protocol + agente (hooks, inventário, transport) + relay (canal/thread, prompts, respostas),
   Linux. Entrega: ver no Discord as sessões deste PC.
2. **M2 Comandar**: `session.send`, `/novo`, `/parar`, fila offline. Entrega: criar e dirigir chats pelo Discord.
3. **M3 Permissões**: hook `PermissionRequest` + cards com botões.
4. **M4 Windows**: scripts `.ps1`, named pipe, WinSW, `doctor`; validação no Toneli-PC.
5. **M5 Deploy**: Docker compose isolado na VPS (porta 8443, TLS próprio), `systemd --user` no Linux, documentação
   de instalação.

### 11.1 Ambiente real da VPS e isolamento (levantado em 06/10/2026, leitura via SSH)

A VPS (163.176.107.229, Oracle, Ubuntu 24.04, 2 vCPU, 11 GB RAM com 9,4 GB livres, 38 GB de disco livres, Docker 29 +
Compose v5, `sudo` sem senha, sem Node no host) já hospeda outro projeto que ocupa as portas 80 e 443 com um proxy
próprio. Decisão do Leonardo: **os dois projetos são independentes**; o global-agents não referencia, não altera e
não depende de nada do outro compose.

Desenho do isolamento:

- Compose próprio em `~/global-agents/` com rede Docker própria, volume próprio para o SQLite e logs com rotação.
  Nenhum arquivo fora desse diretório é tocado, exceto a regra de firewall abaixo.
- O relay escuta em **`0.0.0.0:8443`** e termina TLS ele mesmo (`https`/`wss` nativos do Node). Compartilhado com o
  outro projeto fica só o host: uma regra `iptables -A INPUT -p tcp --dport 8443 -m state --state NEW -j ACCEPT`
  persistida, e a mesma liberação na security list da Oracle Cloud.
- **Certificado**: autoassinado, gerado pelo relay na primeira subida e guardado no volume; o agente local grava o
  fingerprint SHA-256 na sua config (`relayCertFingerprint`) e rejeita qualquer outro (pinning). Sem domínio, sem
  DNS, sem Let's Encrypt. Migração futura opcional para um domínio fora do outro projeto com DNS-01 (Cloudflare)
  muda só `relayUrl` nos agentes.
- Limites no compose: `mem_limit: 512m`, `cpus: 0.5`, `restart: unless-stopped`.
- Backup: `relay backup` exporta o SQLite para um `.tar.gz` em `~/global-agents/backups/` via cron do usuário.
- Autenticação continua por token de máquina no header do WebSocket; o pinning protege contra MITM no IP.

## 12. Riscos aceitos

- Formato `msgV: 1` do inbox não é contrato público: isolado em um arquivo, com fallback e aviso.
- Mensagem injetada é tratada como "de outra sessão": não aprova permissões nem roda `/comandos` (por desenho da
  Anthropic); a aprovação vai pelo hook.
- Channels, Remote Control e agent view estão em preview; `--channels` e `--teammate-mode` nem aparecem no `--help`.
  O design não depende de Channels; depende de `--bg`/`agents --json` (preview, mas estável desde v2.1.139).
