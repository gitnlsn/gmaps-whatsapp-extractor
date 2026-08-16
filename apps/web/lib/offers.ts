import "server-only";
import { sql, sqlOne } from "./db";

/**
 * Read-only views over the offers tables.
 *
 * Everything that *writes* an offer or computes a ranking runs through the CLI
 * via the job runner, so the compiling and ranking logic has exactly one
 * implementation and this file never has to reimplement Stage 0 or Stage 1.
 */

export interface OfferAxis {
  key: string;
  label: string;
  question: string;
}

export interface OfferSummary {
  id: string;
  title: string;
  version: number;
  active: boolean;
  stage: string;
  summary: string | null;
  axes: OfferAxis[];
  cnaes: string[];
  channels: string[];
  shortlisted: number;
  enriched: number;
  scored: number;
  contacted: number;
  interested: number;
}

const OFFER_SELECT = `
  SELECT o.id, o.title, o.active, s.version,
         s.spec ->> 'stage'                            AS stage,
         s.spec ->> 'summary'                          AS summary,
         COALESCE(s.spec -> 'rubric' -> 'axes', '[]'::jsonb)                AS axes,
         COALESCE(s.spec -> 'targeting' -> 'cnaePrefixes', '[]'::jsonb)     AS cnaes,
         COALESCE(s.spec -> 'targeting' -> 'channels', '[]'::jsonb)         AS channels,
         (SELECT count(*) FROM offer_candidates c WHERE c.offer_id = o.id)  AS shortlisted,
         (SELECT count(*) FROM offer_candidates c
            JOIN enrichment e ON e.cnpj = c.cnpj
           WHERE c.offer_id = o.id)                                         AS enriched,
         (SELECT count(*) FROM scores sc
           WHERE sc.offer_id = o.id AND sc.best_fit IS NOT NULL)            AS scored,
         (SELECT count(*) FROM outreach ou WHERE ou.offer_id = o.id)        AS contacted,
         (SELECT count(*) FROM outreach ou
           WHERE ou.offer_id = o.id AND ou.interest IS NOT NULL)            AS interested
    FROM offers o
    LEFT JOIN offer_specs s ON s.offer_id = o.id AND s.version = o.current_version`;

function shape(r: Record<string, unknown>): OfferSummary {
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    id: String(r.id),
    title: String(r.title),
    version: n("version"),
    active: Boolean(r.active),
    stage: String(r.stage ?? "?"),
    summary: (r.summary as string) ?? null,
    axes: (r.axes as OfferAxis[]) ?? [],
    cnaes: (r.cnaes as string[]) ?? [],
    channels: (r.channels as string[]) ?? [],
    shortlisted: n("shortlisted"),
    enriched: n("enriched"),
    scored: n("scored"),
    contacted: n("contacted"),
    interested: n("interested"),
  };
}

export async function listOffers(): Promise<OfferSummary[]> {
  const rows = await sql<Record<string, unknown>>(
    `${OFFER_SELECT} ORDER BY o.active DESC, o.created_at DESC`
  );
  return rows.map(shape);
}

export async function getOffer(id: string): Promise<OfferSummary | undefined> {
  const r = await sqlOne<Record<string, unknown>>(`${OFFER_SELECT} WHERE o.id = $1`, [id]);
  return r ? shape(r) : undefined;
}

/** The active offer drives the main table's columns when no ?offer= is given. */
export async function activeOfferId(): Promise<string | undefined> {
  const r = await sqlOne<{ id: string }>(`SELECT id FROM offers WHERE active LIMIT 1`);
  return r?.id;
}

/**
 * The active offer in one round trip.
 *
 * Callers that need the offer itself (not just its id) were doing
 * `activeOfferId()` and then `getOffer(id)` — a waterfall where the second
 * query cannot even be planned until the first returns. Since the pages that do
 * this then block on the result before starting their own queries, that round
 * trip sat in front of everything else on the page.
 */
export async function getActiveOffer(): Promise<OfferSummary | undefined> {
  const r = await sqlOne<Record<string, unknown>>(`${OFFER_SELECT} WHERE o.active`);
  return r ? shape(r) : undefined;
}

export async function getOfferSpec(id: string): Promise<{ spec: unknown; description: string; finalidade: string } | undefined> {
  return sqlOne(
    `SELECT s.spec, s.description, s.finalidade
       FROM offers o JOIN offer_specs s
         ON s.offer_id = o.id AND s.version = o.current_version
      WHERE o.id = $1`,
    [id]
  );
}

/**
 * Per-prefix reality check, mirroring `validateCnaes` in src/compile.ts.
 *
 * A count of zero has two causes that need opposite fixes — a code that does
 * not exist versus a real code whose data was never loaded — so the dictionary
 * join is what makes the difference visible.
 */
export interface CnaeCheck {
  prefix: string;
  leads: number;
  reachable: number;
  descricao: string | null;
  status: "ok" | "not_loaded" | "unknown";
}

export async function checkOfferCnaes(prefixes: string[]): Promise<CnaeCheck[]> {
  if (!prefixes.length) return [];
  // This was the slowest query in the app: 15,200 ms for three prefixes. Each
  // prefix ran two count(*) over 2.1M rows, and because the pattern is
  // `p.prefix || '%'` — not a literal — the planner could not use
  // leads_cnae_prefix_idx and fell back to a seq scan per subquery.
  //
  // leads_rollup (migration 009) pre-aggregates by every low-cardinality lead
  // attribute at once, so the same numbers are a sum over ~21k rows. `ativa`
  // reproduces this query's situacao='ATIVA' predicate exactly.
  const rows = await sql<Record<string, string | null>>(
    `SELECT p.prefix,
            (SELECT COALESCE(sum(r.n), 0) FROM leads_rollup r
              WHERE r.codigo LIKE p.prefix || '%' AND r.ativa)::text  AS leads,
            (SELECT COALESCE(sum(r.n), 0) FROM leads_rollup r
              WHERE r.codigo LIKE p.prefix || '%' AND r.ativa
                AND r.has_phone)::text                               AS reachable,
            (SELECT count(*) FROM cnaes c WHERE c.codigo LIKE p.prefix || '%')::text AS in_dict,
            (SELECT c.descricao FROM cnaes c
              WHERE c.codigo LIKE p.prefix || '%' ORDER BY c.codigo LIMIT 1) AS descricao
       FROM unnest($1::text[]) AS p(prefix)`,
    [prefixes]
  );
  return rows.map((r) => {
    const leads = Number(r.leads ?? 0);
    return {
      prefix: String(r.prefix),
      leads,
      reachable: Number(r.reachable ?? 0),
      descricao: r.descricao,
      status: leads > 0 ? "ok" : Number(r.in_dict ?? 0) > 0 ? "not_loaded" : "unknown",
    };
  });
}

export interface CandidateRow {
  cnpj: string;
  nome: string | null;
  municipio: string | null;
  uf: string | null;
  cnae: string | null;
  cnae_desc: string | null;
  is_mobile: boolean | null;
  rank_score: string;
  rank_parts: Record<string, boolean> | null;
  enriched: boolean;
  fits: Record<string, number | null> | null;
  best_fit: number | null;
  tier: string | null;
  hook: string | null;
  status: string;
}

/** The ranked list. Free — this is Stage 1 output, not LLM output. */
export async function getCandidates(
  offerId: string,
  page = 1,
  perPage = 50
): Promise<{ rows: CandidateRow[]; total: number }> {
  const offset = (Math.max(page, 1) - 1) * perPage;
  const rows = await sql<CandidateRow>(
    `SELECT oc.cnpj, l.nome_fantasia AS nome, l.municipio_nome AS municipio, l.uf,
            l.cnae_principal AS cnae, cn.descricao AS cnae_desc, l.is_mobile,
            oc.rank_score::text AS rank_score, oc.rank_parts,
            (e.cnpj IS NOT NULL) AS enriched,
            s.fits, s.best_fit, s.tier, s.hook,
            COALESCE(o.status, 'novo') AS status
       FROM offer_candidates oc
       JOIN leads l ON l.cnpj = oc.cnpj
       LEFT JOIN cnaes cn ON cn.codigo = l.cnae_principal
       LEFT JOIN enrichment e ON e.cnpj = oc.cnpj
       LEFT JOIN scores s ON s.cnpj = oc.cnpj AND s.offer_id = oc.offer_id
       LEFT JOIN outreach o ON o.cnpj = oc.cnpj
      WHERE oc.offer_id = $1
      ORDER BY s.best_fit DESC NULLS LAST,
               oc.rank_score DESC,
               COALESCE(l.capital_social, 0) DESC,
               oc.cnpj
      LIMIT $2 OFFSET $3`,
    [offerId, perPage, offset]
  );

  const count = await sqlOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM offer_candidates WHERE offer_id = $1`,
    [offerId]
  );
  return { rows, total: Number(count?.n ?? 0) };
}

// ------------------------------------------------------------------- demand
//
// The deliverable. Everything upstream — loading, ranking, scoring, drafting —
// exists to produce this list: companies that heard the idea and said
// something. `interest` is deliberately separate from `status`, because
// "respondeu" and "pagaria" are different facts and collapsing them into one
// enum would lose the only row that proves demand.

/** Strongest first. priced_too_high outranks not_now: they want it, you mispriced. */
export const INTEREST_ORDER = [
  "committed",
  "would_pay",
  "wants_demo",
  "interested",
  "priced_too_high",
  "not_now",
  "no_interest",
  "wrong_person",
] as const;

export const INTEREST_LABEL: Record<string, string> = {
  committed: "fechou",
  would_pay: "pagaria",
  wants_demo: "quer ver",
  interested: "interessado",
  priced_too_high: "achou caro",
  not_now: "agora não",
  no_interest: "sem interesse",
  wrong_person: "pessoa errada",
};

export interface DemandRow {
  cnpj: string;
  nome: string | null;
  municipio: string | null;
  uf: string | null;
  cnae_desc: string | null;
  phone_e164: string | null;
  is_mobile: boolean | null;
  offer_id: string | null;
  interest: string;
  interest_at: string | null;
  contact_name: string | null;
  contact_role: string | null;
  price_ceiling: string | null;
  notes: string | null;
  hook: string | null;
}

export async function getDemand(offerId?: string): Promise<DemandRow[]> {
  const params: unknown[] = [INTEREST_ORDER as unknown as string[]];
  let filter = "";
  if (offerId) {
    params.push(offerId);
    filter = `AND o.offer_id = $${params.length}`;
  }
  return sql<DemandRow>(
    `SELECT o.cnpj, l.nome_fantasia AS nome, l.municipio_nome AS municipio, l.uf,
            cn.descricao AS cnae_desc, l.phone_e164, l.is_mobile,
            o.offer_id, o.interest, o.interest_at::text, o.contact_name, o.contact_role,
            o.price_ceiling::text, o.notes, s.hook
       FROM outreach o
       JOIN leads l ON l.cnpj = o.cnpj
       LEFT JOIN cnaes cn ON cn.codigo = l.cnae_principal
       LEFT JOIN scores s ON s.cnpj = o.cnpj AND s.offer_id = o.offer_id
      WHERE o.interest IS NOT NULL ${filter}
      ORDER BY array_position($1::text[], o.interest), o.interest_at DESC NULLS LAST`,
    params
  );
}

/** Conversion per offer — the comparison that actually decides which idea to build. */
export interface DemandFunnel {
  offer_id: string;
  title: string;
  contacted: number;
  replied: number;
  positive: number;
  would_pay: number;
}

export async function getDemandFunnel(): Promise<DemandFunnel[]> {
  return sql<DemandFunnel>(
    `SELECT o.offer_id, COALESCE(f.title, o.offer_id) AS title,
            count(*)::int                                                        AS contacted,
            count(*) FILTER (WHERE o.status = 'replied')::int                     AS replied,
            count(*) FILTER (WHERE o.interest IN
              ('committed','would_pay','wants_demo','interested'))::int           AS positive,
            count(*) FILTER (WHERE o.interest IN ('committed','would_pay'))::int  AS would_pay
       FROM outreach o
       LEFT JOIN offers f ON f.id = o.offer_id
      WHERE o.offer_id IS NOT NULL
      GROUP BY o.offer_id, f.title
      ORDER BY would_pay DESC, positive DESC`
  );
}
