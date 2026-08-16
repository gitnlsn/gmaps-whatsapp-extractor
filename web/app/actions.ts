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
