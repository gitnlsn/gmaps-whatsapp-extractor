-- 009_leads_rollup.sql
--
-- Finishes what 008 started, and collapses two views into one.
--
-- 008 fixed the dashboard but left /discover untouched, on the reasoning that
-- its aggregates are user-filtered and so cannot be precomputed. With every
-- other page fast, that page stood out: 57.8 s to render, because its four
-- queries each scan 2.1M rows and run concurrently, competing for the same I/O.
--
-- The reasoning was wrong. The discover filters are all low-cardinality
-- attributes of a lead — uf, CNAE, phone type, legal nature, MEI — so grouping
-- by every one of them at once produces just 21,081 distinct combinations. Any
-- filtered count over those attributes is then a SUM over 21k rows instead of a
-- scan of 2.1M, with no loss of precision: this is a lossless pre-aggregation,
-- not a sample or an estimate.
--
-- The one filter it cannot express is age. `data_inicio_atividade >=
-- CURRENT_DATE - N years` is exact day arithmetic against a moving date, and
-- bucketing it by year would silently change the answers. Callers therefore
-- fall back to the live query when an age filter is set — see discoverWhere /
-- rollupWhere in web/lib/queries.ts. Every number stays exact either way.
--
-- This grain is a strict superset of 008's cnae_uf_rollup, which is dropped
-- below: two views over the same table, refreshed on the same schedule, are two
-- chances to disagree.

CREATE MATERIALIZED VIEW IF NOT EXISTS leads_rollup AS
  SELECT
    l.uf,
    l.cnae_principal                    AS codigo,
    left(l.natureza_juridica, 1)        AS natureza1,
    l.opcao_mei                         AS mei,
    l.is_mobile,
    (l.phone_e164 IS NOT NULL)          AS has_phone,
    (l.nome_fantasia IS NOT NULL)       AS named,
    -- Carried as a dimension rather than a WHERE clause because callers
    -- disagree: checkOfferCnaes counts only active companies, the UF dropdown
    -- counts every lead. Today all 2,149,018 rows are ATIVA and the two are the
    -- same number; encoding it keeps them the same number if that ever changes.
    (l.situacao = 'ATIVA')              AS ativa,
    count(*)::bigint                    AS n
  FROM leads l
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;

-- Required for REFRESH ... CONCURRENTLY. Most of these columns are nullable and
-- a UNIQUE index counts NULLs as distinct, which would let duplicate all-NULL
-- groups slip past; NULLS NOT DISTINCT makes the constraint mean what it says.
CREATE UNIQUE INDEX IF NOT EXISTS leads_rollup_pkey
  ON leads_rollup (uf, codigo, natureza1, mei, is_mobile, has_phone, named, ativa)
  NULLS NOT DISTINCT;

-- Prefix matching on CNAE is the hot path (checkOfferCnaes, getMissingCnaes,
-- the discover CNAE table). text_pattern_ops for LIKE 'prefix%' under a
-- non-C collation, same reason as leads_cnae_prefix_idx.
CREATE INDEX IF NOT EXISTS leads_rollup_prefix_idx
  ON leads_rollup (codigo text_pattern_ops);

CREATE INDEX IF NOT EXISTS leads_rollup_uf_idx ON leads_rollup (uf);

-- Superseded by the view above.
DROP MATERIALIZED VIEW IF EXISTS cnae_uf_rollup;
