import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { Db } from "../ports/index";

/**
 * The pg implementation of the `Db` port.
 *
 * Pools are cached on `globalThis`, not in a module-level `let`. Next.js
 * re-evaluates modules on every edit in dev, and a module-local pool would leak
 * a fresh set of connections on each save until Postgres started refusing them.
 * The dashboard had already learned this the hard way and solved it in its own
 * db module; folding that fix in here is what lets both apps share one pool.
 */
const globalForPg = globalThis as unknown as { leadsPools?: Map<string, Pool> };
const pools = (globalForPg.leadsPools ??= new Map<string, Pool>());

export function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL not set. Start the database with `pnpm db:up` and set " +
        "DATABASE_URL=postgres://leads:leads@localhost:5432/leads in .env"
    );
  }
  return url;
}

export function getPool(url = connectionString(), max = 10): Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max });
    pools.set(url, pool);
  }
  return pool;
}

/**
 * Builds a `Db` bound to one connection string. Tests point this at a scratch
 * database; the apps call it with no argument and get the configured one.
 */
export function createDb(url = connectionString(), max = 10): Db {
  const pool = getPool(url, max);

  async function query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<T[]> {
    const res = await pool.query<T extends QueryResultRow ? T : QueryResultRow>(
      text,
      params as unknown[]
    );
    return res.rows as T[];
  }

  async function withClient<R>(fn: (client: PoolClient) => Promise<R>): Promise<R> {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  return {
    query,
    async one<T = Record<string, unknown>>(text: string, params?: unknown[]) {
      const rows = await query<T>(text, params);
      return rows[0];
    },
    withClient,
    withTransaction<R>(fn: (client: PoolClient) => Promise<R>): Promise<R> {
      return withClient(async (client) => {
        await client.query("BEGIN");
        try {
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      });
    },
  };
}

export async function closePool(url?: string): Promise<void> {
  if (url) {
    const pool = pools.get(url);
    if (pool) {
      await pool.end();
      pools.delete(url);
    }
    return;
  }
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

/** Fails fast with an actionable message instead of an ECONNREFUSED stack. */
export async function assertDbReachable(db: Db): Promise<void> {
  try {
    await db.query("SELECT 1");
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(
      `Cannot reach Postgres (${msg}).\n` +
        `  Start it with:  pnpm db:up\n` +
        `  Then migrate:   pnpm db:migrate`
    );
  }
}
