import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";
describe("protocol", () => { it("expõe a versão 1", () => { expect(PROTOCOL_VERSION).toBe(1); }); });
