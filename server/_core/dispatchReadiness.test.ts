import { describe, expect, it } from "vitest";
import {
  evaluateDispatchReadiness,
  requestOverride,
  requiresReEvaluation,
  type ReadinessInput,
} from "./dispatchReadiness";

const NOW = new Date(Date.UTC(2026, 7, 30, 12, 0));
const ok = (label: string) => ({
  label,
  present: true,
  expiresAt: new Date(Date.UTC(2027, 0, 1)),
});
const expired = (label: string) => ({
  label,
  present: true,
  expiresAt: new Date(Date.UTC(2026, 6, 1)),
});

const READY: ReadinessInput = {
  evaluatedAt: NOW,
  operator: {
    operatorId: 47,
    name: "D. Reid",
    licence: ok("Class 3 licence"),
    requiredCredentials: [ok("TDG certification"), ok("H2S Alive")],
    hoursAvailableMinutes: 600,
    projectedJobMinutes: 480,
    availabilityDeclared: true,
  },
  truck: {
    unitNumber: "VAC-27",
    inspection: ok("Annual inspection"),
    registration: ok("Registration"),
    insurance: ok("Insurance"),
    maintenanceOverdue: false,
    criticalDefectOpen: false,
    mechanicReleaseRequired: false,
    mechanicReleaseGiven: false,
  },
  trailer: null,
  job: {
    classificationComplete: true,
    dangerousGoods: false,
    tdgDocumentPrepared: null,
    requiredDocumentsPresent: true,
    permitRequired: false,
    permitOnFile: null,
    destinationAcceptanceVerified: true,
    emergencyPlanOnFile: true,
  },
  route: { dispatchStatus: "clear", dataTrustworthy: true },
};

const codes = (i: ReadinessInput) =>
  evaluateDispatchReadiness(i).blockers.map(b => b.code);

describe("evaluateDispatchReadiness", () => {
  it("clears a fully ready assignment", () => {
    const r = evaluateDispatchReadiness(READY);
    expect(r.verdict).toBe("eligible");
    expect(r.blockers).toEqual([]);
    expect(r.explanation).toBe("All dispatch readiness checks passed.");
  });

  it("blocks on an expired operator credential and names it with the date", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      operator: {
        ...READY.operator,
        requiredCredentials: [expired("TDG certification"), ok("H2S Alive")],
      },
    });
    expect(r.verdict).toBe("blocked");
    expect(r.explanation).toContain("TDG certification expired 2026-07-01");
  });

  it("blocks on an expired trailer inspection", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      trailer: {
        trailerNumber: "TRL-14",
        inspection: expired("Annual inspection"),
        registration: ok("Registration"),
        insurance: ok("Insurance"),
        maintenanceOverdue: false,
        compatibleWithTruck: true,
      },
    });
    expect(r.verdict).toBe("blocked");
    expect(
      codes({
        ...READY,
        trailer: {
          trailerNumber: "TRL-14",
          inspection: expired("Annual inspection"),
          registration: ok("Registration"),
          insurance: ok("Insurance"),
          maintenanceOverdue: false,
          compatibleWithTruck: true,
        },
      })
    ).toContain("trailer_inspection_expired");
  });

  it("blocks a unit with an open critical defect", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      truck: { ...READY.truck, criticalDefectOpen: true },
    });
    expect(r.verdict).toBe("blocked");
    expect(r.blockers[0].overridable).toBe(false);
  });

  it("blocks a unit awaiting mechanic release", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      truck: {
        ...READY.truck,
        mechanicReleaseRequired: true,
        mechanicReleaseGiven: false,
      },
    });
    expect(r.verdict).toBe("blocked");
    expect(
      codes({
        ...READY,
        truck: {
          ...READY.truck,
          mechanicReleaseRequired: true,
          mechanicReleaseGiven: false,
        },
      })
    ).toContain("mechanic_release_missing");
  });

  it("blocks when projected work exceeds available hours", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      operator: {
        ...READY.operator,
        hoursAvailableMinutes: 300,
        projectedJobMinutes: 480,
      },
    });
    expect(r.verdict).toBe("blocked");
    expect(r.explanation).toContain("480 min exceeds 300 min available");
  });

  it("returns unknown — never eligible — when HOS state is not held", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      operator: { ...READY.operator, hoursAvailableMinutes: null },
    });
    expect(r.verdict).toBe("unknown");
  });

  it("returns unknown when a credential is present but its expiry is not recorded", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      operator: {
        ...READY.operator,
        requiredCredentials: [
          { label: "TDG certification", present: true, expiresAt: null },
        ],
      },
    });
    expect(r.verdict).toBe("unknown");
    expect(codes(READY)).not.toContain("operator_tdg_certification_unknown");
  });

  it("ranks unknown above review — an unevaluated condition is not a known-minor one", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      operator: {
        ...READY.operator,
        hoursAvailableMinutes: null,
        availabilityDeclared: false,
      },
    });
    expect(r.verdict).toBe("unknown");
  });

  it("blocks a dangerous goods job with no shipping document", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      job: {
        ...READY.job,
        dangerousGoods: true,
        tdgDocumentPrepared: false,
        emergencyPlanOnFile: true,
      },
    });
    expect(r.verdict).toBe("blocked");
  });

  it("blocks a dangerous goods job with no emergency response plan", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      job: {
        ...READY.job,
        dangerousGoods: true,
        tdgDocumentPrepared: true,
        emergencyPlanOnFile: false,
      },
    });
    expect(
      codes({
        ...READY,
        job: {
          ...READY.job,
          dangerousGoods: true,
          tdgDocumentPrepared: true,
          emergencyPlanOnFile: false,
        },
      })
    ).toContain("erp_missing");
    expect(r.verdict).toBe("blocked");
  });

  it("blocks when the destination will not accept the material", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      job: { ...READY.job, destinationAcceptanceVerified: false },
    });
    expect(r.verdict).toBe("blocked");
  });

  it("routes unverified destination acceptance to review, not to blocked", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      job: { ...READY.job, destinationAcceptanceVerified: null },
    });
    expect(r.verdict).toBe("eligible_review");
  });

  it("carries a blocked route decision through from B12", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      route: { dispatchStatus: "blocked", dataTrustworthy: true },
    });
    expect(r.verdict).toBe("blocked");
  });

  it("treats an unevaluated route as unknown", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      route: { dispatchStatus: null, dataTrustworthy: null },
    });
    expect(r.verdict).toBe("unknown");
  });

  it("routes unverified jurisdiction data to review", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      route: { dispatchStatus: "clear", dataTrustworthy: false },
    });
    expect(r.verdict).toBe("eligible_review");
    expect(
      codes({
        ...READY,
        route: { dispatchStatus: "clear", dataTrustworthy: false },
      })
    ).toContain("route_data_unverified");
  });

  it("names every blocker rather than reporting a count", () => {
    const r = evaluateDispatchReadiness({
      ...READY,
      operator: { ...READY.operator, licence: expired("Class 3 licence") },
      truck: { ...READY.truck, criticalDefectOpen: true },
    });
    expect(r.blockers.length).toBe(2);
    expect(r.blockers.every(b => b.label.length > 0)).toBe(true);
  });
});

describe("emergency cannot bypass safety", () => {
  it("has no priority parameter — urgency is structurally unable to reach the gate", () => {
    // If an emergency flag could weaken this gate, it would have to be an
    // input. It is not, and this asserts the surface stays that way.
    const withPriority = {
      ...READY,
      priority: "emergency",
    } as ReadinessInput & { priority: string };
    const r = evaluateDispatchReadiness({
      ...withPriority,
      truck: { ...READY.truck, criticalDefectOpen: true },
    });
    expect(r.verdict).toBe("blocked");
  });
});

describe("requestOverride", () => {
  const gate = (i: ReadinessInput) => evaluateDispatchReadiness(i);

  it("refuses any override of a critical defect, at any role", () => {
    const b = gate({
      ...READY,
      truck: { ...READY.truck, criticalDefectOpen: true },
    }).blockers[0];
    const r = requestOverride(b, {
      blockerCode: b.code,
      requestedByUserId: 1,
      requestedByRole: "administrator",
      reason: "Customer is waiting",
    });
    expect(r.granted).toBe(false);
    if (!r.granted)
      expect(r.refusal).toContain("cannot be overridden by any role");
  });

  it("refuses any override of an expired licence", () => {
    const b = gate({
      ...READY,
      operator: { ...READY.operator, licence: expired("Class 3 licence") },
    }).blockers[0];
    const r = requestOverride(b, {
      blockerCode: b.code,
      requestedByUserId: 1,
      requestedByRole: "administrator",
      reason: "Renewal in progress",
    });
    expect(r.granted).toBe(false);
  });

  it("grants a manager override on unverified destination acceptance", () => {
    const b = gate({
      ...READY,
      job: { ...READY.job, destinationAcceptanceVerified: null },
    }).blockers[0];
    const r = requestOverride(b, {
      blockerCode: b.code,
      requestedByUserId: 8,
      requestedByRole: "manager",
      reason: "Confirmed by phone with facility, ref 88214",
    });
    expect(r.granted).toBe(true);
    if (r.granted) expect(r.reason).toContain("88214");
  });

  it("refuses a dispatcher overriding a manager-level blocker", () => {
    const b = gate({
      ...READY,
      job: { ...READY.job, destinationAcceptanceVerified: null },
    }).blockers[0];
    const r = requestOverride(b, {
      blockerCode: b.code,
      requestedByUserId: 3,
      requestedByRole: "dispatcher",
      reason: "Running late",
    });
    expect(r.granted).toBe(false);
    if (!r.granted) expect(r.refusal).toContain("manager or above is required");
  });

  it("refuses an override with no stated reason", () => {
    const b = gate({
      ...READY,
      job: { ...READY.job, destinationAcceptanceVerified: null },
    }).blockers[0];
    const r = requestOverride(b, {
      blockerCode: b.code,
      requestedByUserId: 8,
      requestedByRole: "manager",
      reason: "   ",
    });
    expect(r.granted).toBe(false);
  });
});

describe("requiresReEvaluation", () => {
  it("accepts a freshly evaluated gate", () => {
    const e = evaluateDispatchReadiness(READY);
    const r = requiresReEvaluation(e, new Date(NOW.getTime() + 5 * 60_000));
    expect(r.stale).toBe(false);
    expect(r.ageMinutes).toBe(5);
  });

  it("demands re-evaluation for a bid gated hours earlier", () => {
    const e = evaluateDispatchReadiness(READY);
    const r = requiresReEvaluation(e, new Date(NOW.getTime() + 3 * 3_600_000));
    expect(r.stale).toBe(true);
    expect(r.message).toContain("re-run the gate before awarding");
  });
});

describe("a permit requirement nobody has determined", () => {
  const withPermit = (job: Partial<ReadinessInput["job"]>): ReadinessInput =>
    ({ ...READY, job: { ...READY.job, ...job } });

  it("refuses dispatch rather than passing, when nobody has determined whether a permit is needed", () => {
    /*
     * This is the state readinessComposer used to make unreachable by supplying `false` on every
     * job. `false` is not a cautious default for "nobody has looked" — it is the answer that lets
     * the truck go, and an oversize movement went with it.
     */
    const r = evaluateDispatchReadiness(withPermit({ permitRequired: null }));
    expect(r.blockers.map(b => b.code)).toContain("permit_requirement_unknown");
    expect(r.verdict).toBe("unknown");
    expect(r.verdict).not.toBe("eligible");
  });

  it("can be accepted by a named manager, but never silently, and never like a missing permit", () => {
    const b = evaluateDispatchReadiness(withPermit({ permitRequired: null }))
      .blockers.find(x => x.code === "permit_requirement_unknown")!;
    /*
     * Overridable by a manager, but never silently: the verdict stays `unknown`, so dispatch is
     * refused until a named person either records a determination or accepts the gap on the record.
     * That is the difference between this and `permit_missing`, which no role may wave through.
     */
    expect(b.severity).toBe("unknown");
    expect(b.overridable).toBe(true);
    expect(b.overrideAuthority).toBe("manager");
    expect(evaluateDispatchReadiness(withPermit({ permitRequired: null })).verdict).not.toBe("eligible");
    const missing = evaluateDispatchReadiness(withPermit({ permitRequired: true, permitOnFile: false }))
      .blockers.find(x => x.code === "permit_missing")!;
    expect(missing.overridable).toBe(false);
  });

  it("still asks nothing about permits once somebody records that none is required", () => {
    // A recorded false is a real determination and must not be confused with the unknown above.
    const r = evaluateDispatchReadiness(withPermit({ permitRequired: false }));
    expect(r.blockers.map(b => b.code).filter(c => c.startsWith("permit_"))).toEqual([]);
  });

  it("keeps the required-but-missing and required-but-unresolved cases distinct", () => {
    expect(codes(withPermit({ permitRequired: true, permitOnFile: false }))).toContain("permit_missing");
    expect(codes(withPermit({ permitRequired: true, permitOnFile: null }))).toContain("permit_unknown");
  });
});
