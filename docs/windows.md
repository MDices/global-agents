# global-agents no Windows (Toneli-PC)

O agente precisa rodar **como o usuário logado**: os named pipes de inbox (`\\.\pipe\LOCAL\cc-msg-<hash>`) e o `~/.claude` são por usuário. Um serviço do Windows como LocalSystem não os enxerga. Por isso a inicialização usa o **Agendador de Tarefas "ao logon"** do usuário atual (sem senha). O WinSW fica como alternativa opcional (seção no fim).

## Pré-requisitos

- Windows 10/11 com PowerShell 5.1 ou 7.
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
   .\deploy\agent\install-windows.ps1 -Relay wss://relay.exemplo:8443 -Token "<token>" -Fingerprint "<fp>" -Project C:\dev\meu-projeto
   ```
   Se a política de execução bloquear: `powershell -ExecutionPolicy Bypass -File .\deploy\agent\install-windows.ps1 ...`.
   Ele verifica Node/Claude Code, roda `pnpm install` e o build, grava a config e os hooks, registra a tarefa `global-agents` (`schtasks /Create ... /SC ONLOGON /RL LIMITED`), inicia o agente e roda o `doctor`.
3. Para ver o comando do `schtasks` sem executar, rode manualmente `node apps\agent\dist\cli.js install --relay ... --token ... --service` (sem `--apply`).

Se `schtasks /Create` responder "Acesso negado", abra o PowerShell como administrador só para esse passo (o agente continua rodando como o seu usuário, nível limitado).

## Verificar

- `node apps\agent\dist\cli.js status` mostra `agente: rodando`.
- `node apps\agent\dist\cli.js doctor` sem ❌.
- No Discord, a máquina aparece no canal/relay e `/claude status` responde.
- Log: o agente roda sem console visível; para depurar, rode `node apps\agent\dist\cli.js run` num terminal (pare a tarefa antes: `schtasks /End /TN global-agents`).

## Parar e remover

```powershell
schtasks /End /TN global-agents                     # para agora
node apps\agent\dist\cli.js uninstall --service --apply   # remove os hooks e a tarefa
```
A config em `~/.global-agents` é mantida. `crossSessionInbound` em `~/.claude/settings.json` não é removido automaticamente.

## Checklist de validação manual (Toneli-PC)

Marque e cole a saída/observações de volta no chat.

- [ ] `pnpm build` no Windows termina sem erro e `apps\agent\dist\hooks\scripts\` contém `global-agents-hook.ps1` e `global-agents-hook.sh`.
- [ ] `install-windows.ps1` conclui; `schtasks /Query /TN global-agents /V /FO LIST` mostra o usuário correto (`Admin`) e o gatilho "Ao fazer logon".
- [ ] **Injeção via named pipe:** com uma sessão `claude --bg --name teste`, mande uma mensagem pelo Discord e confira no transcript que virou turno (o agente usa a linha de auth com `peerToken` do `.key`).
- [ ] **`--bg` + `attach`:** criar sessão pelo Discord (`/claude new` ou equivalente), listar com `claude agents`, `claude attach <id>` abre e mostra a conversa.
- [ ] **`/claude status`** responde no Discord com as sessões da máquina.
- [ ] **Cartão de permissão:** uma sessão pede uma ferramenta que exige permissão; o cartão aparece no Discord; Aprovar/Negar chega à sessão.
- [ ] **Reboot:** reiniciar o PC, fazer logon; sem abrir nada, `status` mostra o agente rodando e o `/claude status` responde.
- [ ] (Opcional) e2e automatizado: `$env:GLOBAL_AGENTS_E2E=1; pnpm --filter @global-agents/agent test e2e-windows` — cria uma sessão `--bg`, injeta pelo pipe e confere o transcript (responde BRAVO).

## Alternativa: serviço do Windows com WinSW

`deploy\agent\global-agents-winsw.xml` descreve um serviço rodando como o usuário. O WinSW pedirá a **senha** do usuário na instalação e exige ajustar o caminho do app no XML. A CLI não depende dele; prefira o Agendador de Tarefas.
