import {
  getDiscoverFunnel,
  getDiscoverCnaes,
  getDiscoverUfs,
  getMissingCnaes,
  type DiscoverFilters,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length > 0 ? s : undefined;
}

const fmt = (n: number) => n.toLocaleString("pt-BR");

/** Segment shortcuts. Deliberately not "presets for the old offer". */
const SEGMENTS: [string, string][] = [
  ["85", "toda a educação"],
  ["8599605", "cursos preparatórios p/ concursos"],
  ["8513,8520", "fundamental + médio"],
  ["8531,8532,8533", "ensino superior"],
  ["8593", "idiomas"],
  ["8541,8542", "técnico e tecnológico"],
  ["8511,8512", "educação infantil"],
];

function Step({
  label,
  value,
  of,
  hint,
}: {
  label: string;
  value: number;
  of?: number;
  hint?: string;
}) {
  const pct = of && of > 0 ? Math.round((value / of) * 100) : null;
  return (
    <div style={{ padding: "6px 14px", borderRight: "1px solid var(--border)", minWidth: 110 }}>
      <div
        className="muted"
        style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em" }}
      >
        {label}
      </div>
      <div style={{ fontSize: 16, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
        {fmt(value)}
      </div>
      <div className="muted" style={{ fontSize: 10.5 }}>
        {hint ?? (pct !== null ? `${pct}% do segmento` : " ")}
      </div>
    </div>
  );
}

export default async function DiscoverPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;

  const params: Record<string, string | undefined> = {};
  for (const k of ["cnae", "uf", "canal", "natureza", "excludeMei", "minIdade", "maxIdade"]) {
    params[k] = one(sp[k]);
  }

  const filters: DiscoverFilters = {
    cnae: params.cnae,
    uf: params.uf,
    canal: params.canal,
    natureza: params.natureza,
    excludeMei: params.excludeMei === "1",
    minIdade: params.minIdade ? Number(params.minIdade) : undefined,
    maxIdade: params.maxIdade ? Number(params.maxIdade) : undefined,
  };

  const [funnel, cnaes, ufs, missing] = await Promise.all([
    getDiscoverFunnel(filters),
    getDiscoverCnaes(filters),
    getDiscoverUfs(filters),
    getMissingCnaes(params.cnae),
  ]);

  const v = (k: string) => params[k] ?? "";
  const notLoaded = missing.filter((m) => m.cause === "not_loaded");
  const unknown = missing.filter((m) => m.cause === "unknown");

  return (
    <>
      <h1 style={{ fontSize: 16, fontWeight: 650, marginBottom: 4 }}>Descobrir segmento</h1>
      <p className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
        Quantas empresas existem num segmento e quantas dá para contatar de verdade. Tudo em
        SQL — nenhuma chamada de LLM, nenhum custo. Use antes de decidir o que vender.
      </p>

      <div className="panel" style={{ padding: 10, marginBottom: 12 }}>
        <form
          method="GET"
          style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
        >
          <input
            className="inp"
            name="cnae"
            placeholder="CNAE: 85 ou 8513,8599605"
            defaultValue={v("cnae")}
            style={{ width: 220 }}
          />

          <select className="sel" name="uf" defaultValue={v("uf")}>
            <option value="">UF: todas</option>
            {ufs.map((u) => (
              <option key={u.uf} value={u.uf}>
                {u.uf} ({fmt(u.leads)})
              </option>
            ))}
          </select>

          <select className="sel" name="natureza" defaultValue={v("natureza")}>
            <option value="">natureza: qualquer</option>
            <option value="privado">empresa privada (2xxx)</option>
            <option value="sem_fins">sem fins lucrativos (3xxx)</option>
            <option value="publico">administração pública (1xxx)</option>
          </select>

          <select className="sel" name="canal" defaultValue={v("canal")}>
            <option value="">canal: qualquer</option>
            <option value="mobile">celular</option>
            <option value="landline">fixo</option>
          </select>

          <select className="sel" name="excludeMei" defaultValue={v("excludeMei")}>
            <option value="">MEI: tanto faz</option>
            <option value="1">excluir MEI</option>
          </select>

          <select className="sel" name="minIdade" defaultValue={v("minIdade")}>
            <option value="">aberta há: qualquer</option>
            <option value="3">≥ 3 anos</option>
            <option value="5">≥ 5 anos</option>
            <option value="10">≥ 10 anos</option>
          </select>

          <button className="btn" type="submit">
            filtrar
          </button>
        </form>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {SEGMENTS.map(([q, label]) => (
            <a key={q} className="chip chip-plain" href={`/discover?cnae=${q}`}>
              {label}
            </a>
          ))}
        </div>
      </div>

      {unknown.length > 0 && (
        <div className="panel" style={{ padding: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 12 }}>CNAE inexistente</strong>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            {unknown.map((m) => m.prefix).join(", ")} — não existe na tabela oficial de CNAEs.
            Provavelmente um erro de digitação.
          </p>
        </div>
      )}

      {notLoaded.length > 0 && (
        <div className="panel" style={{ padding: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 12 }}>CNAE existe, mas você não carregou esse recorte</strong>
          <ul className="muted" style={{ fontSize: 12, margin: "4px 0 8px 16px" }}>
            {notLoaded.map((m) => (
              <li key={m.prefix}>
                <code>{m.prefix}</code> — {m.descricao ?? "(sem descrição)"}
              </li>
            ))}
          </ul>
          <pre
            style={{
              fontSize: 11.5,
              background: "var(--bg-alt, rgba(127,127,127,0.08))",
              padding: 8,
              borderRadius: 4,
              overflowX: "auto",
            }}
          >
            npm run load -- --cnae {notLoaded.map((m) => m.prefix).join(",")}
          </pre>
        </div>
      )}

      <div
        className="panel"
        style={{ display: "flex", flexWrap: "wrap", marginBottom: 12, overflowX: "auto" }}
      >
        <Step label="no segmento" value={funnel.matched} hint="empresas ativas" />
        <Step label="com telefone" value={funnel.with_phone} of={funnel.matched} />
        <Step label="celular" value={funnel.mobile} of={funnel.with_phone} hint="WhatsApp direto" />
        <Step label="fixo" value={funnel.landline} of={funnel.with_phone} hint="confirmar antes" />
        <Step label="privadas" value={funnel.private_only} of={funnel.matched} hint="natureza 2xxx" />
        <Step label="não MEI" value={funnel.not_mei} of={funnel.matched} />
        <Step label="com nome fantasia" value={funnel.named} of={funnel.matched} hint="dá pra citar" />
        <Step
          label="contatáveis"
          value={funnel.reachable}
          of={funnel.matched}
          hint="nunca contatadas"
        />
      </div>

      {funnel.reachable > 0 && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          A 40 contatos/dia, {fmt(funnel.reachable)} leads dão para{" "}
          <strong>{fmt(Math.ceil(funnel.reachable / 40))} dias</strong> de prospecção. Você não
          precisa de mais volume que isso para validar uma ideia.
        </p>
      )}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">CNAE</th>
              <th>descrição</th>
              <th className="num">empresas</th>
              <th className="num">com telefone</th>
              <th className="num">privadas</th>
              <th className="num">MEI</th>
            </tr>
          </thead>
          <tbody>
            {cnaes.map((c) => (
              <tr key={c.codigo}>
                <td className="sticky-col muted">{c.codigo}</td>
                <td>
                  {c.descricao ?? (
                    <span className="chip chip-plain">código fora da tabela oficial</span>
                  )}
                </td>
                <td className="num">{fmt(c.leads)}</td>
                <td className="num">{fmt(c.reachable)}</td>
                <td className="num">{fmt(c.privados)}</td>
                <td className="num">{fmt(c.mei)}</td>
              </tr>
            ))}
            {cnaes.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  Nenhuma empresa nesse filtro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
