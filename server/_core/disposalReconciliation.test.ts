import { describe, expect, it } from "vitest";
import {
  completenessPercent,
  reconcileDisposal,
  summariseJobDisposals,
  type DisposalRecordInput,
} from "./disposalReconciliation";

const FULL_REQS = {
  facilityIssuesScaleTicket: true,
  manifestRequired: true,
  facilitySignatureRequired: true,
  weightRequired: true,
};

const COMPLETE: DisposalRecordInput = {
  ticketNumber: "DT-2026-004821-01",
  jobId: 1842,
  tripId: 4821,
  loadId: 91,
  createdByUserId: 382,
  operatorId: 47,
  facilityId: 3,
  material: "Produced water",
  quantity: 8.7,
  measurementMethod: "scale",
  arrivedAt: new Date(),
  departedAt: new Date(),
  facilityTicketNumber: "F-99183",
  facilityAcknowledgedAt: new Date(),
  manifestNumber: "MF-2026-004821",
  billingBookEntryId: 55,
  netKg: 8500,
  verificationStatus: "verified",
  requirements: FULL_REQS,
};

describe("reconcileDisposal", () => {
  it("passes a fully evidenced disposal", () => {
    const r = reconcileDisposal(COMPLETE);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.disposalChargeHeld).toBe(false);
    expect(completenessPercent(r)).toBe(100);
  });

  it("holds only the disposal charge when evidence is missing", () => {
    const r = reconcileDisposal({ ...COMPLETE, facilityTicketNumber: null });
    expect(r.disposalChargeHeld).toBe(true);
    expect(r.otherChargesMayProceed).toBe(true);
    expect(r.missing).toContain("Facility ticket");
  });

  it("does not demand a scale ticket from a facility that issues none", () => {
    const r = reconcileDisposal({
      ...COMPLETE,
      facilityTicketNumber: null,
      requirements: { ...FULL_REQS, facilityIssuesScaleTicket: false },
    });
    expect(r.complete).toBe(true);
    expect(r.checks.find(c => c.key === "facility_ticket")?.status).toBe(
      "not_required"
    );
  });

  it("does not demand a manifest for an unmanifested material", () => {
    const r = reconcileDisposal({
      ...COMPLETE,
      manifestNumber: null,
      requirements: { ...FULL_REQS, manifestRequired: false },
    });
    expect(r.complete).toBe(true);
  });

  it("keeps a facility that issues no ticket at 100%, not permanently short", () => {
    const r = reconcileDisposal({
      ...COMPLETE,
      facilityTicketNumber: null,
      netKg: null,
      requirements: {
        facilityIssuesScaleTicket: false,
        manifestRequired: true,
        facilitySignatureRequired: true,
        weightRequired: false,
      },
    });
    expect(completenessPercent(r)).toBe(100);
  });

  it("treats a quantity with no measurement method as missing", () => {
    const r = reconcileDisposal({ ...COMPLETE, measurementMethod: "unknown" });
    expect(r.missing).toContain("Measurement method");
  });

  it("flags an estimated quantity without blocking on it", () => {
    const r = reconcileDisposal({ ...COMPLETE, measurementMethod: "estimate" });
    const c = r.checks.find(x => x.key === "measurement_method");
    expect(c?.status).toBe("pass");
    expect(c?.detail).toContain("Estimated, not weighed");
  });

  it("requires an authenticated creator, not just an operator name", () => {
    const r = reconcileDisposal({ ...COMPLETE, createdByUserId: null });
    expect(r.missing).toContain("Authenticated operator");
  });

  it("never infers verification from completeness", () => {
    const r = reconcileDisposal({
      ...COMPLETE,
      verificationStatus: "needs_review",
    });
    expect(r.complete).toBe(false);
    expect(r.disposalChargeHeld).toBe(true);
    expect(r.missing).toEqual([]); // nothing missing — it just isn't verified yet
  });

  it("surfaces a prior rejection", () => {
    const r = reconcileDisposal({
      ...COMPLETE,
      verificationStatus: "rejected",
    });
    expect(r.checks.find(c => c.key === "verified")?.detail).toContain(
      "rejected"
    );
  });

  it("catches a disposal with no billing relationship", () => {
    const r = reconcileDisposal({ ...COMPLETE, billingBookEntryId: null });
    expect(r.missing).toContain("Billing relationship");
  });
});

describe("summariseJobDisposals", () => {
  it("reproduces the closeout shape office staff expect", () => {
    const complete = Array.from({ length: 7 }, () =>
      reconcileDisposal(COMPLETE)
    );
    const broken = reconcileDisposal({
      ...COMPLETE,
      ticketNumber: "DT-2026-004821-08",
      facilityTicketNumber: null,
    });
    const s = summariseJobDisposals([...complete, broken]);
    expect(s.total).toBe(8);
    expect(s.complete).toBe(7);
    expect(s.requiresReview).toBe(1);
    expect(s.exceptions[0].ticketNumber).toBe("DT-2026-004821-08");
    expect(s.exceptions[0].missing).toEqual(["Facility ticket"]);
    expect(s.exceptions[0].effect).toContain(
      "other accepted charges may proceed"
    );
  });

  it("explains an unverified record rather than showing an empty gap list", () => {
    const s = summariseJobDisposals([
      reconcileDisposal({ ...COMPLETE, verificationStatus: "needs_review" }),
    ]);
    expect(s.exceptions[0].missing).toEqual(["Awaiting human verification"]);
  });
});
