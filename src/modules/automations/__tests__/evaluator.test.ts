/**
 * Tests: rule evaluator, quiet hours, template renderer.
 * Run: npx tsx src/modules/automations/__tests__/evaluator.test.ts
 * Or with Node: node --import tsx --test src/modules/automations/__tests__/evaluator.test.ts
 *
 * @module modules/automations/__tests__/evaluator.test
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import type { ScenarioConfig } from "../schemas/scenario-config.schema.js";
import { evaluateConditions, checkQuietHours, pickExperimentVariant } from "../engine/evaluator.js";
import { renderTemplate } from "../engine/template-renderer.js";
import type { EvalContext } from "../engine/evaluator.js";
import type { TemplateConfig } from "../schemas/scenario-config.schema.js";

const ctx: EvalContext = {
  userId: 1,
  telegramId: 123,
  lang: "ru",
  payload: {},
};

describe("evaluator", () => {
  describe("evaluateConditions", () => {
    it("passes when no rules", async () => {
      const config: ScenarioConfig = { trigger: { type: "EVENT", eventNames: ["deposit.completed"] }, conditions: { rules: [] }, steps: [], offers: {}, templates: {} };
      const ok = await evaluateConditions(config, ctx, {});
      assert.strictEqual(ok, true);
    });

    it("fails when gte rule not met", async () => {
      const config: ScenarioConfig = {
        trigger: { type: "EVENT", eventNames: [] },
        conditions: { rules: [{ field: "balance", operator: "gte", value: 50 }] },
        steps: [],
        offers: {},
        templates: {},
      };
      const ok = await evaluateConditions(config, ctx, { balance: 30 });
      assert.strictEqual(ok, false);
    });

    it("passes when gte rule met", async () => {
      const config: ScenarioConfig = {
        trigger: { type: "EVENT", eventNames: [] },
        conditions: { rules: [{ field: "balance", operator: "gte", value: 50 }] },
        steps: [],
        offers: {},
        templates: {},
      };
      const ok = await evaluateConditions(config, ctx, { balance: 50 });
      assert.strictEqual(ok, true);
    });

    it("passes when in rule met", async () => {
      const config: ScenarioConfig = {
        trigger: { type: "EVENT", eventNames: [] },
        conditions: { rules: [{ field: "tier", operator: "in", value: ["silver", "gold"] }] },
        steps: [],
        offers: {},
        templates: {},
      };
      const ok = await evaluateConditions(config, ctx, { tier: "silver" });
      assert.strictEqual(ok, true);
    });
  });

  describe("checkQuietHours", () => {
    it("allows when disabled", () => {
      const config = { quietHours: { enabled: false } } as ScenarioConfig;
      assert.strictEqual(checkQuietHours(config, null).allowed, true);
    });

    it("allows when no config", () => {
      const config = {} as ScenarioConfig;
      assert.strictEqual(checkQuietHours(config, null).allowed, true);
    });

    it("returns allowed boolean when window set", () => {
      const config: ScenarioConfig = {
        trigger: { type: "EVENT", eventNames: [] },
        conditions: { rules: [] },
        steps: [],
        offers: {},
        templates: {},
        quietHours: {
          enabled: true,
          timezoneDefault: "UTC",
          allowedStartHour: 9,
          allowedEndHour: 22,
        },
      };
      const result = checkQuietHours(config, "UTC");
      assert.strictEqual(typeof result.allowed, "boolean");
    });
  });

  describe("pickExperimentVariant", () => {
    it("returns null when experiment disabled", () => {
      const config = { experiment: { enabled: false, variants: [] } } as unknown as ScenarioConfig;
      assert.strictEqual(pickExperimentVariant(config), null);
    });

    it("returns variant id when one variant", () => {
      const config = {
        experiment: { enabled: true, variants: [{ id: "A", splitPercent: 100 }] },
      } as ScenarioConfig;
      assert.strictEqual(pickExperimentVariant(config), "A");
    });

    it("returns one of variant ids when two variants", () => {
      const config = {
        experiment: {
          enabled: true,
          variants: [
            { id: "A", splitPercent: 50 },
            { id: "B", splitPercent: 50 },
          ],
        },
      } as ScenarioConfig;
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) ids.add(pickExperimentVariant(config)!);
      assert.ok(ids.has("A") || ids.has("B"));
    });
  });
});

describe("template-renderer", () => {
  it("replaces variables", () => {
    const template: TemplateConfig = {
      key: "t1",
      ru: { text: "Баланс: {{user.balance}} $" },
      en: { text: "Balance: {{user.balance}} $" },
    };
    const out = renderTemplate(template, "ru", { "user.balance": 100 });
    assert.strictEqual(out.text, "Баланс: 100 $");
  });

  it("uses EN when lang en", () => {
    const template: TemplateConfig = {
      key: "t1",
      ru: { text: "Привет" },
      en: { text: "Hello" },
    };
    const out = renderTemplate(template, "en", {});
    assert.strictEqual(out.text, "Hello");
  });

  it("falls back to ru when en missing", () => {
    const template: TemplateConfig = {
      key: "t1",
      ru: { text: "Привет" },
    };
    const out = renderTemplate(template, "en", {});
    assert.strictEqual(out.text, "Привет");
  });
});
