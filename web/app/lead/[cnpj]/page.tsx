import Link from "next/link";
import { notFound } from "next/navigation";
import { getLead } from "@/lib/queries";
import { setStatus } from "@/app/actions";
import { TierChip, SiteChip } from "@/components/bits";

export const dynamic = "force-dynamic";

type Rec = Record<string, unknown>;

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (v instanceof Date) return v.toLocaleDateString("pt-BR");
  return String(v);
}

/** A two-column facts table — deliberately not a card. */
function Facts({ title, rows }: { title: string; rows: [string, unknown][] }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }} className="muted">
        {title}
      </h2>
      <div className="tbl-wrap" style={{ maxHeight: "none" }}>
        <table className="tbl">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="muted" style={{ width: 190 }}>
                  {k}
                </td>
                <td style={{ whiteSpace: "normal" }}>{fmt(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function LeadPage({ params }: { params: Promise<{ cnpj: string }> }) {
  const { cnpj } = await params;
  const lead = await getLead(cnpj);
  if (!lead) notFound();

  const e = (lead.enrichment ?? {}) as Rec;
  const s = (lead.score ?? {}) as Rec;
  const o = (lead.outreach ?? {}) as Rec;
  const evidence = ((s.evidence as Rec)?.evidence ?? []) as string[];
  const justification = (s.evidence as Rec)?.justification as string | undefined;
  const phone = lead.phone_e164 as string | null;

  async function mark(formData: FormData) {
    "use server";
    const status = String(formData.get("status")) as
      | "sent" | "replied" | "not_a_fit" | "opted_out" | "queued";
    await setStatus(cnpj, status);
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <Link className="link" href="/">
          ← todos os leads
        </Link>
      </div>

      <h1 style={{ fontSize: 19, fontWeight: 650, marginBottom: 4 }}>
        {fmt(lead.nome_fantasia ?? lead.razao_social)}
      </h1>
      <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
        CNPJ {fmt(lead.cnpj)} · {fmt(lead.municipio_nome)}/{fmt(lead.uf)} ·{" "}
        <TierChip tier={(s.tier as string) ?? null} />{" "}
        <SiteChip status={String(lead.site_status)} />
      </div>

      {s.hook ? (
        <div className="panel" style={{ padding: 12, marginBottom: 16 }}>
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", marginBottom: 4 }}>
            gancho de abertura
          </div>
          <div style={{ fontSize: 14 }}>{String(s.hook)}</div>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {phone && (
          <a
            className="btn btn-primary"
            href={`https://wa.me/${phone.replace(/\D/g, "")}`}
            target="_blank"
            rel="noreferrer"
          >
            abrir WhatsApp
          </a>
        )}
        <form action={mark} style={{ display: "flex", gap: 6 }}>
          <button className="btn" name="status" value="sent">
            marcar enviado
          </button>
          <button className="btn" name="status" value="replied">
            respondeu
          </button>
          <button className="btn" name="status" value="not_a_fit">
            não serve
          </button>
          <button className="btn" name="status" value="opted_out">
            opt-out
          </button>
        </form>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
        <div>
          <Facts
            title="cadastro (Receita Federal)"
            rows={[
              ["razão social", lead.razao_social],
              ["nome fantasia", lead.nome_fantasia],
              ["CNAE principal", lead.cnae_principal],
              ["natureza jurídica", lead.natureza_juridica],
              ["porte", lead.porte],
              ["capital social", lead.capital_social],
              ["MEI", lead.opcao_mei],
              ["Simples", lead.opcao_simples],
              ["início de atividade", lead.data_inicio_atividade],
              ["situação", lead.situacao],
              ["endereço", `${fmt(lead.logradouro)}, ${fmt(lead.bairro)} — CEP ${fmt(lead.cep)}`],
              ["telefone", lead.phone_e164],
              ["e-mail", lead.email],
            ]}
          />
          <Facts
            title="procedência (LGPD)"
            rows={[
              ["fonte", lead.source],
              ["URL de origem", lead.source_url],
              ["coletado em", lead.collected_at],
              ["place_id do Google", lead.google_place_id],
            ]}
          />
        </div>

        <div>
          <Facts
            title="site (verificação própria)"
            rows={[
              ["URL cadastrada", e.website_url],
              ["URL final", e.final_url],
              ["HTTP", e.http_status],
              ["erro", e.error],
              ["tem site", e.has_website],
              ["fora do ar", e.is_dead],
              ["HTTPS", e.is_https],
              ["é link hub", e.is_link_hub],
              ["construtor grátis", e.is_free_builder],
              ["meta viewport", e.has_viewport],
              ["caminho de contato", e.has_contact_path],
              ["link wa.me", e.has_wa_link],
              ["formulário", e.has_form],
              ["plataforma", e.platform],
              ["gerador", e.generator],
              ["ano no rodapé", e.footer_year],
              ["PageSpeed mobile", e.psi_performance],
              ["Instagram", e.ig_handle],
              ["verificado em", e.checked_at],
            ]}
          />

          <Facts
            title="pontuação"
            rows={[
              // Axis names come from whichever offer graded this lead, so the
              // rows are built from the stored fits rather than fixed columns.
              ...Object.entries((s.fits ?? {}) as Record<string, number | null>),
              ["nota", s.best_fit],
              ["tier", s.tier],
              ["oferta", s.offer_id],
              ["recomendação", s.recommendation],
              ["rubrica", s.prompt_sha],
              ["confiança", s.confidence],
              ["evidência", evidence.join(" · ")],
              ["justificativa", justification],
              ["modelo", s.model],
              ["pontuado em", s.scored_at],
              ["erro", s.error],
            ]}
          />

          <Facts
            title="contato"
            rows={[
              ["status", o.status],
              ["toques", o.touches],
              ["enviado em", o.sent_at],
              ["follow-up em", o.followup_at],
              ["respondeu em", o.replied_at],
              ["rascunho", o.draft],
              ["notas", o.notes],
            ]}
          />
        </div>
      </div>
    </>
  );
}
