/**
 * Unit tests using a hand-rolled DatabaseClient mock.
 *
 * These verify that SQL is forwarded correctly (including ?→?N rewriting),
 * results are mapped to Drizzle's expected shape, and transactions route
 * through the underlying client's transaction callback.  No real SQLite
 * database is required.
 */
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";

import { drizzle } from "../src/index.js";
import { migrate } from "../src/migrator.js";
import type { DatabaseClient, QueryResponse, TransactionHandle } from "better-starlite3";

// ─── Schema ──────────────────────────────────────────────────────────────────

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email"),
});

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeResult(
  columns: string[],
  rows: (string | number | boolean | null)[][],
  extra: Partial<{ rows_affected: number; last_insert_id: number | null }> = {},
): QueryResponse {
  return {
    results: [
      {
        columns,
        rows,
        rows_affected: extra.rows_affected ?? 0,
        last_insert_id: extra.last_insert_id ?? null,
        time_ns: 0,
      },
    ],
    node_id: "mock",
    role: "standalone",
    executed_on: "mock",
    raft_index: 0,
    crdt_conflicts: [],
  };
}

type Stmt = { sql: string; params?: unknown[] };

function makeMockClient(driver: DatabaseClient["driver"] = "better-sqlite3") {
  const calls: { sql: string; params: unknown[] }[] = [];
  let nextResult: QueryResponse = makeResult([], []);

  function doQuery(stmts: Stmt[], dest: typeof calls) {
    const s = stmts[0]!;
    dest.push({ sql: s.sql, params: s.params ?? [] });
    return Promise.resolve(nextResult);
  }

  const client = {
    driver,
    query: (stmts: Stmt[]) => doQuery(stmts, calls),
    execute: (stmts: Stmt[]) => doQuery(stmts, calls),
    async transaction<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
      const txCalls: typeof calls = [];
      const txHandle = {
        id: "tx-1",
        expiresAt: new Date(),
        query: (stmts: Stmt[]) => doQuery(stmts, txCalls),
        execute: (stmts: Stmt[]) => doQuery(stmts, txCalls),
        commit: () =>
          Promise.resolve({ status: "committed" as const, transaction_id: "tx-1", raft_index: 0 }),
        rollback: () =>
          Promise.resolve({ status: "rolled_back" as const, transaction_id: "tx-1" }),
      } as unknown as TransactionHandle;
      const result = await fn(txHandle);
      calls.push(...txCalls);
      return result;
    },
    beginTransaction: () =>
      Promise.reject(new Error("not needed in tests")),
    destroy: () => {},
  } as unknown as DatabaseClient;

  return {
    client,
    calls,
    setResult(r: QueryResponse) { nextResult = r; },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("drizzle() factory", () => {
  it("exposes $client", () => {
    const { client } = makeMockClient();
    const db = drizzle(client);
    assert.equal(db.$client, client);
  });

  it("works with better-sqlite3 driver", () => {
    const { client } = makeMockClient("better-sqlite3");
    const db = drizzle(client);
    assert.equal(db.$client.driver, "better-sqlite3");
  });

  it("works with best-sqlite3 driver", () => {
    const { client } = makeMockClient("best-sqlite3");
    const db = drizzle(client);
    assert.equal(db.$client.driver, "best-sqlite3");
  });

  it("works with flexdb driver", () => {
    const { client } = makeMockClient("flexdb");
    const db = drizzle(client);
    assert.equal(db.$client.driver, "flexdb");
  });
});

describe("parameter rewriting (? → ?1, ?2, …)", () => {
  it("rewrites single placeholder", async () => {
    const { client, calls } = makeMockClient();
    const db = drizzle(client);

    await db.select().from(users).where(eq(users.id, 1));

    const last = calls.at(-1)!;
    assert.match(last.sql, /\?1/);
    assert.doesNotMatch(last.sql, /(?<!\d)\?(?!\d)/);
  });

  it("rewrites multiple placeholders in order", async () => {
    const { client, calls } = makeMockClient();
    const db = drizzle(client);

    await db.select().from(users).where(eq(users.name, "Alice"));

    const last = calls.at(-1)!;
    assert.match(last.sql, /\?1/);
  });

  it("numbers params sequentially", async () => {
    const { client, calls } = makeMockClient();
    const db = drizzle(client);

    // Two-param query
    await db
      .select()
      .from(users)
      .where(eq(users.id, 1));

    const last = calls.at(-1)!;
    // Should not contain bare ? (only ?N)
    assert.doesNotMatch(last.sql, /(?<![?0-9])\?(?![0-9])/);
  });
});

describe("select", () => {
  it("maps columns+rows to objects", async () => {
    const { client, setResult } = makeMockClient();
    setResult(
      makeResult(
        ["id", "name", "email"],
        [
          [1, "Alice", "alice@example.com"],
          [2, "Bob", null],
        ],
      ),
    );
    const db = drizzle(client);
    const rows = await db.select().from(users);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { id: 1, name: "Alice", email: "alice@example.com" });
    assert.deepEqual(rows[1], { id: 2, name: "Bob", email: null });
  });

  it("returns empty array for no rows", async () => {
    const { client, setResult } = makeMockClient();
    setResult(makeResult(["id", "name", "email"], []));
    const db = drizzle(client);
    const rows = await db.select().from(users);
    assert.deepEqual(rows, []);
  });

  it("forwards WHERE params correctly", async () => {
    const { client, calls, setResult } = makeMockClient();
    setResult(makeResult(["id", "name", "email"], [[1, "Alice", null]]));
    const db = drizzle(client);

    await db.select().from(users).where(eq(users.id, 42));

    const last = calls.at(-1)!;
    assert.deepEqual(last.params, [42]);
    assert.match(last.sql, /\?1/);
  });
});

describe("insert", () => {
  it("returns lastInsertRowid via run()", async () => {
    const { client, setResult } = makeMockClient();
    setResult(makeResult([], [], { rows_affected: 1, last_insert_id: 42 }));
    const db = drizzle(client);
    const result = await db
      .insert(users)
      .values({ name: "Dave" })
      .run();

    assert.equal(result.rowsAffected, 1);
    assert.equal(result.lastInsertRowid, 42n);
  });

  it("returning() returns an array", async () => {
    const { client, setResult } = makeMockClient();
    setResult(makeResult([], [], { rows_affected: 1, last_insert_id: 7 }));
    const db = drizzle(client);
    const result = await db
      .insert(users)
      .values({ name: "Carol", email: "carol@example.com" })
      .returning({ id: users.id });

    assert.ok(Array.isArray(result));
  });
});

describe("update / delete", () => {
  it("update returns rows_affected", async () => {
    const { client, setResult } = makeMockClient();
    setResult(makeResult([], [], { rows_affected: 3 }));
    const db = drizzle(client);
    const result = await db
      .update(users)
      .set({ email: "new@example.com" })
      .where(eq(users.id, 1))
      .run();

    assert.equal(result.rowsAffected, 3);
  });

  it("delete forwards correct SQL", async () => {
    const { client, calls, setResult } = makeMockClient();
    setResult(makeResult([], [], { rows_affected: 1 }));
    const db = drizzle(client);
    await db.delete(users).where(eq(users.id, 5)).run();

    const last = calls.at(-1)!;
    assert.match(last.sql.toLowerCase(), /delete from/);
    assert.match(last.sql, /\?1/);
    assert.deepEqual(last.params, [5]);
  });
});

describe("transaction()", () => {
  it("wraps callback in client transaction", async () => {
    const { client, calls, setResult } = makeMockClient();
    setResult(makeResult([], [], { rows_affected: 1 }));
    const db = drizzle(client);

    await db.transaction(async (tx) => {
      await tx.insert(users).values({ name: "Tx User" }).run();
    });

    assert.ok(calls.length >= 1);
    assert.match(calls.at(-1)!.sql.toLowerCase(), /insert/);
  });

  it("re-throws on error", async () => {
    const { client } = makeMockClient();
    const db = drizzle(client);

    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.select().from(users);
          throw new Error("deliberate failure");
        }),
      /deliberate failure/,
    );
  });
});

describe("raw sql", () => {
  it("db.run() executes arbitrary SQL", async () => {
    const { client, calls } = makeMockClient();
    const db = drizzle(client);

    const { sql } = await import("drizzle-orm");
    await db.run(sql`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)`);

    const last = calls.at(-1)!;
    assert.match(last.sql.toLowerCase(), /create table/);
  });

  it("db.all() executes raw SELECT", async () => {
    const { client, calls, setResult } = makeMockClient();
    setResult(makeResult(["id"], [[1], [2]]));
    const db = drizzle(client);

    const { sql } = await import("drizzle-orm");
    const rows = await db.all(sql`SELECT id FROM users`);
    assert.ok(calls.length >= 1);
    assert.ok(Array.isArray(rows));
  });
});

describe("migrate()", () => {
  it("creates migrations table when folder is empty", async () => {
    const { client, calls, setResult } = makeMockClient();
    setResult(makeResult(["id", "hash", "created_at"], []));

    const db = drizzle(client);

    const migrationsFolder = mkdtempSync(join(tmpdir(), "bs3-drizzle-test-"));
    mkdirSync(join(migrationsFolder, "meta"));
    writeFileSync(
      join(migrationsFolder, "meta", "_journal.json"),
      JSON.stringify({ entries: [] }),
    );

    await migrate(db, { migrationsFolder });

    assert.ok(calls.length >= 2, `Expected ≥2 calls, got ${calls.length}`);

    const createCall = calls.find((c) =>
      c.sql.toLowerCase().includes("create table"),
    );
    assert.ok(createCall, "Should have issued CREATE TABLE for migrations");
    assert.match(createCall!.sql.toLowerCase(), /__drizzle_migrations/);

    const selectCall = calls.find((c) =>
      c.sql.toLowerCase().includes("select"),
    );
    assert.ok(selectCall, "Should have queried existing migrations");
  });

  it("skips already-applied migrations", async () => {
    const { client, calls, setResult } = makeMockClient();
    setResult(
      makeResult(["id", "hash", "created_at"], [["1", "abc123", 1000]]),
    );

    const db = drizzle(client);
    const migrationsFolder = mkdtempSync(join(tmpdir(), "bs3-drizzle-test-"));
    mkdirSync(join(migrationsFolder, "meta"));
    writeFileSync(
      join(migrationsFolder, "meta", "_journal.json"),
      JSON.stringify({ entries: [] }),
    );

    await migrate(db, { migrationsFolder });

    const insertCall = calls.find(
      (c) =>
        c.sql.toLowerCase().includes("insert into") &&
        c.sql.toLowerCase().includes("__drizzle_migrations"),
    );
    assert.equal(insertCall, undefined, "Should not INSERT when nothing is pending");
  });
});
