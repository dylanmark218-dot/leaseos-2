/**
 * v23.26 — the write path for permits, so the gate reads rows somebody actually put there.
 *
 * Two permissions, and the gap between them is the design:
 *
 *   `permit.determine`  decide whether a movement needs a permit at all;
 *   `permit.verify`     confirm a permit against the issuing authority.
 *
 * Recording a permit is the third and the widest — a dispatcher typing in the number off a fax is
 * ordinary work. Deciding that a movement is within legal limits is not: that determination is what
 * releases a job through the permit gate, and `within_legal_limits` is a claim about the law, made
 * by a person, that a scale operator may later test. Verification is separate again because
 * "we have the permit" and "we checked it with the issuer" are different facts, and a single
 * permission would have let whoever typed the number also vouch for it.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { movementPermitDeterminations, movementPermits } from "../drizzle/schema";
import { permitStatusForJob } from "./_core/movementPermits";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No database" });
  return db;
}

const PERMIT_TYPE = z.enum(["oversize", "overweight", "oversize_overweight", "dangerous_goods", "seasonal", "municipal", "other"]);
const BASIS = z.enum(["within_legal_limits", "dimensions_exceed_limit", "weight_exceeds_limit", "dangerous_goods_route", "municipal_restriction", "authority_advised", "other"]);

export const movementPermitRouter = router({
  /**
   * What the readiness panel shows. Same resolver the dispatch gate uses, so a dispatcher reading
   * "no determination on file" is reading the reason their job is held rather than a second opinion.
   */
  statusFor: roleProcedure("movementPermit.statusFor")
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ input }) => permitStatusForJob(await dbOrThrow(), input.jobId)),

  /**
   * Record a permit. Deliberately permissive about what it accepts and honest about what that means:
   * everything lands `unverified`, and the resolver says so in the gate's detail line.
   */
  record: roleProcedure("movementPermit.record")
    .input(z.object({
      jobId: z.number().int().positive().nullish(),
      tripId: z.number().int().positive().nullish(),
      unitId: z.number().int().positive().nullish(),
      authority: z.string().min(2).max(160),
      jurisdiction: z.string().min(2).max(32),
      permitNumber: z.string().min(1).max(120),
      permitType: PERMIT_TYPE,
      effectiveFrom: z.coerce.date().nullish(),
      effectiveTo: z.coerce.date().nullish(),
      conditionsText: z.string().max(20000).nullish(),
      routeRef: z.string().max(120).nullish(),
      routeVersion: z.string().max(64).nullish(),
      source: z.enum(["dispatcher_entered", "authority_portal", "document_extraction", "imported", "customer_supplied"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      if (!input.jobId && !input.tripId && !input.unitId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A permit must name the job, trip or unit it authorizes" });
      }
      /*
       * A window that runs backwards is refused rather than stored. `permitCoversMoment` would read
       * it as covering nothing, which is the safe direction — but it would present as an expired
       * permit, and a dispatcher chasing a renewal for a permit that is merely mistyped is being
       * sent after the wrong problem.
       */
      if (input.effectiveFrom && input.effectiveTo && input.effectiveFrom > input.effectiveTo) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The permit's effective period ends before it starts" });
      }
      const permitRef = `PRM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      await db.insert(movementPermits).values({
        orgRef: null,
        permitRef,
        jobId: input.jobId ?? null,
        tripId: input.tripId ?? null,
        unitId: input.unitId ?? null,
        authority: input.authority,
        jurisdiction: input.jurisdiction,
        permitNumber: input.permitNumber,
        permitType: input.permitType,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        conditionsText: input.conditionsText ?? null,
        routeRef: input.routeRef ?? null,
        routeVersion: input.routeVersion ?? null,
        source: input.source,
        verificationStatus: "unverified",
        createdBy: ctx.user.id,
      });
      const undated = !input.effectiveFrom || !input.effectiveTo;
      return {
        permitRef,
        note: undated
          ? "Recorded without a complete effective period, so the gate cannot tell whether it covers a movement and will hold the job for review."
          : "Recorded as unverified. It counts as on file; verifying it with the issuing authority is a separate step.",
      };
    }),

  /**
   * Record whether this movement needs a permit.
   *
   * The determination supersedes rather than edits, for the same reason every other decision here
   * does: the question "who said this load was within legal limits, and when" has to survive the
   * next person changing their mind.
   */
  determine: roleProcedure("movementPermit.determine")
    .input(z.object({
      jobId: z.number().int().positive(),
      permitRequired: z.boolean(),
      basis: BASIS,
      basisNote: z.string().max(2000).nullish(),
      ruleSourceKey: z.string().max(120).nullish(),
      ruleSourceVersion: z.string().max(64).nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      /*
       * `other` without a note is refused. The basis is the whole value of the record — a
       * determination whose stated reason is "other" and nothing else is an unsigned opinion, and
       * the audit asks for the basis before it asks for anything else.
       */
      if (input.basis === "other" && !input.basisNote?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A basis of 'other' must say what it was" });
      }
      const now = new Date();
      const superseded = await db
        .update(movementPermitDeterminations)
        .set({ supersededAt: now })
        .where(and(eq(movementPermitDeterminations.jobId, input.jobId), isNull(movementPermitDeterminations.supersededAt)));
      await db.insert(movementPermitDeterminations).values({
        orgRef: null,
        jobId: input.jobId,
        permitRequired: input.permitRequired,
        basis: input.basis,
        basisNote: input.basisNote ?? null,
        ruleSourceKey: input.ruleSourceKey ?? null,
        ruleSourceVersion: input.ruleSourceVersion ?? null,
        determinedBy: ctx.user.id,
        determinedAt: now,
      });
      return {
        recorded: true,
        supersededPrior: Number((superseded as unknown as { rowsAffected?: number }).rowsAffected ?? 0),
        status: await permitStatusForJob(db, input.jobId),
      };
    }),

  /**
   * Confirm a permit against the issuing authority, or reject it.
   *
   * Rejection does not delete. A permit somebody recorded and somebody else found was not real is
   * a thing that happened, and the row is the only place that stays written down.
   */
  verify: roleProcedure("movementPermit.verify")
    .input(z.object({
      permitRef: z.string().min(1).max(64),
      outcome: z.enum(["verified", "rejected"]),
      note: z.string().max(2000).nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const rows = await db.select().from(movementPermits).where(eq(movementPermits.permitRef, input.permitRef)).limit(1);
      const existing = rows[0];
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: `No permit ${input.permitRef}` });
      if (existing.verificationStatus === "superseded") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That permit is superseded; verify the one that replaced it" });
      }
      await db
        .update(movementPermits)
        .set({ verificationStatus: input.outcome, verifiedAt: new Date(), verifiedBy: ctx.user.id })
        .where(eq(movementPermits.permitRef, input.permitRef));
      return {
        permitRef: input.permitRef,
        outcome: input.outcome,
        note: input.outcome === "rejected"
          ? "Recorded as rejected. It no longer covers any movement, and the row stays so the rejection is visible."
          : "Verified with the issuing authority.",
      };
    }),

  /** Every permit on a job, newest first — including rejected and superseded ones. */
  listForJob: roleProcedure("movementPermit.listForJob")
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      return db.select().from(movementPermits).where(eq(movementPermits.jobId, input.jobId)).orderBy(desc(movementPermits.createdAt));
    }),
});
