import { createRequire } from "node:module";
import type { DatabaseClient, TransactionHandle, StatementResult } from "better-starlite3";
import { entityKind } from "drizzle-orm/entity";
import { NoopLogger, type Logger } from "drizzle-orm/logger";
import { fillPlaceholders, sql as drizzleSql } from "drizzle-orm/sql/sql";
import type { Query } from "drizzle-orm/sql/sql";
import {
  BaseSQLiteDatabase,
  SQLiteAsyncDialect,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";
import {
  SQLiteSession,
  SQLitePreparedQuery,
  type PreparedQueryConfig,
  type SQLiteExecuteMethod,
} from "drizzle-orm/sqlite-core/session";
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core";
import type {
  ExtractTablesWithRelations,
  RelationalSchemaConfig,
  TablesRelationalConfig,
} from "drizzle-orm/relations";

// mapResultRow is exported from the JS but not typed in .d.ts
const _require = createRequire(import.meta.url);
const { mapResultRow: _mapResultRow } = _require("drizzle-orm/utils") as {
  mapResultRow: (
    fields: SelectedFieldsOrdered,
    row: unknown[],
    joinsNotNullableMap: Record<string, boolean> | undefined,
  ) => Record<string, unknown>;
};

/** A DatabaseClient or a TransactionHandle (both have query/execute). */
export type BetterStarlite3Client = DatabaseClient | TransactionHandle;

export interface BetterStarlite3RunResult {
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}

/** Convert Drizzle's `?` positional placeholders to better-starlite3's `?1`, `?2`, … style. */
function numberParams(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `?${++i}`);
}

/** Map a row array + column list to a plain object. */
function rowToObj(columns: string[], row: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]!] = row[i];
  }
  return obj;
}

function mapRow(
  fields: SelectedFieldsOrdered,
  row: unknown[],
  joinsNotNullableMap: Record<string, boolean> | undefined,
): Record<string, unknown> {
  return _mapResultRow(fields, row, joinsNotNullableMap);
}

const EMPTY_RESULT: StatementResult = {
  columns: [],
  rows: [],
  rows_affected: 0,
  last_insert_id: null,
  time_ns: 0,
};

async function doQuery(
  client: BetterStarlite3Client,
  sql: string,
  params: unknown[],
): Promise<StatementResult> {
  const numbered = numberParams(sql);
  const p = params as (string | number | boolean | null)[];
  const resp = await client.query([{ sql: numbered, params: p }]);
  // Local SQLite TransactionHandles buffer statements and return empty results[].
  return resp.results[0] ?? EMPTY_RESULT;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrepared = any;

export class BetterStarlite3PreparedQuery<
  T extends PreparedQueryConfig & { type: "async" },
> extends SQLitePreparedQuery<T> {
  static readonly [entityKind]: string = "BetterStarlite3PreparedQuery";

  constructor(
    private client: BetterStarlite3Client,
    query: Query,
    private logger: Logger,
    private _fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    _isResponseInArrayMode: boolean,
    private _customResultMapper:
      | ((
          rows: unknown[][],
          mapColumnValue?: (value: unknown) => unknown,
        ) => unknown)
      | undefined,
  ) {
    super("async", executeMethod, query);
  }

  async run(placeholderValues?: Record<string, unknown>): Promise<BetterStarlite3RunResult> {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const result = await doQuery(this.client, this.query.sql, params);
    return {
      rowsAffected: result.rows_affected,
      lastInsertRowid:
        result.last_insert_id != null ? BigInt(result.last_insert_id) : undefined,
    };
  }

  async all(placeholderValues?: Record<string, unknown>): Promise<unknown[]> {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const result = await doQuery(this.client, this.query.sql, params);

    if (!this._fields && !this._customResultMapper) {
      return result.rows.map((row) => rowToObj(result.columns, row));
    }
    return this.mapAllResult(result.rows) as unknown[];
  }

  mapAllResult(rows: unknown, isFromBatch?: boolean): unknown {
    const raw = isFromBatch
      ? (rows as { rows: unknown[][] }).rows
      : (rows as unknown[][]);

    if (!this._fields && !this._customResultMapper) {
      return raw;
    }
    if (this._customResultMapper) {
      return this._customResultMapper(raw);
    }
    const jnnm = (this as AnyPrepared).joinsNotNullableMap as
      | Record<string, boolean>
      | undefined;
    return raw.map((row) => mapRow(this._fields!, row as unknown[], jnnm));
  }

  async get(placeholderValues?: Record<string, unknown>): Promise<unknown> {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const result = await doQuery(this.client, this.query.sql, params);

    if (!this._fields && !this._customResultMapper) {
      return result.rows.length > 0
        ? rowToObj(result.columns, result.rows[0]!)
        : undefined;
    }
    return this.mapGetResult(result.rows);
  }

  mapGetResult(rows: unknown, isFromBatch?: boolean): unknown {
    const raw = isFromBatch
      ? (rows as { rows: unknown[][] }).rows
      : (rows as unknown[][]);
    const row = raw[0];

    if (!this._fields && !this._customResultMapper) {
      return row ? rowToObj([], row) : undefined;
    }
    if (!row) return undefined;
    if (this._customResultMapper) {
      return this._customResultMapper(raw);
    }
    const jnnm = (this as AnyPrepared).joinsNotNullableMap as
      | Record<string, boolean>
      | undefined;
    return mapRow(this._fields!, row as unknown[], jnnm);
  }

  async values(placeholderValues?: Record<string, unknown>): Promise<unknown[][]> {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const result = await doQuery(this.client, this.query.sql, params);
    return result.rows;
  }
}

export class BetterStarlite3Transaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<"async", BetterStarlite3RunResult, TFullSchema, TSchema> {
  static readonly [entityKind]: string = "BetterStarlite3Transaction";

  override async transaction<T>(
    transaction: (tx: BetterStarlite3Transaction<TFullSchema, TSchema>) => Promise<T>,
  ): Promise<T> {
    const self = this as AnyPrepared;
    const savepointName = `sp${self.nestedIndex}`;
    const tx = new BetterStarlite3Transaction<TFullSchema, TSchema>(
      "async",
      self.dialect,
      self.session,
      self.schema,
      self.nestedIndex + 1,
    );
    await self.session.run(drizzleSql.raw(`SAVEPOINT ${savepointName}`));
    try {
      const result = await transaction(tx);
      await self.session.run(drizzleSql.raw(`RELEASE SAVEPOINT ${savepointName}`));
      return result;
    } catch (err) {
      await self.session.run(drizzleSql.raw(`ROLLBACK TO SAVEPOINT ${savepointName}`));
      throw err;
    }
  }
}

export class BetterStarlite3Session<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteSession<"async", BetterStarlite3RunResult, TFullSchema, TSchema> {
  static readonly [entityKind]: string = "BetterStarlite3Session";

  private logger: Logger;

  constructor(
    private client: BetterStarlite3Client,
    dialect: SQLiteAsyncDialect,
    private schema: RelationalSchemaConfig<TSchema> | undefined,
    private options: { logger?: Logger },
  ) {
    super(dialect);
    this.logger = options.logger ?? new NoopLogger();
  }

  prepareQuery(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: (
      rows: unknown[][],
      mapColumnValue?: (value: unknown) => unknown,
    ) => unknown,
  ): BetterStarlite3PreparedQuery<PreparedQueryConfig & { type: "async" }> {
    return new BetterStarlite3PreparedQuery(
      this.client,
      query,
      this.logger,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  override async transaction<T>(
    transaction: (tx: BetterStarlite3Transaction<TFullSchema, TSchema>) => Promise<T>,
  ): Promise<T> {
    const self = this as AnyPrepared;
    const rootClient = this.client as DatabaseClient;
    return rootClient.transaction(async (txHandle: TransactionHandle) => {
      const txSession = new BetterStarlite3Session<TFullSchema, TSchema>(
        txHandle,
        self.dialect,
        this.schema,
        this.options,
      );
      const tx = new BetterStarlite3Transaction<TFullSchema, TSchema>(
        "async",
        self.dialect,
        txSession,
        this.schema,
      );
      return transaction(tx);
    });
  }
}

export class BetterStarlite3Database<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends BaseSQLiteDatabase<
  "async",
  BetterStarlite3RunResult,
  TSchema,
  ExtractTablesWithRelations<TSchema>
> {
  static readonly [entityKind]: string = "BetterStarlite3Database";

  /** The underlying DatabaseClient — for driver-specific operations, teardown, etc. */
  readonly $client: DatabaseClient;

  constructor(
    client: DatabaseClient,
    session: BetterStarlite3Session<TSchema, ExtractTablesWithRelations<TSchema>>,
    schema: RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined,
    dialect: SQLiteAsyncDialect,
  ) {
    super("async", dialect, session, schema);
    this.$client = client;
  }
}
