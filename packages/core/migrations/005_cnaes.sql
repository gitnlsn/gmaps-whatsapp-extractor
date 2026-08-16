-- 005_cnaes.sql
--
-- Two things the education pivot needs before anything else.
--
-- 1. A CNAE dictionary. Until now a CNAE was an opaque numeric string with no
--    name anywhere in the repo. Two consequences: the dashboard can only show
--    "8599" instead of what it means, and there is no way to tell a real code
--    from an invented one. The second matters a lot once an LLM starts
--    proposing CNAE prefixes from a free-text product description — a
--    hallucinated code silently targets nobody. With this table, "does this
--    code exist?" and "is it merely not loaded?" become two different answers
--    with two different fixes.
--
-- 2. Indexes matching the new contactability predicate. `is_mobile` used to
--    gate every query; it is now `phone_e164 IS NOT NULL` plus a sort key, so
--    leads_mobile_idx (a partial index WHERE is_mobile) no longer applies.

-- ------------------------------------------------------------------- cnaes
-- Loaded from the Receita's own Cnaes.zip by `npm run cnaes`. ~1,358 rows.
CREATE TABLE IF NOT EXISTS cnaes (
  codigo    TEXT PRIMARY KEY,   -- 7 digits, unpunctuated, as it appears in the dumps
  descricao TEXT NOT NULL
);

-- Prefix lookup ("everything under 85") is the hot path for segment discovery.
CREATE INDEX IF NOT EXISTS cnaes_prefix_idx ON cnaes (codigo text_pattern_ops);

-- ------------------------------------------------------------------- leads
-- Contactability is now the filter, so index it. leads_mobile_idx is kept:
-- it still serves the ?canal=mobile filter and costs nothing to leave behind.
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads (phone_e164)
  WHERE phone_e164 IS NOT NULL;

-- leads_cnae_idx is a plain btree, which cannot serve LIKE 'prefix%' under a
-- non-C collation — and prefix matching is the whole basis of segmentation.
CREATE INDEX IF NOT EXISTS leads_cnae_prefix_idx
  ON leads (cnae_principal text_pattern_ops);
