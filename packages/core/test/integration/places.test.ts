import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, type TestContext } from "../helpers/testDb";
import { makeSpec, seedLead, seedOffer } from "../helpers/fixtures";
import { buildShortlist } from "../../src/usecases/shortlist";
import { loadOffer } from "../../src/usecases/offerRepo";
import { runPlacesEnrichment } from "../../src/usecases/runPlaces";
import type { BudgetPort, PlaceDetails, PlaceRef, PlacesPort } from "../../src/ports/index";

/**
 * Places is the only stage denominated in money: 1,000 Enterprise Details calls
 * per month, which is roughly one month of manual outreach. Which leads it
 * spends those on is therefore not a detail.
 */

/** Records every query it is asked to run, and never touches the network. */
function recordingPlaces(seen: string[]): PlacesPort {
  return {
    async *searchIds(query: string, budget: BudgetPort): AsyncGenerator<PlaceRef[]> {
      seen.push(query);
      await budget.check("textsearch.essentials");
      await budget.record("textsearch.essentials");
      yield [{ id: `place-${seen.length}` }];
    },
    async getDetails(placeId: string, budget: BudgetPort): Promise<PlaceDetails> {
      await budget.check("details.enterprise");
      await budget.record("details.enterprise");
      return { id: placeId, websiteUri: "https://exemplo.com.br" };
    },
    async refreshPlaceId(id) {
      return id;
    },
  };
}

describe("places targeting", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestDb("places");
  });
  after(() => teardownTestDb("places"));

  it("spends the paid quota on the offer's shortlist, in rank order", async () => {
    // An education offer, plus an unrelated dental lead that the old global
    // ordering would happily have burned Enterprise Details calls on.
    await seedOffer(ctx.deps, "edu", makeSpec({ targeting: { cnaePrefixes: ["8599"] } }));

    await seedLead(ctx.deps, {
      cnae_principal: "8599605",
      nome_fantasia: "CURSO ALFA",
      capital_social: 100,
    });
    await seedLead(ctx.deps, {
      cnae_principal: "8599605",
      nome_fantasia: "CURSO BETA",
      capital_social: 900000,
    });
    await seedLead(ctx.deps, { cnae_principal: "8630501", nome_fantasia: "ODONTO GAMA" });

    const offer = await loadOffer(ctx.deps, "edu");
    await buildShortlist(ctx.deps, offer, 100);

    const seen: string[] = [];
    const deps = ctx.withPorts({
      places: recordingPlaces(seen),
      http: { fetch: async () => new Response("<html></html>", { status: 200 }) },
    });

    await runPlacesEnrichment(deps, {
      limit: 10,
      allowPaid: false,
      dryRun: false,
      recheck: false,
      offerId: "edu",
    });

    assert.ok(
      !seen.some((q) => q.includes("ODONTO")),
      "a lead outside the offer must never consume a billable call"
    );
    assert.equal(seen.length, 2, "only the two shortlisted leads");
    assert.ok(
      seen[0].includes("BETA"),
      "higher rank_score goes first, so a run cut short covered the best prospects"
    );
  });

  it("still walks the whole base when no offer is given", async () => {
    const seen: string[] = [];
    const deps = ctx.withPorts({
      places: recordingPlaces(seen),
      http: { fetch: async () => new Response("<html></html>", { status: 200 }) },
    });

    await runPlacesEnrichment(deps, {
      limit: 10,
      allowPaid: false,
      dryRun: false,
      recheck: true,
    });

    assert.ok(
      seen.some((q) => q.includes("ODONTO")),
      "without --offer the previous global behaviour is unchanged"
    );
  });

  it("never spends past the free ceiling, offer or not", async () => {
    await ctx.db.query(
      `INSERT INTO api_usage (day, sku, count) VALUES (CURRENT_DATE, 'details.enterprise', 1000)
       ON CONFLICT (day, sku) DO UPDATE SET count = 1000`
    );

    const seen: string[] = [];
    const deps = ctx.withPorts({
      places: recordingPlaces(seen),
      http: { fetch: async () => new Response("<html></html>", { status: 200 }) },
    });

    const result = await runPlacesEnrichment(deps, {
      limit: 10,
      allowPaid: false,
      dryRun: false,
      recheck: true,
      offerId: "edu",
    });

    assert.equal(result.stoppedOnBudget, true, "the run must stop cleanly, not spill into paid");
    assert.equal(result.found, 0, "no Details call may complete once the allowance is gone");
  });
});
