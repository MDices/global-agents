import { describe, expect, it } from "vitest";
import { resolveToken } from "../src/token.js";

describe("resolveToken", () => {
  it("--token tem precedência", () => expect(resolveToken("a", { GLOBAL_AGENTS_TOKEN: "b" })).toBe("a"));
  it("cai para a variável de ambiente", () => expect(resolveToken(undefined, { GLOBAL_AGENTS_TOKEN: "b" })).toBe("b"));
  it("vazio ou ausente → undefined", () => {
    expect(resolveToken(undefined, { GLOBAL_AGENTS_TOKEN: "" })).toBeUndefined();
    expect(resolveToken(undefined, {})).toBeUndefined();
  });
});
