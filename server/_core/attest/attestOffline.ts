/**
 * Sign & Attest — the device envelope (SA2): `attest.submitSession`.
 *
 * docs/sign-attest/SIGN_ATTEST_DESIGN.md §6.3. Two signatures, two clocks. The envelope was signed
 * by the device at SEND time with a fresh nonce and must be fresh by the device's own clock (the 0142
 * rule, skew recorded). The session inside it was signed at COMPLETION time, hours or days earlier,
 * with whatever key the device held then; its age is recorded and is not subject to the ten-minute
 * rule, which exists for online acts. Both are verified over exact bytes.
 *
 * The order is the design's, fail-closed at every step, and every answer is a code the device acts
 * on (`attestRefusalHandling`), never a thrown error the outbox would retry for ever:
 *
 *   wire shape → device admission (enrolled by the active organization, bound to the caller, active,
 *   keyed) → envelope freshness → envelope signature → nonce → inner signature → the sealed stroke
 *   bytes are strokes, drawn for this field, rendering to the declared hash → the service (binding,
 *   signer, fields, seals, rows, events, outbox — one transaction).
 *
 * Which refusals are rows: anything from the inner signature on is a session the device cannot fix
 * and is recorded through `recordRejectedSession`, or by the service itself. Envelope refusals
 * (device, clock, key, nonce) are not: the handling tells the device to fix the device and send the
 * SAME session again, and a rejected row under its `sessionRef` would make that impossible.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { attestDocumentRevisions, attestFields, attestMarks, attestSigners, attestSigningSessions, deviceKeyEvents, deviceSyncNonces, evidenceRecords, fieldDevices } from "../../../drizzle/schema";
import {
  ATTEST_ENVELOPE_FORMAT, attestEnvelopeSchema, attestRefusalHandling,
  type AttestRejectionCode, type AttestRevisionState, type AttestSessionSubmitResponse, type AttestSubmitRefusalCode, type OfflineAttestMark,
} from "../../../shared/attest";
import { storageRead } from "../../storage";
import type { Db } from "../dbTypes";
import { DEVICE_SIGNATURE_MAX_SKEW_MS, signatureFreshness, verifyP256PackageSignature } from "../deviceSignature";
import { consentTextHash, sessionPayloadBytes } from "./attestPayload";
import { AttestRefusal, recordRejectedSession, submitSession, type MarkInput, type SubmitActor, type SubmitInput } from "./attestService";
import { verifyDrawnMarkBytes } from "./attestStrokes";

export type EnvelopeCaller = {
  userId: number;
  /** The acting organization as the device table records it (`resolveActingScope().tenantId`). */
  tenantId: string;
  /** The same organization as the attest tables record it: null for the historical single tenant. */
  orgRef: string | null;
  /** Whether the caller holds `attest.witness` — a witnessed session inside the envelope needs it. */
  canWitness: boolean;
};

export type EnvelopeInput = { deviceRef: string; signedWithFingerprint: string; signatureP1363Base64: string; signedPayloadJson: string };

export async function submitDeviceEnvelope(db: Db, caller: EnvelopeCaller, input: EnvelopeInput, now: Date = new Date()): Promise<AttestSessionSubmitResponse> {
  const serverTimeIso = now.toISOString();
  const refusal = (sessionRef: string, code: AttestSubmitRefusalCode, reason: string, skewMs: number | null = null): AttestSessionSubmitResponse =>
    ({ state: "rejected", sessionRef, code, reason, handling: attestRefusalHandling({ code, skewMs, serverTimeIso }), serverTimeIso, skewMs });

  // 1. The exact bytes, parsed. Nothing is decided from the wire until its shape is the envelope's.
  let parsed: unknown;
  try { parsed = JSON.parse(input.signedPayloadJson); } catch { return refusal("(unreadable)", "MALFORMED", "The signed payload is not JSON."); }
  const wire = attestEnvelopeSchema.safeParse(parsed);
  if (!wire.success) return refusal("(unreadable)", "MALFORMED", `The signed payload is not a ${ATTEST_ENVELOPE_FORMAT} envelope: ${wire.error.issues.slice(0, 2).map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}.`);
  const env = wire.data;
  const session = env.session;
  const sessionRef = session.sessionRef;
  if (env.deviceRef !== input.deviceRef) return refusal(sessionRef, "MALFORMED", "The envelope names a device other than the request's.");
  if (!sessionRef.startsWith(`${input.deviceRef}:`)) return refusal(sessionRef, "MALFORMED", "An offline session reference names the device that minted it.");

  // 2. Admission — the server looks the device up; nothing the request says about it is believed.
  const dev = (await db.select().from(fieldDevices).where(eq(fieldDevices.deviceRef, input.deviceRef)).limit(1))[0] ?? null;
  if (!dev || !dev.orgRef || dev.orgRef !== caller.tenantId) return refusal(sessionRef, "DEVICE_NOT_ENROLLED", `Device ${input.deviceRef} is not enrolled with the active organization.`);
  if (dev.userId !== caller.userId) return refusal(sessionRef, "DEVICE_NOT_ENROLLED", `Device ${input.deviceRef} is enrolled to another person; a session is submitted by the person the device is bound to.`);
  if (dev.status !== "active" || dev.revokedAt || dev.suspendedAt) return refusal(sessionRef, "DEVICE_NOT_ACTIVE", `Device ${input.deviceRef} is ${dev.revokedAt ? "revoked" : dev.suspendedAt ? "suspended" : `not active (${dev.status})`}. Revocation takes effect for signatures too.`);
  if (!dev.publicKeySpkiBase64) return refusal(sessionRef, "DEVICE_NOT_ENROLLED", "A fingerprint-only device must be re-enrolled with a public key before it submits signatures.");
  const history = await db.select().from(deviceKeyEvents).where(eq(deviceKeyEvents.fieldDeviceId, dev.id));
  const keyFor = (fp: string): string | null => dev.keyFingerprint === fp ? dev.publicKeySpkiBase64 : history.find(h => h.keyFingerprint === fp && h.publicKeySpkiBase64)?.publicKeySpkiBase64 ?? null;

  // 3. Freshness of the envelope, by the device's clock; the skew between the clocks is recorded.
  const fresh = signatureFreshness({ signedAt: new Date(env.signedAt), now, deviceClockAt: new Date(env.deviceClockAt) });
  if (!fresh.fresh) return refusal(sessionRef, fresh.code, `Envelope refused: ${fresh.reason} (server time ${serverTimeIso}; allowed ±${DEVICE_SIGNATURE_MAX_SKEW_MS / 60_000} min by the device's clock).`, fresh.skewMs);
  const clockSkewMs = fresh.skewMs;

  // 4. The envelope signature, over the very bytes the device sent.
  const envelopeKey = keyFor(input.signedWithFingerprint);
  if (!envelopeKey) return refusal(sessionRef, "KEY_FINGERPRINT_MISMATCH", `The envelope names key ${input.signedWithFingerprint.slice(0, 12)}…, which was never enrolled or rotated in for ${input.deviceRef}.`, clockSkewMs);
  if (!verifyP256PackageSignature({ publicKeySpkiBase64: envelopeKey, payload: Buffer.from(input.signedPayloadJson, "utf8"), signatureP1363Base64: input.signatureP1363Base64 })) {
    return refusal(sessionRef, "SIGNATURE_INVALID", "The envelope signature does not verify against the device's key.", clockSkewMs);
  }

  // 5. The nonce. A replay answers with what the server already holds (§6.4).
  try {
    await db.insert(deviceSyncNonces).values({ fieldDeviceId: dev.id, orgRef: dev.orgRef, nonce: env.nonce, signedAt: new Date(env.signedAt), packageRef: sessionRef.slice(-64), receivedAt: now });
  } catch {
    return (await recorded(db, sessionRef, clockSkewMs, serverTimeIso)) ?? refusal(sessionRef, "REPLAY", "This envelope's nonce was already used; no session is recorded under its reference.", clockSkewMs);
  }

  // 6. Where a refusal from here on is filed: the revision and signer in the caller's organization.
  const located = await locate(db, caller.orgRef, session.revisionRef, session.signerRef);
  const actor: SubmitActor = session.authMethod === "witnessed" ? { kind: "witness", userId: caller.userId } : { kind: "user", userId: caller.userId };
  const inner = session.deviceSignature;
  const serviceInput: SubmitInput = {
    revisionRef: session.revisionRef, signerRef: session.signerRef, revisionHashAtStart: session.revisionHashAtStart, authMethod: session.authMethod, consentVersion: session.consentVersion,
    marks: session.marks.map(toMarkInput),
    deviceAttestation: { deviceRef: input.deviceRef, keyFingerprint: inner.keyFingerprint, signatureP1363Base64: inner.signatureP1363Base64, signedAt: new Date(inner.signedAt), verifiedOver: "session_payload_offline" },
    capturedOffline: true, gps: session.gps, sessionRef, occurredAt: new Date(session.completedAt),
    deviceClockAt: new Date(env.deviceClockAt), clockSkewMs, clockSource: "device",
  };
  const settled = async (code: AttestRejectionCode, reason: string): Promise<AttestSessionSubmitResponse> => {
    if (located) await recordRejectedSession(db, actor, serviceInput, { revisionId: located.revisionId, signerId: located.signerId, rejection: { code, reason } }, now).catch(() => undefined);
    return refusal(sessionRef, code, reason, clockSkewMs);
  };
  if (session.authMethod === "witnessed" && !caller.canWitness) return settled("AUTH_METHOD_INSUFFICIENT", "A witnessed session is submitted by a user who holds attest.witness; this caller does not.");
  const consentHash = consentTextHash(session.consentVersion);
  if (!consentHash) return settled("CONSENT_MISSING", `Unknown consent statement ${session.consentVersion}.`);

  // 7. The inner signature: the session as signed at completion, by the key the device held then.
  const innerKey = keyFor(inner.keyFingerprint);
  if (!innerKey) return settled("KEY_FINGERPRINT_MISMATCH", `The session was signed with key ${inner.keyFingerprint.slice(0, 12)}…, which was never enrolled or rotated in for this device.`);
  const innerPayload = sessionPayloadBytes({
    sessionRef, revisionRef: session.revisionRef, revisionHash: session.revisionHashAtStart, signerRef: session.signerRef,
    marks: session.marks.map(m => ({ fieldKey: m.fieldKey, markKind: m.markKind, strokeHash: m.strokeHash, renderedHash: m.renderedHash, valueText: m.markKind === "date" ? null : m.valueText })),
    consentTextHash: consentHash, signedAt: new Date(inner.signedAt),
  });
  if (!verifyP256PackageSignature({ publicKeySpkiBase64: innerKey, payload: innerPayload, signatureP1363Base64: inner.signatureP1363Base64 })) {
    return settled("SIGNATURE_INVALID", "The session signature does not verify against the key the device named. The marks are kept as evidence; the session is not accepted.");
  }
  if (new Date(inner.signedAt).getTime() > new Date(env.signedAt).getTime() + DEVICE_SIGNATURE_MAX_SKEW_MS) return settled("MALFORMED", "The session was signed after the envelope that carries it.");

  // 8. Drawn marks: the sealed bytes ARE strokes, drawn for this field, rendering to the declared hash.
  for (const m of session.marks) {
    if (m.markKind !== "drawn") continue;
    if (m.strokeEvidenceRecordId == null || !m.strokeHash) return settled("MARK_NOT_SEALED", `Field ${m.fieldKey}: a drawn mark names its sealed stroke record and hash.`);
    const fieldRef = located?.fields.get(m.fieldKey);
    if (!fieldRef) return settled("MALFORMED", `Field ${m.fieldKey} does not exist on ${session.revisionRef}.`);
    const strokeBytes = await bytesOf(db, m.strokeEvidenceRecordId);
    if (!strokeBytes) return settled("MARK_NOT_SEALED", `Field ${m.fieldKey}: the stroke record's bytes cannot be read from the vault.`);
    const renderedBytes = m.renderedEvidenceRecordId != null ? await bytesOf(db, m.renderedEvidenceRecordId) : null;
    if (m.renderedEvidenceRecordId != null && !renderedBytes) return settled("MARK_NOT_SEALED", `Field ${m.fieldKey}: the render's bytes cannot be read from the vault.`);
    const v = verifyDrawnMarkBytes({ strokeBytes, renderedBytes, declared: { strokeHash: m.strokeHash, renderedHash: m.renderedHash, fieldRef, canvas: m.canvas, pointCount: m.pointCount, strokeCount: m.strokeCount, inputKind: m.inputKind } });
    if (!v.ok) return settled(v.code, `Field ${m.fieldKey}: ${v.reason}`);
  }

  // 9. The service: binding, signer, fields, seals, rows, events, outbox — one transaction; a refusal is a row.
  try {
    const r = await submitSession(db, actor, { orgRef: caller.orgRef }, serviceInput);
    return { state: r.alreadyRecorded ? "already_recorded" : "accepted", sessionRef: r.sessionRef, revisionState: r.revisionState, signerState: r.signerState, marks: r.marks, clockSkewMs };
  } catch (e) {
    if (e instanceof AttestRefusal) {
      const code: AttestSubmitRefusalCode = e.rejection ?? (e.code === "not_found" ? "REVISION_MISMATCH" : "MALFORMED");
      return refusal(sessionRef, code, e.message, clockSkewMs);
    }
    throw e;
  }
}

const toMarkInput = (m: OfflineAttestMark): MarkInput => ({
  fieldKey: m.fieldKey, markKind: m.markKind, inputKind: m.inputKind, valueText: m.valueText,
  strokeEvidenceRecordId: m.strokeEvidenceRecordId, strokeHash: m.strokeHash, renderedEvidenceRecordId: m.renderedEvidenceRecordId, renderedHash: m.renderedHash,
  canvas: m.canvas, pointCount: m.pointCount, strokeCount: m.strokeCount, durationMs: m.durationMs, pressureAvailable: m.pressureAvailable,
});

async function locate(db: Db, orgRef: string | null, revisionRef: string, signerRef: string): Promise<{ revisionId: number; signerId: number | null; fields: Map<string, string> } | null> {
  const rev = (await db.select({ id: attestDocumentRevisions.id }).from(attestDocumentRevisions)
    .where(and(eq(attestDocumentRevisions.revisionRef, revisionRef), orgRef == null ? isNull(attestDocumentRevisions.orgRef) : eq(attestDocumentRevisions.orgRef, orgRef))).limit(1))[0];
  if (!rev) return null;
  const signer = (await db.select({ id: attestSigners.id }).from(attestSigners).where(and(eq(attestSigners.revisionId, rev.id), eq(attestSigners.signerRef, signerRef))).limit(1))[0];
  const fields = new Map<string, string>();
  for (const f of await db.select({ fieldKey: attestFields.fieldKey, fieldRef: attestFields.fieldRef }).from(attestFields).where(eq(attestFields.revisionId, rev.id))) fields.set(f.fieldKey, f.fieldRef);
  return { revisionId: rev.id, signerId: signer?.id ?? null, fields };
}

async function bytesOf(db: Db, evidenceRecordId: number): Promise<Buffer | null> {
  const rec = (await db.select({ storageKey: evidenceRecords.storageKey }).from(evidenceRecords).where(eq(evidenceRecords.id, evidenceRecordId)).limit(1))[0];
  if (!rec?.storageKey) return null;
  try { return await storageRead(rec.storageKey); } catch { return null; }
}

/** The idempotent answer for a session the server already holds, or null when it holds none. */
async function recorded(db: Db, sessionRef: string, clockSkewMs: number | null, serverTimeIso: string): Promise<AttestSessionSubmitResponse | null> {
  const s = (await db.select().from(attestSigningSessions).where(eq(attestSigningSessions.sessionRef, sessionRef)).orderBy(desc(attestSigningSessions.id)).limit(1))[0];
  if (!s) return null;
  if (s.state === "rejected") {
    const code = (s.rejectionCode ?? "MALFORMED") as AttestSubmitRefusalCode;
    return { state: "rejected", sessionRef, code, reason: s.rejectionReason ?? "Session was rejected", handling: attestRefusalHandling({ code, skewMs: clockSkewMs, serverTimeIso }), serverTimeIso, skewMs: clockSkewMs };
  }
  const rev = (await db.select({ state: attestDocumentRevisions.state }).from(attestDocumentRevisions).where(eq(attestDocumentRevisions.id, s.revisionId)).limit(1))[0];
  const signer = (await db.select({ state: attestSigners.state }).from(attestSigners).where(eq(attestSigners.id, s.signerId)).limit(1))[0];
  const marks = await db.select({ markRef: attestMarks.markRef, payloadHash: attestMarks.payloadHash, fieldKey: attestFields.fieldKey, fieldRef: attestFields.fieldRef })
    .from(attestMarks).innerJoin(attestFields, eq(attestFields.id, attestMarks.fieldId)).where(eq(attestMarks.sessionId, s.id));
  return { state: "already_recorded", sessionRef, revisionState: (rev?.state ?? "open") as AttestRevisionState, signerState: signer?.state ?? "active", marks, clockSkewMs };
}
