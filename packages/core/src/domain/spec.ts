/**
 * An Offer is a product being sold, described well enough that the pipeline can
 * find and grade buyers for it.
 *
 * It exists because the product used to be a prompt string: `src/score.ts` knew
 * it was selling websites and chatbots, the `scores` table had a `web_fit` and a
 * `chatbot_fit` column, and the dashboard had headers called `web` and `bot`.
 * Selling anything else meant editing five files.
 *
 * Specs are authored at runtime — compiled by an LLM from a free-text product
 * description, then edited by a human — so this file is a TRUST BOUNDARY, not a
 * convenience type. Everything that reaches SQL or a prompt passes through
 * `parseOfferSpec` first. There is no raw-SQL escape hatch and no user-supplied
 * regex, both on purpose: a spec is data written by a language model and stored
 * in a database, which is exactly the threat model where those become injection
 * and ReDoS primitives.
 */

export type Stage = "presell" | "beta" | "live";
export type Channel = "mobile" | "landline";
export type SiteDetail = "full" | "minimal" | "none";
export type Goal = "validate" | "demo" | "sell";

/** Who to look at. Every field maps to a column, evaluated in SQL for free. */
export interface Targeting {
  /** CNAE prefixes, 2-7 digits. Validated against loaded data before use. */
  cnaePrefixes: string[];
  cnaeExclude: string[];
  /** Which phone types this offer can actually reach. */
  channels: Channel[];
  ufs: string[];
  /**
   * natureza_juridica leading digits. "1" = public administration (cannot buy
   * without a licitação), "2" = private company, "3" = nonprofit/association.
   * Many private schools are associações, so excluding 3 loses real buyers.
   */
  naturezaPrefixes: string[];
  porteIn: string[];
  minCapitalSocial: number | null;
  excludeMei: boolean;
  minAgeYears: number | null;
  maxAgeYears: number | null;
  /** You cannot write a specific opener about a business you cannot name. */
  requireNomeFantasia: boolean;
}

/**
 * A keyword probe evaluated against the stored homepage text.
 *
 * `terms` are LITERAL strings. The engine escapes them and builds a word-bounded
 * alternation over unaccented text. Never a regex: an LLM-authored pattern run
 * against arbitrary page content is a ReDoS waiting to happen, for no benefit.
 */
export interface Probe {
  key: string;
  label: string;
  terms: string[];
  /** positive = a reason to contact them; negative = a reason not to. */
  meaning: "positive" | "negative";
  weight: number;
}

/** Weights for the free SQL ranking that produces the list the user sees. */
export interface Ranking {
  cnaeExact: number;
  /**
   * Bonus for a private (2xxx) or nonprofit (3xxx) legal nature.
   *
   * A ranking term rather than a filter on purpose: public administration is a
   * tiny slice, but natureza_juridica is NULL whenever the Empresas file for
   * that CNPJ was not loaded — filtering would silently discard a large number
   * of real prospects to exclude a handful of unreachable ones.
   */
  naturezaPrivada: number;
  channelMobile: number;
  porteMatch: number;
  ageMatch: number;
  capitalBand: number;
  hasNomeFantasia: number;
  hasWebsite: number;
  ownDomain: number;
  probeHit: number;
  ftsTerms: string[];
  ftsWeight: number;
}

export interface Axis {
  key: string;
  label: string;
  question: string;
  /** Higher ALWAYS means a better buyer. Enforced in the prompt and validated. */
  anchors: { "1": string; "2": string; "3": string; "4": string; "5": string };
}

export interface Recommendation {
  value: string;
  label: string;
  when: string;
}

export interface Rubric {
  axes: Axis[];
  recommendations: Recommendation[];
  notes: string[];
  /** Offer-specific hook examples, appended to the shared honesty rules. */
  hookBad: string[];
  hookGood: string[];
  /**
   * How much website-quality detail to feed the model. "minimal" when a broken
   * site is irrelevant to the offer — for a school buying a question generator,
   * a dead homepage is a hook fact, not evidence of need.
   */
  siteSignals: SiteDetail;
}

export interface Messaging {
  senderRole: string;
  productNoun: string;
  goal: Goal;
  asks: string[];
  fallbackAsk: string;
  forbidden: string[];
}

export interface Preset {
  label: string;
  query: string;
}

export interface OfferSpec {
  schemaVersion: 1;
  stage: Stage;
  summary: string;
  buyer: string;
  problem: string;
  targeting: Targeting;
  probes: Probe[];
  ranking: Ranking;
  rubric: Rubric;
  messaging: Messaging;
  presets: Preset[];
}

// ------------------------------------------------------------------- limits

export const LIMITS = {
  /**
   * Each axis multiplies output tokens per lead across the batch, and free
   * structured-output models degrade badly on long schemas. Two is usually
   * right; three is the ceiling.
   */
  maxAxes: 3,
  maxProbes: 12,
  maxProbeTerms: 20,
  maxTermLength: 40,
  maxCnaePrefixes: 40,
  maxRecommendations: 6,
  maxNotes: 12,
  maxHookExamples: 6,
  maxPresets: 8,
} as const;

const KEY_RE = /^[a-z][a-z0-9_]{2,30}$/;
const CNAE_RE = /^\d{2,7}$/;
const REC_RE = /^[a-z][a-z0-9_]{1,20}$/;

/** Words that turn a validation ("what do you do today?") into a sale. */
const SALES_WORDS = ["contratar", "assinar", "plano", "desconto", "preço", "preco", "orçamento"];

export class SpecError extends Error {
  constructor(
    message: string,
    readonly path: string
  ) {
    super(`${path}: ${message}`);
    this.name = "SpecError";
  }
}

// ------------------------------------------------------------------ helpers

function fail(path: string, message: string): never {
  throw new SpecError(message, path);
}

function str(v: unknown, path: string, { max = 400, allowEmpty = false } = {}): string {
  if (typeof v !== "string") fail(path, "precisa ser texto");
  const s = v.trim();
  if (!allowEmpty && s.length === 0) fail(path, "não pode ficar vazio");
  if (s.length > max) fail(path, `passa de ${max} caracteres`);
  return s;
}

function strArray(
  v: unknown,
  path: string,
  { max, maxLen = 200 }: { max: number; maxLen?: number }
): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(path, "precisa ser uma lista");
  if (v.length > max) fail(path, `no máximo ${max} itens (recebi ${v.length})`);
  return v.map((item, i) => str(item, `${path}[${i}]`, { max: maxLen }));
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(
  v: unknown,
  path: string,
  { min = 0, max = 1e12, nullable = true }: { min?: number; max?: number; nullable?: boolean } = {}
): number | null {
  if (v === undefined || v === null || v === "") {
    if (nullable) return null;
    fail(path, "é obrigatório");
  }
  const n = Number(v);
  if (!Number.isFinite(n)) fail(path, "precisa ser um número");
  if (n < min || n > max) fail(path, `precisa estar entre ${min} e ${max}`);
  return n;
}

function weight(v: unknown, path: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(path, "peso precisa ser um número");
  return Math.max(0, Math.min(5, n));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string, fallback?: T): T {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    fail(path, `é obrigatório (${allowed.join(" | ")})`);
  }
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail(path, `precisa ser um de: ${allowed.join(" | ")}`);
  }
  return v as T;
}

// -------------------------------------------------------------- the parser

/**
 * Validates an untrusted object into an OfferSpec, or throws SpecError with a
 * path the UI can point at. Deliberately strict: a spec that is merely
 * *plausible* produces a campaign that quietly targets nobody.
 */
export function parseOfferSpec(input: unknown): OfferSpec {
  if (!input || typeof input !== "object") fail("spec", "precisa ser um objeto");
  const o = input as Record<string, unknown>;

  const t = (o.targeting ?? {}) as Record<string, unknown>;
  const cnaePrefixes = strArray(t.cnaePrefixes, "targeting.cnaePrefixes", {
    max: LIMITS.maxCnaePrefixes,
    maxLen: 7,
  }).map((c, i) => {
    const clean = c.replace(/\D/g, "");
    if (!CNAE_RE.test(clean)) {
      fail(`targeting.cnaePrefixes[${i}]`, `"${c}" não é um prefixo CNAE de 2 a 7 dígitos`);
    }
    return clean;
  });
  if (cnaePrefixes.length === 0) {
    fail("targeting.cnaePrefixes", "pelo menos um prefixo CNAE é obrigatório — sem ele a busca não tem alvo");
  }

  const channels = strArray(t.channels, "targeting.channels", { max: 2, maxLen: 10 }).map((c, i) =>
    oneOf(c, ["mobile", "landline"] as const, `targeting.channels[${i}]`)
  );
  if (channels.length === 0) {
    fail("targeting.channels", "pelo menos um canal é obrigatório");
  }

  const targeting: Targeting = {
    cnaePrefixes,
    cnaeExclude: strArray(t.cnaeExclude, "targeting.cnaeExclude", {
      max: LIMITS.maxCnaePrefixes,
      maxLen: 7,
    }).map((c) => c.replace(/\D/g, "")),
    channels: [...new Set(channels)],
    ufs: strArray(t.ufs, "targeting.ufs", { max: 27, maxLen: 2 }).map((u) => u.toUpperCase()),
    naturezaPrefixes: strArray(t.naturezaPrefixes, "targeting.naturezaPrefixes", {
      max: 4,
      maxLen: 1,
    }),
    porteIn: strArray(t.porteIn, "targeting.porteIn", { max: 6, maxLen: 20 }),
    minCapitalSocial: num(t.minCapitalSocial, "targeting.minCapitalSocial"),
    excludeMei: bool(t.excludeMei),
    minAgeYears: num(t.minAgeYears, "targeting.minAgeYears", { max: 200 }),
    maxAgeYears: num(t.maxAgeYears, "targeting.maxAgeYears", { max: 200 }),
    requireNomeFantasia: bool(t.requireNomeFantasia, true),
  };

  // ---- probes
  const rawProbes = Array.isArray(o.probes) ? o.probes : [];
  if (rawProbes.length > LIMITS.maxProbes) {
    fail("probes", `no máximo ${LIMITS.maxProbes} (recebi ${rawProbes.length})`);
  }
  const probeKeys = new Set<string>();
  const probes: Probe[] = rawProbes.map((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const key = str(p.key, `probes[${i}].key`, { max: 30 });
    if (!KEY_RE.test(key)) fail(`probes[${i}].key`, `"${key}" precisa casar com ${KEY_RE}`);
    if (probeKeys.has(key)) fail(`probes[${i}].key`, `"${key}" está duplicado`);
    probeKeys.add(key);

    const terms = strArray(p.terms, `probes[${i}].terms`, {
      max: LIMITS.maxProbeTerms,
      maxLen: LIMITS.maxTermLength,
    });
    if (terms.length === 0) fail(`probes[${i}].terms`, "precisa de pelo menos um termo");

    return {
      key,
      label: str(p.label, `probes[${i}].label`, { max: 80 }),
      terms,
      meaning: oneOf(p.meaning, ["positive", "negative"] as const, `probes[${i}].meaning`, "positive"),
      weight: weight(p.weight, `probes[${i}].weight`, 1),
    };
  });

  // ---- ranking
  const r = (o.ranking ?? {}) as Record<string, unknown>;
  const ranking: Ranking = {
    cnaeExact: weight(r.cnaeExact, "ranking.cnaeExact", 2),
    naturezaPrivada: weight(r.naturezaPrivada, "ranking.naturezaPrivada", 2),
    channelMobile: weight(r.channelMobile, "ranking.channelMobile", 1),
    porteMatch: weight(r.porteMatch, "ranking.porteMatch", 2),
    ageMatch: weight(r.ageMatch, "ranking.ageMatch", 1),
    capitalBand: weight(r.capitalBand, "ranking.capitalBand", 1),
    hasNomeFantasia: weight(r.hasNomeFantasia, "ranking.hasNomeFantasia", 2),
    hasWebsite: weight(r.hasWebsite, "ranking.hasWebsite", 1),
    ownDomain: weight(r.ownDomain, "ranking.ownDomain", 2),
    probeHit: weight(r.probeHit, "ranking.probeHit", 2),
    ftsTerms: strArray(r.ftsTerms, "ranking.ftsTerms", { max: 20, maxLen: 40 }),
    ftsWeight: weight(r.ftsWeight, "ranking.ftsWeight", 2),
  };

  // ---- rubric
  const rb = (o.rubric ?? {}) as Record<string, unknown>;
  const rawAxes = Array.isArray(rb.axes) ? rb.axes : [];
  if (rawAxes.length === 0) fail("rubric.axes", "pelo menos um eixo é obrigatório");
  if (rawAxes.length > LIMITS.maxAxes) {
    fail(
      "rubric.axes",
      `no máximo ${LIMITS.maxAxes} eixos (recebi ${rawAxes.length}) — cada eixo multiplica ` +
        `o custo por lead e modelos gratuitos erram schemas longos`
    );
  }
  const axisKeys = new Set<string>();
  const axes: Axis[] = rawAxes.map((raw, i) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const key = str(a.key, `rubric.axes[${i}].key`, { max: 30 });
    if (!KEY_RE.test(key)) fail(`rubric.axes[${i}].key`, `"${key}" precisa casar com ${KEY_RE}`);
    if (axisKeys.has(key)) fail(`rubric.axes[${i}].key`, `"${key}" está duplicado`);
    axisKeys.add(key);

    const anchorsRaw = (a.anchors ?? {}) as Record<string, unknown>;
    const anchors = {} as Axis["anchors"];
    for (const level of ["1", "2", "3", "4", "5"] as const) {
      anchors[level] = str(anchorsRaw[level], `rubric.axes[${i}].anchors.${level}`, { max: 300 });
    }

    return {
      key,
      label: str(a.label, `rubric.axes[${i}].label`, { max: 40 }),
      question: str(a.question, `rubric.axes[${i}].question`, { max: 200 }),
      anchors,
    };
  });

  const rawRecs = Array.isArray(rb.recommendations) ? rb.recommendations : [];
  if (rawRecs.length > LIMITS.maxRecommendations) {
    fail("rubric.recommendations", `no máximo ${LIMITS.maxRecommendations}`);
  }
  const recValues = new Set<string>();
  const recommendations: Recommendation[] = rawRecs.map((raw, i) => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    const value = str(rec.value, `rubric.recommendations[${i}].value`, { max: 20 });
    if (!REC_RE.test(value)) {
      fail(`rubric.recommendations[${i}].value`, `"${value}" precisa casar com ${REC_RE}`);
    }
    if (recValues.has(value)) fail(`rubric.recommendations[${i}].value`, `"${value}" duplicado`);
    recValues.add(value);
    return {
      value,
      label: str(rec.label, `rubric.recommendations[${i}].label`, { max: 60 }),
      when: str(rec.when, `rubric.recommendations[${i}].when`, { max: 200 }),
    };
  });
  if (recommendations.length === 0) {
    // The scorer must always be able to say "not a fit".
    recommendations.push({ value: "none", label: "não é cliente", when: "não se encaixa" });
  }

  const rubric: Rubric = {
    axes,
    recommendations,
    notes: strArray(rb.notes, "rubric.notes", { max: LIMITS.maxNotes, maxLen: 300 }),
    hookBad: strArray(rb.hookBad, "rubric.hookBad", { max: LIMITS.maxHookExamples, maxLen: 300 }),
    hookGood: strArray(rb.hookGood, "rubric.hookGood", { max: LIMITS.maxHookExamples, maxLen: 300 }),
    siteSignals: oneOf(rb.siteSignals, ["full", "minimal", "none"] as const, "rubric.siteSignals", "full"),
  };

  // ---- messaging
  const m = (o.messaging ?? {}) as Record<string, unknown>;
  const stage = oneOf(o.stage, ["presell", "beta", "live"] as const, "stage", "presell");
  const messaging: Messaging = {
    senderRole: str(m.senderRole, "messaging.senderRole", { max: 100 }),
    productNoun: str(m.productNoun, "messaging.productNoun", { max: 160 }),
    goal: oneOf(m.goal, ["validate", "demo", "sell"] as const, "messaging.goal", "validate"),
    asks: strArray(m.asks, "messaging.asks", { max: 6, maxLen: 200 }),
    fallbackAsk: str(m.fallbackAsk, "messaging.fallbackAsk", { max: 200 }),
    forbidden: strArray(m.forbidden, "messaging.forbidden", { max: 12, maxLen: 120 }),
  };

  // A pre-sell that asks for money is not a pre-sell. Catches the compiler
  // drifting into sales copy, which it does readily.
  if (stage === "presell") {
    for (const [i, ask] of messaging.asks.entries()) {
      const hit = SALES_WORDS.find((w) => ask.toLowerCase().includes(w));
      if (hit) {
        fail(
          `messaging.asks[${i}]`,
          `contém "${hit}" — o produto ainda não existe, então a mensagem não pode ` +
            `vender, cobrar ou oferecer plano. Peça opinião.`
        );
      }
    }
  }

  const presets: Preset[] = (Array.isArray(o.presets) ? o.presets : [])
    .slice(0, LIMITS.maxPresets)
    .map((raw, i) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      return {
        label: str(p.label, `presets[${i}].label`, { max: 40 }),
        // Only a query string, never a URL: a preset must not be able to
        // navigate the user off-site.
        query: str(p.query, `presets[${i}].query`, { max: 200 }).replace(/^[?#]+/, ""),
      };
    });

  return {
    schemaVersion: 1,
    stage,
    summary: str(o.summary, "summary", { max: 500 }),
    buyer: str(o.buyer, "buyer", { max: 200 }),
    problem: str(o.problem, "problem", { max: 500 }),
    targeting,
    probes,
    ranking,
    rubric,
    messaging,
    presets,
  };
}

/** Derives the tier from the fits. Deliberately code, not a model output. */
export function tierFor(fits: Record<string, number | null>): "hot" | "warm" | "cold" | null {
  const values = Object.values(fits).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return null;
  const best = Math.max(...values);
  return best >= 5 ? "hot" : best === 4 ? "warm" : "cold";
}

export function bestFit(fits: Record<string, number | null>): number | null {
  const values = Object.values(fits).filter((v): v is number => typeof v === "number");
  return values.length ? Math.max(...values) : null;
}
