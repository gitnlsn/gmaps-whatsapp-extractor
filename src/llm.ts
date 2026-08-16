const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type Task = "score" | "plan" | "draft" | "compile";

/**
 * Free-tier defaults. Every model here costs $0 on OpenRouter and supports
 * structured outputs, which the scorer depends on.
 *
 * Free models are rate limited: 20 requests/minute, and 50 requests/day unless
 * the account has ever bought >= 10 credits (then 1000/day). Scoring batches 10
 * leads per request, so 1000/day ~= 10,000 leads/day.
 *
 * Run `npm start -- models` to see the current free list; OpenRouter rotates it.
 */
const DEFAULT_MODELS: Record<Task, string> = {
  // Bulk work: small, fast, structured-output capable.
  score: "google/gemma-4-26b-a4b-it:free",
  // Quality work: the largest free model that supports structured outputs.
  plan: "nvidia/nemotron-3-super-120b-a12b:free",
  draft: "nvidia/nemotron-3-super-120b-a12b:free",
  // Runs once per offer, and its output defines an entire campaign — worth the
  // biggest model available.
  compile: "nvidia/nemotron-3-super-120b-a12b:free",
};

/** Free models share a 20 req/min ceiling; serialize with a floor delay. */
const FREE_MIN_INTERVAL_MS = 3200;
let lastCallAt = 0;

async function throttle(model: string): Promise<void> {
  if (!model.endsWith(":free") && model !== "openrouter/free") return;
  const wait = lastCallAt + FREE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

export function modelFor(task: Task): string {
  const envKey = `OPENROUTER_MODEL_${task.toUpperCase()}`;
  return process.env[envKey] || DEFAULT_MODELS[task];
}

export function apiKey(): string {
  // .env already used OPEN_ROUTER_API_KEY; accept both spellings rather than
  // forcing a rename of an existing working variable.
  const key = process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "OPEN_ROUTER_API_KEY not set. Add it to .env (get one at https://openrouter.ai/keys)."
    );
  }
  return key;
}

export function hasApiKey(): boolean {
  return Boolean(process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_API_KEY);
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  structured: boolean;
}

/** Lists the models OpenRouter currently offers at $0, newest list each call. */
export async function listFreeModels(): Promise<ModelInfo[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new LlmError(`Could not list models (${res.status})`);

  const data = (await res.json()) as {
    data: {
      id: string;
      name: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      supported_parameters?: string[];
    }[];
  };

  return data.data
    .filter(
      (m) =>
        Number(m.pricing?.prompt ?? 0) === 0 && Number(m.pricing?.completion ?? 0) === 0
    )
    .map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length ?? 0,
      structured: (m.supported_parameters ?? []).includes("structured_outputs"),
    }))
    .sort((a, b) => Number(b.structured) - Number(a.structured) || b.contextLength - a.contextLength);
}

export interface CompleteOptions {
  task: Task;
  messages: Message[];
  /** JSON Schema. When set, the model is constrained to emit matching JSON. */
  schema?: Record<string, unknown>;
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  /** Retries on 429/5xx with exponential backoff. */
  retries?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LlmError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Single completion. Returns the raw assistant text plus usage.
 * Throws LlmError rather than returning a sentinel — callers decide how to
 * record failure, and no caller may substitute a fake score.
 */
export async function complete(
  opts: CompleteOptions
): Promise<{ text: string; usage: Usage; model: string }> {
  const model = modelFor(opts.task);
  const retries = opts.retries ?? 4;

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: opts.schemaName ?? "result",
        strict: true,
        schema: opts.schema,
      },
    };
  }

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 16000);
      await sleep(backoff);
    }
    await throttle(model);

    let res: Response;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey()}`,
          "HTTP-Referer": "https://github.com/local/gmaps-whatsapp-extractor",
          "X-Title": "lead-pipeline",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = new LlmError(`Network error calling OpenRouter: ${(err as Error).message}`);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new LlmError(
        `OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`,
        res.status
      );
      continue;
    }

    if (!res.ok) {
      // 4xx other than 429 will not improve on retry.
      throw new LlmError(
        `OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`,
        res.status
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    if (data.error) {
      throw new LlmError(`OpenRouter error: ${data.error.message ?? "unknown"}`);
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      lastErr = new LlmError("OpenRouter returned no content");
      continue;
    }

    const usage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    };

    // Recorded here rather than at the call sites so nothing can spend without
    // being counted. A bookkeeping failure must never lose a completed call, so
    // it is swallowed — the request happened either way.
    try {
      const { recordUsage } = await import("./llmBudget");
      await recordUsage(model, opts.task, usage.promptTokens, usage.completionTokens);
    } catch {
      /* never let accounting break a successful call */
    }

    return { text, model, usage };
  }

  throw lastErr ?? new LlmError("OpenRouter call failed");
}

/**
 * Completion that must parse as JSON. Tolerates markdown fences because not
 * every model on OpenRouter honours response_format, but a parse failure is
 * surfaced as an error — never silently defaulted.
 */
export async function completeJson<T>(opts: CompleteOptions): Promise<{
  value: T;
  usage: Usage;
  model: string;
}> {
  // Free models are not always well behaved even with response_format set —
  // some emit <pad> runs or a prose preamble. A malformed body is retryable in
  // a way an HTTP error is not, so it gets its own attempt loop.
  const parseRetries = opts.retries ?? 3;
  let last: LlmError | undefined;

  for (let attempt = 0; attempt <= parseRetries; attempt++) {
    const { text, usage, model } = await complete({ ...opts, retries: 2 });

    const cleaned = text
      .replace(/<pad>/g, "")
      .replace(/<\/?s>/g, "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      return { value: JSON.parse(cleaned) as T, usage, model };
    } catch {
      // Some models wrap the object in prose; salvage the outermost braces.
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return { value: JSON.parse(cleaned.slice(start, end + 1)) as T, usage, model };
        } catch {
          /* fall through to retry */
        }
      }
      last = new LlmError(
        `Model did not return valid JSON. First 200 chars: ${cleaned.slice(0, 200) || "(empty)"}`
      );
    }
  }

  throw last ?? new LlmError("Model did not return valid JSON");
}
