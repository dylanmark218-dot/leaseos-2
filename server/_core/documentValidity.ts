/**
 * v22.20 — a document on file is not a document in force.
 *
 * Pure. No network, no database.
 *
 * Composes `DocumentType` and the OCR outcome from `documentExtraction` rather
 * than restating them. That module answers "what does this page say"; this one
 * answers "does it count".
 *
 * Three things a document library gets wrong by default.
 *
 * **Uploading is not verifying.** A photo of an insurance certificate is a
 * photo. It becomes a fact when somebody with the standing to say so has
 * checked the dates against the page. Until then the unit has an unverified
 * document, which is a different state from both "covered" and "no document" —
 * and the dangerous one, because the folder looks full.
 *
 * **A new version is not automatically the valid one.** Somebody uploads the
 * 2027 certificate in November and the 2026 one is still what is in force. If
 * the newest upload silently became current, an unverified page would displace
 * a verified one, and the fleet would be running on whatever was uploaded last.
 *
 * **Expiry blocks what depends on the document, not everything.** An expired
 * dangerous-goods endorsement stops dangerous-goods work. It does not stop the
 * same driver hauling water. A system that grounds the person entirely will be
 * overridden until the overrides mean nothing; one that grounds nothing is
 * worse. The dependency is the answer.
 */

import type { DocumentType } from "./documentExtraction";

export type VerificationState =
  | "uploaded"      // bytes exist, nothing is claimed
  | "extracted"     // OCR proposed fields; still nobody's assertion
  | "verified"      // a person checked it against the page
  | "rejected"      // a person looked and said no
  | "superseded";   // a later verified version replaced it

export type DocumentVersion = {
  documentRef: string;
  version: number;
  type: DocumentType;
  subjectRef: string;
  state: VerificationState;
  /** Only meaningful once verified: an OCR-read date is a proposal. */
  effectiveFrom: Date | null;
  expiresAt: Date | null;
  verifiedByUserId: number | null;
  verifiedAt: Date | null;
  supersededByVersion: number | null;
  uploadedAt: Date;
};

export type ValidityState = "in_force" | "expiring" | "expired" | "unverified" | "rejected" | "none";

export type Validity = {
  state: ValidityState;
  version: number | null;
  expiresAt: Date | null;
  daysRemaining: number | null;
  reason: string;
};

/**
 * Which version, if any, is actually in force.
 *
 * Only verified versions are candidates. The most recent verified one wins, and
 * an unverified upload sitting on top of it changes nothing about what is in
 * force — it is reported separately so nobody mistakes a full folder for a
 * current one.
 */
export function validityOf(versions: readonly DocumentVersion[], at: Date, noticeDays = 30): Validity {
  if (!versions.length) return { state: "none", version: null, expiresAt: null, daysRemaining: null, reason: "No document on file" };

  const verified = versions
    .filter(v => v.state === "verified" || v.state === "superseded")
    .filter(v => !v.effectiveFrom || v.effectiveFrom.getTime() <= at.getTime())
    .sort((a, b) => b.version - a.version);

  if (!verified.length) {
    const latest = [...versions].sort((a, b) => b.version - a.version)[0];
    if (latest.state === "rejected") {
      return { state: "rejected", version: latest.version, expiresAt: null, daysRemaining: null, reason: `Version ${latest.version} was reviewed and rejected` };
    }
    return {
      state: "unverified", version: latest.version, expiresAt: null, daysRemaining: null,
      reason: `Version ${latest.version} is ${latest.state}. A document on file is not a document in force until somebody has checked it.`,
    };
  }

  const current = verified[0];
  if (!current.expiresAt) {
    return { state: "in_force", version: current.version, expiresAt: null, daysRemaining: null, reason: `Version ${current.version}, verified, no expiry recorded` };
  }
  const days = Math.floor((current.expiresAt.getTime() - at.getTime()) / 86_400_000);
  if (days < 0) return { state: "expired", version: current.version, expiresAt: current.expiresAt, daysRemaining: days, reason: `Expired ${Math.abs(days)} day(s) ago` };
  if (days <= noticeDays) return { state: "expiring", version: current.version, expiresAt: current.expiresAt, daysRemaining: days, reason: `Expires in ${days} day(s)` };
  return { state: "in_force", version: current.version, expiresAt: current.expiresAt, daysRemaining: days, reason: `Verified and current for another ${days} day(s)` };
}

export class NotVerifiable extends Error {}

/**
 * Verify a version.
 *
 * Supersedes the previous verified one at this moment rather than at upload:
 * the 2027 certificate uploaded in November takes force when somebody confirms
 * it, and the 2026 one is what governs until then.
 */
export function verify(args: {
  versions: readonly DocumentVersion[];
  version: number;
  byUserId: number;
  at: Date;
  effectiveFrom: Date | null;
  expiresAt: Date | null;
}): DocumentVersion[] {
  const target = args.versions.find(v => v.version === args.version);
  if (!target) throw new NotVerifiable(`No version ${args.version} to verify`);
  if (target.state === "verified") throw new NotVerifiable(`Version ${args.version} is already verified`);
  if (target.state === "superseded") throw new NotVerifiable(`Version ${args.version} has been superseded`);

  return args.versions.map(v => {
    if (v.version === args.version) {
      return { ...v, state: "verified" as const, verifiedByUserId: args.byUserId, verifiedAt: args.at, effectiveFrom: args.effectiveFrom, expiresAt: args.expiresAt };
    }
    // The previous holder stays on the record, marked as replaced rather than removed.
    if (v.state === "verified" && v.version < args.version) {
      return { ...v, state: "superseded" as const, supersededByVersion: args.version };
    }
    return v;
  });
}

/** A person looked and said no. Kept, because a rejection is a finding. */
export function reject(versions: readonly DocumentVersion[], version: number): DocumentVersion[] {
  return versions.map(v => (v.version === version ? { ...v, state: "rejected" as const } : v));
}

/* ------------------------------------------------------------------ */
/* What an expiry actually stops                                        */
/* ------------------------------------------------------------------ */

export type Capability = string;

/** What a capability needs on file to be exercised. */
export type CapabilityRequirement = { capability: Capability; requires: readonly DocumentType[] };

export type CapabilityStatus = {
  capability: Capability;
  allowed: boolean;
  blockedBy: { type: DocumentType; state: ValidityState; reason: string }[];
  warnings: { type: DocumentType; reason: string }[];
};

/**
 * Which capabilities a subject retains.
 *
 * Blocking is per capability, from the dependency. An expired dangerous-goods
 * endorsement removes dangerous-goods work and leaves water hauling alone,
 * because that is what is actually true — and a system that grounds the person
 * entirely will be overridden until the overrides mean nothing.
 *
 * `unverified` blocks exactly as `expired` does. Both mean nobody has
 * established the document is in force, which is the same operational fact
 * wearing different clothes.
 */
export function capabilityStatus(args: {
  requirements: readonly CapabilityRequirement[];
  documents: Record<string, readonly DocumentVersion[]>;
  at: Date;
}): CapabilityStatus[] {
  return args.requirements.map(req => {
    const blockedBy: CapabilityStatus["blockedBy"] = [];
    const warnings: CapabilityStatus["warnings"] = [];
    for (const type of req.requires) {
      const v = validityOf(args.documents[type] ?? [], args.at);
      if (v.state === "in_force") continue;
      if (v.state === "expiring") { warnings.push({ type, reason: v.reason }); continue; }
      blockedBy.push({ type, state: v.state, reason: v.reason });
    }
    return { capability: req.capability, allowed: blockedBy.length === 0, blockedBy, warnings };
  });
}

/** The line a dispatcher reads: what this person can still do, and what they cannot. */
export function capabilitySummary(statuses: readonly CapabilityStatus[]): string {
  const kept = statuses.filter(s => s.allowed).map(s => s.capability);
  const lost = statuses.filter(s => !s.allowed);
  if (!lost.length) return `All ${kept.length} capability(ies) retained`;
  return `${kept.length} retained (${kept.join(", ") || "none"}); ${lost.length} blocked — ${lost.map(l => `${l.capability}: ${l.blockedBy.map(b => b.type).join(", ")}`).join("; ")}`;
}
