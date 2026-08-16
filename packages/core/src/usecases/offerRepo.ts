import type { Deps } from "../ports/index";
import { parseOfferSpec, type OfferSpec } from "../domain/spec";
import { LEGACY_OFFER_ID, LEGACY_SPEC } from "../domain/legacy";

/**
 * Reading and writing offers. Specs are append-only: `saveSpec` always inserts
 * a new version and never updates one in place, so a score that recorded
 * (offer_id, offer_version) can always be traced back to the exact rubric that
 * produced it.
 */

export interface OfferRow {
  id: string;
  title: string;
  current_version: number;
  active: boolean;
}

export interface LoadedOffer {
  id: string;
  title: string;
  version: number;
  description: string;
  finalidade: string;
  spec: OfferSpec;
}

export async function listOffers(deps: Deps): Promise<OfferRow[]> {
  return deps.db.query<OfferRow>(
    `SELECT id, title, current_version, active FROM offers ORDER BY active DESC, created_at DESC`
  );
}

/** Loads an offer at its current version, validating the stored spec on the way out. */
export async function loadOffer(deps: Deps, id: string): Promise<LoadedOffer> {
  const rows = await deps.db.query<{
    id: string;
    title: string;
    version: number;
    description: string;
    finalidade: string;
    spec: unknown;
  }>(
    `SELECT o.id, o.title, s.version, s.description, s.finalidade, s.spec
       FROM offers o
       JOIN offer_specs s ON s.offer_id = o.id AND s.version = o.current_version
      WHERE o.id = $1`,
    [id]
  );

  const row = rows[0];
  if (!row) {
    const exists = await deps.db.query<{ id: string }>(`SELECT id FROM offers WHERE id = $1`, [id]);
    if (exists.length) {
      throw new Error(
        `Offer "${id}" has no spec for version ${exists[0] ? "current" : "?"}. ` +
          `If this is the original offer, run: pnpm leads offer seed`
      );
    }
    throw new Error(`No offer named "${id}". Run \`pnpm leads offer list\` to see them.`);
  }

  // Stored JSON is re-validated rather than trusted: it may have been written
  // by an older schemaVersion, hand-edited in psql, or produced by a model.
  return { ...row, spec: parseOfferSpec(row.spec) };
}

/** The single offer in flight. One active offer is what keeps campaigns from multiplying contacts. */
export async function activeOffer(deps: Deps): Promise<LoadedOffer> {
  const rows = await deps.db.query<{ id: string }>(`SELECT id FROM offers WHERE active LIMIT 1`);
  if (!rows[0]) {
    throw new Error(
      "No active offer. Activate one with `pnpm leads offer use <id>`, " +
        "or create one with `pnpm leads offer compile`."
    );
  }
  return loadOffer(deps, rows[0].id);
}

/** Resolves an optional --offer flag, falling back to the active offer. */
export async function resolveOffer(deps: Deps, id?: string): Promise<LoadedOffer> {
  return id ? loadOffer(deps, id) : activeOffer(deps);
}

export interface SaveSpecInput {
  offerId: string;
  title?: string;
  description: string;
  finalidade: string;
  spec: OfferSpec;
  compiledBy: string;
  note?: string;
  /** The operator's ideal-customer profile, verbatim. */
  icpText?: string;
  /** What the compiler made of it, criterion by criterion. */
  icpCoverage?: unknown;
}

/** Inserts a new spec version and points the offer at it. Never overwrites. */
export async function saveSpec(deps: Deps, input: SaveSpecInput): Promise<number> {
  // Validate before anything is written, so a bad spec cannot create a version.
  const spec = parseOfferSpec(input.spec);

  return deps.db.withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(
        `INSERT INTO offers (id, title, current_version, active)
         VALUES ($1, $2, 0, FALSE)
         ON CONFLICT (id) DO UPDATE SET title = COALESCE(EXCLUDED.title, offers.title)`,
        [input.offerId, input.title ?? input.offerId]
      );

      const { rows } = await c.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0) + 1 AS version FROM offer_specs WHERE offer_id = $1`,
        [input.offerId]
      );
      const version = rows[0].version;

      await c.query(
        `INSERT INTO offer_specs
           (offer_id, version, description, finalidade, spec, compiled_by, note,
            icp_text, icp_coverage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.offerId,
          version,
          input.description,
          input.finalidade,
          JSON.stringify(spec),
          input.compiledBy,
          input.note ?? null,
          input.icpText ?? null,
          input.icpCoverage ? JSON.stringify(input.icpCoverage) : null,
        ]
      );

      await c.query(`UPDATE offers SET current_version = $2 WHERE id = $1`, [
        input.offerId,
        version,
      ]);

      await c.query("COMMIT");
      return version;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

/**
 * Makes one offer active, deactivating the rest.
 *
 * Two statements in one transaction because `offers_one_active_idx` is a unique
 * partial index: setting the new one first would collide with the old one.
 */
export async function setActive(deps: Deps, id: string): Promise<void> {
  await deps.db.withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const { rowCount } = await c.query(`SELECT 1 FROM offers WHERE id = $1`, [id]);
      if (!rowCount) throw new Error(`No offer named "${id}".`);
      await c.query(`UPDATE offers SET active = FALSE WHERE active`);
      await c.query(`UPDATE offers SET active = TRUE WHERE id = $1`, [id]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

/**
 * Writes the original site/chatbot rubric into the database as offer version 1.
 *
 * Migration 006 creates the `offers` row but not its spec, deliberately: the
 * spec is large and lives in TypeScript (domain/legacy.ts), and duplicating
 * it into a .sql file would create two sources of truth that drift.
 */
export async function seedLegacy(deps: Deps): Promise<{ seeded: boolean; version: number }> {
  const existing = await deps.db.query<{ version: number }>(
    `SELECT version FROM offer_specs WHERE offer_id = $1 ORDER BY version DESC LIMIT 1`,
    [LEGACY_OFFER_ID]
  );
  if (existing.length) {
    return { seeded: false, version: existing[0].version };
  }

  const version = await saveSpec(deps, {
    offerId: LEGACY_OFFER_ID,
    title: "Site e automação de WhatsApp (oferta original)",
    description:
      "Desenvolvedor solo vendendo site/landing page e automação de atendimento no " +
      "WhatsApp para pequenos negócios brasileiros.",
    finalidade:
      "Identificar micro e pequenas empresas brasileiras cujo perfil indique necessidade " +
      "de site/landing page ou automação de atendimento por WhatsApp, para oferta " +
      "comercial direta, individual e de baixo volume. (LIA.md §1)",
    spec: LEGACY_SPEC,
    compiledBy: "human",
    note: "Reconstruída a partir da constante RUBRIC de src/score.ts, anterior à migração 006.",
  });

  return { seeded: true, version };
}
