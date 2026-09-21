/**
 * §10.3 — what wins when two sources disagree about a road.
 *
 * Owner decision, 2026-09-19: precedence is **asymmetric**. A lower-authority or field source may
 * make a segment *less* trusted or *more* restrictive. It may never make a segment more permissive
 * than a controlling higher-authority restriction.
 *
 * The asymmetry is the whole rule, and it is not squeamishness. The two directions carry different
 * consequences and therefore deserve different evidence:
 *
 *   A driver reporting a washed-out bridge on a road the province lists as open is describing
 *   something he can see. Believing him costs a detour. Disbelieving him costs a truck.
 *
 *   A driver reporting that a closed road "looks fine" is describing the absence of something —
 *   and the absence of a visible reason is not evidence that the reason is absent. The closure may
 *   be a load restriction, a permit condition, or work starting tomorrow.
 *
 * So: negative observations tighten immediately; positive ones never loosen. Lifting an
 * authoritative restriction requires authority, not consensus.
 */

/** Who is speaking, most authoritative first. The order is the precedence. */
export const AUTHORITY_RANK = [
  "posted_road_authority",      // the sign on the road, and whoever controls it
  "official_restriction",       // a verified restriction from the controlling authority
  "operator_instruction",       // a verified instruction from the road's operator
  "leaseos_field_hazard",       // a confirmed hazard observed by our own people
  "open_map_data",              // OSM and other general map sources
] as const;

export type AuthorityLevel = (typeof AUTHORITY_RANK)[number];

const rankOf = (a: AuthorityLevel) => AUTHORITY_RANK.indexOf(a);

/** What a source says about whether the segment may be used. */
export type Posture = "open" | "restricted" | "closed" | "unknown";

/** Restrictiveness order: a source may always move a segment rightwards, never leftwards. */
const RESTRICTIVENESS: Record<Posture, number> = { open: 0, unknown: 1, restricted: 2, closed: 3 };

export type SourceClaim = {
  authority: AuthorityLevel;
  posture: Posture;
  /** What the claim actually says, in the words a person would read. */
  statement: string;
  observedAt: Date;
  /** A field observation nobody has corroborated is still credible; it is not yet verified. */
  verified: boolean;
};

export type PrecedenceVerdict = {
  /** The posture the route evaluator should act on. */
  effective: Posture;
  /** The claim that set it, so the reason is attributable. */
  governedBy: SourceClaim;
  /**
   * Every claim, kept. The decision explicitly refuses to resolve a disagreement by discarding the
   * losing side — a conflict is a fact about the road and it is surfaced, not tidied away.
   */
  claims: readonly SourceClaim[];
  /** True when sources genuinely disagree, so a person is told rather than left to notice. */
  conflicting: boolean;
  /** What it would take to make this segment more permissive than it now is. */
  toLift: string | null;
  explanation: string;
};

/**
 * Resolve the posture of one segment from everything said about it.
 *
 * Three rules, applied in this order:
 *
 *   1. The most restrictive posture from any **sufficiently authoritative** source governs.
 *   2. A **less** authoritative source may still tighten — a confirmed field hazard on a road the
 *      province calls open moves it to restricted, pending review.
 *   3. Nothing may loosen below what the highest-ranking source states. A driver's "looks open" on
 *      a closed road leaves it closed, and on an unknown road leaves it unknown: an unverified
 *      clearance is not a clearance, which is the same rule the evaluator already applies to a
 *      limit satisfied on unverified data.
 */
export function resolvePrecedence(claims: readonly SourceClaim[]): PrecedenceVerdict {
  if (claims.length === 0) {
    const none: SourceClaim = { authority: "open_map_data", posture: "unknown", statement: "Nothing is recorded about this segment.", observedAt: new Date(0), verified: false };
    return { effective: "unknown", governedBy: none, claims: [], conflicting: false, toLift: null, explanation: "Nothing is recorded about this segment, so its posture is unknown." };
  }

  // The highest-ranking source sets the floor: nothing below it may be read as more permissive.
  const topRank = Math.min(...claims.map(c => rankOf(c.authority)));
  const authoritative = claims.filter(c => rankOf(c.authority) === topRank);
  const floor = authoritative.reduce((a, b) => (RESTRICTIVENESS[b.posture] > RESTRICTIVENESS[a.posture] ? b : a));

  // Anything may tighten. A confirmed field hazard on an officially open road is the case this
  // exists for: believing it costs a detour, disbelieving it costs a truck.
  const tightest = claims.reduce((a, b) => (RESTRICTIVENESS[b.posture] > RESTRICTIVENESS[a.posture] ? b : a));
  const governedBy = RESTRICTIVENESS[tightest.posture] > RESTRICTIVENESS[floor.posture] ? tightest : floor;

  const postures = new Set(claims.map(c => c.posture));
  const conflicting = postures.size > 1;

  const toLift = governedBy.posture === "open"
    ? null
    : `Only ${AUTHORITY_RANK.slice(0, rankOf(governedBy.authority) + 1).join(" or ")} may lift this; a lower-ranking source reporting it clear does not.`;

  const loosenAttempts = claims.filter(c => RESTRICTIVENESS[c.posture] < RESTRICTIVENESS[governedBy.posture]);

  return {
    effective: governedBy.posture,
    governedBy,
    claims,
    conflicting,
    toLift,
    explanation: conflicting
      ? `${governedBy.posture} — ${governedBy.statement} (${governedBy.authority}). ${loosenAttempts.length} other source(s) read it as less restrictive and do not govern: ${loosenAttempts.map(c => `${c.authority} says ${c.posture}`).join("; ")}. Both are kept on the record.`
      : `${governedBy.posture} — ${governedBy.statement} (${governedBy.authority}).`,
  };
}

/**
 * A credible safety-negative observation may impose a conservative restriction immediately, before
 * anybody verifies it.
 *
 * This is the one place speed beats certainty, and deliberately so: waiting for verification before
 * acting on a reported washout means the next truck drives at it. The restriction is temporary by
 * construction — it names what would lift it, and lifting takes the authority path, not the passage
 * of time.
 */
export function provisionalRestriction(observation: {
  statement: string;
  observedAt: Date;
  observerIsOurs: boolean;
}): SourceClaim | null {
  if (!observation.observerIsOurs) return null;   // an unattributed report is not yet an observation
  return {
    authority: "leaseos_field_hazard",
    posture: "restricted",
    statement: observation.statement,
    observedAt: observation.observedAt,
    verified: false,
  };
}
