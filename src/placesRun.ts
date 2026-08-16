import { query, withClient } from "./db";
import { Budget, BudgetExceededError, usageReport } from "./budget";
import { searchIds, getDetails } from "./places";
import { checkSite, upsertEnrichment, websiteFromEmail } from "./enrich";

/**
 * Google Places as a scalpel, not a hose.
 *
 * Receita gives contactable phone numbers at national scale but carries no
 * website field, so it cannot tell a business with a dead Wix from one with a
 * modern site — which is the whole basis of the pitch. Places has that field.
 *
 * The economics happen to line up: the free tier is 1,000 Enterprise Details
 * calls per month, and a 40-message-per-day manual cadence consumes about 800
 * leads per month. So the free quota is roughly exactly one month of outreach.
 *
 * Terms compliance: place_id may be stored indefinitely; names, phones,
 * addresses, ratings and review counts may not. Those are therefore used
 * within this run only — passed straight into the site check and discarded.
 * What lands in the database is our own observation of their website.
 */

export interface PlacesRunOptions {
  limit: number;
  allowPaid: boolean;
  dryRun: boolean;
  recheck: boolean;
}

interface Candidate {
  cnpj: string;
  nome: string | null;
  municipio: string | null;
  uf: string | null;
  email: string | null;
}

export async function runPlacesEnrichment(opts: PlacesRunOptions): Promise<void> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_MAPS_API_KEY not set.\n" +
        "  This step is optional — the rest of the pipeline runs without it.\n" +
        "  Enable the Places API (New) in Google Cloud and restrict the key to it."
    );
  }

  const budget = new Budget({ allowPaid: opts.allowPaid });

  // Prioritise: recently opened businesses in the target verticals that we can
  // actually contact and have not looked at yet.
  //
  // nome_fantasia is required, not merely preferred. For an MEI, razao_social
  // is the owner's personal name with the CNPJ prepended ("67.960.043 ANA
  // ...") — searching Maps for that finds nothing and means running a private
  // individual's name through Google. A trade name is both searchable and the
  // thing that is genuinely public. About 20% of leads have one, which is far
  // more than the 1,000/month budget can consume anyway.
  const candidates = await query<Candidate>(
    `SELECT l.cnpj, l.nome_fantasia AS nome,
            l.municipio_nome AS municipio, l.uf, l.email
     FROM leads l
     LEFT JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN outreach o ON o.cnpj = l.cnpj
     LEFT JOIN suppression s ON s.phone_e164 = l.phone_e164
     WHERE l.phone_e164 IS NOT NULL
       AND l.situacao = 'ATIVA'
       AND l.nome_fantasia IS NOT NULL
       AND length(l.nome_fantasia) >= 4
       AND l.municipio_nome IS NOT NULL
       AND o.cnpj IS NULL
       AND s.phone_e164 IS NULL
       ${opts.recheck ? "" : "AND e.google_checked_at IS NULL"}
     ORDER BY l.is_mobile DESC NULLS LAST,
              l.data_inicio_atividade DESC NULLS LAST
     LIMIT $1`,
    [opts.limit]
  );

  if (candidates.length === 0) {
    console.log("Nothing to check. Every contactable lead has already been through Places.");
    return;
  }

  const usedSearch = await budget.used("textsearch.essentials");
  const usedDetails = await budget.used("details.enterprise");

  console.log(`Candidates: ${candidates.length}`);
  console.log(
    `Free tier used this month: ${usedSearch}/10000 text search, ` +
      `${usedDetails}/1000 details`
  );

  if (opts.dryRun) {
    console.log("\n--dry-run: no API calls made.\n");
    console.log("Would issue up to:");
    console.log(`  ${candidates.length} Text Search (Essentials, ID-only)  — 10,000 free/month`);
    console.log(`  ${candidates.length} Place Details (Enterprise)         —  1,000 free/month`);
    const overDetails = Math.max(0, usedDetails + candidates.length - 1000);
    if (overDetails > 0) {
      console.log(
        `\n  ⚠️  ${overDetails} details call(s) would exceed the free tier ` +
          `($${((overDetails / 1000) * 20).toFixed(2)}). The run will hard-stop instead.`
      );
    }
    console.log("\nFirst 5 queries:");
    for (const c of candidates.slice(0, 5)) {
      console.log(`  "${c.nome} ${c.municipio} ${c.uf}"`);
    }
    return;
  }

  let found = 0;
  let notFound = 0;
  let withSite = 0;
  let stopped = false;

  for (const [i, c] of candidates.entries()) {
    try {
      const q = `${c.nome} ${c.municipio} ${c.uf}`;
      let placeId: string | undefined;

      for await (const batch of searchIds(q, apiKey, budget)) {
        placeId = batch[0]?.id;
        break; // first result only — we are matching one known business
      }

      if (!placeId) {
        notFound++;
        await markGoogleChecked(c.cnpj, false);
        continue;
      }

      const details = await getDetails(placeId, apiKey, budget);
      found++;

      // Google's fields live only in this scope. The site check that follows
      // is our own request, and only its result is persisted.
      const websiteUri = details.websiteUri ?? websiteFromEmail(c.email);
      const signals = await checkSite(websiteUri ?? null);
      if (signals.hasWebsite) withSite++;

      await upsertEnrichment(c.cnpj, signals);
      await withClient((client) =>
        client.query(
          `UPDATE leads SET google_place_id = $2, place_id_refreshed_at = now()
           WHERE cnpj = $1`,
          [c.cnpj, placeId]
        )
      );
      await markGoogleChecked(c.cnpj, true);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.log(`\n\n${err.message}`);
        console.log(`Stopped cleanly after ${i} of ${candidates.length} candidates.`);
        stopped = true;
        break;
      }
      console.warn(`\n  ${c.nome}: ${(err as Error).message.slice(0, 120)}`);
      await markGoogleChecked(c.cnpj, false).catch(() => {});
    }

    if ((i + 1) % 10 === 0 || i + 1 === candidates.length) {
      process.stdout.write(
        `\r  ${i + 1}/${candidates.length}  found ${found}, sem match ${notFound}, com site ${withSite}   `
      );
    }
  }

  console.log(
    `\n\nMatched ${found}, no match ${notFound}, with a website to judge ${withSite}.`
  );
  if (!stopped) console.log("Completed without hitting the budget ceiling.");
  await usageReport();
}

async function markGoogleChecked(cnpj: string, found: boolean): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO enrichment (cnpj, google_checked_at, google_found)
       VALUES ($1, now(), $2)
       ON CONFLICT (cnpj) DO UPDATE
         SET google_checked_at = now(), google_found = EXCLUDED.google_found`,
      [cnpj, found]
    )
  );
}
