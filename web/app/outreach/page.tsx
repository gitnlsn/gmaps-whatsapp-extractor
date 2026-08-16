import { getOutreach, getStats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function OutreachPage() {
  const [rows, stats] = await Promise.all([getOutreach(), getStats()]);
  const rate = stats.sent > 0 ? ((stats.replied / stats.sent) * 100).toFixed(1) : "—";

  return (
    <>
      <h1 style={{ fontSize: 16, fontWeight: 650, marginBottom: 4 }}>Contatos</h1>
      <p className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
        Taxa de resposta geral: <strong>{rate}%</strong>. Referência: disparo genérico fica
        em ~4%. Se você não estiver bem acima disso, o problema é a qualificação e a
        mensagem — não o volume.
      </p>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">semana</th>
              <th className="num">enviados</th>
              <th className="num">respostas</th>
              <th className="num">taxa</th>
              <th className="num">não serve</th>
              <th className="num">opt-out</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sent = Number(r.sent);
              const replied = Number(r.replied);
              const pct = sent ? ((replied / sent) * 100).toFixed(1) : "—";
              return (
                <tr key={r.week}>
                  <td className="sticky-col">{r.week}</td>
                  <td className="num">{sent}</td>
                  <td className="num">{replied}</td>
                  <td className="num">{pct}{sent ? "%" : ""}</td>
                  <td className="num">{r.not_a_fit}</td>
                  <td className="num">{r.opted_out}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  Nada enviado ainda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
