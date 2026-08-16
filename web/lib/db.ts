import "server-only";
import { Pool, type QueryResultRow } from "pg";

// Next.js dev mode re-evaluates modules on every edit; without this the pool
// would leak connections until Postgres refuses new ones.
const globalForPg = globalThis as unknown as { leadsPool?: Pool };

function pool(): Pool {
  if (!globalForPg.leadsPool) {
    const connectionString =
      process.env.DATABASE_URL ?? "postgres://leads:leads@localhost:5432/leads";
    globalForPg.leadsPool = new Pool({ connectionString, max: 5 });
  }
  return globalForPg.leadsPool;
}

export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool().query<T>(text, params);
  return res.rows;
}

export async function sqlOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | undefined> {
  return (await sql<T>(text, params))[0];
}
