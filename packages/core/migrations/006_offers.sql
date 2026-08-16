-- 006_offers.sql
--
-- Makes the PRODUCT BEING SOLD a piece of data instead of a prompt string.
--
-- Before this, "what are we selling?" was answered in four incompatible places:
-- a hardcoded Portuguese rubric in src/score.ts, two integer columns here
-- (web_fit, chatbot_fit), a four-value enum in src/types.ts, and column headers
-- in the dashboard. Selling a second thing meant editing all four.
--
-- Offers are authored at RUNTIME — compiled by an LLM from a free-text product
-- description, then edited by a human — so they cannot live in TypeScript. They
-- live here, and specs are APPEND-ONLY: editing an offer inserts version+1 and
-- never overwrites. Scores record the exact (offer_id, offer_version,
-- prompt_sha) that graded them, so "which rubric produced this score?" stays
-- answerable after the spec has been revised a dozen times. Without versioning
-- a score points at whatever the spec says today, which is worthless.

-- ------------------------------------------------------------------ offers

CREATE TABLE IF NOT EXISTS offers (
  id              TEXT PRIMARY KEY
                    CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  title           TEXT    NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  active          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One campaign in flight at a time, enforced by the database rather than by
-- convention. This is also the structural half of the anti-multiplication rule:
-- with a single active offer there is never a second campaign that could queue
-- the same human again. Same trick 004_jobs.sql uses for "one running job".
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_active_idx
  ON offers ((active)) WHERE active;

CREATE TABLE IF NOT EXISTS offer_specs (
  offer_id    TEXT    NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  -- Exactly what the human typed. Never rewritten; the audit trail starts here.
  description TEXT    NOT NULL,
  -- LGPD: legitimate interest is FINALITY-specific (LIA.md §1, §7). A generic
  -- offer engine therefore needs a declared purpose per offer, not one global
  -- purpose. This column is why the offers table is load-bearing and not just
  -- convenient.
  finalidade  TEXT    NOT NULL,
  -- Shape is validated in TypeScript (src/offers/spec.ts), deliberately not by
  -- a CHECK: a constraint would need a migration every time the rubric shape
  -- moves, which is the thing this design exists to avoid.
  spec        JSONB   NOT NULL,
  compiled_by TEXT,                       -- 'llm:<model>' | 'human'
  compiled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT,
  PRIMARY KEY (offer_id, version)
);

-- Identity for every score written before offers existed, so no row is
-- orphaned by the foreign key below. The spec itself is seeded from
-- src/offers/legacy.ts by `npm start -- offer seed`, keeping one source of
-- truth rather than duplicating a large JSON blob into this file.
INSERT INTO offers (id, title, active)
VALUES ('site-chatbot', 'Site e automação de WhatsApp (oferta original)', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------ scores
-- One score per (lead, offer). NULL fits still mean "not scored / failed",
-- never a fake middle value — that invariant predates offers and survives them.

ALTER TABLE scores ADD COLUMN IF NOT EXISTS offer_id       TEXT;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS offer_version  INTEGER;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS fits           JSONB;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS best_fit       SMALLINT;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS recommendation TEXT;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS prompt_sha     TEXT;

UPDATE scores SET
  offer_id       = COALESCE(offer_id, 'site-chatbot'),
  offer_version  = COALESCE(offer_version, 1),
  recommendation = COALESCE(recommendation, offer),
  fits = COALESCE(fits,
    CASE WHEN web_fit IS NULL AND chatbot_fit IS NULL THEN NULL
         ELSE jsonb_strip_nulls(jsonb_build_object(
                'web_fit', web_fit, 'chatbot_fit', chatbot_fit)) END),
  best_fit = COALESCE(best_fit,
    NULLIF(GREATEST(COALESCE(web_fit, 0), COALESCE(chatbot_fit, 0)), 0));

ALTER TABLE scores ALTER COLUMN offer_id      SET NOT NULL;
ALTER TABLE scores ALTER COLUMN offer_version SET NOT NULL;

DO $fk$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_offer_fk') THEN
    ALTER TABLE scores ADD CONSTRAINT scores_offer_fk
      FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_best_fit_ck') THEN
    ALTER TABLE scores ADD CONSTRAINT scores_best_fit_ck
      CHECK (best_fit IS NULL OR best_fit BETWEEN 1 AND 5);
  END IF;
END $fk$;

-- The same lead can now be graded under more than one offer.
ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_pkey;
ALTER TABLE scores ADD PRIMARY KEY (cnpj, offer_id);

-- web_fit / chatbot_fit / offer become GENERATED views over the new shape.
--
-- This is a temporary bridge, not the design: the dashboard, the CSV export and
-- the queue all read those names today, and rewriting them in the same change
-- that reshapes the table would mean nothing is verifiable in between. They are
-- dropped once the dashboard renders axes from the offer spec.
--
-- Note they are only ever populated for an offer whose axes happen to be named
-- web_fit / chatbot_fit. For any new offer they are NULL by construction, which
-- is exactly why every consumer has to migrate to best_fit / fits.
DROP INDEX IF EXISTS scores_tier_idx;
ALTER TABLE scores DROP COLUMN IF EXISTS web_fit;
ALTER TABLE scores DROP COLUMN IF EXISTS chatbot_fit;
ALTER TABLE scores DROP COLUMN IF EXISTS offer;
ALTER TABLE scores ADD COLUMN web_fit SMALLINT
  GENERATED ALWAYS AS (NULLIF(fits ->> 'web_fit', '')::smallint) STORED;
ALTER TABLE scores ADD COLUMN chatbot_fit SMALLINT
  GENERATED ALWAYS AS (NULLIF(fits ->> 'chatbot_fit', '')::smallint) STORED;
ALTER TABLE scores ADD COLUMN offer TEXT
  GENERATED ALWAYS AS (recommendation) STORED;

CREATE INDEX IF NOT EXISTS scores_offer_rank_idx
  ON scores (offer_id, best_fit DESC NULLS LAST, tier);
CREATE INDEX IF NOT EXISTS scores_cnpj_idx ON scores (cnpj);

-- -------------------------------------------------------------- enrichment
-- text_excerpt is what makes runtime-authored keyword probes possible AND
-- retroactive. Offers are written long after enrichment ran, so without the
-- stored page text every new offer's probes would mean re-fetching every
-- website — turning a free operation into hours of other people's bandwidth.

ALTER TABLE enrichment ADD COLUMN IF NOT EXISTS text_excerpt TEXT;
ALTER TABLE enrichment ADD COLUMN IF NOT EXISTS signals JSONB NOT NULL DEFAULT '{}'::jsonb;

-- signals shape: { "<offer_id>": { "<probe_key>": true|false } }
CREATE INDEX IF NOT EXISTS enrichment_signals_idx
  ON enrichment USING gin (signals jsonb_path_ops);
CREATE INDEX IF NOT EXISTS enrichment_text_fts_idx
  ON enrichment USING gin (to_tsvector('portuguese', COALESCE(text_excerpt, '')));

-- -------------------------------------------------------- offer_candidates
-- The Stage-1 shortlist: the free, SQL-ranked answer to "which companies?".
-- Materialised so the ranked list is stable and pageable, and so the exact set
-- handed to the (expensive) LLM stage is auditable afterwards.

CREATE TABLE IF NOT EXISTS offer_candidates (
  offer_id   TEXT     NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  cnpj       CHAR(14) NOT NULL REFERENCES leads(cnpj) ON DELETE CASCADE,
  rank_score NUMERIC  NOT NULL,
  -- Why it ranked where it did, component by component. Shown in the UI as
  -- deterministic chips: an explanation that costs no tokens.
  rank_parts JSONB,
  stage      TEXT     NOT NULL DEFAULT 'shortlist'
               CHECK (stage IN ('shortlist','enriched','scored','skipped')),
  built_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (offer_id, cnpj)
);

CREATE INDEX IF NOT EXISTS offer_candidates_rank_idx
  ON offer_candidates (offer_id, rank_score DESC, cnpj);

-- ---------------------------------------------------------------- outreach
-- THE ANTI-MULTIPLICATION GUARANTEE.
--
-- outreach stays keyed on cnpj — one row per lead, forever, however many offers
-- exist. offer_id records WHICH offer was pitched; it is an attribute and never
-- part of the key, so a second offer cannot create a second row for the same
-- business.
--
-- The phone-level rule is the partial unique index below: one human, one
-- contact record. Enforced by the database rather than by a SELECT-then-INSERT
-- guard, because the CLI queue and the dashboard server action are two writers
-- that can race. LIA.md §5 promises this; now the schema keeps the promise.

ALTER TABLE outreach ADD COLUMN IF NOT EXISTS offer_id   TEXT REFERENCES offers(id);
ALTER TABLE outreach ADD COLUMN IF NOT EXISTS phone_e164 TEXT;

-- Structured pre-sell outcome, orthogonal to `status`: status is what happened
-- to the message, interest is what the person said back. "replied + would_pay"
-- is the row this whole pipeline exists to produce and cannot be expressed in
-- a single enum. priced_too_high ranks ABOVE not_now on purpose — for a
-- pre-sale it means they want it and you mispriced, which is a good outcome.
ALTER TABLE outreach ADD COLUMN IF NOT EXISTS interest TEXT
  CHECK (interest IN ('committed','would_pay','wants_demo','interested',
                      'priced_too_high','not_now','no_interest','wrong_person'));
ALTER TABLE outreach ADD COLUMN IF NOT EXISTS interest_at   TIMESTAMPTZ;
ALTER TABLE outreach ADD COLUMN IF NOT EXISTS price_ceiling NUMERIC;
ALTER TABLE outreach ADD COLUMN IF NOT EXISTS contact_name  TEXT;
ALTER TABLE outreach ADD COLUMN IF NOT EXISTS contact_role  TEXT;

UPDATE outreach o
   SET offer_id   = COALESCE(o.offer_id, 'site-chatbot'),
       phone_e164 = COALESCE(o.phone_e164, l.phone_e164)
  FROM leads l
 WHERE l.cnpj = o.cnpj;

-- Fail loudly rather than silently dropping a contact record. If this fires,
-- the same human was already contacted under two CNPJs. Resolve by hand: keep
-- the earliest row, NULL the other's phone_e164, and say why in `notes`.
DO $guard$
DECLARE dupes INTEGER;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT phone_e164 FROM outreach
     WHERE phone_e164 IS NOT NULL
     GROUP BY phone_e164 HAVING count(*) > 1) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'outreach tem % telefone(s) contatado(s) sob mais de um CNPJ. '
      'Resolva antes: 006 passa a garantir um contato por pessoa.', dupes;
  END IF;
END
$guard$;

CREATE UNIQUE INDEX IF NOT EXISTS outreach_one_per_phone_idx
  ON outreach (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS outreach_interest_idx
  ON outreach (interest, interest_at DESC) WHERE interest IS NOT NULL;

-- --------------------------------------------------------------- llm_usage
-- src/budget.ts guards Google Places spend; nothing guards OpenRouter. With
-- offers authored from a browser, an unbudgeted LLM path is the fastest way to
-- burn a daily quota by accident.

CREATE TABLE IF NOT EXISTS llm_usage (
  day               DATE    NOT NULL,
  model             TEXT    NOT NULL,
  task              TEXT    NOT NULL,   -- score | compile | draft | plan
  requests          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     BIGINT  NOT NULL DEFAULT 0,
  completion_tokens BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, task)
);

-- ----------------------------------------------------------------- queries
-- Written by `plan`, read by nothing. Its only conceivable consumer was Google
-- Places discovery, which is off by default, restricted by ToS to storing
-- place_id, and fully superseded by the free national CNAE prefix filter in
-- src/receita.ts. Its useful half — turning an intent into CNAE prefixes — is
-- now src/compile.ts, with validation against actually-loaded data.
DROP TABLE IF EXISTS queries;
