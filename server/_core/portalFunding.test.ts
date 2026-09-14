import { describe, expect, it } from "vitest";
import {
  composeSession,
  KNOWLEDGE_PANELS,
  panelsForPortal,
  PORTALS,
  portalsForRole,
  WORKER_DATA_CATEGORIES,
} from "./portalComposition";
import {
  assessStacking,
  canAdvanceOpportunity,
  estimateCostShare,
  isRealizedMoney,
  matchProgram,
  matchPrograms,
  programMoneyNature,
  purchaseAdvisory,
  TRIGGER_CATEGORIES,
  type CompanyProfile,
  type FundingProgram,
} from "./fundingIntelligence";
import { FUNDING_PROGRAM_SEEDS, WORKER_TAX_TOPICS } from "./fundingProgramSeeds";
import {
  authorize,
  permissionsFor,
  type DomainRole,
} from "./recordsAuthorization";

const ALL_ROLES: DomainRole[] = [
  "driver", "dispatcher", "mechanic", "shop_lead", "safety", "office",
  "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin",
  "tax_preparer", "controller", "external_accountant",
];

/* ================================================================== */

describe("portals are composed from roles, not picked from a dropdown", () => {
  it("gives an operator who is also safety both portals, not a third one", () => {
    const s = composeSession(["driver", "safety"]);
    const keys = s.portals.map(p => p.portal);
    expect(keys).toContain("field_workforce");
    expect(keys).toContain("safety_compliance");
    expect(keys).toContain("worker_self_service");
    // No portal in the registry is a hand-built operator-safety blend.
    expect(PORTALS.some(p => p.portal.includes("operator_safety"))).toBe(false);
  });

  it("is purely additive — a second role never removes a portal", () => {
    const one = composeSession(["driver"]).portals.map(p => p.portal);
    const two = composeSession(["driver", "mechanic"]).portals.map(p => p.portal);
    for (const k of one) expect(two).toContain(k);
  });

  it("reaches at least one portal for every internal role", () => {
    for (const role of ALL_ROLES) {
      expect(portalsForRole(role).length, role).toBeGreaterThan(0);
    }
  });

  it("gives every internal role the self-service portal — everyone is a person", () => {
    const self = PORTALS.find(p => p.portal === "worker_self_service")!;
    for (const role of ALL_ROLES) {
      if (role === "external_accountant") continue; // external, scoped party
      expect(self.composedFrom, role).toContain(role);
    }
  });

  it("leaves the external portals empty until an external identity model exists", () => {
    // An external party must never get broader access merely because they have
    // an account. No domain role composes these; they are declared, not open.
    for (const k of ["customer", "vendor_facility"] as const) {
      const p = PORTALS.find(x => x.portal === k)!;
      expect(p.composedFrom, k).toEqual([]);
    }
  });

  it("lists absent portals so a screen can explain the gap", () => {
    const s = composeSession(["driver"]);
    expect(s.notReached).toContain("finance_billing");
    expect(s.notReached).toContain("management");
  });

  it("only lists permissions that some role actually holds", () => {
    // A portal built around a permission nobody holds is a screen that looks
    // gated and isn't. Checked per role — passing all roles at once applies
    // deny-beats-grant across the combined set and hides permissions that a
    // single role legitimately holds, which is correct behaviour and the wrong
    // question here.
    const heldBySomeone = new Set(ALL_ROLES.flatMap(r => permissionsFor([r])));
    for (const p of PORTALS) {
      for (const perm of p.builtAround) {
        expect(heldBySomeone.has(perm), `${p.portal} → ${perm}`).toBe(true);
      }
    }
  });

  it("builds each portal around permissions its own composing roles hold", () => {
    // Stronger: the safety portal's surfaces must be reachable by safety, not
    // merely by someone.
    for (const p of PORTALS) {
      if (p.composedFrom.length === 0) continue;
      const held = new Set(p.composedFrom.flatMap(r => permissionsFor([r])));
      for (const perm of p.builtAround) {
        expect(held.has(perm), `${p.portal} → ${perm} not held by any composing role`).toBe(true);
      }
    }
  });

  it("does not grant anything — a portal is a window", () => {
    // A driver's field portal lists billing nowhere, and even if it did, the
    // permission engine is what answers.
    const field = PORTALS.find(p => p.portal === "field_workforce")!;
    expect(field.builtAround).not.toContain("billing.read");
    expect(authorize({ userId: 1, roles: ["driver"], permission: "billing.read" }).allowed).toBe(false);
  });
});

describe("knowledge panels land where they are useful", () => {
  it("puts equipment financing in front of the fleet manager, not the driver", () => {
    expect(panelsForPortal("fleet_maintenance").map(k => k.key)).toContain("equipment_financing");
    expect(panelsForPortal("field_workforce").map(k => k.key)).not.toContain("equipment_financing");
  });

  it("puts training funding in front of HR and the worker", () => {
    expect(panelsForPortal("hr_workforce").map(k => k.key)).toContain("training_funding");
    expect(panelsForPortal("worker_self_service").map(k => k.key)).toContain("training_funding");
  });

  it("keeps personal panels personal", () => {
    // Tool receipts and remote-work records are the worker's, and appear only
    // on the worker's own surface.
    for (const key of ["tradesperson_tools", "worker_expense_organizer", "data_transparency"] as const) {
      const panel = KNOWLEDGE_PANELS.find(k => k.key === key)!;
      expect(panel.personal, key).toBe(true);
      const hosts = PORTALS.filter(p => p.knowledgePanels.includes(key)).map(p => p.portal);
      expect(hosts, key).toEqual(["worker_self_service"]);
    }
  });

  it("gives every panel a home", () => {
    for (const k of KNOWLEDGE_PANELS) {
      const hosts = PORTALS.filter(p => p.knowledgePanels.includes(k.key));
      expect(hosts.length, k.key).toBeGreaterThan(0);
    }
  });

  it("does not dump every panel on every portal", () => {
    // Distribution is the point. The pipeline panel is a management/finance
    // view and does not belong on a mechanic's screen.
    expect(panelsForPortal("fleet_maintenance").map(k => k.key)).not.toContain("funding_pipeline");
    expect(panelsForPortal("field_workforce").map(k => k.key)).not.toContain("tax_opportunities");
  });
});

describe("what LeaseOS knows about me", () => {
  it("derives who can reach each category from the permission model", () => {
    // Pay data lists exactly the roles that actually hold a payroll read.
    const pay = WORKER_DATA_CATEGORIES.find(c => c.category.startsWith("Pay"))!;
    for (const role of pay.reachableByRoles) {
      const can = ["payroll.read_employee", "payroll.read_all"].some(
        p => authorize({ userId: 1, roles: [role], permission: p as never }).allowed
      );
      expect(can, role).toBe(true);
    }
    expect(pay.reachableByRoles).not.toContain("dispatcher");
    expect(pay.reachableByRoles).not.toContain("driver");
  });

  it("marks personal tax documents as reachable by nobody employer-side", () => {
    const tax = WORKER_DATA_CATEGORIES.find(c => c.category.startsWith("Personal tax"))!;
    expect(tax.reachableByRoles).toEqual([]);
    expect(tax.whyCollected).toContain("never employer-visible");
  });

  it("does not claim a statutory retention period it has not verified", () => {
    const hos = WORKER_DATA_CATEGORIES.find(c => c.category.includes("hours of service"))!;
    expect(hos.retentionBasis).toBe("statutory_unverified");
  });

  it("logs access to the sensitive categories", () => {
    for (const c of WORKER_DATA_CATEGORIES) {
      if (/Pay|Incident|Personal tax|evidence/.test(c.category)) {
        expect(c.accessIsLogged, c.category).toBe(true);
      }
    }
  });
});

/* ================================================================== */

const CO: CompanyProfile = {
  country: "CA",
  province: "AB",
  applicantType: "corporation",
  industries: ["oil_gas_extraction", "transportation_warehousing"],
  employeeCount: 42,
  annualRevenue: 8_500_000,
  attributes: [],
};
const NOW = new Date("2026-09-09T12:00:00Z");
const byKey = (k: string) => FUNDING_PROGRAM_SEEDS.find(p => p.programKey === k)!;

describe("no program in the seed is verified", () => {
  it("records every program as unverified", () => {
    expect(FUNDING_PROGRAM_SEEDS.length).toBeGreaterThan(5);
    for (const p of FUNDING_PROGRAM_SEEDS) {
      expect(p.verificationStatus, p.programKey).toBe("unverified");
      expect(p.lastVerifiedAt ?? null, p.programKey).toBeNull();
    }
  });

  it("marks every claimed parameter set as unverified against the authority", () => {
    for (const p of FUNDING_PROGRAM_SEEDS) {
      expect(String(p.parameters.note), p.programKey).toContain("unverified against authority");
    }
  });

  it("records every worker tax topic as unverified too", () => {
    for (const t of WORKER_TAX_TOPICS) expect(t.verificationStatus).toBe("unverified");
  });
});

describe("an unverified program is never a strong match and never money", () => {
  it("caps an unverified program at 'possible' even when everything fits", () => {
    const m = matchProgram({ program: byKey("ab.capg"), company: CO, now: NOW });
    expect(m.strength).not.toBe("strong");
    expect(m.verificationCaveat).toContain("unverified");
  });

  it("labels an estimate from unverified details as such — there is no bare number", () => {
    const e = estimateCostShare({ program: byKey("ab.capg"), eligibleCost: 24600, units: 8 });
    expect(e.amount).toBe(12300);
    expect(e.fromVerifiedProgram).toBe(false);
    expect(e.label).toContain("UNVERIFIED");
    expect(e.label).toContain("confirm before relying");
  });

  it("applies the per-trainee and per-applicant caps in the estimate basis", () => {
    // 12 trainees × $5,000 cap = $60,000; 50% of $150,000 = $75,000 → capped.
    const e = estimateCostShare({ program: byKey("ab.capg"), eligibleCost: 150000, units: 12 });
    expect(e.amount).toBe(60000);
    expect(e.basis).toContain("capped at 5000 × 12");
  });

  it("becomes strong only once verified", () => {
    const verified: FundingProgram = {
      ...byKey("ab.capg"),
      verificationStatus: "verified",
      lastVerifiedAt: NOW,
      programStatus: "open",
    };
    const m = matchProgram({ program: verified, company: CO, now: NOW });
    expect(m.strength).toBe("strong");
    expect(m.verificationCaveat).toBeUndefined();
    const e = estimateCostShare({ program: verified, eligibleCost: 1000 });
    expect(e.fromVerifiedProgram).toBe(true);
    expect(e.label).not.toContain("UNVERIFIED");
  });

  it("returns no estimate when a program states no coverage percentage", () => {
    const e = estimateCostShare({ program: byKey("ca.csbfp"), eligibleCost: 475000 });
    expect(e.amount).toBeNull();
    expect(e.label).toContain("No estimate");
  });
});

describe("a loan is not a grant", () => {
  it("classifies money by whether you keep it, owe it, or never receive it", () => {
    expect(programMoneyNature("grant")).toBe("non_repayable");
    expect(programMoneyNature("loan_guarantee")).toBe("repayable");
    expect(programMoneyNature("refundable_tax_credit")).toBe("tax_treatment");
    expect(programMoneyNature("tax_system_grant")).toBe("tax_treatment");
  });

  it("presents the financing program as repayable, not as a grant", () => {
    const m = matchProgram({ program: byKey("ca.csbfp"), company: CO, now: NOW });
    expect(m.moneyNature).toBe("repayable");
    expect(m.programType).toBe("loan_guarantee");
  });

  it("marks the innovation grant as delivered through the tax system", () => {
    // The workflow is different: no application intake, no deadline countdown.
    const p = byKey("ab.innovation_employment_grant");
    expect(p.programType).toBe("tax_system_grant");
    expect(p.deliveryMechanism).toBe("tax_return");
  });
});

describe("exclusions are terminal and route, rather than a hard-coded branch", () => {
  const FARM: CompanyProfile = { ...CO, applicantType: "farming", industries: ["agriculture"] };

  it("excludes a farming business from the general financing program", () => {
    const m = matchProgram({ program: byKey("ca.csbfp"), company: FARM, now: NOW });
    expect(m.strength).toBe("excluded");
    expect(m.reasons[0]).toContain("does not apply to farming");
  });

  it("surfaces the agricultural equivalent for the same trigger", () => {
    const ms = matchPrograms({
      programs: FUNDING_PROGRAM_SEEDS,
      company: FARM,
      trigger: "ag_equipment.purchase_planned",
      now: NOW,
    });
    const keys = ms.filter(m => m.strength !== "excluded").map(m => m.programKey);
    expect(keys).toContain("ca.cala");
    expect(keys).toContain("ab.sustainable_cap");
    expect(ms.find(m => m.programKey === "ca.csbfp")?.strength).toBe("excluded");
  });

  it("excludes a corporation from the farming-only loan program", () => {
    const m = matchProgram({ program: byKey("ca.cala"), company: CO, now: NOW });
    expect(m.strength).toBe("excluded");
  });

  it("excludes on province and on employee ceiling", () => {
    const bc = matchProgram({ program: byKey("ab.capg"), company: { ...CO, province: "BC" }, now: NOW });
    expect(bc.strength).toBe("excluded");
    const capped: FundingProgram = { ...byKey("ab.capg"), parameters: { maxEmployees: 10 } };
    expect(matchProgram({ program: capped, company: CO, now: NOW }).strength).toBe("excluded");
  });

  it("asks for what it cannot see rather than assuming", () => {
    const m = matchProgram({ program: byKey("ab.capg"), company: { ...CO, province: null }, now: NOW });
    expect(m.strength).toBe("more_information_required");
    expect(m.missingInformation).toContain("Company operating province");
  });
});

describe("triggers open a search, not a directory", () => {
  it("routes a training event to training and workforce programs only", () => {
    const ms = matchPrograms({ programs: FUNDING_PROGRAM_SEEDS, company: CO, trigger: "training.created", now: NOW });
    const keys = ms.map(m => m.programKey);
    expect(keys).toContain("ab.capg");
    expect(keys).not.toContain("ca.csbfp");
    expect(keys).not.toContain("ca.sred");
  });

  it("routes a development project to R&D and clean-tech", () => {
    const keys = matchPrograms({ programs: FUNDING_PROGRAM_SEEDS, company: CO, trigger: "development_project.created", now: NOW }).map(m => m.programKey);
    expect(keys).toContain("ca.sred");
    expect(keys).toContain("ab.innovation_employment_grant");
    expect(keys).not.toContain("ab.capg");
  });

  it("covers every trigger with at least one category", () => {
    for (const [t, cats] of Object.entries(TRIGGER_CATEGORIES)) {
      if (t === "manual") continue;
      expect(cats.length, t).toBeGreaterThan(0);
    }
  });
});

describe("temporary programs carry their close date, not 'grant available'", () => {
  it("marks the workforce resilience intake as temporary with an exhaustion flag", () => {
    const p = byKey("ab.workforce_resilience.employer_training");
    expect(p.temporaryProgram).toBe(true);
    expect(p.fundingExhaustionPossible).toBe(true);
    expect(p.intakeClosesAt).not.toBeNull();
  });

  it("reports the intake closed after its date", () => {
    const after = matchProgram({
      program: byKey("ab.workforce_resilience.employer_training"),
      company: CO,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(after.intakeState).toBe("closed");
    expect(after.missingInformation.join(" ")).toContain("intake is closed");
  });

  it("warns that funding may run out before the published close", () => {
    const m = matchProgram({ program: byKey("ab.workforce_resilience.employer_training"), company: CO, now: NOW });
    expect(m.intakeState).toBe("open");
    expect(m.missingInformation.join(" ")).toContain("exhausted");
  });
});

describe("do not purchase yet", () => {
  it("warns when a matched program requires pre-approval", () => {
    const ms = matchPrograms({ programs: FUNDING_PROGRAM_SEEDS, company: CO, trigger: "training.created", now: NOW });
    const adv = purchaseAdvisory(ms);
    expect(adv.warn).toBe(true);
    expect(adv.headline).toContain("DO NOT PURCHASE YET");
    expect(adv.programsRequiringPreApproval).toContain("ab.capg");
  });

  it("does not warn on the strength of an excluded program", () => {
    const ms = matchPrograms({
      programs: FUNDING_PROGRAM_SEEDS,
      company: { ...CO, province: "BC" },
      trigger: "training.created",
      now: NOW,
    });
    // Both Alberta training programs are excluded for a BC company.
    expect(purchaseAdvisory(ms).warn).toBe(false);
  });
});

describe("the status ladder separates estimates from cash", () => {
  it("walks forward one step at a time", () => {
    expect(canAdvanceOpportunity("estimated", "potential")).toBe(true);
    expect(canAdvanceOpportunity("potential", "pre_screened")).toBe(true);
    expect(canAdvanceOpportunity("application_submitted", "approved")).toBe(true);
    expect(canAdvanceOpportunity("approved", "claimed")).toBe(true);
    expect(canAdvanceOpportunity("claimed", "received")).toBe(true);
  });

  it("refuses to jump from an estimate to approved", () => {
    expect(canAdvanceOpportunity("estimated", "approved")).toBe(false);
    expect(canAdvanceOpportunity("potential", "received")).toBe(false);
  });

  it("counts only approved, claimed and received as money that exists", () => {
    for (const s of ["estimated", "potential", "pre_screened", "application_submitted"] as const) {
      expect(isRealizedMoney(s), s).toBe(false);
    }
    for (const s of ["approved", "claimed", "received"] as const) {
      expect(isRealizedMoney(s), s).toBe(true);
    }
  });
});

describe("no double-dipping", () => {
  const capg = byKey("ab.capg");
  const claimed = {
    claimRef: "CLM-1", programKey: "ab.other", expenseRef: "INV-88421",
    eligibleCost: 4280, claimedAmount: 2140, status: "approved" as const,
  };

  it("is clear when nothing else funds the expense", () => {
    const r = assessStacking({ program: capg, expenseRef: "INV-1", eligibleCost: 1000, proposedAmount: 500, existingClaims: [claimed] });
    expect(r.outcome).toBe("clear");
    expect(r.remainingUnfundedAmount).toBe(1000);
  });

  it("flags the same invoice offered twice to the same program", () => {
    const r = assessStacking({
      program: capg, expenseRef: "INV-88421", eligibleCost: 4280, proposedAmount: 2140,
      existingClaims: [{ ...claimed, programKey: "ab.capg" }],
    });
    expect(r.outcome).toBe("possible_duplicate");
    expect(r.reason).toContain("INV-88421");
  });

  it("resolves an unknown stacking rule to review, never to clear", () => {
    // The seed's stacking rules are all unknown. Unknown is not permission.
    const r = assessStacking({ program: capg, expenseRef: "INV-88421", eligibleCost: 4280, proposedAmount: 2140, existingClaims: [claimed] });
    expect(r.outcome).toBe("review");
    expect(r.reason).toContain("stacking rule is unknown");
  });

  it("refuses outright when the program prohibits stacking", () => {
    const r = assessStacking({ program: { ...capg, stackingRule: "prohibited" }, expenseRef: "INV-88421", eligibleCost: 4280, proposedAmount: 2140, existingClaims: [claimed] });
    expect(r.outcome).toBe("prohibited");
  });

  it("allows stacking within the unfunded remainder and reviews beyond it", () => {
    const permitted = { ...capg, stackingRule: "permitted" as const };
    expect(assessStacking({ program: permitted, expenseRef: "INV-88421", eligibleCost: 4280, proposedAmount: 2140, existingClaims: [claimed] }).outcome).toBe("clear");
    expect(assessStacking({ program: permitted, expenseRef: "INV-88421", eligibleCost: 4280, proposedAmount: 3000, existingClaims: [claimed] }).outcome).toBe("review");
  });

  it("ignores rejected and withdrawn claims", () => {
    const r = assessStacking({
      program: capg, expenseRef: "INV-88421", eligibleCost: 4280, proposedAmount: 2140,
      existingClaims: [{ ...claimed, status: "rejected" }, { ...claimed, claimRef: "CLM-2", status: "withdrawn" }],
    });
    expect(r.outcome).toBe("clear");
  });
});

describe("funding authorization", () => {
  it("keeps loading program knowledge with the controller alone", () => {
    const holders = ALL_ROLES.filter(
      r => authorize({ userId: 1, roles: [r], permission: "funding.programs.manage" }).allowed
    );
    expect(holders).toEqual(["controller"]);
  });

  it("lets a driver see nothing on the company funding surface", () => {
    for (const p of ["funding.read", "funding.manage", "funding.claim"] as const) {
      expect(authorize({ userId: 1, roles: ["driver"], permission: p }).allowed, p).toBe(false);
    }
  });

  it("separates reading opportunities from recording a claim", () => {
    expect(authorize({ userId: 1, roles: ["hr"], permission: "funding.manage" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["hr"], permission: "funding.claim" }).allowed).toBe(false);
    expect(authorize({ userId: 1, roles: ["bookkeeper"], permission: "funding.claim" }).allowed).toBe(true);
  });
});
