import type { Deps } from "../ports/index";
import { resolveOffer, saveSpec, setActive, type LoadedOffer } from "./offerRepo";
import { compileOffer, validateCnaes } from "./compileOffer";
import { buildShortlist } from "./shortlist";
import { runPlacesEnrichment } from "./runPlaces";
import { enrichLeads } from "./enrichLeads";
import { scoreLeads } from "./scoreLeads";
import { refreshRollupsQuietly } from "./refreshRollups";
import { loadReceita } from "./loadReceita";
import { BudgetExceededError } from "../services/budget";
import { LlmBudgetExceededError } from "../services/llmBudget";

/**
 * The whole campaign, in order, as one process.
 *
 * Every stage here already existed and was already re-runnable; what did not
 * exist was anything that knew the order or the dependencies. Running them by
 * hand means remembering that Places must precede enrich (it is what discovers
 * the website enrich then judges), that score inner-joins enrichment, and that
 * the ranking is circular — `buildRankSql` scores hasWebsite/ownDomain/probeHit
 * out of `enrichment`, but `enrich --offer` walks the shortlist. Re-ranking
 * after enrichment is free and nobody does it by hand.
 *
 * What this deliberately does NOT do is contact anybody. The last automatic
 * step is a rollup refresh; the review queue stays a human decision.
 */

export type StepKey =
  | "compile"
  | "cnaeCheck"
  | "load"
  | "shortlist"
  | "places"
  | "enrich"
  | "reshortlist"
  | "score"
  | "rollups";

export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface Step {
  key: StepKey;
  label: string;
  status: StepStatus;
  note?: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Compile the offer as the pipeline's first step, instead of requiring one to
 * already exist. This is what makes "describe the idea, get ranked companies"
 * a single run rather than three manual hops.
 */
export interface CompileStepInput {
  slug: string;
  title?: string;
  finalidade: string;
  description: string;
  idealCustomer?: string;
}

export interface RunPipelineOptions {
  offerId?: string;
  compile?: CompileStepInput;
  /** 0 disables the stage. Places is 0 by default: it is the one that bills. */
  places?: number;
  enrich?: number;
  score?: number;
  shortlistLimit?: number;
  scoreBatch?: number;
  /** Download Receita slices the offer targets but the base does not have. */
  withLoad?: boolean;
  /** Re-rank after enrichment so the new site signals affect the order. */
  reshortlist?: boolean;
  llmDailyRequests?: number;
  psiApiKey?: string;
  /** Existing pipeline_runs row to report into. Created when absent. */
  runId?: number;
  /** The dashboard job that spawned this run, so the two can be joined. */
  jobId?: number;
  /** Print the plan and stop. */
  dryRun?: boolean;
}

export interface PipelineResult {
  runId: number;
  offerId: string;
  steps: Step[];
  status: "done" | "cancelled" | "failed";
}

const LABELS: Record<StepKey, string> = {
  compile: "Compilar a ideia em perfil de cliente",
  cnaeCheck: "Conferir CNAEs contra os dados carregados",
  load: "Carregar dados da Receita",
  shortlist: "Montar shortlist",
  places: "Buscar sites no Google",
  enrich: "Enriquecer sites",
  reshortlist: "Reordenar com os sinais novos",
  score: "Pontuar leads",
  rollups: "Atualizar totais",
};

/**
 * A quota that ran out is not a failed run.
 *
 * Both budgets stop cleanly and preserve the work already done, so the honest
 * outcome is "this stage did what it could" — failing the whole pipeline would
 * throw away the stages that follow for no reason.
 */
function isQuotaStop(err: unknown): boolean {
  return err instanceof BudgetExceededError || err instanceof LlmBudgetExceededError;
}

export async function runOfferPipeline(
  deps: Deps,
  opts: RunPipelineOptions = {}
): Promise<PipelineResult> {
  // With a compile step the offer does not exist yet — it is what this run is
  // about to produce. Everything downstream reads `offer` through `current()`,
  // which is filled in the moment the compile step lands.
  let offer: LoadedOffer | undefined = opts.compile
    ? undefined
    : await resolveOffer(deps, opts.offerId);
  const offerId = opts.compile?.slug ?? offer!.id;
  const current = (): LoadedOffer => {
    if (!offer) throw new Error("a oferta ainda não foi compilada");
    return offer;
  };

  const places = opts.places ?? 0;
  const enrich = opts.enrich ?? 500;
  const score = opts.score ?? 200;
  const shortlistLimit = opts.shortlistLimit ?? 5000;
  const reshortlist = opts.reshortlist !== false;

  // Only knowable up front when the offer already exists; with a compile step
  // there are no CNAEs to check until the model has produced them.
  const missing = opts.withLoad && offer ? await missingCnaes(deps, offer) : [];

  const steps: Step[] = [
    ...(opts.compile ? [step("compile"), step("cnaeCheck")] : []),
    ...(opts.withLoad && missing.length ? [step("load")] : []),
    step("shortlist"),
    ...(places > 0 ? [step("places")] : []),
    ...(enrich > 0 ? [step("enrich")] : []),
    ...(reshortlist ? [step("reshortlist")] : []),
    ...(score > 0 ? [step("score")] : []),
    step("rollups"),
  ];

  if (opts.dryRun) {
    deps.progress.info(`Plano para "${offerId}" (${steps.length} passos):`);
    for (const s of steps) deps.progress.info(`  - ${s.label}`);
    if (missing.length) {
      deps.progress.warn(
        `CNAE não carregado: ${missing.join(", ")} — o passo "load" baixaria vários GB (~30 min).`
      );
    }
    deps.progress.info("--dry-run: nada foi executado.");
    // No pipeline_runs row: a dry run that recorded one would sit at 'running'
    // forever and read as a pipeline that never finished.
    return { runId: 0, offerId, steps, status: "done" };
  }

  const runId = opts.runId ?? (await createRun(deps, offerId, steps, opts.jobId));

  // SIGTERM stops the pipeline BETWEEN stages, never inside one. Every stage is
  // resumable — they all skip rows they already processed — so the next run
  // continues rather than restarting.
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    deps.progress.warn("cancelamento pedido — terminando o passo atual e parando.");
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    for (const s of steps) {
      if (stopping) {
        s.status = "skipped";
        s.note = "cancelado";
        continue;
      }

      s.status = "running";
      s.startedAt = new Date().toISOString();
      await saveSteps(deps, runId, steps);

      try {
        s.note = await runStep(deps, s.key, current, {
          places,
          enrich,
          score,
          shortlistLimit,
          scoreBatch: opts.scoreBatch ?? 10,
          missing,
          llmDailyRequests: opts.llmDailyRequests,
          psiApiKey: opts.psiApiKey,
          compile: opts.compile,
          offerId,
          onCompiled: (o) => {
            offer = o;
          },
        });
        s.status = "done";
      } catch (err) {
        if (isQuotaStop(err)) {
          s.status = "done";
          s.note = "cota esgotada — o que deu para fazer foi feito";
          deps.progress.warn(`${s.label}: ${(err as Error).message.split("\n")[0]}`);
        } else {
          s.status = "failed";
          s.note = (err as Error).message.slice(0, 400);
          s.finishedAt = new Date().toISOString();
          await finishRun(deps, runId, steps, "failed", (err as Error).message);
          return { runId, offerId, steps, status: "failed" };
        }
      }

      s.finishedAt = new Date().toISOString();
      await saveSteps(deps, runId, steps);
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }

  const status = stopping ? "cancelled" : "done";
  await finishRun(deps, runId, steps, status);

  const ready = await readyForReview(deps, offerId);
  deps.progress.info(
    `Pipeline de "${offerId}" concluído. ${ready} lead(s) pontuados aguardando SUA revisão — ` +
      `nada foi enviado.`
  );

  return { runId, offerId, steps, status };
}

interface StageArgs {
  places: number;
  enrich: number;
  score: number;
  shortlistLimit: number;
  scoreBatch: number;
  missing: string[];
  llmDailyRequests?: number;
  psiApiKey?: string;
  compile?: CompileStepInput;
  offerId: string;
  /** Publishes the offer the compile step just created to the rest of the run. */
  onCompiled: (offer: LoadedOffer) => void;
}

async function runStep(
  deps: Deps,
  key: StepKey,
  current: () => LoadedOffer,
  args: StageArgs
): Promise<string | undefined> {
  switch (key) {
    case "compile": {
      const c = args.compile!;
      const { spec, model, icpCoverage } = await compileOffer(
        deps,
        { description: c.description, idealCustomer: c.idealCustomer },
        { llmDailyRequests: args.llmDailyRequests }
      );

      await saveSpec(deps, {
        offerId: c.slug,
        title: c.title ?? c.slug,
        description: c.description,
        finalidade: c.finalidade,
        spec,
        compiledBy: `llm:${model}`,
        icpText: c.idealCustomer,
        icpCoverage,
      });
      // Made active so the queue, the coverage page and the main table all point
      // at the campaign the operator just created rather than the previous one.
      await setActive(deps, c.slug);

      const offer = await resolveOffer(deps, c.slug);
      args.onCompiled(offer);

      const unmapped = icpCoverage.filter((i) => !i.mapped).length;
      return (
        `${spec.targeting.cnaePrefixes.length} CNAE, ` +
        `${spec.rubric.axes.length} eixo(s)` +
        (unmapped ? `, ${unmapped} critério(s) do perfil sem filtro possível` : "")
      );
    }
    case "cnaeCheck": {
      // Free, and the gate that separates "the model found the target" from
      // "the model invented a code". Never fatal: a bad prefix costs reach, and
      // the operator decides what to do about it on the page.
      const offer = current();
      const checks = await validateCnaes(
        deps,
        offer.spec.targeting.cnaePrefixes,
        offer.spec.targeting.channels
      );
      const ok = checks.filter((c) => c.status === "ok");
      const notLoaded = checks.filter((c) => c.status === "not_loaded");
      const unknown = checks.filter((c) => c.status === "unknown");
      const reach = ok.reduce((n, c) => n + c.reachable, 0);

      for (const c of unknown) {
        deps.progress.warn(`CNAE ${c.prefix} não existe na tabela oficial — o modelo inventou.`);
      }
      for (const c of notLoaded) {
        deps.progress.warn(`CNAE ${c.prefix} existe, mas esse recorte não foi carregado.`);
      }

      return (
        `${ok.length} ok (${reach.toLocaleString("pt-BR")} contatáveis)` +
        (notLoaded.length ? `, ${notLoaded.length} não carregado(s)` : "") +
        (unknown.length ? `, ${unknown.length} inexistente(s)` : "")
      );
    }
    case "load": {
      await loadReceita(deps, { cnae: args.missing, parts: [0] });
      return `CNAE ${args.missing.join(", ")}`;
    }
    case "shortlist":
    case "reshortlist": {
      // Reloaded so a re-rank sees whatever the enrich stage just wrote.
      const fresh = await resolveOffer(deps, current().id);
      const n = await buildShortlist(deps, fresh, args.shortlistLimit);
      return `${n.toLocaleString("pt-BR")} empresas ranqueadas`;
    }
    case "places": {
      if (!deps.places) return "sem GOOGLE_MAPS_API_KEY — pulado";
      const r = await runPlacesEnrichment(deps, {
        limit: args.places,
        // Never, by any path. The only flag that spends real money is not
        // reachable from an automatic run.
        allowPaid: false,
        dryRun: false,
        recheck: false,
        offerId: current().id,
      });
      return `${r.found} encontrados, ${r.withSite} com site`;
    }
    case "enrich": {
      const r = await enrichLeads(deps, {
        limit: args.enrich,
        concurrency: 10,
        psi: false,
        recheck: false,
        offerId: current().id,
        psiApiKey: args.psiApiKey,
      });
      return `${r.checked} verificados, ${r.ok} ok`;
    }
    case "score": {
      if (!deps.llm) return "sem OPEN_ROUTER_API_KEY — pulado";
      const r = await scoreLeads(deps, {
        limit: args.score,
        batchSize: args.scoreBatch,
        rescore: false,
        offerId: current().id,
        llmDailyRequests: args.llmDailyRequests,
      });
      return `${r.scored} pontuados, ${r.tiers.hot ?? 0} hot`;
    }
    case "rollups": {
      await refreshRollupsQuietly(deps);
      return undefined;
    }
  }
}

function step(key: StepKey): Step {
  return { key, label: LABELS[key], status: "pending" };
}

/** CNAE prefixes the offer targets that have no rows loaded yet. */
async function missingCnaes(deps: Deps, offer: LoadedOffer): Promise<string[]> {
  const checks = await validateCnaes(
    deps,
    offer.spec.targeting.cnaePrefixes,
    offer.spec.targeting.channels
  );
  return checks.filter((c) => c.status === "not_loaded").map((c) => c.prefix);
}

async function readyForReview(deps: Deps, offerId: string): Promise<number> {
  const [row] = await deps.db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM scores
      WHERE offer_id = $1 AND best_fit IS NOT NULL AND tier <> 'cold'`,
    [offerId]
  );
  return Number(row?.n ?? 0);
}

// ------------------------------------------------------------- persistence

async function createRun(
  deps: Deps,
  offerId: string,
  steps: Step[],
  jobId?: number
): Promise<number> {
  const [row] = await deps.db.query<{ id: number }>(
    `INSERT INTO pipeline_runs (offer_id, job_id, steps) VALUES ($1, $2, $3) RETURNING id`,
    [offerId, jobId ?? null, JSON.stringify(steps)]
  );
  return row.id;
}

async function saveSteps(deps: Deps, runId: number, steps: Step[]): Promise<void> {
  // Progress bookkeeping must never take down the run it is describing.
  await deps.db
    .query(`UPDATE pipeline_runs SET steps = $2 WHERE id = $1`, [runId, JSON.stringify(steps)])
    .catch(() => {});
}

async function finishRun(
  deps: Deps,
  runId: number,
  steps: Step[],
  status: "done" | "cancelled" | "failed",
  error?: string
): Promise<void> {
  await deps.db
    .query(
      `UPDATE pipeline_runs
          SET steps = $2, status = $3, error = $4, finished_at = now()
        WHERE id = $1`,
      [runId, JSON.stringify(steps), status, error?.slice(0, 500) ?? null]
    )
    .catch(() => {});
}
