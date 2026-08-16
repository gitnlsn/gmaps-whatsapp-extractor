-- Marks that a lead has been through the Google Places lens.
--
-- Only our own observations are persisted. Google's name, address, phone,
-- rating and review count are used in-run and discarded, because the Maps
-- Platform terms permit caching place_id indefinitely but not the content.
-- `google_checked_at` is our timestamp, and `google_found` records only
-- whether a match existed at all.

ALTER TABLE enrichment ADD COLUMN IF NOT EXISTS google_checked_at TIMESTAMPTZ;
ALTER TABLE enrichment ADD COLUMN IF NOT EXISTS google_found      BOOLEAN;

CREATE INDEX IF NOT EXISTS enrichment_google_idx
  ON enrichment (google_checked_at NULLS FIRST);
