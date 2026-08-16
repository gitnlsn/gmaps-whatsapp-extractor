-- Core schema. Applied by `npm run db:migrate` (src/migrate.ts).
-- Everything here is idempotent so re-running is safe.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is STABLE, not IMMUTABLE, so it cannot be used directly in an
-- index expression. This wrapper is the standard workaround.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
  RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

-- Normalized business name used for chain detection and fuzzy joins.
-- immutable_unaccent must be schema-qualified: Postgres inlines this body into
-- index expressions, which are resolved with a restricted search_path.
CREATE OR REPLACE FUNCTION norm_name(text)
  RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT lower(regexp_replace(public.immutable_unaccent($1), '[^a-zA-Z0-9]+', ' ', 'g')) $$;


-- ---------------------------------------------------------------- geography

CREATE TABLE IF NOT EXISTS municipios (
  id          INTEGER PRIMARY KEY,          -- 7-digit IBGE code
  nome        TEXT    NOT NULL,
  uf          CHAR(2) NOT NULL,
  populacao   INTEGER,
  -- Receita's own municipality code (TOM), which is NOT the IBGE code.
  cod_rf      INTEGER
);
CREATE INDEX IF NOT EXISTS municipios_uf_idx      ON municipios (uf);
CREATE INDEX IF NOT EXISTS municipios_pop_idx     ON municipios (populacao DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS municipios_cod_rf_idx  ON municipios (cod_rf);


-- ------------------------------------------------------------------- leads
-- Sourced from Receita Federal open data, which is freely storable.
-- Google-sourced fields must NEVER be written here (see plan §4) — only
-- google_place_id, which Google explicitly exempts from caching limits.

CREATE TABLE IF NOT EXISTS leads (
  cnpj                    CHAR(14) PRIMARY KEY,
  razao_social            TEXT,
  nome_fantasia           TEXT,
  cnae_principal          TEXT,
  cnae_secundarias        TEXT,
  natureza_juridica       TEXT,
  porte                   TEXT,
  capital_social          NUMERIC,
  opcao_mei               BOOLEAN,
  opcao_simples           BOOLEAN,
  data_inicio_atividade   DATE,
  situacao                TEXT,
  matriz                  BOOLEAN,

  cep                     TEXT,
  uf                      CHAR(2),
  municipio_id            INTEGER REFERENCES municipios(id),
  municipio_nome          TEXT,
  bairro                  TEXT,
  logradouro              TEXT,

  phone_raw               TEXT,
  phone_e164              TEXT,
  is_mobile               BOOLEAN,
  email                   TEXT,

  google_place_id         TEXT,
  place_id_refreshed_at   TIMESTAMPTZ,

  -- LGPD provenance: required to answer "where did you get this number?"
  source                  TEXT NOT NULL,
  source_url              TEXT,
  collected_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_uf_mun_idx    ON leads (uf, municipio_id);
CREATE INDEX IF NOT EXISTS leads_cnae_idx      ON leads (cnae_principal);
CREATE INDEX IF NOT EXISTS leads_abertura_idx  ON leads (data_inicio_atividade DESC);
CREATE INDEX IF NOT EXISTS leads_situacao_idx  ON leads (situacao);
-- Partial index: contactable leads are the only ones we ever scan for outreach.
CREATE INDEX IF NOT EXISTS leads_mobile_idx    ON leads (phone_e164) WHERE is_mobile;
CREATE INDEX IF NOT EXISTS leads_name_trgm_idx ON leads USING gin (norm_name(nome_fantasia) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS leads_normname_idx  ON leads (norm_name(nome_fantasia));


-- -------------------------------------------------------------- enrichment
-- Our own observations from our own HTTP requests. Not Google's data.

CREATE TABLE IF NOT EXISTS enrichment (
  cnpj              CHAR(14) PRIMARY KEY REFERENCES leads(cnpj) ON DELETE CASCADE,
  checked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  website_url       TEXT,
  final_url         TEXT,
  http_status       INTEGER,
  error             TEXT,

  has_website       BOOLEAN,
  is_dead           BOOLEAN,
  is_https          BOOLEAN,
  is_link_hub       BOOLEAN,
  is_free_builder   BOOLEAN,
  has_viewport      BOOLEAN,
  has_contact_path  BOOLEAN,
  has_wa_link       BOOLEAN,
  has_form          BOOLEAN,
  generator         TEXT,
  platform          TEXT,
  footer_year       INTEGER,
  title             TEXT,
  ig_handle         TEXT,
  psi_performance   INTEGER,
  psi_checked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS enrichment_dead_idx    ON enrichment (is_dead)     WHERE is_dead;
CREATE INDEX IF NOT EXISTS enrichment_hub_idx     ON enrichment (is_link_hub) WHERE is_link_hub;
CREATE INDEX IF NOT EXISTS enrichment_nosite_idx  ON enrichment (has_website) WHERE NOT has_website;


-- ------------------------------------------------------------------ scores

CREATE TABLE IF NOT EXISTS scores (
  cnpj         CHAR(14) PRIMARY KEY REFERENCES leads(cnpj) ON DELETE CASCADE,
  -- NULL means "not scored / failed", never a fake middle value.
  web_fit      SMALLINT CHECK (web_fit     BETWEEN 1 AND 5),
  chatbot_fit  SMALLINT CHECK (chatbot_fit BETWEEN 1 AND 5),
  confidence   TEXT,     -- high | medium | low | cannot_determine
  tier         TEXT,     -- hot | warm | cold
  offer        TEXT,     -- site | chatbot | both | none
  evidence     JSONB,
  hook         TEXT,
  model        TEXT,
  scored_at    TIMESTAMPTZ,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS scores_tier_idx ON scores (tier, web_fit DESC NULLS LAST, chatbot_fit DESC NULLS LAST);


-- ---------------------------------------------------------------- outreach

CREATE TABLE IF NOT EXISTS outreach (
  cnpj         CHAR(14) PRIMARY KEY REFERENCES leads(cnpj) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','sent','replied','not_a_fit','opted_out')),
  draft        TEXT,
  touches      SMALLINT NOT NULL DEFAULT 0,
  queued_at    TIMESTAMPTZ DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  followup_at  TIMESTAMPTZ,
  replied_at   TIMESTAMPTZ,
  outcome      TEXT,
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS outreach_status_idx ON outreach (status, sent_at DESC NULLS LAST);


-- ------------------------------------------------------------- suppression
-- Checked before every send, forever. Keyed on phone, not on business,
-- because one human often owns several CNPJs.

CREATE TABLE IF NOT EXISTS suppression (
  phone_e164  TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------- queries
-- The AI query planner's work queue (Places discovery only).

CREATE TABLE IF NOT EXISTS queries (
  id            SERIAL PRIMARY KEY,
  text          TEXT UNIQUE NOT NULL,
  category      TEXT,
  cnae_codes    TEXT[],
  municipio_id  INTEGER REFERENCES municipios(id),
  priority      INTEGER NOT NULL DEFAULT 0,
  last_run_at   TIMESTAMPTZ,
  yield_count   INTEGER NOT NULL DEFAULT 0,
  result_count  INTEGER NOT NULL DEFAULT 0,
  saturated     BOOLEAN NOT NULL DEFAULT FALSE,
  retired       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS queries_queue_idx ON queries (priority DESC, last_run_at NULLS FIRST)
  WHERE NOT retired;


-- ---------------------------------------------------------------- api_usage
-- The cost guardrail. Checked before every billable Places call.

CREATE TABLE IF NOT EXISTS api_usage (
  day    DATE NOT NULL,
  sku    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, sku)
);
