import { writeFile } from "node:fs/promises";
import { CnpjCompany, ExtractedContact } from "./types";

function escapeCsvField(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function formatCsv(contacts: ExtractedContact[]): string {
  const header = "name,phone,wa_me_link,address,website,rating,review_count,type,google_maps_url,lead_score,lead_score_reason";
  const rows = contacts.map((c) =>
    [
      c.name,
      c.phone,
      c.waMeLink,
      c.address,
      c.websiteUri ?? "",
      c.rating?.toString() ?? "",
      c.userRatingCount?.toString() ?? "",
      c.primaryType ?? "",
      c.googleMapsUri ?? "",
      c.leadScore?.toString() ?? "",
      c.leadScoreReason ?? "",
    ]
      .map(escapeCsvField)
      .join(",")
  );
  return [header, ...rows].join("\n") + "\n";
}

export async function writeCsv(
  filePath: string,
  contacts: ExtractedContact[]
): Promise<void> {
  await writeFile(filePath, formatCsv(contacts), "utf-8");
}

export function formatCnpjCsv(companies: CnpjCompany[]): string {
  const header = "status,company_name,cnpj,cnpj_full,razao_social,nome_fantasia,location,endereco,detail_url,capital_social,cnae_principal,cnaes_secundarios,natureza_juridica,data_abertura";
  const rows = companies.map((c) =>
    [
      c.status,
      c.companyName,
      c.cnpj,
      c.cnpjFull ?? "",
      c.razaoSocial ?? "",
      c.nomeFantasia ?? "",
      c.location,
      c.endereco ?? "",
      c.detailUrl,
      c.capitalSocial ?? "",
      c.cnaePrincipal ?? "",
      c.cnaesSecundarios ?? "",
      c.naturezaJuridica ?? "",
      c.dataAbertura ?? "",
    ]
      .map(escapeCsvField)
      .join(",")
  );
  return [header, ...rows].join("\n") + "\n";
}

export async function writeCnpjCsv(
  filePath: string,
  companies: CnpjCompany[]
): Promise<void> {
  await writeFile(filePath, formatCnpjCsv(companies), "utf-8");
}

export async function writeCnpjJson(
  filePath: string,
  companies: CnpjCompany[]
): Promise<void> {
  await writeFile(filePath, JSON.stringify(companies, null, 2) + "\n", "utf-8");
}
