import { query, withClient } from "./db";
import { completeJson, hasApiKey, modelFor } from "./llm";

/**
 * Deterministic fallback categories, so the planner works with no LLM key.
 * CNAE prefixes are what the Receita loader filters on; the query text is what
 * Places searches for.
 */
const FALLBACK_CATEGORIES: { category: string; cnae: string[]; template: string }[] = [
  { category: "restaurante", cnae: ["5611"], template: "restaurantes em {municipio}, {uf}" },
  { category: "salão de beleza", cnae: ["9602"], template: "salão de beleza em {municipio}, {uf}" },
  { category: "odontologia", cnae: ["8630"], template: "dentista em {municipio}, {uf}" },
  { category: "oficina mecânica", cnae: ["4520"], template: "oficina mecânica em {municipio}, {uf}" },
  { category: "academia", cnae: ["9313"], template: "academia em {municipio}, {uf}" },
  { category: "pet shop", cnae: ["4789"], template: "pet shop em {municipio}, {uf}" },
  { category: "clínica", cnae: ["8630"], template: "clínica em {municipio}, {uf}" },
  { category: "barbearia", cnae: ["9602"], template: "barbearia em {municipio}, {uf}" },
];

const CATEGORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categories"],
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "cnae_prefixes", "query_template", "rationale"],
        properties: {
          category: { type: "string" },
          cnae_prefixes: { type: "array", items: { type: "string" } },
          query_template: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM = `Você planeja buscas para encontrar pequenos negócios brasileiros que
precisam de site ou de automação de atendimento no WhatsApp.

Devolva CATEGORIAS de negócio, não cidades — a lista de municípios vem do IBGE.

Para cada categoria:
- "category": nome curto em português
- "cnae_prefixes": prefixos de CNAE reais (4 dígitos) que capturam essa atividade.
  Só use prefixos que você tem certeza que existem.
- "query_template": texto de busca contendo os marcadores {municipio} e {uf}
- "rationale": por que esse ramo compra site ou chatbot

Priorize ramos que: atendem consumidor final, marcam horário ou recebem pedidos,
têm movimento constante, e normalmente têm presença digital fraca.`;

export interface PlanOptions {
  intent: string;
  maxMunicipios: number;
  dryRun: boolean;
}

interface CategorySpec {
  category: string;
  cnae_prefixes: string[];
  query_template: string;
  rationale?: string;
}

async function planCategories(intent: string): Promise<CategorySpec[]> {
  if (!hasApiKey()) {
    console.log("No OpenRouter key — using the built-in category list.");
    return FALLBACK_CATEGORIES.map((c) => ({
      category: c.category,
      cnae_prefixes: c.cnae,
      query_template: c.template,
    }));
  }

  try {
    const { value } = await completeJson<{ categories: CategorySpec[] }>({
      task: "plan",
      schema: CATEGORY_SCHEMA,
      schemaName: "categories",
      maxTokens: 2000,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Intenção: ${intent}\n\nDevolva de 8 a 15 categorias.` },
      ],
    });

    const valid = value.categories.filter(
      (c) =>
        c.query_template?.includes("{municipio}") && c.cnae_prefixes?.length > 0
    );

    if (valid.length === 0) {
      console.warn("Model returned no usable categories — falling back to the static list.");
      return FALLBACK_CATEGORIES.map((c) => ({
        category: c.category,
        cnae_prefixes: c.cnae,
        query_template: c.template,
      }));
    }
    console.log(`Planner (${modelFor("plan")}) returned ${valid.length} categories.`);
    return valid;
  } catch (err) {
    console.warn(`Planner failed (${(err as Error).message}). Using the static list.`);
    return FALLBACK_CATEGORIES.map((c) => ({
      category: c.category,
      cnae_prefixes: c.cnae,
      query_template: c.template,
    }));
  }
}

export async function buildPlan(opts: PlanOptions): Promise<void> {
  const categories = await planCategories(opts.intent);

  // Population order is the whole point: the largest municipalities hold most
  // of the addressable businesses, so the queue is worked top-down and can be
  // stopped at any point without leaving the best markets untouched.
  const municipios = await query<{ id: number; nome: string; uf: string; populacao: number }>(
    `SELECT id, nome, uf, COALESCE(populacao, 0) AS populacao
     FROM municipios
     ORDER BY populacao DESC NULLS LAST
     LIMIT $1`,
    [opts.maxMunicipios]
  );

  if (municipios.length === 0) {
    throw new Error("No municípios loaded. Run `npm run ibge` first.");
  }

  const rows: { text: string; category: string; cnae: string[]; municipioId: number; priority: number }[] =
    [];

  for (const m of municipios) {
    for (const c of categories) {
      rows.push({
        text: c.query_template.replace("{municipio}", m.nome).replace("{uf}", m.uf),
        category: c.category,
        cnae: c.cnae_prefixes,
        municipioId: m.id,
        priority: m.populacao,
      });
    }
  }

  console.log(
    `\n${categories.length} categories x ${municipios.length} municípios = ` +
      `${rows.length.toLocaleString()} queries.`
  );

  const cnaes = [...new Set(categories.flatMap((c) => c.cnae_prefixes))].sort();
  console.log(`\nCNAE prefixes for \`npm run load --cnae\`:\n  ${cnaes.join(",")}`);

  if (opts.dryRun) {
    console.log("\nFirst 15 queries:");
    for (const r of rows.slice(0, 15)) console.log(`  ${r.text}`);
    console.log(
      `\n--dry-run: nothing written, no API calls made.\n` +
        `Places discovery would cost ${rows.length} Text Search (Essentials) requests\n` +
        `at up to 3 pages each — free tier is 10,000/month.`
    );
    return;
  }

  await withClient(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO queries (text, category, cnae_codes, municipio_id, priority)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (text) DO UPDATE SET priority = EXCLUDED.priority`,
        [r.text, r.category, r.cnae, r.municipioId, r.priority]
      );
    }
  });

  console.log(`\nWrote ${rows.length.toLocaleString()} queries to the queue.`);
}
