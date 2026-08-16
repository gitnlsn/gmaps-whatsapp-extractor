import { NextResponse } from "next/server";
import { getCurrentJob, getRecentJobs, reconcileStaleJobs } from "@/lib/jobs";
import { getPlacesQuota } from "@/lib/queries";

// Polled while a job runs — must never be cached.
export const dynamic = "force-dynamic";

/**
 * One payload covering everything the JobPanel needs, so a 1.5s poll is a
 * single request. `log` is included only for the current job; the history
 * entries omit it to keep the response small.
 */
export async function GET() {
  // Cheap, and it is what unblocks the queue after a dev-server restart.
  await reconcileStaleJobs();

  const [current, recent, quota] = await Promise.all([
    getCurrentJob(),
    getRecentJobs(10),
    getPlacesQuota(),
  ]);

  return NextResponse.json(
    { current: current ?? null, recent, quota },
    { headers: { "Cache-Control": "no-store" } }
  );
}
