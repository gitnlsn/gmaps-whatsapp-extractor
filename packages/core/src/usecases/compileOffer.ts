import { requireLlm, type Deps } from "../ports/index";
import { createLlmBudget } from "../services/llmBudget";
import { parseOfferSpec, type OfferSpec } from "../domain/spec";

/**
 * Turns a free-text product description into a structured OfferSpec.
 *
 * This replaces src/planner.ts, whose only durable value was turning an intent
 * into CNAE prefixes — it wrote its output to a `queries` table that nothing
 * ever read.
 *
 * Two calls rather than one. Free structured-output models fail long
 * `strict: true` schemas fairly reliably, and the two halves are independently
 * reviewable and independently retryable: if the rubric comes back weak you do
 * not want to re-roll the targeting you already checked.
 *
 * Nothing here is trusted. The output goes through `parseOfferSpec`, and the
 * CNAE prefixes are checked against actually-loaded data by `validateCnaes`
 * before a single token is spent on scoring.
 */

// ------------------------------------------------------------------ call 1

const TARGETING_SYSTEM = `Você traduz a descrição de um produto em um PERFIL DE CLIENTE IDEAL
pesquisável na base de dados abertos da Receita Federal brasileira.

Você NÃO sabe quais empresas existem. Não invente empresa, número ou mercado.

CNAE — a regra mais importante:
- Devolva prefixos de que você tem CERTEZA. É MUITO melhor devolver um prefixo
  curto e abrangente ("85") do que um código de 7 dígitos inventado.
- O sistema vai CONFERIR cada prefixo contra os dados realmente carregados e
  descartar os que não existem. Um prefixo errado não passa despercebido — só
  faz a campanha perder alcance.
- Prefixos têm de 2 a 7 dígitos, só números, sem pontuação.

Os ÚNICOS fatos disponíveis por empresa são:
  cadastro: CNPJ, razão social, nome fantasia, CNAE, natureza jurídica, porte,
            capital social, opção MEI, data de abertura, município/UF, telefone, e-mail
  site:     se responde, se está morto, se é só Instagram/Linktree, plataforma,
            ano no rodapé, e o TEXTO da página inicial
NÃO existem: faturamento, número de funcionários, número de alunos, stack,
contratos, tráfego. Nunca peça um sinal que não esteja nessa lista.

natureza jurídica (primeiro dígito) — use para excluir quem não pode comprar:
  "1" = administração pública (só compra por licitação)
  "2" = empresa privada
  "3" = entidade sem fins lucrativos (muita escola privada é associação!)

channels: "mobile" = celular (WhatsApp direto), "landline" = fixo.
  Instituições (escola, faculdade, hospital) registram FIXO. Se o alvo for
  institucional, inclua "landline" ou você perde a maior parte do mercado.

excludeMei: MEI é uma pessoa só. Para venda institucional, quase sempre true.

probes: palavras EXATAS em português que apareceriam no SITE da própria empresa
e que indicam o problema que o produto resolve, ou que ela já compra software
desse tipo. Termos literais, sem regex, sem curinga.`;

const TARGETING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cnaePrefixes", "rationale", "channels", "excludeMei", "naturezaPrefixes", "probes", "ftsTerms"],
  properties: {
    cnaePrefixes: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
    channels: { type: "array", items: { type: "string", enum: ["mobile", "landline"] } },
    excludeMei: { type: "boolean" },
    naturezaPrefixes: { type: "array", items: { type: "string", enum: ["1", "2", "3", "4"] } },
    minAgeYears: { type: ["integer", "null"] },
    probes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "terms", "meaning"],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          terms: { type: "array", items: { type: "string" } },
          meaning: { type: "string", enum: ["positive", "negative"] },
        },
      },
    },
    ftsTerms: { type: "array", items: { type: "string" } },
  },
} as const;

// ------------------------------------------------------------------ call 2

const RUBRIC_SYSTEM = `Você define como PONTUAR empresas como compradoras de um produto.

axes: 1 a 3 eixos, nota de 1 a 5. Menos é melhor: 2 costuma bastar.
- Nota MAIOR significa SEMPRE cliente MELHOR para quem vende. Nunca inverta.
- Cada âncora precisa ser concreta e VERIFICÁVEL nos fatos disponíveis
  (cadastro + sinais do site + texto da home). Se a âncora depender de algo
  que não dá para observar (faturamento, nº de alunos), o eixo não presta.
- key: minúsculas, sem acento, formato snake_case, ex: "dor_exames".

stage: "presell" se a descrição indicar que o produto ainda NÃO existe.
Se stage = presell, a mensagem NÃO pode oferecer teste, preço, plano ou
demonstração, e os "asks" têm de pedir OPINIÃO, não venda.

messaging.senderRole: como o remetente se apresenta em 3-4 palavras,
ex: "tô construindo um app", "sou desenvolvedor".

hookBad: frases que seriam MENTIRA ou presunção para este produto.
hookGood: frases boas, citando fato observável e terminando em pergunta.`;

const RUBRIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stage", "summary", "buyer", "problem", "axes", "recommendations", "notes", "hookBad", "hookGood", "siteSignals", "messaging"],
  properties: {
    stage: { type: "string", enum: ["presell", "beta", "live"] },
    summary: { type: "string" },
    buyer: { type: "string" },
    problem: { type: "string" },
    axes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "question", "anchors"],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          question: { type: "string" },
          anchors: {
            type: "object",
            additionalProperties: false,
            required: ["1", "2", "3", "4", "5"],
            properties: {
              "1": { type: "string" },
              "2": { type: "string" },
              "3": { type: "string" },
              "4": { type: "string" },
              "5": { type: "string" },
            },
          },
        },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "label", "when"],
        properties: {
          value: { type: "string" },
          label: { type: "string" },
          when: { type: "string" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
    hookBad: { type: "array", items: { type: "string" } },
    hookGood: { type: "array", items: { type: "string" } },
    siteSignals: { type: "string", enum: ["full", "minimal", "none"] },
    messaging: {
      type: "object",
      additionalProperties: false,
      required: ["senderRole", "productNoun", "goal", "asks", "fallbackAsk", "forbidden"],
      properties: {
        senderRole: { type: "string" },
        productNoun: { type: "string" },
        goal: { type: "string", enum: ["validate", "demo", "sell"] },
        asks: { type: "array", items: { type: "string" } },
        fallbackAsk: { type: "string" },
        forbidden: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

// ---------------------------------------------------------------- compiler

export interface CompileResult {
  spec: OfferSpec;
  model: string;
  rationale: string;
}

/**
 * Trims model output to the shape the validator accepts.
 *
 * The split of responsibility matters: `parseOfferSpec` stays strict because it
 * guards everything that reaches SQL or a prompt, but rejecting a whole compile
 * because a column header came back at 47 characters would be user-hostile.
 * Cosmetic overruns are clamped here; anything semantic still fails loudly.
 */
const clamp = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Model-invented keys drift toward accents and camelCase; force the allowed shape. */
function slugKey(v: unknown, fallback: string): string {
  const s = String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return /^[a-z][a-z0-9_]{2,30}$/.test(s) ? s : fallback;
}

export interface CompileOptions {
  /** Daily free-tier request ceiling, resolved by the app. */
  llmDailyRequests?: number;
}

export async function compileOffer(
  deps: Deps,
  description: string,
  opts: CompileOptions = {}
): Promise<CompileResult> {
  if (!deps.llm) {
    throw new Error(
      "OPEN_ROUTER_API_KEY is not set — compiling an offer needs a model. " +
        "You can still write a spec by hand and load it with `offer import`."
    );
  }
  const llm = requireLlm(deps);
  const model = llm.modelFor("compile");

  // `scoreLeads` has always refused before its first request rather than dying
  // halfway; compiling never did, which stopped mattering the moment a button
  // in a browser could start it and a pipeline could start with it.
  const budget = createLlmBudget(deps.db, { dailyRequests: opts.llmDailyRequests });
  await budget.checkBudget(model, 2);

  deps.progress.stage("compile", "Compilando descrição em perfil de cliente", 2);
  const { value: t } = await llm.completeJson<Record<string, any>>({
    task: "compile",
    schema: TARGETING_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "offer_targeting",
    maxTokens: 2000,
    messages: [
      { role: "system", content: TARGETING_SYSTEM },
      { role: "user", content: `Produto:\n${description}` },
    ],
  });

  deps.progress.tick(1, "alvo definido");
  const { value: r } = await llm.completeJson<Record<string, any>>({
    task: "compile",
    schema: RUBRIC_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "offer_rubric",
    maxTokens: 3000,
    messages: [
      { role: "system", content: RUBRIC_SYSTEM },
      {
        role: "user",
        content:
          `Produto:\n${description}\n\n` +
          `Alvo já definido: CNAE ${(t.cnaePrefixes ?? []).join(", ")}, ` +
          `canais ${(t.channels ?? []).join("/")}.`,
      },
    ],
  });

  // Assembled here rather than asked of the model: weights are ours, and the
  // model has no basis for choosing them.
  const spec = parseOfferSpec({
    schemaVersion: 1,
    stage: r.stage,
    summary: r.summary,
    buyer: r.buyer,
    problem: r.problem,
    targeting: {
      cnaePrefixes: t.cnaePrefixes,
      cnaeExclude: [],
      channels: t.channels,
      ufs: [],
      naturezaPrefixes: t.naturezaPrefixes,
      porteIn: [],
      minCapitalSocial: null,
      excludeMei: t.excludeMei,
      minAgeYears: t.minAgeYears ?? null,
      maxAgeYears: null,
      requireNomeFantasia: true,
    },
    probes: (t.probes ?? []).slice(0, 12).map((p: Record<string, unknown>, i: number) => ({
      key: slugKey(p.key, `probe_${i + 1}`),
      label: clamp(p.label, 80) || `sinal ${i + 1}`,
      terms: (Array.isArray(p.terms) ? p.terms : []).slice(0, 20).map((x) => clamp(x, 40)).filter(Boolean),
      meaning: p.meaning === "negative" ? "negative" : "positive",
      weight: 1,
    })).filter((p: { terms: string[] }) => p.terms.length > 0),
    ranking: { ftsTerms: (t.ftsTerms ?? []).slice(0, 20).map((x: unknown) => clamp(x, 40)) },
    rubric: {
      // Capped at 3: each axis multiplies output tokens per lead, and free
      // structured-output models degrade on long schemas.
      axes: (r.axes ?? []).slice(0, 3).map((a: Record<string, any>, i: number) => ({
        key: slugKey(a.key, `fit_${i + 1}`),
        label: clamp(a.label, 40) || `eixo ${i + 1}`,
        question: clamp(a.question, 200),
        anchors: a.anchors,
      })),
      recommendations: (r.recommendations ?? []).slice(0, 6).map((rec: Record<string, any>, i: number) => ({
        value: slugKey(rec.value, `opcao_${i + 1}`).slice(0, 20),
        label: clamp(rec.label, 60) || `opção ${i + 1}`,
        when: clamp(rec.when, 200),
      })),
      notes: (r.notes ?? []).slice(0, 12).map((x: unknown) => clamp(x, 300)).filter(Boolean),
      hookBad: (r.hookBad ?? []).slice(0, 6).map((x: unknown) => clamp(x, 300)).filter(Boolean),
      hookGood: (r.hookGood ?? []).slice(0, 6).map((x: unknown) => clamp(x, 300)).filter(Boolean),
      siteSignals: r.siteSignals,
    },
    messaging: {
      senderRole: clamp(r.messaging?.senderRole, 100),
      productNoun: clamp(r.messaging?.productNoun, 160),
      goal: r.messaging?.goal,
      asks: (r.messaging?.asks ?? []).slice(0, 6).map((x: unknown) => clamp(x, 200)).filter(Boolean),
      fallbackAsk: clamp(r.messaging?.fallbackAsk, 200),
      forbidden: (r.messaging?.forbidden ?? []).slice(0, 12).map((x: unknown) => clamp(x, 120)).filter(Boolean),
    },
    presets: [],
  });

  return { spec, model, rationale: String(t.rationale ?? "") };
}

// ------------------------------------------------------- CNAE verification

export interface CnaeCheck {
  prefix: string;
  leads: number;
  reachable: number;
  descricao: string | null;
  /** ok = has leads; not_loaded = real code, no data; unknown = not a real code. */
  status: "ok" | "not_loaded" | "unknown";
}

/**
 * Checks compiled CNAE prefixes against reality.
 *
 * The compiler WILL produce plausible, wrong codes — this is not a maybe. Two
 * failure modes look identical from a count of zero and need opposite fixes:
 * a code that does not exist (drop it) versus a real code whose slice was never
 * downloaded (load it). The join against `cnaes` is what tells them apart.
 */
export async function validateCnaes(
  deps: Deps,
  prefixes: string[],
  channels: string[] = ["mobile", "landline"]
): Promise<CnaeCheck[]> {
  if (!prefixes.length) return [];

  const wantsMobile = channels.includes("mobile");
  const wantsLandline = channels.includes("landline");
  const channelSql =
    wantsMobile && wantsLandline
      ? "l.phone_e164 IS NOT NULL"
      : wantsMobile
        ? "l.is_mobile IS TRUE"
        : "l.is_mobile IS NOT TRUE AND l.phone_e164 IS NOT NULL";

  const rows = await deps.db.query<{
    prefix: string;
    leads: string;
    reachable: string;
    in_dict: string;
    descricao: string | null;
  }>(
    `SELECT p.prefix,
            (SELECT count(*) FROM leads l
              WHERE l.cnae_principal LIKE p.prefix || '%'
                AND l.situacao = 'ATIVA')::text AS leads,
            (SELECT count(*) FROM leads l
              WHERE l.cnae_principal LIKE p.prefix || '%'
                AND l.situacao = 'ATIVA' AND ${channelSql})::text AS reachable,
            (SELECT count(*) FROM cnaes c WHERE c.codigo LIKE p.prefix || '%')::text AS in_dict,
            (SELECT c.descricao FROM cnaes c
              WHERE c.codigo LIKE p.prefix || '%' ORDER BY c.codigo LIMIT 1) AS descricao
       FROM unnest($1::text[]) AS p(prefix)`,
    [prefixes]
  );

  return rows.map((r) => {
    const leads = Number(r.leads);
    const inDict = Number(r.in_dict);
    return {
      prefix: r.prefix,
      leads,
      reachable: Number(r.reachable),
      descricao: r.descricao,
      status: leads > 0 ? "ok" : inDict > 0 ? "not_loaded" : "unknown",
    };
  });
}
