-- Pipeline runs started from the dashboard.
--
-- The web app does not reimplement enrich/score/places; it shells out to the
-- same `tsx src/cli.ts` the terminal uses and records the run here.

CREATE TABLE IF NOT EXISTS jobs (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,        -- enrich | score | places
  args        TEXT[] NOT NULL,      -- exact argv handed to the CLI
  status      TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  log         TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  error       TEXT,
  pid         INTEGER,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- At most one job in flight, enforced by the database rather than by
-- application code: two Server Action invocations can interleave, and a
-- SELECT-then-INSERT guard would race between them.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running_idx
  ON jobs ((status)) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS jobs_recent_idx ON jobs (started_at DESC);
