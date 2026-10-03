import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resolveBinding } from "./attestBinding";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("the fingerprint before signing (§8.1)", () => {
  it("binds a field-ticket revision to its snapshot hash only when the snapshot still hashes to it", () => {
    const snapshotJson = JSON.stringify({ a: 1 });
    expect(resolveBinding({ subjectType: "field_ticket_revision", documentRef: "FT-1-R1", fieldTicketId: 4, ticketNumber: "FT-1", snapshotJson, snapshotHash: sha(snapshotJson) }))
      .toEqual({ ok: true, instanceRef: "FT-1", subjectRef: "FT-1-R1", subjectId: 4, revisionHash: sha(snapshotJson) });
    expect(resolveBinding({ subjectType: "field_ticket_revision", documentRef: "FT-1-R1", fieldTicketId: 4, ticketNumber: "FT-1", snapshotJson, snapshotHash: sha("tampered") })).toMatchObject({ ok: false, reason: expect.stringContaining("no longer hashes") });
  });
  it("binds a sealed evidence record to its current seal and refuses a draft, a superseded record or a stale seal", () => {
    const seal = { contentHash: sha("bytes"), version: 2 };
    expect(resolveBinding({ subjectType: "evidence_record", evidenceRecordId: 9, trackingNumber: "EV-9", sealState: "sealed", currentVersion: 2, seal })).toEqual({ ok: true, instanceRef: "EV-9", subjectRef: "evidence:9:v2", subjectId: 9, revisionHash: seal.contentHash });
    expect(resolveBinding({ subjectType: "evidence_record", evidenceRecordId: 9, trackingNumber: null, sealState: "draft", currentVersion: 1, seal: null }).ok).toBe(false);
    expect(resolveBinding({ subjectType: "evidence_record", evidenceRecordId: 9, trackingNumber: null, sealState: "superseded", currentVersion: 2, seal }).ok).toBe(false);
    expect(resolveBinding({ subjectType: "evidence_record", evidenceRecordId: 9, trackingNumber: null, sealState: "sealed", currentVersion: 3, seal }).ok).toBe(false);
  });
  it("binds a register document only while it is the current version, to the chain's root", () => {
    expect(resolveBinding({ subjectType: "commercial_document", documentId: 3, documentRef: "DOC-3", status: "current", contentHash: sha("doc"), version: 2, rootDocumentRef: "DOC-1" })).toEqual({ ok: true, instanceRef: "DOC-1", subjectRef: "DOC-3", subjectId: 3, revisionHash: sha("doc") });
    expect(resolveBinding({ subjectType: "commercial_document", documentId: 3, documentRef: "DOC-3", status: "superseded", contentHash: sha("doc"), version: 2, rootDocumentRef: "DOC-1" }).ok).toBe(false);
  });
});
