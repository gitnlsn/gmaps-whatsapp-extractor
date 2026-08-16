"use server";

import { revalidatePath } from "next/cache";
import { sql, sqlOne } from "@/lib/db";
import {
  startJob,
  cancelJob as cancelJobImpl,
  isJobKind,
  type JobOptions,
} from "@/lib/jobs";

type Status = "queued" | "sent" | "replied" | "not_a_fit" | "opted_out";

const ALLOWED: Status[] = ["queued", "sent", "replied", "not_a_fit", "opted_out"];

/** Actions report failure instead of throwing — see startPipelineJob below. */
export type Result = { ok: true } | { ok: false; reason: string };

function revalidateOutreach(cnpj: string): void {
  revalidatePath("/");
  revalidatePath("/queue");
  revalidatePath("/outreach");
  revalidatePath("/demand");
  revalidatePath(`/lead/${cnpj}`);
}

/**
 * Records an outreach outcome. Still cannot send anything — it only records
 * what the human did.
 *
 * `offer_id` and `phone_e164` are not decoration. Migration 006 made outreach
 * offer-aware and added a UNIQUE partial index on `phone_e164`, and this
 * function predated both: every row the dashboard wrote came out with them
 * NULL, which meant the row was invisible to /demand (it filters
 * `offer_id IS NOT NULL`) and skipped entirely by the partial index — so the
 * "one human, one contact record" guarantee in LIA.md §5 did not apply to
 * anything clicked in the browser. The CLI's mark() in src/queue.ts always
 * wrote both; this now matches it, and selecting FROM leads is what lets the
 * phone come from the lead row.
 */
export async function setStatus(
  cnpj: string,
  status: Status,
  draft?: string,
  offerId?: string
): Promise<Result> {
  if (!/^\d{14}$/.test(cnpj)) return { ok: false, reason: "CNPJ inválido" };
  if (!ALLOWED.includes(status)) return { ok: false, reason: "status inválido" };

  try {
    await sql(
      `INSERT INTO outreach (cnpj, offer_id, phone_e164, status, draft,
                             touches, sent_at, followup_at)
       SELECT $1,
              COALESCE($4, (SELECT id FROM offers WHERE active LIMIT 1)),
              l.phone_e164, $2, $3,
              CASE WHEN $2 = 'sent' THEN 1 ELSE 0 END,
              CASE WHEN $2 = 'sent' THEN now() END,
              CASE WHEN $2 = 'sent' THEN now() + interval '4 days' END
         FROM leads l WHERE l.cnpj = $1
       ON CONFLICT (cnpj) DO UPDATE SET
         status = EXCLUDED.status,
         draft = COALESCE(EXCLUDED.draft, outreach.draft),
         offer_id = COALESCE(outreach.offer_id, EXCLUDED.offer_id),
         phone_e164 = COALESCE(outreach.phone_e164, EXCLUDED.phone_e164),
         touches = outreach.touches
           + CASE WHEN EXCLUDED.status = 'sent' AND outreach.status <> 'sent' THEN 1 ELSE 0 END,
         sent_at = COALESCE(outreach.sent_at, EXCLUDED.sent_at),
         followup_at = COALESCE(EXCLUDED.followup_at, outreach.followup_at),
         replied_at = CASE WHEN EXCLUDED.status = 'replied' THEN now() ELSE outreach.replied_at END`,
      [cnpj, status, draft ?? null, offerId ?? null]
    );

    // Opting out suppresses the phone across every CNPJ that human owns. It can
    // now be lifted (see clearOutreach), so the change is logged either way.
    if (status === "opted_out") {
      await sql(
        `WITH ins AS (
           INSERT INTO suppression (phone_e164, reason)
           SELECT phone_e164, 'opt-out via painel' FROM leads
            WHERE cnpj = $1 AND phone_e164 IS NOT NULL
           ON CONFLICT (phone_e164) DO NOTHING
           RETURNING phone_e164
         )
         INSERT INTO suppression_log (phone_e164, action, reason)
         SELECT phone_e164, 'added', 'opt-out via painel' FROM ins`,
        [cnpj]
      );
    }
  } catch (err) {
    // 23505 here means the same human already has a contact record under
    // another CNPJ — which is the guarantee working, not a crash.
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      return {
        ok: false,
        reason: "Esse telefone já tem um registro de contato (uma pessoa, um contato).",
      };
    }
    return { ok: false, reason: (err as Error).message };
  }

  revalidateOutreach(cnpj);
  return { ok: true };
}

/**
 * Undoes a contact record: the lead goes back to "novo" and reappears in the
 * queue.
 *
 * Deletion is the only thing that actually restores "novo". The UI reads
 * `COALESCE(o.status,'novo')` and getQueue excludes on `o.cnpj IS NULL`, so
 * setting status='queued' would leave the lead labelled differently and still
 * invisible.
 *
 * For an opted-out lead this also lifts the suppression, which is a deliberate
 * choice by the operator rather than a default: an opt-out clicked on the wrong
 * row would otherwise kill a good lead permanently. It is never silent —
 * `suppression_log` keeps the before and after — and the UI requires a separate
 * confirmation, which is why `confirmOptOut` exists.
 */
export async function clearOutreach(cnpj: string, confirmOptOut = false): Promise<Result> {
  if (!/^\d{14}$/.test(cnpj)) return { ok: false, reason: "CNPJ inválido" };

  const row = await sqlOne<{ status: string; phone_e164: string | null }>(
    `SELECT o.status, COALESCE(o.phone_e164, l.phone_e164) AS phone_e164
       FROM outreach o JOIN leads l ON l.cnpj = o.cnpj
      WHERE o.cnpj = $1`,
    [cnpj]
  );
  if (!row) return { ok: false, reason: "esse lead já está como novo" };

  if (row.status === "opted_out" && !confirmOptOut) {
    return {
      ok: false,
      reason:
        "Este lead pediu para não ser contatado. Desfazer remove a supressão e " +
        "permite contatá-lo de novo — confirme se foi um clique errado.",
    };
  }

  try {
    if (row.status === "opted_out" && row.phone_e164) {
      await sql(
        `INSERT INTO suppression_log (phone_e164, action, reason)
         VALUES ($1, 'removed', 'desfeito manualmente no painel')`,
        [row.phone_e164]
      );
      await sql(`DELETE FROM suppression WHERE phone_e164 = $1`, [row.phone_e164]);
    }
    await sql(`DELETE FROM outreach WHERE cnpj = $1`, [cnpj]);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  revalidateOutreach(cnpj);
  return { ok: true };
}

// ----------------------------------------------------------------- pipeline

/**
 * Starts a pipeline step by shelling out to the CLI. Returns a result object
 * rather than throwing, because "a job is already running" is an expected
 * outcome the UI has to show, not an error.
 */
export async function startPipelineJob(kind: string, opts: JobOptions) {
  if (!isJobKind(kind)) return { ok: false as const, reason: "comando não permitido" };

  const result = await startJob(kind, opts);

  // The job runs in the background; the tables it affects are refreshed by the
  // client once it finishes. Revalidating here just clears the stale render.
  if (result.ok) revalidatePath("/");
  return result;
}

export async function cancelPipelineJob(id: number) {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false as const, reason: "id inválido" };
  }
  return cancelJobImpl(id);
}

// ------------------------------------------------------------------ interest

const INTEREST_VALUES = [
  "committed",
  "would_pay",
  "wants_demo",
  "interested",
  "priced_too_high",
  "not_now",
  "no_interest",
  "wrong_person",
] as const;

type Interest = (typeof INTEREST_VALUES)[number];

/**
 * Records what a person said back.
 *
 * Orthogonal to setStatus on purpose: `status` is what happened to the message,
 * `interest` is the reply. A pre-sale is judged on "replied + would_pay", which
 * a single enum cannot express.
 *
 * Inserts rather than updates, because the reply often arrives from a lead that
 * was never formally marked sent — a phone call, a walk-in, a forwarded e-mail.
 */
export async function setInterest(
  cnpj: string,
  interest: string,
  extra: {
    contactName?: string;
    contactRole?: string;
    priceCeiling?: number | null;
    notes?: string;
    offerId?: string;
  } = {}
): Promise<Result> {
  if (!/^\d{14}$/.test(cnpj)) return { ok: false, reason: "CNPJ inválido" };
  if (!INTEREST_VALUES.includes(interest as Interest)) {
    return { ok: false, reason: "nível de interesse inválido" };
  }

  try {
    await sql(
    `INSERT INTO outreach (cnpj, offer_id, phone_e164, status, touches, sent_at,
                           replied_at, interest, interest_at, contact_name,
                           contact_role, price_ceiling, notes)
     SELECT $1,
            COALESCE($2, (SELECT id FROM offers WHERE active LIMIT 1)),
            l.phone_e164, 'replied', 1, now(), now(), $3, now(),
            NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, '')
       FROM leads l WHERE l.cnpj = $1
     ON CONFLICT (cnpj) DO UPDATE SET
       interest = EXCLUDED.interest,
       interest_at = now(),
       contact_name = COALESCE(EXCLUDED.contact_name, outreach.contact_name),
       contact_role = COALESCE(EXCLUDED.contact_role, outreach.contact_role),
       price_ceiling = COALESCE(EXCLUDED.price_ceiling, outreach.price_ceiling),
       notes = COALESCE(EXCLUDED.notes, outreach.notes),
       status = 'replied',
       replied_at = COALESCE(outreach.replied_at, now())`,
    [
      cnpj,
      extra.offerId ?? null,
      interest,
      extra.contactName ?? "",
      extra.contactRole ?? "",
      extra.priceCeiling ?? null,
      extra.notes ?? "",
    ]
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return {
        ok: false,
        reason: "Esse telefone já tem um registro de contato (uma pessoa, um contato).",
      };
    }
    return { ok: false, reason: (err as Error).message };
  }

  revalidateOutreach(cnpj);
  return { ok: true };
}
