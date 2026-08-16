import "server-only";
import { Pool, type QueryResultRow } from "pg";

// Next.js dev mode re-evaluates modules on every edit; without this the pool
// would leak connections until Postgres refuses new ones.
const globalForPg = globalThis as unknown as { leadsPool?: Pool };

function pool(): Pool {
  if (!globalForPg.leadsPool) {
    const connectionString =
      process.env.DATABASE_URL ?? "postgres://leads:leads@localhost:5432/leads";
    // Streaming means a page issues its queries concurrently instead of one at
    // a time, and the 1.5 s /api/jobs poll already holds three while a job
    // runs. At max: 5 those contended for the same handful of connections.
    globalForPg.leadsPool = new Pool({ connectionString, max: 15 });
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
