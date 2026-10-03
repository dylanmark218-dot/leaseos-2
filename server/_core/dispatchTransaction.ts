import { and, eq, gt, lt, sql } from "drizzle-orm";
import {
  dispatchAuditEvents,
  dispatchBids,
  dispatchEligibilityChecks,
  dispatchInvitations,
  dispatchPostings,
  dispatchRoles,
  resourceBookings,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { conflictingBookingsWhere } from "./bookingConflict";
import {
  assessEligibilityValidity,
  awardIdempotencyKey,
  computeEligibilityFingerprint,
  decideAward,
  type EligibilityFacts,
  type GrantedOverride,
  type PostingState,
  type StoredEligibilityCheck,
} from "./dispatchAward";
import {
  assessStaffing,
  canTransitionPosting,
  type RoleStaffing,
} from "./dispatchLifecycle";

/**
 * The award transaction.
 *
 * A client never creates an assignment. It REQUESTS one; this decides whether
 * the award is permitted and performs every write atomically.
 *
 * Concurrency: two dispatchers awarding the same operator or unit at the same
 * moment must produce exactly one winner. Three layers guard that:
 *
 *   1. SELECT … FOR UPDATE on the posting row — serialises award attempts on
 *      the same posting, so conflict detection cannot interleave.
 *   2. Overlap re-check INSIDE the transaction, after the lock. Checking
 *      before the lock would be a time-of-check/time-of-use race.
 *   3. Idempotency key — a retried request resolves to the existing
 *      assignment rather than creating a second one.
 */

export type AwardInput = {
  postingId: number;
  roleId: number | null;
  operatorId: number;
  unitId: number | null;
  trailerId: number | null;
  eligibilityCheckId: number;
  currentFacts: EligibilityFacts;
  grantedOverrides: GrantedOverride[];
  startsAt: Date;
  endsAt: Date;
  actorUserId: number;
  actorRole: string;
  now: Date;
  maxAgeMinutes?: number;
};

export type AwardResult =
  | {
      ok: true;
      assignmentRoleId: number | null;
      postingState: PostingState;
      replayed: boolean;
      explanation: string;
    }
  | { ok: false; refusals: string[]; explanation: string };

export async function awardAssignment(input: AwardInput): Promise<AwardResult> {
  const db = await getDb();
  if (!db) {
    return {
      ok: false,
      refusals: ["Database unavailable"],
      explanation: "Database unavailable.",
    };
  }

  const idempotencyKey = awardIdempotencyKey({
    postingId: input.postingId,
    roleId: input.roleId,
    operatorId: input.operatorId,
    unitId: input.unitId,
    trailerId: input.trailerId,
    requestedByUserId: input.actorUserId,
  });

  return db.transaction(async tx => {
    // (1) Lock the posting. Everything below is serialised per posting.
    const lockedRows = await tx
      .select()
      .from(dispatchPostings)
      .where(eq(dispatchPostings.id, input.postingId))
      .for("update");

    const posting = lockedRows[0];
    if (!posting) {
      return {
        ok: false as const,
        refusals: ["Posting not found"],
        explanation: "Posting not found.",
      };
    }

    // (3) Idempotent replay — a retried request must not double-assign.
    const existing = await tx
      .select()
      .from(dispatchAuditEvents)
      .where(
        and(
          eq(dispatchAuditEvents.postingId, input.postingId),
          eq(dispatchAuditEvents.eventType, "assignment_approved"),
          eq(dispatchAuditEvents.detail, idempotencyKey)
        )
      );
    if (existing.length > 0) {
      return {
        ok: true as const,
        assignmentRoleId: input.roleId,
        postingState: posting.planningState as PostingState,
        replayed: true,
        explanation:
          "Award already recorded for this request; returning the existing assignment.",
      };
    }

    // Load the eligibility check that the client is proposing to rely on.
    const checkRows = await tx
      .select()
      .from(dispatchEligibilityChecks)
      .where(eq(dispatchEligibilityChecks.id, input.eligibilityCheckId));
    const checkRow = checkRows[0];
    if (!checkRow || checkRow.operatorId !== input.operatorId) {
      return {
        ok: false as const,
        refusals: ["Eligibility check not found for this operator"],
        explanation: "Eligibility check not found for this operator.",
      };
    }

    const storedCheck: StoredEligibilityCheck = {
      checkId: checkRow.id,
      operatorId: checkRow.operatorId,
      verdict: checkRow.verdict,
      blockers: checkRow.blockersJson ? JSON.parse(checkRow.blockersJson) : [],
      evaluatedAt: checkRow.evaluatedAt,
      explanation: "",
      // A row with no fingerprint is treated as invalid, never as valid.
      fingerprint: checkRow.fingerprint || "MISSING",
    };

    const validity = assessEligibilityValidity(
      storedCheck,
      input.currentFacts,
      input.now,
      input.maxAgeMinutes ?? 30
    );

    // (2) Overlap re-check INSIDE the lock. Half-open: a booking ending
    // exactly when this one starts is not a conflict.
    const conflicts: Array<{
      resourceRef: string;
      existingJob: string;
      message: string;
    }> = [];
    const refs: Array<{
      type: "operator" | "unit" | "trailer";
      ref: string | null;
    }> = [
      { type: "operator", ref: String(input.operatorId) },
      {
        type: "unit",
        ref: input.unitId === null ? null : String(input.unitId),
      },
      {
        type: "trailer",
        ref: input.trailerId === null ? null : String(input.trailerId),
      },
    ];

    for (const { type, ref } of refs) {
      if (!ref) continue;
      const overlapping = await tx
        .select()
        .from(resourceBookings)
        // The final revalidation, inside the transaction, by the one booking-conflict rule
        // (_core/bookingConflict.ts) — the same rule open-shift eligibility applied earlier.
        .where(conflictingBookingsWhere({ type, ref }, input));
      for (const o of overlapping) {
        if (o.postingId === input.postingId) continue;
        conflicts.push({
          resourceRef: ref,
          existingJob: String(o.jobId ?? o.postingId ?? "unknown"),
          message: `${type} ${ref} is already booked ${o.startsAt.toISOString().slice(11, 16)}–${o.endsAt.toISOString().slice(11, 16)} on posting ${o.postingId}`,
        });
      }
    }

    const bidRows =
      input.roleId === null
        ? await tx
            .select()
            .from(dispatchBids)
            .where(
              and(
                eq(dispatchBids.postingId, input.postingId),
                eq(dispatchBids.operatorId, input.operatorId)
              )
            )
        : await tx
            .select()
            .from(dispatchBids)
            .where(
              and(
                eq(dispatchBids.postingId, input.postingId),
                eq(dispatchBids.roleId, input.roleId),
                eq(dispatchBids.operatorId, input.operatorId)
              )
            );

    const decision = decideAward({
      postingState: posting.planningState as PostingState,
      bidState: (bidRows[0]?.status as never) ?? null,
      eligibility: storedCheck,
      validity,
      conflicts,
      grantedOverrides: input.grantedOverrides,
    });

    if (!decision.permitted) {
      // A refused attempt is evidence. Recorded, then the transaction rolls
      // back everything else.
      await tx.insert(dispatchAuditEvents).values({
        postingId: input.postingId,
        roleId: input.roleId,
        eventType: "assignment_blocked",
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        subjectOperatorId: input.operatorId,
        detail: decision.refusals.join(" | "),
        previousState: posting.planningState,
        newState: posting.planningState,
        occurredAt: input.now,
      });
      return {
        ok: false as const,
        refusals: decision.refusals,
        explanation: decision.explanation,
      };
    }

    // ---- writes, all inside the transaction ----
    if (input.roleId !== null) {
      await tx
        .update(dispatchRoles)
        .set({
          assignedOperatorId: input.operatorId,
          assignedUnitId: input.unitId,
          assignedTrailerId: input.trailerId,
          status: "assigned",
        })
        .where(eq(dispatchRoles.id, input.roleId));
    }

    for (const { type, ref } of refs) {
      if (!ref) continue;
      await tx.insert(resourceBookings).values({
        resourceType: type,
        resourceRef: ref,
        postingId: input.postingId,
        jobId: posting.jobId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        bookingState: "confirmed",
      });
    }

    await tx
      .update(dispatchEligibilityChecks)
      .set({ usedForAward: true })
      .where(eq(dispatchEligibilityChecks.id, input.eligibilityCheckId));

    if (bidRows[0]) {
      await tx
        .update(dispatchBids)
        .set({ status: "awarded" })
        .where(eq(dispatchBids.id, bidRows[0].id));
      await tx
        .update(dispatchBids)
        .set({ status: "not_selected" })
        .where(
          and(
            eq(dispatchBids.postingId, input.postingId),
            eq(dispatchBids.status, "submitted")
          )
        );
    }

    await tx
      .update(dispatchInvitations)
      .set({ status: "awarded", respondedAt: input.now })
      .where(
        and(
          eq(dispatchInvitations.postingId, input.postingId),
          eq(dispatchInvitations.operatorId, input.operatorId)
        )
      );

    // Staffing recalculated from the roles as they now stand.
    const roleRows = await tx
      .select()
      .from(dispatchRoles)
      .where(eq(dispatchRoles.postingId, input.postingId));
    const staffing = assessStaffing(
      roleRows.map(
        (r): RoleStaffing => ({
          roleId: r.id,
          roleLabel: r.roleLabel,
          required: true,
          assignedOperatorId: r.assignedOperatorId,
        })
      )
    );

    const nextState: PostingState =
      roleRows.length === 0
        ? "staffed"
        : staffing.state === "staffed"
          ? "staffed"
          : "partially_staffed";

    if (
      canTransitionPosting(posting.planningState as PostingState, nextState)
    ) {
      await tx
        .update(dispatchPostings)
        .set({ planningState: nextState })
        .where(eq(dispatchPostings.id, input.postingId));
    }

    await tx.insert(dispatchAuditEvents).values({
      postingId: input.postingId,
      roleId: input.roleId,
      eventType: "assignment_approved",
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      subjectOperatorId: input.operatorId,
      detail: idempotencyKey,
      previousState: posting.planningState,
      newState: nextState,
      occurredAt: input.now,
    });

    return {
      ok: true as const,
      assignmentRoleId: input.roleId,
      postingState: nextState,
      replayed: false,
      explanation: `${decision.explanation} ${staffing.message}`,
    };
  });
}

export { computeEligibilityFingerprint };
