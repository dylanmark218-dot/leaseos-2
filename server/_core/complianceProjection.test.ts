/**
 * SEC-1 item 3 — a private credential's detail never leaves through a list.
 *
 * `PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED` (compliancePassport.ts) names what a private
 * credential must never expose beyond HR. The passport honoured it; `documents.list` returned the
 * whole row, so a medical certificate's title, identifier and storage key reached every holder of
 * `compliance.read` (baseline V4). This module is the one projection every list path applies, and
 * `isPrivateDocType` is the one rule for which documents are private, so `documents.create` and
 * `compliance.credentialRecord` cannot disagree.
 */
import { describe, expect, it } from "vitest";
import { PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED } from "./compliancePassport";
import { isPrivateDocType, projectComplianceDocument } from "./complianceProjection";

const row = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 7, ownerType: "operator", ownerId: 3, docType: "medical_fitness",
  title: "Commercial medical — Dr. Example, 45-65 band", identifier: "MED-55-1234",
  storageKey: "12/evidence/medical.pdf", storageUrl: null, source: "clinic letter", notes: "restriction: corrective lenses",
  expiresAt: new Date("2027-01-01T00:00:00Z"), verificationStatus: "verified", privateDetail: true,
  ...o,
});

describe("projectComplianceDocument", () => {
  it("nulls every never-projected field of a private document and keeps what a verdict needs", () => {
    const p = projectComplianceDocument(row());
    for (const f of PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED) expect(p[f]).toBeNull();
    expect(p).toMatchObject({ id: 7, docType: "medical_fitness", verificationStatus: "verified", privateDetail: true });
    expect(p.expiresAt).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it("leaves a non-private document untouched, and returns a copy rather than mutating", () => {
    const r = row({ docType: "drivers_licence", privateDetail: false, title: "Class 1" });
    const p = projectComplianceDocument(r);
    expect(p).toEqual(r);
    const priv = row();
    projectComplianceDocument(priv);
    expect(priv.title).toBe("Commercial medical — Dr. Example, 45-65 band");
  });

  it("treats a document whose type is private as private even when the stored flag is false", () => {
    // Rows created through documents.create before this fix carry privateDetail = false.
    const p = projectComplianceDocument(row({ privateDetail: false }));
    expect(p.title).toBeNull();
    expect(p.identifier).toBeNull();
  });
});

describe("isPrivateDocType", () => {
  it("is the single rule for which documents are private", () => {
    expect(isPrivateDocType("medical_fitness")).toBe(true);
    expect(isPrivateDocType("drivers_licence")).toBe(false);
    expect(isPrivateDocType("insurance_certificate")).toBe(false);
  });
});
