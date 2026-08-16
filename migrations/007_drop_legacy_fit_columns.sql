-- 007_drop_legacy_fit_columns.sql
--
-- Removes the last trace of "the product is two integer columns".
--
-- Migration 006 kept web_fit / chatbot_fit / offer alive as GENERATED columns
-- so the dashboard, the CSV export and the queue kept working while they were
-- migrated one at a time. They have all moved to `fits` (a JSONB object keyed
-- by the offer's own axis names) and `best_fit`, so the bridge can come down.
--
-- Keeping them would be actively misleading rather than merely redundant: they
-- are only ever populated for an offer whose axes happen to be called web_fit
-- and chatbot_fit. For every new offer they read NULL, which looks identical to
-- "not scored" — the one ambiguity this schema works hardest to avoid.

ALTER TABLE scores DROP COLUMN IF EXISTS web_fit;
ALTER TABLE scores DROP COLUMN IF EXISTS chatbot_fit;
ALTER TABLE scores DROP COLUMN IF EXISTS offer;
