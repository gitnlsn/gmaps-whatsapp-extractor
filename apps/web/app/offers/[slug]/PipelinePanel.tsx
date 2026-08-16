"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  buildShortlistAction,
  runOfferJob,
  runPipelineAction,
  setActiveOffer,
} from "../actions";
import type { PipelineRun, PipelineStep, StepStatus } from "@/lib/offers";

/**
 * The campaign, as one place.
 *
 * Every action here is labelled with what it actually costs, because the
 * difference is the whole shape of this tool: ranking is free and unlimited,
 * Places bills in dollars past a 1,000/month allowance, scoring is throttled on
 * a small daily quota. A button that hides that is how a quota disappears by
 * accident — so "Rodar pipeline" says what it will spend before you press it.
 *
 * The last card is deliberately not a button. Nothing here contacts anybody.
 */

interface StageView {
  key: string;
  label: string;
  cost: React.ReactNode;
  count?: number;
  done: boolean;
  blocked?: string;
  /** Runs just this stage. Absent for stages with no standalone action. */
  solo?: () => Promise<{ ok: boolean; reason?: string }>;
}

const CHIP: Record<StepStatus, string> = {
  pending: "chip chip-plain",
  running: "chip chip-warm",
  done: "chip chip-ok",
  skipped: "chip chip-plain",
  failed: "chip chip-hot",
};

const CHIP_LABEL: Record<StepStatus, string> = {
  pending: "pendente",
  running: "rodando",
  done: "ok",
  skipped: "pulado",
  failed: "falhou",
};

export default function PipelinePanel({
  offerId,
  active,
  shortlisted,
  enriched,
  scored,
  awaitingReview,
  missingCnaes,
  initialRun,
}: {
  offerId: string;
  active: boolean;
  shortlisted: number;
  enriched: number;
  scored: number;
  awaitingReview: number;
  missingCnaes: string[];
  initialRun?: PipelineRun;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [run, setRun] = useState<PipelineRun | undefined>(initialRun);

  const [places, setPlaces] = useState(0);
  const [enrichN, setEnrichN] = useState(500);
  const [scoreN, setScoreN] = useState(200);
  const [withLoad, setWithLoad] = useState(false);

  const router = useRouter();
  const running = run?.status === "running";

  // Poll only while something is running, same as JobPanel. A dashboard that
  // polls when nothing is happening is just load.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs`, { cache: "no-store" });
        const data = (await res.json()) as { pipeline?: PipelineRun };
        if (data.pipeline && data.pipeline.offer_id === offerId) setRun(data.pipeline);
        if (data.pipeline && data.pipeline.status !== "running") router.refresh();
      } catch {
        /* a dropped poll is not worth surfacing */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [running, offerId, router]);

  const call = (fn: () => Promise<{ ok: boolean; reason?: string }>) =>
    startTransition(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r.ok ? "iniciado — acompanhe abaixo" : (r.reason ?? "falhou"));
      router.refresh();
    });

  const stepFor = (key: string): PipelineStep | undefined =>
    run?.steps?.find((s) => s.key === key);

  /**
   * `done`/`pending` come from real counters, `running`/`skipped`/`failed` from
   * the run in flight. A shortlist built last week is done whether or not any
   * recorded run knows about it.
   */
  const statusOf = (stage: StageView): StepStatus => {
    const s = stepFor(stage.key);
    if (s && (s.status === "running" || s.status === "failed" || s.status === "skipped")) {
      return s.status;
    }
    return stage.done ? "done" : (s?.status ?? "pending");
  };

  const requests = Math.ceil(scoreN / 10);

  const stages: StageView[] = [
    {
      key: "load",
      label: "Dados da Receita",
      cost: missingCnaes.length ? (
        <>
          <strong>vários GB · ~30 min</strong> · CNAE {missingCnaes.join(", ")} ainda não carregado
        </>
      ) : (
        "todos os CNAEs da oferta já estão carregados"
      ),
      done: missingCnaes.length === 0,
    },
    {
      key: "shortlist",
      label: "Shortlist",
      cost: "grátis · SQL · ranqueia até 5.000",
      count: shortlisted,
      done: shortlisted > 0,
      solo: () => buildShortlistAction(offerId, 5000),
    },
    {
      key: "places",
      label: "Sites via Google Places",
      cost: (
        <>
          <strong>cota paga</strong> · 1.000 detalhes/mês grátis · nunca passa do grátis ·
          descobre o site que a Receita não tem
        </>
      ),
      done: false,
    },
    {
      key: "enrich",
      label: "Enriquecimento",
      cost: "grátis · visita o site de cada lead e roda as palavras-chave da oferta",
      count: enriched,
      done: enriched > 0,
      blocked: shortlisted === 0 ? "precisa da shortlist primeiro" : undefined,
      solo: () => runOfferJob("enrich", offerId, 500),
    },
    {
      key: "reshortlist",
      label: "Reordenar com os sinais novos",
      cost: "grátis · o ranking usa sinais do site, então vale reordenar depois do enrich",
      done: false,
    },
    {
      key: "score",
      label: "Pontuação",
      cost: (
        <>
          <strong>gasta LLM</strong> · ~{requests} requisições · ~
          {Math.ceil((requests * 3.2) / 60)} min · cota grátis do OpenRouter costuma ser 50/dia
        </>
      ),
      count: scored,
      done: scored > 0,
      blocked: enriched === 0 ? "enriqueça primeiro" : undefined,
      solo: () => runOfferJob("score", offerId, scoreN),
    },
    {
      key: "rollups",
      label: "Totais do painel",
      cost: "grátis",
      done: false,
    },
  ];

  return (
    <div className="panel" style={{ padding: 12, marginBottom: 12, display: "grid", gap: 12 }}>
      {/* ------------------------------------------------------- run control */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {!active && (
          <button className="btn" disabled={pending} onClick={() => call(() => setActiveOffer(offerId))}>
            Tornar ativa
          </button>
        )}

        <button
          className="btn btn-primary"
          disabled={pending || running}
          onClick={() =>
            call(() =>
              runPipelineAction(offerId, {
                places,
                enrich: enrichN,
                score: scoreN,
                withLoad,
              })
            )
          }
        >
          {running ? "Rodando…" : "Rodar pipeline"}
        </button>

        <label style={{ fontSize: 11.5 }}>
          Places{" "}
          <select className="sel" value={places} onChange={(e) => setPlaces(Number(e.target.value))}>
            {[0, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "não usar" : n}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 11.5 }}>
          Enrich{" "}
          <select className="sel" value={enrichN} onChange={(e) => setEnrichN(Number(e.target.value))}>
            {[100, 250, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 11.5 }}>
          Score{" "}
          <select className="sel" value={scoreN} onChange={(e) => setScoreN(Number(e.target.value))}>
            {[0, 50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "não pontuar" : n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {missingCnaes.length > 0 && (
        <label
          style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "flex-start" }}
          className="muted"
        >
          <input
            type="checkbox"
            checked={withLoad}
            onChange={(e) => setWithLoad(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            Baixar também os CNAEs que faltam ({missingCnaes.join(", ")}).{" "}
            <strong>Vários GB e cerca de 30 minutos.</strong> O processo é do servidor, então
            você pode fechar a aba — mas reiniciar o <code>next dev</code> mata o job.
          </span>
        </label>
      )}

      {/* --------------------------------------------------------- checklist */}
      <div style={{ display: "grid", gap: 6 }}>
        {stages.map((stage) => {
          const status = statusOf(stage);
          const note = stepFor(stage.key)?.note;
          return (
            <div
              key={stage.key}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "baseline",
                flexWrap: "wrap",
                opacity: status === "skipped" ? 0.55 : 1,
              }}
            >
              <span className={CHIP[status]} style={{ minWidth: 62, textAlign: "center" }}>
                {CHIP_LABEL[status]}
              </span>
              <strong style={{ fontSize: 12.5, minWidth: 190 }}>{stage.label}</strong>
              {stage.count !== undefined && (
                <span className="num muted" style={{ fontSize: 12 }}>
                  {stage.count.toLocaleString("pt-BR")}
                </span>
              )}
              <span className="muted" style={{ fontSize: 11.5, flex: 1, minWidth: 220 }}>
                {note ?? stage.cost}
                {stage.blocked && ` · ${stage.blocked}`}
              </span>
              {stage.solo && (
                <button
                  className="btn"
                  disabled={pending || running || Boolean(stage.blocked)}
                  onClick={() => call(stage.solo!)}
                  style={{ fontSize: 11.5 }}
                >
                  só este
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ------------------------------------------------------ review gate */}
      <div
        className="panel"
        style={{ padding: 10, display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}
      >
        <span className="chip chip-plain">manual</span>
        <strong style={{ fontSize: 12.5 }}>Revisão</strong>
        <span className="num" style={{ fontSize: 12.5 }}>
          {awaitingReview.toLocaleString("pt-BR")}
        </span>
        <span className="muted" style={{ fontSize: 11.5, flex: 1 }}>
          lead(s) pontuados esperando você conferir o contato. O pipeline nunca envia nada.
        </span>
        <Link className="link" href="/queue" style={{ fontSize: 12 }}>
          abrir a fila →
        </Link>
      </div>

      {run?.error && (
        <div className="muted" style={{ fontSize: 11.5, color: "var(--hot)" }}>
          {run.error}
        </div>
      )}
      {msg && (
        <div className="muted" style={{ fontSize: 12 }}>
          {msg}
        </div>
      )}
    </div>
  );
}
