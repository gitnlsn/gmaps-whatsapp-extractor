"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setStatus, clearOutreach, setInterest } from "@/app/actions";

/**
 * Records what the human did with a lead.
 *
 * A client component because the previous Server-Component forms gave no
 * feedback at all: the action ran, the row silently vanished from the queue
 * (getQueue excludes any lead that has an outreach row), and a click was
 * indistinguishable from a page flicker. Every control here reports its outcome
 * and the actions return `{ ok, reason }` rather than throwing.
 */

const INTEREST_OPTS: [string, string][] = [
  ["committed", "fechou"],
  ["would_pay", "pagaria"],
  ["wants_demo", "quer ver"],
  ["interested", "interessado"],
  ["priced_too_high", "achou caro"],
  ["not_now", "agora não"],
  ["no_interest", "sem interesse"],
  ["wrong_person", "pessoa errada"],
];

export interface Props {
  cnpj: string;
  status: string;
  offerId?: string;
  /** `compact` is the queue row; `full` is the lead page. */
  variant?: "compact" | "full";
}

export default function OutreachButtons({ cnpj, status, offerId, variant = "full" }: Props) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Undoing an opt-out lifts the suppression, so it takes a second click.
  const [confirmUndo, setConfirmUndo] = useState(false);
  const router = useRouter();

  const contacted = status !== "novo";

  const run = (fn: () => Promise<{ ok: boolean; reason?: string }>, okText: string) =>
    startTransition(async () => {
      setMsg(null);
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? okText : (r.reason ?? "falhou") });
      if (r.ok) {
        setConfirmUndo(false);
        router.refresh();
      }
    });

  const mark = (s: "sent" | "replied" | "not_a_fit" | "opted_out", label: string) =>
    run(() => setStatus(cnpj, s, undefined, offerId), label);

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="btn"
          disabled={pending}
          title="marcar como enviado"
          onClick={() => mark("sent", "marcado como enviado")}
        >
          {variant === "compact" ? "✓" : "marcar enviado"}
        </button>
        <button
          className="btn"
          disabled={pending}
          title="respondeu"
          onClick={() => mark("replied", "marcado como respondeu")}
        >
          {variant === "compact" ? "↩" : "respondeu"}
        </button>
        <button
          className="btn"
          disabled={pending}
          title="não serve"
          onClick={() => mark("not_a_fit", "marcado como não serve")}
        >
          {variant === "compact" ? "✕" : "não serve"}
        </button>
        <button
          className="btn"
          disabled={pending}
          title="opt-out: suprime o telefone"
          onClick={() => mark("opted_out", "opt-out registrado e telefone suprimido")}
        >
          {variant === "compact" ? "⊘" : "opt-out"}
        </button>

        {/* Only offered once there is something to undo. */}
        {contacted && (
          <button
            className="btn"
            disabled={pending}
            title="voltar para novo e devolver à fila"
            onClick={() => run(() => clearOutreach(cnpj, confirmUndo), "voltou para novo")}
            style={confirmUndo ? { fontWeight: 700 } : undefined}
          >
            {confirmUndo ? "confirmar desfazer" : "↺ desfazer"}
          </button>
        )}
      </div>

      {/* status is what happened to the message; interest is what they said. */}
      {contacted && (
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 11 }}>
            resposta:
          </span>
          <select
            className="sel"
            disabled={pending}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              run(() => setInterest(cnpj, v, { offerId }), "interesse registrado");
            }}
          >
            <option value="">registrar…</option>
            {INTEREST_OPTS.map(([val, label]) => (
              <option key={val} value={val}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}

      {msg && (
        <div
          className={msg.ok ? "muted" : undefined}
          style={{ fontSize: 11.5, maxWidth: 320, whiteSpace: "normal" }}
        >
          {msg.text}
          {!msg.ok && !confirmUndo && status === "opted_out" && (
            <>
              {" "}
              <button
                className="btn"
                style={{ padding: "0 6px" }}
                onClick={() => setConfirmUndo(true)}
              >
                entendi, desfazer mesmo assim
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
