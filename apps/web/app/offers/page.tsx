import Link from "next/link";
import { listOffers } from "@/lib/offers";

export const dynamic = "force-dynamic";

const fmt = (n: number) => n.toLocaleString("pt-BR");

const STAGE_LABEL: Record<string, string> = {
  presell: "pré-venda",
  beta: "beta",
  live: "no ar",
};

export default async function OffersPage() {
  const offers = await listOffers();

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 16, fontWeight: 650 }}>Ofertas</h1>
        <Link className="link" href="/offers/new" style={{ fontSize: 12.5 }}>
          + nova oferta
        </Link>
      </div>
      <p className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
        Uma oferta é o produto que você está vendendo. Ela define quem é procurado, como cada
        empresa é pontuada e o que a primeira mensagem diz. Só uma fica ativa por vez — é o que
        impede duas campanhas de falarem com a mesma pessoa.
      </p>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">oferta</th>
              <th>etapa</th>
              <th>eixos</th>
              <th>canais</th>
              <th className="num">shortlist</th>
              <th className="num">enriquecidos</th>
              <th className="num">pontuados</th>
              <th className="num">contatados</th>
              <th className="num">interessados</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.id}>
                <td className="sticky-col" style={{ maxWidth: 260 }}>
                  <Link className="link" href={`/offers/${o.id}`}>
                    {o.title}
                  </Link>
                  {o.active && (
                    <span className="chip chip-ok" style={{ marginLeft: 6 }}>
                      ativa
                    </span>
                  )}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {o.id} v{o.version}
                  </div>
                </td>
                <td>
                  <span className={o.stage === "presell" ? "chip chip-warm" : "chip chip-plain"}>
                    {STAGE_LABEL[o.stage] ?? o.stage}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>
                  {o.axes.map((a) => a.key).join(", ") || "—"}
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>
                  {o.channels.join(", ") || "—"}
                </td>
                <td className="num">{fmt(o.shortlisted)}</td>
                <td className="num">{fmt(o.enriched)}</td>
                <td className="num">{fmt(o.scored)}</td>
                <td className="num">{fmt(o.contacted)}</td>
                <td className="num">{fmt(o.interested)}</td>
                <td>
                  <Link className="link" href={`/offers/${o.id}`} style={{ fontSize: 12 }}>
                    abrir
                  </Link>
                </td>
              </tr>
            ))}
            {offers.length === 0 && (
              <tr>
                <td colSpan={10} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  Nenhuma oferta ainda.{" "}
                  <Link className="link" href="/offers/new">
                    Descreva um produto
                  </Link>{" "}
                  para começar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
