import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { sql, sqlOne } from "./db";

/**
 * Runs pipeline steps by shelling out to the existing CLI.
 *
 * The dashboard deliberately does not reimplement enrich/score/places — there
 * is one implementation (`src/cli.ts`) and the terminal keeps working exactly
 * as before. This module only starts it, captures its output and records the
 * outcome.
 */

// Next runs with cwd = <repo>/web; the CLI needs the repo root so its dotenv
// call finds the root .env (GOOGLE_MAPS_API_KEY, OPEN_ROUTER_API_KEY live
// there — web/.env.local only has DATABASE_URL).
const REPO_ROOT = path.resolve(process.cwd(), "..");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Clamp a user-supplied number into a safe range. Never trusts the input. */
function int(value: unknown, min: number, max: number, fallback: number): string {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return String(fallback);
  return String(Math.min(max, Math.max(min, n)));
}

export interface JobOptions {
  limit?: unknown;
  concurrency?: unknown;
  batch?: unknown;
  psi?: boolean;
  recheck?: boolean;
  /** Offer slug. Validated against OFFER_ID_RE before it can reach argv. */
  offer?: unknown;
  /** Free text for `offer compile`. See the note on COMMANDS below. */
  desc?: unknown;
  title?: unknown;
  finalidade?: unknown;
}

/** Mirrors the CHECK constraint on offers.id in migration 006. */
const OFFER_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

/**
 * An offer slug is the first user-influenced value to reach an argv array, so
 * it is validated here rather than trusted. Callers additionally confirm the
 * slug exists in the database before starting a job.
 */
function offerId(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!OFFER_ID_RE.test(s)) throw new Error("slug de oferta inválido");
  return s;
}

/** Bounded free text. Safe as one argv element; spawn never uses a shell. */
function text(v: unknown, max: number): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Error("texto obrigatório");
  return s.slice(0, max);
}

/**
 * The allowlist IS the security boundary. `kind` is looked up here and every
 * argument is generated, so no user-supplied string ever reaches the process.
 *
 * Absent on purpose, not merely hidden in the UI:
 *   load / ibge  — 2GB+ and ~30 minutes, a bad fit for a browser tab
 *   queue        — interactive (readline on stdin); spawned it would hang
 *   --allow-paid — the one flag that can actually spend money
 */
const COMMANDS = {
  enrich: {
    label: "Enriquecer sites",
    build: (o: JobOptions) => [
      "enrich",
      "--limit", int(o.limit, 1, 5000, 500),
      "--concurrency", int(o.concurrency, 1, 40, 10),
      ...(o.psi ? ["--psi"] : []),
      ...(o.recheck ? ["--recheck"] : []),
      ...(o.offer ? ["--offer", offerId(o.offer)] : []),
    ],
  },
  score: {
    label: "Pontuar leads",
    build: (o: JobOptions) => [
      "score",
      "--limit", int(o.limit, 1, 2000, 200),
      "--batch", int(o.batch, 1, 20, 10),
      ...(o.recheck ? ["--rescore"] : []),
      ...(o.offer ? ["--offer", offerId(o.offer)] : []),
    ],
  },
  // Offer work runs through the same CLI as the terminal does, so the ranking
  // and compiling logic has exactly one implementation. The dashboard only ever
  // reads the tables these produce.
  "offer-compile": {
    label: "Compilar oferta",
    build: (o: JobOptions) => [
      "offer", "compile",
      "--slug", offerId(o.offer),
      "--desc", text(o.desc, 4000),
      "--title", text(o.title ?? o.offer, 120),
      ...(o.finalidade ? ["--finalidade", text(o.finalidade, 1000)] : []),
    ],
  },
  "offer-shortlist": {
    label: "Montar shortlist",
    build: (o: JobOptions) => [
      "offer", "shortlist", offerId(o.offer),
      "--limit", int(o.limit, 1, 50000, 5000),
    ],
  },
  places: {
    label: "Buscar no Google",
    build: (o: JobOptions) => [
      "places",
      "--limit", int(o.limit, 1, 200, 25),
      ...(o.recheck ? ["--recheck"] : []),
    ],
  },
} as const;

export type JobKind = keyof typeof COMMANDS;

export function isJobKind(v: string): v is JobKind {
  return Object.prototype.hasOwnProperty.call(COMMANDS, v);
}

export const JOB_LABELS: Record<JobKind, string> = {
  enrich: COMMANDS.enrich.label,
  score: COMMANDS.score.label,
  places: COMMANDS.places.label,
  "offer-compile": COMMANDS["offer-compile"].label,
  "offer-shortlist": COMMANDS["offer-shortlist"].label,
};

export interface JobRow {
  id: number;
  kind: string;
  args: string[];
  status: "running" | "done" | "failed" | "cancelled";
  log: string;
  exit_code: number | null;
  error: string | null;
  pid: number | null;
  started_at: string;
  finished_at: string | null;
}

/** Keep the tail only — a long enrich would otherwise bloat the row. */
const MAX_LOG_BYTES = 64 * 1024;

/**
 * Collapses terminal progress redraws.
 *
 * The CLI reports progress with `process.stdout.write("\r  250/400   ")`.
 * Piped output is not a TTY, so every one of those thousands of redraws is
 * delivered verbatim. Keeping only the segment after the last `\r` in a run
 * turns them back into a single current line.
 */
function collapseCarriageReturns(chunk: string): string {
  return chunk
    .split("\n")
    .map((line) => {
      const i = line.lastIndexOf("\r");
      return i === -1 ? line : line.slice(i + 1);
    })
    .join("\n");
}

/**
 * A dev-server restart (or a crash) orphans rows still marked `running`.
 * Because only one such row may exist, a single orphan would block every
 * future job — so this runs before any start and on every status read.
 */
export async function reconcileStaleJobs(): Promise<void> {
  const stale = await sql<{ id: number; pid: number | null }>(
    `SELECT id, pid FROM jobs WHERE status = 'running'`
  );

  for (const job of stale) {
    let alive = false;
    if (job.pid) {
      try {
        // Signal 0 tests for existence without touching the process.
        process.kill(job.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (!alive) {
      await sql(
        `UPDATE jobs SET status = 'failed', finished_at = now(),
                error = COALESCE(error, 'processo interrompido (servidor reiniciado?)')
         WHERE id = $1 AND status = 'running'`,
        [job.id]
      );
    }
  }
}

export interface StartResult {
  ok: boolean;
  jobId?: number;
  reason?: string;
}

export async function startJob(kind: JobKind, opts: JobOptions): Promise<StartResult> {
  await reconcileStaleJobs();

  const spec = COMMANDS[kind];
  if (!spec) return { ok: false, reason: "comando desconhecido" };

  // Argument validation rejects rather than coerces, and a rejection is an
  // expected outcome the UI shows — not a crash.
  let args: string[];
  try {
    args = spec.build(opts);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  let job: { id: number } | undefined;
  try {
    job = await sqlOne<{ id: number }>(
      `INSERT INTO jobs (kind, args, status) VALUES ($1, $2, 'running') RETURNING id`,
      [kind, args]
    );
  } catch (err) {
    // The partial unique index rejected it: another job is already running.
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, reason: "já existe um job rodando" };
    }
    throw err;
  }
  if (!job) return { ok: false, reason: "não foi possível criar o job" };

  const jobId = job.id;

  try {
    // shell: false — argv array, never string interpolation.
    const child = spawn(TSX_BIN, ["src/cli.ts", ...args], {
      cwd: REPO_ROOT,
      shell: false,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    await sql(`UPDATE jobs SET pid = $2 WHERE id = $1`, [jobId, child.pid ?? null]);

    let buffer = "";
    let flushing = false;
    let timer: NodeJS.Timeout | undefined;

    const flush = async () => {
      if (flushing || buffer.length === 0) return;
      flushing = true;
      const chunk = buffer;
      buffer = "";
      try {
        await sql(
          `UPDATE jobs
           SET log = right(log || $2, ${MAX_LOG_BYTES})
           WHERE id = $1`,
          [jobId, chunk]
        );
      } catch {
        /* a dropped log line must never kill the run */
      } finally {
        flushing = false;
      }
    };

    // Batch writes rather than one UPDATE per chunk.
    timer = setInterval(flush, 500);

    const onData = (d: Buffer) => {
      buffer += collapseCarriageReturns(d.toString("utf8"));
      if (buffer.length > MAX_LOG_BYTES) buffer = buffer.slice(-MAX_LOG_BYTES);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", async (err) => {
      if (timer) clearInterval(timer);
      await flush();
      await sql(
        `UPDATE jobs SET status = 'failed', finished_at = now(), error = $2
         WHERE id = $1 AND status = 'running'`,
        [jobId, err.message.slice(0, 500)]
      );
    });

    child.on("close", async (code, signal) => {
      if (timer) clearInterval(timer);
      await flush();

      // `run()` in src/cli.ts swallows exceptions into process.exitCode, so the
      // exit code — not stderr — is the only reliable success signal.
      const cancelled = signal === "SIGTERM" || signal === "SIGKILL";
      const status = cancelled ? "cancelled" : code === 0 ? "done" : "failed";

      await sql(
        `UPDATE jobs SET status = $2, exit_code = $3, finished_at = now()
         WHERE id = $1 AND status = 'running'`,
        [jobId, status, code]
      );
    });
  } catch (err) {
    await sql(
      `UPDATE jobs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
      [jobId, (err as Error).message.slice(0, 500)]
    );
    return { ok: false, reason: (err as Error).message };
  }

  return { ok: true, jobId };
}

export async function cancelJob(id: number): Promise<{ ok: boolean; reason?: string }> {
  const job = await sqlOne<{ pid: number | null; status: string }>(
    `SELECT pid, status FROM jobs WHERE id = $1`,
    [id]
  );
  if (!job) return { ok: false, reason: "job não encontrado" };
  if (job.status !== "running") return { ok: false, reason: "job já terminou" };

  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      /* already gone — fall through and mark it */
    }
  }

  await sql(
    `UPDATE jobs SET status = 'cancelled', finished_at = now()
     WHERE id = $1 AND status = 'running'`,
    [id]
  );
  return { ok: true };
}

export async function getCurrentJob(): Promise<JobRow | undefined> {
  return sqlOne<JobRow>(
    `SELECT id, kind, args, status, log, exit_code, error, pid, started_at, finished_at
     FROM jobs
     ORDER BY (status = 'running') DESC, started_at DESC
     LIMIT 1`
  );
}

export type JobSummary = Omit<JobRow, "log" | "pid">;

export async function getRecentJobs(limit = 10): Promise<JobSummary[]> {
  return sql<JobSummary>(
    `SELECT id, kind, args, status, exit_code, error, started_at, finished_at
     FROM jobs ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
}
