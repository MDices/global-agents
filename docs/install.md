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
  --dev-root ~/dev \
  --service
unset GLOBAL_AGENTS_TOKEN
```
(`--token <token>` também funciona, mas fica no histórico do shell e aparece no `ps`; `--dev-root` e `--project` podem repetir.) Isso grava a config em `~/.global-agents`, copia os scripts de hook e instala os hooks em `~/.claude/settings.json`.

### Pastas dev (`--dev-root`)

Cada `--dev-root <pasta>` é uma **pasta raiz de desenvolvimento**: tudo dentro dela pode virar sessão pelo `/novo` do Discord, sem cadastrar projeto nenhum (`--project` vira opcional, para pastas avulsas fora das raízes). A pasta pode ser qualquer caminho da máquina: `~/dev`, um caminho relativo ou absoluto; o `install` grava o caminho absoluto (com `~` expandido). O agente lista sozinho as subpastas de 1º nível e os repositórios git do 2º nível (sem pastas ocultas, `node_modules`, `dist` e afins, até 200, sem seguir symlinks) e manda essa lista ao relay ao conectar e quando ela muda (varredura a cada 5 min); são as sugestões do autocomplete do `projeto`.

No `/novo`, `projeto` seleciona uma pasta **que já existe**: uma sugestão, um caminho **relativo à primeira pasta dev** (ex.: `gestai`, `work/app-novo`, inclusive mais fundo do que a varredura alcança) ou um caminho absoluto. Para **criar** uma pasta, use `nova_pasta` com o nome (ex.: `meu-app` ou `clientes/app`): ela é criada dentro da primeira pasta dev. Os dois campos não se misturam: informar `projeto` e `nova_pasta` juntos dá erro, e `nova_pasta` com uma pasta que já existe também (a mensagem manda usar `projeto` para abri-la). Quem decide é o agente: só abre sessão em pasta **dentro** de uma pasta dev (comparando o caminho real, então um symlink que sai da pasta dev é recusado) ou em um `--project` explícito. Pasta que ainda não existe só é criada com `nova_pasta` no `/novo`, e cada nome novo precisa começar com letra ou número e ter só letras, números, `.`, `_` e `-`. Sem `projeto` nem `nova_pasta`, o `/novo` abre a sessão na própria primeira pasta dev (mesmo havendo `--project`); sem pasta dev, no primeiro `--project`.

Confiança do Claude Code: uma pasta nova sem git dentro de uma pasta dev já confiável herda a confiança dela. Quando o `claude --bg` recusa a pasta ("Workspace not trusted", por exemplo num repositório git que nunca foi aberto, ou numa pasta dev que nunca foi aberta), o agente marca essa pasta como confiável em `~/.claude.json` (`projects[<pasta>].hasTrustDialogAccepted`, o mesmo campo que o Claude Code grava ao aceitar o diálogo; no Windows com `/` no caminho, como o Claude Code lê) e tenta uma vez mais. A gravação usa a mesma trava do Claude Code (`~/.claude.json.lock`) e, se ela estiver ocupada por mais de 2 s, desiste e a sessão falha com a instrução. Isso só acontece para pastas dentro de uma pasta dev; fora delas a sessão falha com a instrução de abrir `claude` na pasta uma vez.

> **Atenção: pasta dev = "tudo aqui é confiável para o Claude Code".** Qualquer pasta dentro de uma pasta dev pode ganhar a confiança do Claude Code automaticamente quando uma sessão é aberta nela pelo Discord, inclusive um repositório de terceiros clonado ali e nunca aberto. Confiar numa pasta libera o que ela traz: hooks em `.claude/settings.json`, servidores MCP de `.mcp.json` e afins passam a rodar sem o diálogo de confiança. Não use como pasta dev um lugar onde você clona código em que não confia; clone esse código fora das pastas dev.

Para acrescentar ou trocar as pastas dev depois, não precisa do token nem do relay de novo: com a config já gravada, `--relay`, `--token` e `--fingerprint` são opcionais e o que não for passado fica como estava.
```bash
node apps/agent/dist/cli.js install --dev-root ~/dev --dev-root ~/trabalho
systemctl --user restart global-agents
```
`--dev-root` e `--project` substituem a lista inteira correspondente (repita a pasta que já existia para mantê-la); não passar nenhum `--dev-root` mantém a lista, e `--no-dev-root` apaga todas as raízes. O agente só lê a config ao subir, por isso o restart. `status` mostra a linha `raízes dev:`.

No `/novo`, `projeto:~/dev/app` também funciona: `~` é o home do usuário do agente.

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
- [ ] `/novo` cria uma sessão nova a partir do Discord; `/novo nova_pasta:teste-ga` cria a pasta dentro da pasta dev; repetir o mesmo comando dá erro "a pasta teste-ga já existe", e `/novo projeto:teste-ga` abre a pasta existente.
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
| **Nome da thread** (de onde vem) | Por prioridade: o `/rename` da sessão, o título automático do Claude Code (o mesmo que a extensão do VS Code mostra), o nome de `claude agents` (ex.: `gestai-8d`) e, por último, o nome da pasta. O agente lê esses títulos do fim do transcript (`~/.claude/projects/…/<sessão>.jsonl`). |
| **`/rename` não aparece no Discord** | O agente percebe o `/rename` em até 5 s, mas o Discord só aceita renomear a thread 1× a cada 5 min: o nome novo aparece em até ~5 min. Agentes de antes desta versão já mostram o `/rename` (vem em `claude agents`), mas não o título automático; atualize o agente para ver esse título. |
| **Sessão sem thread** / `/sessoes` mostra "sem atividade ainda" | Esperado: a thread só nasce no primeiro prompt, resposta, notificação ou pedido de permissão (ou no `/novo`). Sessões abertas e nunca usadas não ganham thread. Threads vazias criadas antes desta versão ficam; pode apagá-las no Discord. |
| **Subagent sem thread própria** | Esperado: subagent comum roda dentro da sessão do pai, e agente com nome (`@telas`) vira teammate, que aparece no painel `👥 Time` e nas linhas da thread do líder. |
| **Thread arquivada** | Nada a fazer: uma mensagem nova desarquiva a thread automaticamente. |
| **`esta máquina não tem pasta dev`** no `/novo` | O agente foi instalado sem `--dev-root` nem `--project`. A mensagem traz o comando do sistema da máquina: no Linux `global-agents install --dev-root ~/dev` (sem token) seguido de `systemctl --user restart global-agents`; no Windows `.\deploy\agent\install-windows.ps1 -DevRoot C:\dev`, que refaz o build (depois de um `git pull`, é o fluxo de atualização) e já reinicia o agente sozinho. |
| **`pasta não existe; use nova_pasta:<nome>…`** | A pasta pedida em `projeto` não existe; para criá-la, repita o `/novo` com `nova_pasta` (só funciona dentro de uma pasta dev). |
| **`a pasta X já existe; use projeto:X…`** | Foi pedido `nova_pasta` de uma pasta que já existe; use `projeto` para abri-la. |
| **`… está fora das pastas dev desta máquina`** | O caminho (ou o destino real de um symlink) fica fora de toda pasta dev e não é um `--project`. Use um caminho dentro de uma pasta dev ou acrescente a pasta com `install --dev-root`. |
| **Injeção falhou** (❌ na mensagem) | A sessão morreu ou o socket sumiu; o relay sugere `/novo`. |
| **Permissão sem resposta** | Após 30 min o card marca "expirou" e a permissão é negada. |
