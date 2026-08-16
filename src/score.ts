import { query, withClient } from "./db";
import { completeJson, LlmError, modelFor } from "./llm";
import { buildRubricPrompt, buildScoreSchema, promptSha } from "./offers/prompt";
import { bestFit, tierFor, type OfferSpec } from "./offers/spec";
import { resolveOffer, type LoadedOffer } from "./offers/repo";
import { buildStage0Where } from "./offers/rank";

/**
 * One graded lead. The fit scores are not fixed fields any more — an offer
 * declares its own axes, so they arrive as extra keys alongside these and are
 * collected by `fitsFrom` below.
 */
interface ScoreResult {
  cnpj: string;
  justification: string;
  confidence: string;
  recommendation: string;
  evidence: string[];
  hook: string | null;
  [axisKey: string]: unknown;
}

/**
 * Pulls the offer's axis values out of a model response.
 *
 * `cannot_determine` zeroes everything: it is the model saying the evidence was
 * insufficient, which must stay distinguishable from a confident low score. A
 * failed API call is different again — that records an error and no confidence
 * at all — so `error IS NULL` cleanly separates "couldn't tell" from "broke".
 */
function fitsFrom(spec: OfferSpec, r: ScoreResult): Record<string, number | null> {
  const fits: Record<string, number | null> = {};
  if (r.confidence === "cannot_determine") {
    for (const axis of spec.rubric.axes) fits[axis.key] = null;
    return fits;
  }
  for (const axis of spec.rubric.axes) {
    const raw = r[axis.key];
    const n = typeof raw === "number" ? raw : Number(raw);
    fits[axis.key] = Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  }
  return fits;
}

// ------------------------------------------------------------- candidate row

interface Candidate {
  cnpj: string;
  nome: string | null;
  cnae: string | null;
  cnae_desc: string | null;
  natureza: string | null;
  natureza_desc: string | null;
  porte: string | null;
  mei: boolean | null;
  capital: string | null;
  idade_anos: number | null;
  municipio: string | null;
  uf: string | null;
  has_website: boolean | null;
  website_url: string | null;
  final_url: string | null;
  is_dead: boolean | null;
  is_https: boolean | null;
  is_link_hub: boolean | null;
  is_free_builder: boolean | null;
  has_viewport: boolean | null;
  has_contact_path: boolean | null;
  has_wa_link: boolean | null;
  has_form: boolean | null;
  platform: string | null;
  footer_year: number | null;
  psi_performance: number | null;
  title: string | null;
  email_domain: string | null;
  signals: Record<string, boolean> | null;
}

/** Deterministic facts, rendered compactly. The model weighs; it does not detect. */
function renderCandidate(c: Candidate, spec: OfferSpec): string {
  const bits: string[] = [];
  bits.push(`cnpj: ${c.cnpj}`);
  bits.push(`nome: ${c.nome ?? "(sem nome fantasia)"}`);
  // The CNAE description carries far more meaning than the code, and it is the
  // difference between the model knowing this is a driving school and it
  // guessing from seven digits.
  if (c.cnae) bits.push(`cnae: ${c.cnae}${c.cnae_desc ? ` (${c.cnae_desc})` : ""}`);
  // Natureza jurídica decides whether they can buy at all: 1xxx is public
  // administration, which needs a licitação; 3xxx is a nonprofit/associação,
  // which many private schools are.
  if (c.natureza) {
    bits.push(`natureza jurídica: ${c.natureza}${c.natureza_desc ? ` (${c.natureza_desc})` : ""}`);
  }
  if (c.municipio) bits.push(`local: ${c.municipio}/${c.uf ?? ""}`);
  if (c.idade_anos !== null) bits.push(`idade: ${c.idade_anos} anos`);
  if (c.porte) bits.push(`porte: ${c.porte}`);
  if (c.mei) bits.push("MEI: sim");
  if (c.capital) bits.push(`capital social: R$ ${c.capital}`);

  // Offer-specific probes over the stored homepage text. Only hits are shown;
  // a miss is not evidence of absence, since the page may never have loaded.
  if (c.signals && spec.probes.length) {
    const hits = spec.probes.filter((pr) => c.signals?.[pr.key]).map((pr) => pr.label);
    if (hits.length) bits.push(`no site deles: ${hits.join(", ")}`);
  }

  // Website-quality detail is irrelevant for some offers. "minimal" keeps only
  // what can still seed a truthful hook and drops the rest, saving tokens.
  const detail = spec.rubric.siteSignals;
  if (detail === "none") return `- ${bits.join(" | ")}`;

  if (!c.has_website) {
    // Receita has no website column. All we can say is that no site surfaced —
    // never that one does not exist. The rubric must not treat the two as equal.
    bits.push(
      c.email_domain
        ? `site: nenhum encontrado (e-mail em domínio próprio ${c.email_domain}, mas o site não respondeu)`
        : "site: NÃO ENCONTRADO — sem domínio próprio no cadastro (indício fraco, não confirmação)"
    );
  } else {
    bits.push(`site: ${c.final_url ?? c.website_url}`);
    if (c.is_dead) bits.push("site MORTO (fora do ar / erro)");
    if (c.is_free_builder) bits.push("construtor grátis (subdomínio)");

    if (c.is_link_hub) {
      // We deliberately do not fetch Instagram/Linktree, so nothing about the
      // page itself was observed. Saying "não é responsivo" here would be
      // inventing evidence from an unfetched page.
      bits.push(
        "o 'site' é só link hub (Instagram/Linktree) — NÃO abrimos a página, " +
          "então não se sabe nada sobre responsividade, formulário ou contato"
      );
    } else if (detail === "full") {
      if (c.is_https === false) bits.push("sem HTTPS (confirmado)");
      if (c.has_viewport === false) bits.push("SEM meta viewport (não responsivo no celular)");
      if (c.has_contact_path === false) bits.push("sem caminho de contato no site");
      if (c.has_wa_link) bits.push("tem link wa.me no site (já vende por WhatsApp)");
      if (c.has_form === false) bits.push("sem formulário");
    }
    if (detail === "full") {
      if (c.platform) bits.push(`plataforma: ${c.platform}`);
      if (c.footer_year) bits.push(`rodapé © ${c.footer_year}`);
      if (c.psi_performance !== null) bits.push(`PageSpeed mobile: ${c.psi_performance}/100`);
    }
    if (c.title) bits.push(`title: ${c.title}`);
  }

  return `- ${bits.join(" | ")}`;
}

// ------------------------------------------------------------------- runner

export interface ScoreOptions {
  limit: number;
  batchSize: number;
  rescore: boolean;
  offerId?: string;
}

export async function scoreLeads(opts: ScoreOptions): Promise<void> {
  const offer = await resolveOffer(opts.offerId);
  const spec = offer.spec;

  // Composed once per run, before the loop: the system prompt must be constant
  // across every request so it stays prompt-cacheable, and its sha identifies
  // exactly which rubric produced each row.
  const systemPrompt = buildRubricPrompt(spec);
  const schema = buildScoreSchema(spec);
  const sha = promptSha(systemPrompt);

  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = buildStage0Where(spec, p);

  // Scores are per (lead, offer): a lead already graded for THIS offer is
  // skipped, but one graded for another offer is still fair game.
  const offerParam = p(offer.id);
  const limitParam = p(opts.limit);

  const candidates = await query<Candidate>(
    `SELECT
       l.cnpj, l.nome_fantasia AS nome, l.cnae_principal AS cnae,
       cn.descricao AS cnae_desc,
       l.natureza_juridica AS natureza, NULL::text AS natureza_desc,
       l.porte, l.opcao_mei AS mei, l.capital_social::text AS capital,
       CASE WHEN l.data_inicio_atividade IS NOT NULL
            THEN date_part('year', age(l.data_inicio_atividade))::int END AS idade_anos,
       l.municipio_nome AS municipio, l.uf,
       e.has_website, e.website_url, e.final_url, e.is_dead, e.is_https,
       e.is_link_hub, e.is_free_builder, e.has_viewport, e.has_contact_path,
       e.has_wa_link, e.has_form, e.platform, e.footer_year, e.psi_performance, e.title,
       -- Only an own-domain address is a signal; a gmail tells you nothing, so
       -- freemail is rendered as no domain at all rather than as evidence.
       NULLIF(CASE WHEN split_part(l.email, '@', 2) IN
                ('gmail.com','hotmail.com','outlook.com','yahoo.com.br','uol.com.br',
                 'bol.com.br','terra.com.br','ig.com.br','globo.com','r7.com','live.com')
              THEN '' ELSE split_part(COALESCE(l.email, ''), '@', 2) END, '') AS email_domain,
       (e.signals -> ${offerParam})::jsonb AS signals
     FROM leads l
     JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN cnaes cn ON cn.codigo = l.cnae_principal
     LEFT JOIN scores s ON s.cnpj = l.cnpj AND s.offer_id = ${offerParam}
     WHERE ${where.join("\n       AND ")}
       ${opts.rescore ? "" : "AND s.cnpj IS NULL"}
     -- Leads with verified site evidence first, then ones with a trade name we
     -- can actually name in a message. A lead with neither yields a generic
     -- hook, which is the thing that drives block rates.
     ORDER BY (e.has_website IS TRUE) DESC,
              l.is_mobile DESC NULLS LAST,
              (l.nome_fantasia IS NOT NULL) DESC,
              l.data_inicio_atividade DESC NULLS LAST
     LIMIT ${limitParam}`,
    params
  );

  if (candidates.length === 0) {
    console.log(
      `Nothing to score for "${offer.id}". Run \`npm run enrich\` first, ` +
        `or widen the offer's targeting.`
    );
    return;
  }

  const model = modelFor("score");
  const requests = Math.ceil(candidates.length / opts.batchSize);

  // Refuse before the first request rather than dying at request 30 of 50 —
  // a half-finished run records the remainder as failures, which is noise that
  // looks like a model problem.
  const { checkBudget, usageReport } = await import("./llmBudget");
  const budget = await usageReport();
  await checkBudget(model, requests);

  console.log(
    `Offer: ${offer.title} (${offer.id} v${offer.version}) — rubrica ${sha}\n` +
      `Eixos: ${spec.rubric.axes.map((a) => a.key).join(", ")}\n` +
      `Scoring ${candidates.length} lead(s) with ${model}, ${opts.batchSize} per request ` +
      `= ${requests} requisição(ões).\n` +
      `Cota do dia: ${budget.used}/${budget.limit} usadas, ${budget.left} restantes. ` +
      `Tempo estimado: ~${Math.ceil((requests * 3.2) / 60)} min.`
  );

  let scored = 0;
  let failed = 0;
  const tiers: Record<string, number> = { hot: 0, warm: 0, cold: 0 };

  for (let i = 0; i < candidates.length; i += opts.batchSize) {
    const batch = candidates.slice(i, i + opts.batchSize);
    const listing = batch.map((c) => renderCandidate(c, spec)).join("\n");

    try {
      const { value } = await completeJson<{ results?: ScoreResult[] }>({
        task: "score",
        schema,
        schemaName: "lead_scores",
        maxTokens: 400 * batch.length + 500,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content:
              `Avalie os ${batch.length} negócios abaixo. Responda um objeto por ` +
              `negócio, na mesma ordem, com o cnpj exato.\n\n${listing}`,
          },
        ],
      });

      // Models vary in how strictly they honour the schema wrapper: some
      // return {results:[...]}, some a bare array, some {leads:[...]}.
      const results: ScoreResult[] = Array.isArray(value)
        ? (value as ScoreResult[])
        : Array.isArray(value?.results)
          ? value.results
          : Array.isArray((value as Record<string, unknown>)?.leads)
            ? ((value as Record<string, unknown>).leads as ScoreResult[])
            : [];

      if (results.length === 0) {
        throw new LlmError(
          `Model returned JSON without a usable results array: ` +
            `${JSON.stringify(value).slice(0, 200)}`
        );
      }

      const byCnpj = new Map(
        results.filter((r) => r?.cnpj).map((r) => [String(r.cnpj).trim(), r])
      );

      for (const c of batch) {
        const r = byCnpj.get(c.cnpj);
        if (!r) {
          await recordFailure(c.cnpj, offer, model, "model omitted this cnpj from its response");
          failed++;
          continue;
        }
        const tier = await recordScore(c.cnpj, offer, model, sha, spec, r);
        scored++;
        if (tier) tiers[tier] = (tiers[tier] ?? 0) + 1;
      }
    } catch (err) {
      // A batch failure marks every lead in it as failed with the real reason.
      // It never assigns a middle score — unscored must stay distinguishable.
      const msg = err instanceof LlmError ? err.message : (err as Error).message;
      for (const c of batch) {
        await recordFailure(c.cnpj, offer, model, msg.slice(0, 400));
        failed++;
      }
      console.warn(`\n  Batch failed: ${msg.slice(0, 160)}`);
    }

    process.stdout.write(
      `\r  ${Math.min(i + opts.batchSize, candidates.length)}/${candidates.length} ` +
        `(scored ${scored}, failed ${failed})   `
    );
  }

  console.log(
    `\nDone. hot: ${tiers.hot ?? 0}, warm: ${tiers.warm ?? 0}, cold: ${tiers.cold ?? 0}, failed: ${failed}`
  );
  if (failed > 0) {
    console.log("  Failed leads have score = NULL and an error recorded — never a fake 5.");
  }
}

async function recordScore(
  cnpj: string,
  offer: LoadedOffer,
  model: string,
  sha: string,
  spec: OfferSpec,
  r: ScoreResult
): Promise<string | null> {
  const fits = fitsFrom(spec, r);
  // Derived here, never asked of the model: it is a pure function of the fits,
  // so accepting it as output would add a failure mode and make the hot/warm/
  // cold rule unauditable.
  const tier = tierFor(fits);
  const best = bestFit(fits);
  const hasAny = best !== null;

  await withClient((c) =>
    c.query(
      `INSERT INTO scores (cnpj, offer_id, offer_version, fits, best_fit, confidence,
                           tier, recommendation, evidence, hook, model, prompt_sha,
                           scored_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), NULL)
       ON CONFLICT (cnpj, offer_id) DO UPDATE SET
         offer_version = EXCLUDED.offer_version, fits = EXCLUDED.fits,
         best_fit = EXCLUDED.best_fit, confidence = EXCLUDED.confidence,
         tier = EXCLUDED.tier, recommendation = EXCLUDED.recommendation,
         evidence = EXCLUDED.evidence, hook = EXCLUDED.hook,
         model = EXCLUDED.model, prompt_sha = EXCLUDED.prompt_sha,
         scored_at = now(), error = NULL`,
      [
        cnpj,
        offer.id,
        offer.version,
        hasAny ? JSON.stringify(fits) : null,
        best,
        r.confidence,
        tier,
        r.recommendation ?? null,
        JSON.stringify({ evidence: r.evidence ?? [], justification: r.justification }),
        r.hook,
        model,
        sha,
      ]
    )
  );
  return tier;
}

/**
 * A failed call records the reason and nothing else.
 *
 * Note `confidence` stays NULL here, while a model that answered
 * "cannot_determine" records that string with error NULL. That is what makes
 * `error IS NULL` a clean test for "we asked and it could not tell" versus
 * "the call broke" — two situations that used to look identical.
 */
async function recordFailure(
  cnpj: string,
  offer: LoadedOffer,
  model: string,
  error: string
): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO scores (cnpj, offer_id, offer_version, fits, best_fit, tier,
                           confidence, model, scored_at, error)
       VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, $4, now(), $5)
       ON CONFLICT (cnpj, offer_id) DO UPDATE SET
         fits = NULL, best_fit = NULL, tier = NULL, confidence = NULL,
         model = EXCLUDED.model, scored_at = now(), error = EXCLUDED.error`,
      [cnpj, offer.id, offer.version, model, error]
    )
  );
}
