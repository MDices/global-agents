import { describe, expect, it } from "vitest";
import { chunkText } from "../src/discord/chunk.js";

const LIMIT = 1900;
const SUFFIX_RE = /\n-# \(parte \d+\/\d+\)$/;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("chunkText", () => {
  it("texto vazio ou só espaços vira o aviso padrão", () => {
    expect(chunkText("")).toEqual(["(sem texto na resposta)"]);
    expect(chunkText("  \n")).toEqual(["(sem texto na resposta)"]);
  });

  it("texto curto fica em uma fatia, sem sufixo", () => {
    const text = "a".repeat(100);
    expect(chunkText(text)).toEqual([text]);
  });

  it("três parágrafos de 800 chars viram 2 fatias cortadas em \\n\\n", () => {
    const p = "x".repeat(800);
    const chunks = chunkText([p, p, p].join("\n\n"));
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
    expect(chunks[0]).toContain("(parte 1/2)");
    expect(chunks[1]).toContain("(parte 2/2)");
    expect(chunks[0]?.replace(SUFFIX_RE, "")).toBe(`${p}\n\n${p}`);
    expect(chunks[1]?.replace(SUFFIX_RE, "")).toBe(p);
  });

  it("bloco ```ts de 3000 chars fecha na fatia 1 e reabre na fatia 2", () => {
    const body = Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`.padEnd(29, " ")).join("\n");
    const text = "```ts\n" + body + "\n```";
    expect(text.length).toBeGreaterThan(2900);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
    expect(chunks[0]?.replace(SUFFIX_RE, "").endsWith("```")).toBe(true);
    expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
    const last = chunks[chunks.length - 1]?.replace(SUFFIX_RE, "");
    expect(last?.endsWith("```")).toBe(true);
  });

  it("linha única maior que o limite dentro de bloco não trava", () => {
    const text = "```\n" + "y".repeat(5000) + "\n```";
    const chunks = chunkText(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
    const joined = chunks.map((c) => c.replace(SUFFIX_RE, "")).join("");
    expect(joined.split("y").length - 1).toBe(5000);
  });

  it("muitas cercas consecutivas respeitam o limite", () => {
    const text = Array.from({ length: 800 }, () => "```").join("\n");
    const chunks = chunkText(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
  });

  it("palavra única de 5000 chars é cortada em fatias <= 1900", () => {
    const chunks = chunkText("w".repeat(5000));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
    const joined = chunks.map((c) => c.replace(SUFFIX_RE, "")).join("");
    expect(joined).toBe("w".repeat(5000));
  });

  it("nunca separa um par substituto (emoji)", () => {
    const text = "😀".repeat(3000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(LIMIT);
      const body = c.replace(SUFFIX_RE, "");
      expect(body).toBe(body.toWellFormed());
    }
    expect(chunks.map((c) => c.replace(SUFFIX_RE, "")).join("")).toBe(text);
  });

  it("propriedade: 50 textos aleatórios reconstroem o original ignorando espaços", () => {
    const rand = mulberry32(12345);
    const seps = [" ", " ", " ", "\n", "\n\n"];
    for (let i = 0; i < 50; i++) {
      const words = Math.floor(rand() * 1500) + 1;
      let text = "";
      for (let w = 0; w < words; w++) {
        text += "k".repeat(Math.floor(rand() * 12) + 1) + (seps[Math.floor(rand() * seps.length)] ?? " ");
      }
      const chunks = chunkText(text);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
      const joined = chunks.map((c) => (chunks.length > 1 ? c.replace(SUFFIX_RE, "") : c)).join("");
      expect(joined.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    }
  });
});

describe("chunkText com cercas longas", () => {
  it("cerca de 10 crases respeita o limite e reabre igual", () => {
    const text = "``````````js\n" + "z".repeat(4000) + "\n``````````";
    const chunks = chunkText(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
    expect(chunks[1]?.startsWith("``````````js\n")).toBe(true);
  });
});
