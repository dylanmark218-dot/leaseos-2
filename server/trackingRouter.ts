/**
 * 0175 — The one-time tracking link, from the recipient's side.
 *
 * Every procedure here is a `trackingProcedure`: the token resolves to one link, the link to one
 * job in one organization, and the link's scope decides what may be read. The request never names
 * a job. What is returned is an explicit customer-safe projection built in
 * `server/_core/customerJobView.ts` from the canonical records — never a serialized job row.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { router, trackingProcedure, type TrackingContext } from "./_core/trpc";
import { getDb } from "./db";
import { jobs } from "../drizzle/schema";
import { liveWindow } from "./_core/trackingLinks";

const trk = (ctx: unknown) => (ctx as { tracking: TrackingContext }).tracking;

async function db() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}

export const trackingRouter = router({
  /** What this link is: the job's reference, who it was issued to, what it permits, and whether live tracking is still on. */
  resolve: trackingProcedure("tracking.resolve").query(async ({ ctx }) => {
    const t = trk(ctx);
    const d = await db();
    const job = (await d.select({ jobCode: jobs.jobCode, status: jobs.status, updatedAt: jobs.updatedAt }).from(jobs).where(eq(jobs.id, t.jobId)).limit(1))[0];
    if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "This tracking link no longer resolves to a job" });
    const now = new Date();
    const live = liveWindow({ liveUntilRule: t.liveUntilRule, liveGraceHours: t.liveGraceHours, liveExpiresAt: t.liveExpiresAt, jobCompletedAt: job.status === "complete" ? job.updatedAt : null, linkExpiresAt: t.expiresAt, now });
    return {
      linkRef: t.linkRef,
      jobReference: job.jobCode,
      issuedTo: t.contactName ? { name: t.contactName, kind: t.contactKind } : null,
      permits: t.scope,
      locationMode: t.locationMode,
      live: { available: live.live, reason: live.reason, until: live.until },
      expiresAt: t.expiresAt,
    };
  }),
});
