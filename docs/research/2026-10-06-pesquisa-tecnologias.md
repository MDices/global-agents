# global-agents — pesquisa de tecnologias (2026-10-06)

Objetivo: decidir, antes da spec, como ligar sessões do Claude Code em vários PCs (Linux + Windows) a um canal onde eu
(um usuário) **observo** o que cada sessão faz e **comando** (mando prompts, crio chats novos, aprovo permissões), com
Discord como primeira interface e o global-pets como interface futura.

Layout desejado no Discord: um canal por máquina; dentro dele, uma thread por chat (sessão). Responder na thread manda
prompt pra sessão; um comando no canal cria um chat novo naquela máquina.

Legenda de confiança de cada afirmação:

- **VERIFICADO**: testado nesta máquina hoje (Claude Code v2.1.291, Fedora 44).
- **DOC**: lido na documentação oficial (code.claude.com/docs) ou em fonte primária citada.
- **NÃO VERIFICADO**: inferido ou não acessível; precisa de teste.

---

## 1. O que o Claude Code já oferece (lado "agente")

### 1.1 Hooks — observar (DOC + VERIFICADO no global-pets)

- `UserPromptSubmit`, `Stop`, `Notification`, `SubagentStop`, `SessionStart/End` existem e recebem JSON em stdin.
- `Stop` traz `last_assistant_message`, `transcript_path`, `stop_reason`, `session_id`, `cwd`. Não precisa mais ler o
  transcript pra pegar a resposta final (o hook do global-pets faz isso via `jq`; dá pra simplificar).
- `PermissionRequest` existe e **pode devolver `{"decision":{"behavior":"allow"|"deny"}}`** → aprovação remota de
  `Bash`/`Write`/`Edit` sem canal especial. Precisa de `timeout` longo por hook nas settings, senão expira antes de
  alguém clicar no Discord (NÃO VERIFICADO o limite máximo).
- `Notification` com tipos `agent_needs_input` / `agent_completed` dispara também para sessões em background.
- Regra de ouro herdada do global-pets: hook nunca bloqueia o Claude (timeout curto, `exit 0` sempre, fire-and-forget
  para um agente local; o agente local é quem fala com a rede).

### 1.2 Inventário de sessões — `claude agents --json` (VERIFICADO)

Lista **todas** as sessões vivas da máquina, interativas e em background, sem TTY, para scripts:

| Campo | Exemplo | Observação |
|---|---|---|
| `kind` | `interactive` / `background` | |
| `name` | `correcoes-bugs`, `gestai-8d` | nome dado com `--name`/`/rename`, ou derivado |
| `cwd` | `/home/leonardo/dev/work/gestai` | |
| `sessionId` | UUID | o mesmo do transcript e dos hooks |
| `status` | `busy` / `waiting` / `idle` | |
| `state` (só bg) | `working` / `blocked` / `done` / `failed` / `stopped` | |
| `waitingFor` | `permission prompt`, `input needed`, … | só quando `status=waiting` |
| `id` (só bg) | `85285a68` | id curto para `attach/logs/stop/rm` |
| `pid`, `startedAt` | | |

Há também um registro por sessão em `~/.claude/sessions/<pid>.json` com `messagingSocketPath`, `name`, `status`
(VERIFICADO), mas o formato interno não é contrato público.

### 1.3 Sessões em background — `claude --bg` + supervisor (VERIFICADO)

- `claude --bg --name X [--permission-mode …] "prompt"` cria uma sessão completa sem terminal, gerida por um
  supervisor local (`claude daemon status`). Sobrevive ao fechamento do terminal, dorme e acorda com a máquina.
- `claude attach <id>` abre a sessão num terminal qualquer; `←`/`Ctrl+Z` desanexa e ela continua. Windows nativo é
  suportado pela doc (DOC).
- Uma sessão interativa vira background com `←` ou `/bg`, e volta com `attach`. Ou seja: **toda sessão pode ser
  "um chat da máquina" que eu abro no terminal quando quero digitar e solto quando quero ir pro Discord.**
- `claude --resume <id> "prompt"` manda o prompt como próximo turno de uma sessão bg em execução **só a partir de um
  TTY** (ele faz `attach`). De um processo sem TTY ele recusa com exit 1 (VERIFICADO). `claude logs` devolve o
  terminal com ANSI, não serve para parse.
- Agent teams exigem sessão interativa e não nascem em `-p`/Agent SDK (DOC). Uma sessão `--bg` não é `-p`, então
  deve conseguir spawnar teammates in-process (NÃO VERIFICADO).

### 1.4 Injeção de prompt numa sessão viva — socket de inbox (VERIFICADO)

A doc de cross-session messaging diz: cada sessão expõe um **socket de inbox** (Unix socket no Linux/macOS/WSL,
named pipe no Windows) e descreve a seção "quando você quer que um script ou hook poste numa sessão".

- Caminho: `/run/user/<uid>/cc-socks/<pid>.sock` (ou `/tmp/cc-socks-<uid>`), exportado como
  `CLAUDE_CODE_MESSAGING_SOCKET`; token em `CLAUDE_CODE_MESSAGING_TOKEN`. Também em `~/.claude/sessions/<pid>.json`.
- Formato de fio capturado com um peer falso (não publicado na doc → **contrato não versionado**, `msgV: 1`):

```json
{"msgV":1,"msg_id":"<uuid>","type":"user",
 "message":{"role":"user","content":"<cross-session-message from=\"...\" from-name=\"...\" from-mode=\"bypass\">\nTEXTO\n</cross-session-message>"},
 "priority":"next","from":"<endereço do remetente>"}
```

- Teste: injetar essa linha no socket de uma sessão `--bg` fez a sessão abrir um turno novo e responder
  (VERIFICADO, 3 vezes). Chega como "Another Claude session sent a message", não como você.
- Controles de entrada (VERIFICADO):

| Receptor | Remetente | Resultado |
|---|---|---|
| plan / modo que pede permissão | sem classe | entregue |
| bypass (`--dangerously-skip-permissions`) | sem classe | **segurado**, pede aprovação no terminal |
| bypass | `from-mode="bypass"` | entregue |
| bypass + `crossSessionInbound: accept` | sem classe | entregue |

- Limites por desenho (DOC): a mensagem **não pode aprovar permissão**, slash commands viram texto, não altera
  config. Para aprovar de longe usa-se o hook `PermissionRequest` (1.1).
- Windows nativo exige a linha `{"type":"auth","token":…}`; o token é o `peerToken` do arquivo
  `~/.claude/sessions/<pid>.<hash>.key` (VERIFICADO no Toneli-PC). Sessão em container/WSL e sessão no host não se enxergam (DOC).
- Fallback se o formato mudar numa versão: `claude --resume <id> "prompt"` dirigido por um pty (node-pty), que é o
  caminho oficial para humanos.

### 1.5 Channels (research preview) — alternativa oficial de entrada (DOC)

MCP server local que empurra `<channel>` para a sessão, com tool `reply` e relay de permissão (allow/deny por id de
5 letras). Plugin oficial `discord@claude-plugins-official` existe (Bun + discord.js).

- Modelo do plugin oficial: **1 bot ↔ 1 sessão**. Cada sessão sobe o próprio cliente Discord; não há roteamento por
  sessão nem por máquina. Dois processos com o mesmo token recebem as mesmas mensagens.
- Channel próprio exige `--dangerously-load-development-channels` com diálogo de aviso em tela cheia a cada início,
  só em sessão interativa; o protocolo pode mudar. Não serve para sessão `--bg` sem alguém anexado.
- Conclusão: ótimo como referência de código (chunking, pairing, relay de permissão), ruim como base do produto.

### 1.6 Agent SDK / `claude -p --input-format stream-json` (DOC)

`@anthropic-ai/claude-agent-sdk` 0.3.x: `query()` em streaming input mode, `resume`, `canUseTool` (callback de
permissão que fica pendente até resposta), `interrupt()`, eventos estruturados. É o caminho para um daemon **dono**
das sessões. Custo: sessões do SDK não aparecem em `claude attach`, não spawnam agent teams, e o `--bare`
recomendado para scripts não usa login de assinatura (precisa `ANTHROPIC_API_KEY`).

### 1.7 Remote Control nativo (DOC)

`claude --rc` / `claude remote-control` dirige sessões locais pelo claude.ai e app; modo servidor cria sessões sob
demanda. Só claude.ai, sem API, sem Discord, sem hooks para o pet. Serve de baseline: parte do desejo já existe
pronto, mas fechado.

---

## 2. Projetos existentes e o que reaproveitar

| Projeto | O que é | Reaproveitar |
|---|---|---|
| **global-pets** (Leonardo) | Pet desktop (Electron + Svelte) que ouve hooks do Claude e mostra balão | Contrato de evento `session.status` (`idle/working/waiting/error/done`, `sessionId`, `title`, `snippet`, `transcriptPath`) como **formato de fio** do global-agents; instalador idempotente de hooks (`hookInstaller.ts`); scripts `.sh`/`.ps1` |
| **Duo** (Victor, github.com/Victorow/A2A-and-cache-semantic-for-claude) | Ponte agente↔agente entre 2 PCs via MCP/HTTP autenticado sobre Tailscale; Executor hospeda Agent SDK com suspensão/resume; cache semântico | `src/agent/host.ts` (wrapper do SDK: `resume`, `onMessage`, `shouldStop`, bypass); auth bearer em tempo constante; lição do idle-timeout de ~300 s do cliente MCP; lição "barreira real é no servidor Git". Resolve a **fatia 3** (times entre PCs), não observação/comando |
| **Plugin Discord oficial** | Channel Discord 1:1 | Pairing por código, chunking 2000, `edit_message` para progresso, relay de permissão com botões |

Conflito a decidir: Duo escolheu **custo zero + Tailscale ponto a ponto**; a ideia aqui é **VPS + Discord**.

---

## 3. Lado infra (relatório do subagente, fontes primárias)

### 3.1 Biblioteca Discord (Node/TS)

- **discord.js 14.27** (recomendado): threads (`startThread`, `autoArchiveDuration`), Components v2 (até 4000 chars
  de texto, 40 componentes), botões para Permitir/Negar.
- Vercel Chat SDK: roda em qualquer lugar, mas é thread-por-mensagem e exige state adapter; luta contra o layout.
- discord.py: maduro, fora da stack TS.

| Limite Discord | Valor |
|---|---|
| Tamanho da mensagem | 2000 chars (`content`) |
| Rate limit global | 50 req/s por bot; buckets por rota; edição ≈ 1/s é seguro |
| Thread auto-archive | 60 / 1440 / 4320 / 10080 min; mensagem nova desarquiva |
| Intent obrigatório | `MessageContent` (privilegiado; liga no portal com <100 servidores) |

### 3.2 Transporte agente local ↔ relay

- **WebSocket `ws`** de saída (PC → VPS), token, ping/pong 30 s, backoff, **outbox em disco** no agente para quando
  o PC dorme. Recomendado para 1 usuário.
- NATS/JetStream: replay e ack prontos, mas mais um serviço. Redis Pub/Sub: at-most-once, descartado.
- Tailscale (grátis até 6 usuários): camada opcional de segurança/alternativa à exposição pública; não substitui o
  protocolo nem a reconexão.

### 3.3 Injeção em terminal já aberto (sem o socket do Claude)

tmux `send-keys -l` funciona só se o Claude já estiver no tmux. TIOCSTI desligado no kernel desta Fedora. Windows
Terminal não tem send-text; `SendInput` é frágil. **Descartado como base** — o socket de inbox (1.4) resolve isso de
forma suportada.

### 3.4 Empacotamento do agente local

Node SEA e bun compile brigam com o SDK/binário do Claude. Recomendação: Node 24 LTS + pacote; Linux `systemd --user`,
Windows WinSW ou Agendador de Tarefas "ao logon".

### 3.5 VPS

`docker compose`: `caddy` (443, TLS automático, WebSocket) + `app` (discord.js + `ws` + `node:sqlite` para
`máquina→canal`, `sessão→thread`). Só a 443 exposta; Discord é sempre conexão de saída.

---

## 4. Opções de arquitetura

### Opção U — "Tudo é sessão Claude Code" (recomendada)

Agente local **fino** por máquina:

| Função | Mecanismo | Confiança |
|---|---|---|
| Observar prompts/respostas/estados | hooks → agente local → relay | VERIFICADO (global-pets) |
| Inventário de chats da máquina | `claude agents --json` + `~/.claude/sessions/*.json` | VERIFICADO |
| Mandar prompt pra chat existente (terminal ou bg) | socket de inbox (Unix socket / named pipe) | VERIFICADO (Linux e Windows) |
| Criar chat novo pelo Discord | `claude --bg --name <nome> --permission-mode … "prompt"` | VERIFICADO |
| Abrir no terminal o chat criado pelo Discord | `claude attach <id>` | VERIFICADO |
| Aprovar permissão pelo Discord | hook `PermissionRequest` → relay → botão → allow/deny | DOC |
| Times de agentes (fatia 3) | agent teams in-process dentro da sessão bg, ou Duo | NÃO VERIFICADO |

Prós: zero código de "motor", sessões iguais às do terminal (plugins, skills, memória, Remote Control, attach),
assinatura normal, funciona para sessões que eu abri no terminal. Contras: o formato do socket não é versionado
(isolar num módulo, manter fallback pty); mensagem injetada é "de outra sessão" (não aprova, não roda `/comando`).

### Opção S — Agent SDK daemon para chats do Discord + hooks para o terminal

Chats criados pelo Discord vivem num daemon (SDK streaming, `canUseTool` → botões). Chats do terminal só observados
(ou comandados via socket igual à U). Prós: eventos estruturados, permissão como callback nativo, reuso do
`host.ts` do Duo. Contras: dois tipos de sessão, sem `attach`, sem agent teams, auth por API key em `--bare`.

### Opção C — Channels

Usa o plugin oficial de Discord ou um channel próprio por sessão. Descartada como base pelos motivos de 1.5; fica
como referência de implementação e possível futuro quando sair do preview.

---

## 5. Decisões tomadas (06/10/2026, Leonardo)

| Tema | Decisão |
|---|---|
| Motor dos chats criados pelo Discord | **Opção U**: tudo é sessão Claude Code (`--bg` + socket + `attach`) |
| Rede | **VPS + WebSocket de saída**; Tailscale opcional por cima |
| Injeção em sessões com bypass | **`crossSessionInbound: accept`** nas settings de cada máquina (instalador grava) |
| Aprovação remota | hook `PermissionRequest` → relay → botões no Discord |
| Mapeamento Discord | canal por máquina + thread por sessão; comando no canal cria `--bg` |
| Formato de fio | estender `session.status` do global-pets |

## 6. Spikes executados após as decisões (06/10/2026)

| Spike | Resultado | Confiança |
|---|---|---|
| Hook `PermissionRequest` em sessão `--bg` sem ninguém anexado, hook demora 75 s e responde `allow` | Sessão ficou `blocked / permission prompt` por 75 s, recebeu o allow, rodou o `curl`, respondeu `200`. Payload traz `tool_name`, `tool_input`, `permission_suggestions`, `session_id`, `cwd`. `timeout: 600` no hook funcionou | VERIFICADO |
| Agent teams em sessão `--bg` (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `acceptEdits`) | Lead criou `alpha` e `beta` via `Agent` com `name`, trocou mensagens, recebeu `teammate-message`, mandou `shutdown_request`, consolidou "MAÇÃ BANANA". Em plan mode ele parou pedindo aprovação do plano (esperado) | VERIFICADO |
| Injeção numa sessão **interativa** com rascunho digitado no prompt | Chegou como `› Message from @discord-leonardo: … (ctrl+o to expand)`, abriu turno novo e respondeu `DELTA`; o rascunho continuou no prompt. Detalhe: sessão filha de outra sessão Claude (`CLAUDE_CODE_CHILD_SESSION`) não registra inbox nem salva transcript; o agente local deve limpar `CLAUDE_CODE_*` do ambiente ao lançar `claude` | VERIFICADO |
| Windows nativo (Toneli-PC, Claude 2.1.291, PowerShell) | `claude agents --json` e `--bg --name` funcionam. Pipe de inbox: `\\.\pipe\LOCAL\cc-msg-<hash>` (no registro `.json`). Injeção com linha `{"type":"auth","token":<peerToken do .key>}` foi entregue e respondida (`ECHO`); sem a linha de auth, nada chegou (`FOXTROT` ignorado), como a doc prevê | VERIFICADO |

Observações operacionais dos spikes:

- `claude agents --json` reflete `waitingFor: permission prompt` em tempo real: dá para o relay mostrar "aguardando aprovação" na thread mesmo sem o hook.
- Sessões de teste precisam ser removidas com `claude rm` para não poluir o agent view.
- O `.key` por sessão contém `peerToken`, `procStart` e `pidDomain`; o registro `.json` contém `messagingSocketPath` e `name`.

## 7. Próximo passo

Design em seções (arquitetura, componentes, fluxo de dados, erros, testes) → spec em `docs/superpowers/specs/` → plano.

## Fontes

- code.claude.com/docs: hooks, channels, channels-reference, cli-reference, sessions, agent-view,
  cross-session-messaging, remote-control, agent-teams, headless, agent-sdk/*, env-vars.
- github.com/anthropics/claude-plugins-official/external_plugins/discord (server.ts, ACCESS.md).
- /run/media/leonardo/421A73401A733051/DriveD/global-pets (ADR 0003, hook .sh, hookInstaller.ts, packages/protocol).
- github.com/Victorow/A2A-and-cache-semantic-for-claude (README, CONTEXT.md, design.md, src/agent/host.ts).
- Relatório de infra do subagente (discord.js, Chat SDK, ws, NATS, Tailscale, SEA, WinSW, Caddy), copiado para o scratchpad da sessão.
