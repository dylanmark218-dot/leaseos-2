/**
 * LeaseOS Knowledge Architecture — the admission gate.
 *
 * Built to the perimeter document, which rejects the common blueprint in its
 * first step. That blueprint says: scrape the course, chunk it, embed it,
 * answer from it. The perimeter says something narrower and harder:
 *
 *   "the vector store should be the search layer, not the legal/compliance
 *    database itself"
 *
 * and, about government courses specifically:
 *
 *   "LeaseOS should distinguish between public regulatory facts that can be
 *    referenced and course content whose reproduction or reuse may have
 *    licensing/terms restrictions. We can index links and permitted material
 *    without assuming that an entire course can legally be copied and
 *    redistributed."
 *
 * So this module is the step the blueprint has no equivalent for: a licence
 * and authority check that runs **before** anything is chunked, and again
 * before anything reaches an answer.
 *
 * Nothing here retrieves, embeds or answers. It decides what is allowed to.
 */
import type { AuthorityClass, DispatchEffect } from "../complianceFinding";

/* ------------------------------------------------------------------ */
/* Authority                                                           */
/* ------------------------------------------------------------------ */

/**
 * Six levels, from the perimeter document. The ordering is load-bearing:
 * a lower level may never outrank a higher one in a regulatory answer.
 */
export const AUTHORITY_LEVELS = [
  "law",                  // A — legislation, regulations, regulator directives
  "official_guidance",    // B — government manuals, bulletins, carrier education
  "recognized_standard",  // C — NSC, CSA where licensed, manufacturer specs
  "manufacturer",         // C — manufacturer procedures
  "company_policy",       // D — employer rules, SOPs, client and site requirements
  "operational",          // E — historical jobs, access routes, facility notes
  "unverified",           // F — AI inference, driver observation, third-party
] as const;

export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

/** Lower number binds harder. Used for ranking, never for hiding. */
const RANK: Readonly<Record<AuthorityLevel, number>> = {
  law: 0, official_guidance: 1, recognized_standard: 2, manufacturer: 2,
  company_policy: 3, operational: 4, unverified: 5,
};

export const outranks = (a: AuthorityLevel, b: AuthorityLevel): boolean => RANK[a] < RANK[b];

/**
 * Levels that may support a compliance or dispatch conclusion.
 *
 * The perimeter's rule: *"LeaseOS could explain something using Level F
 * material, but it could never silently promote it into a dispatch
 * authorization or compliance decision."*
 */
export const BINDING_LEVELS: readonly AuthorityLevel[] = [
  "law", "official_guidance", "recognized_standard", "manufacturer",
];

export const isBinding = (l: AuthorityLevel): boolean => BINDING_LEVELS.includes(l);

/* ------------------------------------------------------------------ */
/* Authority tier (C1b-1)                                              */
/* ------------------------------------------------------------------ */

/**
 * Knowledge authority → the compliance authority ladder.
 *
 * The design's mapping table (§4), as code. It is a table on purpose: no rule's tier is decided by
 * judgement at promotion time, and no stored `authorityLevel` or `authorityType` is rewritten.
 *
 * `official_guidance` sits at the statute tier because it interprets statute, but it is **guidance**:
 * it cannot block dispatch on its own. `recognized_standard` and `manufacturer` are best practice
 * unless a program version adopts them, in which case the adopting carrier policy supplies the tier.
 *
 * Only the binding levels have a tier; `company_policy`, `operational` and `unverified` do not map by
 * table (company policy is split by pack kind, C1b-2).
 */
export function tierForAuthority(level: AuthorityLevel, adoptedByProgram = false): AuthorityClass | null {
  switch (level) {
    case "law": return "statute_regulation";
    case "official_guidance": return "statute_regulation";
    case "recognized_standard":
    case "manufacturer": return adoptedByProgram ? "carrier_safety_policy" : "best_practice";
    default: return null;
  }
}

/** Guidance interprets; it does not bind. A rule resting on it alone may not block. */
export const isGuidance = (level: AuthorityLevel): boolean => level === "official_guidance";

/**
 * Which rule revisions need two distinct verifiers (C1b-Q3, recommended answer): a rule at the statute
 * or regulator-order tier whose dispatch effect is BLOCK. The HOS model, generalized.
 */
export const requiresSecondVerifier = (tier: AuthorityClass, effect: DispatchEffect): boolean =>
  effect === "BLOCK" && (tier === "statute_regulation" || tier === "regulator_order");

/** `best_practice` is capped at WARN (§4); guidance cannot BLOCK alone. */
export function maxEffectFor(tier: AuthorityClass, level: AuthorityLevel): DispatchEffect {
  if (tier === "best_practice" || isGuidance(level)) return "WARN";
  return "BLOCK";
}

/* ------------------------------------------------------------------ */
/* Licence                                                             */
/* ------------------------------------------------------------------ */

export type LicenceStatus = "public" | "licensed" | "permission_required" | "internal" | "unknown";

/**
 * What may be done with a source, independently.
 *
 * These are four separate permissions because they are four separate legal
 * questions. A government course is the case that proves it: its regulatory
 * *facts* are referenceable, its *text* may not be reproducible, and it is
 * almost certainly not licensed as training data.
 */
export type AllowedUses = {
  /** May its existence and location be indexed and shown? */
  search: boolean;
  /** May its content be quoted or paraphrased into an AI answer? */
  aiAnswer: boolean;
  /** May it be used to train or fine-tune a model? */
  training: boolean;
  /** May its text be stored and reproduced — which is what chunking is? */
  reproduce: boolean;
};

export type KnowledgeAuthority = {
  id: string;
  jurisdiction: string;
  authorityLevel: AuthorityLevel;
  issuingAuthority?: string;
  sourceTitle: string;
  sourceUrl?: string;
  section?: string;
  page?: number;
  publishedAt?: Date;
  effectiveFrom?: Date;
  effectiveUntil?: Date;
  lastVerifiedAt?: Date;
  supersedesId?: string;
  supersededById?: string;
  contentHash: string;
  licenceStatus: LicenceStatus;
  allowedUses: AllowedUses;
  confidence: "authority_confirmed" | "human_verified" | "imported" | "unverified";
};

/**
 * The default for a source nobody has assessed.
 *
 * Everything off. The perimeter's ingestion gate puts a COPYRIGHT / LICENCE
 * CHECK before PARSE, and "no licence" is not "public domain" — the same rule
 * the Open-Source & SBOM Policy applies to packages, applied to text.
 */
export const UNASSESSED: AllowedUses = { search: false, aiAnswer: false, training: false, reproduce: false };

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

export type Intent = "index" | "chunk" | "answer" | "quote" | "train";

export type Admission =
  | { admitted: true }
  | { admitted: false; reason: string; code: AdmissionRefusal };

export type AdmissionRefusal =
  | "LICENCE_UNASSESSED"
  | "REPRODUCTION_NOT_PERMITTED"
  | "ANSWERING_NOT_PERMITTED"
  | "TRAINING_NOT_PERMITTED"
  | "SEARCH_NOT_PERMITTED"
  | "SUPERSEDED"
  | "NOT_YET_EFFECTIVE"
  | "EXPIRED";

/**
 * May this source be used for this purpose, right now?
 *
 * `chunk` is deliberately gated on `reproduce`, not on `search`. Chunking a
 * document into a vector store stores its text — that is reproduction, whatever
 * the pipeline diagram calls it. This is the single check the scrape-and-embed
 * blueprint has no place for.
 */
export function admit(authority: KnowledgeAuthority, intent: Intent, now: Date): Admission {
  const u = authority.allowedUses;

  if (authority.licenceStatus === "unknown") {
    return { admitted: false, code: "LICENCE_UNASSESSED",
      reason: `"${authority.sourceTitle}" has not had a licence assessment; nothing may be done with it yet` };
  }

  if (authority.supersededById) {
    return { admitted: false, code: "SUPERSEDED",
      reason: `"${authority.sourceTitle}" is superseded by ${authority.supersededById}` };
  }
  if (authority.effectiveFrom && authority.effectiveFrom > now) {
    return { admitted: false, code: "NOT_YET_EFFECTIVE",
      reason: `"${authority.sourceTitle}" takes effect ${authority.effectiveFrom.toISOString().slice(0, 10)}` };
  }
  if (authority.effectiveUntil && authority.effectiveUntil <= now) {
    return { admitted: false, code: "EXPIRED",
      reason: `"${authority.sourceTitle}" ceased to have effect ${authority.effectiveUntil.toISOString().slice(0, 10)}` };
  }

  switch (intent) {
    case "index":
      return u.search ? { admitted: true }
        : { admitted: false, code: "SEARCH_NOT_PERMITTED", reason: `"${authority.sourceTitle}" may not be indexed` };
    case "chunk":
    case "quote":
      // Storing the text and reproducing the text are the same permission.
      return u.reproduce ? { admitted: true }
        : { admitted: false, code: "REPRODUCTION_NOT_PERMITTED",
            reason: `"${authority.sourceTitle}" may be referenced but its text may not be stored or reproduced` };
    case "answer":
      return u.aiAnswer ? { admitted: true }
        : { admitted: false, code: "ANSWERING_NOT_PERMITTED",
            reason: `"${authority.sourceTitle}" may not be used to compose an answer` };
    case "train":
      return u.training ? { admitted: true }
        : { admitted: false, code: "TRAINING_NOT_PERMITTED",
            reason: `"${authority.sourceTitle}" is not licensed as training data` };
  }
}

/* ------------------------------------------------------------------ */
/* Retrieval                                                           */
/* ------------------------------------------------------------------ */

export type Retrieved<T> = { authority: KnowledgeAuthority; content: T };

export type AnswerPlan<T> = {
  /** Passages the model may read and quote. */
  usable: readonly Retrieved<T>[];
  /**
   * Sources that are relevant and may be named and linked, but whose text may
   * not be reproduced. The perimeter's "index links and permitted material".
   */
  referenceOnly: readonly { authority: KnowledgeAuthority; reason: string }[];
  /** Excluded entirely, with the reason, so a gap is visible rather than silent. */
  withheld: readonly { authority: KnowledgeAuthority; reason: string; code: AdmissionRefusal }[];
  /** The highest authority level actually usable. */
  highestUsable: AuthorityLevel | null;
  /** True when nothing binding is available, so no compliance claim may be made. */
  advisoryOnly: boolean;
};

/**
 * Split retrieved passages into what may be answered from, what may only be
 * pointed at, and what is out.
 *
 * A source that fails `answer` but passes `index` is not dropped — it becomes a
 * citation. That is the difference between "we cannot tell you" and "we cannot
 * quote this, here is where it is".
 */
export function planAnswer<T>(hits: readonly Retrieved<T>[], now: Date): AnswerPlan<T> {
  const usable: Retrieved<T>[] = [];
  const referenceOnly: { authority: KnowledgeAuthority; reason: string }[] = [];
  const withheld: { authority: KnowledgeAuthority; reason: string; code: AdmissionRefusal }[] = [];

  for (const hit of hits) {
    const canAnswer = admit(hit.authority, "answer", now);
    const canQuote = admit(hit.authority, "quote", now);

    if (canAnswer.admitted && canQuote.admitted) { usable.push(hit); continue; }

    // One of the two refused, or we would not be here. Narrow explicitly rather
    // than reaching for `.reason` on a union that may not carry it.
    const refusal = !canAnswer.admitted ? canAnswer : canQuote;
    if (refusal.admitted) continue; // unreachable, but the type says nothing yet

    const canIndex = admit(hit.authority, "index", now);
    if (canIndex.admitted) {
      referenceOnly.push({ authority: hit.authority, reason: refusal.reason });
      continue;
    }

    withheld.push({ authority: hit.authority, reason: refusal.reason, code: refusal.code });
  }

  const levels = usable.map((u) => u.authority.authorityLevel);
  const highestUsable = levels.length
    ? levels.reduce((best, l) => (outranks(l, best) ? l : best))
    : null;

  return {
    usable, referenceOnly, withheld, highestUsable,
    // Nothing binding retrieved means the answer explains, it does not decide.
    advisoryOnly: highestUsable === null || !isBinding(highestUsable),
  };
}

/* ------------------------------------------------------------------ */
/* The line the AI may not cross                                       */
/* ------------------------------------------------------------------ */

/**
 * Operations the AI may never perform, from the perimeter document verbatim.
 *
 * *"LLM for language and reasoning; deterministic engines for authorization."*
 */
export const FORBIDDEN_AI_OUTCOMES = [
  "invent_hos_hours", "authorize_dispatch", "certify_driver", "declare_bridge_safe",
  "declare_permit_unnecessary", "clear_mechanical_defect", "modify_payroll",
  "finalize_invoice", "alter_audit_record", "issue_government_certificate",
] as const;

export type ForbiddenOutcome = (typeof FORBIDDEN_AI_OUTCOMES)[number];

export type ComplianceClaim = {
  topic: string;
  /** What the answer asserts. */
  assertion: string;
  /** The authorities it rests on. */
  supportedBy: readonly KnowledgeAuthority[];
  /** Whether it is being offered as a decision or as an explanation. */
  kind: "explanation" | "decision";
};

export type ClaimVerdict =
  | { permitted: true; kind: "explanation" | "decision" }
  | { permitted: false; reason: string };

/**
 * May this claim be made in the form it is being made?
 *
 * An explanation may rest on anything admitted. A **decision** may rest only on
 * binding authority, and even then LeaseOS's deterministic engines make it —
 * this only prevents the AI from phrasing an advisory answer as an
 * authorization.
 */
export function checkClaim(claim: ComplianceClaim): ClaimVerdict {
  if (claim.supportedBy.length === 0) {
    return { permitted: false, reason: "no authority supports this claim" };
  }

  if (claim.kind === "explanation") return { permitted: true, kind: "explanation" };

  const binding = claim.supportedBy.filter((a) => isBinding(a.authorityLevel));
  if (binding.length === 0) {
    const levels = Array.from(new Set(claim.supportedBy.map((a) => a.authorityLevel))).join(", ");
    return { permitted: false,
      reason: `a compliance decision needs binding authority; this rests only on ${levels}` };
  }

  const unverified = binding.filter((a) => a.confidence === "unverified" || a.confidence === "imported");
  if (unverified.length === binding.length) {
    return { permitted: false,
      reason: "every supporting authority is imported or unverified; a person has not confirmed any of them" };
  }

  return { permitted: true, kind: "decision" };
}
