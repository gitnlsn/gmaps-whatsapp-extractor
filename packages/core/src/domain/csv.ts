/**
 * CSV formatting. Pure string work, no filesystem.
 *
 * The dashboard used to carry a byte-for-byte copy of this because importing it
 * would have dragged the pg pool across the app boundary. Now both sides import
 * the same twelve lines.
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

/** Shared cell coercion: null becomes empty, booleans become sim/nao. */
export function csvBody(header: string[], rows: Record<string, unknown>[]): (string | null)[][] {
  return rows.map((r) =>
    header.map((h) => {
      const v = r[h];
      if (v === null || v === undefined) return "";
      if (typeof v === "boolean") return v ? "sim" : "nao";
      return String(v);
    })
  );
}
