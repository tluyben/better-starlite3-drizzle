import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm/sql/sql";
import type { BetterStarlite3Database } from "./session.js";

/**
 * Run pending Drizzle migrations against a better-starlite3 database.
 *
 * Migrations are tracked in a `__drizzle_migrations` table (configurable via
 * `migrationsTable`). Each migration runs inside a transaction so failures
 * leave the database unchanged.
 *
 * @example
 * ```ts
 * import { open } from "better-starlite3";
 * import { drizzle } from "better-starlite3-drizzle";
 * import { migrate } from "better-starlite3-drizzle/migrator";
 *
 * const client = await open({ driver: "better-sqlite3", filename: "./app.db" });
 * const db = drizzle(client);
 * await migrate(db, { migrationsFolder: "./drizzle" });
 * ```
 */
export async function migrate<TSchema extends Record<string, unknown>>(
  db: BetterStarlite3Database<TSchema>,
  config: MigrationConfig,
): Promise<void> {
  const migrations = readMigrationFiles(config);
  const migrationsTable = config.migrationsTable ?? "__drizzle_migrations";

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT    NOT NULL,
      created_at NUMERIC
    )
  `);

  const applied = await db.values<[string, string, number]>(
    sql`SELECT id, hash, created_at FROM ${sql.identifier(migrationsTable)} ORDER BY created_at DESC LIMIT 1`,
  );
  const lastApplied = applied[0];

  const pending = migrations.filter(
    (m) => !lastApplied || Number(lastApplied[2]) < m.folderMillis,
  );

  if (pending.length === 0) return;

  await db.transaction(async (tx) => {
    for (const migration of pending) {
      for (const stmt of migration.sql) {
        await tx.run(sql.raw(stmt));
      }
      await tx.run(
        sql`INSERT INTO ${sql.identifier(migrationsTable)} (hash, created_at)
            VALUES (${migration.hash}, ${migration.folderMillis})`,
      );
    }
  });
}
