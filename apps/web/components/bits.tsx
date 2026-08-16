import PendingLink from "./PendingLink";

/**
 * Skeletons for the loading.tsx boundaries.
 *
 * They mirror the real chrome — same panel, same table wrapper, same row height
 * — so the shell that paints on navigation is the shell that stays. A skeleton
 * with a different shape reads as a second layout shift.
 */
export function Shimmer({ w, h = 12 }: { w: number | string; h?: number }) {
  return (
    <span
      className="shimmer"
      style={{ display: "inline-block", width: w, height: h, borderRadius: 3 }}
    />
  );
}

export function StatSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="panel" style={{ padding: 10, marginBottom: 12, display: "flex", gap: 18 }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <Shimmer w={52} h={9} />
          <Shimmer w={38} h={13} />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 12, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <div className="tbl-wrap" aria-busy="true" aria-live="polite">
      <table className="tbl">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>
                <Shimmer w={i === 0 ? 110 : 54} h={9} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <Shimmer w={c === 0 ? `${60 + ((r * 7) % 35)}%` : `${40 + ((r * 11 + c * 5) % 40)}%`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Title + subtitle + table: the shape every secondary page shares. */
export function PageSkeleton({
  title,
  cols,
  rows = 12,
}: {
  /** Real heading text — it is known at build time and steadies the layout. */
  title: string;
  cols: number;
  rows?: number;
}) {
  return (
    <>
      <h1 style={{ fontSize: 16, fontWeight: 650, marginBottom: 4 }}>{title}</h1>
      <div style={{ marginBottom: 12 }}>
        <Shimmer w="42%" h={10} />
      </div>
      <TableSkeleton rows={rows} cols={cols} />
    </>
  );
}

export function FilterBarSkeleton() {
  return (
    <div className="panel" style={{ padding: 10, marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
      {[170, 90, 130, 80, 110, 120, 110, 90, 110, 110, 110, 70].map((w, i) => (
        <Shimmer key={i} w={w} h={26} />
      ))}
    </div>
  );
}

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
      <PendingLink href={`?${qs.toString()}`}>
        {label}
        {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
      </PendingLink>
    </th>
  );
}

export function Pager({
  page,
  perPage,
  total,
  totalCapped = false,
  params,
}: {
  page: number;
  perPage: number;
  total: number;
  /** True when `total` is a ceiling rather than a count — rendered as "N+". */
  totalCapped?: boolean;
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
        {total.toLocaleString("pt-BR")}
        {totalCapped ? "+" : ""} resultado(s) · página {page} de {pages}
        {totalCapped ? "+" : ""}
      </span>
      <span style={{ flex: 1 }} />
      {page > 1 && (
        <PendingLink className="btn" href={mk(page - 1)}>
          ← anterior
        </PendingLink>
      )}
      {page < pages && (
        <PendingLink className="btn" href={mk(page + 1)}>
          próxima →
        </PendingLink>
      )}
    </div>
  );
}
