import { readFileSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import type pricesSchema from "../prices.json";

/** Load prices from disk each time so edits apply after restart (and match last `npm run build`). */
export default async (): Promise<typeof pricesSchema> => {
  const fromDistBundle = typeof __filename === "string" && __filename.includes(`${sep}dist${sep}`);
  const distPrices = join(process.cwd(), "dist", "prices.json");
  const srcPrices = join(process.cwd(), "src", "prices.json");
  const paths = fromDistBundle
    ? [
        distPrices,
        srcPrices,
        join(process.cwd(), "prices.json"),
        join(__dirname || process.cwd(), "..", "prices.json"),
      ]
    : [
        srcPrices,
        distPrices,
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
