/**
 * v22.20 — the truck observed it; the truck did not authorize it.
 */
import { describe, expect, it } from "vitest";
import {
  actionable, classRiskDisagreements, ClassRiskMismatch, DeviceAuthorityRefused,
  envelopeFor, freshnessOf, offlineOutcome, validateCapability,
  type FieldCapability, type LocalRecord,
} from "./_core/offlineCapability";

const AT = new Date("2026-09-13T14:00:00Z");

const cap = (o: Partial<FieldCapability> = {}): FieldCapability => ({
  key: "documents.readCached", description: "read a cached manual", riskLevel: "read",
  requiredPermissions: ["document.read"], requiresOnline: false, idempotent: true,
  offlineClass: "local_safe", ...o,
});

/** The stack as it would actually be declared. */
const capabilities: FieldCapability[] = [
  cap(),
  cap({ key: "safety.recordObservation", riskLevel: "low_risk_action", offlineClass: "local_capture" }),
  cap({ key: "tickets.prepareDisposalTicket", riskLevel: "prepare", offlineClass: "local_prepare" }),
  cap({ key: "maintenance.clearOutOfService", riskLevel: "restricted", offlineClass: "server_authoritative" }),
  cap({ key: "billing.issueInvoice", riskLevel: "approval_required", offlineClass: "server_authoritative" }),
];

describe("the class and the risk cannot disagree", () => {
  it("accepts the declared stack", () => {
    expect(classRiskDisagreements(capabilities)).toEqual([]);
  });

  it("refuses a server decision wearing a local-read label", () => {
    // The label is the only thing standing between an offline device and this.
    const mislabelled = cap({ key: "oos.release", riskLevel: "restricted", offlineClass: "local_safe" });
    expect(() => validateCapability(mislabelled)).toThrow(ClassRiskMismatch);
    expect(() => validateCapability(mislabelled)).toThrow(/may be read —/);
  });

  it("names the exact disagreement rather than counting them", () => {
    const [msg] = classRiskDisagreements([cap({ key: "x", riskLevel: "approval_required", offlineClass: "local_prepare" })]);
    expect(msg).toContain("x is local_prepare but carries risk approval_required");
  });

  it("lets a capture record something, since refusing would break the device where it matters most", () => {
    expect(() => validateCapability(cap({ riskLevel: "low_risk_action", offlineClass: "local_capture" }))).not.toThrow();
  });
});

describe("losing signal is not a way around the server", () => {
  const offline = { online: false, draftable: false };

  it("reads cached material locally", () => {
    expect(offlineOutcome(cap(), offline).outcome).toBe("execute_locally");
  });

  it("captures an observation and says who decides what it permits", () => {
    const r = offlineOutcome(cap({ offlineClass: "local_capture", riskLevel: "low_risk_action" }), offline);
    expect(r.outcome).toBe("capture_locally");
    expect(r.note).toContain("The observation is a fact; what it permits is decided when this reaches the server");
  });

  it("never executes a server-authoritative capability offline", () => {
    for (const c of capabilities.filter(c => c.offlineClass === "server_authoritative")) {
      expect(offlineOutcome(c, offline).outcome).not.toBe("execute_locally");
      expect(offlineOutcome(c, { online: false, draftable: true }).outcome).not.toBe("execute_locally");
    }
  });

  it("says unavailable plainly rather than appearing to work and failing hours later", () => {
    const r = offlineOutcome(cap({ key: "maintenance.clearOutOfService", riskLevel: "restricted", offlineClass: "server_authoritative" }), offline);
    expect(r.outcome).toBe("unavailable");
    expect(r.note).toContain("Losing signal is not a way around it");
  });

  it("queues a draftable server capability instead", () => {
    const r = offlineOutcome(cap({ key: "billing.issueInvoice", riskLevel: "approval_required", offlineClass: "server_authoritative" }), { online: false, draftable: true });
    expect(r.outcome).toBe("prepare_and_queue");
  });

  it("behaves normally once there is signal", () => {
    const r = offlineOutcome(cap({ key: "billing.issueInvoice", riskLevel: "approval_required", offlineClass: "server_authoritative" }), { online: true, draftable: false });
    expect(r.outcome).toBe("execute_locally");
    expect(r.note).toContain("the server decides as usual");
  });
});

describe("what syncs is evidence, never a verdict", () => {
  const record = (o: Partial<LocalRecord> = {}): LocalRecord => ({
    recordRef: "LR-1", capability: "safety.recordObservation", offlineClass: "local_capture",
    observation: { note: "steer tire has wire showing", unit: "U-318" },
    capturedAt: AT, deviceId: "TAB-9", ...o,
  });

  it("packages an observation as evidence", () => {
    const e = envelopeFor(record(), null);
    expect(e.kind).toBe("evidence");
    expect(e.observation).toMatchObject({ unit: "U-318" });
  });

  it("carries the device's assessment as a claim with its basis, not as an answer", () => {
    const e = envelopeFor(record(), { claim: "route appears legal", basis: "cached bridge limits, package of 2026-09-01" });
    expect(e.deviceAssessment).toMatchObject({ claim: "route appears legal" });
    // "The local model thought it was legal" and "it is legal" read the same to
    // a column and entirely differently to a regulator.
    expect(e.note).toContain("The server's engines decide; this is not their answer");
  });

  it("refuses to record a server-authoritative capability as done by a device", () => {
    expect(() => envelopeFor(record({ capability: "oos.release", offlineClass: "server_authoritative" }), null))
      .toThrow(DeviceAuthorityRefused);
    expect(() => envelopeFor(record({ capability: "oos.release", offlineClass: "server_authoritative" }), null))
      .toThrow(/Prepare it and let the server decide/);
  });
});

describe("a cached answer says how old it is", () => {
  it("is current inside the window and stale beyond it", () => {
    expect(freshnessOf(new Date(AT.getTime() - 5 * 60_000), AT, 60)).toBe("current");
    expect(freshnessOf(new Date(AT.getTime() - 120 * 60_000), AT, 60)).toBe("stale");
  });

  it("is unknown when the device cannot say when it learned this", () => {
    // Not "current". A device that cannot date what it knows should not present
    // it as today's truth.
    expect(freshnessOf(null, AT, 60)).toBe("unknown");
  });

  it("treats only a current answer as fit to act on", () => {
    const base = { value: 1, source: "local" as const, capturedAt: AT };
    expect(actionable({ ...base, freshness: "current" })).toBe(true);
    expect(actionable({ ...base, freshness: "stale" })).toBe(false);
    expect(actionable({ ...base, freshness: "unknown" })).toBe(false);
  });
});
