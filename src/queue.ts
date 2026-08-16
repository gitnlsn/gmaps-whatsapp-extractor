import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { query, withClient } from "./db";
import { draftMessage, waMeLink, sender } from "./draft";

/**
 * Community-observed ceiling for a warmed number is ~200/day; block/report
 * rate is what actually gets numbers banned, so we stay far below it.
 */
const DEFAULT_DAILY_CAP = 40;

export interface QueueOptions {
  limit: number;
  tier?: string;
}

interface QueueRow {
  cnpj: string;
  nome: string | null;
  razao: string | null;
  municipio: string | null;
  uf: string | null;
  phone: string;
  is_mobile: boolean | null;
  web_fit: number | null;
  chatbot_fit: number | null;
  tier: string | null;
  offer: string | null;
  confidence: string | null;
  hook: string | null;
  evidence: { evidence?: string[]; justification?: string } | null;
  website: string | null;
  final_url: string | null;
}

async function sentToday(): Promise<number> {
  const [r] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outreach
     WHERE status = 'sent' AND sent_at >= CURRENT_DATE`
  );
  return Number(r?.n ?? 0);
}

export async function reviewQueue(opts: QueueOptions): Promise<void> {
  const s = sender();
  if (!s.nome) {
    console.log(
      "Note: SENDER_NAME is not set in .env, so drafts cannot introduce you by name.\n" +
        "      Set SENDER_NAME, SENDER_COMPANY and SENDER_CNPJ before real outreach —\n" +
        "      self-identification is part of the LGPD legitimate-interest basis.\n"
    );
  }

  const cap = Number(process.env.DAILY_SEND_CAP || DEFAULT_DAILY_CAP);
  const already = await sentToday();
  if (already >= cap) {
    console.log(
      `Daily cap reached: ${already}/${cap} sent today. Stop here — volume is what gets numbers banned.`
    );
    return;
  }
  const remaining = Math.min(opts.limit, cap - already);

  const rows = await query<QueueRow>(
    `SELECT l.cnpj, l.nome_fantasia AS nome, l.razao_social AS razao,
            l.municipio_nome AS municipio, l.uf, l.phone_e164 AS phone, l.is_mobile,
            s.web_fit, s.chatbot_fit, s.tier, s.offer, s.confidence, s.hook, s.evidence,
            e.website_url AS website, e.final_url
     FROM leads l
     JOIN scores s ON s.cnpj = l.cnpj
     LEFT JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN outreach o ON o.cnpj = l.cnpj
     LEFT JOIN suppression sup ON sup.phone_e164 = l.phone_e164
     WHERE l.phone_e164 IS NOT NULL
       AND o.cnpj IS NULL
       AND sup.phone_e164 IS NULL
       AND s.web_fit IS NOT NULL
       AND s.tier <> 'cold'
       ${opts.tier ? "AND s.tier = $2" : ""}
       -- one human may own several CNPJs; never queue the same number twice
       AND l.phone_e164 NOT IN (
         SELECT l2.phone_e164 FROM outreach o2
         JOIN leads l2 ON l2.cnpj = o2.cnpj
         WHERE l2.phone_e164 IS NOT NULL
       )
     ORDER BY GREATEST(COALESCE(s.web_fit,0), COALESCE(s.chatbot_fit,0)) DESC,
              s.confidence = 'high' DESC,
              -- Mobiles first: a wa.me link on a landline may open a dead chat.
              -- The human reviewing the row sees the canal before deciding.
              l.is_mobile DESC NULLS LAST
     LIMIT $1`,
    opts.tier ? [remaining, opts.tier] : [remaining]
  );

  if (rows.length === 0) {
    console.log("Queue is empty. Run `npm run score` first, or everything is already handled.");
    return;
  }

  console.log(
    `${rows.length} lead(s) to review. ${already}/${cap} sent today.\n` +
      `Actions: [s]ent  [k]skip  [n]ot a fit  [o]pt-out  [q]uit\n` +
      `Reminder: SAVE THE CONTACT before messaging — messaging numbers not in\n` +
      `your contacts is the single strongest ban signal.\n`
  );

  const rl = createInterface({ input: stdin, output: stdout });
  let sent = 0;

  try {
    for (const [i, row] of rows.entries()) {
      const evidence = row.evidence?.evidence ?? [];
      const draft = await draftMessage({
        nome: row.nome ?? row.razao,
        municipio: row.municipio,
        hook: row.hook,
        evidence,
        offer: row.offer ?? "site",
      });

      console.log("─".repeat(72));
      console.log(
        `[${i + 1}/${rows.length}]  ${row.nome ?? row.razao ?? row.cnpj}  ` +
          `(${row.municipio ?? "?"}/${row.uf ?? "?"})`
      );
      console.log(
        `  tier ${row.tier}  web ${row.web_fit ?? "-"}/5  chatbot ${row.chatbot_fit ?? "-"}/5  ` +
          `conf ${row.confidence ?? "-"}  oferta: ${row.offer ?? "-"}`
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
        await mark(row.cnpj, "not_a_fit", draft);
        continue;
      }

      if (answer === "o") {
        await mark(row.cnpj, "opted_out", draft);
        await withClient((c) =>
          c.query(
            `INSERT INTO suppression (phone_e164, reason) VALUES ($1, 'manual opt-out')
             ON CONFLICT (phone_e164) DO NOTHING`,
            [row.phone]
          )
        );
        console.log("  Suppressed permanently.");
        continue;
      }

      if (answer === "s") {
        await mark(row.cnpj, "sent", draft);
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

async function mark(cnpj: string, status: string, draft: string): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO outreach (cnpj, status, draft, touches, sent_at, followup_at)
       VALUES ($1, $2, $3,
               CASE WHEN $2 = 'sent' THEN 1 ELSE 0 END,
               CASE WHEN $2 = 'sent' THEN now() END,
               CASE WHEN $2 = 'sent' THEN now() + interval '4 days' END)
       ON CONFLICT (cnpj) DO UPDATE SET
         status = EXCLUDED.status,
         draft = EXCLUDED.draft,
         touches = outreach.touches + CASE WHEN EXCLUDED.status = 'sent' THEN 1 ELSE 0 END,
         sent_at = COALESCE(EXCLUDED.sent_at, outreach.sent_at),
         followup_at = COALESCE(EXCLUDED.followup_at, outreach.followup_at)`,
      [cnpj, status, draft]
    )
  );
}
