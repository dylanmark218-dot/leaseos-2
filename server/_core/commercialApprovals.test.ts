import { describe, expect, it } from "vitest";
import { ledgerProgress, mayApprove } from "./commercialApprovals";
import type { ApprovalRequirement } from "./commercialPolicy";

const one: ApprovalRequirement = { state: "KNOWN", approverRole: "office", secondPersonRequired: false, separationOfDuties: true, tier: { maxAmountCents: 500_000, bookOrgRef: null }, layer: "default" };
const two: ApprovalRequirement = { ...one, approverRole: "management", secondPersonRequired: true, tier: { maxAmountCents: null, bookOrgRef: null } };
const at = new Date("2026-09-17T12:00:00Z");

describe("approval ledger progress", () => {
  it("needs one approval in a single-person tier and two distinct people above the top tier; the same person twice does not count", () => {
    expect(ledgerProgress(one, [])).toMatchObject({ state: "AWAITING", required: 1 });
    expect(ledgerProgress(one, [{ userId: 1, roles: ["office"], at }])).toMatchObject({ state: "SATISFIED" });
    expect(ledgerProgress(two, [{ userId: 1, roles: ["management"], at }])).toMatchObject({ state: "AWAITING", approvals: 1, required: 2, awaiting: expect.stringContaining("second person") });
    expect(ledgerProgress(two, [{ userId: 1, roles: ["management"], at }, { userId: 1, roles: ["management"], at }])).toMatchObject({ state: "AWAITING", approvals: 1 });
    expect(ledgerProgress(two, [{ userId: 1, roles: ["management"], at }, { userId: 2, roles: ["management"], at }])).toMatchObject({ state: "SATISFIED", approvals: 2 });
    expect(ledgerProgress({ state: "UNKNOWN", reason: "no tier" }, [])).toMatchObject({ state: "REVIEW" });
  });
  it("refuses the preparer, a repeat approver, the wrong role, and an UNKNOWN requirement — each by name", () => {
    expect(mayApprove(one, [], { userId: 7, roles: ["office"] }, 7).reason).toContain("separation of duties");
    expect(mayApprove(two, [{ userId: 7, roles: ["management"], at }], { userId: 7, roles: ["management"] }, 1).reason).toContain("already approved");
    expect(mayApprove(one, [], { userId: 8, roles: ["dispatcher"] }, 1).reason).toBe("BLOCKED — requires role office");
    expect(mayApprove({ state: "UNKNOWN", reason: "no tier" }, [], { userId: 8, roles: ["management"] }, 1).reason).toContain("REVIEW");
    expect(mayApprove(one, [], { userId: 8, roles: ["management"] }, 1).allowed).toBe(true);   // management may act in any tier
  });
});
