import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, type TestContext } from "../helpers/testDb";
import { seedLead } from "../helpers/fixtures";
import { runOfferPipeline } from "../../src/usecases/runOfferPipeline";
import type { LlmPort } from "../../src/ports/index";

/**
 * Idea in, ranked companies out — the `offer new` path.
 *
 * The two things worth pinning down are that the written profile's unmappable
 * criteria survive as a record rather than vanishing, and that this path stays
 * free: it must not score, and it must not touch the Places budget.
 */

const TARGETING = {
  cnaePrefixes: ["8599"],
  rationale: "cursos livres",
  channels: ["mobile", "landline"],
  excludeMei: true,
  naturezaPrefixes: ["2", "3"],
  probes: [],
  ftsTerms: [],
  icpCoverage: [
    { criterion: "escolas particulares", mapped: true, mappedTo: "CNAE 8599" },
    { criterion: "não-MEI", mapped: true, mappedTo: "excludeMei" },
    {
      criterion: "mais de 50 funcionários",
      mapped: false,
      mappedTo: "a base não traz quadro de pessoal",
    },
  ],
};

const RUBRIC = {
  stage: "live",
  summary: "simulados para escolas",
  buyer: "coordenador pedagógico",
  problem: "montar listas de exercícios à mão",
  axes: [
    {
      key: "fit",
      label: "Fit",
      question: "Serve?",
      anchors: { "1": "não", "2": "quase não", "3": "talvez", "4": "sim", "5": "muito sim" },
    },
  ],
  recommendations: [{ value: "sim", label: "é cliente", when: "encaixa" }],
  notes: [],
  hookBad: [],
  hookGood: [],
  siteSignals: "full",
  messaging: {
    senderRole: "desenvolvedor",
    productNoun: "um app de simulados",
    goal: "sell",
    asks: ["Como vocês montam as listas hoje?"],
    fallbackAsk: "Como vocês montam as listas hoje?",
    forbidden: [],
  },
};

/** Answers the two compile calls in order, and records what it was asked. */
function scriptedLlm(prompts: string[]): LlmPort {
  let call = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeJson: async (o) => {
      prompts.push(o.messages.map((m) => m.content).join("\n---\n"));
      const value = call++ === 0 ? TARGETING : RUBRIC;
      return {
        value: value as never,
        usage: { promptTokens: 0, completionTokens: 0 },
        model: "test/model",
      };
    },
    modelFor: () => "test/model",
    listFreeModels: async () => [],
  };
}

describe("campaign from an idea", () => {
  let ctx: TestContext;
  const prompts: string[] = [];

  before(async () => {
    ctx = await setupTestDb("campaign");
    for (let i = 0; i < 3; i++) {
      await seedLead(ctx.deps, { cnae_principal: "8599605", natureza_juridica: "2062" });
    }
  });
  after(() => teardownTestDb("campaign"));

  it("compiles, checks the CNAEs and ranks — in that order", async () => {
    const deps = ctx.withPorts({ llm: scriptedLlm(prompts) });

    const result = await runOfferPipeline(deps, {
      compile: {
        slug: "ideia",
        title: "Ideia",
        finalidade: "testar — sem contato real",
        description: "App que gera simulados a partir do conteúdo da escola.",
        idealCustomer: "escolas particulares, não-MEI, com mais de 50 funcionários",
      },
      places: 0,
      enrich: 0,
      score: 0,
      reshortlist: false,
    });

    assert.equal(result.status, "done");
    assert.deepEqual(
      result.steps.map((s) => s.key),
      ["compile", "cnaeCheck", "shortlist", "rollups"],
      "the offer has to exist before anything can be checked or ranked against it"
    );
    assert.ok(result.steps.every((s) => s.status === "done"));

    const rows = await ctx.db.query(`SELECT cnpj FROM offer_candidates WHERE offer_id = 'ideia'`);
    assert.ok(rows.length > 0, "the run should end with a ranked list, not just a spec");
  });

  it("hands the written profile to the targeting call as a requirement", async () => {
    assert.match(prompts[0], /Perfil do cliente ideal/);
    assert.match(prompts[0], /mais de 50 funcion/);
    assert.match(prompts[0], /requisito/, "the profile must not read as a mere suggestion");
  });

  it("hands the profile to the rubric call too, minus what cannot be observed", async () => {
    // The axes are what the scorer actually grades on. A rubric written blind
    // to the stated profile produces scores that ignore it.
    assert.match(prompts[1], /Perfil do cliente ideal/);
    assert.match(prompts[1], /não-MEI/);
    assert.match(
      prompts[1],
      /NÃO crie eixo para estes critérios/,
      "unobservable criteria must be named as forbidden, not left to a general rule"
    );
    assert.match(prompts[1], /mais de 50 funcion.*quadro de pessoal/s);
  });

  it("records which criteria could not become filters", async () => {
    const [row] = await ctx.db.query<{ icp_text: string; icp_coverage: unknown }>(
      `SELECT icp_text, icp_coverage FROM offer_specs WHERE offer_id = 'ideia'`
    );
    assert.match(row.icp_text, /não-MEI/, "the profile is kept verbatim");

    const coverage = row.icp_coverage as { criterion: string; mapped: boolean }[];
    const unmapped = coverage.filter((c) => !c.mapped);
    assert.equal(unmapped.length, 1);
    assert.match(
      unmapped[0].criterion,
      /funcion/,
      "headcount has no column, and the operator must be told rather than left to assume"
    );
  });

  it("spends nothing beyond the two compile calls", async () => {
    const [scores] = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM scores WHERE offer_id = 'ideia'`
    );
    assert.equal(scores.n, "0", "scoring is a separate, labelled decision");

    const [google] = await ctx.db.query<{ n: string }>(
      `SELECT COALESCE(sum(count), 0)::text AS n FROM api_usage`
    );
    assert.equal(google.n, "0", "the paid API must not be touched by the free path");
  });

  it("leaves no offer behind when the model fails", async () => {
    const deps = ctx.withPorts({
      llm: {
        complete: async () => {
          throw new Error("modelo fora do ar");
        },
        completeJson: async () => {
          throw new Error("modelo fora do ar");
        },
        modelFor: () => "test/model",
        listFreeModels: async () => [],
      },
    });

    const result = await runOfferPipeline(deps, {
      compile: {
        slug: "nasceu-morta",
        finalidade: "testar",
        description: "qualquer coisa",
      },
      places: 0,
      enrich: 0,
      score: 0,
      reshortlist: false,
    });

    assert.equal(result.status, "failed");
    const [row] = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM offers WHERE id = 'nasceu-morta'`
    );
    assert.equal(row.n, "0", "a failed compile must not leave a half-created offer");

    const [run] = await ctx.db.query<{ status: string }>(
      `SELECT status FROM pipeline_runs WHERE offer_id = 'nasceu-morta'`
    );
    assert.equal(run.status, "failed", "but the attempt itself stays on the record");
  });
});
