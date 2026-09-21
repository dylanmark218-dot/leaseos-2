import { describe, expect, it } from "vitest";
import {
  amendSealedEvidence,
  canonicalManifest,
  isWellFormedHash,
  sealEvidence,
  sha256,
  verifyReceivedSeal,
  type SealInput,
} from "./evidenceSeal";
import {
  COMPANY_DEFAULT_DEVICE_RETENTION_DAYS,
  COMPANY_DEFAULT_OFFICE_RETENTION_MONTHS,
  computeEffectiveRetention,
  evaluateDeviceDeletion,
  evaluateOfficeDisposition,
  storageReliefPlan,
  type RetentionPolicy,
} from "./retentionPolicy";
import {
  canTransition,
  isOperatorActionable,
  operatorFacingStatus,
  planSendPackage,
  retryDelaySeconds,
  syncPermitsDeviceRelease,
  transition,
} from "./evidenceSync";

const CONTENT = sha256("disposal-ticket-bytes");

const SEALABLE: SealInput = {
  trackingNumber: "DOC-2026-00192881",
  recordType: "disposal_ticket",
  version: 1,
  contentHash: CONTENT,
  capturedAt: new Date("2026-09-06T09:12:00Z"),
  sealedAt: new Date("2026-09-06T09:14:00Z"),
  sealedByUserId: 429,
  sealedByEmployeeNumber: "EMP-00429",
  deviceId: "TAB-VAC27",
  devicePlatform: "android",
  capturedLatitude: 53.12,
  capturedLongitude: -113.44,
  relationships: [
    { entityType: "operator", entityId: 429 },
    { entityType: "unit", entityRef: "VAC-27" },
    { entityType: "job", entityRef: "JOB-8841" },
    { entityType: "load", entityRef: "LOAD-9917" },
  ],
};

describe("evidence sealing", () => {
  it("produces a deterministic manifest regardless of relationship order", () => {
    const shuffled: SealInput = {
      ...SEALABLE,
      relationships: [...SEALABLE.relationships].reverse(),
    };
    expect(canonicalManifest(shuffled)).toBe(canonicalManifest(SEALABLE));
    expect(sealEvidence(shuffled).manifestHash).toBe(
      sealEvidence(SEALABLE).manifestHash
    );
  });

  it("changes the manifest hash when any sealed fact changes", () => {
    const base = sealEvidence(SEALABLE).manifestHash;
    const movedJob = sealEvidence({
      ...SEALABLE,
      relationships: [
        ...SEALABLE.relationships.slice(0, 2),
        { entityType: "job", entityRef: "JOB-9999" },
        SEALABLE.relationships[3],
      ],
    }).manifestHash;
    expect(movedJob).not.toBe(base);
  });

  it("refuses to seal a record that relates to nothing", () => {
    // An object filed into no portfolio is unfindable at audit.
    expect(() => sealEvidence({ ...SEALABLE, relationships: [] })).toThrow(
      /at least one entity/
    );
  });

  it("refuses a malformed content hash rather than sealing around it", () => {
    expect(() => sealEvidence({ ...SEALABLE, contentHash: "abc" })).toThrow(
      /sha256/
    );
    expect(isWellFormedHash(CONTENT)).toBe(true);
    expect(isWellFormedHash("ABC")).toBe(false);
    expect(isWellFormedHash(null)).toBe(false);
  });
});

describe("seal verification on receipt", () => {
  const seal = sealEvidence(SEALABLE);

  it("accepts a package whose hashes the server independently reproduces", () => {
    const r = verifyReceivedSeal({
      declaredContentHash: seal.contentHash,
      declaredManifestHash: seal.manifestHash,
      receivedManifest: seal.canonicalManifest,
      computedContentHash: CONTENT,
    });
    expect(r.result).toBe("verified");
    expect(r.accepted).toBe(true);
    expect(r.deviceCopyMayBeReleased).toBe(true);
  });

  it("rejects and retains the local copy when the file content differs", () => {
    const r = verifyReceivedSeal({
      declaredContentHash: seal.contentHash,
      declaredManifestHash: seal.manifestHash,
      receivedManifest: seal.canonicalManifest,
      computedContentHash: sha256("different-bytes"),
    });
    expect(r.result).toBe("hash_mismatch");
    expect(r.accepted).toBe(false);
    expect(r.deviceCopyMayBeReleased).toBe(false);
    expect(r.detail).toContain("local copy retained");
  });

  it("rejects when metadata or relationships changed in transit", () => {
    const tampered = seal.canonicalManifest.replace("JOB-8841", "JOB-0001");
    const r = verifyReceivedSeal({
      declaredContentHash: seal.contentHash,
      declaredManifestHash: seal.manifestHash,
      receivedManifest: tampered,
      computedContentHash: CONTENT,
    });
    expect(r.result).toBe("manifest_mismatch");
    expect(r.deviceCopyMayBeReleased).toBe(false);
  });
});

describe("amendment", () => {
  it("creates version 2 without altering version 1's hash", () => {
    const v1 = sealEvidence(SEALABLE);
    const amended = amendSealedEvidence({
      previous: SEALABLE,
      newContentHash: sha256("corrected-ticket-bytes"),
      amendedAt: new Date("2026-09-08T10:00:00Z"),
      amendedByUserId: 77,
      amendmentReason: "Quantity corrected against scale ticket DSP-99183",
    });
    expect(amended.version).toBe(2);
    expect(amended.supersedesVersion).toBe(1);
    expect(amended.seal.manifestHash).not.toBe(v1.manifestHash);
    // v1 recomputes to exactly what it was — nothing mutated it.
    expect(sealEvidence(SEALABLE).manifestHash).toBe(v1.manifestHash);
  });

  it("refuses an amendment with no stated reason", () => {
    expect(() =>
      amendSealedEvidence({
        previous: SEALABLE,
        newContentHash: CONTENT,
        amendedAt: new Date(),
        amendedByUserId: 77,
        amendmentReason: "   ",
      })
    ).toThrow(/reason/);
  });
});

/* ------------------------------------------------------------------ */

const POLICY: RetentionPolicy = {
  policyKey: "disposal_ticket.default",
  recordType: "disposal_ticket",
  statutoryMinimumMonths: null,
  statutorySourceStatus: "unverified",
  companyRetentionMonths: COMPANY_DEFAULT_OFFICE_RETENTION_MONTHS,
  deviceRetentionDays: COMPANY_DEFAULT_DEVICE_RETENTION_DAYS,
  deletionRequiresOfficeReceipt: true,
  legalHoldOverridesDeletion: true,
};

const SEALED_AT = new Date("2026-09-06T09:14:00Z");

describe("retention — company policy vs statutory claim", () => {
  it("applies the 10-year company archive and 14-day device period", () => {
    const r = computeEffectiveRetention({
      policy: POLICY,
      sealedAt: SEALED_AT,
      underLegalHold: false,
    });
    expect(r.months).toBe(120);
    expect(r.basis).toBe("company");
    expect(r.officeRetainUntil?.getUTCFullYear()).toBe(2036);
    expect(r.deviceRetainUntil?.toISOString().slice(0, 10)).toBe("2026-09-20");
  });

  it("does not claim statutory backing that has not been verified", () => {
    const r = computeEffectiveRetention({
      policy: POLICY,
      sealedAt: SEALED_AT,
      underLegalHold: false,
    });
    expect(r.statutoryBackingVerified).toBe(false);
    expect(r.caveat).toContain("statutory compliance not asserted");
  });

  it("ignores an unverified statutory minimum even when it is longer", () => {
    const r = computeEffectiveRetention({
      policy: {
        ...POLICY,
        statutoryMinimumMonths: 240,
        statutorySourceStatus: "unverified",
      },
      sealedAt: SEALED_AT,
      underLegalHold: false,
    });
    expect(r.basis).toBe("company");
    expect(r.months).toBe(120);
    expect(r.statutoryBackingVerified).toBe(false);
    expect(r.caveat).toContain("240 months");
  });

  it("takes the longest requirement once the statutory source is verified", () => {
    const r = computeEffectiveRetention({
      policy: {
        ...POLICY,
        statutoryMinimumMonths: 240,
        statutorySourceStatus: "verified",
      },
      sealedAt: SEALED_AT,
      underLegalHold: false,
    });
    expect(r.basis).toBe("statutory");
    expect(r.months).toBe(240);
    expect(r.statutoryBackingVerified).toBe(true);
  });

  it("lets a longer contract requirement win over company policy", () => {
    const r = computeEffectiveRetention({
      policy: { ...POLICY, contractRetentionMonths: 180 },
      sealedAt: SEALED_AT,
      underLegalHold: false,
    });
    expect(r.basis).toBe("contract");
    expect(r.months).toBe(180);
  });

  it("suspends expiry entirely under legal hold", () => {
    const r = computeEffectiveRetention({
      policy: POLICY,
      sealedAt: SEALED_AT,
      underLegalHold: true,
    });
    expect(r.basis).toBe("legal_hold_indefinite");
    expect(r.officeRetainUntil).toBeNull();
    // The device clock still runs — a hold is an office archive concern.
    expect(r.deviceRetainUntil).not.toBeNull();
  });
});

describe("device deletion gate", () => {
  const DEVICE_UNTIL = new Date("2026-09-20T09:14:00Z");
  const base = {
    sealed: true,
    deviceRetainUntil: DEVICE_UNTIL,
    officeReceivedAt: new Date("2026-09-06T12:44:00Z"),
    officeIntegrityVerifiedAt: new Date("2026-09-06T12:44:05Z"),
    underLegalHold: false,
    policy: {
      deletionRequiresOfficeReceipt: true,
      legalHoldOverridesDeletion: true,
    },
  };

  it("allows deletion once retention elapsed and office verified it", () => {
    const d = evaluateDeviceDeletion({ ...base, now: new Date("2026-09-21T00:00:00Z") });
    expect(d.allowed).toBe(true);
    expect(d.blockers).toEqual([]);
  });

  it("blocks during the field retention period and says when it clears", () => {
    const d = evaluateDeviceDeletion({ ...base, now: new Date("2026-09-10T00:00:00Z") });
    expect(d.allowed).toBe(false);
    const b = d.blockers.find(x => x.code === "device_retention_active");
    expect(b?.clearsAt).toEqual(DEVICE_UNTIL);
  });

  it("blocks when the office has not received it, however old it is", () => {
    const d = evaluateDeviceDeletion({
      ...base,
      officeReceivedAt: null,
      officeIntegrityVerifiedAt: null,
      now: new Date("2027-01-01T00:00:00Z"),
    });
    expect(d.allowed).toBe(false);
    expect(d.blockers.map(b => b.code)).toContain("office_not_received");
  });

  it("blocks when received but integrity was never verified", () => {
    // A 200 response is not proof the office holds the same bytes.
    const d = evaluateDeviceDeletion({
      ...base,
      officeIntegrityVerifiedAt: null,
      now: new Date("2027-01-01T00:00:00Z"),
    });
    expect(d.allowed).toBe(false);
    expect(d.blockers.map(b => b.code)).toContain("office_integrity_unverified");
  });

  it("blocks under legal hold regardless of elapsed retention", () => {
    const d = evaluateDeviceDeletion({
      ...base,
      underLegalHold: true,
      now: new Date("2030-01-01T00:00:00Z"),
    });
    expect(d.allowed).toBe(false);
    expect(d.blockers.map(b => b.code)).toContain("legal_hold");
  });

  it("blocks an unsealed draft", () => {
    const d = evaluateDeviceDeletion({
      ...base,
      sealed: false,
      now: new Date("2027-01-01T00:00:00Z"),
    });
    expect(d.blockers.map(b => b.code)).toContain("not_sealed");
  });
});

describe("office disposition", () => {
  it("never expires while a hold stands", () => {
    const r = evaluateOfficeDisposition({
      now: new Date("2040-01-01T00:00:00Z"),
      officeRetainUntil: new Date("2036-09-06T00:00:00Z"),
      underLegalHold: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("legal hold");
  });

  it("is eligible only after the period elapses, and says so as eligibility not instruction", () => {
    const until = new Date("2036-09-06T00:00:00Z");
    expect(
      evaluateOfficeDisposition({ now: new Date("2030-01-01T00:00:00Z"), officeRetainUntil: until, underLegalHold: false }).eligible
    ).toBe(false);
    const after = evaluateOfficeDisposition({
      now: new Date("2036-09-07T00:00:00Z"),
      officeRetainUntil: until,
      underLegalHold: false,
    });
    expect(after.eligible).toBe(true);
    expect(after.reason).toContain("authorized disposition");
  });
});

describe("storage relief ordering", () => {
  it("sacrifices map cache before anything, and mandatory records never", () => {
    const plan = storageReliefPlan();
    expect(plan[0].target).toBe("map_cache");
    expect(plan[0].safeToDrop).toBe(true);
    expect(plan.at(-1)?.target).toBe("none");
    expect(plan.at(-1)?.safeToDrop).toBe(false);
    expect(plan.find(p => p.target === "queued_uploads")?.safeToDrop).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("sync state machine", () => {
  it("walks the full offline path to office acceptance", () => {
    let s = transition("queued", "waiting_for_service");
    expect(s.ok).toBe(true);
    for (const next of ["transmitting", "server_received", "hash_verified", "office_accepted"] as const) {
      const r = transition(s.state, next);
      expect(r.ok).toBe(true);
      s = r;
    }
    expect(s.state).toBe("office_accepted");
  });

  it("refuses to jump straight from received to accepted without verification", () => {
    const r = transition("server_received", "office_accepted");
    expect(r.ok).toBe(false);
    expect(canTransition("server_received", "office_accepted")).toBe(false);
  });

  it("releases the device copy only on office acceptance", () => {
    for (const s of ["queued", "waiting_for_service", "transmitting", "server_received", "hash_verified", "failed", "rejected"] as const) {
      expect(syncPermitsDeviceRelease(s)).toBe(false);
    }
    expect(syncPermitsDeviceRelease("office_accepted")).toBe(true);
  });

  it("does not present waiting for service as an operator problem", () => {
    const s = operatorFacingStatus("waiting_for_service");
    expect(s.actionRequired).toBe(false);
    expect(s.tone).toBe("pending");
    expect(isOperatorActionable("waiting_for_service")).toBe(false);
    expect(isOperatorActionable("failed")).toBe(false);
    expect(isOperatorActionable("rejected")).toBe(true);
  });

  it("retries with bounded backoff and never stops trying", () => {
    expect(retryDelaySeconds(0)).toBe(30);
    expect(retryDelaySeconds(3)).toBe(240);
    expect(retryDelaySeconds(50)).toBe(3600);
    // failed is recoverable, not terminal
    expect(canTransition("failed", "queued")).toBe(true);
  });

  it("never sends a draft the operator has not confirmed", () => {
    const plan = planSendPackage({
      packageRef: "PKG-1",
      records: [
        { trackingNumber: "D-1", sealState: "sealed", contentHash: CONTENT, manifestHash: CONTENT },
        { trackingNumber: "D-2", sealState: "draft" },
        { trackingNumber: "D-3", sealState: "superseded", contentHash: CONTENT, manifestHash: CONTENT },
        { trackingNumber: "D-4", sealState: "sealed", contentHash: null, manifestHash: null },
      ],
    });
    expect(plan.itemCount).toBe(1);
    expect(plan.rejected.map(r => r.trackingNumber).sort()).toEqual(["D-2", "D-3", "D-4"]);
    expect(plan.rejected.find(r => r.trackingNumber === "D-2")?.reason).toContain("not confirmed");
  });
});
