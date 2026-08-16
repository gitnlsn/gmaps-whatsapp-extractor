import Link from "next/link";

export function TierChip({ tier }: { tier: string | null }) {
  if (!tier) return <span className="muted">—</span>;
  const cls =
    tier === "hot" ? "chip chip-hot" : tier === "warm" ? "chip chip-warm" : "chip chip-cold";
  return <span className={cls}>{tier}</span>;
}

/**
 * The site verdict is the single most decision-relevant cell in the table, so
 * it is colour-coded: red-ish = a reason to call them, green = leave them alone.
 */
export function SiteChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    "sem site": "chip chip-hot",
    morto: "chip chip-hot",
    "link hub": "chip chip-hot",
    "construtor gratis": "chip chip-warm",
    "nao responsivo": "chip chip-warm",
    ok: "chip chip-ok",
    "nao verificado": "chip chip-plain",
  };
  return <span className={map[status] ?? "chip chip-plain"}>{status}</span>;
}

export function Evidence({ items }: { items: string[] | null }) {
  if (!items || items.length === 0) return <span className="muted">—</span>;
  return (
    <span>
      {items.slice(0, 4).map((e, i) => (
        <span key={i} className="chip chip-plain" title={e}>
          {e.length > 28 ? `${e.slice(0, 27)}…` : e}
        </span>
      ))}
      {items.length > 4 && <span className="muted">+{items.length - 4}</span>}
    </span>
  );
}

export function Fit({ n }: { n: number | null }) {
  if (n === null || n === undefined) return <span className="muted">—</span>;
  const strong = n >= 4;
  return (
    <span style={{ fontWeight: strong ? 700 : 400, color: strong ? "var(--text)" : "var(--muted)" }}>
      {n}
    </span>
  );
}

/** Sortable column header that round-trips through searchParams. */
export function SortHeader({
  label,
  col,
  current,
  dir,
  params,
  className,
}: {
  label: string;
  col: string;
  current?: string;
  dir?: string;
  params: Record<string, string | undefined>;
  className?: string;
}) {
  const active = current === col;
  const nextDir = active && dir !== "asc" ? "asc" : "desc";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== "sort" && k !== "dir" && k !== "page") qs.set(k, v);
  }
  qs.set("sort", col);
  qs.set("dir", nextDir);

  return (
    <th className={className}>
      <Link href={`?${qs.toString()}`}>
        {label}
        {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
      </Link>
    </th>
  );
}

export function Pager({
  page,
  perPage,
  total,
  params,
}: {
  page: number;
  perPage: number;
  total: number;
  params: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const mk = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && k !== "page") qs.set(k, v);
    qs.set("page", String(p));
    return `?${qs.toString()}`;
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginTop: 10,
        fontSize: 12,
      }}
    >
      <span className="muted">
        {total.toLocaleString("pt-BR")} resultado(s) · página {page} de {pages}
      </span>
      <span style={{ flex: 1 }} />
      {page > 1 && (
        <Link className="btn" href={mk(page - 1)}>
          ← anterior
        </Link>
      )}
      {page < pages && (
        <Link className="btn" href={mk(page + 1)}>
          próxima →
        </Link>
      )}
    </div>
  );
}
