import { describe, expect, it } from "vitest";
import {
  assessRegistrationThreshold,
  buildFilingProfile,
  determine,
  isUsable,
  selectRule,
  UNKNOWN_DISPLAY,
  type TaxRule,
} from "./taxRuleEngine";
import {
  allocationsBalance,
  applyHumanTreatment,
  assessExpense,
  assessSalesTaxRecoverability,
  buildAllocations,
  findDuplicateCandidates,
} from "./expenseTreatment";
import {
  assertPayrollEligibility,
  assertSettlementEligibility,
  calculateEarning,
  canTransitionPayRun,
  correctionRouteFor,
  eligibleRevenueFor,
  payrollActivityAffectsHos,
  payRunIsEditable,
  rateInForce,
  reconcileClocks,
  type PayRate,
} from "./payrollEngine";

const d = (s: string) => new Date(s);

const verifiedRule = (over: Partial<TaxRule> = {}): TaxRule => ({
  ruleKey: "test.rule",
  version: 1,
  jurisdiction: "CA-AB",
  ruleType: "registration_threshold",
  parameters: { amount: 1000 },
  effectiveFrom: d("2026-01-01"),
  status: "verified",
  source: { sourceKey: "src", authority: "Test Authority" },
  ...over,
});

/* ================================================================== */

describe("tax rules are never invented", () => {
  it("returns unknown when no rule is loaded at all", () => {
    const r = determine([], {
      jurisdiction: "CA-AB",
      ruleType: "registration_threshold",
      asOf: d("2026-06-01"),
    });
    expect(r.outcome).toBe("unknown");
    expect(isUsable(r)).toBe(false);
    expect(r.caveat).toBe(UNKNOWN_DISPLAY);
    expect(r.parameters).toBeUndefined();
  });

  it("refuses to use an unverified rule even though the number is right there", () => {
    // The whole point. A rule can be recorded, carry a plausible figure, and
    // still not be usable until its source is verified.
    const rules = [verifiedRule({ status: "unverified", parameters: { amount: 30000 } })];
    const r = determine(rules, {
      jurisdiction: "CA-AB",
      ruleType: "registration_threshold",
      asOf: d("2026-06-01"),
    });
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toContain("unverified");
    expect(JSON.stringify(r)).not.toContain("30000");
  });

  it("refuses an expired or superseded rule", () => {
    for (const status of ["expired", "superseded"] as const) {
      const r = determine([verifiedRule({ status })], {
        jurisdiction: "CA-AB",
        ruleType: "registration_threshold",
        asOf: d("2026-06-01"),
      });
      expect(r.outcome, status).toBe("unknown");
    }
  });

  it("refuses a rule outside its effective window", () => {
    const rules = [
      verifiedRule({ effectiveFrom: d("2027-01-01") }),
    ];
    expect(
      determine(rules, {
        jurisdiction: "CA-AB",
        ruleType: "registration_threshold",
        asOf: d("2026-06-01"),
      }).outcome
    ).toBe("unknown");
  });

  it("does not cross jurisdictions", () => {
    const rules = [verifiedRule({ jurisdiction: "CA-BC" })];
    expect(
      determine(rules, {
        jurisdiction: "CA-AB",
        ruleType: "registration_threshold",
        asOf: d("2026-06-01"),
      }).outcome
    ).toBe("unknown");
  });

  it("uses the rule that was in force, not the newest one", () => {
    // Amending a prior period must re-run against the old rule.
    const rules = [
      verifiedRule({ ruleKey: "t.v1", version: 1, effectiveFrom: d("2025-01-01"), effectiveUntil: d("2025-12-31"), parameters: { amount: 100 } }),
      verifiedRule({ ruleKey: "t.v2", version: 2, effectiveFrom: d("2026-01-01"), parameters: { amount: 200 } }),
    ];
    const old = determine(rules, { jurisdiction: "CA-AB", ruleType: "registration_threshold", asOf: d("2025-06-01") });
    expect(old.parameters?.amount).toBe(100);
    const now = determine(rules, { jurisdiction: "CA-AB", ruleType: "registration_threshold", asOf: d("2026-06-01") });
    expect(now.parameters?.amount).toBe(200);
  });

  it("reports why each candidate was rejected", () => {
    const { rule, rejected } = selectRule(
      [verifiedRule({ status: "unverified" })],
      { jurisdiction: "CA-AB", ruleType: "registration_threshold", asOf: d("2026-06-01") }
    );
    expect(rule).toBeNull();
    expect(rejected[0].why).toContain("unverified");
  });

  it("carries the source authority into a usable determination", () => {
    const r = determine([verifiedRule()], {
      jurisdiction: "CA-AB",
      ruleType: "registration_threshold",
      asOf: d("2026-06-01"),
    });
    expect(r.outcome).toBe("determined");
    expect(r.sourceAuthority).toBe("Test Authority");
    expect(r.ruleKey).toBe("test.rule");
  });
});

describe("registration threshold", () => {
  const rules = [verifiedRule({ parameters: { amount: 30000 } })];
  const asOf = d("2026-06-01");

  it("says unknown, not 'not required', when no rule is loaded", () => {
    const a = assessRegistrationThreshold({
      rollingRevenue: 250000,
      jurisdiction: "CA-AB",
      asOf,
      rules: [],
    });
    expect(a.status).toBe("unknown");
    expect(a.thresholdAmount).toBeUndefined();
    expect(a.suggestedAction).toContain("Load the current");
  });

  it("assesses against the loaded threshold once verified", () => {
    expect(assessRegistrationThreshold({ rollingRevenue: 10000, jurisdiction: "CA-AB", asOf, rules }).status).toBe("below");
    expect(assessRegistrationThreshold({ rollingRevenue: 26000, jurisdiction: "CA-AB", asOf, rules }).status).toBe("approaching");
    expect(assessRegistrationThreshold({ rollingRevenue: 42000, jurisdiction: "CA-AB", asOf, rules }).status).toBe("exceeded");
  });

  it("never tells the user they must register", () => {
    const a = assessRegistrationThreshold({ rollingRevenue: 42000, jurisdiction: "CA-AB", asOf, rules });
    expect(a.suggestedAction).toContain("review");
    expect(a.suggestedAction.toLowerCase()).not.toContain("you must");
  });

  it("stays unknown when the rule carries no usable amount", () => {
    const a = assessRegistrationThreshold({
      rollingRevenue: 1,
      jurisdiction: "CA-AB",
      asOf,
      rules: [verifiedRule({ parameters: {} })],
    });
    expect(a.status).toBe("unknown");
  });
});

describe("filing obligations are traced, not assumed", () => {
  it("reports incomplete when no obligation rules are loaded", () => {
    // Even the obvious ones. Hard-coding one obvious rule is how a rate with no
    // date and no source eventually lands in a source file.
    const p = buildFilingProfile({
      taxpayerType: "corporation",
      jurisdiction: "CA",
      taxYear: 2026,
      asOf: d("2026-06-01"),
      rules: [],
    });
    expect(p.obligations).toEqual([]);
    expect(p.incomplete).toBe(true);
    expect(p.unknowns[0]).toContain("No filing-obligation rules loaded");
  });

  it("lists an obligation only from a verified rule, with its authority", () => {
    const rules: TaxRule[] = [
      verifiedRule({
        ruleKey: "ca.corp.return",
        ruleType: "filing_obligation",
        jurisdiction: "CA",
        entityType: "corporation",
        parameters: { obligationKey: "corp_income_return", label: "Corporate income tax return" },
      }),
      verifiedRule({
        ruleKey: "ca.corp.schedule",
        ruleType: "filing_obligation",
        jurisdiction: "CA",
        entityType: "corporation",
        status: "unverified",
        parameters: { obligationKey: "reconciliation_schedule", label: "Reconciliation schedule" },
      }),
    ];
    const p = buildFilingProfile({
      taxpayerType: "corporation",
      jurisdiction: "CA",
      taxYear: 2026,
      asOf: d("2026-06-01"),
      rules,
    });
    expect(p.obligations.map(o => o.obligationKey)).toEqual(["corp_income_return"]);
    expect(p.obligations[0].sourceAuthority).toBe("Test Authority");
    // The unverified one is named as a gap rather than silently dropped.
    expect(p.incomplete).toBe(true);
    expect(p.unknowns.join(" ")).toContain("ca.corp.schedule");
  });

  it("does not give a sole proprietor a corporation's obligations", () => {
    const rules = [
      verifiedRule({
        ruleKey: "ca.corp.return",
        ruleType: "filing_obligation",
        jurisdiction: "CA",
        entityType: "corporation",
        parameters: { obligationKey: "corp_income_return", label: "Corporate return" },
      }),
    ];
    const p = buildFilingProfile({
      taxpayerType: "sole_proprietor",
      jurisdiction: "CA",
      taxYear: 2026,
      asOf: d("2026-06-01"),
      rules,
    });
    expect(p.obligations).toEqual([]);
    expect(p.incomplete).toBe(true);
  });
});

/* ================================================================== */

describe("an expense is not a deduction", () => {
  const base = {
    total: 184.72,
    transactionDate: d("2026-09-07"),
    vendorName: "Gregg Distributors",
    hasReceiptEvidence: true,
    categoryKey: "tools_shop_supplies",
    categorySource: "human" as const,
  };

  it("always assesses to review, never to deductible", () => {
    const a = assessExpense(base);
    expect(a.treatment).toBe("unknown_review_required");
    expect(a.disclaimer).toContain("not by this record");
  });

  it("flags a missing receipt and an unconfirmed category", () => {
    const a = assessExpense({ ...base, hasReceiptEvidence: false, categorySource: "ai_proposed" });
    expect(a.reviewReasons.join(" ")).toContain("No receipt");
    expect(a.reviewReasons.join(" ")).toContain("suggestion");
  });

  it("treats merchant memory as a hint, not a decision", () => {
    const a = assessExpense({ ...base, categorySource: "merchant_memory" });
    expect(a.reviewReasons.join(" ")).toContain("has not been confirmed");
  });

  it("suggests capital review above the category threshold without deciding", () => {
    const a = assessExpense({ ...base, total: 138000, capitalReviewThreshold: 5000 });
    expect(a.capitalReviewSuggested).toBe(true);
    expect(a.treatment).toBe("unknown_review_required");
    expect(a.reviewReasons.join(" ")).toContain("may be a capital asset");
  });

  it("leaves sales tax recoverability unknown by default", () => {
    expect(assessExpense(base).salesTaxRecoverability).toBe("unknown");
    expect(
      assessSalesTaxRecoverability({ jurisdiction: "CA-AB", asOf: d("2026-09-07"), rules: [] }).recoverable
    ).toBe("unknown");
  });
});

describe("mixed use keeps both halves", () => {
  it("splits the amount and stores the personal portion", () => {
    const a = assessExpense({
      total: 135,
      transactionDate: d("2026-09-07"),
      hasReceiptEvidence: true,
      categoryKey: "cellular",
      businessUsePercent: 70,
    });
    expect(a.businessAmount).toBe(94.5);
    expect(a.personalAmount).toBe(40.5);
    expect(a.split).toBe(true);
  });

  it("emits a personal allocation row rather than dropping it", () => {
    const allocs = buildAllocations({ total: 135, businessUsePercent: 70, basis: "cell phone log" });
    expect(allocs.map(a => a.allocationType)).toEqual(["business", "personal"]);
    expect(allocs[1].amount).toBe(40.5);
  });

  it("emits no personal row at 100% business", () => {
    const allocs = buildAllocations({ total: 100, businessUsePercent: 100, basis: "x" });
    expect(allocs).toHaveLength(1);
  });

  it("balances allocations to the cent", () => {
    const allocs = buildAllocations({ total: 99.99, businessUsePercent: 33.33, basis: "x" });
    const b = allocationsBalance(99.99, allocs);
    expect(b.balanced).toBe(true);
  });

  it("clamps a nonsense business-use percentage instead of trusting it", () => {
    const allocs = buildAllocations({ total: 100, businessUsePercent: 250, basis: "x" });
    expect(allocs[0].percent).toBe(100);
    expect(allocs).toHaveLength(1);
  });
});

describe("who may set a tax treatment", () => {
  it("refuses AI outright", () => {
    const r = applyHumanTreatment({
      treatment: "potentially_deductible",
      determinedByUserId: 5,
      actorIsAi: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("may not set a tax treatment");
  });

  it("requires a named person", () => {
    const r = applyHumanTreatment({ treatment: "personal", determinedByUserId: null });
    expect(r.ok).toBe(false);
  });

  it("refuses to have review set as a conclusion", () => {
    const r = applyHumanTreatment({
      treatment: "unknown_review_required" as never,
      determinedByUserId: 5,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a human decision", () => {
    const r = applyHumanTreatment({ treatment: "capital_asset", determinedByUserId: 5 });
    expect(r.ok).toBe(true);
  });
});

describe("duplicate receipts", () => {
  const existing = [
    { expenseRef: "EXP-1", vendorName: "Gregg Distributors", total: 184.72, transactionDate: d("2026-09-07") },
    { expenseRef: "EXP-2", vendorName: "Petro-Canada", total: 842.16, transactionDate: d("2026-09-07") },
  ];

  it("finds the card transaction matching a photographed receipt", () => {
    const c = findDuplicateCandidates({
      candidate: { vendorName: "Gregg Distributors", total: 184.72, transactionDate: d("2026-09-08") },
      existing,
    });
    expect(c[0].expenseRef).toBe("EXP-1");
    expect(c[0].reasons).toContain("identical amount");
  });

  it("does not flag a different amount from the same vendor", () => {
    const c = findDuplicateCandidates({
      candidate: { vendorName: "Gregg Distributors", total: 12.99, transactionDate: d("2026-09-07") },
      existing,
    });
    expect(c).toEqual([]);
  });

  it("returns candidates rather than merging them", () => {
    // Merging the wrong pair silently loses a real cost.
    const c = findDuplicateCandidates({
      candidate: { vendorName: "Gregg", total: 184.72, transactionDate: d("2026-09-07") },
      existing,
    });
    expect(Array.isArray(c)).toBe(true);
    expect(c[0]).toHaveProperty("score");
  });
});

/* ================================================================== */

const RATES: PayRate[] = [
  { rateKey: "driver.hourly", version: 1, earningType: "regular", calculation: "hourly", rate: 34, unit: "hour", effectiveFrom: d("2026-01-01"), effectiveUntil: d("2026-06-30") },
  { rateKey: "driver.hourly", version: 2, earningType: "regular", calculation: "hourly", rate: 36, unit: "hour", effectiveFrom: d("2026-07-01") },
  { rateKey: "driver.load", version: 1, earningType: "load_premium", calculation: "quantity_times_rate", rate: 35, unit: "load", effectiveFrom: d("2026-01-01") },
  { rateKey: "driver.tonne", version: 1, earningType: "tonnage", calculation: "quantity_times_rate", rate: 1.75, unit: "tonne", effectiveFrom: d("2026-01-01"), minimumMeasurementAuthority: "instrument_measured" },
];

describe("pay rates are versioned, not overwritten", () => {
  it("uses the rate in force on the day worked", () => {
    expect(rateInForce(RATES, "regular", d("2026-03-15"))?.rate).toBe(34);
    expect(rateInForce(RATES, "regular", d("2026-09-15"))?.rate).toBe(36);
  });

  it("still returns the March rate when March is re-run in September", () => {
    const calc = calculateEarning({
      proposal: {
        earningType: "regular", source: "approved_timesheet", quantity: 10,
        unit: "hour", workedOn: d("2026-03-15"), evidenceRefs: ["TS-1"],
      },
      rates: RATES,
    });
    expect(calc.status).toBe("calculated");
    expect(calc.rateApplied).toBe(34);
    expect(calc.rateKeyVersion).toBe("driver.hourly-v1");
  });

  it("blocks when no rate was in force", () => {
    const calc = calculateEarning({
      proposal: {
        earningType: "regular", source: "approved_timesheet", quantity: 10,
        unit: "hour", workedOn: d("2020-01-01"), evidenceRefs: ["TS-1"],
      },
      rates: RATES,
    });
    expect(calc.status).toBe("blocked");
    expect(calc.blockedReason).toContain("No pay rate in force");
  });
});

describe("every dollar points at what produced it", () => {
  it("calculates four loads and keeps the four load references", () => {
    const calc = calculateEarning({
      proposal: {
        earningType: "load_premium", source: "load", quantity: 4, unit: "load",
        workedOn: d("2026-09-07"),
        evidenceRefs: ["LOAD-9911", "LOAD-9912", "LOAD-9913", "LOAD-9914"],
      },
      rates: RATES,
    });
    expect(calc.calculatedAmount).toBe(140);
    expect(calc.evidenceRefs).toHaveLength(4);
  });

  it("blocks an earning with no supporting record", () => {
    const calc = calculateEarning({
      proposal: {
        earningType: "load_premium", source: "load", quantity: 4,
        unit: "load", workedOn: d("2026-09-07"), evidenceRefs: [],
      },
      rates: RATES,
    });
    expect(calc.status).toBe("blocked");
    expect(calc.blockedReason).toContain("must reference what produced it");
  });

  it("permits a manual HR adjustment without operational evidence", () => {
    const calc = calculateEarning({
      proposal: {
        earningType: "regular", source: "manual_hr_adjustment", quantity: 1,
        unit: "hour", workedOn: d("2026-09-07"), evidenceRefs: [],
      },
      rates: RATES,
    });
    expect(calc.status).toBe("calculated");
  });

  it("refuses a unit mismatch rather than silently converting", () => {
    const calc = calculateEarning({
      proposal: {
        earningType: "load_premium", source: "load", quantity: 4,
        unit: "tonne", workedOn: d("2026-09-07"), evidenceRefs: ["LOAD-1"],
      },
      rates: RATES,
    });
    expect(calc.status).toBe("blocked");
    expect(calc.blockedReason).toContain("per load");
  });
});

describe("a weak measurement does not become a wage", () => {
  const tonnage = (method: string | null) =>
    calculateEarning({
      proposal: {
        earningType: "tonnage", source: "load", quantity: 25.59, unit: "tonne",
        workedOn: d("2026-09-07"), evidenceRefs: ["LOAD-9917"],
        measurementMethod: method,
      },
      rates: RATES,
    });

  it("pays a scale-measured tonnage", () => {
    const c = tonnage("scale");
    expect(c.status).toBe("calculated");
    expect(c.calculatedAmount).toBe(44.78);
  });

  it("blocks an estimate where the rule requires an instrument", () => {
    const c = tonnage("estimate");
    expect(c.status).toBe("blocked");
    expect(c.blockedReason).toContain("requires a instrument_measured");
  });

  it("blocks an unrecognized measurement vocabulary", () => {
    // Same fail-closed ladder the disposal billing gate uses.
    const c = tonnage("loadsense_uncalibrated");
    expect(c.status).toBe("blocked");
    expect(c.blockedReason).toContain("unrecognized source");
  });

  it("blocks a missing measurement entirely", () => {
    expect(tonnage(null).status).toBe("blocked");
  });
});

describe("three clocks, none of them silently authoritative", () => {
  it("reports a match when all clocks agree", () => {
    const r = reconcileClocks({
      readings: { employeeSubmittedMinutes: 675, hosOnDutyMinutes: 675, leaseosActivityMinutes: 675 },
    });
    expect(r.outcome).toBe("match");
    expect(r.isException).toBe(false);
  });

  it("raises a payroll exception on a real discrepancy", () => {
    // 11.25 h submitted, 10.92 h HOS, 11.17 h activity.
    const r = reconcileClocks({
      readings: { employeeSubmittedMinutes: 675, hosOnDutyMinutes: 655, leaseosActivityMinutes: 670 },
    });
    expect(r.outcome).toBe("review");
    expect(r.varianceMinutes).toBe(20);
    expect(r.isException).toBe(true);
    expect(r.note).toContain("employee time stands until reviewed");
  });

  it("keeps every reading rather than choosing one", () => {
    const readings = { employeeSubmittedMinutes: 675, hosOnDutyMinutes: 655, leaseosActivityMinutes: 670 };
    expect(reconcileClocks({ readings }).readings).toEqual(readings);
  });

  it("treats a single reporting clock as needing corroboration", () => {
    const r = reconcileClocks({ readings: { employeeSubmittedMinutes: 675 } });
    expect(r.outcome).toBe("review");
    expect(r.isException).toBe(true);
  });

  it("is unresolved when nothing reported", () => {
    expect(reconcileClocks({ readings: {} }).outcome).toBe("unresolved");
  });

  it("never lets a payroll activity change write HOS duty status", () => {
    expect(payrollActivityAffectsHos()).toBe(false);
  });
});

describe("paid payroll is never edited in place", () => {
  it("walks the lifecycle forward", () => {
    expect(canTransitionPayRun("draft", "collecting")).toBe(true);
    expect(canTransitionPayRun("review", "approved")).toBe(true);
    expect(canTransitionPayRun("processing", "paid")).toBe(true);
  });

  it("refuses to reopen a paid run for editing", () => {
    expect(canTransitionPayRun("paid", "review")).toBe(false);
    expect(canTransitionPayRun("paid", "collecting")).toBe(false);
    expect(payRunIsEditable("paid")).toBe(false);
    expect(correctionRouteFor("paid")).toBe("adjustment_required");
  });

  it("allows an amendment, which is a new record", () => {
    expect(canTransitionPayRun("paid", "amended")).toBe(true);
    expect(canTransitionPayRun("closed", "amended")).toBe(true);
  });

  it("allows in-place edits only before approval", () => {
    for (const s of ["draft", "collecting", "review"] as const) {
      expect(correctionRouteFor(s), s).toBe("edit_in_place");
    }
    for (const s of ["approved", "processing", "paid", "closed"] as const) {
      expect(correctionRouteFor(s), s).toBe("adjustment_required");
    }
  });
});

describe("an employee is not a contractor", () => {
  it("refuses a contractor in employee payroll", () => {
    const r = assertPayrollEligibility({ kind: "contractor" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("contractor settlement");
  });

  it("refuses an employee in contractor settlement", () => {
    const r = assertSettlementEligibility({ kind: "employee" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("pay through payroll");
  });

  it("permits each through its own path", () => {
    expect(assertPayrollEligibility({ kind: "employee" }).allowed).toBe(true);
    expect(assertSettlementEligibility({ kind: "contractor" }).allowed).toBe(true);
  });
});

describe("percentage pay applies to eligible revenue", () => {
  it("excludes pass-through and tax before percentaging", () => {
    const e = eligibleRevenueFor({
      grossInvoiceAmount: 4800,
      excluded: [
        { label: "Sales tax", amount: 240 },
        { label: "Third-party disposal pass-through", amount: 800 },
      ],
    });
    expect(e.eligibleAmount).toBe(3760);
    expect(e.excludedTotal).toBe(1040);
    expect(e.note).toContain("not the invoice total");
  });

  it("keeps the exclusion breakdown for the payslip explanation", () => {
    const e = eligibleRevenueFor({
      grossInvoiceAmount: 1000,
      excluded: [{ label: "Sales tax", amount: 50 }],
    });
    expect(e.breakdown).toHaveLength(1);
    expect(e.breakdown[0].label).toBe("Sales tax");
  });
});
