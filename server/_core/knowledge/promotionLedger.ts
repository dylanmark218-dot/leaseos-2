/**
 * Promotion, as a ledger.
 *
 * `hosRuleLimits` holds current belief; `hosRuleLimitHistory` holds every
 * figure LeaseOS has ever relied on. Both are written in one transaction, so
 * there is no window where the live figure exists without the promotion that
 * produced it.
 *
 * Three decisions shape this file.
 *
 * **Every promoted state once.** A change writes one history row — the incoming
 * figure — not one for the departing value and one for the arrival. Past belief
 * is read back by walking the ledger, and nothing is recorded twice.
 *
 * **A correction never edits the row it corrects.** A wrong figure that got
 * through plausibility stays visible, superseded, with the correction pointing
 * at it. A silent 700 → 780 destroys the evidence that anyone was ever wrong,
 * which is the evidence an audit most wants.
 *
 * **Four dates, none interchangeable.** An amendment can be published in
 * February, verified in February, and effective in March. Until March it is a
 * `FUTURE` rule, and using it for compliance would be applying a law that has
 * not started.
 */

import { and, desc, eq } from "drizzle-orm";
import { hosRuleLimitHistory, hosRuleLimits } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { isBinding, type AuthorityLevel } from "./admission";
import { checkCitation } from "./citationGuard";
import { checkPlausible } from "./rulePromotion";

const dbOrThrow = async () => {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
};

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

export type VerificationMethod =
  | "OFFICIAL_WEB" | "OFFICIAL_PDF" | "OFFICIAL_PRINT" | "LEGAL_COUNSEL" | "REGULATOR_CONFIRMATION";

export type BindingAuthority = Extract<AuthorityLevel, "law" | "official_guidance" | "recognized_standard" | "manufacturer">;

/**
 * What a verifier records.
 *
 * Note what is absent and stays absent: no copied text, no quoted paragraph, no
 * screenshot of protected material. Enough to relocate and defend the figure,
 * and not one word of the instrument.
 */
export type PromotionEvidence = {
  profileKey: string;
  limitKey: string;
  value: number;
  unit: "minutes" | "hours" | "days" | "kilograms";

  jurisdiction: string;
  authorityType: BindingAuthority;
  instrumentTitle: string;
  issuingAuthority: string;
  sourceSection: string;
  citationUrl: string;
  instrumentVersion?: string;
  consolidationDate?: Date;
  verificationMethod: VerificationMethod;
  establishedByVersionRef?: string;

  verifiedByUserId: number;
  verifiedAt: Date;
  effectiveFrom?: Date;
  effectiveUntil?: Date;

  /** Set when this promotion corrects an earlier one. */
  correctsPromotionRef?: string;
};

export type PromotionRefusal =
  | "NO_VERIFIER" | "NON_BINDING_AUTHORITY" | "NO_CITATION" | "IMPLAUSIBLE_VALUE"
  | "NO_INSTRUMENT_TITLE" | "NO_JURISDICTION" | "AMBIGUOUS_EFFECTIVE_DATE"
  | "DUPLICATE_PROMOTION" | "STALE_VERIFICATION" | "FUTURE_RULE_USED_AS_CURRENT"
  | "CITATION_CHANGED_WITHOUT_REVERIFICATION" | "CORRECTS_UNKNOWN_PROMOTION"
  | "UNRECOGNIZED_AUTHORITY_DOMAIN" | "MALFORMED_CITATION_URL";

export type PromotionOutcome =
  | { promoted: true; promotionRef: string; status: LedgerStatus; becameCurrent: boolean }
  | { promoted: false; code: PromotionRefusal; reason: string };

export type LedgerStatus = "FUTURE" | "CURRENT" | "EXPIRED" | "REVOKED" | "SUPERSEDED";

/** How long a verification is treated as fresh enough to promote from. */
export const STALE_VERIFICATION_DAYS = 180;

/**
 * The status a promotion takes on, from its dates.
 *
 * Derived rather than supplied, so a verifier cannot declare a future rule
 * current by ticking a box.
 */
export function statusFor(e: { effectiveFrom?: Date; effectiveUntil?: Date }, now: Date): LedgerStatus {
  if (e.effectiveFrom && e.effectiveFrom > now) return "FUTURE";
  if (e.effectiveUntil && e.effectiveUntil <= now) return "EXPIRED";
  return "CURRENT";
}

const ref = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export function validateEvidence(e: PromotionEvidence, now: Date): { ok: true } | { ok: false; code: PromotionRefusal; reason: string } {
  if (!Number.isInteger(e.verifiedByUserId) || e.verifiedByUserId < 1) {
    return { ok: false, code: "NO_VERIFIER", reason: "a regulatory figure needs a named verifier; there is no automated path to verified" };
  }
  if (!isBinding(e.authorityType)) {
    return { ok: false, code: "NON_BINDING_AUTHORITY", reason: `${e.authorityType} cannot establish a regulatory limit` };
  }
  if (!e.instrumentTitle.trim()) {
    return { ok: false, code: "NO_INSTRUMENT_TITLE", reason: "the instrument must be named; \"s. 12\" alone does not say which s. 12" };
  }
  if (!e.jurisdiction.trim()) {
    return { ok: false, code: "NO_JURISDICTION", reason: "a limit without a jurisdiction cannot be applied to anybody" };
  }
  if (!e.sourceSection.trim() || !e.citationUrl.trim()) {
    return { ok: false, code: "NO_CITATION", reason: "a verified figure must say where it came from and where to check it" };
  }
  if (e.effectiveFrom && e.effectiveUntil && e.effectiveUntil <= e.effectiveFrom) {
    return { ok: false, code: "AMBIGUOUS_EFFECTIVE_DATE", reason: "the rule would stop applying before it started" };
  }
  if (e.verifiedAt > now) {
    return { ok: false, code: "AMBIGUOUS_EFFECTIVE_DATE", reason: "verified in the future" };
  }

  const ageDays = (now.getTime() - e.verifiedAt.getTime()) / 86_400_000;
  if (ageDays > STALE_VERIFICATION_DAYS) {
    return { ok: false, code: "STALE_VERIFICATION",
      reason: `this verification is ${Math.round(ageDays)} days old; regulations move, so re-check before promoting it` };
  }

  // Where the citation points, for the methods that claim to have read the
  // publication. A guard, never a correctness check.
  const citation = checkCitation(e.citationUrl, e.verificationMethod);
  if (!citation.ok) return { ok: false, code: citation.code, reason: citation.reason };

  const plausible = checkPlausible(e.limitKey, e.value);
  if (!plausible.ok) return { ok: false, code: "IMPLAUSIBLE_VALUE", reason: plausible.reason };

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Promotion                                                           */
/* ------------------------------------------------------------------ */

/**
 * Record a promotion and, when it is current, make it the live figure.
 *
 * A `FUTURE` rule is written to the ledger and **does not touch**
 * `hosRuleLimits`. LeaseOS then knows the amendment exists while still applying
 * the rule in force, which is the correct behaviour between publication and
 * effect.
 */
export async function promote(e: PromotionEvidence, now: Date): Promise<PromotionOutcome> {
  const valid = validateEvidence(e, now);
  if (!valid.ok) return { promoted: false, code: valid.code, reason: valid.reason };

  const db = await dbOrThrow();

  if (e.correctsPromotionRef) {
    const target = await db.select({ promotionRef: hosRuleLimitHistory.promotionRef })
      .from(hosRuleLimitHistory)
      .where(eq(hosRuleLimitHistory.promotionRef, e.correctsPromotionRef)).limit(1);
    if (!target[0]) {
      return { promoted: false, code: "CORRECTS_UNKNOWN_PROMOTION",
        reason: `no promotion ${e.correctsPromotionRef} to correct` };
    }
  }

  const prior = await db.select()
    .from(hosRuleLimitHistory)
    .where(and(
      eq(hosRuleLimitHistory.profileKey, e.profileKey),
      eq(hosRuleLimitHistory.limitKey, e.limitKey),
    ))
    .orderBy(desc(hosRuleLimitHistory.id)).limit(1);

  const previous = prior[0];

  // The same figure, same citation, same verifier, again. Nothing changed, so
  // a second ledger row would only add noise.
  if (previous && !e.correctsPromotionRef &&
      previous.value === e.value &&
      previous.citationUrl === e.citationUrl &&
      previous.sourceSection === e.sourceSection &&
      previous.verifiedByUserId === e.verifiedByUserId) {
    return { promoted: false, code: "DUPLICATE_PROMOTION",
      reason: "this figure, citation and verifier are already the current promotion" };
  }

  // Evidence is not cosmetic metadata. Changing where a figure came from while
  // keeping the figure means somebody edited the justification without
  // re-reading the instrument.
  if (previous && !e.correctsPromotionRef &&
      previous.value === e.value &&
      previous.verifiedByUserId === e.verifiedByUserId &&
      (previous.citationUrl !== e.citationUrl ||
       previous.sourceSection !== e.sourceSection ||
       previous.instrumentVersion !== (e.instrumentVersion ?? null))) {
    return { promoted: false, code: "CITATION_CHANGED_WITHOUT_REVERIFICATION",
      reason: "the citation changed but the figure and verifier did not; a new verification is required" };
  }

  const status = statusFor(e, now);
  const promotionRef = ref("HOS-PROM");

  const changeReason = e.correctsPromotionRef ? "CORRECTED_VERIFICATION"
    : previous ? "VERIFIED_REVISION" : "INITIAL_VERIFICATION";

  await db.transaction(async (tx) => {
    // The departing promotion is marked, not rewritten: its figure, citation
    // and verifier stay exactly as recorded.
    if (previous && previous.status === "CURRENT") {
      await tx.update(hosRuleLimitHistory)
        .set({ status: e.correctsPromotionRef ? "SUPERSEDED" : "SUPERSEDED" })
        .where(eq(hosRuleLimitHistory.id, previous.id));
    }

    await tx.insert(hosRuleLimitHistory).values({
      promotionRef,
      profileKey: e.profileKey,
      limitKey: e.limitKey,
      value: e.value,
      unit: e.unit,
      jurisdiction: e.jurisdiction,
      authorityType: e.authorityType,
      instrumentTitle: e.instrumentTitle,
      issuingAuthority: e.issuingAuthority,
      sourceSection: e.sourceSection,
      citationUrl: e.citationUrl,
      instrumentVersion: e.instrumentVersion ?? null,
      consolidationDate: e.consolidationDate ?? null,
      verificationMethod: e.verificationMethod,
      establishedByVersionRef: e.establishedByVersionRef ?? null,
      verifiedByUserId: e.verifiedByUserId,
      verifiedAt: e.verifiedAt,
      effectiveFrom: e.effectiveFrom ?? null,
      effectiveUntil: e.effectiveUntil ?? null,
      status,
      changeReason,
      correctsPromotionRef: e.correctsPromotionRef ?? null,
      previousPromotionRef: previous?.promotionRef ?? null,
    });

    // A future rule is known and not applied.
    if (status !== "CURRENT") return;

    const live = await tx.select({ id: hosRuleLimits.id }).from(hosRuleLimits)
      .where(and(eq(hosRuleLimits.profileKey, e.profileKey), eq(hosRuleLimits.limitKey, e.limitKey)))
      .limit(1);

    const row = {
      value: e.value,
      sourceSection: e.sourceSection,
      verificationStatus: "verified" as const,
      verifiedByUserId: e.verifiedByUserId,
      verifiedAt: e.verifiedAt,
      establishedByVersionRef: e.establishedByVersionRef ?? null,
      citationUrl: e.citationUrl,
      currentPromotionRef: promotionRef,
    };

    if (live[0]) await tx.update(hosRuleLimits).set(row).where(eq(hosRuleLimits.id, live[0].id));
    else await tx.insert(hosRuleLimits).values({ profileKey: e.profileKey, limitKey: e.limitKey, ...row });
  });

  return { promoted: true, promotionRef, status, becameCurrent: status === "CURRENT" };
}

/* ------------------------------------------------------------------ */
/* Reading the ledger                                                  */
/* ------------------------------------------------------------------ */

/** Every promotion for a limit, oldest first. */
export async function ledgerFor(profileKey: string, limitKey: string) {
  const db = await dbOrThrow();
  return db.select().from(hosRuleLimitHistory)
    .where(and(eq(hosRuleLimitHistory.profileKey, profileKey), eq(hosRuleLimitHistory.limitKey, limitKey)))
    .orderBy(hosRuleLimitHistory.id);
}

/**
 * What LeaseOS believed on a date.
 *
 * The audit question. Answered by reading the ledger rather than by trusting
 * the live row, which only knows about now.
 */
export async function believedOn(profileKey: string, limitKey: string, at: Date): Promise<{ value: number; promotionRef: string; citationUrl: string } | null> {
  const rows = await ledgerFor(profileKey, limitKey);
  const held = rows.filter((r) => r.recordedAt <= at && r.status !== "FUTURE");
  const last = held[held.length - 1];
  return last ? { value: last.value, promotionRef: last.promotionRef, citationUrl: last.citationUrl } : null;
}

export type Divergence = {
  profileKey: string; limitKey: string; field: string; live: unknown; ledger: unknown;
};

/**
 * Does every live figure still match the promotion that produced it?
 *
 * If this ever finds something, `hosRuleLimits` was written outside the
 * promotion path — which is the one thing the ledger cannot survive.
 */
export async function divergences(): Promise<Divergence[]> {
  const db = await dbOrThrow();
  const live = await db.select().from(hosRuleLimits).where(eq(hosRuleLimits.verificationStatus, "verified"));
  const out: Divergence[] = [];

  for (const row of live) {
    if (!row.currentPromotionRef) continue; // predates 0091
    const promo = await db.select().from(hosRuleLimitHistory)
      .where(eq(hosRuleLimitHistory.promotionRef, row.currentPromotionRef)).limit(1);
    const p = promo[0];
    if (!p) {
      out.push({ profileKey: row.profileKey, limitKey: row.limitKey, field: "promotionRef", live: row.currentPromotionRef, ledger: null });
      continue;
    }
    if (p.value !== row.value) out.push({ profileKey: row.profileKey, limitKey: row.limitKey, field: "value", live: row.value, ledger: p.value });
    if (p.citationUrl !== row.citationUrl) out.push({ profileKey: row.profileKey, limitKey: row.limitKey, field: "citationUrl", live: row.citationUrl, ledger: p.citationUrl });
    if (p.verifiedByUserId !== row.verifiedByUserId) out.push({ profileKey: row.profileKey, limitKey: row.limitKey, field: "verifiedByUserId", live: row.verifiedByUserId, ledger: p.verifiedByUserId });
  }
  return out;
}

/** Promotions known but not yet in force. */
export async function pendingFutureRules(now: Date) {
  const db = await dbOrThrow();
  const rows = await db.select().from(hosRuleLimitHistory).where(eq(hosRuleLimitHistory.status, "FUTURE"));
  return rows.filter((r) => !r.effectiveFrom || r.effectiveFrom > now);
}
