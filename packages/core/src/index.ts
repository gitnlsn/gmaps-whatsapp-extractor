/**
 * @leads/core — the domain the CLI and the dashboard both sit on top of.
 *
 * Nothing here reads `process.env`, writes to `console`, or opens a socket of
 * its own. Use-cases declare what they need through `Deps` and the app hands it
 * over, which is what makes the SQL testable against a real database while the
 * paid APIs stay stubbed.
 */
export * from "./ports/index";
export * from "./domain/index";
export { createDb, getPool, closePool, assertDbReachable, connectionString } from "./db/pg";

export { createOpenRouterLlm, DEFAULT_MODELS, LlmError } from "./adapters/openrouter";
export { createGooglePlaces, MASKS } from "./adapters/googlePlaces";

export {
  Budget,
  BudgetExceededError,
  FREE_MONTHLY,
  PRICE_PER_1K,
  estimateCost,
  usageReport,
  type SkuUsage,
} from "./services/budget";
export {
  createLlmBudget,
  isFreeModel,
  LlmBudgetExceededError,
  DEFAULT_DAILY_REQUESTS,
  type LlmBudget,
  type LlmUsageReport,
} from "./services/llmBudget";

export { migrateSchema, splitStatements } from "./usecases/migrateSchema";
export { loadMunicipios } from "./usecases/loadMunicipios";
export { loadCnaes, loadReceita, latestPeriod, classifyPending, type LoadOptions } from "./usecases/loadReceita";
export {
  compileOffer,
  validateCnaes,
  type CompileInput,
  type CompileOptions,
  type CompileResult,
  type CnaeCheck,
} from "./usecases/compileOffer";
export {
  listOffers, loadOffer, activeOffer, resolveOffer, saveSpec, setActive, seedLegacy,
  type OfferRow, type LoadedOffer, type SaveSpecInput,
} from "./usecases/offerRepo";
export { countReach, buildShortlist, topCandidates, type ReachCounts, type TopRow } from "./usecases/shortlist";
export {
  enrichLeads, checkSite, pageSpeed, upsertEnrichment, analyzeHtml, websiteFromEmail,
  type EnrichOptions, type EnrichResult, type SiteSignals,
} from "./usecases/enrichLeads";
export { runPlacesEnrichment, type PlacesRunOptions, type PlacesRunResult } from "./usecases/runPlaces";
export { scoreLeads, type ScoreOptions, type ScoreRunResult } from "./usecases/scoreLeads";
export { refreshRollups, refreshRollupsQuietly } from "./usecases/refreshRollups";
export {
  runOfferPipeline,
  type RunPipelineOptions,
  type CompileStepInput,
  type PipelineResult,
  type Step,
  type StepKey,
  type StepStatus,
} from "./usecases/runOfferPipeline";
export { exportLeads, exportDemand, type ExportOptions, type ExportResult } from "./usecases/exportLeads";
export { draftMessage, templateDraft, waMeLink, type DraftInput, type Sender } from "./usecases/draftMessage";
