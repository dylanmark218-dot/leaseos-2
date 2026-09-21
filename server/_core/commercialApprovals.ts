/**
 * P7.4 — the approval ledger (pure). One record per money decision the office
 * takes: the requirement the ladder produced at the time (snapshotted, with its
 * layer and tier), and each person's approval in order. Whether the requirement
 * is satisfied is computed here from the snapshot and the approvals, so an
 * approval is never a matter of a single status flip.
 */
import type { ApprovalRequirement } from "./commercialPolicy";

export type LedgerApproval = { userId: number; roles: string[]; at: Date };
export type LedgerProgress =
  | { state: "SATISFIED"; approvals: number; required: number }
  | { state: "AWAITING"; approvals: number; required: number; awaiting: string }
  | { state: "REVIEW"; reason: string };

/** How far along the requirement is, given who has approved. */
export function ledgerProgress(requirement: ApprovalRequirement, approvals: LedgerApproval[]): LedgerProgress {
  if (requirement.state === "UNKNOWN") return { state: "REVIEW", reason: requirement.reason };
  const required = requirement.secondPersonRequired ? 2 : 1;
  const distinct = new Set(approvals.map(a => a.userId)).size;
  if (distinct >= required) return { state: "SATISFIED", approvals: distinct, required };
  return { state: "AWAITING", approvals: distinct, required, awaiting: distinct === 0 ? `an approval from ${requirement.approverRole}${requirement.secondPersonRequired ? " and a second person" : ""}` : "a second person, different from the first approver" };
}

/** May this person add an approval now? Refusals are by name. */
export function mayApprove(requirement: ApprovalRequirement, prior: LedgerApproval[], actor: { userId: number; roles: string[] }, preparedByUserId: number | null): { allowed: boolean; reason: string } {
  if (requirement.state === "UNKNOWN") return { allowed: false, reason: `REVIEW — ${requirement.reason}` };
  if (requirement.separationOfDuties && preparedByUserId !== null && preparedByUserId === actor.userId) return { allowed: false, reason: "BLOCKED — separation of duties: the preparer may not approve" };
  if (prior.some(p => p.userId === actor.userId)) return { allowed: false, reason: "BLOCKED — this person has already approved; the second approval must come from someone else" };
  if (!actor.roles.includes(requirement.approverRole) && !actor.roles.includes("management")) return { allowed: false, reason: `BLOCKED — requires role ${requirement.approverRole}` };
  return { allowed: true, reason: "within tier" };
}
