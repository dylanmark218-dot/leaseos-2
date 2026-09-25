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
import { hosRuleLimitHistory, hosRuleLimits, knowledgeDocuments, knowledgeVersions } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { AuthorityClass, DispatchEffect, FindingDomain } from "../complianceFinding";
import { isBinding, maxEffectFor, requiresSecondVerifier, tierForAuthority, type AuthorityLevel } from "./admission";
import { checkCitation } from "./citationGuard";
import { checkPlausible } from "./rulePromotion";

const dbOrThrow = async () => {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
};

/**
 * The ledger holds more than one rule family since 0189 (C1b-1). Every HOS read below is
 * restricted to this family, so a document requirement or permit condition can never be read
 * back as an HOS limit.
 */
export const HOS_RULE_FAMILY = "hos_limit";
const isHos = () => eq(hosRuleLimitHistory.ruleFamily, HOS_RULE_FAMILY);

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

export const ref = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export function validateEvidence(e: PromotionEvidence, now: Date): { ok: true } | { ok: false; code: PromotionRefusal; reason: string } {
  if (!Number.isInteger(e.verifiedByUserId) || e.verifiedByUserId < 1) {
    return { ok: false, code: "NO_VERIFIER", reason: "a regulatory figure needs a named verifier; there is no automated path to verified" };
  }
  const cited = validateCitedEvidence(e, now);
  if (!cited.ok) return cited;

  const plausible = checkPlausible(e.limitKey, e.value);
  if (!plausible.ok) return { ok: false, code: "IMPLAUSIBLE_VALUE", reason: plausible.reason };

  return { ok: true };
}

/** What every promoted rule must show about where it came from, whatever its family (C1b-1). */
export type CitedEvidence = Pick<PromotionEvidence,
  "authorityType" | "instrumentTitle" | "jurisdiction" | "sourceSection" | "citationUrl"
  | "verificationMethod" | "verifiedAt" | "effectiveFrom" | "effectiveUntil">;

/**
 * The instrument, jurisdiction, citation, dates and freshness checks, in the order HOS has always
 * applied them. Shared so a non-HOS rule is held to exactly the same evidence bar.
 */
export function validateCitedEvidence(e: CitedEvidence, now: Date): { ok: true } | { ok: false; code: PromotionRefusal; reason: string } {
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
      isHos(),
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
      // 0189: the same row, described in the vocabulary every rule family shares.
      ruleFamily: HOS_RULE_FAMILY,
      ruleRef: `${e.profileKey}.${e.limitKey}`,
      domain: "hos",
      authorityTier: tierForAuthority(e.authorityType),
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
    // A row that promotion creates was established directly from the instrument
    // by the verifier, so the verifier is also its recorder (0124).
    else await tx.insert(hosRuleLimits).values({ profileKey: e.profileKey, limitKey: e.limitKey, recordedByUserId: e.verifiedByUserId, ...row });
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
    .where(and(isHos(), eq(hosRuleLimitHistory.profileKey, profileKey), eq(hosRuleLimitHistory.limitKey, limitKey)))
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
  // An HOS row always carries its figure; one without is not an HOS promotion and is not believed.
  const held = rows.filter((r) => r.recordedAt <= at && r.status !== "FUTURE" && r.value != null);
  const last = held[held.length - 1];
  return last && last.value != null
    ? { value: last.value, promotionRef: last.promotionRef, citationUrl: last.citationUrl } : null;
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
  const rows = await db.select().from(hosRuleLimitHistory).where(and(isHos(), eq(hosRuleLimitHistory.status, "FUTURE")));
  return rows.filter((r) => !r.effectiveFrom || r.effectiveFrom > now);
}

/*
 * ==================================================================
 * Other rule families (C1b-1, D-03)
 * ==================================================================
 *
 * The rule ledger, for every family.
 *
 * `hosRuleLimitHistory` has been the HOS promotion ledger since 0120. From 0189 it holds any rule
 * family, and this file is how a rule that is not an HOS figure gets into it. HOS keeps its own door,
 * `promote` above, because it also maintains the live `hosRuleLimits` row; everything else
 * lives in the ledger alone.
 *
 * What a promotion here must show, in addition to everything an HOS figure shows (instrument,
 * jurisdiction, citation, dates, freshness — `validateCitedEvidence`, shared):
 *
 * * **A verified source revision.** The rule names the `knowledgeVersions` row it was read from, and
 *   that row must itself be `verified` and not repealed. Its content hash is copied onto the rule, so
 *   a later change of source is detectable against the rule that relied on the old text.
 * * **A proposer who is not the verifier** (C1b-Q2). Nobody approves their own reading. A scraper or
 *   an AI can propose; nothing here accepts a verifier that is not a named person.
 * * **Two verifiers for the rules that stop a truck** (C1b-Q3): a BLOCK rule at the statute or
 *   regulator-order tier. Both distinct from each other and from the proposer.
 * * **An effect the authority can carry.** Guidance cannot block on its own and best practice is
 *   capped at WARN (§4).
 *
 * Lifecycle (§ C1b design): `candidate → reviewed → verified → active → superseded | withdrawn`.
 * `candidate` and `reviewed` are states of a proposal, before the ledger. `verified` and `active` are
 * the ledger's FUTURE and CURRENT, split by the effective date. Nothing becomes `active` except by
 * date, after verification.
 */

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export type RuleLifecycle = "candidate" | "reviewed" | "verified" | "active" | "superseded" | "withdrawn";

/** The only moves a rule makes. `active` is reached by date, never by a person. */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<RuleLifecycle, readonly RuleLifecycle[]>> = {
  candidate: ["reviewed", "withdrawn"],
  reviewed: ["verified", "candidate", "withdrawn"],
  verified: ["active", "superseded", "withdrawn"],
  active: ["superseded", "withdrawn"],
  superseded: [],
  withdrawn: [],
};

export const canTransition = (from: RuleLifecycle, to: RuleLifecycle): boolean =>
  LIFECYCLE_TRANSITIONS[from].includes(to);

/**
 * A ledger row's lifecycle, from its stored status and dates. No history is rewritten to say this:
 * the mapping is read, not written.
 */
export function lifecycleOf(row: { status: LedgerStatus; effectiveFrom: Date | null; effectiveUntil: Date | null }, now: Date): RuleLifecycle {
  if (row.status === "REVOKED") return "withdrawn";
  if (row.status === "SUPERSEDED" || row.status === "EXPIRED") return "superseded";
  if (row.effectiveUntil && row.effectiveUntil <= now) return "superseded";
  if (row.effectiveFrom && row.effectiveFrom > now) return "verified";
  return "active";
}

/** Source revisions: only `verified` backs a rule. */
export type SourceStatus = "candidate" | "reviewed" | "verified" | "superseded" | "withdrawn";

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

export type RuleEvidence = {
  /** Any family except `hos_limit`, which is promoted through `promotionLedger.promote`. */
  ruleFamily: string;
  ruleRef: string;
  domain: FindingDomain;
  dispatchEffect: DispatchEffect;
  /** The rule's content. Stored as JSON; a figure, a document list, a condition set. */
  payload: unknown;

  jurisdiction: string;
  authorityType: BindingAuthority;
  /** A standard or manufacturer figure adopted by a program version takes the carrier-policy tier. */
  adoptedByProgram?: boolean;
  instrumentTitle: string;
  issuingAuthority: string;
  sourceSection: string;
  citationUrl: string;
  instrumentVersion?: string;
  verificationMethod: VerificationMethod;
  /** → `knowledgeVersions.versionRef`. */
  sourceRevisionRef: string;

  proposedByUserId: number;
  verifiedByUserId: number;
  verifiedAt: Date;
  secondVerifierUserId?: number;
  secondVerifiedAt?: Date;
  effectiveFrom?: Date;
  effectiveUntil?: Date;
  correctsPromotionRef?: string;
};

export type RuleRefusal = PromotionRefusal
  | "HOS_FAMILY_USES_PROMOTE" | "NO_RULE_REF" | "NO_PROPOSER" | "SELF_VERIFICATION"
  | "NO_SECOND_VERIFIER" | "SECOND_VERIFIER_NOT_DISTINCT" | "NO_AUTHORITY_TIER"
  | "EFFECT_EXCEEDS_AUTHORITY" | "NO_SOURCE_REVISION" | "SOURCE_NOT_VERIFIED" | "SOURCE_REPEALED";

export type SourceRevision = {
  versionRef: string;
  contentHash: string;
  status: string;
  repealedAt: Date | null;
  effectiveUntil: Date | null;
};

const isPerson = (id: number | undefined): id is number => Number.isInteger(id) && (id as number) >= 1;

/** The tier a rule takes. Derived, never supplied: a proposer cannot pick a stronger tier. */
export const tierOf = (e: Pick<RuleEvidence, "authorityType" | "adoptedByProgram">): AuthorityClass | null =>
  tierForAuthority(e.authorityType, e.adoptedByProgram ?? false);

export function validateRuleEvidence(
  e: RuleEvidence, source: SourceRevision | null, now: Date,
): { ok: true; tier: AuthorityClass } | { ok: false; code: RuleRefusal; reason: string } {
  if (e.ruleFamily === HOS_RULE_FAMILY) {
    return { ok: false, code: "HOS_FAMILY_USES_PROMOTE", reason: "an HOS figure is promoted through hos.limitPromote, which also keeps the live limit" };
  }
  if (!e.ruleFamily.trim() || !e.ruleRef.trim()) {
    return { ok: false, code: "NO_RULE_REF", reason: "a rule must say which family and which rule it is" };
  }
  if (!isPerson(e.proposedByUserId)) {
    return { ok: false, code: "NO_PROPOSER", reason: "a rule revision records who proposed it" };
  }
  if (!isPerson(e.verifiedByUserId)) {
    return { ok: false, code: "NO_VERIFIER", reason: "a rule needs a named verifier; there is no automated path to verified" };
  }
  if (e.verifiedByUserId === e.proposedByUserId) {
    return { ok: false, code: "SELF_VERIFICATION", reason: "the person who proposed a rule does not verify it — a second person does" };
  }

  const cited = validateCitedEvidence(e, now);
  if (!cited.ok) return cited;

  const tier = tierOf(e);
  if (!tier) {
    return { ok: false, code: "NO_AUTHORITY_TIER", reason: `${e.authorityType} has no tier on the authority ladder` };
  }
  const ceiling = maxEffectFor(tier, e.authorityType);
  if (e.dispatchEffect === "BLOCK" && ceiling !== "BLOCK") {
    return { ok: false, code: "EFFECT_EXCEEDS_AUTHORITY",
      reason: e.authorityType === "official_guidance"
        ? "guidance interprets the law but cannot block dispatch on its own"
        : `${tier} is capped at ${ceiling}` };
  }

  if (requiresSecondVerifier(tier, e.dispatchEffect)) {
    if (!isPerson(e.secondVerifierUserId) || !e.secondVerifiedAt) {
      return { ok: false, code: "NO_SECOND_VERIFIER", reason: `a ${tier} rule that blocks dispatch needs a second, independent verifier` };
    }
    if (e.secondVerifierUserId === e.verifiedByUserId || e.secondVerifierUserId === e.proposedByUserId) {
      return { ok: false, code: "SECOND_VERIFIER_NOT_DISTINCT", reason: "the second verifier is a third person: not the proposer, not the first verifier" };
    }
    if (e.secondVerifiedAt > now) {
      return { ok: false, code: "AMBIGUOUS_EFFECTIVE_DATE", reason: "second verification in the future" };
    }
  }

  if (!e.sourceRevisionRef.trim() || !source) {
    return { ok: false, code: "NO_SOURCE_REVISION", reason: "a rule is verified against a source revision; name one that exists" };
  }
  if (source.status !== "verified") {
    return { ok: false, code: "SOURCE_NOT_VERIFIED", reason: `source revision ${source.versionRef} is ${source.status}; a rule cannot be more verified than its source` };
  }
  if ((source.repealedAt && source.repealedAt <= now) || (source.effectiveUntil && source.effectiveUntil <= now)) {
    return { ok: false, code: "SOURCE_REPEALED", reason: `source revision ${source.versionRef} is no longer in force` };
  }

  return { ok: true, tier };
}

/* ------------------------------------------------------------------ */
/* Promotion                                                           */
/* ------------------------------------------------------------------ */

export type RulePromotionOutcome =
  | { promoted: true; promotionRef: string; status: LedgerStatus; lifecycle: RuleLifecycle; tier: AuthorityClass }
  | { promoted: false; code: RuleRefusal; reason: string };

const sourceFor = async (versionRef: string): Promise<SourceRevision | null> => {
  if (!versionRef.trim()) return null;
  const db = await dbOrThrow();
  const rows = await db.select({
    versionRef: knowledgeVersions.versionRef, contentHash: knowledgeVersions.contentHash,
    status: knowledgeVersions.status, repealedAt: knowledgeVersions.repealedAt,
    effectiveUntil: knowledgeVersions.effectiveUntil,
  }).from(knowledgeVersions).where(eq(knowledgeVersions.versionRef, versionRef)).limit(1);
  return rows[0] ?? null;
};

/**
 * Record a verified rule revision. Same guarantees as the HOS ledger: one row per promoted state,
 * the departing row marked and never rewritten, corrections pointing at what they correct.
 */
export async function promoteRule(e: RuleEvidence, now: Date): Promise<RulePromotionOutcome> {
  const source = await sourceFor(e.sourceRevisionRef);
  const valid = validateRuleEvidence(e, source, now);
  if (!valid.ok) return { promoted: false, code: valid.code, reason: valid.reason };

  const db = await dbOrThrow();
  const sameRule = and(eq(hosRuleLimitHistory.ruleFamily, e.ruleFamily), eq(hosRuleLimitHistory.ruleRef, e.ruleRef));

  if (e.correctsPromotionRef) {
    const target = await db.select({ id: hosRuleLimitHistory.id }).from(hosRuleLimitHistory)
      .where(and(sameRule, eq(hosRuleLimitHistory.promotionRef, e.correctsPromotionRef))).limit(1);
    if (!target[0]) {
      return { promoted: false, code: "CORRECTS_UNKNOWN_PROMOTION", reason: `no promotion ${e.correctsPromotionRef} of ${e.ruleFamily}/${e.ruleRef} to correct` };
    }
  }

  const previous = (await db.select().from(hosRuleLimitHistory).where(sameRule)
    .orderBy(desc(hosRuleLimitHistory.id)).limit(1))[0];

  const payloadJson = JSON.stringify(e.payload ?? null);
  if (previous && !e.correctsPromotionRef &&
      previous.payloadJson === payloadJson &&
      previous.citationUrl === e.citationUrl &&
      previous.sourceSection === e.sourceSection &&
      previous.sourceRevisionRef === e.sourceRevisionRef &&
      previous.dispatchEffect === e.dispatchEffect &&
      previous.verifiedByUserId === e.verifiedByUserId) {
    return { promoted: false, code: "DUPLICATE_PROMOTION", reason: "this rule, source and verifier are already the current promotion" };
  }

  const status = statusFor(e, now);
  const promotionRef = ref("RULE-PROM");
  const changeReason = e.correctsPromotionRef ? "CORRECTED_VERIFICATION" : previous ? "VERIFIED_REVISION" : "INITIAL_VERIFICATION";
  const current = (previous && previous.status === "CURRENT")
    ? previous
    : (await db.select().from(hosRuleLimitHistory).where(and(sameRule, eq(hosRuleLimitHistory.status, "CURRENT")))
      .orderBy(desc(hosRuleLimitHistory.id)).limit(1))[0];

  await db.transaction(async (tx) => {
    if (current && status === "FUTURE" && e.effectiveFrom) {
      await tx.update(hosRuleLimitHistory)
        .set({ effectiveUntil: e.effectiveFrom })
        .where(eq(hosRuleLimitHistory.id, current.id));
    }
    if (previous) {
      const supersedesCurrentNow = previous.status === "CURRENT" && status === "CURRENT";
      const replacesFuture = previous.status === "FUTURE";
      const futureCorrectionReplacesCurrent = !!e.correctsPromotionRef && previous.status === "CURRENT" && status === "FUTURE" && !!e.effectiveFrom;
      if (supersedesCurrentNow || replacesFuture || futureCorrectionReplacesCurrent) {
        await tx.update(hosRuleLimitHistory)
          .set({
            status: "SUPERSEDED",
            effectiveUntil: replacesFuture ? previous.effectiveFrom ?? previous.effectiveUntil : e.effectiveFrom ?? previous.effectiveUntil,
          })
          .where(eq(hosRuleLimitHistory.id, previous.id));
      }
    }
    await tx.insert(hosRuleLimitHistory).values({
      promotionRef,
      profileKey: null, limitKey: null, value: null, unit: "none",
      jurisdiction: e.jurisdiction,
      authorityType: e.authorityType,
      instrumentTitle: e.instrumentTitle,
      issuingAuthority: e.issuingAuthority,
      sourceSection: e.sourceSection,
      citationUrl: e.citationUrl,
      instrumentVersion: e.instrumentVersion ?? null,
      verificationMethod: e.verificationMethod,
      establishedByVersionRef: e.sourceRevisionRef,
      verifiedByUserId: e.verifiedByUserId,
      verifiedAt: e.verifiedAt,
      effectiveFrom: e.effectiveFrom ?? null,
      effectiveUntil: e.effectiveUntil ?? null,
      status,
      changeReason,
      correctsPromotionRef: e.correctsPromotionRef ?? null,
      previousPromotionRef: previous?.promotionRef ?? null,
      ruleFamily: e.ruleFamily,
      ruleRef: e.ruleRef,
      domain: e.domain,
      authorityTier: valid.tier,
      dispatchEffect: e.dispatchEffect,
      sourceRevisionRef: e.sourceRevisionRef,
      // Copied, not referenced: the hash the verifier actually read against.
      sourceHash: source!.contentHash,
      proposedByUserId: e.proposedByUserId,
      secondVerifierUserId: e.secondVerifierUserId ?? null,
      secondVerifiedAt: e.secondVerifiedAt ?? null,
      payloadJson,
    });
  });

  return { promoted: true, promotionRef, status, lifecycle: lifecycleOf({ status, effectiveFrom: e.effectiveFrom ?? null, effectiveUntil: e.effectiveUntil ?? null }, now), tier: valid.tier };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** Every promotion of one rule, oldest first. */
export async function ruleHistory(ruleFamily: string, ruleRef: string) {
  const db = await dbOrThrow();
  return db.select().from(hosRuleLimitHistory)
    .where(and(eq(hosRuleLimitHistory.ruleFamily, ruleFamily), eq(hosRuleLimitHistory.ruleRef, ruleRef)))
    .orderBy(hosRuleLimitHistory.id);
}

export type BelievedRule = {
  promotionRef: string;
  ruleFamily: string;
  ruleRef: string;
  authorityTier: string | null;
  dispatchEffect: string | null;
  sourceRevisionRef: string | null;
  sourceHash: string | null;
  payload: unknown;
};

/**
 * The rule in force at `at`, as LeaseOS knew it at `at`.
 *
 * Only rows recorded by then count — today's knowledge is never applied to yesterday's decision —
 * and of those, the last one whose effective window covers `at`. A future rule recorded early is
 * picked up on its effective date without anyone flipping a status.
 */
export async function believedRuleOn(ruleFamily: string, ruleRef: string, at: Date): Promise<BelievedRule | null> {
  const rows = await ruleHistory(ruleFamily, ruleRef);
  const held = rows.filter((r) =>
    r.recordedAt <= at && r.status !== "REVOKED" &&
    (!r.effectiveFrom || r.effectiveFrom <= at) &&
    (!r.effectiveUntil || r.effectiveUntil > at));
  const last = held[held.length - 1];
  if (!last) return null;
  return {
    promotionRef: last.promotionRef, ruleFamily: last.ruleFamily, ruleRef: last.ruleRef ?? ruleRef,
    authorityTier: last.authorityTier, dispatchEffect: last.dispatchEffect,
    sourceRevisionRef: last.sourceRevisionRef, sourceHash: last.sourceHash,
    payload: last.payloadJson == null ? null : JSON.parse(last.payloadJson),
  };
}

/**
 * Rules whose source revision has changed status since they were verified: the source was
 * superseded, withdrawn or repealed after the rule was read from it. Nothing is changed; the list is
 * for a person to re-read.
 */
export async function rulesOnStaleSources(now: Date) {
  const db = await dbOrThrow();
  const rows = await db.select({
    promotionRef: hosRuleLimitHistory.promotionRef, ruleFamily: hosRuleLimitHistory.ruleFamily,
    ruleRef: hosRuleLimitHistory.ruleRef, ruleStatus: hosRuleLimitHistory.status,
    sourceRevisionRef: hosRuleLimitHistory.sourceRevisionRef, sourceHash: hosRuleLimitHistory.sourceHash,
    sourceStatus: knowledgeVersions.status, sourceContentHash: knowledgeVersions.contentHash,
    repealedAt: knowledgeVersions.repealedAt,
  }).from(hosRuleLimitHistory)
    .innerJoin(knowledgeVersions, eq(knowledgeVersions.versionRef, hosRuleLimitHistory.sourceRevisionRef));
  return rows.filter((r) =>
    (r.ruleStatus === "CURRENT" || r.ruleStatus === "FUTURE") &&
    ((r.sourceStatus !== "verified" && r.sourceStatus !== "superseded")
      || r.sourceContentHash !== r.sourceHash
      || (r.repealedAt != null && r.repealedAt <= now)));
}

/* ------------------------------------------------------------------ */
/* Source verification                                                 */
/* ------------------------------------------------------------------ */

export type SourceVerifyOutcome =
  | { verified: true }
  | { verified: false; code: "NO_VERIFIER" | "UNKNOWN_SOURCE" | "SELF_VERIFICATION" | "NOT_VERIFIABLE"; reason: string };

/**
 * Mark a source revision verified. A named person, never the one who fetched the document it belongs
 * to (C1b-Q2), and only from `candidate` or `reviewed`: a superseded or withdrawn revision stays so.
 */
export async function verifySourceRevision(versionRef: string, verifierUserId: number, now: Date): Promise<SourceVerifyOutcome> {
  if (!isPerson(verifierUserId)) return { verified: false, code: "NO_VERIFIER", reason: "a source is verified by a named person" };
  const db = await dbOrThrow();
  const row = (await db.select({ id: knowledgeVersions.id, status: knowledgeVersions.status, fetchedByUserId: knowledgeDocuments.fetchedByUserId })
    .from(knowledgeVersions)
    .leftJoin(knowledgeDocuments, eq(knowledgeDocuments.documentRef, knowledgeVersions.documentRef))
    .where(eq(knowledgeVersions.versionRef, versionRef)).limit(1))[0];
  if (!row) return { verified: false, code: "UNKNOWN_SOURCE", reason: `no source revision ${versionRef}` };
  // Read from the document, never taken from the caller.
  if (row.fetchedByUserId != null && row.fetchedByUserId === verifierUserId) {
    return { verified: false, code: "SELF_VERIFICATION", reason: "the person who fetched a source does not verify it" };
  }
  if (row.status !== "candidate" && row.status !== "reviewed") {
    return { verified: false, code: "NOT_VERIFIABLE", reason: `source revision ${versionRef} is ${row.status}` };
  }
  await db.update(knowledgeVersions)
    .set({ status: "verified", verifiedByUserId: verifierUserId, verifiedAt: now })
    .where(eq(knowledgeVersions.id, row.id));
  return { verified: true };
}
