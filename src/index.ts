import type { DatabaseClient } from "better-starlite3";
import { DefaultLogger } from "drizzle-orm/logger";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type ExtractTablesWithRelations,
  type RelationalSchemaConfig,
  type TablesRelationalConfig,
} from "drizzle-orm/relations";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { DrizzleConfig } from "drizzle-orm/utils";
import {
  BetterStarlite3Database,
  BetterStarlite3Session,
  type BetterStarlite3RunResult,
} from "./session.js";

export {
  BetterStarlite3Database,
  BetterStarlite3Session,
  BetterStarlite3Transaction,
  BetterStarlite3PreparedQuery,
} from "./session.js";
export type { BetterStarlite3RunResult } from "./session.js";

/**
 * Create a Drizzle ORM database backed by better-starlite3.
 *
 * Works with all three underlying drivers: better-sqlite3, best-sqlite3,
 * and FlexDB. Open a DatabaseClient with `open()` from better-starlite3,
 * then pass it here.
 *
 * @example
 * ```ts
 * import { open } from "better-starlite3";
 * import { drizzle } from "better-starlite3-drizzle";
 * import { users } from "./schema";
 *
 * const client = await open({ driver: "better-sqlite3", filename: ":memory:" });
 * const db = drizzle(client);
 *
 * const rows = await db.select().from(users);
 * ```
 */
export function drizzle<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  client: DatabaseClient,
  config: DrizzleConfig<TSchema> = {},
): BetterStarlite3Database<TSchema> {
  const dialect = new SQLiteAsyncDialect({ casing: config.casing });

  let logger;
  if (config.logger === true) {
    logger = new DefaultLogger();
  } else if (config.logger !== false) {
    logger = config.logger;
  }

  let schema:
    | RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>>
    | undefined;

  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(
      config.schema,
      createTableRelationsHelpers,
    );
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables as ExtractTablesWithRelations<TSchema>,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const session = new BetterStarlite3Session<
    TSchema,
    ExtractTablesWithRelations<TSchema>
  >(client, dialect, schema, { logger });

  return new BetterStarlite3Database<TSchema>(client, session, schema, dialect);
}
