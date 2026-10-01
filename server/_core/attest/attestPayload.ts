/**
 * Sign & Attest — what gets hashed, and how. Pure.
 *
 * One digest (`evidenceSeal.sha256`), one canonicalizer for anything a device signs
 * (`deviceSignature.canonicalAttestPayload`, plain JSON only) and one for the receipt
 * (`auditPackage.canonicalJson`, the audit-package shape). docs/sign-attest/SIGN_ATTEST_DESIGN.md §8–9.
 */
import { createHash } from "node:crypto";
import { canonicalAttestPayload } from "../deviceSignature";
import { canonicalJson } from "../auditPackage";
import { CONSENT_TEXTS, sessionSigningObject, type SessionSigningMark } from "../../../shared/attest";

export const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

export function consentTextHash(version: string): string | null {
  const text = CONSENT_TEXTS[version];
  return text ? sha256Hex(text) : null;
}

export type MarkPayloadInput = {
  revisionRef: string;
  revisionHash: string;
  instanceRef: string;
  fieldRef: string;
  fieldKey: string;
  fieldType: string;
  signerRef: string;
  /** `user:<id>`, `ext:<id>` or `named:<sha256 of displayName>` — never an email. */
  signerIdentity: string;
  markKind: string;
  strokeHash: string | null;
  renderedHash: string | null;
  valueText: string | null;
  consentTextHash: string;
  completedAt: Date;
};

/** The canonical mark payload (§8.2). Its hash binds the mark to the revision hash whatever the method. */
export function markPayloadBytes(m: MarkPayloadInput): Buffer {
  return canonicalAttestPayload({
    v: 1,
    revisionRef: m.revisionRef, revisionHash: m.revisionHash, instanceRef: m.instanceRef,
    fieldRef: m.fieldRef, fieldKey: m.fieldKey, fieldType: m.fieldType,
    signerRef: m.signerRef, signerIdentity: m.signerIdentity,
    markKind: m.markKind, strokeHash: m.strokeHash, renderedHash: m.renderedHash, valueText: m.valueText,
    consentTextHash: m.consentTextHash, completedAt: m.completedAt.toISOString(),
  });
}
export const markPayloadHash = (m: MarkPayloadInput): string => sha256Hex(markPayloadBytes(m));

/**
 * The session payload a device signs (§8.2). Everything in it is known to the device before it signs:
 * the revision and its hash, the signer, each mark's field, kind and content hash or value, the consent
 * hash and the device's own signing time. Nothing server-assigned (ids, server timestamps) is in it,
 * because a device cannot sign what it has not seen.
 */
export type SessionPayloadMark = SessionSigningMark;
export function sessionPayloadBytes(s: { sessionRef: string; revisionRef: string; revisionHash: string; signerRef: string; marks: readonly SessionPayloadMark[]; consentTextHash: string; signedAt: Date }): Buffer {
  // SA2 — the object is the shared one, so the device builds exactly what the server hashes.
  return canonicalAttestPayload(sessionSigningObject({ ...s, signedAt: s.signedAt.toISOString() }));
}

export function signerIdentityOf(s: { partyKind: string; userId: number | null; externalIdentityId: number | null; displayName: string }): string {
  if (s.partyKind === "internal_user" && s.userId != null) return `user:${s.userId}`;
  if (s.partyKind === "external_identity" && s.externalIdentityId != null) return `ext:${s.externalIdentityId}`;
  return `named:${sha256Hex(s.displayName)}`;
}

/* ------------------------------------------------------------------ */
/* The event chain (§8.3)                                               */
/* ------------------------------------------------------------------ */

/** What the chain hashes: exactly the columns stored on the event row, so a verifier needs no join. */
export type ChainEventInput = {
  revisionRef: string;
  sequence: number;
  eventType: string;
  sessionId: number | null;
  fieldId: number | null;
  markId: number | null;
  artifactId: number | null;
  actorSource: string;
  actorUserId: number | null;
  actorExternalIdentityId: number | null;
  deviceRef: string | null;
  previousState: string | null;
  newState: string | null;
  detailJson: string | null;
  occurredAt: Date;
};

export function eventHash(prevEventHash: string | null, e: ChainEventInput): string {
  const body = canonicalAttestPayload({
    v: 1, revisionRef: e.revisionRef, sequence: e.sequence, eventType: e.eventType,
    sessionId: e.sessionId, fieldId: e.fieldId, markId: e.markId, artifactId: e.artifactId,
    actorSource: e.actorSource, actorUserId: e.actorUserId, actorExternalIdentityId: e.actorExternalIdentityId, deviceRef: e.deviceRef,
    previousState: e.previousState, newState: e.newState, detailJson: e.detailJson, occurredAt: e.occurredAt.toISOString(),
  });
  return sha256Hex(Buffer.concat([Buffer.from(prevEventHash ?? "", "utf8"), Buffer.from("|", "utf8"), body]));
}

export type ChainVerification = { ok: true; head: string | null; length: number } | { ok: false; brokenAtSequence: number; reason: string };

/** Walk a revision's events in sequence and recompute every link. */
export function verifyChain(events: readonly (ChainEventInput & { prevEventHash: string | null; eventHash: string })[]): ChainVerification {
  let prev: string | null = null;
  let expected = 1;
  for (const e of events) {
    if (e.sequence !== expected) return { ok: false, brokenAtSequence: e.sequence, reason: `sequence ${e.sequence} where ${expected} was expected` };
    if ((e.prevEventHash ?? null) !== prev) return { ok: false, brokenAtSequence: e.sequence, reason: "prevEventHash does not match the previous event" };
    const recomputed = eventHash(prev, e);
    if (recomputed !== e.eventHash) return { ok: false, brokenAtSequence: e.sequence, reason: "eventHash does not recompute" };
    prev = e.eventHash;
    expected += 1;
  }
  return { ok: true, head: prev, length: events.length };
}

/* ------------------------------------------------------------------ */
/* The audit receipt (§9.4)                                             */
/* ------------------------------------------------------------------ */

export const RECEIPT_FORMAT = "leaseos-attest-receipt/1";
export const RECEIPT_RENDERER = { rendererKey: "attest-receipt", rendererVersion: "1" } as const;

export type ReceiptInput = {
  revision: { revisionRef: string; instanceRef: string; revision: number; subjectType: string; subjectRef: string; revisionHash: string; state: string; pageCount: number; completionRule: string };
  fields: { fieldRef: string; fieldKey: string; fieldType: string; page: number; box: { xFrac: number; yFrac: number; widthFrac: number; heightFrac: number }; signerRef: string | null; subjectLineRef: string | null; required: boolean; state: string; markRef: string | null; payloadHash: string | null; strokeHash: string | null; renderedHash: string | null }[];
  signers: { signerRef: string; partyKind: string; identity: string; role: string; requiredAuth: string; state: string }[];
  sessions: { sessionRef: string; signerRef: string; authMethod: string; deviceRef: string | null; keyFingerprint: string | null; deviceSignatureBase64: string | null; capturedOffline: boolean; clockSkewMs: number | null; startedAt: Date; completedAt: Date | null; state: string; rejectionCode: string | null }[];
  events: { sequence: number; eventType: string; eventHash: string }[];
  chainHead: string | null;
  notCompletedOptional: string[];
  generatedAt: Date;
};

/** Canonical JSON of the receipt and its hash. Names no biometric material, no bearer token, no email. */
export function receiptManifest(r: ReceiptInput): { manifestJson: string; receiptHash: string } {
  const manifest = {
    format: RECEIPT_FORMAT,
    revision: r.revision,
    fields: r.fields,
    signers: r.signers,
    sessions: r.sessions.map(s => ({ ...s, startedAt: s.startedAt.toISOString(), completedAt: s.completedAt?.toISOString() ?? null })),
    events: r.events,
    chainHead: r.chainHead,
    notCompletedOptional: r.notCompletedOptional,
    generatedAt: r.generatedAt.toISOString(),
  };
  const manifestJson = canonicalJson(manifest);
  return { manifestJson, receiptHash: sha256Hex(manifestJson) };
}
