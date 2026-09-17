/**
 * P7.1 — Commercial Office policy resolution (pure).
 *
 * Every commercial rule is configuration with two layers: the platform default
 * (bookOrgRef NULL) and one business's own answer (bookOrgRef set), which wins
 * for that business. Resolution never invents a rule: an amount no active tier
 * covers, or a category with no tiers at all, is UNKNOWN and goes to review.
 */

export type ApprovalPolicyRow = {
  bookOrgRef: string | null;
  category: string;
  maxAmountCents: number | null;   // null = no upper bound
  approverRole: string;
  secondPersonRequired: boolean;
  separationOfDuties: boolean;
  status: "active" | "retired";
};

export type ApprovalRequirement =
  | { state: "KNOWN"; approverRole: string; secondPersonRequired: boolean; separationOfDuties: boolean; tier: { maxAmountCents: number | null; bookOrgRef: string | null } ; layer: "business" | "default" }
  | { state: "UNKNOWN"; reason: string };

/** The rows that govern one business: its own rows for a category when it wrote some, else the defaults. */
export function layerFor<T extends { bookOrgRef: string | null; category?: string; status?: string }>(rows: T[], bookOrgRef: string | null, category?: string): { layer: "business" | "default"; rows: T[] } {
  const active = rows.filter(r => (r.status ?? "active") === "active" && (category === undefined || r.category === category));
  const own = bookOrgRef ? active.filter(r => r.bookOrgRef === bookOrgRef) : [];
  if (own.length) return { layer: "business", rows: own };
  return { layer: "default", rows: active.filter(r => r.bookOrgRef === null) };
}

/** Which approval a category and amount require for this business. */
export function approvalRequirementFor(rows: ApprovalPolicyRow[], args: { bookOrgRef: string | null; category: string; amountCents: number }): ApprovalRequirement {
  if (!Number.isFinite(args.amountCents) || args.amountCents < 0) return { state: "UNKNOWN", reason: "amount is not a valid non-negative figure" };
  const { layer, rows: tiers } = layerFor(rows, args.bookOrgRef, args.category);
  if (!tiers.length) return { state: "UNKNOWN", reason: `no approval policy covers category "${args.category}" for this business` };
  // The lowest tier whose ceiling the amount does not exceed; an unbounded tier catches the rest.
  const ordered = [...tiers].sort((a, b) => (a.maxAmountCents ?? Number.POSITIVE_INFINITY) - (b.maxAmountCents ?? Number.POSITIVE_INFINITY));
  const tier = ordered.find(t => t.maxAmountCents === null || args.amountCents <= t.maxAmountCents);
  if (!tier) return { state: "UNKNOWN", reason: `no ${layer} tier covers $${(args.amountCents / 100).toFixed(2)} for "${args.category}"` };
  return { state: "KNOWN", approverRole: tier.approverRole, secondPersonRequired: tier.secondPersonRequired, separationOfDuties: tier.separationOfDuties, tier: { maxAmountCents: tier.maxAmountCents, bookOrgRef: tier.bookOrgRef }, layer };
}

/** May this person approve, given who prepared it? Separation of duties is a refusal by name, not a warning. */
export function approvalDecision(req: ApprovalRequirement, actor: { userId: number; roles: string[] }, preparedByUserId: number | null): { allowed: boolean; reason: string } {
  if (req.state === "UNKNOWN") return { allowed: false, reason: `REVIEW — ${req.reason}` };
  if (req.separationOfDuties && preparedByUserId !== null && preparedByUserId === actor.userId) return { allowed: false, reason: "BLOCKED — separation of duties: the preparer may not approve" };
  if (!actor.roles.includes(req.approverRole) && !actor.roles.includes("management")) return { allowed: false, reason: `BLOCKED — requires role ${req.approverRole}` };
  return { allowed: true, reason: req.secondPersonRequired ? "first approval recorded; a second person is required before this takes effect" : "approved within tier" };
}

/** Format a commercial number the way the business's numbering policy says. */
export type NumberingPolicyRow = { bookOrgRef: string | null; sequenceType: string; prefix: string; separator: string; yearDigits: number; includeMonth: boolean; sequenceDigits: number; resetPeriod: "never" | "yearly" | "monthly" };
export function numberingPolicyFor(rows: NumberingPolicyRow[], bookOrgRef: string | null, sequenceType: string): NumberingPolicyRow | null {
  const own = bookOrgRef ? rows.find(r => r.bookOrgRef === bookOrgRef && r.sequenceType === sequenceType) : undefined;
  return own ?? rows.find(r => r.bookOrgRef === null && r.sequenceType === sequenceType) ?? null;
}
