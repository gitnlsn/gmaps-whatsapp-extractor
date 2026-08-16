-- 008_perf_rollups.sql
--
-- The dashboard was counting 2.1M rows on every page load.
--
-- Measured on the live base (2,135,950 leads / 2959 MB), warm cache:
--
--   checkOfferCnaes (3 prefixes)   15,200 ms   -> /offers/[slug]
--   name search (q=padaria)        10,398 ms   -> and returned 0 rows (bug)
--   getCoverage                     7,341 ms   -> /coverage
--   getLeads rows                   4,817 ms   -> /
--   getStats                        4,472 ms   -> / and /outreach
--   getUfs                          3,707 ms   -> the UF dropdown alone
--
-- The important part: indexes cannot fix the aggregates. Counting 2.1M rows
-- costs 1.3-4 s even with a perfect index-only scan -- `count(*) WHERE
-- phone_e164 IS NOT NULL` already plans as a Parallel Index Only Scan with
-- Heap Fetches: 0 and still takes 1.29 s. An aggregate over the whole base has
-- to be precomputed, not indexed. Hence the materialized views below.
--
-- Every MV gets a UNIQUE index so `REFRESH MATERIALIZED VIEW CONCURRENTLY`
-- works; without one Postgres refuses CONCURRENTLY and a refresh would take an
-- ACCESS EXCLUSIVE lock, freezing the dashboard for the duration of the rebuild.
--
-- Refresh is wired into the pipeline stages that mutate `leads` (see
-- `npm start -- refresh-rollups`). These numbers only move when the pipeline
-- runs, so pipeline-time refresh is not a staleness compromise -- it is exactly
-- when they change.

-- ------------------------------------------------------------- cnae_uf_rollup
--
-- Grain is (uf, cnae_principal): ~15k rows standing in for 2.1M. One rollup
-- serves three callers because both dimensions are summable:
--
--   getUfs           -> sum over all CNAEs, grouped by uf
--   checkOfferCnaes  -> sum over all UFs, filtered by codigo prefix
--   getMissingCnaes  -> same
--
-- `situacao = 'ATIVA'` is not a filter in any meaningful sense (all 2,149,018
-- rows are ATIVA) but it is stated in checkOfferCnaes' predicate, so it is
-- reproduced here to keep the MV an exact substitution.
CREATE MATERIALIZED VIEW IF NOT EXISTS cnae_uf_rollup AS
  SELECT
    l.uf,
    l.cnae_principal                                                    AS codigo,
    count(*)::bigint                                                    AS leads,
    count(*) FILTER (WHERE l.phone_e164 IS NOT NULL)::bigint            AS reachable,
    count(*) FILTER (WHERE l.is_mobile)::bigint                         AS mobile,
    count(*) FILTER (WHERE l.phone_e164 IS NOT NULL
                       AND NOT l.is_mobile)::bigint                     AS landline,
    count(*) FILTER (WHERE left(l.natureza_juridica, 1) = '2')::bigint  AS privados,
    count(*) FILTER (WHERE l.opcao_mei IS TRUE)::bigint                 AS mei
  FROM leads l
  WHERE l.situacao = 'ATIVA'
  GROUP BY l.uf, l.cnae_principal;

-- uf and codigo are both nullable, and a UNIQUE index treats NULLs as distinct
-- -- which would let CONCURRENTLY refresh fail on duplicate NULL groups. NULLS
-- NOT DISTINCT (PG15+) makes the one NULL group collide with itself correctly.
CREATE UNIQUE INDEX IF NOT EXISTS cnae_uf_rollup_pkey
  ON cnae_uf_rollup (uf, codigo) NULLS NOT DISTINCT;

-- Prefix lookup is the hot path: "everything under 85". text_pattern_ops for
-- the same reason leads_cnae_prefix_idx needs it -- a plain btree cannot serve
-- LIKE 'prefix%' under a non-C collation.
CREATE INDEX IF NOT EXISTS cnae_uf_rollup_prefix_idx
  ON cnae_uf_rollup (codigo text_pattern_ops);

-- ----------------------------------------------------------------- lead_stats
--
-- The four whole-base counts at the top of getStats. The other eight subqueries
-- in that query stay live: enrichment (431 rows), scores (52) and outreach (0)
-- are small enough to count on every request, and they change between pipeline
-- runs, so freezing them into an MV would trade 0 ms for staleness.
CREATE MATERIALIZED VIEW IF NOT EXISTS lead_stats AS
  SELECT
    TRUE                                                              AS singleton,
    count(*)::bigint                                                  AS leads,
    count(*) FILTER (WHERE phone_e164 IS NOT NULL)::bigint            AS contactable,
    count(*) FILTER (WHERE is_mobile)::bigint                         AS mobile,
    count(*) FILTER (WHERE phone_e164 IS NOT NULL
                       AND NOT is_mobile)::bigint                     AS landline
  FROM leads;

CREATE UNIQUE INDEX IF NOT EXISTS lead_stats_pkey ON lead_stats (singleton);

-- ------------------------------------------------------------ coverage_rollup
--
-- Only the expensive half is materialized. The GROUP BY over 2.1M leads is what
-- costs 7.3 s; the enriched/scored/hot columns come from enrichment (431 rows)
-- and scores (52), which are cheap to aggregate live and change more often. So
-- the MV holds lead counts only and getCoverage joins the small side fresh.
--
-- HAVING count(*) > 2 is applied here rather than at query time -- it is part of
-- the view's definition in getCoverage and shrinks the MV substantially.
CREATE MATERIALIZED VIEW IF NOT EXISTS coverage_rollup AS
  SELECT
    l.uf,
    l.municipio_nome,
    left(l.cnae_principal, 4) AS cnae4,
    count(*)::bigint          AS leads
  FROM leads l
  WHERE l.phone_e164 IS NOT NULL
  GROUP BY l.uf, l.municipio_nome, left(l.cnae_principal, 4)
  HAVING count(*) > 2;

CREATE UNIQUE INDEX IF NOT EXISTS coverage_rollup_pkey
  ON coverage_rollup (uf, municipio_nome, cnae4) NULLS NOT DISTINCT;

-- The page orders by lead count and takes the top 300.
CREATE INDEX IF NOT EXISTS coverage_rollup_leads_idx
  ON coverage_rollup (leads DESC);

-- ---------------------------------------------------------------- leads index
--
-- Drop three indexes that pg_stat_user_indexes reports as never scanned, and
-- that cannot become useful without a query change:
--
--   leads_situacao_idx  54 MB -- `situacao` is 'ATIVA' for ALL 2,149,018 rows.
--                                A single-valued btree can never narrow
--                                anything; it is pure write-time cost.
--   leads_abertura_idx  56 MB -- 0 scans. maxIdade filters by an open-ended
--                                range that the planner serves by seq scan
--                                anyway, since it matches most of the table.
--   leads_normname_idx  76 MB -- 0 scans, and unreachable by construction: the
--                                only caller does LIKE '%x%', which no btree
--                                can serve.
DROP INDEX IF EXISTS leads_situacao_idx;
DROP INDEX IF EXISTS leads_abertura_idx;
DROP INDEX IF EXISTS leads_normname_idx;

-- leads_name_trgm_idx also had 0 scans, but it is NOT dead weight -- it is
-- misaligned. The index is on norm_name(nome_fantasia); buildWhere queries
-- norm_name(COALESCE(nome_fantasia, razao_social)). An expression index only
-- applies to the exact expression, so the planner could never use it and the
-- search box fell back to a 10 s seq scan.
--
-- Rebuilt on the expression the application actually asks for. Measured against
-- a matching expression: 225 ms vs 10,048 ms.
DROP INDEX IF EXISTS leads_name_trgm_idx;
CREATE INDEX IF NOT EXISTS leads_name_trgm_idx
  ON leads USING gin (norm_name(COALESCE(nome_fantasia, razao_social)) gin_trgm_ops);

-- -------------------------------------------------------------- outreach index
--
-- OFFER_SELECT runs two correlated subqueries per offer row filtered on
-- offer_id, and no index covered it. Cheap now (outreach is empty) and the
-- table is on the write path for every status change, so add it before it
-- matters rather than after.
CREATE INDEX IF NOT EXISTS outreach_offer_idx ON outreach (offer_id)
  WHERE offer_id IS NOT NULL;
