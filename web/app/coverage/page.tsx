import { getCoverage } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function CoveragePage() {
  const rows = await getCoverage();

  return (
    <>
      <h1 style={{ fontSize: 16, fontWeight: 650, marginBottom: 4 }}>Cobertura</h1>
      <p className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
        Onde há leads e onde o enriquecimento/pontuação ainda não chegou. Use isto para
        decidir o que rodar em seguida, não para navegar.
      </p>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">município</th>
              <th>UF</th>
              <th>CNAE</th>
              <th className="num">leads</th>
              <th className="num">enriquecidos</th>
              <th className="num">pontuados</th>
              <th className="num">hot</th>
              <th className="num">% enriquecido</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const leads = Number(r.leads);
              const enr = Number(r.enriched);
              const pct = leads ? Math.round((enr / leads) * 100) : 0;
              return (
                <tr key={i}>
                  <td className="sticky-col">{r.municipio ?? "—"}</td>
                  <td>{r.uf ?? "—"}</td>
                  <td className="muted">{r.cnae ?? "—"}</td>
                  <td className="num">{leads.toLocaleString("pt-BR")}</td>
                  <td className="num">{enr.toLocaleString("pt-BR")}</td>
                  <td className="num">{Number(r.scored).toLocaleString("pt-BR")}</td>
                  <td className="num">{Number(r.hot).toLocaleString("pt-BR")}</td>
                  <td className="num">
                    <span className={pct >= 90 ? "chip chip-ok" : pct > 0 ? "chip chip-warm" : "chip chip-plain"}>
                      {pct}%
                    </span>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  Sem dados ainda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
