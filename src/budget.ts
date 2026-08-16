import { query, withClient } from "./db";

/**
 * Google retired the $200/month universal credit in March 2025. Free
 * allowances are now per-SKU and NOT pooled. These are the monthly ceilings.
 * https://developers.google.com/maps/billing-and-pricing/pricing
 */
export const FREE_MONTHLY: Record<string, number> = {
  "textsearch.essentials": 10_000,
  "textsearch.pro": 5_000,
  "textsearch.enterprise": 1_000,
  "details.essentials": 10_000,
  "details.pro": 5_000,
  "details.enterprise": 1_000,
};

/** USD per 1,000 requests, first paid band. For the dry-run cost report. */
export const PRICE_PER_1K: Record<string, number> = {
  "textsearch.essentials": 1.7,
  "textsearch.pro": 32,
  "textsearch.enterprise": 35,
  "details.essentials": 5,
  "details.pro": 17,
  "details.enterprise": 20,
};

export class BudgetExceededError extends Error {
  constructor(readonly sku: string, readonly used: number, readonly limit: number) {
    super(
      `Free monthly allowance exhausted for SKU "${sku}": ${used}/${limit} used.\n` +
        `  Stopping rather than spilling into paid usage.\n` +
        `  Re-run next month, or pass --allow-paid to continue (this WILL cost money).`
    );
    this.name = "BudgetExceededError";
  }
}

export interface BudgetOptions {
  allowPaid: boolean;
  /** Extra hard stop on total billable requests for a single run. */
  maxRequests?: number;
}

export class Budget {
  private runCount = 0;

  constructor(private readonly opts: BudgetOptions) {}

  /** Month-to-date usage for one SKU. */
  async used(sku: string): Promise<number> {
    const rows = await query<{ total: string }>(
      `SELECT COALESCE(sum(count), 0)::text AS total
       FROM api_usage
       WHERE sku = $1 AND day >= date_trunc('month', CURRENT_DATE)`,
      [sku]
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Call BEFORE every billable request. Throws rather than allowing spend.
   * Records the request only after the caller confirms it happened.
   */
  async check(sku: string): Promise<void> {
    if (this.opts.maxRequests !== undefined && this.runCount >= this.opts.maxRequests) {
      throw new BudgetExceededError(sku, this.runCount, this.opts.maxRequests);
    }
    if (this.opts.allowPaid) return;

    const limit = FREE_MONTHLY[sku];
    if (limit === undefined) {
      throw new Error(`Unknown SKU "${sku}" — refusing to spend against an unknown budget.`);
    }
    const used = await this.used(sku);
    if (used >= limit) throw new BudgetExceededError(sku, used, limit);
  }

  async record(sku: string, n = 1): Promise<void> {
    this.runCount += n;
    await withClient((c) =>
      c.query(
        `INSERT INTO api_usage (day, sku, count) VALUES (CURRENT_DATE, $1, $2)
         ON CONFLICT (day, sku) DO UPDATE SET count = api_usage.count + EXCLUDED.count`,
        [sku, n]
      )
    );
  }

  get requestsThisRun(): number {
    return this.runCount;
  }
}

export async function usageReport(): Promise<void> {
  const rows = await query<{ sku: string; total: string }>(
    `SELECT sku, sum(count)::text AS total
     FROM api_usage
     WHERE day >= date_trunc('month', CURRENT_DATE)
     GROUP BY sku ORDER BY sku`
  );

  if (rows.length === 0) {
    console.log("\nGoogle API usage this month: none. Spend: $0.00");
    return;
  }

  console.log("\nGoogle API usage this month:");
  let overage = 0;
  for (const r of rows) {
    const used = Number(r.total);
    const limit = FREE_MONTHLY[r.sku] ?? 0;
    const paid = Math.max(0, used - limit);
    overage += (paid / 1000) * (PRICE_PER_1K[r.sku] ?? 0);
    const flag = paid > 0 ? `  ⚠️ ${paid} BILLABLE` : "";
    console.log(`  ${r.sku.padEnd(24)} ${String(used).padStart(7)} / ${limit} free${flag}`);
  }
  console.log(`  Estimated spend: $${overage.toFixed(2)}`);
}

export function estimateCost(plan: Record<string, number>): string {
  const lines: string[] = [];
  let total = 0;

  for (const [sku, count] of Object.entries(plan)) {
    const limit = FREE_MONTHLY[sku] ?? 0;
    const paid = Math.max(0, count - limit);
    const cost = (paid / 1000) * (PRICE_PER_1K[sku] ?? 0);
    total += cost;
    lines.push(
      `  ${sku.padEnd(24)} ${String(count).padStart(8)} requests  ` +
        `(${Math.min(count, limit)} free, ${paid} paid)  $${cost.toFixed(2)}`
    );
  }

  lines.push(`  ${"TOTAL".padEnd(24)} ${" ".repeat(18)}$${total.toFixed(2)}`);
  if (total > 0) {
    lines.push(
      `\n  ⚠️  This plan exceeds the free tier. It will NOT run without --allow-paid.`
    );
  }
  return lines.join("\n");
}
