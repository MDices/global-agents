import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Routes,
  ThreadAutoArchiveDuration,
  type CategoryChannel,
  type Guild,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type TextChannel,
} from "discord.js";
import type { RelayConfig } from "../config.js";
import { SLASH_COMMANDS, type SlashButton, type SlashInteraction, type SlashView } from "./slash.js";

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

/** Mensagem com embed e botões (card de permissão). */
export interface CardSpec {
  /** Texto fora do embed; omitido numa edição, o texto atual fica. */
  content?: string;
  /** Únicos usuários que o post pode notificar (menções em `content`); edições nunca notificam. */
  mentions?: string[];
  embed: EmbedSpec;
  /** `[]` tira os botões. */
  buttons: SlashButton[];
}

/**
 * Tudo o que o relay faz no Discord. Fica atrás desta interface para que roteamento e threads sejam testados sem
 * rede (`FakeDiscordPort` nos testes). Esperas de rate limit (`Retry-After`) são do discord.js, que enfileira por rota.
 */
export interface DiscordPort {
  /**
   * Acha (ou cria, com `topic`) o canal de texto `name` na categoria do relay. Nunca edita o tópico de um canal
   * existente (edição de canal tem rate limit apertado; isso fica com `editChannelTopic`). Devolve o tópico atual.
   */
  ensureChannel(name: string, topic: string): Promise<{ channelId: string; topic: string | null }>;
  /** Cria uma thread pública no canal (arquivamento automático em 1 semana). */
  createThread(channelId: string, name: string): Promise<{ threadId: string }>;
  renameThread(threadId: string, name: string): Promise<void>;
  post(threadOrChannelId: string, text: string): Promise<{ messageId: string }>;
  postEmbed(threadOrChannelId: string, embed: EmbedSpec): Promise<{ messageId: string }>;
  editChannelTopic(channelId: string, topic: string): Promise<void>;
  /** Reage com `emoji` (unicode) à mensagem `messageId` do canal/thread. */
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Remove só a reação `emoji` do próprio bot; não faz nada se ela não existir. */
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Responde (reply do Discord) à mensagem `messageId`; se ela sumiu, posta sem a referência. */
  reply(channelId: string, messageId: string, text: string): Promise<{ messageId: string }>;
  /** Fixa a mensagem `messageId` no canal/thread. */
  pin(channelId: string, messageId: string): Promise<void>;
  /** Troca o texto de uma mensagem do próprio bot. */
  edit(channelId: string, messageId: string, text: string): Promise<void>;
  /** Posta um card (embed + botões); só os usuários de `card.mentions` são notificados. */
  postCard(threadId: string, card: CardSpec): Promise<{ messageId: string }>;
  /** Troca embed e botões de um card do próprio bot. */
  editCard(threadId: string, messageId: string, card: CardSpec): Promise<void>;
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

export function embedFrom(spec: EmbedSpec): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (spec.title !== undefined) embed.setTitle(spec.title);
  if (spec.description !== undefined) embed.setDescription(spec.description);
  if (spec.color !== undefined) embed.setColor(spec.color);
  if (spec.fields !== undefined) embed.addFields(spec.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? false })));
  if (spec.footer !== undefined) embed.setFooter({ text: spec.footer });
  return embed;
}

/**
 * Registra `/novo`, `/sessoes`, `/parar` e `/filtro` no guild (comandos de guild valem na hora). Usa o REST do
 * próprio client, já autenticado; chamar depois do `ready` (precisa de `client.application`).
 */
export async function registerSlashCommands(client: Client, guildId: string): Promise<void> {
  const appId = client.application?.id;
  if (appId === undefined) throw new Error("aplicação do bot ainda não carregada (chame depois do ready)");
  await client.rest.put(Routes.applicationGuildCommands(appId, guildId), { body: SLASH_COMMANDS });
}

const BUTTON_STYLE: Record<SlashButton["style"], ButtonStyle> = {
  danger: ButtonStyle.Danger,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
};

function componentsFrom(buttons: SlashButton[]): ActionRowBuilder<ButtonBuilder>[] {
  if (buttons.length === 0) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.map((b) => new ButtonBuilder()
    .setCustomId(b.customId)
    .setLabel(b.label)
    .setStyle(BUTTON_STYLE[b.style])
    .setDisabled(b.disabled ?? false)))];
}

function messageFrom(v: SlashView) {
  return {
    ...(v.content !== undefined ? { content: v.content } : {}),
    ...(v.embeds !== undefined ? { embeds: v.embeds.map(embedFrom) } : {}),
    ...(v.buttons !== undefined ? { components: componentsFrom(v.buttons) } : {}),
    allowedMentions: NO_MENTIONS,
  };
}

/** Converte a interação do discord.js no formato de `slash.ts`; `undefined` para tipos que o relay não trata. */
export function toSlashInteraction(i: Interaction): SlashInteraction | undefined {
  const base = { id: i.id, channelId: i.channelId ?? "", user: { id: i.user.id, username: i.user.username } };
  const ephemeral = (on: boolean) => (on ? { flags: MessageFlags.Ephemeral as const } : {});
  if (i.isChatInputCommand()) {
    return {
      ...base,
      kind: "command",
      commandName: i.commandName,
      options: { getString: (name) => i.options.getString(name), getSubcommand: () => i.options.getSubcommand(false) },
      reply: (v, eph) => i.reply({ ...messageFrom(v), ...ephemeral(eph) }),
      editReply: (v) => i.editReply(messageFrom(v)),
    };
  }
  if (i.isAutocomplete()) {
    const focused = i.options.getFocused(true);
    return {
      ...base,
      kind: "autocomplete",
      commandName: i.commandName,
      focused: { name: focused.name, value: String(focused.value) },
      respond: (choices) => i.respond(choices),
    };
  }
  if (i.isButton()) {
    return {
      ...base,
      kind: "button",
      customId: i.customId,
      update: (v) => i.update(messageFrom(v)),
      editReply: (v) => i.editReply(messageFrom(v)),
      reply: (v, eph) => i.reply({ ...messageFrom(v), ...ephemeral(eph) }),
    };
  }
  return undefined;
}

export class DiscordJsPort implements DiscordPort {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly categoryName: string,
  ) {}

  async ensureChannel(name: string, topic: string): Promise<{ channelId: string; topic: string | null }> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const category = await this.ensureCategory(guild);
    const channels = await guild.channels.fetch();
    const existing = channels.find(
      (c): c is TextChannel => c !== null && c.type === ChannelType.GuildText && c.name === name && c.parentId === category.id,
    );
    if (existing !== undefined) return { channelId: existing.id, topic: existing.topic };
    const created = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, topic });
    return { channelId: created.id, topic: created.topic };
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
    return this.send(threadOrChannelId, { embeds: [embedFrom(spec)], allowedMentions: NO_MENTIONS });
  }

  async editChannelTopic(channelId: string, topic: string): Promise<void> {
    const channel = await this.textChannel(channelId);
    // Edição de canal tem rate limit apertado (~2 a cada 10 min): não gasta com tópico igual.
    if (channel.topic !== topic) await channel.setTopic(topic);
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const message = await this.message(channelId, messageId);
    await message.react(emoji);
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const message = await this.message(channelId, messageId);
    await message.reactions.resolve(emoji)?.users.remove(); // sem argumento: a reação do próprio bot
  }

  reply(channelId: string, messageId: string, text: string): Promise<{ messageId: string }> {
    return this.send(channelId, {
      content: text,
      reply: { messageReference: messageId, failIfNotExists: false },
      allowedMentions: NO_MENTIONS,
    });
  }

  async pin(channelId: string, messageId: string): Promise<void> {
    const message = await this.message(channelId, messageId);
    await message.pin();
  }

  async edit(channelId: string, messageId: string, text: string): Promise<void> {
    const message = await this.message(channelId, messageId);
    await message.edit({ content: text, allowedMentions: NO_MENTIONS });
  }

  postCard(threadId: string, card: CardSpec): Promise<{ messageId: string }> {
    return this.send(threadId, {
      ...(card.content !== undefined ? { content: card.content } : {}),
      embeds: [embedFrom(card.embed)],
      components: componentsFrom(card.buttons),
      allowedMentions: { users: [...(card.mentions ?? [])] },
    });
  }

  async editCard(threadId: string, messageId: string, card: CardSpec): Promise<void> {
    const message = await this.message(threadId, messageId);
    await message.edit({
      ...(card.content !== undefined ? { content: card.content } : {}),
      embeds: [embedFrom(card.embed)],
      components: componentsFrom(card.buttons),
      allowedMentions: NO_MENTIONS,
    });
  }

  private async message(channelId: string, messageId: string): Promise<Message> {
    const ch = await this.client.channels.fetch(channelId);
    if (ch === null || !ch.isTextBased()) throw new Error(`canal ${channelId} não tem mensagens`);
    return ch.messages.fetch(messageId);
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
