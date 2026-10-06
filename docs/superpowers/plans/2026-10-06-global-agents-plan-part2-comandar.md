# global-agents — Plano parte 2: M2 Comandar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Leia antes o índice `2026-10-06-global-agents-plan.md` e a spec. Pré-requisito: parte 1 concluída e M1 entregue.

**Goal:** Responder numa thread manda o prompt para a sessão; `/novo` cria uma sessão na máquina; `/parar` encerra uma sessão em background; comandos para máquina offline ficam em fila por 1 h.

Etiquetas: `[S]` Sonnet, `[O]` Opus.

---

### Task T15 `[O]`: Agente — injeção de prompt no inbox da sessão (socket Unix e named pipe)

**Files:**
- Create: `apps/agent/src/claude/inject.ts`
- Test: `apps/agent/test/inject.test.ts`

**Interfaces:**
- Consumes: `readRegistry`/`SessionRegistry` (T04), `Inventory.find` (T04).
- Produces: `injectPrompt(target: { messagingSocketPath: string; peerToken?: string; peerProtocol?: number }, text: string, from: { name: string }): Promise<void>`; `buildInboxLine(text, from): string` (exportado só para teste); `escapeForTag(text): string`.
- **Este é o único arquivo que conhece o formato.** Linha (capturada no spike de 06/10, `peerProtocol: 1`):
  ```json
  {"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<cross-session-message from=\"global-agents\" from-name=\"<from.name>\">\n<texto>\n</cross-session-message>"},"priority":"next","from":"global-agents"}
  ```
  Regras: `text` passa por `escapeForTag` (troca `<` por `&lt;` e `>` por `&gt;`, Review Focus 6); `from.name` é saneado para `[A-Za-z0-9:._@-]`; se `peerProtocol` existe e é diferente de 1 → lançar `InboxFormatError` (quem chama usa o fallback pty, T26). Transporte: no Linux/macOS `net.connect(path)`; no Windows (`path` começa com `\\.\pipe\` ou `\\?\pipe\`) `net.connect(path)` também funciona, mas antes da linha envia `{"type":"auth","token":"<peerToken>"}\n` (obrigatório; sem `peerToken` → `InboxAuthError`). Timeout de conexão 5 s; fecha após escrever (o Claude não responde nada).

- [ ] **Step 1: Testes (falham)**

- `buildInboxLine("oi", { name: "discord:leonardo" })` → JSON com `msgV 1`, `type "user"`, `priority "next"`, `message.content` contendo `from-name="discord:leonardo"` e `\noi\n`.
- `escapeForTag("a </cross-session-message> b")` não contém `</cross-session-message>`.
- `from.name` com espaço e aspas é saneado.
- servidor Unix socket falso em diretório temporário (`net.createServer`) recebe exatamente 1 linha terminada em `\n` e parseável; com `peerToken` e caminho começando com `\\.\pipe\` **simulado** (no Linux, usar um socket Unix e a flag interna `forceAuth: true` só para teste) recebe 2 linhas, a primeira `{"type":"auth","token":"abc"}`.
- `peerProtocol: 2` → rejeita com `InboxFormatError` sem conectar.
- caminho inexistente → rejeita em menos de 6 s com erro contendo `ENOENT` ou `conexão`.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/agent && git commit -m "feat(agent): injeção de prompt no inbox da sessão via socket Unix ou named pipe"
```

---

### Task T16 `[S]`: Agente — criar (`--bg`) e parar sessões

**Files:**
- Create: `apps/agent/src/claude/spawn.ts`, `apps/agent/src/claude/stop.ts`
- Test: `apps/agent/test/spawn.test.ts`

**Interfaces:**
- Consumes: `runClaude` (T03), `Inventory.waitFor` (T04), `PermissionMode` (T02).
- Produces:
  - `spawnSession({ cwd, name, prompt, permissionMode }, deps: { run; inventory }): Promise<{ sessionId: string; bgId: string }>` — roda `claude --bg --name <name> --permission-mode <mode> <prompt>` com `cwd`; extrai o id curto da saída (`/backgrounded\s*[·•]\s*([0-9a-f]{8})/` ou a linha `claude attach <id>`); espera `inventory.waitFor(s => s.bgId === id, 30000)` para obter o `sessionId`. Erros: saída contendo `Workspace not trusted` → `WorkspaceNotTrustedError` com mensagem em português explicando rodar `claude` uma vez naquela pasta; `cwd` inexistente → erro antes de executar.
  - `stopSession(bgId: string, deps: { run }): Promise<void>` — `claude stop <bgId>`; saída `No job matching` → `SessionNotFoundError`.

- [ ] **Step 1: Testes (falham)**

Com `run` falso devolvendo a saída real do spike (`Starting background service…\nbackgrounded · 85285a68 · nome\n  claude attach 85285a68 …`) e `inventory` falso cujo `waitFor` resolve `{ sessionId: "85285a68-454d-…", bgId: "85285a68" }` → retorna os dois ids e `run` foi chamado com `["--bg","--name","nome","--permission-mode","plan","prompt"]`. Saída `Workspace not trusted. Run \`claude\` in /x once` → `WorkspaceNotTrustedError`. `stopSession` com saída `stopped 85285a68` resolve; com `No job matching '…'` rejeita `SessionNotFoundError`.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/agent && git commit -m "feat(agent): criação de sessões em background e parada por id"
```

---

### Task T17 `[O]`: Agente — despacho de comandos com idempotência

**Files:**
- Create: `apps/agent/src/commands/handle.ts`
- Modify: `apps/agent/src/main.ts` (trocar o `command.error` provisório de T09 pelo handler)
- Test: `apps/agent/test/handle.test.ts`

**Interfaces:**
- Consumes: `injectPrompt` (T15), `spawnSession`/`stopSession` (T16), `Inventory`, `readRegistry` (T04), `RelayCommand`/`AgentEvent` (T02).
- Produces: `createCommandHandler(deps: { machine; inventory; inject; spawn; stop; readRegistry; onPermissionDecide?: (requestId, behavior) => boolean }): (cmd: RelayCommand) => Promise<AgentEvent>` que devolve sempre um `command.ack` ou `command.error`:
  - `session.send`: acha a sessão no inventário (erro `sessão não encontrada nesta máquina` se ausente); precisa de `pid` → `readRegistry(pid)` (erro `sessão sem inbox (reinicie a sessão)` se ausente); `inject(...)`; `ack`.
  - `session.create`: `spawn` → `ack` com `{ sessionId, bgId }`.
  - `session.stop`: exige `bgId` (erro `só sessões em background podem ser paradas pelo Discord; use claude /exit no terminal` para interativas) → `stop` → `ack`.
  - `permission.decide`: delega a `onPermissionDecide` (T20); sem handler → erro `permissões ainda não suportadas`.
  - **Idempotência**: cache LRU em memória de 500 `commandId → resposta`; reenvio devolve a resposta guardada sem reexecutar.
  - Exceções viram `command.error` com `reason` = mensagem; nunca propagam.

- [ ] **Step 1: Testes (falham)**

Com dependências falsas: `session.send` para sessão existente chama `inject` com o socket do registro e devolve `ack`; sessão inexistente → `error` com `não encontrada`; `session.create` → `ack.result.sessionId`; `session.stop` em interativa → `error` com `background`; mesmo `commandId` duas vezes → `inject` chamado uma vez, mesma resposta; `inject` lançando → `error`, sem exceção.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/agent && git commit -m "feat(agent): despacho idempotente de comandos do relay"
```

---

### Task T18 `[O]`: Relay — mensagens da thread viram `session.send`; fila para máquina offline; acks

**Files:**
- Create: `apps/relay/src/commands.ts`
- Modify: `apps/relay/src/router.ts` (tratar `command.ack`/`command.error`), `apps/relay/src/main.ts` (assinar `messageCreate`)
- Test: `apps/relay/test/commands.test.ts`

**Interfaces:**
- Consumes: `Db.pendingCommands`, `AgentHub.send/isOnline` (T11), `DiscordPort` (T13) acrescido de `react(messageId, emoji)` e `removeReaction(messageId, emoji)`, `newEnvelope`/`RelayCommand` (T02).
- Produces: `createCommandBridge({ db, hub, port, allowedUserIds, relayMachine = "relay/vps" })` com:
  - `onThreadMessage(msg: { authorId; threadId; messageId; content; isBot })`: ignora bots e autores fora da allowlist (silêncio); resolve `sessions` por `thread_id` (ignora threads não mapeadas); se `content` começa com `/` ou `!` → `react ❌` e `post` curto `comandos do Claude não são aceitos`; monta `session.send` com `commandId = messageId`; se `hub.isOnline(machine)` → envia e `react ⏳`? **Não**: online → envia sem reação até o ack; offline → `pendingCommands.add` (expira em 1 h) e `react ⏳`.
  - `onAck(machine, ev)`: `command.ack` → `react ✅` na mensagem (`commandId` é o `messageId`) e remove ⏳; `command.error` → `react ❌` + `post` na thread `❌ <reason>`.
  - `onMachineOnline(machine)`: drena `pendingCommands.listDue(machine)` em ordem, enviando e removendo.
  - `expireLoop()` a cada 60 s: `expireBefore(now)` → para cada expirado, troca ⏳ por ❌ e posta `comando expirou: máquina offline por mais de 1 h`.

- [ ] **Step 1: Testes (falham)**

- autor fora da allowlist → nenhuma chamada em `hub.send`/`port`.
- online: `hub.send` recebe `session.send` com `text` e `commandId === messageId`; `onAck` com `command.ack` → `react("✅")`.
- offline: `pendingCommands` ganha 1 item e `react("⏳")`; `onMachineOnline` → `hub.send` chamado e fila vazia.
- `content: "/compact"` → `react("❌")` e `post` com `não são aceitos`, nada enviado.
- `command.error` → `react("❌")` e `post` com a razão.
- expirado → `react("❌")` e `post` com `expirou`.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/relay && git commit -m "feat(relay): mensagens de thread viram prompts, fila offline e reações de ack"
```

---

### Task T19 `[O]`: Relay — slash commands `/novo`, `/sessoes`, `/parar`, `/filtro` e menção ao bot

**Files:**
- Create: `apps/relay/src/discord/slash.ts`
- Modify: `apps/relay/src/discord/bot.ts` (registro dos comandos no guild), `apps/relay/src/main.ts`, `apps/relay/src/router.ts` (aplicar `filter_account`)
- Test: `apps/relay/test/slash.test.ts`

**Interfaces:**
- Consumes: `Db`, `AgentHub`, `ThreadRegistry`, `createCommandBridge` (T18), `DiscordPort` acrescido de `reply(interactionId, text, ephemeral)`.
- Produces: `registerSlashCommands(client, guildId)` (via `REST` do discord.js, `applicationGuildCommands`) e `createSlashHandler({ db, hub, threads, bridge, allowedUserIds })` tratando `interactionCreate`:
  - `/novo prompt:<string> [projeto:<choice dos projects da máquina do canal>] [modo:<default|acceptEdits|plan|bypassPermissions>]` — só em canal de máquina (resolve pelo `channel_id`); responde efêmero `criando sessão…`; envia `session.create` (`name` = primeiras 6 palavras do prompt, truncado a 60); no `ack`, `threads.ensureThread` com `bgId` e edita a resposta com link da thread; offline → fila (T18) e aviso.
  - `/sessoes` — embed com as sessões da máquina do canal: nome, estado (emoji), cwd, `há Xmin` (de `updated_at`), `attach <bgId>` quando houver.
  - `/parar` — só dentro de thread mapeada; pede confirmação com botão `Confirmar` (expira em 60 s); confirmado → `session.stop`.
  - `/filtro conta:<e-mail>` e `/filtro off` — grava `machines.filter_account`; o router passa a **silenciar** (não criar thread nem postar) sessões cuja conta da máquina no momento do `hello` difere, enquanto o filtro estiver ativo; `/filtro` sem argumentos mostra o estado atual. Sem filtro por padrão (decisão do Leonardo).
  - Menção `@bot` em canal de máquina com texto → tratada como `/novo prompt:<texto>` com os padrões.
  - Toda interação checa `allowedUserIds` (resposta efêmera `sem permissão` para outros).

- [ ] **Step 1: Testes (falham)**

Com interações falsas (objetos simples com `commandName`, `options.getString`, `channelId`, `user.id`, `reply/editReply` espiões): `/novo` em canal mapeado → `hub.send` com `session.create` e `permissionMode: "default"`; ack simulado → `threads.ensureThread` chamado com `bgId`; `/novo` fora de canal de máquina → resposta efêmera `use este comando no canal de uma máquina`; `/sessoes` → `reply` com embed contendo os nomes; `/parar` sem confirmar → nada enviado; confirmado → `session.stop`; `/filtro conta:x@y` → `filter_account` gravado e `router` deixa de criar thread para `hello` com outra conta; usuário fora da allowlist → `sem permissão`.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/relay && git commit -m "feat(relay): slash commands /novo, /sessoes, /parar, /filtro e menção ao bot"
```

---

## Entrega do M2 (checklist manual)

1. Atualizar relay na VPS (`docker compose up -d --build`) e o agente neste PC.
2. Numa thread existente, responder um prompt → ✅ e a resposta do Claude na thread.
3. Desligar o agente, mandar outro prompt → ⏳; religar → ✅ e resposta.
4. `/novo prompt:"liste os arquivos" projeto:<escolha>` → thread nova com `claude attach <id>`; abrir no terminal com o comando e ver a conversa.
5. `/parar` na thread criada → confirmação → sessão some de `claude agents`.
