import { config } from "dotenv";
import { Command } from "commander";

config();

const program = new Command();
program
  .name("leads")
  .description(
    "Lead pipeline for Brazilian local businesses.\n" +
      "Receita Federal bulk data -> rules filter -> website enrichment -> LLM scoring -> review queue."
  )
  .version("2.0.0");

/** Loads modules lazily so a command that needs no DB never opens a pool. */
async function run(fn: () => Promise<void>): Promise<void> {
  const { closePool } = await import("./db");
  try {
    await fn();
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

// ------------------------------------------------------------------ migrate

program
  .command("migrate")
  .description("Create or update the database schema")
  .action(() =>
    run(async () => {
      const { migrate } = await import("./migrate");
      await migrate();
    })
  );

// --------------------------------------------------------------------- ibge

program
  .command("ibge")
  .description("Load the 5,570 Brazilian municípios and their populations from IBGE")
  .action(() =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { loadMunicipios } = await import("./ibge");
      await loadMunicipios();
    })
  );

// -------------------------------------------------------------------- cnaes

program
  .command("cnaes")
  .description("Load the CNAE dictionary (~1,358 codes with names). ~40 KB.")
  .action(() =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { loadCnaes } = await import("./receita");
      await loadCnaes();
    })
  );

// --------------------------------------------------------------------- load

program
  .command("load")
  .description("Download and load Receita Federal open CNPJ data (free, no key)")
  .option("--period <YYYY-MM-DD>", "Receita snapshot date (default: latest)")
  .option("--uf <list>", "Comma-separated UFs to keep, e.g. SP,RJ (default: all)")
  .option("--cnae <list>", "Comma-separated CNAE prefixes to keep, e.g. 5611,9602")
  .option("--parts <list>", "Which numbered file parts 0-9 to fetch", "0")
  .option("--dry-run", "Show what would be downloaded and how big, then exit")
  .option("--keep-files", "Keep the downloaded zips instead of deleting them")
  .option("--normalize-only", "Re-run just the staging -> leads join (no downloads)")
  .action((opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { loadReceita } = await import("./receita");

      const list = (v?: string) =>
        v
          ? v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;

      await loadReceita({
        period: opts.period,
        uf: list(opts.uf),
        cnae: list(opts.cnae),
        parts: list(opts.parts)?.map(Number) ?? [0],
        dryRun: Boolean(opts.dryRun),
        keepFiles: Boolean(opts.keepFiles),
        normalizeOnly: Boolean(opts.normalizeOnly),
      });
    })
  );

// --------------------------------------------------------------------- plan

program
  .command("plan")
  .description("Turn an intent into a prioritized query queue (categories via LLM, cities via IBGE)")
  .requiredOption("-i, --intent <text>", "What you are looking for, in plain Portuguese")
  .option("-m, --municipios <n>", "How many municípios, by population desc", "200")
  .option("--dry-run", "Print the plan and the CNAE list without writing or spending")
  .action((opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { buildPlan } = await import("./planner");
      await buildPlan({
        intent: opts.intent,
        maxMunicipios: parseInt(opts.municipios, 10),
        dryRun: Boolean(opts.dryRun),
      });
    })
  );

// ------------------------------------------------------------------- enrich

program
  .command("enrich")
  .description("Fetch and analyze each lead's website (free, our own HTTP requests)")
  .option("-l, --limit <n>", "Max leads to enrich", "500")
  .option("-c, --concurrency <n>", "Parallel fetches", "10")
  .option("--psi", "Also run PageSpeed Insights (25k/day free)")
  .option("--recheck", "Re-enrich leads that already have data")
  .action((opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { enrichLeads } = await import("./enrich");
      await enrichLeads({
        limit: parseInt(opts.limit, 10),
        concurrency: parseInt(opts.concurrency, 10),
        psi: Boolean(opts.psi),
        recheck: Boolean(opts.recheck),
      });
    })
  );

// ------------------------------------------------------------------- places

program
  .command("places")
  .description(
    "Optional: use Google Places to find each lead's website. OFF by default.\n" +
      "Free tier is 1,000 details/month, which matches ~1 month of manual outreach."
  )
  .option("-l, --limit <n>", "Max leads to check", "50")
  .option("--allow-paid", "Continue past the free tier (this WILL cost money)")
  .option("--recheck", "Re-check leads already seen by Places")
  .option("--dry-run", "Show the cost and the first queries without calling the API")
  .action((opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { runPlacesEnrichment } = await import("./placesRun");
      await runPlacesEnrichment({
        limit: parseInt(opts.limit, 10),
        allowPaid: Boolean(opts.allowPaid),
        recheck: Boolean(opts.recheck),
        dryRun: Boolean(opts.dryRun),
      });
    })
  );

// -------------------------------------------------------------------- score

program
  .command("score")
  .description("Score leads with an anchored rubric via OpenRouter (free models by default)")
  .option("-l, --limit <n>", "Max leads to score", "200")
  .option("-b, --batch <n>", "Leads per LLM request", "10")
  .option("--rescore", "Re-score leads that already have a score")
  .action((opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { scoreLeads } = await import("./score");
      await scoreLeads({
        limit: parseInt(opts.limit, 10),
        batchSize: parseInt(opts.batch, 10),
        rescore: Boolean(opts.rescore),
      });
    })
  );

// -------------------------------------------------------------------- queue

program
  .command("queue")
  .description("Review scored leads one at a time and mark them sent (never sends)")
  .option("-l, --limit <n>", "Max leads to review this session", "40")
  .option("-t, --tier <tier>", "Only this tier: hot | warm | cold")
  .action((opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { reviewQueue } = await import("./queue");
      await reviewQueue({
        limit: parseInt(opts.limit, 10),
        tier: opts.tier,
      });
    })
  );

// ------------------------------------------------------------------- export

program
  .command("export")
  .description("Export scored leads to CSV")
  .argument("<file>", "Output CSV path")
  .option("-t, --tier <tier>", "Only this tier: hot | warm | cold")
  .option("-l, --limit <n>", "Max rows", "1000")
  .action((file, opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { exportLeads } = await import("./csv");
      await exportLeads(file, { tier: opts.tier, limit: parseInt(opts.limit, 10) });
    })
  );

// ------------------------------------------------------------------- models

program
  .command("models")
  .description("List the models OpenRouter currently offers for free")
  .action(() =>
    run(async () => {
      const { listFreeModels, modelFor } = await import("./llm");
      const models = await listFreeModels();
      console.log(`${models.length} free model(s) on OpenRouter right now:\n`);
      for (const m of models) {
        console.log(
          `  ${m.id.padEnd(50)} ${String(m.contextLength).padStart(8)} ctx  ` +
            `${m.structured ? "structured-output" : ""}`
        );
      }
      console.log("\nCurrently configured:");
      for (const task of ["score", "plan", "draft"] as const) {
        console.log(`  ${task.padEnd(6)} ${modelFor(task)}`);
      }
      console.log(
        "\nOverride with OPENROUTER_MODEL_SCORE / _PLAN / _DRAFT in .env.\n" +
          "Free models are limited to 20 req/min and 50 req/day\n" +
          "(1000/day once the account has ever purchased >= 10 credits)."
      );
    })
  );

// -------------------------------------------------------------------- stats

program
  .command("stats")
  .description("Show pipeline state and Google API spend")
  .action(() =>
    run(async () => {
      const { assertDbReachable, query } = await import("./db");
      await assertDbReachable();
      const { usageReport } = await import("./budget");

      const [row] = await query<Record<string, string>>(`
        SELECT
          (SELECT count(*) FROM municipios)::text                              AS municipios,
          (SELECT count(*) FROM leads)::text                                   AS leads,
          (SELECT count(*) FROM leads WHERE phone_e164 IS NOT NULL)::text      AS contactable,
          (SELECT count(*) FROM leads WHERE is_mobile)::text                   AS mobile,
          (SELECT count(*) FROM leads
            WHERE phone_e164 IS NOT NULL AND NOT is_mobile)::text              AS landline,
          (SELECT count(*) FROM enrichment)::text                              AS enriched,
          (SELECT count(*) FROM scores WHERE web_fit IS NOT NULL)::text        AS scored,
          (SELECT count(*) FROM scores WHERE error IS NOT NULL)::text          AS score_failed,
          (SELECT count(*) FROM scores WHERE tier = 'hot')::text               AS hot,
          (SELECT count(*) FROM scores WHERE tier = 'warm')::text              AS warm,
          (SELECT count(*) FROM outreach WHERE status = 'sent')::text          AS sent,
          (SELECT count(*) FROM outreach WHERE status = 'replied')::text       AS replied,
          (SELECT count(*) FROM suppression)::text                             AS suppressed
      `);

      console.log("Pipeline state:");
      for (const [k, v] of Object.entries(row)) {
        console.log(`  ${k.padEnd(14)} ${Number(v).toLocaleString()}`);
      }

      const sent = Number(row.sent);
      if (sent > 0) {
        console.log(
          `  reply rate     ${((Number(row.replied) / sent) * 100).toFixed(1)}%`
        );
      }

      await usageReport();
    })
  );

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
