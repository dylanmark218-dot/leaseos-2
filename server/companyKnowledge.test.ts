/**
 * AIL-1B — company intelligence rules, pure. The database half is companyKnowledge.db.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_KINDS, SOURCES_FOR_KIND, SUBJECTS_FOR_KIND, correctionInManifest, mayMove, mayReview, shapeRefusal, supersessionKey, termKey, type EntryShape,
} from "./_core/companyKnowledge";

const base: EntryShape = { kind: "terminology", term: "Bluebird", meaning: "Bluebird #4 Battery, NE-12-34-5-W5", subjectType: "none", subjectRef: null, sourceKind: "person_statement", sourceRef: null };

describe("a term is compared by its key, not its spelling", () => {
  it("folds case, width and spacing, and drops surrounding punctuation only", () => {
    expect(termKey("  Bluebird   #4 ")).toBe("bluebird #4");
    expect(termKey("BLUEBIRD #4")).toBe(termKey("bluebird #4"));
    expect(termKey("Ｂｌｕｅｂｉｒｄ")).toBe("bluebird");          // full-width
    expect(termKey("\"Bluebird.\"")).toBe("bluebird");
    expect(termKey("Bluebird")).not.toBe(termKey("Bluebird #4"));   // a different term, not a fuzzy match
    expect(termKey(" ... ")).toBe("");
  });
});

describe("an entry's shape", () => {
  it("accepts a plain person's statement of terminology", () => {
    expect(shapeRefusal(base)).toBeNull();
  });
  it("refuses an empty term or meaning", () => {
    expect(shapeRefusal({ ...base, term: " -- " })).toBe("term_empty");
    expect(shapeRefusal({ ...base, meaning: "  " })).toBe("meaning_empty");
  });
  it("ties a convention to its facility or customer, and a correction to a form field", () => {
    expect(shapeRefusal({ ...base, kind: "facility_convention" })).toBe("subject_not_allowed_for_kind");
    expect(shapeRefusal({ ...base, kind: "facility_convention", subjectType: "facility", subjectRef: "12" })).toBeNull();
    expect(shapeRefusal({ ...base, kind: "customer_convention", subjectType: "facility", subjectRef: "12" })).toBe("subject_not_allowed_for_kind");
    expect(shapeRefusal({ ...base, kind: "sop", subjectType: "customer", subjectRef: "Acme" })).toBe("subject_not_allowed_for_kind");
    expect(shapeRefusal({ ...base, subjectType: "customer", subjectRef: null })).toBe("subject_ref_mismatch");
    expect(shapeRefusal({ ...base, subjectRef: "x" })).toBe("subject_ref_mismatch");
  });
  it("lets nothing but a person's correction claim to be a verified correction", () => {
    const correction: EntryShape = { ...base, kind: "verified_correction", subjectType: "form_field", subjectRef: "fuel_receipt.vendor", sourceKind: "verified_correction", sourceRef: "PRP-1" };
    expect(shapeRefusal(correction)).toBeNull();
    expect(shapeRefusal({ ...correction, sourceKind: "person_statement", sourceRef: null })).toBe("source_not_allowed_for_kind");
    expect(shapeRefusal({ ...base, sourceKind: "verified_correction", sourceRef: "PRP-1" })).toBe("source_not_allowed_for_kind");
    expect(shapeRefusal({ ...correction, subjectRef: "fuel receipt.vendor" })).toBe("form_field_malformed");
    expect(shapeRefusal({ ...correction, sourceRef: null })).toBe("source_ref_required");
  });
  it("records a knowledge gap only as a person's statement, and a statement carries no reference to launder", () => {
    expect(shapeRefusal({ ...base, kind: "knowledge_gap", sourceKind: "company_document", sourceRef: "P-1" })).toBe("source_not_allowed_for_kind");
    expect(shapeRefusal({ ...base, sourceRef: "ASK-123" })).toBe("source_ref_not_allowed");
    expect(shapeRefusal({ ...base, sourceKind: "company_document", sourceRef: null })).toBe("source_ref_required");
  });
  it("gives every kind at least one subject and one source", () => {
    for (const k of KNOWLEDGE_KINDS) {
      expect(SUBJECTS_FOR_KIND[k].length).toBeGreaterThan(0);
      expect(SOURCES_FOR_KIND[k].length).toBeGreaterThan(0);
    }
  });
});

describe("the lifecycle", () => {
  it("moves proposed → approved/rejected, approved → superseded/retired, and never back", () => {
    expect(mayMove("proposed", "approved")).toBe(true);
    expect(mayMove("proposed", "rejected")).toBe(true);
    expect(mayMove("approved", "superseded")).toBe(true);
    expect(mayMove("approved", "retired")).toBe(true);
    for (const final of ["rejected", "superseded", "retired"] as const) {
      for (const to of ["proposed", "approved", "rejected", "superseded", "retired"] as const) expect(mayMove(final, to)).toBe(false);
    }
    expect(mayMove("proposed", "retired")).toBe(false);
    expect(mayMove("approved", "approved")).toBe(false);
  });
  it("takes two people", () => {
    expect(mayReview(7, 7)).toBe(false);
    expect(mayReview(7, 8)).toBe(true);
  });
  it("supersedes only the same term, kind and subject", () => {
    const k = (o: Partial<{ kind: string; termKey: string; subjectType: string; subjectRef: string | null }>) => supersessionKey({ kind: "alias", termKey: "bb", subjectType: "none", subjectRef: null, ...o });
    expect(k({})).toBe(k({}));
    expect(k({})).not.toBe(k({ kind: "terminology" }));
    expect(k({ subjectType: "customer", subjectRef: "A" })).not.toBe(k({ subjectType: "customer", subjectRef: "B" }));
  });
});

describe("a verified correction must be in the sealed manifest", () => {
  const manifest = JSON.stringify([
    { key: "litres", value: 120, status: "confirmed", correctedFrom: null },
    { key: "vendor", value: "Bluebird #4", status: "corrected", correctedFrom: "Bluebird" },
  ]);
  it("finds a field a person corrected on that form", () => {
    expect(correctionInManifest(manifest, "fuel_receipt", "fuel_receipt.vendor")).toBe(true);
  });
  it("refuses a field that was not corrected, another form, or an unreadable manifest", () => {
    expect(correctionInManifest(manifest, "fuel_receipt", "fuel_receipt.litres")).toBe(false);
    expect(correctionInManifest(manifest, "fuel_receipt", "expense_receipt.vendor")).toBe(false);
    expect(correctionInManifest("not json", "fuel_receipt", "fuel_receipt.vendor")).toBe(false);
    expect(correctionInManifest("{}", "fuel_receipt", "fuel_receipt.vendor")).toBe(false);
  });
});
