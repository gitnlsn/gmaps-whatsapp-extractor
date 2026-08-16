import "server-only";
import { sql, sqlOne } from "./db";

export interface LeadRow {
  cnpj: string;
  nome: string | null;
  municipio: string | null;
  uf: string | null;
  cnae: string | null;
  idade_anos: number | null;
  porte: string | null;
  mei: boolean | null;
  phone_e164: string | null;
  is_mobile: boolean | null;
  site: string | null;
  site_status: string;
  fits: Record<string, number | null> | null;
  best_fit: number | null;
  tier: string | null;
  confidence: string | null;
  offer: string | null;
  hook: string | null;
  evidence: string[] | null;
  status: string;
}

export interface Filters {
  uf?: string;
  municipio?: string;
  cnae?: string;
  tier?: string;
  offer?: string;
  status?: string;
  site?: string; // none | dead | hub | builder | noviewport | ok
  canal?: string; // mobile | landline | any (default)
  /** Which offer's scores to show. Defaults to the active one. */
  offerId?: string;
  minFit?: number;
  mei?: string; // sim | nao
  maxIdade?: number;
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

const SORTABLE: Record<string, string> = {
  nome: "COALESCE(l.nome_fantasia, l.razao_social)",
  municipio: "l.municipio_nome",
  uf: "l.uf",
  cnae: "l.cnae_principal",
  idade_anos: "l.data_inicio_atividade",
  porte: "l.porte",
  tier: "s.tier",
  status: "COALESCE(o.status, 'novo')",
  best: "s.best_fit",
};

const SITE_STATUS_SQL = `
  CASE
    WHEN e.cnpj IS NULL              THEN 'nao verificado'
    WHEN e.has_website IS NOT TRUE   THEN 'sem site'
    WHEN e.is_dead                   THEN 'morto'
    WHEN e.is_link_hub               THEN 'link hub'
    WHEN e.is_free_builder           THEN 'construtor gratis'
    WHEN e.has_viewport IS FALSE     THEN 'nao responsivo'
    ELSE 'ok'
  END`;

/** Builds the shared WHERE clause. Returns SQL plus positional params. */
function buildWhere(f: Filters): { where: string; params: unknown[] } {
  // Contactability, not phone type. `is_mobile` used to gate every query here,
  // which silently hid institutions (schools, faculdades) — they register
  // landlines. Mobility is now a filter the user chooses and a sort key, and
  // the default shows everything reachable.
  const clauses: string[] = ["l.phone_e164 IS NOT NULL"];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;

  if (f.canal === "mobile") clauses.push("l.is_mobile IS TRUE");
  if (f.canal === "landline") clauses.push("l.is_mobile IS NOT TRUE");

  if (f.uf) clauses.push(`l.uf = ${p(f.uf.toUpperCase())}`);
  if (f.municipio) clauses.push(`l.municipio_nome ILIKE ${p(`%${f.municipio}%`)}`);
  if (f.cnae) clauses.push(`l.cnae_principal LIKE ${p(`${f.cnae}%`)}`);
  if (f.tier) clauses.push(`s.tier = ${p(f.tier)}`);
  if (f.offer) clauses.push(`s.recommendation = ${p(f.offer)}`);
  if (f.mei === "sim") clauses.push("l.opcao_mei IS TRUE");
  if (f.mei === "nao") clauses.push("l.opcao_mei IS NOT TRUE");
  if (f.minFit) clauses.push(`s.best_fit >= ${p(f.minFit)}`);
  if (f.maxIdade) {
    clauses.push(
      `l.data_inicio_atividade >= (CURRENT_DATE - (${p(f.maxIdade)}::int * interval '1 year'))`
    );
  }
  if (f.q) {
    // The wildcards MUST sit outside norm_name(). norm_name strips every
    // non-alphanumeric character, so norm_name('%padaria%') returns ' padaria '
    // with the % destroyed — the search box silently matched nothing at all
    // (verified: 0 rows for every term, after a 10 s seq scan). Wrapping the
    // normalised term instead also lets leads_name_trgm_idx apply, which is
    // built on this exact expression: 225 ms instead of 10,048 ms.
    clauses.push(
      `(norm_name(COALESCE(l.nome_fantasia, l.razao_social)) LIKE '%' || norm_name(${p(f.q)}) || '%'
        OR l.cnpj = ${p(f.q.replace(/\D/g, ""))})`
    );
  }

  if (f.status) {
    if (f.status === "novo") clauses.push("o.cnpj IS NULL");
    else clauses.push(`o.status = ${p(f.status)}`);
  }

  switch (f.site) {
    case "none":
      clauses.push("e.has_website IS NOT TRUE AND e.cnpj IS NOT NULL");
      break;
    case "dead":
      clauses.push("e.is_dead IS TRUE");
      break;
    case "hub":
      clauses.push("e.is_link_hub IS TRUE");
      break;
    case "builder":
      clauses.push("e.is_free_builder IS TRUE");
      break;
    case "noviewport":
      clauses.push("e.has_viewport IS FALSE AND e.has_website IS TRUE");
      break;
    case "ok":
      clauses.push(
        "e.has_website IS TRUE AND e.is_dead IS NOT TRUE AND e.is_link_hub IS NOT TRUE AND e.has_viewport IS TRUE"
      );
      break;
    case "unchecked":
      clauses.push("e.cnpj IS NULL");
      break;
  }

  return { where: clauses.join("\n  AND "), params };
}

/**
 * Scores are per (lead, offer), so this join MUST be scoped to one offer.
 * Left unscoped, a lead graded under two offers would appear twice in the
 * table and be double-counted in every total — the quiet failure mode of
 * making scores multi-offer.
 */
function fromSql(p: (v: unknown) => string, offerId: string | undefined): string {
  return `
  FROM leads l
  LEFT JOIN scores s     ON s.cnpj = l.cnpj AND s.offer_id = ${p(offerId ?? "")}
  LEFT JOIN enrichment e ON e.cnpj = l.cnpj
  LEFT JOIN outreach o   ON o.cnpj = l.cnpj`;
}

/** The table's column list, shared by both arms of the default-sort union. */
const LEAD_COLS = `
       l.cnpj,
       COALESCE(l.nome_fantasia, l.razao_social) AS nome,
       l.municipio_nome AS municipio, l.uf, l.cnae_principal AS cnae,
       CASE WHEN l.data_inicio_atividade IS NOT NULL
            THEN date_part('year', age(l.data_inicio_atividade))::int END AS idade_anos,
       l.porte, l.opcao_mei AS mei, l.phone_e164, l.is_mobile,
       COALESCE(e.final_url, e.website_url) AS site,
       ${SITE_STATUS_SQL} AS site_status,
       s.fits, s.best_fit, s.tier, s.confidence, s.recommendation AS offer, s.hook,
       ARRAY(SELECT jsonb_array_elements_text(s.evidence -> 'evidence')) AS evidence,
       COALESCE(o.status, 'novo') AS status`;

/**
 * Beyond this many matches the total is reported as "N+" instead of counted.
 * An exact count means visiting every matching row — 2.5 s on the default view.
 * At 50 per page this still allows 200 pages, well past where OFFSET itself
 * becomes the bottleneck.
 */
const COUNT_CAP = 10_000;

/**
 * The default sort, rewritten to avoid sorting the whole base.
 *
 * `ORDER BY s.best_fit DESC NULLS LAST, l.cnpj` reads innocently but best_fit
 * lives on `scores` — a LEFT JOINed table holding a few dozen rows — so
 * Postgres had to materialise all 2.1M joined rows and top-N sort them to
 * return 50. Measured: 4,817 ms.
 *
 * The ordering is really two concatenated blocks: scored leads by best_fit,
 * then everything unscored by cnpj. Fetching each block separately lets the
 * planner drive the first from `scores` (28 rows, nested loop into leads_pkey)
 * and serve the second straight off leads_pkey, stopping at the LIMIT. The
 * outer ORDER BY is the original expression applied to at most 2×window rows,
 * so the result is identical — verified row-for-row against the old query on
 * pages 1 and 3. Measured: 14 ms.
 */
function bestSortedSql(FROM: string, where: string, window: number): string {
  return `
    WITH scored AS (
      SELECT ${LEAD_COLS}
      ${FROM}
      WHERE ${where} AND s.best_fit IS NOT NULL
      ORDER BY s.best_fit DESC, l.cnpj
      LIMIT ${window}
    ), filler AS (
      SELECT ${LEAD_COLS}
      ${FROM}
      WHERE ${where} AND s.best_fit IS NULL
      ORDER BY l.cnpj
      LIMIT ${window}
    )
    SELECT * FROM scored
    UNION ALL
    SELECT * FROM filler
    ORDER BY best_fit DESC NULLS LAST, cnpj`;
}

/** True when nothing narrows the base predicate, so the total is just the rollup. */
function isUnfiltered(f: Filters): boolean {
  return (
    !f.q && !f.uf && !f.municipio && !f.cnae && !f.tier && !f.offer && !f.site &&
    !f.status && !f.canal && !f.mei && !f.minFit && !f.maxIdade
  );
}

export async function getLeads(
  f: Filters
): Promise<{ rows: LeadRow[]; total: number; totalCapped: boolean }> {
  const { where, params } = buildWhere(f);
  const p = (v: unknown) => `$${params.push(v)}`;
  const FROM = fromSql(p, f.offerId);

  const perPage = Math.min(f.perPage ?? 50, 200);
  const page = Math.max(f.page ?? 1, 1);
  const offset = (page - 1) * perPage;

  const sortKey = f.sort ?? "best";
  const sortCol = SORTABLE[sortKey] ?? SORTABLE.best;
  const dir = f.dir === "asc" ? "ASC" : "DESC";

  // The fast path only reproduces the DESC ordering; an explicit ascending sort
  // by fit is rare enough to leave on the general shape.
  const useBestPath = sortKey === "best" && dir === "DESC";
  const rowsSql = useBestPath
    ? `${bestSortedSql(FROM, where, offset + perPage)}
       LIMIT ${perPage} OFFSET ${offset}`
    : `SELECT ${LEAD_COLS}
       ${FROM}
       WHERE ${where}
       ORDER BY ${sortCol} ${dir} NULLS LAST, l.cnpj
       LIMIT ${perPage} OFFSET ${offset}`;

  // These were serial — the count only started once every row had come back,
  // adding its full cost to the page. Nothing links them, so they overlap.
  const [rows, counted] = await Promise.all([
    sql<LeadRow>(rowsSql, params),
    isUnfiltered(f)
      ? // The joins are all to unique keys, so the row count equals the number
        // of contactable leads — already precomputed, and exact.
        sqlOne<{ n: string }>(`SELECT contactable::text AS n FROM lead_stats`)
      : sqlOne<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM (SELECT 1 ${FROM} WHERE ${where} LIMIT ${COUNT_CAP + 1}) t`,
          params
        ),
  ]);

  const total = Number(counted?.n ?? 0);
  return {
    rows,
    total: Math.min(total, isUnfiltered(f) ? total : COUNT_CAP),
    totalCapped: !isUnfiltered(f) && total > COUNT_CAP,
  };
}

export interface Stats {
  leads: number;
  contactable: number;
  mobile: number;
  landline: number;
  enriched: number;
  scored: number;
  hot: number;
  warm: number;
  queued: number;
  sent: number;
  replied: number;
  sent_week: number;
}

/**
 * The four whole-base counts come from `lead_stats` (migration 008); the rest
 * are counted live.
 *
 * Splitting them is deliberate. Counting 2.1M rows costs seconds even on a
 * perfect index — `count(*) WHERE phone_e164 IS NOT NULL` already plans as an
 * index-only scan with zero heap fetches and still took 1.29 s, and the query
 * as a whole took 4,472 ms on every dashboard render. Those four numbers only
 * move when the pipeline loads leads, so a rollup refreshed by the pipeline is
 * exact, not approximate. The other eight run against enrichment (431 rows),
 * scores (52) and outreach (0) — free to count, and they change between
 * pipeline runs, so materialising them would buy nothing and cost freshness.
 */
export async function getStats(): Promise<Stats> {
  const r = await sqlOne<Record<string, string>>(`
    SELECT
      (SELECT leads::text       FROM lead_stats)                                AS leads,
      (SELECT contactable::text FROM lead_stats)                                AS contactable,
      (SELECT mobile::text      FROM lead_stats)                                AS mobile,
      (SELECT landline::text    FROM lead_stats)                                AS landline,
      (SELECT count(*) FROM enrichment)::text                                   AS enriched,
      (SELECT count(*) FROM scores WHERE best_fit IS NOT NULL)::text            AS scored,
      (SELECT count(*) FROM scores WHERE tier='hot')::text                      AS hot,
      (SELECT count(*) FROM scores WHERE tier='warm')::text                     AS warm,
      (SELECT count(*) FROM outreach WHERE status='queued')::text               AS queued,
      (SELECT count(*) FROM outreach WHERE status='sent')::text                 AS sent,
      (SELECT count(*) FROM outreach WHERE status='replied')::text              AS replied,
      (SELECT count(*) FROM outreach
        WHERE status='sent' AND sent_at >= date_trunc('week', CURRENT_DATE))::text AS sent_week
  `);

  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    leads: n("leads"),
    contactable: n("contactable"),
    mobile: n("mobile"),
    landline: n("landline"),
    enriched: n("enriched"),
    scored: n("scored"),
    hot: n("hot"),
    warm: n("warm"),
    queued: n("queued"),
    sent: n("sent"),
    replied: n("replied"),
    sent_week: n("sent_week"),
  };
}

export async function getLead(cnpj: string, offerId?: string) {
  const params: unknown[] = [cnpj];
  const p = (v: unknown) => `$${params.push(v)}`;
  return sqlOne<Record<string, unknown>>(
    `SELECT l.*,
            to_jsonb(e.*) AS enrichment,
            to_jsonb(s.*) AS score,
            to_jsonb(o.*) AS outreach,
            ${SITE_STATUS_SQL} AS site_status
     ${fromSql(p, offerId)}
     WHERE l.cnpj = $1`,
    params
  );
}

/**
 * Feeds the UF dropdown. Summing the rollup replaces a full aggregate over
 * 2.1M rows: 3,707 ms -> ~10 ms, same 28 counts.
 *
 * No `ativa` filter here, matching the original: this dropdown counts every
 * contactable lead, not only active companies.
 */
export async function getUfs(): Promise<{ uf: string; n: number }[]> {
  const rows = await sql<{ uf: string; n: string }>(
    `SELECT uf, sum(n)::text AS n FROM leads_rollup
     WHERE uf IS NOT NULL AND has_phone GROUP BY uf ORDER BY uf`
  );
  return rows.map((r) => ({ uf: r.uf, n: Number(r.n) }));
}

/**
 * Only the lead counts are materialised. The GROUP BY over 2.1M rows is what
 * cost 7,341 ms; enriched/scored/hot come from enrichment (431 rows) and scores
 * (52), cheap to aggregate live and fresher for it. Driving the small side from
 * `enrichment` rather than `leads` keeps it a 431-row nested loop. 86 ms.
 *
 * Scoping the scores join by offer_id also fixes a latent double-count: this
 * was the one query in the file joining scores without it, so a lead graded
 * under two offers inflated every column here.
 */
export async function getCoverage(offerId?: string) {
  return sql<{
    uf: string;
    municipio: string;
    cnae: string;
    leads: string;
    enriched: string;
    scored: string;
    hot: string;
  }>(
    `WITH small AS (
       SELECT l.uf, l.municipio_nome, left(l.cnae_principal, 4) AS cnae4,
              count(e.cnpj)::bigint                                       AS enriched,
              count(s.cnpj) FILTER (WHERE s.best_fit IS NOT NULL)::bigint AS scored,
              count(*) FILTER (WHERE s.tier = 'hot')::bigint              AS hot
         FROM enrichment e
         JOIN leads l ON l.cnpj = e.cnpj
         LEFT JOIN scores s ON s.cnpj = l.cnpj AND s.offer_id = $1
        WHERE l.phone_e164 IS NOT NULL
        GROUP BY 1, 2, 3
     )
     SELECT r.uf, r.municipio_nome AS municipio, r.cnae4 AS cnae,
            r.leads::text                      AS leads,
            COALESCE(sm.enriched, 0)::text     AS enriched,
            COALESCE(sm.scored, 0)::text       AS scored,
            COALESCE(sm.hot, 0)::text          AS hot
       FROM coverage_rollup r
       LEFT JOIN small sm
         ON sm.uf              IS NOT DISTINCT FROM r.uf
        AND sm.municipio_nome  IS NOT DISTINCT FROM r.municipio_nome
        AND sm.cnae4           IS NOT DISTINCT FROM r.cnae4
      ORDER BY r.leads DESC
      LIMIT 300`,
    [offerId ?? ""]
  );
}

// ------------------------------------------------------------------ discover
//
// Segment discovery: "how many companies could I actually reach in this
// segment, and how many are plausible buyers?" — answered in pure SQL, with
// no LLM involved. This is the free stage of the funnel, and on the current
// base it is also most of the useful signal: the deterministic columns below
// (segment, private-vs-public, size, age, nameability) are the same facts an
// LLM rubric would be re-encoding.

export interface DiscoverFilters {
  cnae?: string; // comma-separated prefixes, e.g. "8513,8599"
  uf?: string;
  canal?: string;
  natureza?: string; // "privado" | "publico" | "sem_fins" | undefined
  excludeMei?: boolean;
  maxIdade?: number;
  minIdade?: number;
}

/** Shared predicate builder for every discover query, so the funnel is consistent. */
function discoverWhere(f: DiscoverFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ["l.situacao = 'ATIVA'"];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;

  const prefixes = (f.cnae ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
  if (prefixes.length) {
    clauses.push(`l.cnae_principal LIKE ANY(${p(prefixes.map((x) => `${x}%`))})`);
  }

  if (f.uf) clauses.push(`l.uf = ${p(f.uf.toUpperCase())}`);
  if (f.canal === "mobile") clauses.push("l.is_mobile IS TRUE");
  if (f.canal === "landline") clauses.push("l.is_mobile IS NOT TRUE AND l.phone_e164 IS NOT NULL");

  // natureza_juridica leading digit: 1 = public administration (cannot buy
  // without a licitação), 2 = private company, 3 = nonprofit/association —
  // many private schools are registered as associações or fundações, so 3 is
  // a buyer, just not a company.
  if (f.natureza === "privado") clauses.push("left(l.natureza_juridica,1) = '2'");
  if (f.natureza === "publico") clauses.push("left(l.natureza_juridica,1) = '1'");
  if (f.natureza === "sem_fins") clauses.push("left(l.natureza_juridica,1) = '3'");

  if (f.excludeMei) clauses.push("l.opcao_mei IS NOT TRUE");
  if (f.maxIdade) {
    clauses.push(
      `l.data_inicio_atividade >= (CURRENT_DATE - (${p(f.maxIdade)}::int * interval '1 year'))`
    );
  }
  if (f.minIdade) {
    clauses.push(
      `l.data_inicio_atividade <= (CURRENT_DATE - (${p(f.minIdade)}::int * interval '1 year'))`
    );
  }

  return { where: clauses.join("\n  AND "), params };
}

/**
 * The same predicate against `leads_rollup` instead of `leads`.
 *
 * Every discover filter except age is a low-cardinality attribute, and the
 * rollup is grouped by all of them at once — so the filtered count is a SUM
 * over 21k rows rather than a scan of 2.1M, with identical results. This is a
 * lossless pre-aggregation, not an approximation.
 *
 * Age is the exception: `data_inicio_atividade >= CURRENT_DATE - N years` is
 * day-exact against a moving date and cannot be bucketed without changing the
 * answer, so `usable` is false whenever an age bound is set and the caller runs
 * the live query instead.
 */
function rollupWhere(f: DiscoverFilters): {
  usable: boolean;
  where: string;
  params: unknown[];
} {
  const clauses: string[] = ["r.ativa"];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;

  const prefixes = (f.cnae ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
  if (prefixes.length) {
    clauses.push(`r.codigo LIKE ANY(${p(prefixes.map((x) => `${x}%`))})`);
  }

  if (f.uf) clauses.push(`r.uf = ${p(f.uf.toUpperCase())}`);
  if (f.canal === "mobile") clauses.push("r.is_mobile IS TRUE");
  if (f.canal === "landline") clauses.push("r.is_mobile IS NOT TRUE AND r.has_phone");

  if (f.natureza === "privado") clauses.push(`r.natureza1 = '2'`);
  if (f.natureza === "publico") clauses.push(`r.natureza1 = '1'`);
  if (f.natureza === "sem_fins") clauses.push(`r.natureza1 = '3'`);

  if (f.excludeMei) clauses.push("r.mei IS NOT TRUE");

  return {
    usable: !f.maxIdade && !f.minIdade,
    where: clauses.join("\n  AND "),
    params,
  };
}

/**
 * How many leads matching `f` are already spoken for — phone suppressed, or
 * contacted under any offer.
 *
 * Written to drive from the small side. The natural phrasing ("leads WHERE NOT
 * EXISTS ...") makes Postgres walk 2.1M rows checking each one; starting from
 * the taken phone numbers and looking each up through leads_phone_idx touches
 * only as many rows as there are contacts. Both tables are empty today, so this
 * is currently a no-op that costs nothing and stays correct as they fill.
 */
async function countTakenPhones(f: DiscoverFilters): Promise<number> {
  const { where, params } = discoverWhere(f);
  const r = await sqlOne<{ n: string }>(
    `WITH taken AS (
       SELECT phone_e164 FROM suppression
       UNION
       SELECT l2.phone_e164 FROM outreach o
         JOIN leads l2 ON l2.cnpj = o.cnpj
        WHERE l2.phone_e164 IS NOT NULL
     )
     SELECT count(*)::text AS n
       FROM taken t
       JOIN leads l ON l.phone_e164 = t.phone_e164
      WHERE ${where} AND l.nome_fantasia IS NOT NULL`,
    params
  );
  return Number(r?.n ?? 0);
}

export interface DiscoverFunnel {
  matched: number;
  with_phone: number;
  mobile: number;
  landline: number;
  named: number;
  private_only: number;
  not_mei: number;
  reachable: number;
}

/**
 * The funnel from "in this segment" down to "actually contactable today".
 * Every step is a reason a lead drops out, shown so the loss is visible rather
 * than silent — the same discipline the scorer uses for evidence.
 */
export async function getDiscoverFunnel(f: DiscoverFilters): Promise<DiscoverFunnel> {
  const roll = rollupWhere(f);
  if (roll.usable) {
    // `reachable` is the one column the rollup cannot answer alone: it also
    // excludes phones that are suppressed or already contacted, which are
    // properties of other tables. Those are counted separately, driving from
    // suppression/outreach (tens of rows) into leads by phone rather than the
    // other way round, and subtracted. Exact, and it touches almost nothing.
    const [agg, taken] = await Promise.all([
      sqlOne<Record<string, string>>(
        `SELECT
           COALESCE(sum(r.n), 0)::text                                      AS matched,
           COALESCE(sum(r.n) FILTER (WHERE r.has_phone), 0)::text           AS with_phone,
           COALESCE(sum(r.n) FILTER (WHERE r.is_mobile), 0)::text           AS mobile,
           COALESCE(sum(r.n) FILTER (WHERE r.has_phone
                                       AND NOT r.is_mobile), 0)::text       AS landline,
           COALESCE(sum(r.n) FILTER (WHERE r.named), 0)::text               AS named,
           COALESCE(sum(r.n) FILTER (WHERE r.natureza1 = '2'), 0)::text     AS private_only,
           COALESCE(sum(r.n) FILTER (WHERE r.mei IS NOT TRUE), 0)::text     AS not_mei,
           COALESCE(sum(r.n) FILTER (WHERE r.has_phone AND r.named), 0)::text
                                                                            AS reachable_base
         FROM leads_rollup r
         WHERE ${roll.where}`,
        roll.params
      ),
      countTakenPhones(f),
    ]);
    const n = (k: string) => Number(agg?.[k] ?? 0);
    return {
      matched: n("matched"),
      with_phone: n("with_phone"),
      mobile: n("mobile"),
      landline: n("landline"),
      named: n("named"),
      private_only: n("private_only"),
      not_mei: n("not_mei"),
      reachable: Math.max(0, n("reachable_base") - taken),
    };
  }

  const { where, params } = discoverWhere(f);
  const r = await sqlOne<Record<string, string>>(
    `SELECT
       count(*)::text                                                   AS matched,
       count(*) FILTER (WHERE l.phone_e164 IS NOT NULL)::text            AS with_phone,
       count(*) FILTER (WHERE l.is_mobile)::text                         AS mobile,
       count(*) FILTER (WHERE l.phone_e164 IS NOT NULL
                          AND NOT l.is_mobile)::text                     AS landline,
       count(*) FILTER (WHERE l.nome_fantasia IS NOT NULL)::text         AS named,
       count(*) FILTER (WHERE left(l.natureza_juridica,1) = '2')::text   AS private_only,
       count(*) FILTER (WHERE l.opcao_mei IS NOT TRUE)::text             AS not_mei,
       -- Reachable = has a phone, is not suppressed, has never been contacted
       -- (under ANY offer), and can be named in a message.
       count(*) FILTER (
         WHERE l.phone_e164 IS NOT NULL
           AND l.nome_fantasia IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.phone_e164 = l.phone_e164)
           AND NOT EXISTS (SELECT 1 FROM outreach o
                            JOIN leads l2 ON l2.cnpj = o.cnpj
                           WHERE l2.phone_e164 = l.phone_e164)
       )::text                                                          AS reachable
     FROM leads l
     WHERE ${where}`,
    params
  );
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    matched: n("matched"),
    with_phone: n("with_phone"),
    mobile: n("mobile"),
    landline: n("landline"),
    named: n("named"),
    private_only: n("private_only"),
    not_mei: n("not_mei"),
    reachable: n("reachable"),
  };
}

export interface DiscoverCnae {
  codigo: string;
  descricao: string | null;
  leads: number;
  reachable: number;
  privados: number;
  mei: number;
}

/**
 * Per-CNAE breakdown WITH the official description, joined from the `cnaes`
 * dictionary. The description is the point: it is how you find out that
 * 8599-6/01 is "Formação de condutores" (driving schools) before spending a
 * campaign on it, and how a code that does not exist becomes visible as such.
 */
export async function getDiscoverCnaes(f: DiscoverFilters): Promise<DiscoverCnae[]> {
  const roll = rollupWhere(f);
  const { where, params } = roll.usable ? roll : discoverWhere(f);
  const rows = roll.usable
    ? await sql<Record<string, string>>(
        `SELECT r.codigo,
                c.descricao,
                sum(r.n)::text                                        AS leads,
                COALESCE(sum(r.n) FILTER (WHERE r.has_phone), 0)::text AS reachable,
                COALESCE(sum(r.n) FILTER (WHERE r.natureza1 = '2'), 0)::text AS privados,
                COALESCE(sum(r.n) FILTER (WHERE r.mei IS TRUE), 0)::text     AS mei
         FROM leads_rollup r
         LEFT JOIN cnaes c ON c.codigo = r.codigo
         WHERE ${where}
         GROUP BY r.codigo, c.descricao
         ORDER BY sum(r.n) DESC
         LIMIT 100`,
        params
      )
    : await sql<Record<string, string>>(
        `SELECT l.cnae_principal AS codigo,
                c.descricao,
                count(*)::text                                                  AS leads,
                count(*) FILTER (WHERE l.phone_e164 IS NOT NULL)::text          AS reachable,
                count(*) FILTER (WHERE left(l.natureza_juridica,1) = '2')::text AS privados,
                count(*) FILTER (WHERE l.opcao_mei IS TRUE)::text               AS mei
         FROM leads l
         LEFT JOIN cnaes c ON c.codigo = l.cnae_principal
         WHERE ${where}
         GROUP BY l.cnae_principal, c.descricao
         ORDER BY count(*) DESC
         LIMIT 100`,
        params
      );
  return rows.map((r) => ({
    codigo: r.codigo,
    descricao: r.descricao ?? null,
    leads: Number(r.leads),
    reachable: Number(r.reachable),
    privados: Number(r.privados),
    mei: Number(r.mei),
  }));
}

/** Where the segment actually is, so a campaign can start with one state. */
export async function getDiscoverUfs(f: DiscoverFilters) {
  const roll = rollupWhere(f);
  const { where, params } = roll.usable ? roll : discoverWhere(f);
  const rows = roll.usable
    ? await sql<Record<string, string>>(
        `SELECT r.uf,
                sum(r.n)::text                                        AS leads,
                COALESCE(sum(r.n) FILTER (WHERE r.has_phone), 0)::text AS reachable
         FROM leads_rollup r
         WHERE ${where} AND r.uf IS NOT NULL
         GROUP BY r.uf ORDER BY sum(r.n) DESC LIMIT 27`,
        params
      )
    : await sql<Record<string, string>>(
        `SELECT l.uf,
                count(*)::text                                          AS leads,
                count(*) FILTER (WHERE l.phone_e164 IS NOT NULL)::text  AS reachable
         FROM leads l
         WHERE ${where} AND l.uf IS NOT NULL
         GROUP BY l.uf ORDER BY count(*) DESC LIMIT 27`,
        params
      );
  return rows.map((r) => ({
    uf: r.uf,
    leads: Number(r.leads),
    reachable: Number(r.reachable),
  }));
}

/**
 * Prefixes the user asked for that returned nothing, split by CAUSE — the two
 * cases need opposite fixes and look identical from a zero count:
 *   unknown   -> the code does not exist. A typo, or a model invented it.
 *   not_loaded-> the code is real, but that slice was never downloaded.
 */
export async function getMissingCnaes(
  cnae: string | undefined
): Promise<{ prefix: string; cause: "unknown" | "not_loaded"; descricao?: string }[]> {
  const prefixes = (cnae ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
  if (!prefixes.length) return [];

  // `in_leads` used to be count(*) over `leads` per prefix. Because the pattern
  // is `p.prefix || '%'` rather than a literal, the planner cannot turn it into
  // a range scan, so leads_cnae_prefix_idx never applied and each prefix cost a
  // full seq scan of 2.1M rows. Against cnae_uf_rollup (~1.3k rows) the same
  // question is a sum.
  const rows = await sql<{ prefix: string; in_dict: string; in_leads: string; descricao: string | null }>(
    `SELECT p.prefix,
            (SELECT count(*) FROM cnaes c WHERE c.codigo LIKE p.prefix || '%')::text AS in_dict,
            (SELECT COALESCE(sum(r.n), 0) FROM leads_rollup r
              WHERE r.codigo LIKE p.prefix || '%')::text                             AS in_leads,
            (SELECT c.descricao FROM cnaes c
              WHERE c.codigo LIKE p.prefix || '%' ORDER BY c.codigo LIMIT 1)         AS descricao
     FROM unnest($1::text[]) AS p(prefix)`,
    [prefixes]
  );

  return rows
    .filter((r) => Number(r.in_leads) === 0)
    .map((r) => ({
      prefix: r.prefix,
      cause: Number(r.in_dict) === 0 ? ("unknown" as const) : ("not_loaded" as const),
      descricao: r.descricao ?? undefined,
    }));
}

export async function getOutreach() {
  return sql<{
    week: string;
    sent: string;
    replied: string;
    not_a_fit: string;
    opted_out: string;
  }>(
    `SELECT to_char(date_trunc('week', COALESCE(sent_at, queued_at)), 'YYYY-MM-DD') AS week,
            count(*) FILTER (WHERE status='sent')::text      AS sent,
            count(*) FILTER (WHERE status='replied')::text   AS replied,
            count(*) FILTER (WHERE status='not_a_fit')::text AS not_a_fit,
            count(*) FILTER (WHERE status='opted_out')::text AS opted_out
     FROM outreach
     GROUP BY 1 ORDER BY 1 DESC LIMIT 26`
  );
}

export async function getQueue(limit = 40, offerId?: string) {
  const params: unknown[] = [limit];
  const p = (v: unknown) => `$${params.push(v)}`;
  const FROM = fromSql(p, offerId);
  return sql<LeadRow & { draft: string | null }>(
    `SELECT l.cnpj, COALESCE(l.nome_fantasia, l.razao_social) AS nome,
            l.municipio_nome AS municipio, l.uf, l.cnae_principal AS cnae,
            CASE WHEN l.data_inicio_atividade IS NOT NULL
                 THEN date_part('year', age(l.data_inicio_atividade))::int END AS idade_anos,
            l.porte, l.opcao_mei AS mei, l.phone_e164, l.is_mobile,
            COALESCE(e.final_url, e.website_url) AS site,
            ${SITE_STATUS_SQL} AS site_status,
            s.fits, s.best_fit, s.tier, s.confidence, s.recommendation AS offer, s.hook,
            ARRAY(SELECT jsonb_array_elements_text(s.evidence -> 'evidence')) AS evidence,
            COALESCE(o.status, 'novo') AS status,
            o.draft
     ${FROM}
     WHERE l.phone_e164 IS NOT NULL
       AND s.best_fit IS NOT NULL
       AND s.tier <> 'cold'
       AND o.cnpj IS NULL
       AND NOT EXISTS (SELECT 1 FROM suppression sup WHERE sup.phone_e164 = l.phone_e164)
       AND NOT EXISTS (
         SELECT 1 FROM outreach o2 JOIN leads l2 ON l2.cnpj = o2.cnpj
         WHERE l2.phone_e164 = l.phone_e164
       )
     ORDER BY s.best_fit DESC,
              s.confidence = 'high' DESC,
              l.is_mobile DESC NULLS LAST
     LIMIT $1`,
    params
  );
}

/**
 * Google's free monthly allowances, per SKU and not pooled.
 * Mirrored from FREE_MONTHLY in src/budget.ts rather than imported, because
 * that module is CommonJS and this app is ESM. src/budget.ts remains the
 * authority that actually stops a run — these numbers only drive the label.
 */
const FREE_DETAILS = 1000;
const FREE_SEARCH = 10000;

export interface PlacesQuota {
  detailsUsed: number;
  detailsFree: number;
  detailsLeft: number;
  searchUsed: number;
  searchFree: number;
  searchLeft: number;
}

export async function getPlacesQuota(): Promise<PlacesQuota> {
  const rows = await sql<{ sku: string; used: string }>(
    `SELECT sku, COALESCE(sum(count), 0)::text AS used
     FROM api_usage
     WHERE day >= date_trunc('month', CURRENT_DATE)
     GROUP BY sku`
  );

  const used = (sku: string) => Number(rows.find((r) => r.sku === sku)?.used ?? 0);
  const detailsUsed = used("details.enterprise");
  const searchUsed = used("textsearch.essentials");

  return {
    detailsUsed,
    detailsFree: FREE_DETAILS,
    detailsLeft: Math.max(0, FREE_DETAILS - detailsUsed),
    searchUsed,
    searchFree: FREE_SEARCH,
    searchLeft: Math.max(0, FREE_SEARCH - searchUsed),
  };
}

export async function sentToday(): Promise<number> {
  const r = await sqlOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM outreach WHERE status='sent' AND sent_at >= CURRENT_DATE`
  );
  return Number(r?.n ?? 0);
}
