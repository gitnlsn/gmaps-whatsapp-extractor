import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, type TestContext } from "../helpers/testDb";
import { makeSpec, seedLead, seedOffer } from "../helpers/fixtures";
import { buildShortlist, countReach } from "../../src/usecases/shortlist";
import { loadOffer, setActive } from "../../src/usecases/offerRepo";
import { migrateSchema } from "../../src/usecases/migrateSchema";

/**
 * The LGPD safeguards from LIA.md §5.
 *
 * Two of these were broken in production and the LIA records it: the
 * one-contact-per-phone index did not apply to anything the dashboard wrote,
 * and the daily cap failed open. Both were invisible failures — the code looked
 * right and the guarantee was gone. That is exactly the class of bug a test
 * against the real schema catches and a unit test cannot.
 */
describe("safeguards", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestDb("safeguards");
  });
  after(() => teardownTestDb("safeguards"));

  it("never shortlists a suppressed phone number", async () => {
    const kept = await seedLead(ctx.deps, { phone_e164: "+5511900000001" });
    const suppressed = await seedLead(ctx.deps, { phone_e164: "+5511900000002" });

    await ctx.db.query(
      `INSERT INTO suppression (phone_e164, reason) VALUES ($1, 'opt-out no teste')`,
      ["+5511900000002"]
    );

    await seedOffer(ctx.deps, "sup-test");
    const offer = await loadOffer(ctx.deps, "sup-test");
    await buildShortlist(ctx.deps, offer, 100);

    const rows = await ctx.db.query<{ cnpj: string }>(
      `SELECT cnpj FROM offer_candidates WHERE offer_id = 'sup-test'`
    );
    const cnpjs = rows.map((r) => r.cnpj.trim());

    assert.ok(cnpjs.includes(kept), "a lead with no suppression must be shortlisted");
    assert.ok(
      !cnpjs.includes(suppressed),
      "a suppressed phone must be excluded at Stage 0, before any spend"
    );
  });

  it("excludes an already-contacted phone, even on a different CNPJ", async () => {
    // One human, two companies, one phone. LIA.md §5: dedup is by phone, not by
    // CNPJ, precisely so a second campaign cannot reach the same person twice.
    const phone = "+5511900000010";
    const first = await seedLead(ctx.deps, { phone_e164: phone });
    const second = await seedLead(ctx.deps, { phone_e164: phone });

    await seedOffer(ctx.deps, "touch-test");
    await ctx.db.query(
      `INSERT INTO outreach (cnpj, status, offer_id, phone_e164)
       VALUES ($1, 'sent', 'touch-test', $2)`,
      [first, phone]
    );

    const offer = await loadOffer(ctx.deps, "touch-test");
    await buildShortlist(ctx.deps, offer, 100);

    const rows = await ctx.db.query<{ cnpj: string }>(
      `SELECT cnpj FROM offer_candidates WHERE offer_id = 'touch-test'`
    );
    const cnpjs = rows.map((r) => r.cnpj.trim());

    assert.ok(!cnpjs.includes(first), "the contacted CNPJ must not come back");
    assert.ok(
      !cnpjs.includes(second),
      "a different CNPJ sharing the phone must not come back either — one human, one contact"
    );
  });

  it("refuses a second outreach row for a phone already contacted", async () => {
    const phone = "+5511900000020";
    const a = await seedLead(ctx.deps, { phone_e164: phone });
    const b = await seedLead(ctx.deps, { phone_e164: phone });
    await seedOffer(ctx.deps, "dup-test");

    await ctx.db.query(
      `INSERT INTO outreach (cnpj, status, offer_id, phone_e164) VALUES ($1, 'sent', 'dup-test', $2)`,
      [a, phone]
    );

    // The guarantee is the database's, not the application's: two interleaved
    // server actions cannot both pass a SELECT-then-INSERT guard.
    await assert.rejects(
      () =>
        ctx.db.query(
          `INSERT INTO outreach (cnpj, status, offer_id, phone_e164)
           VALUES ($1, 'sent', 'dup-test', $2)`,
          [b, phone]
        ),
      (err: { code?: string }) => err.code === "23505",
      "outreach_one_per_phone_idx must reject the second contact"
    );
  });

  it("keeps exactly one offer active", async () => {
    await seedOffer(ctx.deps, "active-a");
    await seedOffer(ctx.deps, "active-b");
    await setActive(ctx.deps, "active-a");
    await setActive(ctx.deps, "active-b");

    const rows = await ctx.db.query<{ id: string }>(`SELECT id FROM offers WHERE active`);
    assert.equal(rows.length, 1, "offers_one_active_idx must permit only one");
    assert.equal(rows[0].id, "active-b");
  });

  it("allows only one running job at a time", async () => {
    await ctx.db.query(`INSERT INTO jobs (kind, args, status) VALUES ('enrich', '{}', 'running')`);

    await assert.rejects(
      () =>
        ctx.db.query(`INSERT INTO jobs (kind, args, status) VALUES ('score', '{}', 'running')`),
      (err: { code?: string }) => err.code === "23505",
      "jobs_one_running_idx is what stops two pipelines racing"
    );

    // A finished job must not block the next one.
    await ctx.db.query(`UPDATE jobs SET status = 'done' WHERE status = 'running'`);
    await ctx.db.query(`INSERT INTO jobs (kind, args, status) VALUES ('score', '{}', 'running')`);
    await ctx.db.query(`UPDATE jobs SET status = 'done' WHERE status = 'running'`);
  });

  it("re-running migrate changes nothing", async () => {
    const before = await ctx.db.query<{ name: string }>(`SELECT name FROM _migrations ORDER BY name`);
    await migrateSchema(ctx.deps);
    const after = await ctx.db.query<{ name: string }>(`SELECT name FROM _migrations ORDER BY name`);
    assert.deepEqual(after, before);
  });

  it("counts only reachable leads at Stage 0", async () => {
    await seedOffer(ctx.deps, "reach-test", makeSpec({ targeting: { cnaePrefixes: ["4711"] } }));
    const offer = await loadOffer(ctx.deps, "reach-test");

    await seedLead(ctx.deps, { cnae_principal: "4711302", phone_e164: "+5511900000030" });
    await seedLead(ctx.deps, { cnae_principal: "4711302", phone_e164: null, is_mobile: null });
    await seedLead(ctx.deps, { cnae_principal: "4711302", situacao: "BAIXADA" });

    const counts = await countReach(ctx.deps, offer);
    assert.equal(counts.matched, 1, "no phone and not ACTIVE are both disqualifying");
  });
});
