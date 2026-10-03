/**
 * Sign & Attest — the subject binding rules. Pure.
 *
 * docs/sign-attest/SIGN_ATTEST_DESIGN.md §8.1. The service loads the subject; this module says what
 * its fingerprint is and whether the loaded facts allow it to be opened for signing. The hash is
 * always recomputed from what the subject stores, never accepted from input.
 */
import { createHash } from "node:crypto";
import { ATTEST_SUBJECT_TYPES, type AttestSubjectType } from "../../../shared/attest";

const HEX64 = /^[0-9a-f]{64}$/;
export const isSubjectType = (v: string): v is AttestSubjectType => (ATTEST_SUBJECT_TYPES as readonly string[]).includes(v);

export type SubjectFacts =
  | { subjectType: "field_ticket_revision"; documentRef: string; fieldTicketId: number; ticketNumber: string; snapshotJson: string; snapshotHash: string }
  | { subjectType: "evidence_record"; evidenceRecordId: number; trackingNumber: string | null; sealState: string; currentVersion: number; seal: { contentHash: string; version: number } | null }
  | { subjectType: "commercial_document"; documentId: number; documentRef: string; status: string; contentHash: string; version: number; rootDocumentRef: string };

export type BindingResolution =
  | { ok: true; instanceRef: string; subjectRef: string; subjectId: number; revisionHash: string }
  | { ok: false; reason: string };

/**
 * The fingerprint before signing, per subject type.
 *
 *   field_ticket_revision  sha256(snapshotJson) must equal the stored snapshotHash — a stored hash that
 *                          no longer matches its own snapshot is an integrity failure, not a document.
 *   evidence_record        the current seal's contentHash; a draft or an unsealed record cannot be
 *                          signed because nothing fixes what the signer saw.
 *   commercial_document    the register row's contentHash while it is the current version.
 */
export function resolveBinding(f: SubjectFacts): BindingResolution {
  switch (f.subjectType) {
    case "field_ticket_revision": {
      if (!HEX64.test(f.snapshotHash)) return { ok: false, reason: "the ticket revision carries no well-formed snapshot hash" };
      const recomputed = createHash("sha256").update(f.snapshotJson).digest("hex");
      if (recomputed !== f.snapshotHash) return { ok: false, reason: `the ticket revision's snapshot no longer hashes to its stored snapshotHash (${f.snapshotHash.slice(0, 12)}…)` };
      return { ok: true, instanceRef: f.ticketNumber, subjectRef: f.documentRef, subjectId: f.fieldTicketId, revisionHash: f.snapshotHash };
    }
    case "evidence_record": {
      if (f.sealState === "draft" || !f.seal) return { ok: false, reason: "the evidence record is not sealed; a signature needs a fixed document" };
      if (f.sealState === "superseded") return { ok: false, reason: "the evidence record is superseded; open its current version" };
      if (!HEX64.test(f.seal.contentHash)) return { ok: false, reason: "the seal carries no well-formed content hash" };
      if (f.seal.version !== f.currentVersion) return { ok: false, reason: "the seal on file is not the record's current version" };
      return { ok: true, instanceRef: f.trackingNumber ?? `EVIDENCE-${f.evidenceRecordId}`, subjectRef: `evidence:${f.evidenceRecordId}:v${f.currentVersion}`, subjectId: f.evidenceRecordId, revisionHash: f.seal.contentHash };
    }
    case "commercial_document": {
      if (f.status !== "current") return { ok: false, reason: `the register document is ${f.status}; only the current version can be signed` };
      if (!HEX64.test(f.contentHash)) return { ok: false, reason: "the register document carries no well-formed content hash" };
      return { ok: true, instanceRef: f.rootDocumentRef, subjectRef: f.documentRef, subjectId: f.documentId, revisionHash: f.contentHash };
    }
  }
}
