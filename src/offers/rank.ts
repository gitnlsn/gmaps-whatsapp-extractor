import type { OfferSpec } from "./spec";

/**
 * Stage 0 (reach) and Stage 1 (rank) — the free half of the funnel.
 *
 * These two stages produce the ranked list of companies the user sees. No LLM
 * is involved, and that is not a compromise: the model's only inputs are the
 * same cadastral columns these predicates read, so it would mostly be
 * re-encoding them into a number. Free models are also throttled to ~3.2s per
 * request with a small daily quota, which makes scoring a multi-million-row
 * base arithmetically impossible. SQL ranks; the LLM is spent only on the top
 * slice, mainly to write the hook.
 *
 * This module imports NOTHING on purpose. The Next.js app needs the identical
 * predicates, and the CJS/ESM boundary between `src/` and `web/` only bites on
 * modules that pull in the pg pool. Keep it dependency-free and it can be
 * shared verbatim rather than duplicated.
 */

/** Pushes a value and returns its positional placeholder, e.g. `$3`. */
export type Param = (v: unknown) => string;

/**
 * Stage 0: who is even reachable.
 *
 * The suppression and outreach clauses are part of Stage 0 rather than a later
 * filter, deliberately. A person who opted out, or who has already been
 * contacted under ANY offer, must never reach a candidate list — let alone have
 * tokens spent on them. Enforcing it at the top of the funnel is what makes the
 * "one human, one contact" promise in LIA.md hold across offers.
 */
export function buildStage0Where(spec: OfferSpec, p: Param): string[] {
  const t = spec.targeting;
  const c: string[] = ["l.situacao = 'ATIVA'", "l.phone_e164 IS NOT NULL"];

  if (t.cnaePrefixes.length) {
    c.push(`l.cnae_principal LIKE ANY(${p(t.cnaePrefixes.map((x) => `${x}%`))})`);
  }
  if (t.cnaeExclude.length) {
    c.push(`l.cnae_principal NOT LIKE ALL(${p(t.cnaeExclude.map((x) => `${x}%`))})`);
  }

  // channels: ["mobile"] reproduces the old behaviour exactly; ["mobile",
  // "landline"] is every contactable lead, which is what institutions need.
  const wantsMobile = t.channels.includes("mobile");
  const wantsLandline = t.channels.includes("landline");
  if (wantsMobile && !wantsLandline) c.push("l.is_mobile IS TRUE");
  if (wantsLandline && !wantsMobile) c.push("l.is_mobile IS NOT TRUE");

  if (t.ufs.length) c.push(`l.uf = ANY(${p(t.ufs)})`);
  if (t.naturezaPrefixes.length) {
    c.push(`left(l.natureza_juridica, 1) = ANY(${p(t.naturezaPrefixes)})`);
  }
  if (t.porteIn.length) c.push(`l.porte = ANY(${p(t.porteIn)})`);
  if (t.minCapitalSocial !== null) {
    c.push(`COALESCE(l.capital_social, 0) >= ${p(t.minCapitalSocial)}`);
  }
  if (t.excludeMei) c.push("l.opcao_mei IS NOT TRUE");
  if (t.requireNomeFantasia) c.push("l.nome_fantasia IS NOT NULL");

  if (t.minAgeYears !== null) {
    c.push(
      `l.data_inicio_atividade <= (CURRENT_DATE - (${p(t.minAgeYears)}::int * interval '1 year'))`
    );
  }
  if (t.maxAgeYears !== null) {
    c.push(
      `l.data_inicio_atividade >= (CURRENT_DATE - (${p(t.maxAgeYears)}::int * interval '1 year'))`
    );
  }

  c.push(`NOT EXISTS (SELECT 1 FROM suppression s WHERE s.phone_e164 = l.phone_e164)`);
  c.push(
    `NOT EXISTS (SELECT 1 FROM outreach o
                  JOIN leads l2 ON l2.cnpj = o.cnpj
                 WHERE l2.phone_e164 = l.phone_e164)`
  );

  return c;
}

/**
 * Stage 1: a hand-weighted propensity score.
 *
 * Every term is a fact from a column, so the ordering is explainable without a
 * model. `rank_parts` (below) records each component so the UI can show why a
 * company placed where it did.
 *
 * Expects `leads l` joined to `enrichment e` (LEFT JOIN — most leads are not
 * enriched, and the expression must stay valid when e.* is NULL).
 */
export function buildRankSql(spec: OfferSpec, offerId: string, p: Param): string {
  const r = spec.ranking;
  const t = spec.targeting;
  const terms: string[] = [];

  // An exact 7-digit match is a much sharper signal than a 2-digit prefix:
  // "85" is all of education, "8520100" is specifically ensino médio.
  const exact = t.cnaePrefixes.filter((c) => c.length === 7);
  if (exact.length && r.cnaeExact) {
    terms.push(`(CASE WHEN l.cnae_principal = ANY(${p(exact)}) THEN ${num(r.cnaeExact)} ELSE 0 END)`);
  }
  if (r.naturezaPrivada) {
    terms.push(
      `(CASE WHEN left(l.natureza_juridica, 1) IN ('2','3') THEN ${num(r.naturezaPrivada)}
             WHEN left(l.natureza_juridica, 1) = '1' THEN ${num(-r.naturezaPrivada)}
             ELSE 0 END)`
    );
  }
  if (r.channelMobile) {
    terms.push(`(CASE WHEN l.is_mobile THEN ${num(r.channelMobile)} ELSE 0 END)`);
  }
  if (t.porteIn.length && r.porteMatch) {
    terms.push(`(CASE WHEN l.porte = ANY(${p(t.porteIn)}) THEN ${num(r.porteMatch)} ELSE 0 END)`);
  }
  if (r.hasNomeFantasia) {
    terms.push(`(CASE WHEN l.nome_fantasia IS NOT NULL THEN ${num(r.hasNomeFantasia)} ELSE 0 END)`);
  }
  if (r.hasWebsite) {
    terms.push(`(CASE WHEN e.has_website IS TRUE THEN ${num(r.hasWebsite)} ELSE 0 END)`);
  }
  // An organisation that registered secretaria@colegiox.com.br runs its own
  // infrastructure and already buys software. Free signal, already in the data.
  if (r.ownDomain) {
    terms.push(
      `(CASE WHEN l.email IS NOT NULL
              AND split_part(l.email, '@', 2) NOT IN
                  ('gmail.com','hotmail.com','outlook.com','yahoo.com.br','uol.com.br',
                   'bol.com.br','terra.com.br','ig.com.br','globo.com','r7.com','live.com')
             THEN ${num(r.ownDomain)} ELSE 0 END)`
    );
  }
  if (r.capitalBand) {
    terms.push(
      `(LEAST(3, GREATEST(0, log(10, GREATEST(COALESCE(l.capital_social, 0), 1)) - 3))
        * ${num(r.capitalBand)})`
    );
  }
  if (r.ageMatch) {
    // Established but not ossified.
    terms.push(
      `(CASE WHEN date_part('year', age(l.data_inicio_atividade)) BETWEEN 3 AND 25
             THEN ${num(r.ageMatch)} ELSE 0 END)`
    );
  }
  if (spec.probes.length && r.probeHit) {
    // Sum of matched positive probes minus matched negative ones.
    terms.push(
      `COALESCE((
         SELECT sum(CASE WHEN v.value::boolean THEN w.weight ELSE 0 END)
           FROM jsonb_each_text(COALESCE(e.signals -> ${p(offerId)}, '{}'::jsonb)) v
           JOIN (SELECT * FROM jsonb_to_recordset(${p(
             JSON.stringify(
               spec.probes.map((pr) => ({
                 key: pr.key,
                 weight: (pr.meaning === "negative" ? -1 : 1) * pr.weight * r.probeHit,
               }))
             )
           )}::jsonb) AS x(key text, weight numeric)) w ON w.key = v.key
       ), 0)`
    );
  }
  if (r.ftsTerms.length && r.ftsWeight) {
    terms.push(
      `(CASE WHEN to_tsvector('portuguese', COALESCE(e.text_excerpt, ''))
                  @@ plainto_tsquery('portuguese', ${p(r.ftsTerms.join(" OR "))})
             THEN ${num(r.ftsWeight)} ELSE 0 END)`
    );
  }

  return terms.length ? terms.join("\n+ ") : "0";
}

/** Components of the rank, as JSONB, so the UI can explain the ordering. */
export function buildRankPartsSql(spec: OfferSpec): string {
  const r = spec.ranking;
  const bits: string[] = [
    `'celular', (l.is_mobile IS TRUE)`,
    `'nome', (l.nome_fantasia IS NOT NULL)`,
    `'site', (e.has_website IS TRUE)`,
  ];
  if (r.ownDomain) bits.push(`'dominio_proprio', (l.email IS NOT NULL)`);
  return `jsonb_build_object(${bits.join(", ")})`;
}

/** Numbers are interpolated, never parameterised — they are validated weights, not input. */
function num(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error("rank weight is not a number");
  // Parenthesised so a negative weight cannot turn `+ -2` into a syntax error.
  return v < 0 ? `(${v.toFixed(4)})` : v.toFixed(4);
}
