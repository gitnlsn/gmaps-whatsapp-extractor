import type { Db, Task, Usage } from "../ports/index";

/**
 * A spend guard for OpenRouter, modelled on services/budget.ts.
 *
 * Google Places has had a budget guard since the beginning because it bills in
 * dollars. The LLM path had none — which was tolerable while scoring was a
 * thing you typed in a terminal, and stopped being tolerable the moment a
 * button in a browser could start it.
 *
 * The limit here is a REQUEST count, not tokens. That is what OpenRouter's free
 * tier actually rations: 50 requests/day, or 1,000 if the account has ever
 * bought at least 10 credits. The default is the pessimistic 50, because
 * guessing high is how a quota disappears mid-run.
 */

export const DEFAULT_DAILY_REQUESTS = 50;

/** Paid models are not rationed by request count, so the guard steps aside. */
export function isFreeModel(model: string): boolean {
  return model.endsWith(":free") || model === "openrouter/free";
}

export class LlmBudgetExceededError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
    readonly needed: number
  ) {
    super(
      `Cota diária de requisições ao modelo esgotada: ${used}/${limit} hoje.\n` +
        `  Esta execução precisaria de ~${needed} requisição(ões).\n` +
        `  Pare aqui, ou:\n` +
        `    - rode de novo amanhã,\n` +
        `    - reduza --limit,\n` +
        `    - ajuste OPENROUTER_DAILY_REQUESTS se sua conta tem cota maior\n` +
        `      (1000/dia se já comprou >= 10 créditos),\n` +
        `    - ou use um modelo pago em OPENROUTER_MODEL_SCORE.`
    );
    this.name = "LlmBudgetExceededError";
  }
}

export interface LlmUsageReport {
  used: number;
  limit: number;
  left: number;
}

export interface LlmBudget {
  readonly limit: number;
  usedToday(): Promise<number>;
  checkBudget(model: string, needed: number): Promise<void>;
  recordUsage(model: string, task: Task, usage?: Usage): Promise<void>;
  usageReport(): Promise<LlmUsageReport>;
}

/**
 * The daily limit is resolved by the caller, not read from the environment
 * here — the core does not own configuration. Apps pass
 * `Number(process.env.OPENROUTER_DAILY_REQUESTS)`.
 */
export function createLlmBudget(db: Db, opts: { dailyRequests?: number } = {}): LlmBudget {
  const n = Number(opts.dailyRequests);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_REQUESTS;

  /** Requests made today against free models, all tasks pooled — the quota is too. */
  async function usedToday(): Promise<number> {
    const rows = await db.query<{ total: string }>(
      `SELECT COALESCE(sum(requests), 0)::text AS total
         FROM llm_usage
        WHERE day = CURRENT_DATE AND model LIKE '%:free'`
    );
    return Number(rows[0]?.total ?? 0);
  }

  return {
    limit,
    usedToday,

    /**
     * Call BEFORE a run that will make `needed` requests. Throws rather than
     * starting something that will die halfway through — a scoring run that
     * stops at request 30 of 50 leaves the rest recorded as failures, which is
     * noise.
     */
    async checkBudget(model: string, needed: number): Promise<void> {
      if (!isFreeModel(model)) return;
      const used = await usedToday();
      if (used + needed > limit) throw new LlmBudgetExceededError(used, limit, needed);
    },

    /** Records one request. Tokens are informational; the quota is per request. */
    async recordUsage(model: string, task: Task, usage?: Usage): Promise<void> {
      await db.withClient((c) =>
        c.query(
          `INSERT INTO llm_usage (day, model, task, requests, prompt_tokens, completion_tokens)
           VALUES (CURRENT_DATE, $1, $2, 1, $3, $4)
           ON CONFLICT (day, model, task) DO UPDATE SET
             requests = llm_usage.requests + 1,
             prompt_tokens = llm_usage.prompt_tokens + EXCLUDED.prompt_tokens,
             completion_tokens = llm_usage.completion_tokens + EXCLUDED.completion_tokens`,
          [model, task, usage?.promptTokens ?? 0, usage?.completionTokens ?? 0]
        )
      );
    },

    async usageReport(): Promise<LlmUsageReport> {
      const used = await usedToday();
      return { used, limit, left: Math.max(0, limit - used) };
    },
  };
}
