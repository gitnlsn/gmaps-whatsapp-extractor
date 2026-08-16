import Link from "next/link";
import { getQueue, sentToday } from "@/lib/queries";
import { setStatus } from "@/app/actions";
import { TierChip, SiteChip, Evidence } from "@/components/bits";

export const dynamic = "force-dynamic";

const DAILY_CAP = Number(process.env.DAILY_SEND_CAP ?? 40);

export default async function QueuePage() {
  const [rows, today] = await Promise.all([getQueue(DAILY_CAP * 2), sentToday()]);
  const remaining = Math.max(0, DAILY_CAP - today);

  async function mark(formData: FormData) {
    "use server";
    const cnpj = String(formData.get("cnpj"));
    const status = String(formData.get("status")) as
      | "sent" | "not_a_fit" | "opted_out";
    await setStatus(cnpj, status);
  }

  return (
    <>
      <div
        className="panel"
        style={{ padding: 10, marginBottom: 12, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}
      >
        <div>
          <span style={{ fontSize: 17, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
            {today}/{DAILY_CAP}
          </span>{" "}
          <span className="muted">enviados hoje · {remaining} restantes</span>
        </div>
        <div className="muted" style={{ fontSize: 11.5, flex: 1, minWidth: 300 }}>
          Salve o contato na agenda <strong>antes</strong> de mandar mensagem — mandar para
          número que não está nos seus contatos é o sinal de banimento mais forte. Máximo 2
          toques. Sem link nem imagem na primeira mensagem.
        </div>
      </div>

      {remaining === 0 && (
        <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
          Limite diário atingido. Pare por hoje — volume é o que derruba número.
        </div>
      )}

      <div className="tbl-wrap" style={{ maxHeight: "none" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">negócio</th>
              <th>local</th>
              <th>site</th>
              <th className="num">web</th>
              <th className="num">bot</th>
              <th>tier</th>
              <th>gancho</th>
              <th>evidência</th>
              <th>ação</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, remaining || rows.length).map((r) => (
              <tr key={r.cnpj}>
                <td className="sticky-col" style={{ maxWidth: 200 }}>
                  <Link className="link" href={`/lead/${r.cnpj}`}>
                    {r.nome ?? r.cnpj}
                  </Link>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {r.phone_e164}
                  </div>
                </td>
                <td className="muted">
                  {r.municipio ?? "—"}/{r.uf ?? "—"}
                </td>
                <td>
                  <SiteChip status={r.site_status} />
                </td>
                <td className="num">{r.web_fit ?? "—"}</td>
                <td className="num">{r.chatbot_fit ?? "—"}</td>
                <td>
                  <TierChip tier={r.tier} />
                </td>
                <td style={{ whiteSpace: "normal", maxWidth: 340, fontSize: 12 }}>
                  {r.hook ?? <span className="muted">— sem gancho concreto —</span>}
                </td>
                <td style={{ whiteSpace: "normal", maxWidth: 240 }}>
                  <Evidence items={r.evidence} />
                </td>
                <td>
                  <div style={{ display: "flex", gap: 4 }}>
                    {r.phone_e164 && (
                      <a
                        className="btn btn-primary"
                        href={`https://wa.me/${r.phone_e164.replace(/\D/g, "")}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        abrir
                      </a>
                    )}
                    <form action={mark} style={{ display: "flex", gap: 4 }}>
                      <input type="hidden" name="cnpj" value={r.cnpj} />
                      <button className="btn" name="status" value="sent" title="marcar como enviado">
                        ✓
                      </button>
                      <button className="btn" name="status" value="not_a_fit" title="não serve">
                        ✕
                      </button>
                      <button className="btn" name="status" value="opted_out" title="opt-out permanente">
                        ⊘
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  Fila vazia. Rode <code>npm run score</code> para pontuar mais leads.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
