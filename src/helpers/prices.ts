import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type pricesSchema from "../prices.json";

/** Load prices from disk each time so edits to prices.json apply without restart. */
export default async (): Promise<typeof pricesSchema> => {
  // Try multiple paths: src/prices.json (dev), dist/../prices.json (built), or current working directory
  const paths = [
    join(process.cwd(), "src", "prices.json"),
    join(process.cwd(), "prices.json"),
    join(__dirname || process.cwd(), "..", "prices.json"),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as typeof pricesSchema;
    }
  }

  throw new Error("prices.json not found in any expected location");
};
