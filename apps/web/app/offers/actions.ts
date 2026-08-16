"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql, sqlOne } from "@/lib/db";
import { startJob } from "@/lib/jobs";

/**
 * Offer authoring. Every long-running step delegates to the CLI through the job
 * runner, so the compiling and ranking logic has one implementation and the
 * terminal keeps working exactly as before. These actions only validate,
 * enqueue and read.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

function slugify(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);
}

export type ActionResult = { ok: true; jobId?: number } | { ok: false; reason: string };

/**
 * Compiles a free-text product description into an offer.
 *
 * Runs as a job rather than inline: two calls against a free model that is
 * throttled to ~3.2s between requests can take a minute, which is far too long
 * to hold a request open. JobPanel already streams the log.
 */
export async function compileOfferAction(formData: FormData): Promise<ActionResult> {
  const desc = String(formData.get("desc") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const finalidade = String(formData.get("finalidade") ?? "").trim();
  const rawSlug = String(formData.get("slug") ?? "").trim();

  if (desc.length < 40) {
    return { ok: false, reason: "Descreva o produto com um pouco mais de detalhe (mín. 40 caracteres)." };
  }
  if (!finalidade) {
    // LGPD: legitimate interest is finality-specific (LIA.md §1, §7), so an
    // offer without a declared purpose has no lawful basis to operate under.
    return { ok: false, reason: "A finalidade é obrigatória — é a base legal do contato (LGPD)." };
  }

  const slug = SLUG_RE.test(rawSlug) ? rawSlug : slugify(title || desc.slice(0, 40));
  if (!SLUG_RE.test(slug)) {
    return { ok: false, reason: "Não consegui derivar um identificador — informe um slug." };
  }

  const exists = await sqlOne<{ id: string }>(`SELECT id FROM offers WHERE id = $1`, [slug]);
  if (exists) {
    return { ok: false, reason: `Já existe uma oferta "${slug}". Escolha outro identificador.` };
  }

  const result = await startJob("offer-compile", {
    offer: slug,
    desc,
    title: title || slug,
    finalidade,
  });
  if (!result.ok) return { ok: false, reason: result.reason ?? "não foi possível iniciar" };

  revalidatePath("/offers");
  return { ok: true, jobId: result.jobId };
}

/** Stage 1: rank the reachable set. Free, no LLM. */
export async function buildShortlistAction(offerId: string, limit: number): Promise<ActionResult> {
  const result = await startJob("offer-shortlist", { offer: offerId, limit });
  if (!result.ok) return { ok: false, reason: result.reason ?? "não foi possível iniciar" };
  revalidatePath(`/offers/${offerId}`);
  return { ok: true, jobId: result.jobId };
}

/** Stage 1.5 / Stage 2. Both bounded, both walk the shortlist in rank order. */
export async function runOfferJob(
  kind: "enrich" | "score",
  offerId: string,
  limit: number
): Promise<ActionResult> {
  const result = await startJob(kind, { offer: offerId, limit });
  if (!result.ok) return { ok: false, reason: result.reason ?? "não foi possível iniciar" };
  revalidatePath(`/offers/${offerId}`);
  return { ok: true, jobId: result.jobId };
}

/**
 * Activates one offer.
 *
 * Two statements in a transaction because `offers_one_active_idx` is a unique
 * partial index — setting the new one first would collide with the old. Only
 * one offer may be in flight, which is half of what stops several campaigns
 * from each contacting the same person.
 */
export async function setActiveOffer(offerId: string): Promise<ActionResult> {
  if (!SLUG_RE.test(offerId)) return { ok: false, reason: "slug inválido" };
  const exists = await sqlOne<{ id: string }>(`SELECT id FROM offers WHERE id = $1`, [offerId]);
  if (!exists) return { ok: false, reason: "oferta não encontrada" };

  await sql(`UPDATE offers SET active = FALSE WHERE active AND id <> $1`, [offerId]);
  await sql(`UPDATE offers SET active = TRUE WHERE id = $1`, [offerId]);

  revalidatePath("/offers");
  revalidatePath("/");
  return { ok: true };
}

export async function activateAndGo(offerId: string): Promise<void> {
  await setActiveOffer(offerId);
  redirect(`/offers/${offerId}`);
}
