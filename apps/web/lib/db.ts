import "server-only";
import type { QueryResultRow } from "pg";
// Narrow entry point on purpose: the dashboard has no business bundling the
// Receita loader or the LLM adapters just to get a connection pool.
import { createDb, getPool } from "@leads/core/db";

/**
 * One pool, shared with the core.
 *
 * This module used to build its own `pg.Pool` because importing anything from
 * the old `src/` would have dragged a second pool into the Next server. The
 * core now owns a `globalThis`-cached pool with the same hot-reload protection
 * this file pioneered, so the dashboard just borrows it.
 *
 * `sql`/`sqlOne` stay as they are: every page and action in the app calls them,
 * and the read layer is not domain logic that belongs in the core.
 */
const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://leads:leads@localhost:5432/leads";

// Streaming means a page issues its queries concurrently instead of one at a
// time, and the 1.5 s /api/jobs poll already holds three while a job runs. At
// max: 5 those contended for the same handful of connections.
const db = createDb(CONNECTION, 15);

/** Exposed for the rare caller that needs the pool itself. */
export const pool = () => getPool(CONNECTION, 15);

export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  return db.query<T>(text, params);
}

export async function sqlOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | undefined> {
  return db.one<T>(text, params);
}

/** The core `Db` port, for anything that wants to call a use-case directly. */
export { db };
