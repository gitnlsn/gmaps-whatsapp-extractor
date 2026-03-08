import { writeFile } from "node:fs/promises";
import { ExtractedContact } from "./types";

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
