import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ThreadAutoArchiveDuration,
  type CategoryChannel,
  type Guild,
  type MessageCreateOptions,
  type TextChannel,
} from "discord.js";
import type { RelayConfig } from "../config.js";

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Embed independente da biblioteca (só o que o relay usa). */
export interface EmbedSpec {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: string;
}

/**
 * Tudo o que o relay faz no Discord. Fica atrás desta interface para que roteamento e threads sejam testados sem
 * rede (`FakeDiscordPort` nos testes). Esperas de rate limit (`Retry-After`) são do discord.js, que enfileira por rota.
 */
export interface DiscordPort {
  /** Acha (ou cria) o canal de texto `name` na categoria do relay; atualiza o tópico se diferente. */
  ensureChannel(name: string, topic: string): Promise<{ channelId: string }>;
  /** Cria uma thread pública no canal (arquivamento automático em 1 semana). */
  createThread(channelId: string, name: string): Promise<{ threadId: string }>;
  renameThread(threadId: string, name: string): Promise<void>;
  post(threadOrChannelId: string, text: string): Promise<{ messageId: string }>;
  postEmbed(threadOrChannelId: string, embed: EmbedSpec): Promise<{ messageId: string }>;
  editChannelTopic(channelId: string, topic: string): Promise<void>;
}

export function createBot(
  cfg: Pick<RelayConfig, "discordToken">,
  log: (msg: string) => void = (m) => { console.error(m); },
): { client: Client; ready: Promise<void> } {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  // Sem listener, um `error` emitido pelo client derrubaria o processo.
  client.on(Events.Error, (e) => { log(`discord: ${e.message}`); });
  const ready = new Promise<void>((resolve, reject) => {
    client.once(Events.ClientReady, () => { resolve(); });
    client.login(cfg.discordToken).catch(reject);
  });
  return { client, ready };
}

/** Nunca menciona ninguém a partir de texto vindo das máquinas. */
const NO_MENTIONS = { parse: [] } as const;

export class DiscordJsPort implements DiscordPort {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly categoryName: string,
  ) {}

  async ensureChannel(name: string, topic: string): Promise<{ channelId: string }> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const category = await this.ensureCategory(guild);
    const channels = await guild.channels.fetch();
    const existing = channels.find(
      (c): c is TextChannel => c !== null && c.type === ChannelType.GuildText && c.name === name && c.parentId === category.id,
    );
    if (existing !== undefined) {
      if (existing.topic !== topic) await existing.setTopic(topic);
      return { channelId: existing.id };
    }
    const created = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, topic });
    return { channelId: created.id };
  }

  async createThread(channelId: string, name: string): Promise<{ threadId: string }> {
    const channel = await this.textChannel(channelId);
    const thread = await channel.threads.create({
      name,
      type: ChannelType.PublicThread,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });
    return { threadId: thread.id };
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    const ch = await this.client.channels.fetch(threadId);
    if (ch === null || !ch.isThread()) throw new Error(`thread ${threadId} não encontrada`);
    await ch.setName(name);
  }

  post(threadOrChannelId: string, text: string): Promise<{ messageId: string }> {
    return this.send(threadOrChannelId, { content: text, allowedMentions: NO_MENTIONS });
  }

  postEmbed(threadOrChannelId: string, spec: EmbedSpec): Promise<{ messageId: string }> {
    const embed = new EmbedBuilder();
    if (spec.title !== undefined) embed.setTitle(spec.title);
    if (spec.description !== undefined) embed.setDescription(spec.description);
    if (spec.color !== undefined) embed.setColor(spec.color);
    if (spec.fields !== undefined) embed.addFields(spec.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? false })));
    if (spec.footer !== undefined) embed.setFooter({ text: spec.footer });
    return this.send(threadOrChannelId, { embeds: [embed], allowedMentions: NO_MENTIONS });
  }

  async editChannelTopic(channelId: string, topic: string): Promise<void> {
    const channel = await this.textChannel(channelId);
    // Edição de canal tem rate limit apertado (~2 a cada 10 min): não gasta com tópico igual.
    if (channel.topic !== topic) await channel.setTopic(topic);
  }

  private async ensureCategory(guild: Guild): Promise<CategoryChannel> {
    const channels = await guild.channels.fetch();
    const found = channels.find(
      (c): c is CategoryChannel => c !== null && c.type === ChannelType.GuildCategory && c.name === this.categoryName,
    );
    return found ?? guild.channels.create({ name: this.categoryName, type: ChannelType.GuildCategory });
  }

  private async textChannel(channelId: string): Promise<TextChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (ch === null || ch.type !== ChannelType.GuildText) throw new Error(`canal de texto ${channelId} não encontrado`);
    return ch;
  }

  private async send(id: string, msg: MessageCreateOptions): Promise<{ messageId: string }> {
    const ch = await this.client.channels.fetch(id);
    if (ch === null || !ch.isSendable()) throw new Error(`canal ${id} não aceita mensagens`);
    const sent = await ch.send(msg);
    return { messageId: sent.id };
  }
}
