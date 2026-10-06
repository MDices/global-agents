# Bridge Claude Code ↔ VPS ↔ Discord — comparativo (2026-10-06)

Fontes: docs oficiais e repositórios primários; itens não confirmados marcados **NÃO VERIFICADO**.

## 1. Biblioteca do bot Discord (Node/TS)

- **discord.js**: `14.27.0` no npm, `engines.node >=18` (registry.npmjs.org/discord.js/latest); o site da branch `main` já exige "Node.js 24.17.0 or newer" (discord.js.org/docs/packages/discord.js/main) — provável próxima major. Threads: `channel.threads.create()` / `message.startThread()`, `autoArchiveDuration`, `setArchived()` (discordjs.guide/popular-topics/threads). Components v2: `MessageFlags.IsComponentsV2`, `TextDisplayBuilder`/`ContainerBuilder`; limite de **40 componentes e 4000 chars** de texto, e não pode coexistir com `content`/`embeds` (discordjs.guide/popular-topics/display-components).
- **Chat SDK (Vercel)**: `chat` e `@chat-adapter/discord` em `4.41.1`, MIT; o adapter depende de `discord.js ^14.25.1` por baixo. Não exige Vercel: "Gateway WebSocket (required for messages) … Requires a persistent connection"; o modo cron de 9 min é só para serverless. Streaming = "Post+Edit fallback" (`streamingUpdateIntervalMs`, 500 ms). Exige **state adapter** (memory/Redis/Postgres) para subscriptions/locks/dedup. Modelo de thread é **uma thread por mensagem top-level** ("Top-level messages use the adapter's normal per-message Discord thread", opção `respondToChannelIds`) — não é o layout "comando cria sessão → thread explícita". Modals: não; ephemeral: só via DM (github.com/vercel/chat, packages/adapter-discord/README.md).
- **discord.py**: `2.7.1` (03/2026), Python ≥3.8 (pypi.org/project/discord.py). Maduro, mas fora da stack TS do relay.
- Limites da API: `content` até **2000 chars** (docs.discord.com/developers/resources/message); global **50 req/s** por bot, buckets por rota via headers `X-RateLimit-Remaining`/`X-RateLimit-Reset-After`/`Retry-After`, 10.000 inválidas/10 min bloqueia o IP (docs.discord.com/developers/topics/rate-limits). Limite específico de edição (o folclórico "5 edits/5 s") **NÃO VERIFICADO** na doc — tratar PATCH como bucket por rota e acelerar edits a ~1/s lendo os headers.
- Threads: `auto_archive_duration` ∈ {60, 1440, 4320, 10080} min; nome 1–100 chars; "Sending a message will automatically unarchive the thread, unless the thread has been locked" (docs.discord.com/developers/topics/threads, resources/channel). Há teto de threads ativas por guild (número não publicado).
- Intents: `Guilds` + `GuildMessages` + **`MessageContent` (privilegiado)** para ler `content`; sem ele só chega conteúdo de DMs, menções ao bot e mensagens do próprio bot. Em <100 servidores basta ligar no portal (docs.discord.com/developers/events/gateway).

**Recomendação:** discord.js 14 direto. O Chat SDK roda em qualquer lugar, mas seu modelo thread-por-mensagem + state adapter obrigatório luta contra o layout desejado e adiciona camada sobre o mesmo discord.js. Streaming: acumular deltas e editar a mensagem ≤1×/s; ao passar de ~1900 chars, fechar a mensagem e abrir outra (ou Components v2 até 4000).

## 2. Transporte agente local ↔ relay

- **WebSocket (`ws` 8.22.0)**: sem reconexão automática — "Users must implement their own reconnection logic"; a doc traz o padrão ping/pong de 30 s para detectar conexão morta (github.com/websockets/ws). Conexão sempre de saída (PC → VPS), token no header/primeira mensagem; buffer offline = fila em disco no agente (SQLite/JSONL) reenviada após reconectar, com ids idempotentes.
- **NATS/JetStream**: `nats-server v2.15.0` (17/09/2026) com binários linux/windows amd64 (github.com/nats-io/nats-server/releases); JetStream dá "at-least-once delivery … messages survive restarts and can be replayed" (docs.nats.io/nats-concepts/jetstream). Resolve buffer offline de graça, mas é mais um serviço + porta.
- **Redis Pub/Sub**: "at-most-once … If the subscriber is unable to handle the message … the message is forever lost"; Streams seriam a alternativa persistente (redis.io/docs/latest/develop/pubsub). Péssimo encaixe para PCs que dormem.
- **MQTT**: não avaliado neste relatório.
- **Tailscale**: plano Personal "Up to 6 users / Unlimited user devices", gratuito (tailscale.com/pricing). Elimina exposição pública, mas o relay ainda precisa de um protocolo (HTTP/WS) e de reconexão.

**Recomendação (1 usuário):** `ws` outbound + token + heartbeat + backoff exponencial + outbox em disco no agente. Tailscale como camada opcional de segurança por cima, não como substituto do protocolo. NATS só se quiser replay/ack prontos sem escrever a fila.

## 3. Injetar texto num terminal interativo já em execução

- **Linux / tmux**: `send-keys -l` "disables key name lookup and processes the keys as literal UTF-8 characters", `-t target-pane` (man7.org/linux/man-pages/man1/tmux.1.html). Robusto, **mas exige que o Claude já esteja dentro do tmux**.
- **Linux / screen**: `-X` "Send the specified command to a running screen session" (man.archlinux.org/man/screen.1); o subcomando `stuff` **NÃO VERIFICADO** (página não acessível).
- **TIOCSTI**: Kconfig upstream `LEGACY_TIOCSTI … default y`, descrito como "malicious privilege escalation mechanism … can be disabled on most systems" (drivers/tty/Kconfig). Nesta Fedora 44 (kernel 7.1): `dev.tty.legacy_tiocsti = 0` e `CONFIG_LEGACY_TIOCSTI is not set` — ou seja, distros modernas desligam. Escrever em `/dev/pts/N` sem TIOCSTI só ecoa na tela, não vira input. Descartar.
- **Claude Code nativo**: `claude --resume <id>` numa *background session* em execução "opens that session … through `claude attach`, and a prompt you pass on the command line goes to it as its next turn" (code.claude.com/docs/en/cli-reference). Pista oficial de injeção, mas só para sessões iniciadas com `--bg`; detalhes além dessa frase **NÃO VERIFICADO**.
- **Windows**: `wt.exe` só tem `new-tab`, `split-pane`, `focus-tab`, `move-focus`, `move-pane`, `swap-pane` — nenhum comando envia texto a um painel (learn.microsoft.com/windows/terminal/command-line-arguments). `SendInput` "is subject to UIPI … inject input only into applications that are at an equal or lesser integrity level" e injeta na fila global de entrada (janela em foco) — frágil por definição (learn.microsoft.com, nf-winuser-sendinput). ConPTY: o host cria os pipes e "can use the write end of the input pipe to send user interaction information" — funciona, mas só para processos que **o seu wrapper** lançou (learn.microsoft.com/windows/console/creating-a-pseudoconsole-session). `wezterm cli send-text --pane-id` existe (wezterm.org/cli/cli/send-text.html); suporte Windows **NÃO VERIFICADO**. WSL2 roda kernel Linux real com systemd, então tmux dentro do WSL funciona igual ao Linux (learn.microsoft.com/windows/wsl/compare-versions).

**Recomendação:** não construir o produto em cima de injeção. Linux: suportar apenas "Claude dentro de tmux" (`send-keys -l` + `Enter`). Windows: WSL2+tmux ou nada. O caminho sólido é o daemon ser dono das sessões (tópico 4); injeção em TUI fica como extra best-effort.

## 4. Claude Code headless de longa duração

- **`@anthropic-ai/claude-agent-sdk` 0.3.291**, Node ≥18, peers `zod ^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`; traz o binário do Claude Code como optionalDependency por plataforma e o roda como subprocesso (registry.npmjs.org; code.claude.com/docs/en/agent-sdk/typescript).
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })`; `Options`: `resume`, `continue`, `forkSession`, `resumeSessionAt`, `cwd`, `permissionMode`, `canUseTool`, `includePartialMessages`, `persistSession`. Métodos: `interrupt()`, `streamInput()`, `setPermissionMode()`, `setModel()`, `close()` — os de controle só em **streaming input mode**.
- Doc oficial: streaming input é "the **preferred** way … allows the agent to operate as a long lived process that takes in user input, handles interruptions, surfaces permission requests"; single-message "does not support … Dynamic message queueing, Real-time interruption, Natural multi-turn conversations" (code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
- `canUseTool(toolName, input, {suggestions})` → `{behavior:"allow", updatedInput}` ou `{behavior:"deny", message}`; também recebe `AskUserQuestion`; nunca dispara para tools já auto-aprovadas (agent-sdk/user-input, agent-sdk/permissions). Encaixa direto em botões Discord "Permitir/Negar".
- Sessões: id vem no `system/init`/`result`; ficam em `~/.claude/projects/<cwd-codificado>/*.jsonl`, "**Same machine only**"; para outro host, `SessionStore` adapter ou copiar o `.jsonl` (agent-sdk/sessions). Logo o mapeamento no VPS é só um ponteiro para um transcript que vive no PC.
- CLI cru: `claude -p --input-format stream-json --output-format stream-json --verbose [--include-partial-messages] [--replay-user-messages] [--permission-prompt-tool mcp_x] [--session-id uuid] [--resume id]` (code.claude.com/docs/en/cli-reference). Mesmo motor, mas você reimplementa o protocolo que o SDK já encapsula. Caveats: `--bare` é "the recommended mode for scripted and SDK calls, and will become the default for `-p`" e "doesn't use your subscription login" (precisa `ANTHROPIC_API_KEY`) — importante se você usa assinatura; SIGTERM deixa o turno inacabado (code.claude.com/docs/en/headless).

**Recomendação:** SDK TS em streaming input mode, um `query()` vivo por sessão/thread, `canUseTool` → botões no Discord, `resume` após restart do daemon. Spawn manual do CLI só se quiser zero dependência npm.

## 5. Empacotamento do agente local

- **Node SEA**: "Stability: 1.1 – Active development"; CI só em Windows, macOS arm64 e Linux (não Alpine); `require/import` só de built-ins sem VFS; addons nativos não carregam do VFS; `mainFormat: module` incompatível com snapshot (nodejs.org/api/single-executable-applications). Conflita com o SDK, que traz binário nativo por plataforma.
- **bun build --compile**: cross-compila linux/windows/mac x64+arm64, mas "Bun's binary is still way too big" (bun.com/docs/bundler/executables); SDK roda em bun (`executable: 'bun'`) mas o binário do Claude Code continua sendo arquivo externo.
- **Go**: binário pequeno, mas teria que reimplementar o protocolo stream-json e perder o SDK.
- **Supervisores**: pm2 `startup` não tem Windows nativo (indica `pm2-installer`) (pm2.keymetrics.io/docs/usage/startup); NSSM estável `2.24 (2014-08-31)`, pré-release `2.24-101` de 2017 (nssm.cc); **WinSW** MIT, ativo, wrapper XML para serviço Windows (github.com/winsw/winsw).

**Recomendação:** não compilar. `node` LTS 24 + o pacote do agente; Linux: unidade `systemd --user`; Windows: WinSW (ou Agendador de Tarefas "ao logon"). Node 24.21.0 é o LTS atual (github.com/nodejs/node/releases).

## 6. Hospedagem no VPS

- **Um processo**: bot Discord e servidor WS no mesmo Node simplifica roteamento thread↔sessão em memória; separar só se precisar reiniciar o bot sem derrubar os agentes. Para 1 usuário, um processo.
- **Persistência**: `node:sqlite` é "Stability: 1.2 – Release candidate" desde v25.7 (disponível desde 22.5) (nodejs.org/api/sqlite.html) — zero deps para a tabela `machine → channel_id`, `session_id → thread_id`, `cwd`, `last_seen`. Volume Docker para o `.db`.
- **Exposição**: apenas `443` via Caddy; `reverse_proxy` "supports WebSocket connections, performing the HTTP upgrade request" e Automatic HTTPS "provisions TLS certificates … and keeps them renewed" via Let's Encrypt/ZeroSSL (caddyserver.com/docs). Discord é sempre conexão de saída (gateway), então nada mais precisa abrir.
- Reconexão do gateway Discord é feita pelo discord.js; a do WS dos agentes é sua (tópico 2).

**Recomendação:** `docker compose` com 2 serviços: `caddy` (443→app:8080, path `/ws`) e `app` (discord.js + `ws` + `node:sqlite`, volume `/data`). Token por máquina em env/arquivo; tudo o mais fechado.
