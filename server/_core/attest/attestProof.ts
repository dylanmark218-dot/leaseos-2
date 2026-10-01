/**
 * Sign & Attest — the read contract other domains consume (SA1, design §11.2).
 *
 * Billing's sentence — "these seven billable lines were acknowledged by this person on this
 * immutable document revision" — is `acknowledgedLines` of a finalized proof. Nothing here writes
 * a billing, disposal, job or portfolio table; the owning domain decides what a proof changes.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { attestArtifacts, attestDocumentRevisions, attestFields, attestMarks, attestSigners, attestSigningSessions, attestEvents } from "../../../drizzle/schema";
import type { Db } from "../dbTypes";
import type { AttestRevisionState } from "../../../shared/attest";
import { signerIdentityOf } from "./attestPayload";

export type AttestProof = {
  instanceRef: string;
  revisionRef: string;
  revision: number;
  revisionHash: string;
  state: AttestRevisionState;
  acknowledgedLines: { subjectLineRef: string; fieldRef: string; fieldKey: string; fieldType: string; signerRef: string; signerIdentity: string; signerRole: string; markRef: string; payloadHash: string; completedAt: Date; eventSequence: number | null }[];
  signatures: { fieldRef: string; fieldKey: string; fieldType: string; signerRef: string; signerIdentity: string; signerRole: string; authMethod: string; markKind: string; completedAt: Date }[];
  artifact: { artifactRef: string; kind: string; contentHash: string; registerDocumentId: number | null } | null;
  receiptHash: string | null;
  eventChainHead: string | null;
};

/** The latest signing revision of a subject that the scope may see, as proof. Null when none exists. */
export async function attestProofFor(db: Db, scope: { orgRef: string | null }, subject: { subjectType: string; subjectRef?: string | null; instanceRef?: string | null }): Promise<AttestProof | null> {
  const scopeKey = scope.orgRef ?? "default";
  const conds = [eq(attestDocumentRevisions.orgScopeKey, scopeKey), eq(attestDocumentRevisions.subjectType, subject.subjectType)];
  if (subject.subjectRef) conds.push(eq(attestDocumentRevisions.subjectRef, subject.subjectRef));
  else if (subject.instanceRef) conds.push(eq(attestDocumentRevisions.instanceRef, subject.instanceRef));
  else return null;
  const rev = (await db.select().from(attestDocumentRevisions).where(and(...conds)).orderBy(desc(attestDocumentRevisions.revision)).limit(1))[0];
  if (!rev) return null;
  const [fields, signers, sessions, artifacts] = await Promise.all([
    db.select().from(attestFields).where(eq(attestFields.revisionId, rev.id)),
    db.select().from(attestSigners).where(eq(attestSigners.revisionId, rev.id)),
    db.select().from(attestSigningSessions).where(eq(attestSigningSessions.revisionId, rev.id)),
    db.select().from(attestArtifacts).where(eq(attestArtifacts.revisionId, rev.id)),
  ]);
  const markIds = fields.map(f => f.completedMarkId).filter((x): x is number => x != null);
  const marks = markIds.length ? await db.select().from(attestMarks).where(inArray(attestMarks.id, markIds)) : [];
  const events = markIds.length ? await db.select({ markId: attestEvents.markId, sequence: attestEvents.sequence }).from(attestEvents).where(and(eq(attestEvents.revisionId, rev.id), inArray(attestEvents.markId, markIds))) : [];
  const completed = fields.filter(f => f.state === "completed" && f.completedMarkId != null).map(f => {
    const mark = marks.find(m => m.id === f.completedMarkId)!;
    const session = sessions.find(s => s.id === mark.sessionId);
    const signer = signers.find(s => s.id === (session?.signerId ?? f.assignedSignerId));
    return { f, mark, session, signer };
  }).filter(x => x.signer);
  const artifact = artifacts.find(a => a.kind === "finalized_pdf") ?? artifacts.find(a => a.kind === "audit_receipt") ?? null;
  return {
    instanceRef: rev.instanceRef, revisionRef: rev.revisionRef, revision: rev.revision, revisionHash: rev.revisionHash, state: rev.state,
    acknowledgedLines: completed.filter(x => x.f.subjectLineRef).map(x => ({
      subjectLineRef: x.f.subjectLineRef!, fieldRef: x.f.fieldRef, fieldKey: x.f.fieldKey, fieldType: x.f.fieldType, signerRef: x.signer!.signerRef, signerIdentity: signerIdentityOf(x.signer!), signerRole: x.signer!.signerRole,
      markRef: x.mark.markRef, payloadHash: x.mark.payloadHash, completedAt: x.mark.completedAt, eventSequence: events.find(e => e.markId === x.mark.id)?.sequence ?? null,
    })),
    signatures: completed.filter(x => x.f.fieldType === "signature" || x.f.fieldType === "initials" || x.f.fieldType === "approval").map(x => ({
      fieldRef: x.f.fieldRef, fieldKey: x.f.fieldKey, fieldType: x.f.fieldType, signerRef: x.signer!.signerRef, signerIdentity: signerIdentityOf(x.signer!), signerRole: x.signer!.signerRole,
      authMethod: x.session?.authMethod ?? "unknown", markKind: x.mark.markKind, completedAt: x.mark.completedAt,
    })),
    artifact: artifact ? { artifactRef: artifact.artifactRef, kind: artifact.kind, contentHash: artifact.contentHash, registerDocumentId: artifact.registerDocumentId } : null,
    receiptHash: rev.receiptHash, eventChainHead: rev.eventChainHead,
  };
}
