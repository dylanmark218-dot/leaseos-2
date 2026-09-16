/**
 * Rule promotion — knowledge becomes a binding figure.
 *
 * This is the missing link. LeaseOS has an HOS engine that refuses to answer
 * while its limits are unverified, and a knowledge system that records what
 * sources say. Nothing connected them, so every determination read UNKNOWN and
 * would have kept reading UNKNOWN however much material was ingested.
 *
 * The connection is deliberately narrow. Ingestion does not create rules;
 * **a person reading an authoritative text creates rules**, and this records
 * that act with enough detail to defend it later.
 *
 * One consequence is worth stating plainly, because it is what makes the whole
 * thing work while 511 Alberta is blocked:
 *
 *   **A person reading the regulation is not LeaseOS reproducing it.**
 *
 * The licence gate governs what LeaseOS ingests, stores and quotes. It does not
 * govern what a human verifier may look up. So a verifier can open the federal
 * Hours of Service Regulations, read the figure, and record it here with a
 * citation — without LeaseOS storing a sentence of anything it is not licensed
 * to store. That is the route the 511 assessment itself identifies: build the
 * deterministic rules from the underlying legislation rather than from a course
 * that cannot be copied.
 */

import { and, eq } from "drizzle-orm";
import { hosRuleLimits } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { isBinding, type AuthorityLevel } from "./admission";

const dbOrThrow = async () => {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
};

/* ------------------------------------------------------------------ */
/* What a verifier must supply                                         */
/* ------------------------------------------------------------------ */

export type RuleVerification = {
  profileKey: string;
  limitKey: string;
  value: number;

  /** The instrument, its level, and where to find the figure. */
  authorityLevel: AuthorityLevel;
  sourceSection: string;
  citationUrl?: string;
  /** Set only when the figure came from an ingested document. */
  establishedByVersionRef?: string;

  verifiedByUserId: number;
  verifiedAt: Date;
};

export type PromotionResult =
  | { promoted: true; profileKey: string; limitKey: string; value: number }
  | { promoted: false; code: PromotionRefusal; reason: string };

export type PromotionRefusal =
  | "NO_VERIFIER"
  | "NON_BINDING_AUTHORITY"
  | "NO_CITATION"
  | "IMPLAUSIBLE_VALUE"
  | "NOT_A_NUMBER";

/**
 * Plausibility bounds, by limit.
 *
 * Not a substitute for a verifier — a wrong figure inside the bounds still gets
 * through, and only a person reading the instrument catches that. What these
 * catch is the transposition and the unit error: 1300 minutes of daily driving
 * instead of 780, or hours typed where minutes were meant. Those are the
 * mistakes a careful person makes at the end of a long day, and they are worth
 * a cheap guard.
 */
const PLAUSIBLE: Readonly<Record<string, { min: number; max: number; unit: string }>> = {
  daily_drive_minutes: { min: 60, max: 900, unit: "minutes" },
  daily_on_duty_minutes: { min: 60, max: 1080, unit: "minutes" },
  shift_drive_minutes: { min: 60, max: 900, unit: "minutes" },
  shift_on_duty_minutes: { min: 60, max: 1080, unit: "minutes" },
  shift_elapsed_minutes: { min: 60, max: 1200, unit: "minutes" },
  core_rest_minutes: { min: 120, max: 960, unit: "minutes" },
  daily_off_duty_minutes: { min: 120, max: 960, unit: "minutes" },
  cycle_1_on_duty_minutes: { min: 600, max: 5400, unit: "minutes" },
  cycle_2_on_duty_minutes: { min: 600, max: 9000, unit: "minutes" },
  cycle_2_interim_on_duty_minutes: { min: 600, max: 9000, unit: "minutes" },
  break_required_after_drive_minutes: { min: 60, max: 600, unit: "minutes" },
  break_minutes: { min: 5, max: 120, unit: "minutes" },
  mandatory_rest_minutes: { min: 480, max: 5760, unit: "minutes" },
  reduced_rest_floor_minutes: { min: 120, max: 960, unit: "minutes" },
  cycle_1_days: { min: 1, max: 30, unit: "days" },
  cycle_2_days: { min: 1, max: 30, unit: "days" },
  mandatory_rest_within_days: { min: 1, max: 60, unit: "days" },
  cycle_1_reset_minutes: { min: 480, max: 5760, unit: "minutes" },
  cycle_2_reset_minutes: { min: 480, max: 5760, unit: "minutes" },
};

export function checkPlausible(limitKey: string, value: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(value)) return { ok: false, reason: "value is not a number" };
  const bounds = PLAUSIBLE[limitKey];
  // An unrecognised limit is not rejected on plausibility — LeaseOS does not
  // get to decide that a jurisdiction's limit does not exist. It just gets no
  // arithmetic sanity check.
  if (!bounds) return { ok: true };
  if (value < bounds.min || value > bounds.max) {
    return { ok: false,
      reason: `${value} is outside the plausible range for ${limitKey} (${bounds.min}–${bounds.max} ${bounds.unit}); check the units` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Promotion                                                           */
/* ------------------------------------------------------------------ */

/**
 * **Superseded by `promotionLedger.promote()` (0091). Closed in 0093B.**
 *
 * This was the 0090 path: it wrote a verified figure with a citation, and no
 * ledger row. 0091 added the ledger and 0093B closed the branch's uncited
 * `hos.limitVerify` — and left this one open, which is the same mistake with
 * my name on it. Six verified figures in the test database had a citation and
 * no promotion behind them, all of them written from here.
 *
 * It refuses and names its replacement rather than being deleted, so a caller
 * gets an instruction instead of a missing export.
 *
 * ---
 *
 * Record a verified regulatory figure.
 *
 * The only path to `verificationStatus: "verified"`, and it refuses without a
 * named person, a binding authority level and a citation.
 *
 * **The figure is updated in place.** `hosRuleLimits` carries
 * `UNIQUE(profileKey, limitKey)`, so the branch's design is one row per limit
 * and a superseding insert is rejected by the database. That is the branch's
 * decision and an integration commit is not the place to overturn it — but it
 * has a consequence worth naming: **prior figures are not retained.** After an
 * amendment there is no record of what the system believed before it, which an
 * audit asking "what did you think in March" cannot be answered from. Recorded
 * in the checkpoint as a gap, not worked around here.
 */
export async function promoteVerifiedLimit(v: RuleVerification): Promise<PromotionResult> {
  throw new Error(
    `promoteVerifiedLimit is closed: it wrote a verified figure with no promotion behind it. ` +
    `Use promote() from promotionLedger for ${v.profileKey}.${v.limitKey} — it writes the live row ` +
    `and an immutable promotion in one transaction.`);
}

/** The original body, kept for reference while callers move. */
async function _promoteVerifiedLimitSuperseded(v: RuleVerification): Promise<PromotionResult> {
  if (!Number.isInteger(v.verifiedByUserId) || v.verifiedByUserId < 1) {
    return { promoted: false, code: "NO_VERIFIER",
      reason: "a regulatory figure needs a named verifier; there is no automated path to verified" };
  }

  if (!isBinding(v.authorityLevel)) {
    return { promoted: false, code: "NON_BINDING_AUTHORITY",
      reason: `${v.authorityLevel} cannot establish a regulatory limit; only law, official guidance, a recognized standard or a manufacturer specification can` };
  }

  if (!v.sourceSection.trim()) {
    return { promoted: false, code: "NO_CITATION",
      reason: "a verified figure must say where it came from" };
  }

  const plausible = checkPlausible(v.limitKey, v.value);
  if (!plausible.ok) {
    return { promoted: false,
      code: Number.isFinite(v.value) ? "IMPLAUSIBLE_VALUE" : "NOT_A_NUMBER",
      reason: plausible.reason };
  }

  const db = await dbOrThrow();

  const existing = await db.select({ id: hosRuleLimits.id })
    .from(hosRuleLimits)
    .where(and(eq(hosRuleLimits.profileKey, v.profileKey), eq(hosRuleLimits.limitKey, v.limitKey)))
    .limit(1);

  const row = {
    value: v.value,
    sourceSection: v.sourceSection,
    verificationStatus: "verified" as const,
    verifiedByUserId: v.verifiedByUserId,
    verifiedAt: v.verifiedAt,
    establishedByVersionRef: v.establishedByVersionRef ?? null,
    citationUrl: v.citationUrl ?? null,
  };

  if (existing[0]) {
    // One row per limit, per the unique constraint. The provenance columns are
    // rewritten with the figure, so the citation always describes the value
    // currently sitting in the row rather than the one it replaced.
    await db.update(hosRuleLimits).set(row).where(eq(hosRuleLimits.id, existing[0].id));
  } else {
    await db.insert(hosRuleLimits).values({ profileKey: v.profileKey, limitKey: v.limitKey, ...row });
  }

  return { promoted: true, profileKey: v.profileKey, limitKey: v.limitKey, value: v.value };
}

/**
 * Why a figure is what it is.
 *
 * The audit question. A verified limit that cannot answer it is a number
 * somebody will eventually have to defend and will not be able to.
 */
export async function provenanceOf(profileKey: string, limitKey: string): Promise<{
  value: number; sourceSection: string | null; citationUrl: string | null;
  establishedByVersionRef: string | null; verifiedByUserId: number | null; verifiedAt: Date | null;
} | null> {
  const db = await dbOrThrow();
  const rows = await db.select({
    value: hosRuleLimits.value,
    sourceSection: hosRuleLimits.sourceSection,
    citationUrl: hosRuleLimits.citationUrl,
    establishedByVersionRef: hosRuleLimits.establishedByVersionRef,
    verifiedByUserId: hosRuleLimits.verifiedByUserId,
    verifiedAt: hosRuleLimits.verifiedAt,
  }).from(hosRuleLimits).where(and(
    eq(hosRuleLimits.profileKey, profileKey),
    eq(hosRuleLimits.limitKey, limitKey),
    eq(hosRuleLimits.verificationStatus, "verified"),
  )).limit(1);
  return rows[0] ?? null;
}

/**
 * Verified figures with no citation anybody can follow.
 *
 * Rows predating 0090, or recorded with a section and no link. Reported rather
 * than fixed: backfilling a citation nobody checked would be inventing
 * provenance, which is worse than admitting it is missing.
 */
export async function figuresWithoutCitation(): Promise<{ profileKey: string; limitKey: string; sourceSection: string | null }[]> {
  const db = await dbOrThrow();
  const rows = await db.select({
    profileKey: hosRuleLimits.profileKey,
    limitKey: hosRuleLimits.limitKey,
    sourceSection: hosRuleLimits.sourceSection,
    citationUrl: hosRuleLimits.citationUrl,
  }).from(hosRuleLimits).where(eq(hosRuleLimits.verificationStatus, "verified"));

  return rows.filter((r) => !r.citationUrl)
    .map(({ profileKey, limitKey, sourceSection }) => ({ profileKey, limitKey, sourceSection }));
}
