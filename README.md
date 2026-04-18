# better-starlite3-drizzle

[Drizzle ORM](https://orm.drizzle.team) driver for [better-starlite3](https://github.com/tluyben/better-starlite3) — a unified async SQLite client that backs your queries with **better-sqlite3** (native), **best-sqlite3** (pure-JS/WASM), or **FlexDB** (distributed Raft cluster), all behind the same interface.

Switch drivers with one config line; your Drizzle schema and queries stay identical.

## Requirements

- Node.js 18+
- `drizzle-orm` ≥ 0.30
- `better-starlite3` ≥ 1.0

One of the underlying drivers must also be installed:

| Driver | Package | Use case |
|--------|---------|----------|
| `better-sqlite3` | `npm i better-sqlite3` | Native performance, local dev & production |
| `best-sqlite3` | `npm i best-sqlite3` | No native build required (CI, serverless, containers) |
| `flexdb` | `npm i flexdb-node` | Distributed Raft-replicated cluster |

## Installation

```sh
# From npm (once published)
npm install better-starlite3-drizzle drizzle-orm better-starlite3

# Dev setup — clones and builds GitHub dependencies automatically
git clone https://github.com/tluyben/better-starlite3-drizzle
cd better-starlite3-drizzle
npm install   # triggers scripts/clone-deps.sh → clones better-starlite3 + flexdb-node
```

`npm install` runs `scripts/clone-deps.sh` as a `preinstall` hook, which:
1. Clones `https://github.com/tluyben/flexdb-node` → `3rdparty/flexdb-node` and builds it
2. Clones `https://github.com/tluyben/better-starlite3` → `3rdparty/better-starlite3` and builds it

Both directories are listed in `.gitignore`.

## Quick start

```ts
import { open } from "better-starlite3";
import { drizzle } from "better-starlite3-drizzle";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";

const users = sqliteTable("users", {
  id:    integer("id").primaryKey({ autoIncrement: true }),
  name:  text("name").notNull(),
  email: text("email"),
});

// Pick any driver — only this line changes:
const client = await open({ driver: "better-sqlite3", filename: ":memory:" });
// const client = await open({ driver: "best-sqlite3",    filename: ":memory:" });
// const client = await open({ driver: "flexdb",          nodes: "http://localhost:4001" });

const db = drizzle(client);

await db.run(/* sql */`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT
)`);

await db.insert(users).values({ name: "Alice", email: "alice@example.com" });
const all = await db.select().from(users);
```

## API

### `drizzle(client, config?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `client` | `DatabaseClient` | A client opened with `better-starlite3`'s `open()` |
| `config.schema` | `Record<string, unknown>` | Optional relational schema for `db.query.*` API |
| `config.logger` | `boolean \| Logger` | Pass `true` for the built-in query logger |
| `config.casing` | `"snake_case" \| "camelCase"` | Column name casing convention |

Returns a `BetterStarlite3Database` which extends Drizzle's `BaseSQLiteDatabase<'async', ...>`.

`db.$client` exposes the raw `DatabaseClient` for driver-specific operations (e.g. calling `client.destroy()` on shutdown).

### CRUD

```ts
// SELECT
await db.select().from(users);
await db.select({ id: users.id }).from(users).where(eq(users.id, 1));

// INSERT
await db.insert(users).values({ name: "Bob" });
const result = await db.insert(users).values({ name: "Bob" }).run();
// result.rowsAffected, result.lastInsertRowid (BigInt)

// UPDATE
await db.update(users).set({ email: "new@example.com" }).where(eq(users.id, 1));

// DELETE
await db.delete(users).where(eq(users.id, 1));
```

### Transactions

```ts
await db.transaction(async (tx) => {
  await tx.update(accounts).set({ balance: sql`balance - ${100}` }).where(eq(accounts.id, 1));
  await tx.update(accounts).set({ balance: sql`balance + ${100}` }).where(eq(accounts.id, 2));
});
```

Transactions roll back automatically if the callback throws.

Nested transactions use SQL `SAVEPOINT` / `RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT`.

> **Note for better-sqlite3 and best-sqlite3 drivers:** The underlying `DatabaseClient.transaction()` implementation buffers all statements until commit to maintain atomicity. This means `SELECT` queries issued *inside* a transaction callback will return empty results with these drivers. Reads should be performed outside the transaction. FlexDB does not have this limitation.

### Raw SQL

```ts
import { sql } from "drizzle-orm";

await db.run(sql`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, msg TEXT)`);
const rows = await db.all(sql`SELECT * FROM logs WHERE msg LIKE ${"error%"}`);
const row  = await db.get(sql`SELECT * FROM users WHERE id = ${1}`);
const vals = await db.values(sql`SELECT id, name FROM users`);
```

### Migrations

```ts
import { migrate } from "better-starlite3-drizzle/migrator";

await migrate(db, { migrationsFolder: "./drizzle" });
```

Migrations are tracked in `__drizzle_migrations` (override with `migrationsTable`). Each pending migration runs inside a transaction. Migration files are generated by `drizzle-kit`.

### Relational queries

```ts
import { relations } from "drizzle-orm";

const posts = sqliteTable("posts", {
  id:     integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id),
  title:  text("title").notNull(),
});

const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
const postsRelations = relations(posts, ({ one }) => ({
  user: one(users, { fields: [posts.userId], references: [users.id] }),
}));

const db = drizzle(client, { schema: { users, posts, usersRelations, postsRelations } });

const result = await db.query.users.findMany({ with: { posts: true } });
```

### Logging

```ts
const db = drizzle(client, { logger: true });

const db = drizzle(client, {
  logger: { logQuery(query, params) { console.log("[SQL]", query, params); } },
});
```

### Switching drivers

```ts
// Local development
const client = await open({ driver: "better-sqlite3", filename: "./app.db" });

// CI / Docker (no native builds)
const client = await open({ driver: "best-sqlite3", filename: "./app.db" });

// Production cluster
const client = await open({
  driver: "flexdb",
  nodes: ["http://10.0.0.1:4001", "http://10.0.0.2:4001", "http://10.0.0.3:4001"],
  authToken: process.env.FLEXDB_TOKEN,
});

const db = drizzle(client);
// All queries, transactions, and migrations work identically across all three.
```

Call `client.destroy()` when your process exits to release resources (stops FlexDB health checks, closes the SQLite connection).

## Parameter syntax

better-starlite3 uses `?1 ?2 …` positional placeholders (SQLite numbered bind parameters). Drizzle generates `?` by default. `better-starlite3-drizzle` rewrites them automatically — no changes needed in your schema or queries.

## Limitations

- **Async only** — all three drivers are exposed through an async interface.
- **SELECT inside transactions (local SQLite)** — with `better-sqlite3` and `best-sqlite3`, queries inside `db.transaction()` are buffered until commit for atomicity. SELECT queries within the transaction callback will return empty results; read before entering the transaction instead. FlexDB does not have this limitation.
- **No `batch()`** — use `db.transaction()` for multi-statement atomicity.

## License

MIT
