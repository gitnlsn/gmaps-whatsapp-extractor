-- The ideal-customer profile, and what the compiler managed to do with it.
--
-- These live on `offer_specs` rather than on `offers` because that table is
-- append-only per version: the profile the operator wrote, and the mapping the
-- model produced from it, stay attached to the exact rubric version they
-- produced. Re-compiling an offer therefore does not rewrite the record of what
-- the previous targeting was based on.
--
-- Deliberately NOT inside `spec` JSONB: that column is the scoring contract,
-- validated field by field by parseOfferSpec. This is metadata about the
-- compilation, and mixing the two would mean loosening a validator that exists
-- to be strict.

-- Exactly what the operator typed. Never rewritten.
ALTER TABLE offer_specs ADD COLUMN IF NOT EXISTS icp_text TEXT;

-- [{criterion, mapped, mappedTo}] — one row per distinct criterion.
-- The `mapped: false` entries are the point: the Receita base carries no
-- headcount, revenue or tooling, so a profile asking for them yields a filter
-- that does not exist. Recording that is what stops the operator assuming the
-- shortlist is narrower than it is.
ALTER TABLE offer_specs ADD COLUMN IF NOT EXISTS icp_coverage JSONB;

-- A pipeline run can now START with compiling the offer, which means the run
-- exists before the offer does — the checklist has to be able to show
-- "compilando…" live, and it cannot do that if the row it writes to is rejected
-- by a foreign key to a row the run is about to create.
--
-- Dropping the constraint also makes the runs an audit trail that outlives its
-- subject, which is the same call `suppression_log` makes: what happened stays
-- recorded even when what it happened to is gone.
ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_offer_id_fkey;
