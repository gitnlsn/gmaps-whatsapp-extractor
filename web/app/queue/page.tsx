import Link from "next/link";
import { getQueue, sentToday } from "@/lib/queries";
import { activeOfferId } from "@/lib/offers";
import OutreachButtons from "@/components/OutreachButtons";
import { TierChip, SiteChip, Evidence } from "@/components/bits";

export const dynamic = "force-dynamic";

const DAILY_CAP = Number(process.env.DAILY_SEND_CAP ?? 40);

export default async function QueuePage() {
  // The queue works one offer at a time — the active one. That is what keeps a
  // second campaign from queueing someone the first already contacted. The
  // buttons need the id too, so it is resolved before the pair below.
  const offerId = await activeOfferId();
  const [rows, today] = await Promise.all([getQueue(DAILY_CAP * 2, offerId), sentToday()]);
  const remaining = Math.max(0, DAILY_CAP - today);

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
              <th className="num">nota</th>
              <th>tier</th>
              <th>gancho</th>
              <th>evidência</th>
              <th>ação</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, remaining).map((r) => (
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
                <td className="num">{r.best_fit ?? "—"}</td>
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
                    <OutreachButtons
                      cnpj={r.cnpj}
                      status={r.status}
                      offerId={offerId}
                      variant="compact"
                    />
                  </div>
                </td>
              </tr>
            ))}
            {(rows.length === 0 || remaining === 0) && (
              <tr>
                <td colSpan={8} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  {remaining === 0
                    ? "Limite diário atingido — a fila volta amanhã."
                    : "Fila vazia. Pontue mais leads para encher a fila."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
