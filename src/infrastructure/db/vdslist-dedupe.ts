/**
 * Before TypeORM adds UNIQUE(vdsId) via synchronize, duplicate rows break SQLite table recreation.
 * Removes extra rows per vdsId, keeping the smallest id (oldest record).
 *
 * @module infrastructure/db/vdslist-dedupe
 */

import path from "path";
import Database from "better-sqlite3";
import { Logger } from "../../app/logger.js";

export function dedupeVdslistDuplicateVdsIds(databasePath: string): void {
  const resolved = path.isAbsolute(databasePath) ? databasePath : path.resolve(process.cwd(), databasePath);
  let db: Database.Database | undefined;
  try {
    db = new Database(resolved);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vdslist'")
      .get() as { name: string } | undefined;
    if (!row) return;

    const dupGroups = db
      .prepare(
        `SELECT "vdsId" AS vdsId, COUNT(*) AS c FROM vdslist GROUP BY "vdsId" HAVING c > 1`
      )
      .all() as { vdsId: number; c: number }[];

    if (dupGroups.length === 0) return;

    const totalExtra = dupGroups.reduce((acc, g) => acc + (g.c - 1), 0);
    Logger.warn(
      `vdslist: deduplicating ${dupGroups.length} vdsId group(s) (~${totalExtra} duplicate row(s)) before schema sync`
    );

    const result = db
      .prepare(
        `DELETE FROM vdslist WHERE id NOT IN (SELECT MIN(id) FROM vdslist GROUP BY "vdsId")`
      )
      .run();

    Logger.warn(`vdslist: removed ${result.changes} duplicate row(s); kept MIN(id) per vdsId`);
  } finally {
    db?.close();
  }
}
