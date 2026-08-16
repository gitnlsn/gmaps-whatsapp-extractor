import { writeFile } from "node:fs/promises";
import { query } from "./db";

export function escapeCsvField(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function formatCsv(header: string[], rows: (string | null)[][]): string {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(row.map((v) => escapeCsvField(v ?? "")).join(","));
  }
  return lines.join("\n") + "\n";
}

export interface ExportOptions {
  tier?: string;
  limit: number;
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
  "web_fit",
  "chatbot_fit",
  "tier",
  "confianca",
  "oferta",
  "evidencia",
  "hook",
  "status",
];

export async function exportLeads(file: string, opts: ExportOptions): Promise<void> {
  const rows = await query<Record<string, unknown>>(
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
            s.web_fit, s.chatbot_fit, s.tier, s.confidence AS confianca, s.offer AS oferta,
            array_to_string(
              ARRAY(SELECT jsonb_array_elements_text(s.evidence -> 'evidence')), ' | '
            ) AS evidencia,
            s.hook,
            COALESCE(o.status, 'novo') AS status
     FROM leads l
     JOIN scores s ON s.cnpj = l.cnpj
     LEFT JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN outreach o ON o.cnpj = l.cnpj
     WHERE s.web_fit IS NOT NULL
       ${opts.tier ? "AND s.tier = $2" : ""}
     ORDER BY GREATEST(COALESCE(s.web_fit,0), COALESCE(s.chatbot_fit,0)) DESC
     LIMIT $1`,
    opts.tier ? [opts.limit, opts.tier] : [opts.limit]
  );

  const body = rows.map((r) =>
    HEADER.map((h) => {
      const v = r[h];
      if (v === null || v === undefined) return "";
      if (typeof v === "boolean") return v ? "sim" : "nao";
      return String(v);
    })
  );

  await writeFile(file, formatCsv(HEADER, body), "utf-8");
  console.log(`Wrote ${rows.length} row(s) to ${file}`);
  console.log(
    "Note: this file contains personal phone numbers. It is gitignored — keep it that way."
  );
}
