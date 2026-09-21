/**
 * P3.1 — manifest chain of custody: the rules, pure and DB-free.
 *
 * The router loads rows and calls these. Everything a person could argue
 * about is here, testable without a database: what order custody events may
 * take, when a manifest seals, what closing requires, what an amendment must
 * carry, and how the state is hashed so an amendment can prove what it replaced.
 */
import { createHash } from "node:crypto";

export const CUSTODY_EVENT_TYPES = ["loaded", "departed_origin", "arrived_facility", "accepted_by_facility", "rejected_by_facility", "unloaded", "closed"] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

export const EVIDENCE_RELATIONSHIPS = ["origin_ticket", "scale_ticket", "disposal_ticket", "photo", "signature", "client_authorization", "facility_acceptance", "route_evidence"] as const;
export type EvidenceRelationship = (typeof EVIDENCE_RELATIONSHIPS)[number];

/** Relationships that identify a physical ticket; one ticket belongs to one manifest. */
export const TICKET_RELATIONSHIPS: readonly EvidenceRelationship[] = ["origin_ticket", "scale_ticket", "disposal_ticket"];

/** What each event may follow. `loaded` opens the chain; `closed` ends it. */
const MAY_FOLLOW: Record<CustodyEventType, readonly (CustodyEventType | "start")[]> = {
  loaded: ["start"],
  departed_origin: ["loaded"],
  arrived_facility: ["departed_origin", "rejected_by_facility"],   // rejected: on to the next facility
  accepted_by_facility: ["arrived_facility"],
  rejected_by_facility: ["arrived_facility"],
  unloaded: ["accepted_by_facility"],
  closed: ["unloaded"],
};

export type CustodyDecision =
  | { ok: true; seals: boolean; sequence: number }
  | { ok: false; code: "CUSTODY_OUT_OF_ORDER" | "CUSTODY_CLOSED" | "CUSTODY_TIME_REVERSED" | "CUSTODY_FACILITY_REQUIRED"; message: string };

/**
 * May this event follow the chain so far?
 *
 * Facility acceptance cannot precede arrival — that is the rule the whole
 * table exists for. Time cannot run backwards inside one chain. A closed
 * manifest takes nothing more.
 */
export function nextCustodyEvent(
  chain: readonly { eventType: CustodyEventType; occurredAt: Date }[],
  next: { eventType: CustodyEventType; occurredAt: Date; facilityId: number | null },
): CustodyDecision {
  const last = chain[chain.length - 1];
  if (last?.eventType === "closed") return { ok: false, code: "CUSTODY_CLOSED", message: "The manifest is closed; nothing follows closure" };
  const prev: CustodyEventType | "start" = last ? last.eventType : "start";
  if (!MAY_FOLLOW[next.eventType].includes(prev)) {
    return { ok: false, code: "CUSTODY_OUT_OF_ORDER", message: `${next.eventType} cannot follow ${last ? last.eventType : "an empty chain"}; it may follow ${MAY_FOLLOW[next.eventType].join(" or ")}` };
  }
  if (last && next.occurredAt.getTime() < last.occurredAt.getTime()) {
    return { ok: false, code: "CUSTODY_TIME_REVERSED", message: `${next.eventType} at ${next.occurredAt.toISOString()} precedes ${last.eventType} at ${last.occurredAt.toISOString()}` };
  }
  if ((next.eventType === "arrived_facility" || next.eventType === "accepted_by_facility" || next.eventType === "rejected_by_facility") && !next.facilityId) {
    return { ok: false, code: "CUSTODY_FACILITY_REQUIRED", message: `${next.eventType} names the facility` };
  }
  return { ok: true, seals: next.eventType === "departed_origin", sequence: chain.length + 1 };
}

/** The state an amendment hashes: parties, job, material, facilities. Text snapshots included — they are part of what was represented. */
export type ManifestState = {
  manifestNumber: string; jobId: number | null; tripId: number | null; loadId: number | null;
  operatorId: number | null; unitId: number | null; trailerUnitId: number | null;
  originFacilityId: number | null; destinationFacilityId: number | null;
  material: string | null; unNumber: string | null; loadClass: string | null;
  driver: string | null; trailer: string | null; route: string | null; facility: string | null;
};

export function manifestHash(state: ManifestState): string {
  const keys = Object.keys(state).sort() as (keyof ManifestState)[];
  return createHash("sha256").update(JSON.stringify(keys.map(k => [k, state[k] ?? null]))).digest("hex");
}

export type AmendmentDecision =
  | { ok: true }
  | { ok: false; code: "AMENDMENT_NOT_SEALED" | "AMENDMENT_NO_REASON" | "AMENDMENT_SAME_PERSON" | "AMENDMENT_NO_CHANGE" | "AMENDMENT_CLOSED"; message: string };

/** An amendment exists only after sealing, carries a reason, changes something, and is approved by someone other than its requester. */
export function amendmentAllowed(args: { sealedAt: Date | null; closedAt: Date | null; reasonText: string; requestedByUserId: number; approvedByUserId: number; changedKeys: readonly string[] }): AmendmentDecision {
  if (!args.sealedAt) return { ok: false, code: "AMENDMENT_NOT_SEALED", message: "Before sealing, edit the draft directly; an amendment is for a sealed manifest" };
  if (args.closedAt) return { ok: false, code: "AMENDMENT_CLOSED", message: "A closed manifest is not amended; reopen it through review" };
  if (args.reasonText.trim().length < 10) return { ok: false, code: "AMENDMENT_NO_REASON", message: "An amendment states its reason (at least ten characters)" };
  if (args.requestedByUserId === args.approvedByUserId) return { ok: false, code: "AMENDMENT_SAME_PERSON", message: "The person who requests an amendment does not approve it — a second person does" };
  if (args.changedKeys.length === 0) return { ok: false, code: "AMENDMENT_NO_CHANGE", message: "The amendment changes nothing" };
  return { ok: true };
}

export type CloseDecision =
  | { verdict: "PASS"; required: readonly EvidenceRelationship[] }
  | { verdict: "REVIEW"; code: "NO_EVIDENCE_PROFILE" | "PROFILE_NOT_APPROVED" | "CUSTODY_INCOMPLETE"; message: string; required: readonly EvidenceRelationship[] }
  | { verdict: "BLOCKED"; code: "EVIDENCE_MISSING"; missing: readonly EvidenceRelationship[]; required: readonly EvidenceRelationship[] };

/**
 * May the manifest close?
 *
 * The evidence profile is configuration per load class. No profile is not the
 * same as no requirement: a load class nobody has decided the evidence for
 * closes to REVIEW, and a person decides. Missing evidence under an approved
 * profile is BLOCKED with every missing relationship named.
 */
export function closeDecision(args: {
  profile: { required: readonly EvidenceRelationship[]; approvedAt: Date | null } | null;
  attached: readonly EvidenceRelationship[];
  chain: readonly { eventType: CustodyEventType }[];
}): CloseDecision {
  const last = args.chain[args.chain.length - 1]?.eventType;
  if (last !== "unloaded") return { verdict: "REVIEW", code: "CUSTODY_INCOMPLETE", message: `closing follows unloading; the chain ends at ${last ?? "nothing"}`, required: args.profile?.required ?? [] };
  if (!args.profile) return { verdict: "REVIEW", code: "NO_EVIDENCE_PROFILE", message: "no evidence profile is configured for this load class; a person decides what closing requires", required: [] };
  if (!args.profile.approvedAt) return { verdict: "REVIEW", code: "PROFILE_NOT_APPROVED", message: "the evidence profile for this load class has not been approved", required: args.profile.required };
  const have = new Set(args.attached);
  const missing = args.profile.required.filter(r => !have.has(r));
  return missing.length ? { verdict: "BLOCKED", code: "EVIDENCE_MISSING", missing, required: args.profile.required } : { verdict: "PASS", required: args.profile.required };
}
