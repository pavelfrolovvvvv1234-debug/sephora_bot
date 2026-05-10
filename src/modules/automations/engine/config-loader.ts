/**
 * Load published scenario config by key.
 *
 * @module modules/automations/engine/config-loader
 */

import type { DataSource } from "typeorm";
import type { ScenarioConfig } from "../schemas/scenario-config.schema.js";
import { ScenarioConfigSchema } from "../schemas/scenario-config.schema.js";
import ScenarioVersion from "../../../entities/automations/ScenarioVersion.js";

export async function getPublishedConfig(
  dataSource: DataSource,
  scenarioKey: string
): Promise<ScenarioConfig | null> {
  const repo = dataSource.getRepository(ScenarioVersion);
  const row = await repo.findOne({
    where: { scenarioKey, status: "published" },
    order: { publishedAt: "DESC" },
  });
  if (!row?.config) return null;
  const parsed = ScenarioConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : null;
}

export async function getAllPublishedKeys(dataSource: DataSource): Promise<string[]> {
  const repo = dataSource.getRepository(ScenarioVersion);
  const rows = await repo.find({
    where: { status: "published" },
    select: ["scenarioKey"],
  });
  return [...new Set(rows.map((r) => r.scenarioKey))];
}
