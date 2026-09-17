import { describe, expect, it } from "vitest";
import { approvalDecision, approvalRequirementFor, layerFor, numberingPolicyFor, type ApprovalPolicyRow } from "./commercialPolicy";

const tier = (o: Partial<ApprovalPolicyRow>): ApprovalPolicyRow => ({ bookOrgRef: null, category: "purchase_order", maxAmountCents: null, approverRole: "management", secondPersonRequired: false, separationOfDuties: true, status: "active", ...o });
const DEFAULTS: ApprovalPolicyRow[] = [
  tier({ maxAmountCents: 500_000, approverRole: "office" }),
  tier({ maxAmountCents: 2_500_000, approverRole: "management" }),
  tier({ maxAmountCents: null, approverRole: "management", secondPersonRequired: true }),
];

describe("approval ladder — the owner's defaults", () => {
  it("routes $4,999.99 to office, $25,000 to management, and $25,000.01 to management with a second person", () => {
    const at = (c: number) => approvalRequirementFor(DEFAULTS, { bookOrgRef: "ORG-A", category: "purchase_order", amountCents: c });
    expect(at(499_999)).toMatchObject({ state: "KNOWN", approverRole: "office", secondPersonRequired: false, layer: "default" });
    expect(at(2_500_000)).toMatchObject({ state: "KNOWN", approverRole: "management", secondPersonRequired: false });
    expect(at(2_500_001)).toMatchObject({ state: "KNOWN", approverRole: "management", secondPersonRequired: true });
  });
  it("is UNKNOWN for a category no policy covers, and for a business whose own tiers stop short", () => {
    expect(approvalRequirementFor(DEFAULTS, { bookOrgRef: null, category: "expense_claim", amountCents: 100 })).toMatchObject({ state: "UNKNOWN" });
    const capped = [...DEFAULTS, tier({ bookOrgRef: "ORG-B", maxAmountCents: 100_000, approverRole: "office" })];
    // ORG-B wrote its own ladder with one tier to $1,000: above that nothing covers it, and the defaults do NOT fill the gap.
    expect(approvalRequirementFor(capped, { bookOrgRef: "ORG-B", category: "purchase_order", amountCents: 100_001 })).toMatchObject({ state: "UNKNOWN" });
    expect(approvalRequirementFor(capped, { bookOrgRef: "ORG-B", category: "purchase_order", amountCents: 100_000 })).toMatchObject({ state: "KNOWN", layer: "business", approverRole: "office" });
  });
  it("lets a business override a category while other categories keep the defaults", () => {
    const rows = [...DEFAULTS, tier({ bookOrgRef: "ORG-C", category: "purchase_order", maxAmountCents: null, approverRole: "office" })];
    expect(approvalRequirementFor(rows, { bookOrgRef: "ORG-C", category: "purchase_order", amountCents: 9_000_000 })).toMatchObject({ state: "KNOWN", layer: "business", approverRole: "office" });
    expect(layerFor(DEFAULTS.map(t => ({ ...t, category: "credit" })), "ORG-C", "credit").layer).toBe("default");
  });
  it("lets a business retire a category in its own book: the default does not come back", () => {
    const rows = [...DEFAULTS, { ...tier({ bookOrgRef: "ORG-R", category: "purchase_order" }), status: "retired" as const }];
    const l = layerFor(rows, "ORG-R", "purchase_order");
    expect(l).toEqual({ layer: "business", rows: [] });
    expect(approvalRequirementFor(rows, { bookOrgRef: "ORG-R", category: "purchase_order", amountCents: 100 })).toMatchObject({ state: "UNKNOWN" });
    expect(layerFor(rows, "ORG-S", "purchase_order").layer).toBe("default");   // everyone else still has the default
  });
  it("refuses a negative or non-finite amount as UNKNOWN rather than fitting it to the lowest tier", () => {
    expect(approvalRequirementFor(DEFAULTS, { bookOrgRef: null, category: "purchase_order", amountCents: -1 })).toMatchObject({ state: "UNKNOWN" });
    expect(approvalRequirementFor(DEFAULTS, { bookOrgRef: null, category: "purchase_order", amountCents: Number.NaN })).toMatchObject({ state: "UNKNOWN" });
  });
});

describe("approval decision", () => {
  const req = approvalRequirementFor(DEFAULTS, { bookOrgRef: null, category: "purchase_order", amountCents: 400_000 });
  it("blocks the preparer by name, blocks the wrong role by name, and names the second person when one is required", () => {
    expect(approvalDecision(req, { userId: 7, roles: ["office"] }, 7)).toMatchObject({ allowed: false, reason: expect.stringContaining("separation of duties") });
    expect(approvalDecision(req, { userId: 8, roles: ["dispatcher"] }, 7)).toMatchObject({ allowed: false, reason: "BLOCKED — requires role office" });
    expect(approvalDecision(req, { userId: 8, roles: ["office"] }, 7)).toMatchObject({ allowed: true });
    const big = approvalRequirementFor(DEFAULTS, { bookOrgRef: null, category: "purchase_order", amountCents: 9_000_000 });
    expect(approvalDecision(big, { userId: 9, roles: ["management"] }, 7).reason).toContain("second person");
    expect(approvalDecision({ state: "UNKNOWN", reason: "x" }, { userId: 9, roles: ["management"] }, 7)).toMatchObject({ allowed: false, reason: expect.stringContaining("REVIEW") });
  });
});

describe("numbering policy", () => {
  const rows = [
    { bookOrgRef: null, sequenceType: "CLI", prefix: "CLI", separator: "-", yearDigits: 0, includeMonth: false, sequenceDigits: 6, resetPeriod: "never" as const },
    { bookOrgRef: "ORG-D", sequenceType: "CLI", prefix: "CUST", separator: "", yearDigits: 2, includeMonth: false, sequenceDigits: 4, resetPeriod: "yearly" as const },
  ];
  it("gives a business its own format and everyone else the default; an unknown sequence is null, not a guess", () => {
    expect(numberingPolicyFor(rows, "ORG-D", "CLI")?.prefix).toBe("CUST");
    expect(numberingPolicyFor(rows, "ORG-E", "CLI")?.prefix).toBe("CLI");
    expect(numberingPolicyFor(rows, "ORG-E", "XYZ")).toBeNull();
  });
});
