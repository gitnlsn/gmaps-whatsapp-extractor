import { query, withClient } from "../db";
import { buildStage0Where, buildRankSql, buildRankPartsSql } from "./rank";
import type { LoadedOffer } from "./repo";

/**
 * Stage 0 (how many can I reach) and Stage 1 (in what order) — the free half of
 * the funnel, and the part that actually answers "which companies?".
 *
 * Neither spends a token. That is deliberate: the base is millions of rows and
 * free models are throttled to ~3.2s per request on a small daily quota, so an
 * LLM pass over the base is not slow, it is impossible. Ranking here and
 * spending the model only on the shortlist head is what makes the whole thing
 * work.
 */

export interface ReachCounts {
  matched: number;
  mobile: number;
  landline: number;
  named: number;
}

/** Stage 0: how many companies this offer can reach at all. */
export async function countReach(offer: LoadedOffer): Promise<ReachCounts> {
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = buildStage0Where(offer.spec, p);

  const rows = await query<Record<string, string>>(
    `SELECT count(*)::text                                            AS matched,
            count(*) FILTER (WHERE l.is_mobile)::text                 AS mobile,
            count(*) FILTER (WHERE NOT l.is_mobile)::text             AS landline,
            count(*) FILTER (WHERE l.nome_fantasia IS NOT NULL)::text AS named
       FROM leads l
      WHERE ${where.join("\n        AND ")}`,
    params
  );
  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);
  return { matched: n("matched"), mobile: n("mobile"), landline: n("landline"), named: n("named") };
}

/** Stage 1: rank the reachable set and materialise the top N. */
export async function buildShortlist(offer: LoadedOffer, limit: number): Promise<number> {
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = buildStage0Where(offer.spec, p);
  const rank = buildRankSql(offer.spec, offer.id, p);
  const parts = buildRankPartsSql(offer.spec);
  const offerParam = p(offer.id);
  const limitParam = p(limit);

  return withClient(async (c) => {
    await c.query("BEGIN");
    try {
      // Rebuilt wholesale rather than merged: the spec may have changed, and a
      // stale ranking is worse than none. `scored` rows are not lost — they
      // live in `scores`, keyed independently.
      await c.query(`DELETE FROM offer_candidates WHERE offer_id = $1`, [offer.id]);

      const { rowCount } = await c.query(
        `INSERT INTO offer_candidates (offer_id, cnpj, rank_score, rank_parts, stage)
         SELECT ${offerParam}, l.cnpj, (${rank})::numeric, ${parts}, 'shortlist'
           FROM leads l
           LEFT JOIN enrichment e ON e.cnpj = l.cnpj
          WHERE ${where.join("\n            AND ")}
          -- Most rank terms are binary, so before enrichment runs a lot of
          -- leads tie at the ceiling. Capital social breaks the tie with a real
          -- (if weak) size proxy instead of leaving the order to whatever the
          -- planner happened to emit; cnpj makes it fully deterministic.
          ORDER BY (${rank}) DESC,
                   COALESCE(l.capital_social, 0) DESC,
                   l.cnpj
          LIMIT ${limitParam}`,
        params
      );

      await c.query("COMMIT");
      return rowCount ?? 0;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

export interface TopRow {
  cnpj: string;
  nome: string | null;
  municipio: string | null;
  uf: string | null;
  cnae: string | null;
  cnae_desc: string | null;
  porte: string | null;
  is_mobile: boolean | null;
  rank_score: string;
  enriched: boolean;
  best_fit: number | null;
  hook: string | null;
}

/** The ranked list itself. */
export async function topCandidates(offer: LoadedOffer, limit: number): Promise<TopRow[]> {
  return query<TopRow>(
    `SELECT oc.cnpj, l.nome_fantasia AS nome, l.municipio_nome AS municipio, l.uf,
            l.cnae_principal AS cnae, cn.descricao AS cnae_desc, l.porte, l.is_mobile,
            oc.rank_score::text AS rank_score,
            (e.cnpj IS NOT NULL) AS enriched,
            s.best_fit, s.hook
       FROM offer_candidates oc
       JOIN leads l ON l.cnpj = oc.cnpj
       LEFT JOIN cnaes cn ON cn.codigo = l.cnae_principal
       LEFT JOIN enrichment e ON e.cnpj = oc.cnpj
       LEFT JOIN scores s ON s.cnpj = oc.cnpj AND s.offer_id = oc.offer_id
      WHERE oc.offer_id = $1
      ORDER BY oc.rank_score DESC, COALESCE(l.capital_social, 0) DESC, oc.cnpj
      LIMIT $2`,
    [offer.id, limit]
  );
}
