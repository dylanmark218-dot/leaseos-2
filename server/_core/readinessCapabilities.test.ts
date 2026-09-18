/**
 * P8.1 standing suite — the owner decision of 2026-09-18, case by case.
 *
 * The brief named the minimum coverage, and every case below is one of those. They are written
 * against the states a partly-on system genuinely reaches: a company that keeps paper logs, one
 * that never bought routing, a module switched off, an engine that returned nothing at all.
 *
 * The line the suite defends, in the owner's words: keep fail-closed behaviour where the consumer
 * explicitly requires the capability, but do not turn "feature not used" into a system-wide
 * failure. Both halves have to hold at once, and it is easy to satisfy one by breaking the other.
 */
import { describe, expect, it } from "vitest";
import { combineForConsumer, notEvaluated, type CapabilityResult } from "./interEngineStatus";
import {
  BILLING_CAPABILITY, CAPABILITY, billingContractFor, capabilityItems, capabilityOf,
  capabilityResults, dispatchContractFor, pictureFor, type EvaluationMap,
} from "./readinessCapabilities";
import type { DispatchBlocker } from "./dispatchReadiness";

const FULL_TRIP = { routingInUse: true, destinationRequired: true, mechanicReleaseApplicable: false };
const MAPPING_ONLY = { routingInUse: false, destinationRequired: false, mechanicReleaseApplicable: false };

const blocker = (code: string, severity: DispatchBlocker["severity"], subject: DispatchBlocker["subject"] = "truck"): DispatchBlocker =>
  ({ code, label: code, severity, subject, overridable: true, minimumRole: "supervisor" } as DispatchBlocker);

const evaluatedAll = (): EvaluationMap => ({});

describe("dispatch: a required capability in each state", () => {
  it("required + PASS contributes toward release", () => {
    const p = pictureFor(dispatchContractFor(FULL_TRIP), [], evaluatedAll());
    expect(p.verdict.status).toBe("PASS");
    expect(p.extraBlockers).toEqual([]);
  });

  it("required + REVIEW stays review", () => {
    const p = pictureFor(dispatchContractFor(FULL_TRIP), [blocker("cvip_inspection_due_soon", "review")], evaluatedAll());
    expect(p.verdict.status).toBe("REVIEW");
  });

  it("required + BLOCKED blocks", () => {
    const p = pictureFor(dispatchContractFor(FULL_TRIP), [blocker("annual_inspection_expired", "blocking")], evaluatedAll());
    expect(p.verdict.status).toBe("BLOCKED");
    expect(p.verdict.blockers.map(b => b.capability)).toEqual([CAPABILITY.unitInspection]);
  });

  it("required + UNKNOWN never becomes PASS", () => {
    const p = pictureFor(dispatchContractFor(FULL_TRIP), [blocker("hos_hours_unknown", "unknown", "operator")], evaluatedAll());
    expect(p.verdict.status).toBe("UNKNOWN");
    expect(p.verdict.status).not.toBe("PASS");
  });

  it("required + NOT_EVALUATED is not read as consent, and reaches the engine's own verdict", () => {
    const evaluation: EvaluationMap = { [CAPABILITY.hos]: { evaluated: false, reason: "module_disabled", detail: "this company keeps paper logs" } };
    const p = pictureFor(dispatchContractFor(FULL_TRIP), [], evaluation);
    expect(p.verdict.status).toBe("REVIEW");                      // not PASS, though nothing blocked
    expect(p.verdict.missingRequired).toEqual([CAPABILITY.hos]);
    // And it becomes a blocker the existing engine understands, so eligibility cannot read eligible.
    expect(p.extraBlockers).toHaveLength(1);
    expect(p.extraBlockers[0]!.severity).toBe("unknown");         // unknown, not blocking: no answer was given
    expect(p.extraBlockers[0]!.label).toMatch(/required for this dispatch and was not evaluated \(module_disabled\)/);
  });

  it("optional + NOT_EVALUATED changes nothing, and is still recorded", () => {
    // A mapping-only account: no route, no destination. Neither is required for this trip.
    const evaluation: EvaluationMap = {
      [CAPABILITY.routeRestrictions]: { evaluated: false, reason: "not_applicable", detail: "no route named" },
      [CAPABILITY.destinationAcceptance]: { evaluated: false, reason: "not_licensed" },
    };
    const p = pictureFor(dispatchContractFor(MAPPING_ONLY), [], evaluation);
    expect(p.verdict.status).toBe("PASS");
    expect(p.extraBlockers).toEqual([]);                          // "feature not used" is not a failure
    expect(p.verdict.notEvaluated.map(r => r.capability).sort())
      .toEqual([CAPABILITY.destinationAcceptance, CAPABILITY.routeRestrictions].sort());
  });

  it("a disabled dependency degrades rather than failing the whole composition", () => {
    const evaluation: EvaluationMap = { [CAPABILITY.routeRestrictions]: { evaluated: false, reason: "module_disabled" } };
    const p = pictureFor(dispatchContractFor({ ...FULL_TRIP, routingInUse: true }), [], evaluation);
    expect(p.verdict.status).toBe("REVIEW");                      // surfaced
    expect(() => pictureFor(dispatchContractFor(FULL_TRIP), [], evaluation)).not.toThrow();   // not fatal
  });

  it("an unlicensed dependency reports NOT_EVALUATED rather than being squeezed into an older word", () => {
    const evaluation: EvaluationMap = { [CAPABILITY.destinationAcceptance]: { evaluated: false, reason: "not_licensed" } };
    const p = pictureFor(dispatchContractFor(MAPPING_ONLY), [], evaluation);
    const d = p.capabilities.find(c => c.capability === CAPABILITY.destinationAcceptance)!;
    expect(d.status).toBe("NOT_EVALUATED");
    expect(["PASS", "REVIEW", "BLOCKED", "UNKNOWN"]).not.toContain(d.status);
    expect(d.reason).toBe("not_licensed");
  });

  it("a capability that returned no result at all is an absence, not consent", () => {
    // Nothing in the evaluation map, no blocker, and the contract says it is required: silence.
    const contract = { consumer: "dispatch readiness", requires: ["a capability nobody wired"] };
    const v = combineForConsumer(contract, [{ capability: CAPABILITY.hos, status: "PASS" }]);
    expect(v.status).toBe("REVIEW");
    expect(v.explanation).toMatch(/gave no answer at all/);
  });

  it("mixed results: NOT_EVALUATED never enters the worst-of comparison", () => {
    const evaluation: EvaluationMap = { [CAPABILITY.hos]: { evaluated: false, reason: "module_disabled" } };
    const p = pictureFor(dispatchContractFor(FULL_TRIP), [blocker("annual_inspection_expired", "blocking")], evaluation);
    expect(p.verdict.status).toBe("BLOCKED");                     // the blocker decides the status
    expect(p.verdict.missingRequired).toEqual([CAPABILITY.hos]);  // and the absence is not hidden by it
    // Neither fact is lost: had NOT_EVALUATED taken part in worst-of, one of these would be.
    expect(p.verdict.explanation).toMatch(/blocked by/);
    expect(p.verdict.explanation).toMatch(/not evaluated and required here/);
  });
});

describe("billing does not inherit dispatch's requirements", () => {
  const evidencePasses: CapabilityResult[] = [
    { capability: BILLING_CAPABILITY.fieldTicket, status: "PASS" },
    { capability: BILLING_CAPABILITY.acceptedLines, status: "PASS" },
    { capability: BILLING_CAPABILITY.customerAcceptance, status: "PASS" },
    { capability: BILLING_CAPABILITY.signatureIntegrity, status: "PASS" },
    { capability: BILLING_CAPABILITY.chargeEvidence, status: "PASS" },
  ];

  it("invoices when an irrelevant HOS capability was not evaluated", () => {
    const v = combineForConsumer(billingContractFor({ lineNeedsSupportingEvidence: false }), [
      ...evidencePasses,
      notEvaluated(CAPABILITY.hos, "module_disabled", "paper logs; not evidence for this charge"),
    ]);
    expect(v.status).toBe("PASS");                                // the invoice proceeds
    expect(v.missingRequired).toEqual([]);
    expect(v.notEvaluated.map(r => r.capability)).toEqual([CAPABILITY.hos]);   // and still says so
  });

  it("does not manufacture a PASS for a capability it did not require", () => {
    const v = combineForConsumer(billingContractFor({ lineNeedsSupportingEvidence: false }), [
      ...evidencePasses,
      notEvaluated(CAPABILITY.routeRestrictions, "not_licensed"),
    ]);
    const route = v.notEvaluated.find(r => r.capability === CAPABILITY.routeRestrictions)!;
    expect(route.status).toBe("NOT_EVALUATED");                   // not upgraded to PASS by the others
  });

  it("still holds an invoice whose own required evidence was not evaluated", () => {
    const v = combineForConsumer(billingContractFor({ lineNeedsSupportingEvidence: true }), [
      ...evidencePasses,
      notEvaluated(BILLING_CAPABILITY.supportingEvidence, "no_data_source_loaded", "disposal ticket not on file"),
    ]);
    expect(v.status).toBe("REVIEW");                              // fail-closed where billing does require it
    expect(v.missingRequired).toEqual([BILLING_CAPABILITY.supportingEvidence]);
  });
});

describe("the audit package preserves what was not evaluated", () => {
  const contract = dispatchContractFor(FULL_TRIP);
  const capabilities = capabilityResults(contract, [blocker("annual_inspection_expired", "blocking")], {
    [CAPABILITY.hos]: { evaluated: false, reason: "module_disabled", detail: "paper logs" },
  });

  it("writes NOT_EVALUATED out as itself, with its reason and both statuses", () => {
    const items = capabilityItems("dispatch readiness", contract, capabilities, {
      engine: "readinessComposer", profileVersion: "v22.65",
      rawStatusOf: (c) => (c === CAPABILITY.unitInspection ? "blocked" : null),
    });
    const hos = items.find(i => i.row.capability === CAPABILITY.hos)!;
    expect(hos.row.interEngineStatus).toBe("NOT_EVALUATED");
    expect(hos.row.notEvaluated).toBe(true);
    expect(hos.row.notEvaluatedReason).toBe("module_disabled");
    expect(hos.row.requiredByConsumer).toBe(true);
    expect(hos.title).toMatch(/hos — NOT_EVALUATED \(module_disabled\)/);

    const insp = items.find(i => i.row.capability === CAPABILITY.unitInspection)!;
    expect(insp.row.rawEngineStatus).toBe("blocked");             // the engine's own word, kept
    expect(insp.row.interEngineStatus).toBe("BLOCKED");           // beside the shared one
    expect(insp.row.engine).toBe("readinessComposer");
    expect(insp.row.profileVersion).toBe("v22.65");
  });

  it("produces a package's worth of items even though a capability was not evaluated", () => {
    // The package is evidence of what happened, including what was not evaluated.
    const items = capabilityItems("dispatch readiness", contract, capabilities, { engine: "readinessComposer" });
    expect(items.length).toBe(capabilities.length);
    expect(items.every(i => i.itemKind === "capability_evaluation")).toBe(true);
  });
});

describe("blockers are attributed to the capability that raised them", () => {
  it("reads the code first and the subject as the fallback", () => {
    expect(capabilityOf({ code: "hos_daily_limit", subject: "operator" })).toBe(CAPABILITY.hos);
    expect(capabilityOf({ code: "mechanic_release_missing", subject: "truck" })).toBe(CAPABILITY.mechanicRelease);
    expect(capabilityOf({ code: "annual_inspection_expired", subject: "truck" })).toBe(CAPABILITY.unitInspection);
    expect(capabilityOf({ code: "route_approval_stale", subject: "route" })).toBe(CAPABILITY.routeRestrictions);
    // Unrecognised: attributed to the subject rather than dropped. Losing a safety blocker in the
    // attribution step would be the worst failure this file could have.
    expect(capabilityOf({ code: "something_nobody_mapped", subject: "truck" })).toBe(CAPABILITY.unitInspection);
  });
});
