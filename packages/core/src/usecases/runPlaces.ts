import { requirePlaces, type Deps } from "../ports/index";
import { Budget, BudgetExceededError, usageReport, type SkuUsage } from "../services/budget";
import { checkSite, upsertEnrichment, websiteFromEmail } from "./enrichLeads";
import { resolveOffer } from "./offerRepo";

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
  /**
   * Walk this offer's shortlist in rank order instead of the whole base.
   *
   * Without it, the 1,000-call monthly allowance — the only budget in this tool
   * that is denominated in money — gets spent on whatever the global ordering
   * happens to surface, which for an education campaign was dentists and
   * medical practices. `enrich` and `score` have taken `--offer` since the
   * offers migration; this stage was the one that never did.
   */
  offerId?: string;
}

interface Candidate {
  cnpj: string;
  nome: string | null;
  municipio: string | null;
  uf: string | null;
  email: string | null;
}

export interface PlacesRunResult {
  candidates: number;
  found: number;
  notFound: number;
  withSite: number;
  /** True when the free allowance ran out and the run stopped early, cleanly. */
  stoppedOnBudget: boolean;
  usage: { rows: SkuUsage[]; overage: number };
}

export async function runPlacesEnrichment(
  deps: Deps,
  opts: PlacesRunOptions
): Promise<PlacesRunResult> {
  if (!deps.places) {
    throw new Error(
      "GOOGLE_MAPS_API_KEY not set.\n" +
        "  This step is optional — the rest of the pipeline runs without it.\n" +
        "  Enable the Places API (New) in Google Cloud and restrict the key to it."
    );
  }
  const places = requirePlaces(deps);
  const { progress } = deps;

  // A ceiling for this run on top of the monthly one, so `--limit 25` cannot
  // become 26 billable calls through a retry.
  const budget = new Budget(deps.db, { allowPaid: opts.allowPaid, maxRequests: opts.limit * 2 });

  // Prioritise: recently opened businesses in the target verticals that we can
  // actually contact and have not looked at yet.
  //
  // nome_fantasia is required, not merely preferred. For an MEI, razao_social
  // is the owner's personal name with the CNPJ prepended ("67.960.043 ANA
  // ...") — searching Maps for that finds nothing and means running a private
  // individual's name through Google. A trade name is both searchable and the
  // thing that is genuinely public. About 20% of leads have one, which is far
  // more than the 1,000/month budget can consume anyway.
  const offer = opts.offerId ? await resolveOffer(deps, opts.offerId) : null;

  const candidates = await deps.db.query<Candidate>(
    `SELECT l.cnpj, l.nome_fantasia AS nome,
            l.municipio_nome AS municipio, l.uf, l.email
     FROM leads l
     ${offer ? "JOIN offer_candidates oc ON oc.cnpj = l.cnpj AND oc.offer_id = $2" : ""}
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
     -- With an offer, rank order decides who gets the scarce paid calls. Without
     -- one the old global ordering stands, unchanged.
     ORDER BY ${offer ? "oc.rank_score DESC," : ""}
              l.is_mobile DESC NULLS LAST,
              l.data_inicio_atividade DESC NULLS LAST
     LIMIT $1`,
    offer ? [opts.limit, offer.id] : [opts.limit]
  );

  if (candidates.length === 0) {
    progress.finish("places", "nada a checar — todos os contatáveis já passaram pelo Places");
    return {
      candidates: 0, found: 0, notFound: 0, withSite: 0,
      stoppedOnBudget: false, usage: await usageReport(deps.db),
    };
  }

  const usedSearch = await budget.used("textsearch.essentials");
  const usedDetails = await budget.used("details.enterprise");

  progress.stage("places", "Google Places", candidates.length);
  progress.info(
    `Free tier used this month: ${usedSearch}/10000 text search, ${usedDetails}/1000 details`
  );

  if (opts.dryRun) {
    progress.info("--dry-run: no API calls made.");
    progress.info("Would issue up to:");
    progress.info(`  ${candidates.length} Text Search (Essentials, ID-only)  — 10,000 free/month`);
    progress.info(`  ${candidates.length} Place Details (Enterprise)         —  1,000 free/month`);
    const overDetails = Math.max(0, usedDetails + candidates.length - 1000);
    if (overDetails > 0) {
      progress.warn(
        `${overDetails} details call(s) would exceed the free tier ` +
          `($${((overDetails / 1000) * 20).toFixed(2)}). The run will hard-stop instead.`
      );
    }
    progress.info("First 5 queries:");
    for (const c of candidates.slice(0, 5)) {
      progress.info(`  "${c.nome} ${c.municipio} ${c.uf}"`);
    }
    progress.finish("places", "dry run");
    return {
      candidates: candidates.length, found: 0, notFound: 0, withSite: 0,
      stoppedOnBudget: false, usage: await usageReport(deps.db),
    };
  }

  let found = 0;
  let notFound = 0;
  let withSite = 0;
  let stopped = false;

  for (const [i, c] of candidates.entries()) {
    try {
      const q = `${c.nome} ${c.municipio} ${c.uf}`;
      let placeId: string | undefined;

      for await (const batch of places.searchIds(q, budget)) {
        placeId = batch[0]?.id;
        break; // first result only — we are matching one known business
      }

      if (!placeId) {
        notFound++;
        await markGoogleChecked(deps, c.cnpj, false);
        continue;
      }

      const details = await places.getDetails(placeId, budget);
      found++;

      // Google's fields live only in this scope. The site check that follows
      // is our own request, and only its result is persisted.
      const websiteUri = details.websiteUri ?? websiteFromEmail(c.email);
      const signals = await checkSite(deps, websiteUri ?? null);
      if (signals.hasWebsite) withSite++;

      await upsertEnrichment(deps, c.cnpj, signals);
      await deps.db.withClient((client) =>
        client.query(
          `UPDATE leads SET google_place_id = $2, place_id_refreshed_at = now()
           WHERE cnpj = $1`,
          [c.cnpj, placeId]
        )
      );
      await markGoogleChecked(deps, c.cnpj, true);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        progress.warn(err.message);
        progress.warn(`Stopped cleanly after ${i} of ${candidates.length} candidates.`);
        stopped = true;
        break;
      }
      progress.warn(`${c.nome}: ${(err as Error).message.slice(0, 120)}`);
      await markGoogleChecked(deps, c.cnpj, false).catch(() => {});
    }

    if ((i + 1) % 10 === 0 || i + 1 === candidates.length) {
      progress.tick(i + 1, `found ${found}, sem match ${notFound}, com site ${withSite}`);
    }
  }

  progress.finish(
    "places",
    `matched ${found}, sem match ${notFound}, com site ${withSite}` +
      (stopped ? " (parou no teto da cota)" : "")
  );

  return {
    candidates: candidates.length,
    found,
    notFound,
    withSite,
    stoppedOnBudget: stopped,
    usage: await usageReport(deps.db),
  };
}

async function markGoogleChecked(deps: Deps, cnpj: string, found: boolean): Promise<void> {
  await deps.db.withClient((c) =>
    c.query(
      `INSERT INTO enrichment (cnpj, google_checked_at, google_found)
       VALUES ($1, now(), $2)
       ON CONFLICT (cnpj) DO UPDATE
         SET google_checked_at = now(), google_found = EXCLUDED.google_found`,
      [cnpj, found]
    )
  );
}
