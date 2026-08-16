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

// -------------------------------------------------------------------- offer
//
// An offer is the product being sold. Everything downstream — who gets looked
// at, how they are graded, what the opener says — comes from its spec.

const offer = program.command("offer").description("Define and inspect what you are selling");

offer
  .command("list")
  .description("List offers; the active one is used when --offer is omitted")
  .action(() =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { listOffers } = await import("./offers/repo");
      const rows = await listOffers();
      if (!rows.length) {
        console.log("No offers yet. Create one with `offer compile --desc \"...\"`.");
        return;
      }
      for (const o of rows) {
        console.log(`${o.active ? "*" : " "} ${o.id.padEnd(24)} v${o.current_version}  ${o.title}`);
      }
    })
  );

offer
  .command("seed")
  .description("Write the original site/chatbot rubric into the database as an offer")
  .action(() =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { seedLegacy } = await import("./offers/repo");
      await seedLegacy();
    })
  );

offer
  .command("use <id>")
  .description("Make an offer the active one (only one may be active)")
  .action((id: string) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { setActive } = await import("./offers/repo");
      await setActive(id);
      console.log(`Active offer is now "${id}".`);
    })
  );

offer
  .command("show [id]")
  .description("Print the composed rubric prompt and JSON schema exactly as the model sees them")
  .action((id?: string) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { resolveOffer } = await import("./offers/repo");
      const { buildRubricPrompt, buildScoreSchema, promptSha } = await import("./offers/prompt");
      const o = await resolveOffer(id);
      const prompt = buildRubricPrompt(o.spec);
      console.log(`# ${o.title}  (${o.id} v${o.version})`);
      console.log(`# stage: ${o.spec.stage}   rubrica: ${promptSha(prompt)}`);
      console.log(`# finalidade (LGPD): ${o.finalidade}\n`);
      console.log(prompt);
      console.log(`\n--- schema ---\n${JSON.stringify(buildScoreSchema(o.spec), null, 2)}`);
    })
  );

offer
  .command("cnae [id]")
  .description("Check the offer's CNAE prefixes against the data you actually loaded")
  .action((id?: string) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { resolveOffer } = await import("./offers/repo");
      const { validateCnaes } = await import("./compile");
      const o = await resolveOffer(id);
      const checks = await validateCnaes(o.spec.targeting.cnaePrefixes, o.spec.targeting.channels);

      for (const c of checks) {
        const tag =
          c.status === "ok"
            ? `${c.leads.toLocaleString()} leads (${c.reachable.toLocaleString()} contatáveis)`
            : c.status === "not_loaded"
              ? "existe, mas você NÃO carregou esse recorte"
              : "CÓDIGO INEXISTENTE — descarte";
        console.log(`  ${c.prefix.padEnd(8)} ${tag}  ${c.descricao ?? ""}`);
      }

      const missing = checks.filter((c) => c.status === "not_loaded").map((c) => c.prefix);
      if (missing.length) {
        console.log(`\nPara carregar:\n  npm run load -- --cnae ${missing.join(",")}`);
      }
      const bogus = checks.filter((c) => c.status === "unknown");
      if (bogus.length) {
        console.log(`\n${bogus.length} prefixo(s) inexistente(s) — edite a oferta e remova.`);
      }
    })
  );

offer
  .command("count [id]")
  .description("Stage 0: how many companies this offer can reach. Instant, free, no LLM.")
  .action((id?: string) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { resolveOffer } = await import("./offers/repo");
      const { countReach } = await import("./offers/shortlist");
      const o = await resolveOffer(id);
      const c = await countReach(o);
      const fmt = (n: number) => n.toLocaleString("pt-BR");
      console.log(`${o.title} (${o.id} v${o.version})`);
      console.log(`  alcançáveis:   ${fmt(c.matched)}`);
      console.log(`  celular:       ${fmt(c.mobile)}`);
      console.log(`  fixo:          ${fmt(c.landline)}`);
      console.log(`  com nome:      ${fmt(c.named)}`);
      if (c.matched > 0) {
        console.log(`\n  A 40 contatos/dia isso dá ${Math.ceil(c.matched / 40)} dias de prospecção.`);
      }
    })
  );

offer
  .command("shortlist [id]")
  .description("Stage 1: rank the reachable set into offer_candidates. Free, no LLM.")
  .option("-l, --limit <n>", "How many to materialise", "5000")
  .action((id: string | undefined, opts: { limit: string }) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { resolveOffer } = await import("./offers/repo");
      const { buildShortlist } = await import("./offers/shortlist");
      const o = await resolveOffer(id);
      const n = await buildShortlist(o, parseInt(opts.limit, 10));
      console.log(`Shortlist de "${o.id}": ${n.toLocaleString("pt-BR")} empresas ranqueadas.`);
    })
  );

offer
  .command("top [id]")
  .description("The ranked list of companies. Costs nothing.")
  .option("-l, --limit <n>", "How many rows", "40")
  .action((id: string | undefined, opts: { limit: string }) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { resolveOffer } = await import("./offers/repo");
      const { topCandidates } = await import("./offers/shortlist");
      const o = await resolveOffer(id);
      const rows = await topCandidates(o, parseInt(opts.limit, 10));
      if (!rows.length) {
        console.log("Shortlist vazia. Rode `offer shortlist` primeiro.");
        return;
      }
      for (const [i, r] of rows.entries()) {
        console.log(
          `${String(i + 1).padStart(3)}. ${Number(r.rank_score).toFixed(1).padStart(6)}  ` +
            `${(r.nome ?? r.cnpj).slice(0, 38).padEnd(38)} ` +
            `${(r.municipio ?? "?").slice(0, 16).padEnd(16)} ${r.uf ?? "??"}  ` +
            `${r.is_mobile ? "cel" : "fixo"}  ${r.cnae_desc?.slice(0, 34) ?? r.cnae ?? ""}`
        );
        if (r.hook) console.log(`      hook: ${r.hook}`);
      }
    })
  );

offer
  .command("import <slug> <file>")
  .description("Save a hand-written or hand-corrected spec as a new version")
  .option("-t, --title <text>", "Human-readable name")
  .option("-f, --finalidade <text>", "LGPD: declared purpose of contacting these companies")
  .option("-n, --note <text>", "Why this version exists")
  .action((slug: string, file: string, opts: Record<string, string>) =>
    run(async () => {
      const { readFile } = await import("node:fs/promises");
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { saveSpec, loadOffer } = await import("./offers/repo");
      const { parseOfferSpec } = await import("./offers/spec");
      const { validateCnaes } = await import("./compile");

      const raw = JSON.parse(await readFile(file, "utf-8"));
      // Validated before anything is written: a bad spec must not create a version.
      const spec = parseOfferSpec(raw);

      // Carry the previous description/finalidade forward unless overridden, so
      // correcting a rubric does not silently drop the declared legal purpose.
      let description = "Spec editada à mão.";
      let finalidade = opts.finalidade ?? "";
      try {
        const prev = await loadOffer(slug);
        description = prev.description;
        finalidade = opts.finalidade ?? prev.finalidade;
      } catch {
        /* new offer */
      }
      if (!finalidade) {
        throw new Error("--finalidade é obrigatória para uma oferta nova (base legal, LGPD).");
      }

      const version = await saveSpec({
        offerId: slug,
        title: opts.title,
        description,
        finalidade,
        spec,
        compiledBy: "human",
        note: opts.note,
      });
      console.log(`Salvo "${slug}" v${version}.`);

      const checks = await validateCnaes(spec.targeting.cnaePrefixes, spec.targeting.channels);
      for (const c of checks) {
        const tag =
          c.status === "ok"
            ? `${c.leads.toLocaleString()} leads (${c.reachable.toLocaleString()} contatáveis)`
            : c.status === "not_loaded"
              ? "NÃO CARREGADO"
              : "INEXISTENTE";
        console.log(`  ${c.prefix.padEnd(8)} ${tag.padEnd(34)} ${c.descricao ?? ""}`);
      }
    })
  );

offer
  .command("compile")
  .description("Turn a free-text product description into an offer spec (2 LLM calls)")
  .requiredOption("-d, --desc <text>", "What the product is, in plain Portuguese")
  .requiredOption("-s, --slug <id>", "Short id, e.g. simulados-edu")
  .option("-t, --title <text>", "Human-readable name")
  .option(
    "-f, --finalidade <text>",
    "LGPD: the declared purpose of contacting these companies (required for legitimate interest)"
  )
  .option("--activate", "Make this the active offer after compiling")
  .action((opts: Record<string, string | boolean>) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { compileOffer, validateCnaes } = await import("./compile");
      const { saveSpec, setActive } = await import("./offers/repo");

      const description = String(opts.desc);
      console.log("Compilando descrição em perfil de cliente ideal (2 chamadas)...");
      const { spec, model, rationale } = await compileOffer(description);

      console.log(`\nEtapa: ${spec.stage}`);
      console.log(`Resumo: ${spec.summary}`);
      console.log(`Comprador: ${spec.buyer}`);
      if (rationale) console.log(`Racional do alvo: ${rationale}`);
      console.log(`Canais: ${spec.targeting.channels.join(", ")}`);
      console.log(`Eixos: ${spec.rubric.axes.map((a) => `${a.key} (${a.label})`).join(", ")}`);

      // Never let a hallucinated CNAE silently define a campaign.
      console.log(`\nConferindo CNAEs contra os dados carregados:`);
      const checks = await validateCnaes(spec.targeting.cnaePrefixes, spec.targeting.channels);
      for (const c of checks) {
        const tag =
          c.status === "ok"
            ? `${c.leads.toLocaleString()} leads`
            : c.status === "not_loaded"
              ? "não carregado"
              : "INEXISTENTE";
        console.log(`  ${c.prefix.padEnd(8)} ${tag.padEnd(16)} ${c.descricao ?? ""}`);
      }
      const usable = checks.filter((c) => c.status === "ok");
      if (!usable.length) {
        console.log(
          `\nNenhum CNAE proposto tem lead carregado. A oferta foi salva, mas antes de\n` +
            `pontuar qualquer coisa rode o load ou corrija os prefixos.`
        );
      }

      const version = await saveSpec({
        offerId: String(opts.slug),
        title: String(opts.title ?? opts.slug),
        description,
        finalidade: String(
          opts.finalidade ??
            `Identificar empresas cujo perfil indique interesse em ${spec.messaging.productNoun}, ` +
              `para contato comercial individual e de baixo volume.`
        ),
        spec,
        compiledBy: `llm:${model}`,
      });

      console.log(`\nSalvo como "${opts.slug}" v${version}.`);
      if (opts.activate) {
        await setActive(String(opts.slug));
        console.log(`Oferta ativa agora é "${opts.slug}".`);
      }
      console.log(
        `\nPróximos passos (nenhum gasta LLM):\n` +
          `  npm start -- offer show ${opts.slug}\n` +
          `  npm start -- offer count ${opts.slug}\n` +
          `  npm start -- offer shortlist ${opts.slug}\n` +
          `  npm start -- offer top ${opts.slug}`
      );
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
  .option("-o, --offer <id>", "Walk this offer's shortlist in rank order and run its probes")
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
        offerId: opts.offer,
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
  .option("-o, --offer <id>", "Which offer to score against (default: the active one)")
  .action((opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { scoreLeads } = await import("./score");
      await scoreLeads({
        limit: parseInt(opts.limit, 10),
        batchSize: parseInt(opts.batch, 10),
        rescore: Boolean(opts.rescore),
        offerId: opts.offer,
      });
    })
  );

// -------------------------------------------------------------------- queue

program
  .command("queue")
  .description("Review scored leads one at a time and mark them sent (never sends)")
  .option("-l, --limit <n>", "Max leads to review this session", "40")
  .option("-t, --tier <tier>", "Only this tier: hot | warm | cold")
  .option("-o, --offer <id>", "Which offer to work (default: the active one)")
  .action((opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { reviewQueue } = await import("./queue");
      await reviewQueue({
        limit: parseInt(opts.limit, 10),
        tier: opts.tier,
        offerId: opts.offer,
      });
    })
  );

// ------------------------------------------------------------------- export

program
  .command("export")
  .description("Export scored leads to CSV")
  .argument("<file>", "Output CSV path")
  .option("-t, --tier <tier>", "Only this tier: hot | warm | cold")
  .option("-o, --offer <id>", "Which offer to work (default: the active one)")
  .option("-l, --limit <n>", "Max rows", "1000")
  .action((file, opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { exportLeads } = await import("./csv");
      await exportLeads(file, {
        tier: opts.tier,
        limit: parseInt(opts.limit, 10),
        offerId: opts.offer,
      });
    })
  );

// ------------------------------------------------------------------- demand

program
  .command("demand")
  .description("Export validated demand — everyone who replied with an interest level")
  .argument("<file>", "Output CSV path")
  .option("-o, --offer <id>", "Only this offer")
  .action((file, opts) =>
    run(async () => {
      const { assertDbReachable } = await import("./db");
      await assertDbReachable();
      const { exportDemand } = await import("./csv");
      await exportDemand(file, opts.offer);
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
          (SELECT count(*) FROM scores WHERE best_fit IS NOT NULL)::text       AS scored,
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
