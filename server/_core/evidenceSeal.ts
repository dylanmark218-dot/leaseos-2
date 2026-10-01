/**
 * Evidence sealing — what "sealed" means technically.
 *
 * A read-only screen is not a seal. Sealing means the file bytes, the metadata
 * and the relationships are serialized into one canonical form, hashed, and
 * that hash travels with the record. The server recomputes it independently on
 * receipt. If the two disagree the record is not accepted and the device copy
 * is not released — a mismatch is an alert, never a silent overwrite.
 *
 * Amendment never mutates. A corrected disposal ticket becomes version 2 with
 * its own seal; version 1 and its hash remain exactly as the operator sealed
 * them in the field. That is the difference between an evidence chain and a
 * folder of files that happen to be old.
 */

import { createHash } from "node:crypto";

export type EvidenceRecordType =
  | "daily_log"
  | "pre_trip"
  | "post_trip_dvir"
  | "manifest"
  | "load_ticket"
  | "disposal_ticket"
  | "scale_ticket"
  | "field_ticket"
  | "bill_receipt"
  | "safety_meeting"
  | "incident"
  | "near_miss"
  | "defect_report"
  | "work_order"
  | "inspection"
  | "permit"
  | "photo"
  // SA1 — Sign & Attest: the canonical stroke document, its rendered mark, a finalized artifact, an audit receipt.
  | "signature_strokes"
  | "signature_render"
  | "signed_artifact"
  | "attest_receipt"
  | "other";

export type EvidenceEntityType =
  | "operator"
  | "unit"
  | "trailer"
  | "equipment"
  | "job"
  | "trip"
  | "load"
  | "manifest"
  | "disposalTicket"
  | "fieldTicket"
  | "workOrder"
  | "incident"
  | "nearMiss"
  | "safetyMeeting"
  | "invoice"
  | "customer"
  | "facility"
  | "dailyLog"
  | "inspection"
  // SA1 (0214)
  | "attestRevision"
  | "attestMark";

export type EvidenceRelationshipInput = {
  entityType: EvidenceEntityType;
  entityId?: number | null;
  entityRef?: string | null;
  role?: string | null;
};

export type SealInput = {
  trackingNumber: string;
  recordType: EvidenceRecordType;
  version: number;
  /** Hash of the file bytes, computed on the device over the original file. */
  contentHash: string;
  capturedAt: Date;
  sealedAt: Date;
  sealedByUserId: number;
  sealedByEmployeeNumber?: string | null;
  deviceId?: string | null;
  devicePlatform?: string | null;
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  relationships: EvidenceRelationshipInput[];
};

export type Seal = {
  canonicalManifest: string;
  manifestHash: string;
  contentHash: string;
  hashAlgorithm: "sha256";
};

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isWellFormedHash(value: string | null | undefined): boolean {
  return typeof value === "string" && HEX64.test(value);
}

/**
 * Deterministic serialization. Two devices sealing identical facts must produce
 * byte-identical manifests, so key order and relationship order are both fixed
 * rather than left to whatever order the caller happened to build them in.
 */
export function canonicalManifest(input: SealInput): string {
  const relationships = input.relationships
    .map(r => ({
      entityType: r.entityType,
      entityId: r.entityId ?? null,
      entityRef: r.entityRef ?? null,
      role: r.role ?? null,
    }))
    .sort((a, b) => {
      const k = (x: typeof a) =>
        `${x.entityType}|${x.entityId ?? ""}|${x.entityRef ?? ""}|${x.role ?? ""}`;
      return k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0;
    });

  // Explicit ordered object — not JSON.stringify over an arbitrary shape.
  const ordered = {
    capturedAt: input.capturedAt.toISOString(),
    capturedLatitude: input.capturedLatitude ?? null,
    capturedLongitude: input.capturedLongitude ?? null,
    contentHash: input.contentHash,
    deviceId: input.deviceId ?? null,
    devicePlatform: input.devicePlatform ?? null,
    recordType: input.recordType,
    relationships,
    sealedAt: input.sealedAt.toISOString(),
    sealedByEmployeeNumber: input.sealedByEmployeeNumber ?? null,
    sealedByUserId: input.sealedByUserId,
    trackingNumber: input.trackingNumber,
    version: input.version,
  };

  return JSON.stringify(ordered);
}

export function sealEvidence(input: SealInput): Seal {
  if (!isWellFormedHash(input.contentHash)) {
    throw new Error(
      "contentHash must be a lowercase 64-character sha256 hex digest"
    );
  }
  if (input.version < 1) throw new Error("version starts at 1");
  if (input.relationships.length === 0) {
    // An evidence object with no relationships cannot be filed into any
    // portfolio, which makes it unfindable at audit. Refuse at seal time.
    throw new Error("a sealed record must relate to at least one entity");
  }

  const manifest = canonicalManifest(input);
  return {
    canonicalManifest: manifest,
    manifestHash: sha256(manifest),
    contentHash: input.contentHash,
    hashAlgorithm: "sha256",
  };
}

export type VerificationResult =
  | "verified"
  | "hash_mismatch"
  | "manifest_mismatch"
  | "pending";

export type VerificationOutcome = {
  result: VerificationResult;
  accepted: boolean;
  /** True only when the office copy is provably identical to what was sealed. */
  deviceCopyMayBeReleased: boolean;
  detail?: string;
};

/**
 * Server-side verification. The server recomputes both hashes from what it
 * actually received; it never takes the device's word for either.
 */
export function verifyReceivedSeal(args: {
  declaredContentHash: string;
  declaredManifestHash: string;
  receivedManifest: string;
  computedContentHash: string;
}): VerificationOutcome {
  const recomputedManifestHash = sha256(args.receivedManifest);

  if (recomputedManifestHash !== args.declaredManifestHash) {
    return {
      result: "manifest_mismatch",
      accepted: false,
      deviceCopyMayBeReleased: false,
      detail:
        "Manifest hash does not match the sealed manifest — metadata or relationships changed in transit",
    };
  }

  if (args.computedContentHash !== args.declaredContentHash) {
    return {
      result: "hash_mismatch",
      accepted: false,
      deviceCopyMayBeReleased: false,
      detail:
        "File content hash does not match the sealed content — local copy retained, retry required",
    };
  }

  return { result: "verified", accepted: true, deviceCopyMayBeReleased: true };
}

/**
 * Amend a sealed record. Produces the next version; the caller is expected to
 * persist it alongside — never over — the previous one.
 */
export function amendSealedEvidence(args: {
  previous: SealInput;
  newContentHash: string;
  amendedAt: Date;
  amendedByUserId: number;
  amendmentReason: string;
  relationships?: EvidenceRelationshipInput[];
}): { seal: Seal; version: number; supersedesVersion: number } {
  if (!args.amendmentReason.trim()) {
    throw new Error("an amendment requires a stated reason");
  }

  const version = args.previous.version + 1;
  const seal = sealEvidence({
    ...args.previous,
    version,
    contentHash: args.newContentHash,
    sealedAt: args.amendedAt,
    sealedByUserId: args.amendedByUserId,
    relationships: args.relationships ?? args.previous.relationships,
  });

  return { seal, version, supersedesVersion: args.previous.version };
}

/* ------------------------------------------------------------------ */
/* P1.2 — the third leg: what the stored bytes actually hash to        */
/* ------------------------------------------------------------------ */

/**
 * A seal records what the **device** said the bytes hashed to. Nothing has ever checked that claim
 * against the object the server is actually holding, so `evidenceSeals.serverVerifiedAt` and
 * `verificationResult` have sat unwritten since the table was created.
 *
 * That gap is narrower than it sounds and worse than it sounds. The device hash is a real control:
 * it catches tampering *after* capture, because a later edit produces different bytes. What it
 * cannot catch is anything that went wrong between the device computing it and the server storing
 * it — a truncated upload, a swapped storage key, a half-written object, a restore that put the
 * wrong file back. In all of those the seal still reads "sealed" and still carries a hash, and the
 * hash is right about a file nobody has. An unverified seal looks exactly like a verified one,
 * which makes it worse than no seal: it is evidence of diligence that was never done.
 *
 * Three legs, and each answers a different question:
 *
 *   `deviceContentHash`  what the device said, at capture
 *   `storedContentHash`  what the bytes on this server hash to, now
 *   `manifestHash`       what the recorded manifest hashes to, recomputed from the manifest itself
 *
 * The third catches a manifest edited after sealing even when the bytes are untouched, which is the
 * quiet one: change the capture time or the operator in the manifest and the photo still matches.
 */
export type SealVerification =
  | { result: "verified"; checkedAt: Date; note: string }
  | { result: "hash_mismatch"; checkedAt: Date; deviceContentHash: string; storedContentHash: string; note: string }
  | { result: "manifest_mismatch"; checkedAt: Date; recordedManifestHash: string; recomputedManifestHash: string; note: string }
  | { result: "content_unavailable"; checkedAt: Date; note: string };

export function verifySealAgainstStored(args: {
  deviceContentHash: string;
  /** Null when the object could not be read — which is unverifiable, never "verified". */
  storedContentHash: string | null;
  recordedManifestHash: string;
  canonicalManifest: string;
  hashOfManifest: (manifest: string) => string;
  checkedAt: Date;
}): SealVerification {
  const recomputed = args.hashOfManifest(args.canonicalManifest);
  if (recomputed !== args.recordedManifestHash) {
    return {
      result: "manifest_mismatch", checkedAt: args.checkedAt,
      recordedManifestHash: args.recordedManifestHash, recomputedManifestHash: recomputed,
      note: "The manifest recorded with this seal does not hash to the value stored beside it. The described circumstances of the capture have changed since it was sealed, whether or not the bytes have.",
    };
  }
  if (args.storedContentHash == null) {
    // Unknown stays unknown. A seal we could not check is not a seal that passed.
    return {
      result: "content_unavailable", checkedAt: args.checkedAt,
      note: "The stored object could not be read, so the device's hash could not be checked against it. This is not a pass: it is a verification that did not happen.",
    };
  }
  if (args.storedContentHash !== args.deviceContentHash) {
    return {
      result: "hash_mismatch", checkedAt: args.checkedAt,
      deviceContentHash: args.deviceContentHash, storedContentHash: args.storedContentHash,
      note: "The bytes this server holds do not hash to what the device recorded at capture. The seal is honest about the original; the stored object is not the object it describes.",
    };
  }
  return {
    result: "verified", checkedAt: args.checkedAt,
    note: "Device hash, stored bytes and manifest all agree.",
  };
}

/** Only one result means the evidence may be relied on. Named so no caller has to remember. */
export const sealIsTrustworthy = (v: SealVerification): boolean => v.result === "verified";
