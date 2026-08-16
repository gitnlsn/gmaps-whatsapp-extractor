import type { Stats } from "@/lib/queries";

function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ padding: "6px 14px", borderRight: "1px solid var(--border)", minWidth: 84 }}>
      <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
        {value}
      </div>
      {hint && (
        <div className="muted" style={{ fontSize: 10.5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** Numbers only — deliberately not a chart row. */
export default function StatStrip({ s }: { s: Stats }) {
  const fmt = (n: number) => n.toLocaleString("pt-BR");
  const replyRate = s.sent > 0 ? `${((s.replied / s.sent) * 100).toFixed(1)}%` : "—";

  return (
    <div
      className="panel"
      style={{ display: "flex", flexWrap: "wrap", marginBottom: 12, overflowX: "auto" }}
    >
      <Cell label="leads" value={fmt(s.leads)} />
      <Cell label="contatáveis" value={fmt(s.contactable)} hint="com telefone" />
      <Cell label="celular" value={fmt(s.mobile)} hint="WhatsApp direto" />
      <Cell label="fixo" value={fmt(s.landline)} hint="confirmar WhatsApp" />
      <Cell label="enriquecidos" value={fmt(s.enriched)} />
      <Cell label="pontuados" value={fmt(s.scored)} />
      <Cell label="hot" value={fmt(s.hot)} />
      <Cell label="warm" value={fmt(s.warm)} />
      <Cell label="enviados" value={fmt(s.sent)} hint={`${fmt(s.sent_week)} esta semana`} />
      <Cell label="respostas" value={fmt(s.replied)} hint={replyRate} />
    </div>
  );
}
