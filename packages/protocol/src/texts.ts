/**
 * Textos mostrados no Discord que o relay e o agente precisam dizer igual.
 *
 * Sem pasta dev: o comando certo depende do sistema da máquina (`os` do `agent.hello`). No Linux é preciso reiniciar
 * a unidade systemd para o agente ler a config nova; no Windows o instalador já reinicia a tarefa sozinho.
 */
export function noDevRootText(os: string | null | undefined): string {
  if (os === "win32") {
    return "esta máquina não tem pasta dev; rode `.\\deploy\\agent\\install-windows.ps1 -DevRoot C:\\dev` (o script grava a pasta e reinicia o agente sozinho)";
  }
  if (os === "darwin") return "esta máquina não tem pasta dev; rode `global-agents install --dev-root ~/dev` e reinicie o agente";
  return "esta máquina não tem pasta dev; rode `global-agents install --dev-root ~/dev` e reinicie o agente com `systemctl --user restart global-agents`";
}
