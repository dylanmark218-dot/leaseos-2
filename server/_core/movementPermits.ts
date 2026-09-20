/**
 * v23.25 — what the permit gate reads instead of a literal.
 *
 * Pure. The caller supplies rows; this decides what they mean.
 *
 * Two questions, and the composer was answering both with `false`:
 *
 *   1. Does this movement need a permit?
 *   2. If it does, is one on file and good for the movement?
 *
 * The first cannot be computed here. Whether a load is oversize depends on the jurisdiction's
 * dimensional limits, and those are regulatory data that has not been loaded — so the determination
 * is a record made by a person, and a job without one is UNKNOWN rather than exempt. That is the
 * whole difference between this and the line it replaces: `false` was an answer nobody gave.
 */

export type PermitRow = {
  permitRef: string;
  authority: string;
  jurisdiction: string;
  permitNumber: string;
  permitType: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  verificationStatus: "unverified" | "verified" | "rejected" | "superseded";
};

export type DeterminationRow = {
  permitRequired: boolean;
  basis: string;
  supersededAt: Date | null;
};

export type PermitStatus = {
  /** null means nobody has determined it — which the gate must treat as review, not as exempt. */
  permitRequired: boolean | null;
  /** null means required-but-unresolved. Only meaningful when permitRequired is true. */
  permitOnFile: boolean | null;
  /** Plain text for the readiness panel, so a dispatcher sees why rather than a bare state. */
  detail: string;
};

/**
 * Is this permit good for a movement happening at `at`?
 *
 * A window nobody recorded reads as unknown rather than as open-ended. A permit with no end date is
 * not a permit that never expires — it is a permit whose expiry was not written down, and those are
 * different in exactly the way that matters at a scale house.
 */
export function permitCoversMoment(p: PermitRow, at: Date): boolean | null {
  if (p.verificationStatus === "rejected" || p.verificationStatus === "superseded") return false;
  if (p.effectiveFrom === null || p.effectiveTo === null) return null;
  if (at < p.effectiveFrom) return false;
  if (at > p.effectiveTo) return false;
  return true;
}

/**
 * Resolve the two fields the dispatch gate needs.
 *
 * The ordering matters. The requirement is settled first, because "is a permit on file" is not a
 * question worth asking about a movement that does not need one — and answering it anyway is how a
 * job with an irrelevant expired permit ends up blocked for the wrong reason.
 */
export function resolvePermitStatus(
  determinations: readonly DeterminationRow[],
  permits: readonly PermitRow[],
  at: Date,
): PermitStatus {
  const current = determinations.filter(d => d.supersededAt === null);
  if (current.length === 0) {
    return {
      permitRequired: null,
      permitOnFile: null,
      detail: "No permit determination on file for this job — nobody has recorded whether this movement needs one.",
    };
  }
  /*
   * More than one live determination is a conflict, not a vote. Taking the most recent would hide
   * that two people disagreed about whether a movement is legal, so it goes to review saying so.
   */
  if (current.length > 1) {
    return {
      permitRequired: null,
      permitOnFile: null,
      detail: `${current.length} conflicting permit determinations are current for this job — supersede all but one.`,
    };
  }
  const determination = current[0]!;
  if (!determination.permitRequired) {
    return {
      permitRequired: false,
      permitOnFile: null,
      detail: `No permit required — ${determination.basis.replace(/_/g, " ")}.`,
    };
  }

  const usable = permits.filter(p => permitCoversMoment(p, at) === true);
  if (usable.length > 0) {
    /*
     * A permit that is on file but unverified still counts as on file. Verification is a separate
     * axis and gets its own line in the detail rather than being folded into a boolean — collapsing
     * them would make "we have the permit" and "we checked the permit with the issuer" the same
     * claim, and the standing rule keeps confidence visible instead.
     */
    const unverified = usable.filter(p => p.verificationStatus === "unverified");
    return {
      permitRequired: true,
      permitOnFile: true,
      detail: unverified.length
        ? `${usable.length} permit(s) on file; ${unverified.length} not yet verified with the issuing authority.`
        : `${usable.length} verified permit(s) on file.`,
    };
  }

  const undated = permits.filter(p => permitCoversMoment(p, at) === null);
  if (undated.length > 0) {
    return {
      permitRequired: true,
      permitOnFile: null,
      detail: `${undated.length} permit(s) on file with no recorded effective period — cannot tell whether they cover this movement.`,
    };
  }

  return {
    permitRequired: true,
    permitOnFile: false,
    detail: permits.length
      ? `A permit is required and ${permits.length} on file do not cover this movement.`
      : "A permit is required and none is on file.",
  };
}

/* ------------------------------------------------------------------ */
/* Reading the rows                                                    */
/* ------------------------------------------------------------------ */

import { and, eq, isNull } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { movementPermitDeterminations, movementPermits } from "../../drizzle/schema";

type Db = MySql2Database<Record<string, unknown>>;

/**
 * Answer the two permit questions for a job.
 *
 * A null `jobId` is unknown rather than exempt, same as everything else here — readiness asked
 * about no job at all cannot conclude that no permit is needed.
 */
export async function permitStatusForJob(db: Db, jobId: number | null, at: Date = new Date()): Promise<PermitStatus> {
  if (jobId === null) {
    return { permitRequired: null, permitOnFile: null, detail: "No job supplied — permit requirement not evaluated." };
  }
  const determinations = await db
    .select({
      permitRequired: movementPermitDeterminations.permitRequired,
      basis: movementPermitDeterminations.basis,
      supersededAt: movementPermitDeterminations.supersededAt,
    })
    .from(movementPermitDeterminations)
    .where(and(eq(movementPermitDeterminations.jobId, jobId), isNull(movementPermitDeterminations.supersededAt)));

  const permits = await db
    .select({
      permitRef: movementPermits.permitRef,
      authority: movementPermits.authority,
      jurisdiction: movementPermits.jurisdiction,
      permitNumber: movementPermits.permitNumber,
      permitType: movementPermits.permitType,
      effectiveFrom: movementPermits.effectiveFrom,
      effectiveTo: movementPermits.effectiveTo,
      verificationStatus: movementPermits.verificationStatus,
    })
    .from(movementPermits)
    .where(eq(movementPermits.jobId, jobId));

  return resolvePermitStatus(
    determinations.map(d => ({ permitRequired: Boolean(d.permitRequired), basis: d.basis, supersededAt: d.supersededAt })),
    permits,
    at,
  );
}
