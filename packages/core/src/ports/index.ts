import type { PoolClient } from "pg";

/**
 * The five boundaries the core does not own.
 *
 * Everything else in `src/` is either pure domain logic or a use-case composed
 * from these. The rule that makes the package testable: a use-case never
 * touches `pg`, `fetch`, `console` or `process.env` directly — it asks for what
 * it needs and the app hands it over. That is what lets an integration test run
 * the real SQL against a real Postgres while OpenRouter and Google stay stubbed.
 */

// ---------------------------------------------------------------------- db

/**
 * Deliberately the same four methods `src/db.ts` already exposed, so the SQL in
 * every use-case is unchanged by the move — only where the functions come from.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------- progress

/**
 * Replaces every `console.log` and `process.stdout.write("\r…")` in the core.
 *
 * Those redraws were never really for a human — `collapseCarriageReturns` in the
 * web job runner exists purely to *undo* them. With a port there are two honest
 * implementations instead: one that prints for a terminal, one that emits NDJSON
 * for a parent process. Neither has to reverse-engineer the other.
 */
export interface Progress {
  /** Enter a named stage. `total` when the work is countable up front. */
  stage(key: string, label: string, total?: number): void;
  /** Advance within the current stage. */
  tick(done: number, note?: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** Leave a stage. `note` explains an unusual outcome ("cota esgotada"). */
  finish(key: string, note?: string): void;
}

/** Discards everything. The default when a caller does not care. */
export const silentProgress: Progress = {
  stage() {},
  tick() {},
  info() {},
  warn() {},
  finish() {},
};

// -------------------------------------------------------------------- http

/** Narrowed to what the core uses, so a test double is three lines. */
export interface HttpPort {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export const nodeHttp: HttpPort = {
  fetch: (url, init) => fetch(url, init),
};

// ------------------------------------------------------------------ budget

/**
 * The spend guard, as seen by an adapter about to make a billable call.
 * `check` throws rather than allowing spend; `record` counts a call that
 * actually happened. A 4xx is not billable and must not be recorded.
 */
export interface BudgetPort {
  check(sku: string): Promise<void>;
  record(sku: string, n?: number): Promise<void>;
  used(sku: string): Promise<number>;
}

// --------------------------------------------------------------------- llm

export type Task = "score" | "plan" | "draft" | "compile";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  task: Task;
  messages: Message[];
  /** JSON Schema. When set, the model is constrained to emit matching JSON. */
  schema?: Record<string, unknown>;
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  structured: boolean;
}

export interface LlmPort {
  complete(opts: CompleteOptions): Promise<{ text: string; usage: Usage; model: string }>;
  completeJson<T>(opts: CompleteOptions): Promise<{ value: T; usage: Usage; model: string }>;
  /** Which model a task resolves to, for logging and budget accounting. */
  modelFor(task: Task): string;
  listFreeModels(): Promise<ModelInfo[]>;
}

// ------------------------------------------------------------------ places

export interface PlaceRef {
  id: string;
}

export interface PlaceDetails {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  businessStatus?: string;
  primaryType?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
}

export interface PlacesPort {
  searchIds(query: string, budget: BudgetPort): AsyncIterable<PlaceRef[]>;
  getDetails(placeId: string, budget: BudgetPort): Promise<PlaceDetails>;
  refreshPlaceId(placeId: string): Promise<string | null>;
}

// -------------------------------------------------------------------- deps

/**
 * What a use-case receives. `db` and `progress` are always present; the rest
 * only where that use-case genuinely reaches outside the database, which is
 * itself the documentation of which stages can cost money.
 */
export interface Deps {
  db: Db;
  progress: Progress;
  http?: HttpPort;
  llm?: LlmPort;
  places?: PlacesPort;
}

/** Narrowing helpers — a missing port is a wiring bug, not a runtime maybe. */
export function requireHttp(deps: Deps): HttpPort {
  if (!deps.http) throw new Error("This use-case needs an HTTP port; none was wired.");
  return deps.http;
}

export function requireLlm(deps: Deps): LlmPort {
  if (!deps.llm) throw new Error("This use-case needs an LLM port; none was wired.");
  return deps.llm;
}

export function requirePlaces(deps: Deps): PlacesPort {
  if (!deps.places) throw new Error("This use-case needs a Places port; none was wired.");
  return deps.places;
}
