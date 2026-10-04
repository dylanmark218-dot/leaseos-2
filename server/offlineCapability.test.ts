/**
 * v22.20 — the truck observed it; the truck did not authorize it.
 */
import { describe, expect, it } from "vitest";
import {
  actionable, classRiskDisagreements, ClassRiskMismatch, DeviceAuthorityRefused,
  envelopeFor, freshnessOf, offlineClassOf, runtimeAvailability, validateCapability,
  type DeviceOperation, type LocalRecord,
} from "./_core/offlineCapability";
import type { CapabilityMatrix } from "@shared/hardwareCapability";

const AT = new Date("2026-09-13T14:00:00Z");

// SPINE item 3: a capability declares requiresOnline and its risk; its offline class is derived from them.
const cap = (o: Partial<DeviceOperation> = {}): DeviceOperation => ({
  key: "documents.readCached", riskLevel: "read", requiresOnline: false, requiredHardware: [], draftable: false, ...o,
});
const HARDWARE: CapabilityMatrix = { localStore: true, fileVault: true, keystore: true, camera: true, location: true, network: true };
const offlineOutcome = (c: DeviceOperation, a: { online: boolean; draftable: boolean }) =>
  runtimeAvailability({ ...c, draftable: a.draftable }, { hardware: HARDWARE, online: a.online });

/** The stack as it would actually be declared. */
const capabilities: DeviceOperation[] = [
  cap(),
  cap({ key: "safety.recordObservation", riskLevel: "low_risk_action" }),
  cap({ key: "tickets.prepareDisposalTicket", riskLevel: "prepare" }),
  cap({ key: "maintenance.clearOutOfService", riskLevel: "restricted", requiresOnline: true }),
  cap({ key: "billing.issueInvoice", riskLevel: "approval_required", requiresOnline: true }),
];

describe("the class and the risk cannot disagree", () => {
  it("accepts the declared stack, and classes it from requiresOnline and the risk", () => {
    expect(classRiskDisagreements(capabilities)).toEqual([]);
    expect(capabilities.map(offlineClassOf)).toEqual(["local_safe", "local_capture", "local_prepare", "server_authoritative", "server_authoritative"]);
  });

  it("refuses a server decision declared as runnable without the server", () => {
    // requiresOnline is the only thing standing between an offline device and this.
    const mislabelled = cap({ key: "oos.release", riskLevel: "restricted", requiresOnline: false });
    expect(() => validateCapability(mislabelled)).toThrow(ClassRiskMismatch);
    expect(() => validateCapability(mislabelled)).toThrow(/declare it requiresOnline/);
  });

  it("names the exact disagreement rather than counting them", () => {
    const [msg] = classRiskDisagreements([cap({ key: "x", riskLevel: "approval_required", requiresOnline: false })]);
    expect(msg).toContain("x carries risk approval_required but is declared to run without the server");
  });

  it("lets a capture record something, since refusing would break the device where it matters most", () => {
    expect(() => validateCapability(cap({ riskLevel: "low_risk_action" }))).not.toThrow();
    expect(offlineClassOf(cap({ riskLevel: "low_risk_action" }))).toBe("local_capture");
  });
});

describe("losing signal is not a way around the server", () => {
  const offline = { online: false, draftable: false };

  it("reads cached material locally", () => {
    expect(offlineOutcome(cap(), offline).outcome).toBe("execute_locally");
  });

  it("captures an observation and says who decides what it permits", () => {
    const r = offlineOutcome(cap({ riskLevel: "low_risk_action" }), offline);
    expect(r.outcome).toBe("capture_locally");
    expect(r.note).toContain("What it permits is decided when it reaches the server");
  });

  it("never executes a server-authoritative capability offline", () => {
    for (const c of capabilities.filter(c => offlineClassOf(c) === "server_authoritative")) {
      expect(offlineOutcome(c, offline).outcome).not.toBe("execute_locally");
      expect(offlineOutcome(c, { online: false, draftable: true }).outcome).not.toBe("execute_locally");
    }
  });

  it("says unavailable plainly rather than appearing to work and failing hours later", () => {
    const r = offlineOutcome(cap({ key: "maintenance.clearOutOfService", riskLevel: "restricted", requiresOnline: true }), offline);
    expect(r.outcome).toBe("unavailable");
    expect(r.note).toContain("Losing signal is not a way around it");
  });

  it("queues a draftable server capability instead", () => {
    const r = offlineOutcome(cap({ key: "billing.issueInvoice", riskLevel: "approval_required", requiresOnline: true }), { online: false, draftable: true });
    expect(r.outcome).toBe("prepare_and_queue");
  });

  it("with signal, sends server work to the server — signal is not a licence to execute it here (SPINE item 3)", () => {
    // Before item 3 this returned execute_locally for every capability once online.
    const r = offlineOutcome(cap({ key: "billing.issueInvoice", riskLevel: "approval_required", requiresOnline: true }), { online: true, draftable: false });
    expect(r).toMatchObject({ outcome: "prepare_and_queue", reason: "server_decides" });
    expect(r.note).toContain("sent to the server now; nothing is done here");
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
