import { createDb, closePool } from "../../src/db/pg";
import { migrateSchema } from "../../src/usecases/migrateSchema";
import { silentProgress, type Db, type Deps } from "../../src/ports/index";

/**
 * A scratch database on the same Postgres `docker-compose.yml` already runs.
 *
 * The whole point of testing against the real thing is that the invariants that
 * matter here are not in TypeScript — they are partial unique indexes, `NOT
 * EXISTS` predicates and a rank expression built by string interpolation. A
 * mock would agree with whatever the code does and prove nothing.
 */

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://leads:leads@localhost:5432/leads";
const TEST_DB_PREFIX = process.env.LEADS_TEST_DB ?? "leads_test";

/**
 * One database per test file.
 *
 * Node's test runner runs files in parallel processes, so a single shared
 * scratch database means two suites racing to DROP and CREATE it — which fails
 * with a duplicate-key error on pg_database rather than anything informative.
 */
function dbName(suite: string): string {
  const safe = suite.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  return `${TEST_DB_PREFIX}_${safe}`;
}

export function testUrl(suite: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName(suite)}`;
  return u.toString();
}

export interface TestContext {
  db: Db;
  deps: Deps;
  /** Deps with a given port overridden, for stubbing the paid APIs. */
  withPorts(extra: Partial<Deps>): Deps;
}

/**
 * Drops and recreates the scratch database, then migrates it.
 *
 * Recreated rather than truncated so a schema change in a migration is exercised
 * on every run — the migration runner is itself one of the things under test.
 */
export async function setupTestDb(suite: string): Promise<TestContext> {
  const name = dbName(suite);
  const admin = createDb(ADMIN_URL, 2);

  // CREATE/DROP DATABASE cannot run inside a transaction block; the pool's
  // implicit autocommit is what makes these plain queries work.
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await closePool(ADMIN_URL);

  const url = testUrl(suite);
  const db = createDb(url, 5);
  const deps: Deps = { db, progress: silentProgress };
  await migrateSchema(deps);

  return {
    db,
    deps,
    withPorts: (extra) => ({ ...deps, ...extra }),
  };
}

export async function teardownTestDb(suite: string): Promise<void> {
  await closePool(testUrl(suite));
}
