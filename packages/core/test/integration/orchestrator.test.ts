import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, type TestContext } from "../helpers/testDb";
import { makeSpec, seedEnrichment, seedLead, seedOffer } from "../helpers/fixtures";
import { runOfferPipeline } from "../../src/usecases/runOfferPipeline";
import type { HttpPort, LlmPort } from "../../src/ports/index";

/**
 * The orchestrator. What matters is the order, what happens when a quota runs
 * out mid-run, and — above everything — that "run the whole pipeline" still
 * ends at a pile of leads for a human rather than at a message.
 */

const okHttp: HttpPort = {
  fetch: async () => new Response("<html><body>cursos e simulados</body></html>", { status: 200 }),
};

/** Refuses every call, the way an exhausted free tier does. */
function deadLlm(): LlmPort {
  return {
    complete: async () => {
      throw new Error("sem cota");
    },
    completeJson: async () => {
      throw new Error("sem cota");
    },
    modelFor: () => "test/model",
    listFreeModels: async () => [],
  };
}

describe("offer pipeline", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestDb("orchestrator");
    await seedOffer(ctx.deps, "camp", makeSpec({ targeting: { cnaePrefixes: ["8599"] } }));
    for (let i = 0; i < 4; i++) {
      await seedLead(ctx.deps, { cnae_principal: "8599605", capital_social: 1000 * (i + 1) });
    }
  });
  after(() => teardownTestDb("orchestrator"));

  it("runs the stages in dependency order and records each one", async () => {
    const deps = ctx.withPorts({ http: okHttp });
    const result = await runOfferPipeline(deps, {
      offerId: "camp",
      places: 0,
      enrich: 4,
      score: 0,
    });

    assert.equal(result.status, "done");
    assert.deepEqual(
      result.steps.map((s) => s.key),
      ["shortlist", "enrich", "reshortlist", "rollups"],
      "shortlist must precede enrich, and the re-rank must follow it"
    );
    assert.ok(result.steps.every((s) => s.status === "done"));

    const [row] = await ctx.db.query<{ status: string; n: string }>(
      `SELECT status, jsonb_array_length(steps)::text AS n FROM pipeline_runs WHERE id = $1`,
      [result.runId]
    );
    assert.equal(row.status, "done", "the run row must be closed out, not left running");
    assert.equal(Number(row.n), 4);
  });

  it("treats an exhausted quota as a finished stage, not a failed run", async () => {
    for (const c of await ctx.db.query<{ cnpj: string }>(`SELECT cnpj FROM leads`)) {
      await seedEnrichment(ctx.deps, c.cnpj.trim()).catch(() => {});
    }

    const deps = ctx.withPorts({ http: okHttp, llm: deadLlm() });
    const result = await runOfferPipeline(deps, {
      offerId: "camp",
      places: 0,
      enrich: 0,
      score: 4,
      // A ceiling of zero: the guard must refuse before the first request.
      llmDailyRequests: 1,
    });

    // The model is dead, but the run still completes and the later stages run.
    assert.notEqual(result.status, "failed");
    const rollups = result.steps.find((s) => s.key === "rollups");
    assert.equal(rollups?.status, "done", "a dead model must not skip the rollup refresh");
  });

  it("never contacts anybody", async () => {
    const before = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM outreach`);

    const deps = ctx.withPorts({ http: okHttp });
    await runOfferPipeline(deps, { offerId: "camp", places: 0, enrich: 4, score: 0 });

    const after = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM outreach`);
    assert.equal(
      after[0].n,
      before[0].n,
      "the whole point: running everything produces leads to review, never a message"
    );
  });

  it("a dry run leaves no half-open run behind", async () => {
    const deps = ctx.withPorts({ http: okHttp });
    await runOfferPipeline(deps, { offerId: "camp", dryRun: true });

    const [row] = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pipeline_runs WHERE status = 'running'`
    );
    assert.equal(row.n, "0", "a dry run that recorded a row would read as a stuck pipeline");
  });
});
