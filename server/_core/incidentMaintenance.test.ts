import { describe, expect, it } from "vitest";
import {
  applyAiSummary,
  buildInspectionView,
  canAdvanceEscalation,
  dangerousGoodsStatus,
  deriveSeverity,
  evaluateNearMiss,
  hosProductionWindow,
  isInInspectionScope,
  planEscalation,
  ROADSIDE_INSPECTION_SCOPE,
  type IncidentFacts,
} from "./incidentReport";
import {
  canAdvanceTo,
  closureImpliesRelease,
  evaluateMechanicRelease,
  nextMaintenanceStage,
  unitServiceStateAfterRelease,
  type ReleaseAttempt,
} from "./mechanicRelease";

const QUIET: IncidentFacts = {
  incidentType: "incident",
  injuryReported: false,
  emergencyServicesAttended: false,
  policeAttended: false,
  environmentalRelease: false,
  dangerousGoodsInvolved: false,
  workStopped: false,
};

describe("incident severity is derived from facts", () => {
  it("treats a reported injury as critical", () => {
    expect(deriveSeverity({ ...QUIET, injuryReported: true })).toBe("critical");
  });

  it("treats a release or dangerous goods as serious", () => {
    expect(deriveSeverity({ ...QUIET, environmentalRelease: true })).toBe("serious");
    expect(deriveSeverity({ ...QUIET, dangerousGoodsInvolved: true })).toBe("serious");
  });

  it("treats stopped work and damage as moderate", () => {
    expect(deriveSeverity({ ...QUIET, workStopped: true })).toBe("moderate");
    expect(deriveSeverity({ ...QUIET, vehicleDamage: true })).toBe("moderate");
  });

  it("does not inflate a hazard observation", () => {
    expect(deriveSeverity({ ...QUIET, incidentType: "hazard_observation" })).toBe("none");
  });
});

describe("escalation routing", () => {
  it("routes an injury to safety, management, HR and legal", () => {
    const p = planEscalation({ ...QUIET, injuryReported: true });
    expect(p.severity).toBe("critical");
    expect(p.targets).toEqual(expect.arrayContaining(["safety", "management", "hr", "legal"]));
    expect(p.immediate).toBe(true);
    expect(p.legalHoldRecommended).toBe(true);
  });

  it("holds the unit after a collision and recalculates dispatch", () => {
    const p = planEscalation({ ...QUIET, incidentType: "collision" });
    expect(p.holdUnit).toBe(true);
    expect(p.targets).toContain("dispatch");
  });

  it("does not escalate a hazard observation to management", () => {
    const p = planEscalation({ ...QUIET, incidentType: "hazard_observation" });
    expect(p.targets).not.toContain("management");
    expect(p.immediate).toBe(false);
    expect(p.holdUnit).toBe(false);
  });

  it("advances escalation one stage at a time", () => {
    expect(canAdvanceEscalation("captured", "sealed")).toBe(true);
    expect(canAdvanceEscalation("captured", "closed")).toBe(false);
    expect(canAdvanceEscalation("sealed", "under_review")).toBe(false);
    expect(canAdvanceEscalation("corrective_action", "closed")).toBe(true);
  });
});

describe("near miss stays a near miss until it isn't", () => {
  it("accepts a short report with no injury", () => {
    const r = evaluateNearMiss({
      originalStatement: "Bucket entered the spotter's exclusion zone.",
      anyoneInjured: false,
      workStopped: true,
    });
    expect(r.accepted).toBe(true);
    expect(r.mustEscalateToIncident).toBe(false);
  });

  it("converts to an incident when an injury is reported", () => {
    const r = evaluateNearMiss({
      originalStatement: "Spotter was clipped by the hose.",
      anyoneInjured: true,
      workStopped: true,
    });
    expect(r.mustEscalateToIncident).toBe(true);
    expect(r.escalationReason).toContain("original statement carried over");
  });

  it("refuses a report with no operator description", () => {
    const r = evaluateNearMiss({ originalStatement: "  ", anyoneInjured: false, workStopped: false });
    expect(r.accepted).toBe(false);
    expect(r.rejectionReason).toContain("own description");
  });
});

describe("AI may structure but never rewrite", () => {
  it("returns the operator's statement byte-identical alongside the summary", () => {
    const original = "pump started grinding when i hit the PTO, shut er down";
    const out = applyAiSummary({
      originalStatement: original,
      proposedSummary: "Operator reported pump noise on PTO engagement; unit shut down.",
      confirmedByUserId: null,
    });
    expect(out.originalStatement).toBe(original);
    expect(out.summarySource).toBe("ai_proposed");
  });

  it("marks the summary confirmed only when a human confirmed it", () => {
    expect(
      applyAiSummary({ originalStatement: "x", proposedSummary: "y", confirmedByUserId: 12 })
        .summarySource
    ).toBe("ai_confirmed");
  });

  it("keeps an unverified UN number a candidate, not a classification", () => {
    const unverified = dangerousGoodsStatus({ unNumber: "UN1993", verified: false });
    expect(unverified.usableForRegulatoryPurposes).toBe(false);
    expect(unverified.display).toContain("candidate");
    expect(dangerousGoodsStatus({ unNumber: "UN1993", verified: true }).usableForRegulatoryPurposes).toBe(true);
    expect(dangerousGoodsStatus({ unNumber: null, verified: false }).usableForRegulatoryPurposes).toBe(false);
  });
});

describe("roadside / scale inspection scope", () => {
  it("shows the inspector the current records and hours of service", () => {
    for (const c of ["unit_registration", "unit_insurance", "permits", "hours_of_service", "current_trip_manifest", "tdg_documents", "defect_status"]) {
      expect(isInInspectionScope(c)).toBe(true);
    }
  });

  it("withholds everything outside the allowlist", () => {
    // Not a denylist — a category added tomorrow is closed by default.
    for (const c of ["customer_billing", "invoice", "incident_investigation", "payroll", "private_message", "other_employee_records"]) {
      expect(isInInspectionScope(c)).toBe(false);
    }
  });

  it("counts what it withheld instead of silently dropping it", () => {
    const view = buildInspectionView([
      { category: "hours_of_service", id: 1 },
      { category: "current_trip_manifest", id: 2 },
      { category: "customer_billing", id: 3 },
      { category: "incident_investigation", id: 4 },
    ]);
    expect(view.visible.map(v => v.id)).toEqual([1, 2]);
    expect(view.withheldCount).toBe(2);
  });

  it("produces the current day plus the previous 14 for HOS", () => {
    const w = hosProductionWindow(new Date("2026-09-06T00:00:00Z"));
    expect(w.days).toBe(15);
    expect(w.from.toISOString().slice(0, 10)).toBe("2026-08-23");
  });

  it("keeps the inspection scope small enough to be reviewable", () => {
    expect(ROADSIDE_INSPECTION_SCOPE.length).toBeLessThanOrEqual(12);
  });
});

/* ------------------------------------------------------------------ */

const GOOD_CRITICAL: ReleaseAttempt = {
  workOrderStatus: "ready_for_service",
  defectSeverity: "critical",
  releaseType: "full",
  repairSummary: "Pump coupling replaced",
  testProcedure: "20 minute PTO operational test",
  testResult: "pass",
  roadTestPerformed: true,
  technicianUserId: 113,
  technicianIdentifier: "TECH-113",
};

describe("mechanic release", () => {
  it("accepts a fully evidenced critical release", () => {
    const d = evaluateMechanicRelease(GOOD_CRITICAL);
    expect(d.valid).toBe(true);
    expect(d.mechanicReleaseGiven).toBe(true);
    expect(d.unitDispatchable).toBe(true);
  });

  it("refuses a release with a typed name and no authenticated technician", () => {
    const d = evaluateMechanicRelease({ ...GOOD_CRITICAL, technicianUserId: null });
    expect(d.valid).toBe(false);
    expect(d.mechanicReleaseGiven).toBe(false);
    expect(d.blockers.map(b => b.code)).toContain("technician_not_authenticated");
  });

  it("refuses a critical release with no road test", () => {
    const d = evaluateMechanicRelease({ ...GOOD_CRITICAL, roadTestPerformed: false });
    expect(d.blockers.map(b => b.code)).toContain("road_test_missing");
  });

  it("refuses a release on a failed test", () => {
    const d = evaluateMechanicRelease({ ...GOOD_CRITICAL, testResult: "fail" });
    expect(d.valid).toBe(false);
    expect(d.blockers.map(b => b.code)).toContain("test_failed");
  });

  it("refuses a release while the work order is still waiting on parts", () => {
    const d = evaluateMechanicRelease({ ...GOOD_CRITICAL, workOrderStatus: "waiting_parts" });
    expect(d.blockers.map(b => b.code)).toContain("waiting_parts");
  });

  it("does not require a road test for an advisory defect", () => {
    const d = evaluateMechanicRelease({
      workOrderStatus: "ready_for_service",
      defectSeverity: "advisory",
      releaseType: "full",
      repairSummary: "Mirror bracket tightened",
      technicianUserId: 113,
      technicianIdentifier: "TECH-113",
    });
    expect(d.valid).toBe(true);
  });

  it("requires a restricted release to state its restriction", () => {
    const d = evaluateMechanicRelease({ ...GOOD_CRITICAL, releaseType: "restricted" });
    expect(d.blockers.map(b => b.code)).toContain("restriction_undefined");
    const ok = evaluateMechanicRelease({
      ...GOOD_CRITICAL,
      releaseType: "restricted",
      restrictionDetail: "No highway operation above 80 km/h until follow-up",
    });
    expect(ok.valid).toBe(true);
    expect(ok.restricted).toBe(true);
  });

  it("treats a revocation as removing the release, not granting one", () => {
    const d = evaluateMechanicRelease({ ...GOOD_CRITICAL, releaseType: "revoked" });
    expect(d.mechanicReleaseGiven).toBe(false);
    expect(d.unitDispatchable).toBe(false);
  });
});

describe("closing a work order is not a mechanic release", () => {
  it("refuses to treat closure as release for anything above advisory", () => {
    expect(closureImpliesRelease("critical")).toBe(false);
    expect(closureImpliesRelease("inspection_required")).toBe(false);
    expect(closureImpliesRelease("advisory")).toBe(true);
  });

  it("holds a unit with an open critical defect and no release", () => {
    const s = unitServiceStateAfterRelease({
      openCriticalDefect: true,
      release: null,
      previousStatus: "available",
    });
    expect(s.status).toBe("held");
    expect(s.dispatchRecalculationRequired).toBe(true);
  });

  it("returns the unit to service and recalculates dispatch on a valid release", () => {
    const s = unitServiceStateAfterRelease({
      openCriticalDefect: true,
      release: evaluateMechanicRelease(GOOD_CRITICAL),
      previousStatus: "held",
    });
    expect(s.status).toBe("available");
    expect(s.dispatchRecalculationRequired).toBe(true);
  });

  it("carries a restriction through to dispatch rather than dropping it", () => {
    const s = unitServiceStateAfterRelease({
      openCriticalDefect: false,
      release: evaluateMechanicRelease({
        ...GOOD_CRITICAL,
        releaseType: "restricted",
        restrictionDetail: "Loaded weight limited pending suspension follow-up",
      }),
      previousStatus: "held",
    });
    expect(s.status).toBe("restricted");
  });
});

describe("defect to archive chain", () => {
  it("advances one stage at a time from driver report to office archive", () => {
    expect(nextMaintenanceStage("driver_reported")).toBe("management_review");
    expect(nextMaintenanceStage("sent_to_shop")).toBe("work_in_progress");
    expect(nextMaintenanceStage("released")).toBe("office_archived");
    expect(nextMaintenanceStage("office_archived")).toBeNull();
  });

  it("refuses to skip management review or the shop", () => {
    expect(canAdvanceTo("driver_reported", "sent_to_shop")).toBe(false);
    expect(canAdvanceTo("driver_reported", "released")).toBe(false);
    expect(canAdvanceTo("management_review", "sent_to_shop")).toBe(true);
  });
});

describe("regression — a held unit always reaches dispatch", () => {
  // Caught during B20: a collision set holdUnit true but dispatch was only
  // notified via a separately-listed damage condition, so a collision with no
  // recorded damage held the unit and told nobody who schedules it.
  it("notifies dispatch and maintenance for every hold reason", () => {
    const holds: IncidentFacts[] = [
      { ...QUIET, incidentType: "collision" },
      { ...QUIET, incidentType: "equipment_event" },
      { ...QUIET, vehicleDamage: true },
      { ...QUIET, equipmentDamage: true },
      { ...QUIET, injuryReported: true },
    ];
    for (const f of holds) {
      const p = planEscalation(f);
      expect(p.holdUnit).toBe(true);
      expect(p.targets).toContain("dispatch");
      expect(p.targets).toContain("maintenance");
    }
  });

  it("does not notify dispatch when nothing is held and work continues", () => {
    const p = planEscalation({ ...QUIET, incidentType: "hazard_observation" });
    expect(p.holdUnit).toBe(false);
    expect(p.targets).not.toContain("dispatch");
  });
});
