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
  web_fit: number | null;
  chatbot_fit: number | null;
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
  minWeb?: number;
  minChat?: number;
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
  web_fit: "s.web_fit",
  chatbot_fit: "s.chatbot_fit",
  tier: "s.tier",
  status: "COALESCE(o.status, 'novo')",
  best: "GREATEST(COALESCE(s.web_fit,0), COALESCE(s.chatbot_fit,0))",
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
  if (f.offer) clauses.push(`s.offer = ${p(f.offer)}`);
  if (f.mei === "sim") clauses.push("l.opcao_mei IS TRUE");
  if (f.mei === "nao") clauses.push("l.opcao_mei IS NOT TRUE");
  if (f.minWeb) clauses.push(`s.web_fit >= ${p(f.minWeb)}`);
  if (f.minChat) clauses.push(`s.chatbot_fit >= ${p(f.minChat)}`);
  if (f.maxIdade) {
    clauses.push(
      `l.data_inicio_atividade >= (CURRENT_DATE - (${p(f.maxIdade)}::int * interval '1 year'))`
    );
  }
  if (f.q) {
    clauses.push(
      `(norm_name(COALESCE(l.nome_fantasia, l.razao_social)) LIKE norm_name(${p(`%${f.q}%`)})
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

const FROM = `
  FROM leads l
  LEFT JOIN scores s     ON s.cnpj = l.cnpj
  LEFT JOIN enrichment e ON e.cnpj = l.cnpj
  LEFT JOIN outreach o   ON o.cnpj = l.cnpj`;

export async function getLeads(
  f: Filters
): Promise<{ rows: LeadRow[]; total: number }> {
  const { where, params } = buildWhere(f);

  const perPage = Math.min(f.perPage ?? 50, 200);
  const page = Math.max(f.page ?? 1, 1);
  const offset = (page - 1) * perPage;

  const sortCol = SORTABLE[f.sort ?? "best"] ?? SORTABLE.best;
  const dir = f.dir === "asc" ? "ASC" : "DESC";

  const rows = await sql<LeadRow>(
    `SELECT
       l.cnpj,
       COALESCE(l.nome_fantasia, l.razao_social) AS nome,
       l.municipio_nome AS municipio, l.uf, l.cnae_principal AS cnae,
       CASE WHEN l.data_inicio_atividade IS NOT NULL
            THEN date_part('year', age(l.data_inicio_atividade))::int END AS idade_anos,
       l.porte, l.opcao_mei AS mei, l.phone_e164, l.is_mobile,
       COALESCE(e.final_url, e.website_url) AS site,
       ${SITE_STATUS_SQL} AS site_status,
       s.web_fit, s.chatbot_fit, s.tier, s.confidence, s.offer, s.hook,
       ARRAY(SELECT jsonb_array_elements_text(s.evidence -> 'evidence')) AS evidence,
       COALESCE(o.status, 'novo') AS status
     ${FROM}
     WHERE ${where}
     ORDER BY ${sortCol} ${dir} NULLS LAST, l.cnpj
     LIMIT ${perPage} OFFSET ${offset}`,
    params
  );

  const countRow = await sqlOne<{ n: string }>(
    `SELECT count(*)::text AS n ${FROM} WHERE ${where}`,
    params
  );

  return { rows, total: Number(countRow?.n ?? 0) };
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

export async function getStats(): Promise<Stats> {
  const r = await sqlOne<Record<string, string>>(`
    SELECT
      (SELECT count(*) FROM leads)::text                                        AS leads,
      (SELECT count(*) FROM leads WHERE phone_e164 IS NOT NULL)::text           AS contactable,
      (SELECT count(*) FROM leads WHERE is_mobile)::text                        AS mobile,
      (SELECT count(*) FROM leads
        WHERE phone_e164 IS NOT NULL AND NOT is_mobile)::text                   AS landline,
      (SELECT count(*) FROM enrichment)::text                                   AS enriched,
      (SELECT count(*) FROM scores WHERE web_fit IS NOT NULL)::text             AS scored,
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

export async function getLead(cnpj: string) {
  return sqlOne<Record<string, unknown>>(
    `SELECT l.*,
            to_jsonb(e.*) AS enrichment,
            to_jsonb(s.*) AS score,
            to_jsonb(o.*) AS outreach,
            ${SITE_STATUS_SQL} AS site_status
     ${FROM}
     WHERE l.cnpj = $1`,
    [cnpj]
  );
}

export async function getUfs(): Promise<{ uf: string; n: number }[]> {
  const rows = await sql<{ uf: string; n: string }>(
    `SELECT uf, count(*)::text AS n FROM leads
     WHERE phone_e164 IS NOT NULL AND uf IS NOT NULL GROUP BY uf ORDER BY uf`
  );
  return rows.map((r) => ({ uf: r.uf, n: Number(r.n) }));
}

export async function getCoverage() {
  return sql<{
    uf: string;
    municipio: string;
    cnae: string;
    leads: string;
    enriched: string;
    scored: string;
    hot: string;
  }>(
    `SELECT l.uf, l.municipio_nome AS municipio, left(l.cnae_principal, 4) AS cnae,
            count(*)::text                                          AS leads,
            count(e.cnpj)::text                                     AS enriched,
            count(s.cnpj) FILTER (WHERE s.web_fit IS NOT NULL)::text AS scored,
            count(*) FILTER (WHERE s.tier = 'hot')::text            AS hot
     FROM leads l
     LEFT JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN scores s ON s.cnpj = l.cnpj
     WHERE l.phone_e164 IS NOT NULL
     GROUP BY l.uf, l.municipio_nome, left(l.cnae_principal, 4)
     HAVING count(*) > 2
     ORDER BY count(*) DESC
     LIMIT 300`
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
  const { where, params } = discoverWhere(f);
  const rows = await sql<Record<string, string>>(
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
  const { where, params } = discoverWhere(f);
  const rows = await sql<Record<string, string>>(
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

  const rows = await sql<{ prefix: string; in_dict: string; in_leads: string; descricao: string | null }>(
    `SELECT p.prefix,
            (SELECT count(*) FROM cnaes c  WHERE c.codigo LIKE p.prefix || '%')::text AS in_dict,
            (SELECT count(*) FROM leads l  WHERE l.cnae_principal LIKE p.prefix || '%')::text AS in_leads,
            (SELECT c.descricao FROM cnaes c WHERE c.codigo LIKE p.prefix || '%' LIMIT 1) AS descricao
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

export async function getQueue(limit = 40) {
  return sql<LeadRow & { draft: string | null }>(
    `SELECT l.cnpj, COALESCE(l.nome_fantasia, l.razao_social) AS nome,
            l.municipio_nome AS municipio, l.uf, l.cnae_principal AS cnae,
            CASE WHEN l.data_inicio_atividade IS NOT NULL
                 THEN date_part('year', age(l.data_inicio_atividade))::int END AS idade_anos,
            l.porte, l.opcao_mei AS mei, l.phone_e164, l.is_mobile,
            COALESCE(e.final_url, e.website_url) AS site,
            ${SITE_STATUS_SQL} AS site_status,
            s.web_fit, s.chatbot_fit, s.tier, s.confidence, s.offer, s.hook,
            ARRAY(SELECT jsonb_array_elements_text(s.evidence -> 'evidence')) AS evidence,
            COALESCE(o.status, 'novo') AS status,
            o.draft
     ${FROM}
     WHERE l.phone_e164 IS NOT NULL
       AND s.web_fit IS NOT NULL
       AND s.tier <> 'cold'
       AND o.cnpj IS NULL
       AND NOT EXISTS (SELECT 1 FROM suppression sup WHERE sup.phone_e164 = l.phone_e164)
       AND NOT EXISTS (
         SELECT 1 FROM outreach o2 JOIN leads l2 ON l2.cnpj = o2.cnpj
         WHERE l2.phone_e164 = l.phone_e164
       )
     ORDER BY GREATEST(COALESCE(s.web_fit,0), COALESCE(s.chatbot_fit,0)) DESC,
              s.confidence = 'high' DESC,
              l.is_mobile DESC NULLS LAST
     LIMIT $1`,
    [limit]
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
