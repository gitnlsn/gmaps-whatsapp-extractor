import type { IcpCriterion } from "@leads/core/domain";

/**
 * What the written ideal-customer profile actually became.
 *
 * The `✖` rows are the reason this panel exists. The Receita base carries no
 * headcount, no revenue and no tooling, so a profile asking for them produces a
 * filter that silently does not exist — and a shortlist the operator reads as
 * narrower than it is. Saying "this did not become a filter" out loud is worth
 * more than quietly dropping it, which is what happened before.
 */
export default function IcpCoverage({
  icpText,
  coverage,
}: {
  icpText: string | null;
  coverage: IcpCriterion[] | null;
}) {
  if (!coverage?.length) return null;

  const unmapped = coverage.filter((c) => !c.mapped);

  return (
    <details className="panel" style={{ padding: 10, marginBottom: 12 }} open={unmapped.length > 0}>
      <summary style={{ fontSize: 12.5, cursor: "pointer", fontWeight: 600 }}>
        Do seu perfil de cliente ideal
        {unmapped.length > 0 && (
          <span className="chip chip-warm" style={{ marginLeft: 8 }}>
            {unmapped.length} sem filtro
          </span>
        )}
      </summary>

      <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
        {coverage.map((c, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span className={c.mapped ? "chip chip-ok" : "chip chip-plain"} style={{ minWidth: 58, textAlign: "center" }}>
              {c.mapped ? "filtro" : "não deu"}
            </span>
            <span style={{ fontSize: 12.5, minWidth: 260 }}>{c.criterion}</span>
            <span className="muted" style={{ fontSize: 11.5, flex: 1 }}>
              {c.mappedTo}
            </span>
          </div>
        ))}
      </div>

      {unmapped.length > 0 && (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 8, marginBottom: 0 }}>
          Esses critérios <strong>não</strong> restringiram a lista — os dados abertos não têm
          esse campo. A lista abaixo é mais ampla do que o seu perfil pede, e a triagem deles
          é sua, na revisão.
        </p>
      )}

      {icpText && (
        <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          <em>Você escreveu:</em> {icpText}
        </p>
      )}
    </details>
  );
}
