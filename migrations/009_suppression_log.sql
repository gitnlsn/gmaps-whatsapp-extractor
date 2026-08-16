-- 009_suppression_log.sql
--
-- Two things: an audit trail for suppression changes, and a backfill for rows
-- the dashboard wrote incompletely.
--
-- ## Why a log table and not a `removed_at` flag on `suppression`
--
-- Undoing an opt-out now removes the suppression entry. The obvious design is a
-- soft delete — add `removed_at`, and have every reader add
-- `AND removed_at IS NULL`. That was rejected: `suppression` is read in five
-- places (src/offers/rank.ts, src/score.ts, src/queue.ts, web/lib/queries.ts,
-- and the enrich candidate query), and ONE forgotten predicate would silently
-- contact somebody who asked never to be contacted again.
--
-- With an append-only log next to an unchanged `suppression` table, the worst
-- case of the same mistake is a missing audit line. The failure directions are
-- not symmetric, so the design follows the safer one.

CREATE TABLE IF NOT EXISTS suppression_log (
  id         SERIAL PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('added','removed')),
  reason     TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS suppression_log_phone_idx
  ON suppression_log (phone_e164, at DESC);

-- Anything already suppressed predates the log; record it so the table is a
-- complete history rather than one starting mid-story.
INSERT INTO suppression_log (phone_e164, action, reason, at)
SELECT phone_e164, 'added', reason, added_at FROM suppression
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------- outreach fix
--
-- `setStatus` in the dashboard predates migration 006 and never wrote offer_id
-- or phone_e164, while the CLI's mark() did. Rows written from the browser are
-- therefore invisible to /demand (which filters offer_id IS NOT NULL) and are
-- skipped by outreach_one_per_phone_idx, a PARTIAL index over
-- `phone_e164 IS NOT NULL` — so the one-contact-per-person guarantee simply did
-- not apply to them. The code is fixed alongside this; these rows need
-- repairing.

UPDATE outreach o
   SET phone_e164 = COALESCE(o.phone_e164, l.phone_e164),
       offer_id   = COALESCE(o.offer_id, (SELECT id FROM offers WHERE active LIMIT 1))
  FROM leads l
 WHERE l.cnpj = o.cnpj
   AND (o.phone_e164 IS NULL OR o.offer_id IS NULL);

-- If two rows were written for the same human while the index was inert, the
-- unique index below could not have caught it. Fail loudly rather than leave a
-- silent LGPD violation in the data.
DO $guard$
DECLARE dupes INTEGER;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT phone_e164 FROM outreach
     WHERE phone_e164 IS NOT NULL
     GROUP BY phone_e164 HAVING count(*) > 1) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'outreach tem % telefone(s) com mais de um registro — provavelmente gravados '
      'pelo painel enquanto o índice único estava inerte. Resolva à mão antes de seguir.', dupes;
  END IF;
END
$guard$;
