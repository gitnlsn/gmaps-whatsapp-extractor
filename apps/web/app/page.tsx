import { Suspense } from "react";
import Link from "next/link";
import { getLeads, getStats, getUfs, type Filters } from "@/lib/queries";
import { getActiveOffer, getOffer, type OfferAxis } from "@/lib/offers";
import FilterBar from "@/components/FilterBar";
import StatStrip from "@/components/StatStrip";
import {
  TierChip,
  SiteChip,
  Evidence,
  Fit,
  SortHeader,
  Pager,
  StatSkeleton,
  TableSkeleton,
  FilterBarSkeleton,
} from "@/components/bits";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length > 0 ? s : undefined;
}

const PARAM_KEYS = [
  "q", "uf", "municipio", "cnae", "tier", "offer", "site", "status", "canal",
  "minFit", "mei", "maxIdade", "sort", "dir", "page",
] as const;

type Params = Record<string, string | undefined>;

/**
 * The page itself awaits nothing but searchParams.
 *
 * Previously it awaited the active offer, then the offer, then a Promise.all of
 * three queries — so the browser got no HTML at all until the slowest of them
 * finished. Each section now fetches its own data behind its own Suspense
 * boundary: the shell and the table chrome paint immediately and each part
 * fills in as its query returns, slowest last instead of first.
 */
export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;

  const params: Params = {};
  for (const k of PARAM_KEYS) params[k] = one(sp[k]);

  // Keying the boundaries on the filter set makes React show the skeleton again
  // when the filters change. Without a key it would keep the previous rows on
  // screen during the transition, which reads as "these are your results".
  const key = PARAM_KEYS.map((k) => params[k] ?? "").join("|");

  return (
    <>
      <Suspense fallback={<StatSkeleton />}>
        <StatsSection />
      </Suspense>

      <Suspense fallback={<FilterBarSkeleton />}>
        <FiltersSection params={params} />
      </Suspense>

      <Suspense key={key} fallback={<TableSkeleton rows={14} cols={15} />}>
        <LeadsSection params={params} />
      </Suspense>
    </>
  );
}

async function StatsSection() {
  return <StatStrip s={await getStats()} />;
}

async function FiltersSection({ params }: { params: Params }) {
  return <FilterBar ufs={await getUfs()} params={params} />;
}

async function LeadsSection({ params }: { params: Params }) {
  // Scores belong to an offer, so the table's fit columns are whatever that
  // offer's rubric declared. No offer, no fit columns — which is honest: an
  // unscored lead has no fit, it does not have a zero.
  const offer = params.offer ? await getOffer(params.offer) : await getActiveOffer();
  const offerId = offer?.id;
  const axes: OfferAxis[] = offer?.axes ?? [];

  const filters: Filters = {
    q: params.q,
    uf: params.uf,
    municipio: params.municipio,
    cnae: params.cnae,
    tier: params.tier,
    offer: params.offer,
    site: params.site,
    status: params.status,
    canal: params.canal,
    mei: params.mei,
    minFit: params.minFit ? Number(params.minFit) : undefined,
    offerId,
    maxIdade: params.maxIdade ? Number(params.maxIdade) : undefined,
    sort: params.sort,
    dir: params.dir === "asc" ? "asc" : "desc",
    page: params.page ? Number(params.page) : 1,
    perPage: 50,
  };

  const { rows, total, totalCapped } = await getLeads(filters);

  const th = (label: string, col: string, className?: string) => (
    <SortHeader
      label={label}
      col={col}
      current={params.sort ?? "best"}
      dir={params.dir}
      params={params}
      className={className}
    />
  );

  return (
    <>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {th("negócio", "nome", "sticky-col")}
              {th("município", "municipio")}
              <th>UF</th>
              {th("CNAE", "cnae")}
              {th("idade", "idade_anos", "num")}
              {th("porte", "porte")}
              <th>telefone</th>
              <th>site</th>
              {axes.map((a) => (
                <th key={a.key} className="num" title={a.question}>
                  {a.label}
                </th>
              ))}
              {th("tier", "tier")}
              <th>conf</th>
              <th>oferta</th>
              <th>evidência</th>
              {th("status", "status")}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cnpj}>
                <td className="sticky-col" style={{ maxWidth: 230 }}>
                  <Link className="link" href={`/lead/${r.cnpj}`}>
                    {r.nome ?? r.cnpj}
                  </Link>
                </td>
                <td>{r.municipio ?? "—"}</td>
                <td>{r.uf ?? "—"}</td>
                <td className="muted">{r.cnae ?? "—"}</td>
                <td className="num">{r.idade_anos ?? "—"}</td>
                <td className="muted">
                  {r.mei ? "MEI" : (r.porte ?? "—")}
                </td>
                <td>
                  {r.phone_e164 ? (
                    <a
                      className="link"
                      href={`https://wa.me/${r.phone_e164.replace(/\D/g, "")}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.phone_e164}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <SiteChip status={r.site_status} />
                </td>
                {axes.map((a) => (
                  <td key={a.key} className="num">
                    <Fit n={r.fits?.[a.key] ?? null} />
                  </td>
                ))}
                <td>
                  <TierChip tier={r.tier} />
                </td>
                <td className="muted">{r.confidence ?? "—"}</td>
                <td className="muted">{r.offer ?? "—"}</td>
                <td style={{ whiteSpace: "normal", maxWidth: 320 }}>
                  <Evidence items={r.evidence} />
                </td>
                <td>
                  <span className={r.status === "novo" ? "chip chip-plain" : "chip chip-ok"}>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={15} style={{ padding: 24, textAlign: "center" }} className="muted">
                  Nenhum lead com esses filtros. Rode <code>npm run load</code>,{" "}
                  <code>npm run enrich</code> e <code>npm run score</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager
        page={filters.page ?? 1}
        perPage={50}
        total={total}
        totalCapped={totalCapped}
        params={params}
      />
    </>
  );
}
