import type { Deps } from "../ports/index";

/**
 * Materialized views that stand in for whole-base aggregates (migration 008).
 *
 * The dashboard used to count 2.1M rows on every page load. That cost is not
 * fixable with indexes — `count(*) WHERE phone_e164 IS NOT NULL` already plans
 * as an index-only scan with zero heap fetches and still takes 1.3 s. The only
 * way past it is to compute the answer once, when the underlying rows change.
 *
 * "When the underlying rows change" means: at the end of a pipeline stage that
 * touched `leads`. Between runs these numbers are constant, so refreshing here
 * is not a staleness trade — it is the exact moment they move.
 */
const ROLLUPS = ["leads_rollup", "lead_stats", "coverage_rollup"] as const;

/**
 * CONCURRENTLY is what makes this safe to call from a running pipeline: a plain
 * REFRESH takes an ACCESS EXCLUSIVE lock and would freeze every dashboard read
 * for the length of the rebuild. It needs a UNIQUE index on each view, which
 * migration 008 creates. It also cannot run inside a transaction block.
 */
export async function refreshRollups(deps: Deps): Promise<void> {
  for (const name of ROLLUPS) {
    const started = Date.now();
    try {
      await deps.db.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${name}`);
    } catch (err) {
      // A view that has never held data cannot be refreshed concurrently.
      // Fall back to a plain refresh to populate it the first time.
      const msg = (err as Error).message;
      if (!/concurrently/i.test(msg)) throw err;
      await deps.db.query(`REFRESH MATERIALIZED VIEW ${name}`);
    }
    deps.progress.tick(1, `${name} (${Date.now() - started} ms)`);
  }
}

/**
 * Refreshes without ever failing the caller.
 *
 * Used at the tail of pipeline stages: the stage's real work is already
 * committed by this point, so a refresh problem should surface as a warning and
 * a stale dashboard, not as a failed `enrich` run.
 */
export async function refreshRollupsQuietly(deps: Deps): Promise<void> {
  try {
    await refreshRollups(deps);
  } catch (err) {
    deps.progress.warn(`rollup refresh failed: ${(err as Error).message}`);
  }
}
