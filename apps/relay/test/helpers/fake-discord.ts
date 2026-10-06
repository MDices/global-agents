import type { DiscordPort, EmbedSpec } from "../../src/discord/bot.js";

export type FakeCall =
  | { op: "ensureChannel"; name: string; topic: string }
  | { op: "createThread"; channelId: string; name: string }
  | { op: "renameThread"; threadId: string; name: string }
  | { op: "post"; targetId: string; text: string }
  | { op: "postEmbed"; targetId: string; embed: EmbedSpec }
  | { op: "editChannelTopic"; channelId: string; topic: string };

/** Implementação de `DiscordPort` em memória que grava todas as chamadas, para testes sem rede. */
export class FakeDiscordPort implements DiscordPort {
  readonly calls: FakeCall[] = [];
  private seq = 0;
  private readonly channels = new Map<string, string>();
  /** Atraso artificial de `createThread`, para simular concorrência. */
  createDelayMs = 0;

  of<K extends FakeCall["op"]>(op: K): Extract<FakeCall, { op: K }>[] {
    return this.calls.filter((c): c is Extract<FakeCall, { op: K }> => c.op === op);
  }

  async ensureChannel(name: string, topic: string): Promise<{ channelId: string }> {
    this.calls.push({ op: "ensureChannel", name, topic });
    let id = this.channels.get(name);
    if (id === undefined) {
      id = `ch-${++this.seq}`;
      this.channels.set(name, id);
    }
    return { channelId: id };
  }

  async createThread(channelId: string, name: string): Promise<{ threadId: string }> {
    this.calls.push({ op: "createThread", channelId, name });
    const id = `th-${++this.seq}`;
    if (this.createDelayMs > 0) await new Promise((r) => setTimeout(r, this.createDelayMs));
    return { threadId: id };
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    this.calls.push({ op: "renameThread", threadId, name });
  }

  async post(targetId: string, text: string): Promise<{ messageId: string }> {
    this.calls.push({ op: "post", targetId, text });
    return { messageId: `msg-${++this.seq}` };
  }

  async postEmbed(targetId: string, embed: EmbedSpec): Promise<{ messageId: string }> {
    this.calls.push({ op: "postEmbed", targetId, embed });
    return { messageId: `msg-${++this.seq}` };
  }

  async editChannelTopic(channelId: string, topic: string): Promise<void> {
    this.calls.push({ op: "editChannelTopic", channelId, topic });
  }
}
