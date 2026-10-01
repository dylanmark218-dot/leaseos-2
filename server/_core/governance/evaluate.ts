/**
 * G1 — `evaluate()`: one governance decision for one request.
 *
 * Pure. Everything it needs arrives in the request — the permission layer's answer, the acting
 * organization, the resource snapshot, the policy rows in force, and `now`. It cannot fail open on
 * I/O because it does none.
 *
 * Order, and why:
 *
 *   1. The LeaseOS rules (`rules.ts`), all mandatory. Every one runs; none short-circuits, so the
 *      trace shows every rule that objected, not only the first.
 *   2. The organization's own rows. An organization may refuse an action or require review of it. It
 *      cannot grant one (absence of refusal already is a grant), and a row claiming an authority an
 *      organization does not hold is ignored and named in the trace — "a lower level never weakens a
 *      higher one" is enforced by construction, not by trusting the row.
 *   3. The reported decision is the worst outcome: deny › not evaluated › action required › review ›
 *      allow. Ties go to the stronger authority, then to rule order. The trace keeps everything else,
 *      so a denial never hides the review or the missing acceptance behind it.
 *
 * Two organization rows in force under the same policy reference are a conflict, and a conflict goes
 * to a person. It is never resolved by date, version or row order (the `automationPolicy` rule).
 */
import { createHash } from "node:crypto";
import { REASON_CODES, type ReasonCode } from "@shared/_core/reasonCodes";
import {
  DECISION_SEVERITY,
  ORGANIZATION_AUTHORABLE,
  authorityRank,
  type GovernanceDecision,
  type GovernanceRequest,
  type OrganizationPolicyRow,
  type PolicyAuthority,
  type TraceEntry,
} from "./decision";
import { RULES, RULESET_VERSION, rulesetManifest, type RuleOutcome } from "./rules";

/** The hash of what this kernel enforces. Recorded on every decision, so a past decision names its rules. */
export const ruleSetHash = (): string => createHash("sha256").update(rulesetManifest()).digest("hex");

type Candidate = {
  order: number;
  ruleId: string;
  policyId: string;
  policyVersion: string;
  authority: PolicyAuthority;
  outcome: RuleOutcome;
};

const inForce = (row: OrganizationPolicyRow, at: Date) =>
  row.effectiveFrom.getTime() <= at.getTime() && (row.effectiveTo == null || row.effectiveTo.getTime() > at.getTime());

export function evaluate(req: GovernanceRequest): GovernanceDecision {
  const now = req.context.now;
  const trace: TraceEntry[] = [];
  const candidates: Candidate[] = [];

  /* 1. LeaseOS rules. */
  RULES.forEach((rule, i) => {
    const outcome = rule.decide(req);
    const base = { ruleId: rule.ruleId, policyId: rule.policyId, policyVersion: rule.version, authority: rule.authority };
    if (!outcome) {
      trace.push({ ...base, outcome: "no_opinion" });
      return;
    }
    trace.push({ ...base, outcome: outcome.decision, reasonCode: outcome.reasonCode, note: outcome.note });
    candidates.push({ order: i, ...base, outcome });
  });

  /* 2. The organization's rows for this exact action. */
  const rows = (req.context.organizationPolicies ?? []).filter(r => r.action === req.action && inForce(r, now));
  const byRef = new Map<string, OrganizationPolicyRow[]>();
  for (const r of rows) byRef.set(r.policyRef, [...(byRef.get(r.policyRef) ?? []), r]);

  let order = RULES.length;
  byRef.forEach((same, policyRef) => {
    const first = same[0]!;
    const base = { ruleId: `organization.${policyRef}`, policyId: policyRef, policyVersion: String(first.version), authority: first.authority };

    if (same.length > 1) {
      const versions = same.map(r => r.version).sort((a, b) => a - b).join(", ");
      const outcome: RuleOutcome = { decision: "require_review", reasonCode: "POLICY_CONFLICT", review: `Versions ${versions} of ${policyRef} are in force together`, note: `versions ${versions}` };
      trace.push({ ...base, policyVersion: versions, outcome: outcome.decision, reasonCode: outcome.reasonCode, note: outcome.note });
      candidates.push({ order: order++, ...base, policyVersion: versions, outcome });
      return;
    }
    if (!ORGANIZATION_AUTHORABLE.includes(first.authority)) {
      trace.push({ ...base, outcome: "ignored", reasonCode: "ORG_POLICY_EXCEEDS_CEILING", note: `An organization cannot author at ${first.authority}` });
      return;
    }
    if (first.effect === "allow") {
      trace.push({ ...base, outcome: "ignored", note: "An organization policy can refuse or require review; it cannot grant" });
      return;
    }
    const outcome: RuleOutcome = first.effect === "deny"
      ? { decision: "deny", reasonCode: "ORGANIZATION_POLICY_DENIED", review: `Refused under ${policyRef} v${first.version}` }
      : { decision: "require_review", reasonCode: "ORGANIZATION_POLICY_REVIEW", review: `Review required by ${policyRef} v${first.version}` };
    trace.push({ ...base, outcome: outcome.decision, reasonCode: outcome.reasonCode });
    candidates.push({ order: order++, ...base, outcome });
  });

  /* 3. The worst outcome, strongest authority first. */
  const hash = ruleSetHash();
  const winner = candidates.sort((a, b) =>
    DECISION_SEVERITY[b.outcome.decision] - DECISION_SEVERITY[a.outcome.decision]
    || authorityRank(a.authority) - authorityRank(b.authority)
    || a.order - b.order)[0];

  if (!winner) {
    const code: ReasonCode = "NO_RULE_OBJECTED";
    return {
      decision: "allow",
      policyId: "leaseos.governance", policyVersion: RULESET_VERSION, ruleId: "no_rule_objected",
      authority: "leaseos_mandatory_control",
      reasonCode: code, humanReason: REASON_CODES[code].humanReason, remediation: REASON_CODES[code].remediation,
      ruleSetHash: hash, trace, evaluatedAt: now,
    };
  }

  const { outcome } = winner;
  const entry = REASON_CODES[outcome.reasonCode];
  const decision: GovernanceDecision = {
    decision: outcome.decision,
    policyId: winner.policyId, policyVersion: winner.policyVersion, ruleId: winner.ruleId,
    authority: winner.authority,
    reasonCode: outcome.reasonCode,
    humanReason: entry.humanReason,
    remediation: entry.remediation,
    ruleSetHash: hash, trace, evaluatedAt: now,
  };
  if (outcome.requiredAction) decision.requiredAction = outcome.requiredAction;
  if (outcome.review) decision.review = { queue: "governance_review", reason: outcome.review };
  if (outcome.decision === "not_evaluated") {
    // An unexplained absence is not a record (interEngineStatus rule).
    decision.notEvaluatedReason = outcome.notEvaluatedReason ?? "no_data_source_loaded";
  }
  return decision;
}
