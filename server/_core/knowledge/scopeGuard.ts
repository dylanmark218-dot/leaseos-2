/**
 * A figure may not govern more than the verifier read.
 *
 * The hazard is concrete, and it is in this branch today. `selectProfile` treats
 * a null `latitudeRule` as *applies to both*:
 *
 *   if (a.latitudeRule != null && a.latitudeRule !== latitudeRule) return false;
 *
 * So a profile keyed `CA_FEDERAL` with no latitude rule matches a driver north
 * of 60 and a driver south of it. A verifier who read a section that is itself
 * scoped to one of those would, by promoting into that profile, have their
 * figure applied to operations they never looked at — silently, and with a
 * perfectly good citation attached.
 *
 * This module refuses that. It makes no claim about what any figure is; it only
 * refuses to let a reading be stretched wider than the reading.
 *
 * The rule is structural rather than substantive on purpose. LeaseOS does not
 * need to know which regimes differ to know that a jurisdiction **has** more
 * than one, and that is enough to require a verifier to say which one they were
 * in.
 */

import { and, eq } from "drizzle-orm";
import { hosRuleProfiles } from "../../../drizzle/schema";
import { getDb } from "../../db";

const dbOrThrow = async () => {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
};

/* ------------------------------------------------------------------ */
/* Jurisdictions with more than one regime                             */
/* ------------------------------------------------------------------ */

export type SplitAxis = "latitude";

/**
 * Jurisdictions whose hours-of-service rules are known to run more than one
 * regime, and on what axis.
 *
 * Each entry records **that** a split exists and where it is written, not what
 * either side says. Adding a jurisdiction here tightens the guard; it never
 * establishes a figure.
 */
export const SPLIT_REGIMES: Readonly<Record<string, { axis: SplitAxis; note: string }>> = {
  "CA-FEDERAL": {
    axis: "latitude",
    note: "The federal regulation runs separate divisions for driving south of latitude 60°N and north of it, so a figure read in one does not describe the other.",
  },
};

export const hasSplitRegime = (jurisdiction: string): boolean =>
  Object.prototype.hasOwnProperty.call(SPLIT_REGIMES, jurisdiction.toUpperCase());

/* ------------------------------------------------------------------ */
/* The guard                                                           */
/* ------------------------------------------------------------------ */

export type ScopeRefusal =
  | "PROFILE_NOT_FOUND"
  | "UNSCOPED_PROFILE_IN_SPLIT_JURISDICTION"
  | "SCOPE_MISMATCH"
  | "JURISDICTION_MISMATCH";

export type ScopeVerdict =
  | { ok: true; profileKey: string; scope: string; note: string }
  | { ok: false; code: ScopeRefusal; reason: string; remedy: string };

export type ScopeClaim = {
  profileKey: string;
  jurisdiction: string;
  /** What the verifier attests the reading covers. */
  geographicScope?: "SOUTH_OF_60_N" | "NORTH_OF_60_N" | "ALL";
};

const LATITUDE_FOR: Readonly<Record<string, "south_of_60" | "north_of_60">> = {
  SOUTH_OF_60_N: "south_of_60",
  NORTH_OF_60_N: "north_of_60",
};

/**
 * May this figure be promoted into this profile?
 *
 * Checked before the figure is written, and independently of whether the figure
 * is right — a correct number in an over-broad profile is still wrong for
 * everybody it was not read for.
 */
export async function checkPromotionScope(claim: ScopeClaim): Promise<ScopeVerdict> {
  const db = await dbOrThrow();

  const rows = await db.select({
    profileKey: hosRuleProfiles.profileKey,
    jurisdiction: hosRuleProfiles.jurisdiction,
    latitudeRule: hosRuleProfiles.latitudeRule,
  }).from(hosRuleProfiles).where(eq(hosRuleProfiles.profileKey, claim.profileKey)).limit(1);

  const profile = rows[0];
  if (!profile) {
    return { ok: false, code: "PROFILE_NOT_FOUND",
      reason: `no schedule "${claim.profileKey}" exists`,
      remedy: "Record the schedule, with its applicability, before verifying figures into it." };
  }

  const split = SPLIT_REGIMES[claim.jurisdiction.toUpperCase()];

  if (split && split.axis === "latitude" && profile.latitudeRule == null) {
    // The dangerous case, and the one that looks completely fine: a good
    // citation, a real figure, applied to operations nobody read for.
    return {
      ok: false, code: "UNSCOPED_PROFILE_IN_SPLIT_JURISDICTION",
      reason: `"${claim.profileKey}" carries no latitude rule, so it applies both north and south of 60°N. ${split.note}`,
      remedy: `Record separate schedules — one scoped south of 60°N and one north — and verify each against the division that governs it.`,
    };
  }

  if (claim.geographicScope && claim.geographicScope !== "ALL") {
    const expected = LATITUDE_FOR[claim.geographicScope];
    if (expected && profile.latitudeRule !== expected) {
      return {
        ok: false, code: "SCOPE_MISMATCH",
        reason: `the reading is attested for ${claim.geographicScope.replace(/_/g, " ").toLowerCase()} but "${claim.profileKey}" is scoped ${profile.latitudeRule ?? "to everything"}`,
        remedy: "Promote into the schedule that matches the division you read, or record one that does.",
      };
    }
  }

  const profileJur = profile.jurisdiction?.toUpperCase() ?? null;
  const claimJur = claim.jurisdiction.toUpperCase();
  // The profile column is varchar(8) and holds the broad code ("CA"), while a
  // claim names the regime ("CA-FEDERAL"). The claim narrows the profile, so
  // the profile code is a prefix of it — not a suffix, which is what the first
  // version checked and got backwards.
  const jurisdictionAgrees = profileJur === null || claimJur === profileJur || claimJur.startsWith(`${profileJur}-`);
  if (!jurisdictionAgrees) {
    return {
      ok: false, code: "JURISDICTION_MISMATCH",
      reason: `the reading is attested for ${claim.jurisdiction} but "${claim.profileKey}" applies to ${profile.jurisdiction}`,
      remedy: "Promote into a schedule for the jurisdiction you read.",
    };
  }

  return {
    ok: true, profileKey: profile.profileKey,
    scope: profile.latitudeRule ?? "unscoped",
    note: profile.latitudeRule
      ? `scoped ${profile.latitudeRule.replace(/_/g, " ")}`
      : "this jurisdiction has no recorded split regime, so an unscoped schedule is accepted",
  };
}

/* ------------------------------------------------------------------ */
/* Claimed exceptions                                                  */
/* ------------------------------------------------------------------ */

/**
 * A base limit is the normal case, not an unconditional maximum.
 *
 * Regulations carry provisions that permit departure from a limit under stated
 * conditions — emergencies, adverse driving conditions, and others. LeaseOS has
 * **no verified rules for any of them**.
 *
 * The failure to avoid is the quiet one: a driver claims an exception, the
 * engine has only the base figure, and it answers from the base figure as
 * though the exception did not exist — or worse, treats the claim as
 * authorizing the departure. Neither is an answer LeaseOS is entitled to give.
 */
export const EXCEPTION_KINDS = [
  "emergency", "adverse_driving_conditions", "permitted_deferral", "other_authorized_condition",
] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export type ExceptionOutcome =
  | { applies: "no_claim" }
  | { applies: "review"; kind: ExceptionKind; reason: string; nextAction: string };

/**
 * What to do when a departure from a base limit is claimed.
 *
 * Always review. There is no branch that authorizes one, because no exception
 * rule has been verified — and an unverified exception is not a permission.
 */
export function evaluateClaimedException(
  claimed: ExceptionKind | null,
  verifiedExceptionRules: readonly string[] = [],
): ExceptionOutcome {
  if (!claimed) return { applies: "no_claim" };

  const verified = verifiedExceptionRules.includes(claimed);

  return {
    applies: "review",
    kind: claimed,
    reason: verified
      // Even with a rule on file, a claimed exception turns on facts LeaseOS
      // did not witness. It is evidence for a person, not a computation.
      ? `a rule is on file for ${claimed.replace(/_/g, " ")}, and whether the conditions were met is a question about this trip`
      : `no verified rule is on file for ${claimed.replace(/_/g, " ")}; the base limit describes the normal case only`,
    nextAction: "A person reviews the claim against the instrument and the trip record. LeaseOS does not authorize the departure.",
  };
}

/**
 * How a base limit must be labelled once exceptions exist in the instrument.
 *
 * Guards against the first real figure quietly becoming "this many minutes
 * under every possible circumstance".
 */
export const BASE_LIMIT_CAVEAT =
  "Base limit for normal operation. Provisions permitting departure are not verified in LeaseOS, so a claimed exception goes to review rather than being computed.";
