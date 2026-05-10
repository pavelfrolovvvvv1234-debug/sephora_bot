/**
 * Publish default scenario versions from sample JSON configs.
 * Run this once to enable scenarios.
 *
 * @module modules/automations/integration/publish-defaults
 */

import type { DataSource } from "typeorm";
import { ScenarioAdminService } from "../admin/scenario-admin.service.js";
import { ScenarioConfigSchema } from "../schemas/scenario-config.schema.js";
import type { ScenarioConfig } from "../schemas/scenario-config.schema.js";
import { readFileSync } from "fs";
import { join } from "path";

const SAMPLES_DIR = join(process.cwd(), "docs", "automations", "samples");

async function loadSampleConfig(key: string): Promise<ScenarioConfig | null> {
  try {
    const file = join(SAMPLES_DIR, `${key}.json`);
    const content = readFileSync(file, "utf-8");
    const parsed = JSON.parse(content);
    const validated = ScenarioConfigSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

export async function publishDefaultScenarios(dataSource: DataSource): Promise<number> {
  const service = new ScenarioAdminService(dataSource);
  const keys = ["B01", "B02", "B03", "S01", "S04", "S07", "S09", "S11"];
  let published = 0;
  for (const key of keys) {
    try {
      const config = await loadSampleConfig(key);
      if (!config) {
        console.log(`[Automations] No sample config for ${key}, skipping`);
        continue;
      }
      const existing = await service.getPublishedVersion(key);
      if (existing) {
        console.log(`[Automations] ${key} already has published version, skipping`);
        continue;
      }
      const version = await service.createVersion({
        scenarioKey: key,
        config: config as ScenarioConfig,
        status: "draft",
      });
      await service.publishVersion(key, version.id);
      published++;
      console.log(`[Automations] Published ${key}`);
    } catch (e) {
      console.error(`[Automations] Failed to publish ${key}:`, e);
    }
  }
  return published;
}
