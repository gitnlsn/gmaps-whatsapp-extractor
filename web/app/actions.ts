"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import {
  startJob,
  cancelJob as cancelJobImpl,
  isJobKind,
  type JobOptions,
} from "@/lib/jobs";

type Status = "queued" | "sent" | "replied" | "not_a_fit" | "opted_out";

const ALLOWED: Status[] = ["queued", "sent", "replied", "not_a_fit", "opted_out"];

/**
 * Records an outreach outcome. This is the only write path in the UI, and it
 * deliberately cannot send anything — it only records what the human did.
 */
export async function setStatus(cnpj: string, status: Status, draft?: string) {
  if (!/^\d{14}$/.test(cnpj)) throw new Error("invalid cnpj");
  if (!ALLOWED.includes(status)) throw new Error("invalid status");

  await sql(
    `INSERT INTO outreach (cnpj, status, draft, touches, sent_at, followup_at)
     VALUES ($1, $2, $3,
             CASE WHEN $2 = 'sent' THEN 1 ELSE 0 END,
             CASE WHEN $2 = 'sent' THEN now() END,
             CASE WHEN $2 = 'sent' THEN now() + interval '4 days' END)
     ON CONFLICT (cnpj) DO UPDATE SET
       status = EXCLUDED.status,
       draft = COALESCE(EXCLUDED.draft, outreach.draft),
       touches = outreach.touches
         + CASE WHEN EXCLUDED.status = 'sent' AND outreach.status <> 'sent' THEN 1 ELSE 0 END,
       sent_at = COALESCE(outreach.sent_at, EXCLUDED.sent_at),
       followup_at = COALESCE(EXCLUDED.followup_at, outreach.followup_at),
       replied_at = CASE WHEN EXCLUDED.status = 'replied' THEN now() ELSE outreach.replied_at END`,
    [cnpj, status, draft ?? null]
  );

  // Opting out suppresses the phone forever, across every CNPJ that human owns.
  if (status === "opted_out") {
    await sql(
      `INSERT INTO suppression (phone_e164, reason)
       SELECT phone_e164, 'opt-out via dashboard' FROM leads
       WHERE cnpj = $1 AND phone_e164 IS NOT NULL
       ON CONFLICT (phone_e164) DO NOTHING`,
      [cnpj]
    );
  }

  revalidatePath("/");
  revalidatePath("/queue");
  revalidatePath("/outreach");
  revalidatePath(`/lead/${cnpj}`);
}

export async function bulkSetStatus(cnpjs: string[], status: Status) {
  for (const c of cnpjs) await setStatus(c, status);
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
) {
  if (!/^\d{14}$/.test(cnpj)) throw new Error("invalid cnpj");
  if (!INTEREST_VALUES.includes(interest as Interest)) throw new Error("invalid interest");

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

  revalidatePath("/demand");
  revalidatePath("/queue");
  revalidatePath(`/lead/${cnpj}`);
}
