import { Pool, PoolClient, QueryResultRow } from "pg";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL not set. Start the database with `npm run db:up` and set " +
          "DATABASE_URL=postgres://leads:leads@localhost:5432/leads in .env"
      );
    }
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
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
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Fails fast with an actionable message instead of an ECONNREFUSED stack. */
export async function assertDbReachable(): Promise<void> {
  try {
    await query("SELECT 1");
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(
      `Cannot reach Postgres (${msg}).\n` +
        `  Start it with:  npm run db:up\n` +
        `  Then migrate:   npm run db:migrate`
    );
  }
}
