/**
 * NPS callback handler test: parse payload, branch 4-5 vs 1-3.
 * Run: npx tsx src/modules/automations/__tests__/nps-callback.test.ts
 *
 * @module modules/automations/__tests__/nps-callback.test
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { parseNpsPayload } from "../nps-callback.js";

describe("NPS callback", () => {
  it("parses nps:5 as promoter", () => {
    const r = parseNpsPayload("nps:5");
    assert.deepStrictEqual(r, { rating: 5, branch: "promoter" });
  });

  it("parses nps:4 as promoter", () => {
    const r = parseNpsPayload("nps:4");
    assert.deepStrictEqual(r, { rating: 4, branch: "promoter" });
  });

  it("parses nps:3 as neutral", () => {
    const r = parseNpsPayload("nps:3");
    assert.deepStrictEqual(r, { rating: 3, branch: "neutral" });
  });
  it("parses nps:2 as detractor", () => {
    const r = parseNpsPayload("nps:2");
    assert.deepStrictEqual(r, { rating: 2, branch: "detractor" });
  });

  it("returns null for invalid payload", () => {
    assert.strictEqual(parseNpsPayload("other:1"), null);
    assert.strictEqual(parseNpsPayload("nps:0"), null);
    assert.strictEqual(parseNpsPayload("nps:6"), null);
  });
});
