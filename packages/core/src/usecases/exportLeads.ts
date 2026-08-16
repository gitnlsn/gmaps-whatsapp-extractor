import type { Deps } from "../ports/index";
import { csvBody, formatCsv } from "../domain/csv";
import { resolveOffer } from "./offerRepo";

export interface ExportOptions {
  tier?: string;
  limit: number;
  offerId?: string;
}

const HEADER = [
  "cnpj",
  "nome",
  "municipio",
  "uf",
  "cnae",
  "idade_anos",
  "porte",
  "mei",
  "telefone",
  "wa_me",
  "site",
  "site_status",
  "canal",
  "fit",
  "notas",
  "tier",
  "confianca",
  "recomendacao",
  "evidencia",
  "hook",
  "status",
  "interesse",
];

export interface ExportResult {
  csv: string;
  rows: number;
}

/**
 * Returns the CSV rather than writing it. Keeping the filesystem out of the
 * core is what lets a test assert on the bytes without a temp directory, and
 * lets the dashboard stream the same export straight down a response.
 */
export async function exportLeads(deps: Deps, opts: ExportOptions): Promise<ExportResult> {
  const offer = await resolveOffer(deps, opts.offerId);
  const rows = await deps.db.query<Record<string, unknown>>(
    `SELECT l.cnpj,
            COALESCE(l.nome_fantasia, l.razao_social) AS nome,
            l.municipio_nome AS municipio, l.uf, l.cnae_principal AS cnae,
            CASE WHEN l.data_inicio_atividade IS NOT NULL
                 THEN date_part('year', age(l.data_inicio_atividade))::int END AS idade_anos,
            l.porte, l.opcao_mei AS mei, l.phone_e164 AS telefone,
            'https://wa.me/' || regexp_replace(COALESCE(l.phone_e164,''), '\\D', '', 'g') AS wa_me,
            COALESCE(e.final_url, e.website_url) AS site,
            CASE
              WHEN e.has_website IS NOT TRUE THEN 'sem site'
              WHEN e.is_dead                 THEN 'morto'
              WHEN e.is_link_hub             THEN 'link hub'
              WHEN e.is_free_builder         THEN 'construtor gratis'
              WHEN e.has_viewport IS FALSE   THEN 'nao responsivo'
              ELSE 'ok'
            END AS site_status,
            CASE WHEN l.is_mobile THEN 'celular' ELSE 'fixo' END AS canal,
            s.best_fit AS fit,
            -- Axis names come from the offer, so they are flattened to a single
            -- readable column rather than a fixed pair.
            (SELECT string_agg(k || '=' || v, ' ' ORDER BY k)
               FROM jsonb_each_text(COALESCE(s.fits, '{}'::jsonb)) AS f(k, v)) AS notas,
            s.tier, s.confidence AS confianca, s.recommendation AS recomendacao,
            array_to_string(
              ARRAY(SELECT jsonb_array_elements_text(s.evidence -> 'evidence')), ' | '
            ) AS evidencia,
            s.hook,
            COALESCE(o.status, 'novo') AS status,
            o.interest AS interesse
     FROM leads l
     JOIN scores s ON s.cnpj = l.cnpj AND s.offer_id = $2
     LEFT JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN outreach o ON o.cnpj = l.cnpj
     WHERE s.best_fit IS NOT NULL
       ${opts.tier ? "AND s.tier = $3" : ""}
     ORDER BY s.best_fit DESC, l.is_mobile DESC NULLS LAST
     LIMIT $1`,
    opts.tier ? [opts.limit, offer.id, opts.tier] : [opts.limit, offer.id]
  );

  return {
    csv: formatCsv(HEADER, csvBody(HEADER, rows)),
    rows: rows.length,
  };
}

// ------------------------------------------------------------------- demand

const DEMAND_HEADER = [
  "cnpj",
  "nome",
  "municipio",
  "uf",
  "cnae",
  "oferta",
  "interesse",
  "contato",
  "cargo",
  "pagaria_mes",
  "telefone",
  "canal",
  "hook_usado",
  "notas",
  "registrado_em",
];

/**
 * Exports validated demand — the point of the whole exercise.
 *
 * Ordered by how strong the signal is rather than by date, so the top of the
 * file is the list you would take into a decision about whether to build.
 */
export async function exportDemand(deps: Deps, offerId?: string): Promise<ExportResult> {
  const rows = await deps.db.query<Record<string, unknown>>(
    `SELECT o.cnpj,
            COALESCE(l.nome_fantasia, l.razao_social) AS nome,
            l.municipio_nome AS municipio, l.uf,
            COALESCE(cn.descricao, l.cnae_principal) AS cnae,
            o.offer_id AS oferta, o.interest AS interesse,
            o.contact_name AS contato, o.contact_role AS cargo,
            o.price_ceiling::text AS pagaria_mes,
            l.phone_e164 AS telefone,
            CASE WHEN l.is_mobile THEN 'celular' ELSE 'fixo' END AS canal,
            s.hook AS hook_usado, o.notes AS notas,
            o.interest_at::date::text AS registrado_em
       FROM outreach o
       JOIN leads l ON l.cnpj = o.cnpj
       LEFT JOIN cnaes cn ON cn.codigo = l.cnae_principal
       LEFT JOIN scores s ON s.cnpj = o.cnpj AND s.offer_id = o.offer_id
      WHERE o.interest IS NOT NULL
        ${offerId ? "AND o.offer_id = $1" : ""}
      ORDER BY array_position(
                 ARRAY['committed','would_pay','wants_demo','interested',
                       'priced_too_high','not_now','no_interest','wrong_person'],
                 o.interest),
               o.interest_at DESC NULLS LAST`,
    offerId ? [offerId] : []
  );

  return {
    csv: formatCsv(DEMAND_HEADER, csvBody(DEMAND_HEADER, rows)),
    rows: rows.length,
  };
}
