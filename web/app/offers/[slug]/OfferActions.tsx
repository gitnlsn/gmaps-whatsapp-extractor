"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buildShortlistAction, runOfferJob, setActiveOffer } from "../actions";

/**
 * The buttons that spend something, and the ones that do not.
 *
 * Every action here is labelled with its real cost, because the difference is
 * the whole shape of this tool: ranking is free and unlimited, scoring is
 * throttled and quota-limited. A button that hides that is how a daily quota
 * disappears by accident.
 */
export default function OfferActions({
  offerId,
  active,
  shortlisted,
  enriched,
}: {
  offerId: string;
  active: boolean;
  shortlisted: number;
  enriched: number;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [scoreLimit, setScoreLimit] = useState(200);
  const router = useRouter();

  const call = (fn: () => Promise<{ ok: boolean; reason?: string }>) =>
    startTransition(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r.ok ? "iniciado — acompanhe no painel acima" : (r.reason ?? "falhou"));
      router.refresh();
    });

  const requests = Math.ceil(scoreLimit / 10);

  return (
    <div className="panel" style={{ padding: 10, marginBottom: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!active && (
          <button
            className="btn"
            disabled={pending}
            onClick={() => call(() => setActiveOffer(offerId))}
          >
            Tornar ativa
          </button>
        )}

        <button
          className="btn"
          disabled={pending}
          onClick={() => call(() => buildShortlistAction(offerId, 5000))}
        >
          {shortlisted ? "Refazer shortlist" : "Montar shortlist"}
        </button>
        <span className="muted" style={{ fontSize: 11.5 }}>
          grátis · SQL · ranqueia até 5.000
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="btn"
          disabled={pending || shortlisted === 0}
          onClick={() => call(() => runOfferJob("enrich", offerId, 500))}
        >
          Enriquecer 500
        </button>
        <span className="muted" style={{ fontSize: 11.5 }}>
          grátis · visita o site de cada lead e roda as palavras-chave da oferta
          {shortlisted === 0 && " · precisa da shortlist primeiro"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="btn"
          disabled={pending || enriched === 0}
          onClick={() => call(() => runOfferJob("score", offerId, scoreLimit))}
        >
          Pontuar {scoreLimit}
        </button>
        <select
          className="sel"
          value={scoreLimit}
          onChange={(e) => setScoreLimit(Number(e.target.value))}
        >
          {[50, 100, 200, 500].map((n) => (
            <option key={n} value={n}>
              {n} leads
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 11.5 }}>
          <strong>gasta LLM</strong> · ~{requests} requisições · ~{Math.ceil((requests * 3.2) / 60)}{" "}
          min · cota grátis do OpenRouter costuma ser 50/dia
          {enriched === 0 && " · enriqueça primeiro"}
        </span>
      </div>

      {msg && (
        <div className="muted" style={{ fontSize: 12 }}>
          {msg}
        </div>
      )}
    </div>
  );
}
