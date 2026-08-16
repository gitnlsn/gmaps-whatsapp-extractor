import Link from "next/link";
import { getLeads, getStats, getUfs, type Filters } from "@/lib/queries";
import { activeOfferId, getOffer } from "@/lib/offers";
import FilterBar from "@/components/FilterBar";
import StatStrip from "@/components/StatStrip";
import { TierChip, SiteChip, Evidence, Fit, SortHeader, Pager } from "@/components/bits";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length > 0 ? s : undefined;
}

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;

  const params: Record<string, string | undefined> = {};
  for (const k of [
    "q", "uf", "municipio", "cnae", "tier", "offer", "site", "status", "canal",
    "minFit", "mei", "maxIdade", "sort", "dir", "page",
  ]) {
    params[k] = one(sp[k]);
  }

  // Scores belong to an offer, so the table's fit columns are whatever that
  // offer's rubric declared. No offer, no fit columns — which is honest: an
  // unscored lead has no fit, it does not have a zero.
  const offerId = params.offer ?? (await activeOfferId());
  const offer = offerId ? await getOffer(offerId) : undefined;
  const axes = offer?.axes ?? [];

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

  const [{ rows, total }, stats, ufs] = await Promise.all([
    getLeads(filters),
    getStats(),
    getUfs(),
  ]);

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
      <StatStrip s={stats} />
      <FilterBar ufs={ufs} params={params} />

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

      <Pager page={filters.page ?? 1} perPage={50} total={total} params={params} />
    </>
  );
}
