"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startPipelineJob, cancelPipelineJob } from "@/app/actions";

/**
 * The only client component in the app.
 *
 * Everything else is a Server Component with GET forms; this needs state
 * because a pipeline run takes minutes and the request cannot be held open
 * for it. It polls only while a job is running — never when idle.
 */

interface JobSummary {
  id: number;
  kind: string;
  args: string[];
  status: "running" | "done" | "failed" | "cancelled";
  exit_code: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface CurrentJob extends JobSummary {
  log: string;
}

interface Quota {
  detailsUsed: number;
  detailsFree: number;
  detailsLeft: number;
}

interface Payload {
  current: CurrentJob | null;
  recent: JobSummary[];
  quota: Quota;
}

const STEPS = [
  { kind: "enrich", label: "Enriquecer sites", defaultLimit: 500 },
  { kind: "score", label: "Pontuar leads", defaultLimit: 200 },
  { kind: "places", label: "Buscar no Google", defaultLimit: 25 },
] as const;

const STATUS_CHIP: Record<string, string> = {
  running: "chip chip-warm",
  done: "chip chip-ok",
  failed: "chip chip-hot",
  cancelled: "chip chip-plain",
};

function elapsed(from: string, to: string | null): string {
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  const s = Math.max(0, Math.floor((end - start) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function JobPanel({ initialQuotaLeft }: { initialQuotaLeft?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [data, setData] = useState<Payload | null>(null);
  const [limits, setLimits] = useState<Record<string, number>>(() =>
    Object.fromEntries(STEPS.map((s) => [s.kind, s.defaultLimit]))
  );
  const [message, setMessage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [, forceTick] = useState(0);

  const logRef = useRef<HTMLPreElement>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      /* transient fetch failure — the next tick retries */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = data?.current?.status === "running";

  // Poll only while something is running.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void load(), 1500);
    return () => clearInterval(id);
  }, [running, load]);

  // Keeps the elapsed timer moving between polls.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // The whole point of the feature: when a run finishes, re-render the tables
  // so the new rows appear without a manual reload. Fires exactly once.
  useEffect(() => {
    if (wasRunning.current && !running) router.refresh();
    wasRunning.current = running;
  }, [running, router]);

  // Pin the log to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data?.current?.log]);

  function run(kind: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await startPipelineJob(kind, { limit: limits[kind] });
      if (!result.ok) setMessage(result.reason ?? "não foi possível iniciar");
      await load();
    });
  }

  function cancel(id: number) {
    startTransition(async () => {
      await cancelPipelineJob(id);
      await load();
    });
  }

  // Falls back to the server-rendered value until the first poll lands.
  const quotaLeft = data?.quota.detailsLeft ?? initialQuotaLeft ?? null;
  const current = data?.current ?? null;
  const busy = running || pending;

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
        padding: "6px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {STEPS.map((step) => {
          const outOfQuota = step.kind === "places" && quotaLeft === 0;
          return (
            <span key={step.kind} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <button
                className="btn"
                disabled={busy || outOfQuota}
                onClick={() => run(step.kind)}
                title={
                  outOfQuota
                    ? "cota grátis do mês esgotada"
                    : `roda: leads ${step.kind} --limit ${limits[step.kind]}`
                }
              >
                {step.label}
                {step.kind === "places" && quotaLeft !== null && (
                  <span className="muted" style={{ marginLeft: 5, fontSize: 11 }}>
                    · {quotaLeft.toLocaleString("pt-BR")} restantes
                  </span>
                )}
              </button>
              <input
                className="inp"
                type="number"
                min={1}
                value={limits[step.kind]}
                disabled={busy}
                onChange={(e) =>
                  setLimits((l) => ({ ...l, [step.kind]: Number(e.target.value) }))
                }
                style={{ width: 62 }}
                aria-label={`limite para ${step.label}`}
              />
            </span>
          );
        })}

        <span style={{ flex: 1 }} />

        {message && (
          <span className="chip chip-hot" role="status">
            {message}
          </span>
        )}

        <button
          className="btn"
          onClick={() => setShowHistory((v) => !v)}
          style={{ fontSize: 11.5 }}
        >
          histórico {showHistory ? "▴" : "▾"}
        </button>
      </div>

      {current && (running || showHistory) && (
        <div style={{ marginTop: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11.5,
              marginBottom: 4,
            }}
          >
            <span className={STATUS_CHIP[current.status] ?? "chip chip-plain"}>
              {current.status}
            </span>
            <code className="muted">leads {current.args.join(" ")}</code>
            <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
              {elapsed(current.started_at, current.finished_at)}
            </span>
            {current.error && <span style={{ color: "var(--hot)" }}>{current.error}</span>}
            <span style={{ flex: 1 }} />
            {running && (
              <button className="btn" onClick={() => cancel(current.id)} title="cancelar">
                cancelar
              </button>
            )}
          </div>
          {current.log && (
            <pre ref={logRef} className="joblog">
              {current.log}
            </pre>
          )}
        </div>
      )}

      {showHistory && data && data.recent.length > 0 && (
        <div className="tbl-wrap" style={{ marginTop: 6, maxHeight: 220 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>quando</th>
                <th>comando</th>
                <th>status</th>
                <th className="num">duração</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((j) => (
                <tr key={j.id}>
                  <td className="muted">
                    {new Date(j.started_at).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td>
                    <code>{j.args.join(" ")}</code>
                  </td>
                  <td>
                    <span className={STATUS_CHIP[j.status] ?? "chip chip-plain"}>
                      {j.status}
                    </span>
                    {j.error && (
                      <span className="muted" style={{ marginLeft: 6 }}>
                        {j.error.slice(0, 60)}
                      </span>
                    )}
                  </td>
                  <td className="num">{elapsed(j.started_at, j.finished_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
