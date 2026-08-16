import Link from "next/link";
import { getDemand, getDemandFunnel, INTEREST_LABEL } from "@/lib/offers";

export const dynamic = "force-dynamic";

const fmt = (n: number) => n.toLocaleString("pt-BR");

const POSITIVE = new Set(["committed", "would_pay", "wants_demo", "interested"]);

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function DemandPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const offerId = (Array.isArray(sp.offer) ? sp.offer[0] : sp.offer) || undefined;

  const [rows, funnel] = await Promise.all([getDemand(offerId), getDemandFunnel()]);

  return (
    <>
      <h1 style={{ fontSize: 16, fontWeight: 650, marginBottom: 4 }}>Demanda validada</h1>
      <p className="muted" style={{ marginBottom: 12, fontSize: 12, maxWidth: 820 }}>
        Quem ouviu a ideia e respondeu alguma coisa. É o resultado que o resto do pipeline
        existe para produzir — e a única comparação que decide qual produto construir é a taxa
        de conversão por oferta, não a nota que o modelo deu.
      </p>

      {funnel.length > 0 && (
        <div className="tbl-wrap" style={{ marginBottom: 16 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="sticky-col">oferta</th>
                <th className="num">contatados</th>
                <th className="num">responderam</th>
                <th className="num">positivos</th>
                <th className="num">pagariam</th>
                <th className="num">conversão</th>
              </tr>
            </thead>
            <tbody>
              {funnel.map((f) => {
                const conv = f.contacted ? (f.positive / f.contacted) * 100 : 0;
                return (
                  <tr key={f.offer_id}>
                    <td className="sticky-col">
                      <Link className="link" href={`/offers/${f.offer_id}`}>
                        {f.title}
                      </Link>
                    </td>
                    <td className="num">{fmt(f.contacted)}</td>
                    <td className="num">{fmt(f.replied)}</td>
                    <td className="num">{fmt(f.positive)}</td>
                    <td className="num">
                      <strong>{fmt(f.would_pay)}</strong>
                    </td>
                    <td className="num">
                      <span className={conv >= 5 ? "chip chip-ok" : "chip chip-plain"}>
                        {conv.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">empresa</th>
              <th>onde</th>
              <th>segmento</th>
              <th>interesse</th>
              <th>contato</th>
              <th className="num">pagaria/mês</th>
              <th>telefone</th>
              <th>notas</th>
              <th>quando</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cnpj}>
                <td className="sticky-col" style={{ maxWidth: 240 }}>
                  <Link className="link" href={`/lead/${r.cnpj}`}>
                    {r.nome ?? r.cnpj}
                  </Link>
                </td>
                <td className="muted">
                  {r.municipio ?? "—"}/{r.uf ?? "—"}
                </td>
                <td className="muted" style={{ fontSize: 11.5, maxWidth: 200 }}>
                  {r.cnae_desc ?? "—"}
                </td>
                <td>
                  <span className={POSITIVE.has(r.interest) ? "chip chip-ok" : "chip chip-plain"}>
                    {INTEREST_LABEL[r.interest] ?? r.interest}
                  </span>
                </td>
                <td>
                  {r.contact_name ?? "—"}
                  {r.contact_role && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {r.contact_role}
                    </div>
                  )}
                </td>
                <td className="num">
                  {r.price_ceiling ? `R$ ${Number(r.price_ceiling).toLocaleString("pt-BR")}` : "—"}
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>
                  {r.phone_e164 ?? "—"}
                </td>
                <td style={{ whiteSpace: "normal", maxWidth: 300, fontSize: 11.5 }}>
                  {r.notes ?? "—"}
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>
                  {r.interest_at?.slice(0, 10) ?? "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  Ninguém respondeu ainda. Registre o retorno na fila com{" "}
                  <code>[i]</code>, ou na ficha do lead.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
        Exportar: <code>npm start -- demand demanda.csv</code> — o arquivo tem telefone e nome de
        pessoas. Está no .gitignore; mantenha assim.
      </p>
    </>
  );
}
