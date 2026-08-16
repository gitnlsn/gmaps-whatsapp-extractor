import { sql, sqlOne } from "@/lib/db";
import { formatCsv } from "@leads/core/domain";
import { getOffer } from "@/lib/offers";

/**
 * Downloads an offer's ranked shortlist as CSV.
 *
 * Same rows and same order as the table on /offers/[slug], so the file matches
 * what was on screen. The fit columns are generated from the offer's own axes
 * rather than hardcoded — an offer selling something else has different axes,
 * and this is the last place in the app that used to assume otherwise.
 */

export const dynamic = "force-dynamic";

/** Mirrors the CHECK on offers.id in migration 006. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

// The shortlist itself is capped when it is built; this is a second belt so a
// hand-typed URL cannot ask for an unbounded response.
const MAX_ROWS = 20_000;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return new Response("slug inválido", { status: 400 });
  }

  const offer = await getOffer(slug);
  if (!offer) return new Response("oferta não encontrada", { status: 404 });

  const exists = await sqlOne<{ id: string }>(`SELECT id FROM offers WHERE id = $1`, [slug]);
  if (!exists) return new Response("oferta não encontrada", { status: 404 });

  const rows = await sql<Record<string, unknown>>(
    `SELECT oc.cnpj,
            COALESCE(l.nome_fantasia, l.razao_social) AS nome,
            l.municipio_nome AS municipio, l.uf,
            l.cnae_principal AS cnae, cn.descricao AS cnae_desc,
            CASE WHEN l.is_mobile THEN 'celular' ELSE 'fixo' END AS canal,
            l.phone_e164 AS telefone,
            'https://wa.me/' || regexp_replace(COALESCE(l.phone_e164,''), '\\D', '', 'g') AS wa_me,
            l.email,
            COALESCE(e.final_url, e.website_url) AS site,
            round(oc.rank_score, 1)::text AS rank,
            s.fits, s.best_fit, s.tier, s.confidence, s.recommendation, s.hook,
            COALESCE(o.status, 'novo') AS status, o.interest
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
      LIMIT $2`,
    [slug, MAX_ROWS]
  );

  const axisKeys = offer.axes.map((a) => a.key);
  const header = [
    "cnpj", "nome", "municipio", "uf", "cnae", "segmento",
    "canal", "telefone", "wa_me", "email", "site", "rank",
    ...offer.axes.map((a) => a.label),
    "nota", "tier", "confianca", "recomendacao", "gancho", "status", "interesse",
  ];

  const body = rows.map((r) => {
    const fits = (r.fits ?? {}) as Record<string, number | null>;
    const v = (k: string) => {
      const x = r[k];
      return x === null || x === undefined ? "" : String(x);
    };
    return [
      v("cnpj"), v("nome"), v("municipio"), v("uf"), v("cnae"), v("cnae_desc"),
      v("canal"), v("telefone"), v("wa_me"), v("email"), v("site"), v("rank"),
      ...axisKeys.map((k) => (fits[k] === null || fits[k] === undefined ? "" : String(fits[k]))),
      v("best_fit"), v("tier"), v("confidence"), v("recommendation"), v("hook"),
      v("status"), v("interest"),
    ];
  });

  const stamp = new Date().toISOString().slice(0, 10);

  // Leading BOM: without it Excel on pt-BR Windows renders "Educação" as
  // "EducaÃ§Ã£o". Every other reader ignores it.
  return new Response("﻿" + formatCsv(header, body), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
