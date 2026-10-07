# global-agents

Controle e acompanhe suas sessões do Claude Code (em várias máquinas, Linux e Windows) pelo Discord.

- **Agente** (`apps/agent`): roda em cada máquina, lê as sessões, recebe os hooks e injeta mensagens.
- **Relay** (`apps/relay`): roda numa VPS, faz a ponte entre os agentes (WebSocket com TLS) e o bot do Discord: canal por máquina, thread por sessão, cards de permissão.
- **Protocolo** (`packages/protocol`): os envelopes compartilhados.

## Documentação

- [Guia de instalação](docs/install.md): bot do Discord, relay na VPS (isolado), agente em Linux, verificação e solução de problemas.
- [Windows](docs/windows.md): agente via Agendador de Tarefas.
- [Especificação](docs/superpowers/specs/2026-10-06-global-agents-design.md).
- [Mockup do design](docs/design/discord-mockup.html).

## Desenvolvimento

```bash
pnpm install
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build
```
Requer Node.js ≥ 24 e pnpm.
