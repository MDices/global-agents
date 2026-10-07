# Instalação do global-agents

Guia de ponta a ponta: bot do Discord → relay na VPS (isolado) → agente em cada máquina → verificação.

Arquitetura em uma linha: cada máquina roda um **agente** que conecta por WebSocket (`wss://<ip>:8443/ws`) ao **relay** na VPS; o relay conversa com o Discord.

## 1. Criar o bot no Discord

1. Em <https://discord.com/developers/applications>, **New Application** → nome à sua escolha.
2. Aba **Bot**:
   - **Reset Token** e guarde o token (só aparece uma vez). Ele vai direto para o `.env` **na VPS**; não cole em chat nem em commit.
   - **Public Bot**: **desligado**.
   - **Privileged Gateway Intents** → **Message Content Intent**: **ligado**.
3. Aba **OAuth2 → URL Generator**:
   - Scopes: `bot` e `applications.commands`.
   - Bot Permissions (nomes da interface em português entre parênteses):
     - Manage Channels (Gerenciar canais): cria a categoria e os canais das máquinas e edita o tópico.
     - View Channels (Ver canais).
     - Send Messages (Enviar mensagens).
     - Create Public Threads (Criar tópicos públicos).
     - Send Messages in Threads (Enviar mensagens em tópicos).
     - Pin Messages (Fixar mensagens): fixa a mensagem de abertura da thread.
     - Manage Threads (Gerenciar tópicos): renomeia a thread com o emoji de estado.
     - Embed Links (Inserir links): sem ela os embeds (cabeçalho da thread, cards de permissão) não aparecem.
     - Read Message History (Ver histórico de mensagens).
     - Add Reactions (Adicionar reações).
     - Use Application Commands (Usar comandos de barra).
   - Não marque Administrator, Manage Messages, Attach Files nem permissões de voz.
4. Abra a URL gerada e convide o bot para o seu servidor.
5. IDs (Discord → Configurações → Avançado → **Modo desenvolvedor** ligado):
   - ID do servidor: botão direito no ícone do servidor → **Copiar ID do servidor** (`DISCORD_GUILD_ID`).
   - Seu ID de usuário: botão direito no seu nome → **Copiar ID do usuário** (`ALLOWED_USER_IDS`; vários separados por vírgula).

## 2. Relay na VPS (isolado)

A VPS já hospeda outro projeto que usa as portas 80/443 e tem o próprio Docker Compose. O relay **não toca nisso**:

- diretório próprio: `~/global-agents`;
- projeto Compose próprio (`name: global-agents-relay`), com rede e volume (`./data`) próprios;
- só a porta **8443** é publicada;
- a única mudança fora de `~/global-agents` é **uma regra de firewall** para a 8443 (mais a liberação na security list da Oracle).

Todos os comandos abaixo são executados **na VPS** (`ssh ubuntu@<ip-da-vps>`), exceto o `rsync`.

1. **Copiar o repositório** (da sua máquina), só o código-fonte:
   ```bash
   ssh ubuntu@<ip-da-vps> 'mkdir -p ~/global-agents'
   rsync -az --delete --exclude .git --exclude node_modules --exclude dist --exclude .superpowers \
     --exclude 'deploy/relay/data' --exclude 'deploy/relay/.env' \
     ./ ubuntu@<ip-da-vps>:~/global-agents/
   ```
   (Alternativa: `git clone <url> ~/global-agents` na VPS.) `.git`, `node_modules`, `dist` e `.superpowers` (anotações
   locais de desenvolvimento) não vão para a VPS: a imagem é construída lá. Os excludes de `.env` e `data` protegem o
   segredo e o banco em atualizações futuras (o `--delete` não os apaga).
2. **Configurar o `.env` na VPS** (o token nunca passa pelo chat):
   ```bash
   cd ~/global-agents/deploy/relay
   cp .env.example .env
   chmod 600 .env
   nano .env        # DISCORD_TOKEN, DISCORD_GUILD_ID, ALLOWED_USER_IDS
   ```
3. **Diretório de dados** com o dono certo (o relay roda como uid 1000):
   ```bash
   sudo install -d -o 1000 -g 1000 data
   ```
4. **Firewall** (idempotente; insere a regra da 8443 antes do `REJECT` final do `INPUT`, sem mexer nas demais):
   ```bash
   sudo bash firewall.sh
   sudo iptables -L INPUT --line-numbers -n     # confira: 22, 80, 443 e 8443 antes do REJECT
   ```
   O script aplica a regra ao vivo e a grava **só** em `/etc/iptables/rules.v4` (com backup `rules.v4.bak-<data>` e escrita atômica). Ele **não** usa `netfilter-persistent save`, que gravaria as cadeias do Docker do outro projeto e conflitaria com o Docker no boot. Se o `rules.v4` não existir, ele avisa que a regra não sobrevive a um reboot (e não cria o arquivo).
5. **Security list da Oracle Cloud** (console web, feito por você): VCN → Subnet → Security List → *Add Ingress Rule*: origem `0.0.0.0/0`, TCP, porta de destino `8443`.
6. **Subir o relay**:
   ```bash
   docker compose up -d --build
   docker compose logs relay | grep fingerprint
   ```
   Anote o fingerprint SHA-256 (`AA:BB:…`). Ele identifica o certificado autoassinado; os agentes o fixam.
7. **Conferir o certificado de fora** (opcional, da sua máquina): 
   ```bash
   openssl s_client -connect <ip-da-vps>:8443 </dev/null 2>/dev/null | openssl x509 -fingerprint -sha256 -noout
   ```
   Deve bater com o do log. E, na VPS, `docker stats --no-stream` mostra o relay abaixo de 512 MiB.
8. **Registrar cada máquina** (imprime o token **uma única vez**; o relay guarda só o hash):
   ```bash
   docker compose exec relay node dist/cli.js machine add fedora/leonardo
   docker compose exec relay node dist/cli.js machine add toneli-pc/admin
   docker compose exec relay node dist/cli.js machine list
   ```
   O nome é `hostname/usuario`, em minúsculas. Para gerar um token novo de uma máquina existente: `machine add <nome> --force`.

### Backup

O comando `backup` grava `~/global-agents/deploy/relay/data/backups/<data>.db`. Agende no cron do usuário (`crontab -e`):

```
0 3 * * * cd ~/global-agents/deploy/relay && docker compose exec -T relay node dist/cli.js backup
```

Os backups ficam na própria VPS; copie-os para fora de vez em quando.

### Atualizar

Repita o `rsync` do passo 1 e, em `~/global-agents/deploy/relay`, rode `docker compose up -d --build`.

### Rollback / remoção completa

```bash
cd ~/global-agents/deploy/relay
docker compose down                 # para o relay (o ./data é mantido)
sudo bash firewall.sh --remove      # apaga só a regra do 8443 (viva e no rules.v4)
```
Depois remova a regra de entrada 8443 da security list da Oracle e, se quiser apagar tudo, `rm -rf ~/global-agents`. O outro projeto da VPS não é afetado em nenhum momento.

## 3. Agente em Linux

Requisitos: Node.js ≥ 24, pnpm, Git, Claude Code já logado.

```bash
git clone <url-do-repositorio> ~/dev/global-agents && cd ~/dev/global-agents
pnpm install && pnpm --filter '@global-agents/agent...' build
read -rsp 'token: ' GLOBAL_AGENTS_TOKEN; echo; export GLOBAL_AGENTS_TOKEN   # não fica no histórico do shell
node apps/agent/dist/cli.js install \
  --relay wss://<ip-da-vps>:8443/ws \
  --fingerprint '<AA:BB:…>' \
  --project ~/dev/meu-projeto \
  --service
unset GLOBAL_AGENTS_TOKEN
```
(`--token <token>` também funciona, mas fica no histórico do shell e aparece no `ps`; `--project` pode repetir.) Isso grava a config em `~/.global-agents`, copia os scripts de hook e instala os hooks em `~/.claude/settings.json`.

O `--service` grava a unidade systemd de usuário e **imprime** os comandos para ativá-la (`install` sem `--service` só grava config e hooks; reinstalar mantém o que não foi passado).
Rode os comandos `systemctl --user …` e `loginctl enable-linger …` que ele imprimir (o linger mantém o agente de pé sem sessão aberta). Sem `--service`, use `node apps/agent/dist/cli.js run` num terminal.

Verifique:
```bash
node apps/agent/dist/cli.js status
node apps/agent/dist/cli.js doctor      # nenhum ❌
```

## 4. Agente em Windows

Veja [windows.md](./windows.md) (Agendador de Tarefas por usuário, instalador PowerShell e checklist de validação).

## 5. Checklist de verificação

- [ ] `doctor` sem ❌ e `status` com `agente: rodando` em cada máquina.
- [ ] No Discord, o **canal da máquina** aparece (dentro da categoria criada pelo relay).
- [ ] Numa sessão do Claude Code (`claude --bg --name teste`), uma **thread** surge com o prompt e a resposta.
- [ ] `/novo` cria uma sessão nova a partir do Discord.
- [ ] Uma ferramenta que exige permissão gera o **card de permissão**; Aprovar/Negar chega à sessão.
- [ ] `docker compose logs relay` sem erros repetidos.

## 6. Solução de problemas

| Sintoma | O que fazer |
|---|---|
| **Agente fora do ar** / sessão não aparece | `status` diz "não está rodando"? Suba com `systemctl --user start global-agents` (ou `run` num terminal). Com o agente fora, o hook falha o POST em 2 s e sai 0, então o Claude segue normal; um `PermissionRequest` sem agente não imprime nada e o prompt de permissão fica no terminal. |
| **`peerProtocol` ≠ 1** | O agente cai no modo compatível (fallback por PTY) e mostra um aviso (`agent.warning`) na thread. Atualize o Claude Code/agente se persistir. |
| **VPS fora do ar** | O agente guarda os eventos em disco e os reenvia em ordem na volta. Confira `docker compose ps` e `docker compose logs relay`. Comandos para máquina offline ficam 1 h na fila. |
| **Fingerprint não confere** (o agente recusa o certificado) | O certificado mudou (`data/` apagado) ou há alguém no meio do caminho. Confirme com `docker compose exec relay node dist/cli.js fingerprint`; se for o seu relay, reinstale o agente com o fingerprint novo (`install … --fingerprint`). |
| **401 / token recusado** | Token errado ou máquina não registrada. `machine list` na VPS; gere outro com `machine add <nome> --force` e rode `install` de novo no agente. |
| **`EACCES` / "não é gravável" em `data`** | O `./data` foi criado como root. `sudo install -d -o 1000 -g 1000 data` (ou `sudo chown -R 1000:1000 data`) e `docker compose up -d`. |
| **Porta 8443 não responde de fora** | Confira `sudo iptables -L INPUT --line-numbers -n` (a regra deve vir antes do REJECT) e a security list da Oracle. |
| **Rate limit do Discord** | O relay enfileira por canal e respeita o `Retry-After`; as mensagens só demoram. Nome de thread e tópico do canal mudam no máximo 1× a cada 5 min (300 s): o Discord só aceita ~2 edições por canal a cada 10 min, então o emoji de estado pode demorar a acompanhar. |
| **Thread arquivada** | Nada a fazer: uma mensagem nova desarquiva a thread automaticamente. |
| **Injeção falhou** (❌ na mensagem) | A sessão morreu ou o socket sumiu; o relay sugere `/novo`. |
| **Permissão sem resposta** | Após 30 min o card marca "expirou" e a permissão é negada. |
