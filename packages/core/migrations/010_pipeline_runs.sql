-- One row per "run the whole pipeline for this offer".
--
-- The `jobs` table already records that a process ran and keeps its log tail.
-- What it cannot say is which stage a run is on, because a pipeline run is a
-- single job by design: `jobs_one_running_idx` permits exactly one running job,
-- so chaining N jobs would need an orchestrator above the table with idempotent
-- advance and a race on every poll. One sequential process avoids all of that
-- and gets cancellation, log streaming and crash reconciliation for free.
--
-- This table is what the process writes as it moves, so the dashboard can draw
-- a checklist instead of asking a human to read a log.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          SERIAL PRIMARY KEY,
  offer_id    TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  -- Nullable: the CLI can run a pipeline with no dashboard job behind it.
  job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  -- [{key, label, status, note, startedAt, finishedAt}] in execution order.
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- No "only one running" index here on purpose: that guarantee stays with
-- jobs_one_running_idx, so there is exactly one place that enforces it.
CREATE INDEX IF NOT EXISTS pipeline_runs_offer_idx
  ON pipeline_runs (offer_id, started_at DESC);
