/**
 * CSV formatting for the browser download path.
 *
 * A deliberate copy of the two helpers in `src/csv.ts`, which is the authority.
 * That module cannot be imported here: it pulls in `./db` at module scope and
 * would open a second connection pool inside the Next server — the same reason
 * `src/offers/rank.ts` was written import-free. Twelve duplicated lines is a
 * much cheaper price than that.
 */

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
