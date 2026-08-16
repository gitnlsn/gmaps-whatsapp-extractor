import {
  createDb,
  createGooglePlaces,
  createOpenRouterLlm,
  createLlmBudget,
  nodeHttp,
  type Deps,
  type Sender,
  type Task,
} from "@leads/core";
import { pickProgress } from "./progress";

/**
 * Where configuration lives.
 *
 * The core reads no environment variables at all — every one of them is
 * resolved here and handed over. That is what makes an integration test able to
 * run the real SQL with a stubbed model instead of a real API key.
 */

/**
 * `.env` already used OPEN_ROUTER_API_KEY; both spellings are accepted rather
 * than forcing a rename of a variable that works.
 */
function openRouterKey(): string | undefined {
  return process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_API_KEY || undefined;
}

function modelOverrides(): Partial<Record<Task, string>> {
  const out: Partial<Record<Task, string>> = {};
  for (const task of ["score", "plan", "draft", "compile"] as const) {
    const v = process.env[`OPENROUTER_MODEL_${task.toUpperCase()}`];
    if (v) out[task] = v;
  }
  return out;
}

export function llmDailyRequests(): number | undefined {
  const n = Number(process.env.OPENROUTER_DAILY_REQUESTS);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function sender(): Sender {
  return {
    nome: process.env.SENDER_NAME || "",
    empresa: process.env.SENDER_COMPANY || undefined,
    cnpj: process.env.SENDER_CNPJ || undefined,
  };
}

export function dailySendCap(): number {
  const n = Number(process.env.DAILY_SEND_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40;
}

export function psiApiKey(): string | undefined {
  return process.env.PAGESPEED_API_KEY || undefined;
}

/**
 * Builds the dependency set for one CLI invocation.
 *
 * A port is present only when it can actually work: no OpenRouter key means no
 * `llm`, and the use-cases that need one say so with a clear error instead of
 * failing deep inside an HTTP call.
 */
export function buildDeps(): Deps {
  const db = createDb();
  const progress = pickProgress();

  const key = openRouterKey();
  const llmBudget = createLlmBudget(db, { dailyRequests: llmDailyRequests() });
  const llm = key
    ? createOpenRouterLlm({
        apiKey: key,
        models: modelOverrides(),
        http: nodeHttp,
        // Accounting is wired here so the adapter itself needs no database.
        onUsage: (model, task, usage) => llmBudget.recordUsage(model, task, usage),
      })
    : undefined;

  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  const places = mapsKey ? createGooglePlaces({ apiKey: mapsKey, http: nodeHttp }) : undefined;

  return { db, progress, http: nodeHttp, llm, places };
}
