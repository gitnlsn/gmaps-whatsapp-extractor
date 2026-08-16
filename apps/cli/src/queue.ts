import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { draftMessage, resolveOffer, waMeLink, type Deps } from "@leads/core";
import { dailySendCap, sender } from "./deps";

/**
 * Community-observed ceiling for a warmed number is ~200/day; block/report
 * rate is what actually gets numbers banned, so we stay far below it.
 */

export interface QueueOptions {
  limit: number;
  tier?: string;
  offerId?: string;
}

interface QueueRow {
  cnpj: string;
  nome: string | null;
  razao: string | null;
  municipio: string | null;
  uf: string | null;
  phone: string;
  is_mobile: boolean | null;
  fits: Record<string, number | null> | null;
  best_fit: number | null;
  tier: string | null;
  recommendation: string | null;
  confidence: string | null;
  hook: string | null;
  evidence: { evidence?: string[]; justification?: string } | null;
  website: string | null;
  final_url: string | null;
}

async function sentToday(deps: Deps): Promise<number> {
  const [r] = await deps.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outreach
     WHERE status = 'sent' AND sent_at >= CURRENT_DATE`
  );
  return Number(r?.n ?? 0);
}

export async function reviewQueue(deps: Deps, opts: QueueOptions): Promise<void> {
  const s = sender();
  if (!s.nome) {
    console.log(
      "Note: SENDER_NAME is not set in .env, so drafts cannot introduce you by name.\n" +
        "      Set SENDER_NAME, SENDER_COMPANY and SENDER_CNPJ before real outreach —\n" +
        "      self-identification is part of the LGPD legitimate-interest basis.\n"
    );
  }

  const cap = dailySendCap();
  const already = await sentToday(deps);
  if (already >= cap) {
    console.log(
      `Daily cap reached: ${already}/${cap} sent today. Stop here — volume is what gets numbers banned.`
    );
    return;
  }
  const remaining = Math.min(opts.limit, cap - already);

  const offer = await resolveOffer(deps, opts.offerId);

  const rows = await deps.db.query<QueueRow>(
    `SELECT DISTINCT ON (l.phone_e164)
            l.cnpj, l.nome_fantasia AS nome, l.razao_social AS razao,
            l.municipio_nome AS municipio, l.uf, l.phone_e164 AS phone, l.is_mobile,
            s.fits, s.best_fit, s.tier, s.recommendation, s.confidence, s.hook, s.evidence,
            e.website_url AS website, e.final_url
     FROM leads l
     JOIN scores s ON s.cnpj = l.cnpj AND s.offer_id = $2
     LEFT JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN outreach o ON o.cnpj = l.cnpj
     LEFT JOIN suppression sup ON sup.phone_e164 = l.phone_e164
     WHERE l.phone_e164 IS NOT NULL
       AND o.cnpj IS NULL
       AND sup.phone_e164 IS NULL
       AND s.best_fit IS NOT NULL
       AND s.tier <> 'cold'
       ${opts.tier ? "AND s.tier = $3" : ""}
       -- one human may own several CNPJs; never queue the same number twice
       AND l.phone_e164 NOT IN (
         SELECT l2.phone_e164 FROM outreach o2
         JOIN leads l2 ON l2.cnpj = o2.cnpj
         WHERE l2.phone_e164 IS NOT NULL
       )
     -- DISTINCT ON collapses several CNPJs sharing one number down to the
     -- best-scoring one. One human, one message — the leading ORDER BY keys
     -- must start with phone_e164 for that to be well defined.
     ORDER BY l.phone_e164,
              s.best_fit DESC,
              s.confidence = 'high' DESC,
              -- Mobiles first: a wa.me link on a landline may open a dead chat.
              -- The human reviewing the row sees the canal before deciding.
              l.is_mobile DESC NULLS LAST
     LIMIT $1`,
    opts.tier ? [remaining, offer.id, opts.tier] : [remaining, offer.id]
  );

  if (rows.length === 0) {
    console.log("Queue is empty. Run `npm run score` first, or everything is already handled.");
    return;
  }

  console.log(
    `${rows.length} lead(s) to review. ${already}/${cap} sent today.\n` +
      `Actions: [s]ent  [i]nterest  [k]skip  [n]ot a fit  [o]pt-out  [q]uit\n` +
      `Reminder: SAVE THE CONTACT before messaging — messaging numbers not in\n` +
      `your contacts is the single strongest ban signal.\n`
  );

  const rl = createInterface({ input: stdin, output: stdout });
  let sent = 0;

  try {
    for (const [i, row] of rows.entries()) {
      const evidence = row.evidence?.evidence ?? [];
      const draft = await draftMessage(deps, {
        nome: row.nome ?? row.razao,
        municipio: row.municipio,
        hook: row.hook,
        evidence,
        offer: row.recommendation ?? "none",
        spec: offer.spec,
      }, s);

      console.log("─".repeat(72));
      console.log(
        `[${i + 1}/${rows.length}]  ${row.nome ?? row.razao ?? row.cnpj}  ` +
          `(${row.municipio ?? "?"}/${row.uf ?? "?"})`
      );
      // Axes are named by the offer, so the line is built rather than fixed.
      const fitBits = Object.entries(row.fits ?? {})
        .map(([k, v]) => `${k} ${v ?? "-"}/5`)
        .join("  ");
      console.log(
        `  tier ${row.tier}  ${fitBits}  conf ${row.confidence ?? "-"}  ` +
          `recomendação: ${row.recommendation ?? "-"}`
      );
      if (row.website) console.log(`  site: ${row.final_url ?? row.website}`);
      if (evidence.length) console.log(`  evidência: ${evidence.join(" · ")}`);
      // A landline is a maybe, not a no: institutions register fixed lines and
      // many run WhatsApp Business on them. But the wa.me link may open a chat
      // that does not exist, so the human has to know before clicking.
      if (row.is_mobile) {
        console.log(`\n  ${row.phone}  (celular)   ${waMeLink(row.phone)}`);
      } else {
        console.log(
          `\n  ${row.phone}  (FIXO — confirme se tem WhatsApp antes de salvar o contato)\n` +
            `  ${waMeLink(row.phone)}`
        );
      }
      console.log(`\n  ┌─ rascunho ${"─".repeat(56)}`);
      for (const line of draft.split("\n")) console.log(`  │ ${line}`);
      console.log(`  └${"─".repeat(68)}\n`);

      const answer = (await rl.question("  > ")).trim().toLowerCase();

      if (answer === "q") break;
      if (answer === "k") continue;

      if (answer === "n") {
        await mark(deps, row.cnpj, "not_a_fit", draft, offer.id);
        continue;
      }

      if (answer === "o") {
        await mark(deps, row.cnpj, "opted_out", draft, offer.id);
        await deps.db.withClient((c) =>
          c.query(
            `INSERT INTO suppression (phone_e164, reason) VALUES ($1, 'manual opt-out')
             ON CONFLICT (phone_e164) DO NOTHING`,
            [row.phone]
          )
        );
        console.log("  Suppressed permanently.");
        continue;
      }

      // The whole point of a pre-sale is the answer, not the send. `i` records
      // what the person actually said — which `status` cannot express, because
      // "respondeu" and "pagaria" are different facts about the same contact.
      if (answer === "i") {
        await recordInterest(deps, row.cnpj, offer.id, rl);
        continue;
      }

      if (answer === "s") {
        await mark(deps, row.cnpj, "sent", draft, offer.id);
        sent++;
        if (already + sent >= cap) {
          console.log(`\n  Daily cap of ${cap} reached. Stopping.`);
          break;
        }
        continue;
      }

      console.log("  Unrecognized — skipping.");
    }
  } finally {
    rl.close();
  }

  console.log(`\nMarked ${sent} as sent this session (${already + sent}/${cap} today).`);
}

/** Ordered strongest to weakest — priced_too_high sits high on purpose. */
const INTEREST_LEVELS: [string, string][] = [
  ["1", "committed"],
  ["2", "would_pay"],
  ["3", "wants_demo"],
  ["4", "interested"],
  ["5", "priced_too_high"],
  ["6", "not_now"],
  ["7", "no_interest"],
  ["8", "wrong_person"],
];

/**
 * Captures what a person said back.
 *
 * `status` describes the message; `interest` describes the reply. Collapsing
 * them would lose "respondeu + pagaria", which is the only row that proves
 * demand — and proving demand is the reason this pipeline exists.
 */
async function recordInterest(
  deps: Deps,
  cnpj: string,
  offerId: string,
  rl: { question: (q: string) => Promise<string> }
): Promise<void> {
  console.log(
    "\n  " +
      INTEREST_LEVELS.map(([k, v]) => `[${k}] ${v}`).join("  ") +
      "\n  (enter cancela)"
  );
  const pick = (await rl.question("  interesse > ")).trim();
  const level = INTEREST_LEVELS.find(([k]) => k === pick)?.[1];
  if (!level) {
    console.log("  cancelado.");
    return;
  }

  const nome = (await rl.question("  nome do contato (enter pula) > ")).trim();
  const cargo = (await rl.question("  cargo (enter pula) > ")).trim();
  const teto = (await rl.question("  quanto pagaria por mês? (enter pula) > ")).trim();
  const notas = (await rl.question("  notas (enter pula) > ")).trim();

  const preco = Number(teto.replace(/[^0-9.,]/g, "").replace(",", "."));

  // Inserts rather than updates: the queue only shows leads nobody has
  // contacted yet, so pressing [i] here is "I just spoke to them and they said
  // this" — there is no prior row to update.
  await deps.db.withClient((c) =>
    c.query(
      `INSERT INTO outreach (cnpj, offer_id, phone_e164, status, touches, sent_at,
                             replied_at, interest, interest_at, contact_name,
                             contact_role, price_ceiling, notes)
       SELECT $1, $2, l.phone_e164, 'replied', 1, now(), now(), $3, now(),
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
        offerId,
        level,
        nome,
        cargo,
        Number.isFinite(preco) && preco > 0 ? preco : null,
        notas,
      ]
    )
  );
  console.log(`  registrado: ${level}`);
}

/**
 * Records what the human did. `phone_e164` is copied onto the row so the
 * partial unique index `outreach_one_per_phone_idx` can enforce one contact per
 * person — the guarantee that stops several offers from each messaging the same
 * human. `offer_id` records which campaign this contact belonged to.
 */
async function mark(
  deps: Deps,
  cnpj: string,
  status: string,
  draft: string,
  offerId: string
): Promise<void> {
  await deps.db.withClient((c) =>
    c.query(
      `INSERT INTO outreach (cnpj, status, draft, offer_id, phone_e164,
                             touches, sent_at, followup_at)
       SELECT $1, $2, $3, $4, l.phone_e164,
              CASE WHEN $2 = 'sent' THEN 1 ELSE 0 END,
              CASE WHEN $2 = 'sent' THEN now() END,
              CASE WHEN $2 = 'sent' THEN now() + interval '4 days' END
         FROM leads l WHERE l.cnpj = $1
       ON CONFLICT (cnpj) DO UPDATE SET
         status = EXCLUDED.status,
         draft = EXCLUDED.draft,
         offer_id = COALESCE(outreach.offer_id, EXCLUDED.offer_id),
         phone_e164 = COALESCE(outreach.phone_e164, EXCLUDED.phone_e164),
         touches = outreach.touches + CASE WHEN EXCLUDED.status = 'sent' THEN 1 ELSE 0 END,
         sent_at = COALESCE(EXCLUDED.sent_at, outreach.sent_at),
         followup_at = COALESCE(EXCLUDED.followup_at, outreach.followup_at)`,
      [cnpj, status, draft, offerId]
    )
  );
}
