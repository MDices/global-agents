# global-agents no Windows (Toneli-PC)

O agente precisa rodar **como o usuário logado**: os named pipes de inbox (`\\.\pipe\LOCAL\cc-msg-<hash>`) e o `~/.claude` são por usuário. Um serviço do Windows como LocalSystem não os enxerga. Por isso a inicialização usa o **Agendador de Tarefas "ao logon"** do usuário atual (sem senha). O WinSW fica como alternativa opcional (seção no fim).

## Pré-requisitos

- Windows 10 (1809 ou mais novo) ou 11, com PowerShell 5.1 ou 7. O agente roda sem janela via `conhost.exe --headless`, que só existe a partir do Windows 10 1809.
- Node.js ≥ 24 e pnpm (`corepack enable`).
- Git.
- Claude Code ≥ 2.1.234, já logado (`claude --version`).
- URL do relay, token e (se o relay usa certificado autoassinado) o fingerprint.

## Passo a passo

1. Clone o repositório em um diretório fixo (o agente roda de lá):
   ```powershell
   git clone <url-do-repo> C:\dev\global-agents
   cd C:\dev\global-agents
   ```
2. Rode o instalador (PowerShell normal, **não** precisa de administrador):
   ```powershell
   .\deploy\agent\install-windows.ps1 -Relay wss://relay.exemplo:8443 -Fingerprint "<fp>" -Project C:\dev\meu-projeto
   ```
   Se a política de execução bloquear: `powershell -ExecutionPolicy Bypass -File .\deploy\agent\install-windows.ps1 ...`.
   Ele verifica Node/Claude Code, roda `pnpm install` e o build, grava a config e os hooks, registra a tarefa `global-agents` a partir de um XML (`schtasks /Create /TN global-agents /XML ... /F`; gatilho no logon do seu usuário, token interativo, nível limitado, sem limite de tempo, reinício em falha, sem condição de bateria), inicia o agente e roda o `doctor`.
   O token é pedido de forma oculta (não vai para o histórico do PowerShell); também pode vir da variável `GLOBAL_AGENTS_TOKEN`.
3. Para ver o XML da tarefa sem registrar nada, rode `node apps\agent\dist\cli.js install --relay ... --service` (sem `--apply`) com `GLOBAL_AGENTS_TOKEN` definido. Não cole o XML/comando impresso no cmd: use sempre `--apply`, que executa o `schtasks` sem passar por shell.

Não é preciso administrador: a tarefa é do seu usuário e roda com privilégio limitado. O agente roda **sem janela de console**; não há o que fechar por engano.

## Verificar

- `node apps\agent\dist\cli.js status` mostra `agente: rodando`.
- `node apps\agent\dist\cli.js doctor` sem ❌.
- No Discord, a máquina ganha um canal próprio e `/sessoes` (no canal da máquina) lista as sessões dela.
- A tarefa registrada: `schtasks /Query /TN global-agents /XML` (confira `UserId` = seu usuário, `LeastPrivilege`, `ExecutionTimeLimit` `PT0S`) e `/V /FO LIST` para o status.
- Log: o agente roda sem console visível; para depurar, rode `node apps\agent\dist\cli.js run` num terminal (pare a tarefa antes: `schtasks /End /TN global-agents`).

## Parar e remover

```powershell
schtasks /End /TN global-agents                     # para agora
node apps\agent\dist\cli.js uninstall --service --apply   # remove os hooks e a tarefa (faz o /End antes do /Delete)
```
A config em `~/.global-agents` é mantida. `crossSessionInbound` em `~/.claude/settings.json` não é removido automaticamente.

## Checklist de validação manual (Toneli-PC)

Marque e cole a saída/observações de volta no chat.

- [ ] `pnpm build` no Windows termina sem erro e `apps\agent\dist\hooks\scripts\` contém `global-agents-hook.ps1` e `global-agents-hook.sh`.
- [ ] `install-windows.ps1` conclui; `schtasks /Query /TN global-agents /V /FO LIST` mostra o seu usuário (o mesmo de `whoami`) e o gatilho "Ao fazer logon" só para ele; o `/XML` mostra `PT0S`.
- [ ] Instalou **sem** administrador, e ao iniciar a tarefa não aparece janela de console (o `node.exe` aparece no Gerenciador de Tarefas).
- [ ] **Injeção via named pipe:** com uma sessão `claude --bg --name teste`, mande uma mensagem pelo Discord e confira no transcript que virou turno (o agente usa a linha de auth com `peerToken` do `.key`).
- [ ] **`--bg` + `attach`:** criar sessão pelo Discord com `/novo prompt:<pedido>` no canal da máquina, listar com `claude agents`, `claude attach <id>` abre e mostra a conversa.
- [ ] **`/sessoes`** (no canal da máquina) lista as sessões da máquina, e **`/claude comando:status`** (dentro da thread de uma sessão) mostra a tela de status do Claude daquela sessão.
- [ ] **Cartão de permissão:** uma sessão pede uma ferramenta que exige permissão; o cartão aparece no Discord; Permitir/Negar chega à sessão.
- [ ] **Reboot:** reiniciar o PC, fazer logon; sem abrir nada, `status` mostra o agente rodando e o `/sessoes` responde no canal da máquina.
- [ ] **Reinício em falha:** matar o `node.exe` do agente pelo Gerenciador de Tarefas e conferir se ele volta em até ~1 min. Se não voltar, anotar o resultado (a decisão sobre um laço de reinício fica para depois do teste).
- [ ] **Remoção:** depois de `uninstall --service --apply`, conferir que não sobrou nenhum `node.exe` do agente.
- [ ] **Azure AD:** em PC ingressado no Azure AD, conferir se `USERDOMAIN` = `AzureAD` é aceito no `UserId` da tarefa (`schtasks /Create` não deve falhar).
- [ ] (Opcional) e2e automatizado: `$env:GLOBAL_AGENTS_E2E=1; pnpm --filter @global-agents/agent test e2e-windows` — cria uma sessão `--bg`, injeta pelo pipe e confere o transcript (responde BRAVO).

## Alternativa: serviço do Windows com WinSW

`deploy\agent\global-agents-winsw.xml` descreve um serviço rodando como o usuário. O WinSW pedirá a **senha** do usuário na instalação e exige ajustar o caminho do app no XML. A CLI não depende dele; prefira o Agendador de Tarefas.
