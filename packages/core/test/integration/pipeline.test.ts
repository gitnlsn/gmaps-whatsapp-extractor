import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, type TestContext } from "../helpers/testDb";
import { makeSpec, seedEnrichment, seedLead, seedOffer } from "../helpers/fixtures";
import { buildShortlist } from "../../src/usecases/shortlist";
import { enrichLeads } from "../../src/usecases/enrichLeads";
import { scoreLeads } from "../../src/usecases/scoreLeads";
import { loadOffer } from "../../src/usecases/offerRepo";
import { Budget, BudgetExceededError } from "../../src/services/budget";
import type { HttpPort, LlmPort } from "../../src/ports/index";

/**
 * Stage behaviour, with the two ports that cost money replaced by doubles.
 *
 * Hitting OpenRouter or Places for real here would burn a 50-request daily
 * quota and a 1,000-call monthly one to assert things that have nothing to do
 * with either vendor.
 */

function stubHttp(body = "<html><head><title>t</title></head><body>oi</body></html>"): HttpPort {
  return { fetch: async () => new Response(body, { status: 200 }) };
}

/** A model that always fails. The point is what the pipeline records when it does. */
function failingLlm(): LlmPort {
  return {
    complete: async () => {
      throw new Error("modelo indisponível (teste)");
    },
    completeJson: async () => {
      throw new Error("modelo indisponível (teste)");
    },
    // Not a ":free" id, so the daily-request guard steps aside and the test is
    // exercising the failure path rather than the budget path.
    modelFor: () => "test/model",
    listFreeModels: async () => [],
  };
}

describe("pipeline stages", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestDb("pipeline");
  });
  after(() => teardownTestDb("pipeline"));

  it("enriches only leads that have never been checked", async () => {
    const fresh = await seedLead(ctx.deps);
    const already = await seedLead(ctx.deps);
    await seedEnrichment(ctx.deps, already, { title: "não me toque" });

    const deps = ctx.withPorts({ http: stubHttp() });
    const result = await enrichLeads(deps, {
      limit: 50,
      concurrency: 2,
      psi: false,
      recheck: false,
    });

    assert.equal(result.checked, 1, "the already-enriched lead must be skipped");

    const rows = await ctx.db.query<{ cnpj: string; title: string | null }>(
      `SELECT cnpj, title FROM enrichment ORDER BY cnpj`
    );
    const kept = rows.find((r) => r.cnpj.trim() === already);
    assert.equal(kept?.title, "não me toque", "an existing row must not be overwritten");
    assert.ok(rows.some((r) => r.cnpj.trim() === fresh));
  });

  it("re-enriches the same lead with --recheck", async () => {
    const deps = ctx.withPorts({ http: stubHttp() });
    const result = await enrichLeads(deps, {
      limit: 50,
      concurrency: 2,
      psi: false,
      recheck: true,
    });
    assert.ok(result.checked >= 2, "recheck must revisit rows that already exist");
  });

  it("records a failed score as NULL with the reason, never a fake number", async () => {
    const cnpj = await seedLead(ctx.deps, { cnae_principal: "8599605" });
    await seedEnrichment(ctx.deps, cnpj);
    await seedOffer(ctx.deps, "score-fail");

    const deps = ctx.withPorts({ llm: failingLlm() });
    const result = await scoreLeads(deps, {
      limit: 10,
      batchSize: 5,
      rescore: false,
      offerId: "score-fail",
    });

    assert.equal(result.scored, 0);
    assert.ok(result.failed > 0);

    const rows = await ctx.db.query<{ best_fit: number | null; error: string | null }>(
      `SELECT best_fit, error FROM scores WHERE offer_id = 'score-fail'`
    );
    assert.ok(rows.length > 0, "a failure must still leave a row — silence is worse");
    for (const r of rows) {
      assert.equal(r.best_fit, null, "an unscored lead must stay distinguishable from a good one");
      assert.match(String(r.error), /modelo indisponível/);
    }
  });

  it("rebuilds a shortlist wholesale without touching scores", async () => {
    await seedOffer(ctx.deps, "rebuild");
    const offer = await loadOffer(ctx.deps, "rebuild");
    const cnpj = await seedLead(ctx.deps, { cnae_principal: "8599605" });

    await buildShortlist(ctx.deps, offer, 100);
    await ctx.db.query(
      `INSERT INTO scores (cnpj, offer_id, offer_version, best_fit, tier)
       VALUES ($1, 'rebuild', 1, 5, 'hot')`,
      [cnpj]
    );

    const first = await ctx.db.query(`SELECT cnpj FROM offer_candidates WHERE offer_id = 'rebuild'`);
    await buildShortlist(ctx.deps, offer, 100);
    const second = await ctx.db.query(`SELECT cnpj FROM offer_candidates WHERE offer_id = 'rebuild'`);

    assert.equal(second.length, first.length, "a rebuild must not duplicate rows");

    const scores = await ctx.db.query(`SELECT cnpj FROM scores WHERE offer_id = 'rebuild'`);
    assert.equal(scores.length, 1, "scores are keyed independently and must survive a rebuild");
  });

  it("ranks deterministically, so equal leads never reorder between runs", async () => {
    await seedOffer(ctx.deps, "determinism", makeSpec({ targeting: { cnaePrefixes: ["4721"] } }));
    const offer = await loadOffer(ctx.deps, "determinism");
    for (let i = 0; i < 5; i++) {
      await seedLead(ctx.deps, { cnae_principal: "4721102", capital_social: 1000 });
    }

    await buildShortlist(ctx.deps, offer, 10);
    const a = await ctx.db.query<{ cnpj: string }>(
      `SELECT cnpj FROM offer_candidates WHERE offer_id = 'determinism' ORDER BY rank_score DESC, cnpj`
    );
    await buildShortlist(ctx.deps, offer, 10);
    const b = await ctx.db.query<{ cnpj: string }>(
      `SELECT cnpj FROM offer_candidates WHERE offer_id = 'determinism' ORDER BY rank_score DESC, cnpj`
    );

    assert.deepEqual(b, a, "before enrichment most terms tie; the tie-break must be stable");
  });

  it("stops at the free ceiling instead of spending", async () => {
    const budget = new Budget(ctx.db, { allowPaid: false });

    await budget.record("details.enterprise", 999);
    await budget.check("details.enterprise"); // 999 < 1000, still free

    await budget.record("details.enterprise", 1);
    await assert.rejects(
      () => budget.check("details.enterprise"),
      BudgetExceededError,
      "the guard must throw rather than spill into paid usage"
    );
  });

  it("honours a per-run request ceiling even below the monthly one", async () => {
    const budget = new Budget(ctx.db, { allowPaid: false, maxRequests: 2 });
    await budget.check("textsearch.essentials");
    await budget.record("textsearch.essentials");
    await budget.check("textsearch.essentials");
    await budget.record("textsearch.essentials");

    await assert.rejects(() => budget.check("textsearch.essentials"), BudgetExceededError);
  });
});
