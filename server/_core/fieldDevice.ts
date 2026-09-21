/**
 * Secure field runtime — the server's half.
 *
 * The rule the specification gives: no connectivity should prevent
 * synchronization, not prevent work. The device keeps capturing. What the
 * server does is decide, on reconnection, whether to believe it:
 *
 *   Is this a device the company issued, still in good standing?
 *   Is it signing with a key we know, that is still valid?
 *   Does what it sent match what it sealed at capture — and what we sealed?
 *   Did the server change a record the device also changed?
 *   May the device delete a local copy yet?
 *
 * Every one of these fails closed. A package from a revoked device is not
 * "received with a warning"; it is refused. A hash that does not match is not
 * "accepted pending review"; the item is rejected. A conflict is not merged.
 * And a device under storage pressure never deletes something the office has
 * not accepted — it runs out of room instead, and says so.
 *
 * What is NOT here: the encrypted SQLite, the file vault, the keystore. Those
 * live on the device and cannot be built or tested in this container. This
 * file is the contract they are held to.
 */

import { syncPermitsDeviceRelease, type SyncState } from "./evidenceSync";

/* ------------------------------------------------------------------ */
/* Device admission                                                     */
/* ------------------------------------------------------------------ */

export type DeviceStatus = "enrolled" | "active" | "suspended" | "revoked";

export type FieldDeviceRecord = {
  deviceRef: string;
  userId: number;
  status: DeviceStatus;
  keyFingerprint: string;
  encryptedStorageAttested: boolean;
  keystoreAttestation: "hardware" | "software" | "unknown" | "failed";
  revokedAt?: Date | null;
};

export type KeyEvent = {
  keyFingerprint: string;
  eventType: "enrolled" | "rotated" | "retired" | "compromised";
  validFrom: Date;
  validUntil?: Date | null;
};

export type AdmissionDecision =
  | { admitted: true; note?: string }
  | { admitted: false; reason: string; disposition: "rejected" };

/** Grace window in which a package signed with a just-retired key is still accepted. */
export const KEY_ROTATION_GRACE_HOURS = 72;

/**
 * Whether a package from this device, signed with this fingerprint, at this
 * time, may be received at all. Decided before any byte of the payload is
 * looked at.
 */
export function admitPackage(args: {
  device: FieldDeviceRecord | null;
  claimedUserId: number;
  signedWithFingerprint: string;
  keyHistory: readonly KeyEvent[];
  now: Date;
}): AdmissionDecision {
  const d = args.device;
  if (!d) return { admitted: false, reason: "Unknown device — not enrolled", disposition: "rejected" };
  if (d.userId !== args.claimedUserId) {
    return { admitted: false, reason: `Device ${d.deviceRef} is enrolled to another user`, disposition: "rejected" };
  }
  if (d.status === "revoked") {
    return { admitted: false, reason: `Device ${d.deviceRef} was revoked${d.revokedAt ? ` at ${d.revokedAt.toISOString()}` : ""}`, disposition: "rejected" };
  }
  if (d.status === "suspended") {
    return { admitted: false, reason: `Device ${d.deviceRef} is suspended`, disposition: "rejected" };
  }
  if (d.status === "enrolled") {
    return { admitted: false, reason: `Device ${d.deviceRef} is enrolled but not yet activated`, disposition: "rejected" };
  }

  // A compromised key is refused regardless of when.
  const compromised = args.keyHistory.find(k => k.keyFingerprint === args.signedWithFingerprint && k.eventType === "compromised");
  if (compromised) {
    return { admitted: false, reason: "Package signed with a key reported compromised", disposition: "rejected" };
  }

  if (args.signedWithFingerprint === d.keyFingerprint) {
    if (!d.encryptedStorageAttested) {
      return { admitted: true, note: "Device has not attested encrypted local storage — accepted, flagged for compliance" };
    }
    return { admitted: true };
  }

  // Not the current key. Acceptable only inside the rotation grace window.
  const prior = args.keyHistory.find(k => k.keyFingerprint === args.signedWithFingerprint && k.eventType !== "compromised");
  if (!prior) {
    return { admitted: false, reason: "Package signed with a key this device never held", disposition: "rejected" };
  }
  const retiredAt = prior.validUntil;
  if (!retiredAt) {
    return { admitted: false, reason: "Package signed with a superseded key with no retirement time on record", disposition: "rejected" };
  }
  const ageHours = (args.now.getTime() - retiredAt.getTime()) / 3_600_000;
  if (ageHours <= KEY_ROTATION_GRACE_HOURS) {
    return { admitted: true, note: `Signed with a key retired ${Math.round(ageHours)}h ago — inside the ${KEY_ROTATION_GRACE_HOURS}h rotation grace window` };
  }
  return { admitted: false, reason: `Package signed with a key retired ${Math.round(ageHours)}h ago — outside the ${KEY_ROTATION_GRACE_HOURS}h grace window`, disposition: "rejected" };
}

/* ------------------------------------------------------------------ */
/* Three-way hash verification                                          */
/* ------------------------------------------------------------------ */

export type PackageItem = {
  evidenceRecordId: number;
  /** What the device says the bytes hashed to when it captured them. */
  declaredContentHash: string;
  declaredManifestHash: string;
  /** What the server computed from the bytes it actually received. */
  computedContentHash: string;
  computedManifestHash: string;
};

export type SealOnRecord = {
  evidenceRecordId: number;
  contentHash: string;
  manifestHash: string;
} | null;

export type ItemVerdict = {
  evidenceRecordId: number;
  outcome: "verified" | "rejected";
  reason: string;
};

/**
 * Declared must equal computed (nothing changed in transit), and both must
 * equal the seal on record if one exists (nothing changed since capture was
 * first sealed). Any disagreement rejects the item. The package as a whole
 * is verified only when every item is.
 */
export function verifyPackageItems(args: {
  items: readonly PackageItem[];
  seals: ReadonlyMap<number, SealOnRecord>;
}): { packageOutcome: "hash_verified" | "failed"; verdicts: ItemVerdict[] } {
  const verdicts: ItemVerdict[] = args.items.map(it => {
    if (it.declaredContentHash !== it.computedContentHash) {
      return { evidenceRecordId: it.evidenceRecordId, outcome: "rejected", reason: "Content hash differs between what the device declared and what arrived — altered in transit or on device" };
    }
    if (it.declaredManifestHash !== it.computedManifestHash) {
      return { evidenceRecordId: it.evidenceRecordId, outcome: "rejected", reason: "Manifest hash differs between declared and received" };
    }
    const seal = args.seals.get(it.evidenceRecordId) ?? null;
    if (seal) {
      if (seal.contentHash !== it.computedContentHash) {
        return { evidenceRecordId: it.evidenceRecordId, outcome: "rejected", reason: "Content hash differs from the seal on record — the sealed evidence and this copy are not the same bytes" };
      }
      if (seal.manifestHash !== it.computedManifestHash) {
        return { evidenceRecordId: it.evidenceRecordId, outcome: "rejected", reason: "Manifest hash differs from the seal on record" };
      }
    }
    return { evidenceRecordId: it.evidenceRecordId, outcome: "verified", reason: seal ? "Declared, received and sealed hashes agree" : "Declared and received hashes agree; no prior seal to compare" };
  });
  const allOk = verdicts.every(v => v.outcome === "verified");
  return { packageOutcome: allOk ? "hash_verified" : "failed", verdicts };
}

/* ------------------------------------------------------------------ */
/* Conflicts                                                            */
/* ------------------------------------------------------------------ */

export type VersionedRecord = {
  version: number;
  values: Record<string, unknown>;
};

export type ConflictDetection =
  | { conflict: false; reason: string; fastForward: boolean }
  | {
      conflict: true;
      material: boolean;
      conflictingFields: string[];
      deviceValues: Record<string, unknown>;
      serverValues: Record<string, unknown>;
      reason: string;
    };

/**
 * The device edited from base version N. If the server is still at N, the
 * device's change fast-forwards. If the server moved on, compare field by
 * field: fields only one side touched merge; a field both sides changed to
 * different values is a conflict. Material fields make the whole record a
 * conflict a person resolves; nothing is auto-merged for those.
 */
export function detectConflict(args: {
  deviceBase: VersionedRecord;
  deviceNow: VersionedRecord;
  server: VersionedRecord;
  materialFields: readonly string[];
}): ConflictDetection {
  if (args.server.version === args.deviceBase.version) {
    return { conflict: false, reason: "Server unchanged since the device's base version", fastForward: true };
  }
  if (args.server.version < args.deviceBase.version) {
    return {
      conflict: true, material: true, conflictingFields: ["__version"],
      deviceValues: { version: args.deviceBase.version }, serverValues: { version: args.server.version },
      reason: "Device claims a base version the server has never reached — refusing to guess",
    };
  }

  const keys = Array.from(new Set([...Object.keys(args.deviceNow.values), ...Object.keys(args.server.values), ...Object.keys(args.deviceBase.values)]));
  const conflicting: string[] = [];
  const deviceValues: Record<string, unknown> = {};
  const serverValues: Record<string, unknown> = {};
  for (const k of keys) {
    const base = args.deviceBase.values[k];
    const dev = args.deviceNow.values[k];
    const srv = args.server.values[k];
    const deviceChanged = !same(base, dev);
    const serverChanged = !same(base, srv);
    if (deviceChanged && serverChanged && !same(dev, srv)) {
      conflicting.push(k);
      deviceValues[k] = dev;
      serverValues[k] = srv;
    }
  }
  if (conflicting.length === 0) {
    return { conflict: false, reason: "Server changed other fields; the device's changes merge without overlap", fastForward: false };
  }
  const material = conflicting.some(f => args.materialFields.includes(f));
  return {
    conflict: true, material, conflictingFields: conflicting, deviceValues, serverValues,
    reason: material
      ? `Both sides changed ${conflicting.join(", ")} — includes a material field; a person resolves it`
      : `Both sides changed ${conflicting.join(", ")} — non-material; held for review rather than merged silently`,
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/* ------------------------------------------------------------------ */
/* Storage pressure                                                     */
/* ------------------------------------------------------------------ */

export type LocalRecord = {
  evidenceRecordId: number;
  bytes: number;
  syncState: SyncState;
  hashVerified: boolean;
  deviceRetainUntil: Date | null;
  legalHold: boolean;
};

export type StoragePlan = {
  freeBytes: number;
  targetFreeBytes: number;
  underPressure: boolean;
  deletable: number[];
  bytesFreed: number;
  stillShort: number;
  /** Set when the only way to free space is to sync; never "delete unsynced". */
  blockedReason?: string;
};

/**
 * What a device may delete locally. Only records the office has accepted,
 * whose hashes verified, whose device retention has elapsed, and that are not
 * on legal hold. If that is not enough, the plan says the device is short and
 * why — it does not widen the criteria.
 */
export function planStoragePressure(args: {
  freeBytes: number;
  targetFreeBytes: number;
  records: readonly LocalRecord[];
  now: Date;
}): StoragePlan {
  const underPressure = args.freeBytes < args.targetFreeBytes;
  if (!underPressure) {
    return { freeBytes: args.freeBytes, targetFreeBytes: args.targetFreeBytes, underPressure: false, deletable: [], bytesFreed: 0, stillShort: 0 };
  }
  const eligible = args.records
    .filter(r => syncPermitsDeviceRelease(r.syncState) && r.hashVerified && !r.legalHold && r.deviceRetainUntil != null && r.deviceRetainUntil <= args.now)
    .sort((a, b) => b.bytes - a.bytes);

  const need = args.targetFreeBytes - args.freeBytes;
  const deletable: number[] = [];
  let freed = 0;
  for (const r of eligible) {
    if (freed >= need) break;
    deletable.push(r.evidenceRecordId);
    freed += r.bytes;
  }
  const stillShort = Math.max(0, need - freed);
  const unsynced = args.records.filter(r => !syncPermitsDeviceRelease(r.syncState)).length;
  return {
    freeBytes: args.freeBytes, targetFreeBytes: args.targetFreeBytes, underPressure: true,
    deletable, bytesFreed: freed, stillShort,
    blockedReason: stillShort > 0
      ? `Short ${stillShort} bytes after deleting everything eligible; ${unsynced} record(s) are not yet office-accepted and will not be deleted — synchronize to free space`
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Roadside package scope                                               */
/* ------------------------------------------------------------------ */

/**
 * What a roadside document package may contain. Purpose-built and
 * allowlisted; possession of the tablet is not a permission. This is the
 * server's statement of the scope; the device renders only what is listed.
 */
export const ROADSIDE_PACKAGE_CATEGORIES: readonly string[] = [
  "vehicle_registration",
  "insurance_proof",
  "inspection_certificate",
  "operating_permit",
  "oversize_overweight_permit",
  "hos_current",
  "shipping_document",
  "tdg_document",
  "emergency_response_plan",
];

export const NEVER_IN_ROADSIDE_PACKAGE: readonly string[] = [
  "payroll", "personnel", "billing", "invoice", "rate_card", "tax", "claims_reserve", "premium",
];

export function roadsidePackagePermits(category: string): boolean {
  return ROADSIDE_PACKAGE_CATEGORIES.includes(category) && !NEVER_IN_ROADSIDE_PACKAGE.includes(category);
}
