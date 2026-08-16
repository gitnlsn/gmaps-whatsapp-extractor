"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startCampaignAction } from "../actions";

/**
 * The entry point for the whole tool: describe a product and who should buy it,
 * and get back a ranked list of companies.
 *
 * Everything after submit runs as one background job — compiling is two calls
 * to a throttled free model, and the ranking scan walks millions of rows — so
 * this only submits and hands over to the awaiting page, which follows the same
 * `pipeline_runs` checklist the cockpit uses.
 */
export default function NewOfferForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await startCampaignAction(formData);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      const target = String(formData.get("slug") ?? "").trim();
      // The job writes the offer; the page polls until it appears.
      router.push(target ? `/offers/${target}?awaiting=1` : "/offers?awaiting=1");
    });
  }

  return (
    <form action={onSubmit} style={{ display: "grid", gap: 10, maxWidth: 760 }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>O que é o produto?</span>
        <span className="muted" style={{ fontSize: 11.5 }}>
          Escreva como explicaria para uma pessoa. Diga para quem é e, se ainda não existe, diga
          isso — a mensagem muda completamente quando o produto ainda está sendo validado.
        </span>
        <textarea
          className="inp"
          name="desc"
          rows={7}
          required
          minLength={40}
          maxLength={4000}
          placeholder={
            "Ex.: App mobile que gera simulados e questões de prática automaticamente para " +
            "alunos, a partir do conteúdo que a escola já usa. Vendido para escolas de ensino " +
            "fundamental e médio e cursos preparatórios. Ainda não construí — quero validar o " +
            "interesse antes."
          }
          style={{ resize: "vertical", lineHeight: 1.45, padding: 8 }}
        />
      </label>

      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          Perfil do cliente ideal{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            (opcional, mas é o que mais aperta a mira)
          </span>
        </span>
        <span className="muted" style={{ fontSize: 11.5 }}>
          Quem você quer atingir: segmento, porte, região, natureza jurídica, e o que o site
          da empresa mostraria. <strong>Faturamento, número de funcionários e ferramentas
          usadas não existem</strong> nos dados abertos — se você citar, a próxima tela vai
          dizer que aquele critério não virou filtro, em vez de fingir que virou.
        </span>
        <textarea
          className="inp"
          name="icp"
          rows={4}
          maxLength={2000}
          placeholder={
            "Ex.: escolas particulares de ensino médio, não-MEI, que já tenham portal do " +
            "aluno no site. De preferência fora das capitais."
          }
          style={{ resize: "vertical", lineHeight: 1.45, padding: 8 }}
        />
      </label>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 240px" }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Nome</span>
          <input className="inp" name="title" maxLength={120} placeholder="App de simulados" />
        </label>
        <label style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Identificador</span>
          <input
            className="inp"
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            pattern="[a-z0-9][a-z0-9-]{1,38}"
            placeholder="simulados-edu"
            required
          />
        </label>
      </div>

      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Finalidade (LGPD)</span>
        <span className="muted" style={{ fontSize: 11.5 }}>
          Obrigatório. Legítimo interesse é específico por finalidade: o motivo declarado de
          contatar estas empresas é a base legal do contato, e cada oferta tem a sua.
        </span>
        <input
          className="inp"
          name="finalidade"
          required
          maxLength={1000}
          placeholder="Identificar instituições de ensino com interesse em… para contato comercial individual e de baixo volume."
        />
      </label>

      {error && (
        <div className="panel" style={{ padding: 8, fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "começando…" : "Compilar e ranquear"}
        </button>
        <span className="muted" style={{ fontSize: 11.5 }}>
          2 chamadas ao modelo, e o resto é SQL. Enriquecer sites e pontuar com LLM ficam
          para depois, com o custo escrito no botão.
        </span>
      </div>
    </form>
  );
}
