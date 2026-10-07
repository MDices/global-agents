import { describe, expect, it } from "vitest";
import { loadRelayConfig } from "../src/config.js";

describe("loadRelayConfig", () => {
  it("lança nomeando todas as variáveis obrigatórias ausentes", () => {
    expect(() => loadRelayConfig({})).toThrow(/DISCORD_TOKEN/);
    expect(() => loadRelayConfig({})).toThrow(/DISCORD_GUILD_ID/);
    expect(() => loadRelayConfig({})).toThrow(/ALLOWED_USER_IDS/);
  });

  it("lança quando ALLOWED_USER_IDS só tem entradas vazias", () => {
    expect(() =>
      loadRelayConfig({ DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g", ALLOWED_USER_IDS: " , ," }),
    ).toThrow(/ALLOWED_USER_IDS/);
  });

  it("aplica defaults e converte allowedUserIds e port", () => {
    const cfg = loadRelayConfig({ DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g", ALLOWED_USER_IDS: " 1, 2 ,,3 " });
    expect(cfg).toEqual({
      discordToken: "t",
      guildId: "g",
      categoryName: "global-agents",
      allowedUserIds: ["1", "2", "3"],
      dataDir: "/data",
      port: 8443,
      logLevel: "info",
    });
  });

  it("respeita DATA_DIR, PORT e LOG_LEVEL", () => {
    const cfg = loadRelayConfig({
      DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g", ALLOWED_USER_IDS: "1",
      DATA_DIR: "/x", PORT: "9000", LOG_LEVEL: "debug",
    });
    expect(cfg.dataDir).toBe("/x");
    expect(cfg.port).toBe(9000);
    expect(cfg.logLevel).toBe("debug");
  });

  it("rejeita PORT inválida", () => {
    expect(() =>
      loadRelayConfig({ DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g", ALLOWED_USER_IDS: "1", PORT: "abc" }),
    ).toThrow(/PORT/);
  });
});
