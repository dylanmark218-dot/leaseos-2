/**
 * Sign & Attest — producers (SA1, design §3.11, §11.1).
 *
 * A domain that already records a signature becomes a producer: inside its own transaction it opens
 * the signing revision for the exact document revision it is about to store, assigns the one signer,
 * runs the one session and keeps a pointer to it. Everything the domain row recorded before, it
 * still records; what it gains is the binding, the chain and — in SA2 — the drawing.
 *
 * The first producer is the on-spine field-ticket close (`closeoutRouter.recordSignature`).
 */
import type { DeviceAttestation } from "../deviceSignature";
import type { Db } from "../dbTypes";
import { CONSENT_VERSION_V1, type AttestMarkKind } from "../../../shared/attest";
import { AttestRefusal, openRevisionInTx, submitSessionInTx, trpcCodeForRejection, type SubmitActor, type SubmitInput, type SubmitScope } from "./attestService";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type FieldTicketSignatureProducerInput = {
  /** The ticket's owning organization (its job's), or null for the historical single tenant. Never from input. */
  orgRef: string | null;
  /** The R1 revision this signature is of — inserted before this runs; the hash is read from it. */
  documentRef: string;
  signer: { name: string; company: string; role: string | null };
  method: "drawn" | "device_auth" | "pin" | "paper_scan" | "portal_link";
  externalIdentityId: number | null;
  /** The authenticated staff user who witnessed the signature (the driver, or the office filing a scan). */
  witnessUserId: number | null;
  deviceAttestation: DeviceAttestation | null;
  paperScanEvidenceRecordId: number | null;
  offline: boolean;
  gps: { latitude: number; longitude: number } | null;
  now: Date;
};

export type ProducedSignature = { revisionRef: string; sessionRef: string; signerRef: string; fieldRef: string; payloadHash: string; revisionHash: string };

/**
 * What the closeout methods mean in Sign & Attest's two vocabularies (§1.3, §4). `drawn` on the
 * closeout tablet produces no strokes in SA1 (the pad is SA2), so the mark is recorded as what it
 * actually is — an acknowledgement witnessed by the driver — and never as a drawing that does not exist.
 */
export function closeoutMethodMapping(method: FieldTicketSignatureProducerInput["method"]): { authMethod: SubmitInput["authMethod"]; markKind: AttestMarkKind; actorKind: "witness" | "external" } {
  switch (method) {
    case "portal_link": return { authMethod: "portal_link", markKind: "electronic_ack", actorKind: "external" };
    case "paper_scan": return { authMethod: "paper_scan", markKind: "paper_scan", actorKind: "witness" };
    case "drawn": case "pin": case "device_auth": return { authMethod: "witnessed", markKind: "electronic_ack", actorKind: "witness" };
  }
}

export const FIELD_TICKET_SIGNATURE_FIELD = { fieldKey: "consultant_signature", fieldType: "signature" as const, page: 1, xFrac: 0.55, yFrac: 0.88, widthFrac: 0.4, heightFrac: 0.08, signerRole: "customer_representative" };

/**
 * Runs entirely inside the caller's transaction: the revision, the signer, the session and the mark
 * commit with the domain's own rows or not at all. A refusal here therefore throws (the whole close is
 * rolled back, nothing is stored) rather than becoming a rejected-session row — the producer's caller
 * has already checked everything a rejection would name. Returns the refs the domain row keeps.
 */
export async function produceFieldTicketSignature(tx: Tx, input: FieldTicketSignatureProducerInput): Promise<ProducedSignature> {
  const map = closeoutMethodMapping(input.method);
  if (map.actorKind === "external" && input.externalIdentityId == null) throw new Error("A portal_link signature names the external identity that proved it");
  if (map.actorKind === "witness" && input.witnessUserId == null) throw new Error(`A ${input.method} signature on the tablet is witnessed by the authenticated user; none was named`);
  const caller = map.actorKind === "external"
    ? { userId: null, orgRef: input.orgRef, externalIdentityId: input.externalIdentityId }
    : { userId: input.witnessUserId, orgRef: input.orgRef, deviceRef: input.deviceAttestation?.deviceRef ?? null };
  const signer = map.actorKind === "external"
    ? { partyKind: "external_identity" as const, externalIdentityId: input.externalIdentityId!, displayName: input.signer.name, company: input.signer.company, signerRole: FIELD_TICKET_SIGNATURE_FIELD.signerRole, requiredAuth: "portal_link" as const, fieldKeys: [FIELD_TICKET_SIGNATURE_FIELD.fieldKey] }
    : { partyKind: "named_witnessed" as const, displayName: input.signer.name, company: input.signer.company, signerRole: FIELD_TICKET_SIGNATURE_FIELD.signerRole, requiredAuth: map.authMethod === "paper_scan" ? "paper_scan" as const : "witnessed" as const, fieldKeys: [FIELD_TICKET_SIGNATURE_FIELD.fieldKey] };
  const opened = await openRevisionInTx(tx, caller, { subjectType: "field_ticket_revision", subjectRef: input.documentRef, fields: [FIELD_TICKET_SIGNATURE_FIELD], signers: [signer], reuseOpen: true }, input.now);
  const signerRef = opened.signers[0]!.signerRef;
  const fieldRef = opened.fields[0]!.fieldRef;
  const actor: SubmitActor = map.actorKind === "external" ? { kind: "external", externalIdentityId: input.externalIdentityId! } : { kind: "witness", userId: input.witnessUserId! };
  const scope: SubmitScope = map.actorKind === "external" ? { externalIdentityId: input.externalIdentityId! } : { orgRef: input.orgRef };
  const outcome = await submitSessionInTx(tx, actor, scope, {
    revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, authMethod: map.authMethod, consentVersion: CONSENT_VERSION_V1,
    marks: [{ fieldKey: FIELD_TICKET_SIGNATURE_FIELD.fieldKey, markKind: map.markKind, inputKind: input.method === "drawn" ? "touch" : input.method === "pin" ? "keyboard" : "none", renderedEvidenceRecordId: map.markKind === "paper_scan" ? input.paperScanEvidenceRecordId : null }],
    deviceAttestation: input.deviceAttestation ? { ...input.deviceAttestation, verifiedOver: "closeout.canonicalSignaturePayload" } : null,
    capturedOffline: input.offline, gps: input.gps, occurredAt: input.now,
  }, input.now);
  if (!outcome.ok) throw new AttestRefusal(trpcCodeForRejection(outcome.rejection.code), `${outcome.rejection.code}: ${outcome.rejection.reason}`, outcome.rejection.code, outcome.rejection.detail ?? {});
  const result = outcome.result;
  return { revisionRef: opened.revisionRef, sessionRef: result.sessionRef, signerRef, fieldRef, payloadHash: result.marks[0]!.payloadHash, revisionHash: opened.revisionHash };
}
