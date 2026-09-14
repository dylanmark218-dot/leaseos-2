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
  | "inspection";

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
