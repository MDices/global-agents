import type { SlashCommandName } from "@global-agents/protocol";

/** Regras do `/claude` sem dependências pesadas (o handler importa daqui, sem carregar node-pty/@xterm). */

/** Comandos que não mexem na conversa: podem rodar com a sessão ocupada. */
export const SLASH_WHILE_BUSY: ReadonlySet<SlashCommandName> = new Set(["usage", "cost", "status"]);
export const BUSY_TEXT = "sessão ocupada; tente quando o turno terminar";
