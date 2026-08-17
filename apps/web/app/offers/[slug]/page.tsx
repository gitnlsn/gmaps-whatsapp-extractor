import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getOffer,
  getOfferSpec,
  checkOfferCnaes,
  getCandidates,
  getCandidateSegments,
  getCurrentPipelineRun,
  readyForReview,
} from "@/lib/offers";
import PipelinePanel from "./PipelinePanel";
import AwaitingCampaign from "./AwaitingCampaign";
import IcpCoverage from "./IcpCoverage";

export const dynamic = "force-dynamic";

const fmt = (n: number) => n.toLocaleString("pt-BR");

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function OfferPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: SP;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const page = Number(Array.isArray(sp.page) ? sp.page[0] : (sp.page ?? 1)) || 1;
  const awaiting = Boolean(sp.awaiting);
  const segmento = String(Array.isArray(sp.segmento) ? sp.segmento[0] : (sp.segmento ?? ""));

  const offer = await getOffer(slug);
  if (!offer) {
    // The campaign job may still be running; the row appears the moment its
    // compile step commits, and the awaiting view follows that live.
    if (awaiting) return <AwaitingCampaign slug={slug} />;
    notFound();
  }

  const [specRow, cnaes, candidates, run, awaitingReview, segments] = await Promise.all([
    getOfferSpec(slug),
    checkOfferCnaes(offer.cnaes),
    getCandidates(slug, page, 50, segmento || undefined),
    getCurrentPipelineRun(slug),
    readyForReview(slug),
    getCandidateSegments(slug),
  ]);

  const spec = (specRow?.spec ?? {}) as Record<string, any>;
  const notLoaded = cnaes.filter((c) => c.status === "not_loaded");
  const unknown = cnaes.filter((c) => c.status === "unknown");
  const totalPages = Math.max(1, Math.ceil(candidates.total / 50));

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 16, fontWeight: 650 }}>{offer.title}</h1>
        {offer.active && <span className="chip chip-ok">ativa</span>}
        <span className="chip chip-plain">{offer.stage}</span>
        <Link className="link" href="/offers" style={{ fontSize: 12.5 }}>
          ← ofertas
        </Link>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 10, maxWidth: 820 }}>
        {offer.summary ?? "—"}
      </p>

      <PipelinePanel
        offerId={slug}
        active={offer.active}
        shortlisted={offer.shortlisted}
        enriched={offer.enriched}
        scored={offer.scored}
        awaitingReview={awaitingReview}
        missingCnaes={notLoaded.map((c) => c.prefix)}
        initialRun={run}
      />

      <IcpCoverage icpText={specRow?.icp_text ?? null} coverage={specRow?.icp_coverage ?? null} />

      {unknown.length > 0 && (
        <div className="panel" style={{ padding: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 12 }}>CNAE inexistente — o modelo inventou</strong>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            {unknown.map((c) => c.prefix).join(", ")} não existe na tabela oficial. Esses prefixos
            não encontram ninguém.
          </p>
        </div>
      )}

      {notLoaded.length > 0 && (
        <div className="panel" style={{ padding: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 12 }}>CNAE real, mas você não carregou esse recorte</strong>
          <pre
            style={{
              fontSize: 11.5,
              background: "var(--bg-alt, rgba(127,127,127,0.08))",
              padding: 8,
              borderRadius: 4,
              overflowX: "auto",
              marginTop: 6,
            }}
          >
            npm run load -- --cnae {notLoaded.map((c) => c.prefix).join(",")}
          </pre>
        </div>
      )}

      {/* Targeting, as data rather than prose: this is what actually runs. */}
      <div className="tbl-wrap" style={{ marginBottom: 14 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">CNAE alvo</th>
              <th>descrição</th>
              <th className="num">empresas</th>
              <th className="num">com telefone</th>
              <th>situação</th>
            </tr>
          </thead>
          <tbody>
            {cnaes.map((c) => (
              <tr key={c.prefix}>
                <td className="sticky-col muted">{c.prefix}</td>
                <td>{c.descricao ?? "—"}</td>
                <td className="num">{fmt(c.leads)}</td>
                <td className="num">{fmt(c.reachable)}</td>
                <td>
                  <span
                    className={
                      c.status === "ok"
                        ? "chip chip-ok"
                        : c.status === "not_loaded"
                          ? "chip chip-warm"
                          : "chip chip-plain"
                    }
                  >
                    {c.status === "ok" ? "ok" : c.status === "not_loaded" ? "não carregado" : "inexistente"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details style={{ marginBottom: 14 }}>
        <summary style={{ fontSize: 12.5, cursor: "pointer" }}>
          Rubrica, mensagem e finalidade (o que o modelo vai ler)
        </summary>
        <div className="panel" style={{ padding: 10, marginTop: 6, fontSize: 12 }}>
          <p style={{ marginBottom: 8 }}>
            <strong>Comprador:</strong> {spec.buyer ?? "—"}
            <br />
            <strong>Problema:</strong> {spec.problem ?? "—"}
            <br />
            <strong>Finalidade (LGPD):</strong> {specRow?.finalidade ?? "—"}
          </p>
          {offer.axes.map((a) => (
            <div key={a.key} style={{ marginBottom: 8 }}>
              <strong>
                {a.key} — {a.label}
              </strong>
              <div className="muted">{a.question}</div>
            </div>
          ))}
        </div>
      </details>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 6,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 650 }}>
          Empresas mais prováveis ({fmt(candidates.total)})
        </h2>
        <span className="muted" style={{ fontSize: 11.5, flex: 1 }}>
          ordenadas por nota quando pontuadas, senão pelo ranking determinístico
        </span>
        {/*
          Segment chips. A compiled offer routinely reaches more segments than
          you meant — this one ranked ensino fundamental at 40% and cursinhos,
          the actual target, at 2% — and until you can see the split by segment
          there is nothing on the page that says so.

          Links rather than a <select>: filters live in the URL everywhere else
          in this app, so a filtered view stays linkable and the server does the
          work.
        */}
        {segments.length > 1 && (
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" }}>
            <Link
              className={segmento ? "chip chip-plain" : "chip chip-ok"}
              href={`/offers/${slug}`}
              style={{ textDecoration: "none" }}
            >
              todos {fmt(segments.reduce((n, x) => n + x.n, 0))}
            </Link>
            {segments.map((sg) => (
              <Link
                key={sg.cnae}
                className={segmento === sg.cnae ? "chip chip-ok" : "chip chip-plain"}
                href={`/offers/${slug}?segmento=${sg.cnae}`}
                title={`${sg.cnae} — ${sg.descricao ?? ""}`}
                style={{ textDecoration: "none" }}
              >
                {(sg.descricao ?? sg.cnae).slice(0, 34)} {fmt(sg.n)}
              </Link>
            ))}
          </span>
        )}
        {candidates.total > 0 && (
          <a className="btn" href={`/offers/${slug}/export`} download>
            ↓ baixar CSV
          </a>
        )}
      </div>
      {candidates.total > 0 && (
        <p className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          O CSV traz a lista inteira, na mesma ordem, com telefone e link do WhatsApp. Contém
          dados pessoais — <code>*.csv</code> já está no .gitignore; mantenha assim.
        </p>
      )}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">empresa</th>
              <th>município</th>
              <th>UF</th>
              <th>segmento</th>
              <th>canal</th>
              <th className="num">rank</th>
              {offer.axes.map((a) => (
                <th key={a.key} className="num" title={a.question}>
                  {a.label}
                </th>
              ))}
              <th>gancho</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {candidates.rows.map((r) => (
              <tr key={r.cnpj}>
                <td className="sticky-col" style={{ maxWidth: 230 }}>
                  <Link className="link" href={`/lead/${r.cnpj}`}>
                    {r.nome ?? r.cnpj}
                  </Link>
                </td>
                <td>{r.municipio ?? "—"}</td>
                <td>{r.uf ?? "—"}</td>
                <td className="muted" style={{ fontSize: 11.5, maxWidth: 200 }}>
                  {r.cnae_desc ?? r.cnae ?? "—"}
                </td>
                <td>
                  <span className={r.is_mobile ? "chip chip-ok" : "chip chip-plain"}>
                    {r.is_mobile ? "celular" : "fixo"}
                  </span>
                </td>
                <td className="num muted">{Number(r.rank_score).toFixed(1)}</td>
                {offer.axes.map((a) => (
                  <td key={a.key} className="num">
                    {r.fits?.[a.key] ?? (r.enriched ? "—" : "·")}
                  </td>
                ))}
                <td style={{ maxWidth: 320, fontSize: 11.5 }}>{r.hook ?? "—"}</td>
                <td>{r.status}</td>
              </tr>
            ))}
            {candidates.rows.length === 0 && (
              <tr>
                <td
                  colSpan={8 + offer.axes.length}
                  className="muted"
                  style={{ padding: 24, textAlign: "center" }}
                >
                  Shortlist vazia — clique em “Montar shortlist”. Não custa nada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: "flex", gap: 10, marginTop: 10, fontSize: 12 }}>
          {page > 1 && (
            <Link className="link" href={`/offers/${slug}?page=${page - 1}${segmento ? `&segmento=${segmento}` : ""}`}>
              ← anterior
            </Link>
          )}
          <span className="muted">
            página {page} de {totalPages}
          </span>
          {page < totalPages && (
            <Link className="link" href={`/offers/${slug}?page=${page + 1}${segmento ? `&segmento=${segmento}` : ""}`}>
              próxima →
            </Link>
          )}
        </div>
      )}
    </>
  );
}
