# global-agents — Plano parte 3: M3 Permissões, M4 Windows, M5 Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Leia antes o índice `2026-10-06-global-agents-plan.md` e a spec. Pré-requisito: partes 1 e 2 entregues.

Etiquetas: `[S]` Sonnet, `[O]` Opus.

---

### Task T20 `[O]`: Agente — permissões pendentes (segurar o hook `PermissionRequest`)

**Files:**
- Create: `apps/agent/src/permissions/pending.ts`
- Modify: `apps/agent/src/main.ts` (ligar `onPermission` do servidor de hooks ao `PendingPermissions`; ligar `onPermissionDecide` do handler de comandos), `apps/agent/src/hooks/mapper.ts` (não muda; `PermissionRequest` continua fora do mapper)
- Test: `apps/agent/test/pending.test.ts`

**Interfaces:**
- Consumes: `PermissionPayload`/`HookDecision` do servidor (T05), `Inventory` (T04), `AgentEvent` (T02).
- Produces: `class PendingPermissions` — `constructor({ machine; inventory; emit: (ev: AgentEvent) => void; ttlMs = 30 * 60_000; terminalPollMs = 2000 })`; `open(payload: PermissionPayload, respond: (d: HookDecision | null) => void): string` gera `requestId` (uuid), guarda, emite `permission.request` com `tool = tool_name`, `description = tool_input.description ?? ""`, `inputPreview = JSON.stringify(tool_input, null, 0).slice(0, 3500)`, `expiresAt`; `decide(requestId, behavior): boolean` → `respond({ behavior })`, emite `permission.resolved by=remote`, remove (false se desconhecido ou já resolvido, Review Focus 7); vigia: a cada `terminalPollMs`, se a sessão deixou de estar `waiting` no inventário, `respond(null)` e emite `resolved by=terminal`; ao estourar `ttlMs`, `respond({ behavior: "deny" })` e emite `resolved by=timeout`. `close()` responde `null` a todas.

- [ ] **Step 1: Testes (falham)** (relógio falso)

- `open` emite `permission.request` com `requestId` e `expiresAt ≈ agora + 30 min`; `decide(id, "allow")` chama `respond({behavior:"allow"})`, emite `resolved by=remote behavior=allow`, e um segundo `decide` devolve `false`.
- inventário falso muda a sessão de `waiting` para `idle` → `respond(null)` e `resolved by=terminal`.
- avanço de 30 min sem decisão → `respond({behavior:"deny"})` e `resolved by=timeout`.
- `decide("desconhecido", "allow")` → `false`, sem exceção.
- `inputPreview` de um `tool_input` de 10 kB fica com `<= 3500` chars.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/agent && git commit -m "feat(agent): permissões pendentes seguram o hook até decisão remota, terminal ou expiração"
```

---

### Task T21 `[O]`: Relay — cards de permissão com botões Permitir/Negar

**Files:**
- Create: `apps/relay/src/discord/cards.ts`
- Modify: `apps/relay/src/router.ts` (`permission.request`/`permission.resolved`), `apps/relay/src/main.ts` (`interactionCreate` para botões)
- Test: `apps/relay/test/cards.test.ts`

**Interfaces:**
- Consumes: `Db.permissions`, `AgentHub.send`, `DiscordPort` acrescido de `postCard(threadId, card): Promise<{ messageId }>` e `editCard(messageId, card)`.
- Produces: `buildPermissionCard(req, state: "pending" | { by; behavior?; who?; at })` → `{ embed: { title: "🔐 Permissão: <tool>", description, fields: [prévia em bloco de código ≤ 1000 chars, "expira <t>"], color }, buttons: [Permitir(verde, customId "perm:allow:<requestId>"), Negar(vermelho, "perm:deny:<requestId>")] | [] }`; `createPermissionFlow({ db, hub, port, allowedUserIds })` com `onRequest(machine, ev)` (posta card, grava `permissions`), `onButton(interaction)` (checa allowlist; `permission.decide` com `commandId = "perm-"+requestId+"-"+behavior`; edita o card para "decidindo…"; clique repetido é idempotente: se `status != pending`, responde efêmero `já decidido`), `onResolved(ev)` (edita o card: `✅ permitido por @leonardo às 11:46 via Discord` / `🖥️ decidido no terminal` / `⏳ expirou (negado automaticamente)`; remove botões).

- [ ] **Step 1: Testes (falham)**

`permission.request` → `postCard` com título contendo `Bash`, 2 botões; clique `perm:allow:<id>` de usuário permitido → `hub.send` com `permission.decide allow`, `editCard` sem botões; segundo clique → resposta `já decidido`, sem novo `hub.send`; `permission.resolved by=terminal` → `editCard` com `terminal`; usuário fora da allowlist → `sem permissão` e nada enviado; prévia de 5000 chars cortada a 1000 com `…`.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/relay && git commit -m "feat(relay): cards de permissão com botões e desfecho editado"
```

---

### Task T22 `[S]`: Agente — `doctor` e `status`

**Files:**
- Create: `apps/agent/src/doctor.ts`
- Modify: `apps/agent/src/cli.ts`
- Test: `apps/agent/test/doctor.test.ts`

**Interfaces:**
- Produces: `runDoctor(deps): Promise<Check[]>` com `Check = { name; ok; detail }` para: versão do `claude` ≥ 2.1.234 (Windows) / 2.1.224 (Linux); `claude agents --json` responde; hooks instalados nos 5 eventos; `crossSessionInbound` é `accept`; diretório de sockets acessível (`/run/user/<uid>/cc-socks` ou `/tmp/cc-socks-<uid>`; no Windows, existência de `~/.claude/sessions/*.key`); relay alcançável (`https GET /health` com pinning); fingerprint confere. CLI imprime tabela com ✅/❌ em português e sai 1 se algum falhar.

- [ ] **Step 1: Testes (falham)**: com dependências falsas, cada check produz `ok` certo; versão `2.1.200` → `ok: false` com detalhe mencionando a mínima.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/agent && git commit -m "feat(agent): comando doctor com checks de ambiente"
```

---

### Task T23 `[O]`: Agente — fallback por pty para `claude --resume <id> "prompt"`

**Files:**
- Create: `apps/agent/src/claude/fallback-pty.ts`
- Modify: `apps/agent/src/commands/handle.ts` (usar fallback quando `inject` lançar `InboxFormatError`), `apps/agent/package.json` (`node-pty` como `optionalDependency`)
- Test: `apps/agent/test/fallback-pty.test.ts` (só com `GLOBAL_AGENTS_E2E=1` e `claude` real; unit do parser de saída sempre)

**Interfaces:**
- Produces: `resumeViaPty({ sessionId, text, claudeBin, timeoutMs = 20000 }): Promise<void>` — abre `node-pty` com env limpo, roda `claude --resume <sessionId> "<text>"`, espera a linha `Sent your prompt to the background session` (sucesso) ou `Your prompt was not sent` / `not running in the background` (erro com a frase), envia `\x1a` (Ctrl+Z) e mata o processo. Emite `agent.warning` via callback `onWarning("usando modo compatível: formato do inbox mudou")`. Se `node-pty` não carregar → erro `fallback indisponível (node-pty não instalado)`.

- [ ] **Step 1: Testes**: `parsePtyOutput(chunk)` reconhece as três frases com ANSI no meio; e2e opcional cria `--bg`, chama `resumeViaPty`, confere no transcript.

- [ ] **Step 2: Implementação e commit**

```bash
git add apps/agent && git commit -m "feat(agent): fallback de injeção por pty quando o formato do inbox muda"
```

---

### Task T24 `[S]`: Windows — serviço WinSW, instalador e e2e no Toneli-PC

**Files:**
- Create: `deploy/agent/global-agents-winsw.xml`, `deploy/agent/install-windows.ps1`
- Modify: `apps/agent/src/cli.ts` (`install --service` no Windows grava o XML em `%LOCALAPPDATA%\global-agents\` e imprime os comandos `winsw install/start`)
- Test: `apps/agent/test/e2e-windows.test.ts` (só `GLOBAL_AGENTS_E2E=1` e `process.platform === "win32"`)

Conteúdo do XML: `<service><id>global-agents</id><name>global-agents</name><executable>node</executable><arguments>"%LOCALAPPDATA%\global-agents\app\apps\agent\dist\main.js" run</arguments><logpath>%LOCALAPPDATA%\global-agents\logs</logpath><onfailure action="restart" delay="10 sec"/><serviceaccount><username>%USERDOMAIN%\%USERNAME%</username><allowservicelogon>true</allowservicelogon></serviceaccount></service>` — **precisa rodar como o usuário** (sockets/pipes e `~/.claude` são por usuário); documentar que o WinSW pedirá a senha ou usar Agendador de Tarefas "ao logon" como alternativa sem senha.

e2e Windows reproduz `docs/research/spikes/windows-inbox-spike.ps1` via `injectPrompt` real (auth com `peerToken`) e confere o transcript.

- [ ] **Step 1: Teste e2e (falha sem ambiente)**, **Step 2: Implementação**, **Step 3: Leonardo roda no Toneli-PC e cola a saída**; commit:
```bash
git add deploy/agent apps/agent && git commit -m "feat(agent): serviço Windows via WinSW e e2e no Windows"
```

---

### Task T25 `[S]`: Linux — unidade `systemd --user` e `install --service`

**Files:**
- Create: `deploy/agent/global-agents.service`
- Modify: `apps/agent/src/cli.ts`
- Test: `apps/agent/test/service-unit.test.ts` (gera o texto da unidade e valida campos)

Unidade: `[Unit] Description=global-agents (Claude Code ↔ Discord) After=network-online.target` / `[Service] ExecStart=%h/.global-agents/app/node_modules/.bin/global-agents run Restart=on-failure RestartSec=5 Environment=NODE_ENV=production` / `[Install] WantedBy=default.target`. `install --service` grava em `~/.config/systemd/user/global-agents.service` e imprime `systemctl --user daemon-reload && systemctl --user enable --now global-agents` e `loginctl enable-linger $USER`.

```bash
git add deploy/agent apps/agent && git commit -m "feat(agent): unidade systemd --user e install --service no Linux"
```

---

### Task T26 `[O]`: Deploy do relay na VPS (isolado) e runbook

**Files:**
- Create: `docs/install.md`, `deploy/relay/firewall.sh`
- Modify: `deploy/relay/docker-compose.yml` (revisar limites e volume `./data:/data`), `deploy/relay/.env.example`

Passos do runbook (executados pelo Leonardo ou por um subagente **com confirmação dele antes de cada comando que muda estado na VPS**):
1. `ssh ubuntu@163.176.107.229 'mkdir -p ~/global-agents'`; copiar `deploy/relay/*` e o build (`rsync` do repositório, sem `node_modules`).
2. `firewall.sh`: `sudo iptables -I INPUT 5 -p tcp --dport 8443 -m state --state NEW -j ACCEPT && sudo netfilter-persistent save` (instalar `iptables-persistent` se faltar) — **não** toca em regras existentes. Liberar 8443 na security list da Oracle (console web, manual).
3. `docker compose up -d --build`; `docker compose logs relay | grep fingerprint`.
4. `docker compose exec relay node apps/relay/dist/cli.js machine add fedora/leonardo` e `… machine add toneli-pc/admin`.
5. Verificação: `openssl s_client -connect 163.176.107.229:8443 </dev/null 2>/dev/null | openssl x509 -fingerprint -sha256 -noout` confere com o log; `docker stats --no-stream relay` mostra `< 512 MiB`.
6. Rollback: `docker compose down`, `sudo iptables -D INPUT -p tcp --dport 8443 -m state --state NEW -j ACCEPT && sudo netfilter-persistent save`.
7. Backup: cron do usuário `0 3 * * * docker compose -f ~/global-agents/docker-compose.yml exec -T relay node apps/relay/dist/cli.js backup`.

`docs/install.md` cobre: criar o bot no portal do Discord (intent `Message Content`, `Public Bot` desligado, permissões: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History, Add Reactions, Use Slash Commands), convite ao servidor, `.env`, instalação do agente em Linux e Windows, `doctor`, e solução de problemas (os erros da spec §8).

```bash
git add docs deploy && git commit -m "docs: runbook de deploy isolado na VPS e guia de instalação"
```

---

### Task T27 `[O]`: Revisão final de branch e endurecimento

Rodar `superpowers:requesting-code-review` sobre toda a branch com foco em: Global Constraints do índice (grep por `CLAUDE_CODE_` fora de `exec.ts`; `msgV` só em `inject.ts`; nenhuma referência ao outro projeto da VPS), Review Focus 1–7 com os testes correspondentes presentes, limites do Discord, e `pnpm -r test` com `GLOBAL_AGENTS_E2E=1` neste PC. Corrigir achados em tarefas pequenas `[S]` ou `[O]` conforme a natureza, cada uma com teste.

---

## Entrega final (M3–M5)

1. Permissão: numa sessão em `default`, pedir um `curl`; card aparece na thread; clicar Permitir; o comando roda; card editado.
2. Windows: Toneli-PC com serviço instalado, canal `#toneli-pc-admin` no Discord, prompt via thread respondido.
3. `global-agents doctor` verde nas duas máquinas; `docker stats` do relay dentro do limite; backup noturno gerado.
