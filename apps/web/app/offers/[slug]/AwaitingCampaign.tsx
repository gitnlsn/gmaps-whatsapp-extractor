"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PipelineRun, PipelineStep } from "@/lib/offers";

/**
 * The gap between "submitted" and "there is an offer to look at".
 *
 * This used to be a static block with a manual "recarregar" link, which meant
 * the one moment the tool is doing the most work was the one moment it told you
 * nothing. The run writes its steps to `pipeline_runs`, and `/api/jobs` already
 * carries the current run — so the wait can show the same checklist the cockpit
 * does, and move on by itself when the offer lands.
 */
const MARK: Record<string, string> = {
  pending: "·",
  running: "…",
  done: "✔",
  skipped: "·",
  failed: "✖",
};

export default function AwaitingCampaign({ slug }: { slug: string }) {
  const [run, setRun] = useState<PipelineRun | undefined>();
  const [gaveUp, setGaveUp] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      try {
        const res = await fetch("/api/jobs", { cache: "no-store" });
        const data = (await res.json()) as { pipeline?: PipelineRun };
        const mine = data.pipeline?.offer_id === slug ? data.pipeline : undefined;
        if (mine) setRun(mine);

        // The offer row exists the moment the compile step commits — that, not
        // the end of the run, is when there is a real page to show. The
        // remaining stages keep streaming into the cockpit's own checklist.
        const compiled = mine?.steps?.some((s) => s.key === "compile" && s.status === "done");
        if (compiled || (mine && mine.status !== "running")) router.refresh();
      } catch {
        /* a dropped poll is not worth surfacing */
      }
      // Compiling is two throttled calls plus a ranking scan; past a few minutes
      // something is wrong and a spinner would just be lying.
      if (tries > 160) {
        setGaveUp(true);
        clearInterval(timer);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [slug, router]);

  const steps: PipelineStep[] = run?.steps ?? [];
  const failed = run?.status === "failed";

  return (
    <>
      <h1 style={{ fontSize: 16, fontWeight: 650, marginBottom: 6 }}>
        {failed ? `Falhou ao criar “${slug}”` : `Criando “${slug}”…`}
      </h1>
      <p className="muted" style={{ fontSize: 12, maxWidth: 720 }}>
        {failed
          ? "O run parou. O log completo está no painel acima."
          : "O modelo está traduzindo a sua descrição em um perfil de cliente, conferindo os " +
            "CNAEs contra os dados carregados e montando o ranking. Nada disso gasta além das " +
            "duas chamadas da compilação. Esta página se atualiza sozinha."}
      </p>

      <div className="panel" style={{ padding: 12, marginTop: 12, display: "grid", gap: 6 }}>
        {steps.length === 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            <span className="spinner" /> iniciando…
          </span>
        )}
        {steps.map((s) => (
          <div key={s.key} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
            <span style={{ width: 14, textAlign: "center" }}>{MARK[s.status] ?? "·"}</span>
            <strong style={{ fontSize: 12.5, minWidth: 240 }}>{s.label}</strong>
            <span className="muted" style={{ fontSize: 11.5, flex: 1 }}>
              {s.note ?? (s.status === "running" ? "rodando…" : "")}
            </span>
          </div>
        ))}
      </div>

      {run?.error && (
        <div className="panel" style={{ padding: 10, marginTop: 10, fontSize: 12 }}>
          {run.error}
        </div>
      )}

      {gaveUp && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Isso está demorando mais do que deveria. Confira o log no painel acima —{" "}
          <a className="link" href={`/offers/${slug}?awaiting=1`}>
            ou recarregue
          </a>
          .
        </p>
      )}
    </>
  );
}
