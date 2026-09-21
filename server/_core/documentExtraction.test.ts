import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_POLICY,
  classifyDocument,
  disposeField,
  extractToProposal,
  merchantMemoryConfidence,
  normalizeVendor,
  type OcrResult,
} from "./documentExtraction";
import { FORMS } from "./aiProposal";
import { planAssistantCommit, type AssistantCommitContext } from "./assistantCommitAdapters";
import type { CommittedField } from "./aiProposal";

const receipt = (over: Partial<OcrResult> = {}): OcrResult => ({
  engine: "test-ocr",
  engineVersion: "1",
  rawText: "FUEL STOP #12\nDiesel 412.3 L\nSubtotal 520.00\nGST 26.00\nTOTAL 546.00\nReceipt 2026-09-08",
  fields: [
    { key: "vendorName", confidence: 99, value: "Fuel Stop #12", sourceText: "FUEL STOP #12" },
    { key: "transactionDate", confidence: 99, value: "2026-09-08" },
    { key: "total", confidence: 99, value: 546.0, sourceText: "TOTAL 546.00" },
    { key: "subtotal", confidence: 97, value: 520.0 },
    { key: "salesTaxAmount", confidence: 96, value: 26.0 },
    { key: "currency", confidence: 99, value: "CAD" },
    { key: "paymentMethod", confidence: 90, value: "Visa" },
    { key: "categoryKey", confidence: 70, value: "fuel" },
  ],
  ...over,
});

describe("the four gates, strictest first", () => {
  it("never auto-files money however confident the read", () => {
    // A typo in a vendor name is an annoyance. A misread total is a misfiled
    // expense. 99.9 does not change that.
    for (const key of ["total", "subtotal", "salesTaxAmount", "quantity", "netWeightKg"]) {
      expect(disposeField({ fieldKey: key, confidence: 99.9, hasValue: true }), key).toBe("human_only");
    }
  });

  it("never auto-files a precision-sensitive field", () => {
    expect(
      disposeField({ fieldKey: "someField", confidence: 99, hasValue: true, precisionSensitive: true })
    ).toBe("human_only");
  });

  it("auto-files only low-risk metadata, and only at the top band", () => {
    expect(disposeField({ fieldKey: "vendorName", confidence: 98, hasValue: true })).toBe("auto_file");
    expect(disposeField({ fieldKey: "vendorName", confidence: 97.9, hasValue: true })).toBe("review");
    // Confident, but not on the eligible list.
    expect(disposeField({ fieldKey: "jobRef", confidence: 99, hasValue: true })).toBe("review");
  });

  it("asks below the review floor, and asks when there is no value at all", () => {
    expect(disposeField({ fieldKey: "vendorName", confidence: 84.9, hasValue: true })).toBe("ask");
    expect(disposeField({ fieldKey: "vendorName", confidence: 99, hasValue: false })).toBe("ask");
  });

  it("keeps the auto-file band narrow", () => {
    expect(CONFIDENCE_POLICY.autoFile).toBeGreaterThanOrEqual(98);
    expect(CONFIDENCE_POLICY.review).toBeGreaterThanOrEqual(85);
  });
});

describe("classification", () => {
  it("recognizes a receipt from its markers", () => {
    const c = classifyDocument({ ocr: receipt() });
    expect(c.documentType).toBe("expense_receipt");
  });

  it("flags a close race as ambiguous rather than picking a winner", () => {
    // A scale ticket read as a receipt files kilograms as dollars.
    const c = classifyDocument({
      ocr: receipt({ rawText: "GROSS 41200 kg TARE 18100 kg NET 23100 kg SCALE TOTAL RECEIPT SUBTOTAL GST" }),
    });
    expect(c.ambiguous).toBe(true);
    expect(c.reasons.join(" ")).toMatch(/Close race|disagrees/);
  });

  it("returns unknown with no markers, and unknown is ambiguous", () => {
    const c = classifyDocument({ ocr: receipt({ rawText: "lorem ipsum" }) });
    expect(c.documentType).toBe("unknown");
    expect(c.ambiguous).toBe(true);
  });

  it("lets confident merchant memory override keywords", () => {
    const c = classifyDocument({
      ocr: receipt({ rawText: "lorem ipsum" }),
      merchantMemory: { vendorName: "Fuel Stop #12", documentType: "fuel_receipt", confidence: 95 },
    });
    expect(c.documentType).toBe("fuel_receipt");
    expect(c.source).toBe("merchant_memory");
    expect(c.ambiguous).toBe(false);
  });

  it("marks an engine hint that keywords disagree with as ambiguous", () => {
    const c = classifyDocument({
      ocr: receipt({ documentTypeHint: "invoice", documentTypeConfidence: 90 }),
    });
    expect(c.documentType).toBe("invoice");
    expect(c.ambiguous).toBe(true);
  });
});

describe("extraction to proposal", () => {
  it("proposes every field with OCR provenance and never confirms one", () => {
    const out = extractToProposal({ ocr: receipt(), classification: classifyDocument({ ocr: receipt() }) });
    expect(out.formKey).toBe("expense_receipt");
    expect(out.fields.length).toBe(FORMS.expense_receipt.fields.length);
    for (const f of out.fields) {
      expect(f.source, f.key).toBe("photo_ocr");
      expect(f.status, f.key).toBe("proposed");
    }
  });

  it("asks a question for every money field even though the read was confident", () => {
    const out = extractToProposal({ ocr: receipt(), classification: classifyDocument({ ocr: receipt() }) });
    const asked = out.questions.map(q => q.fieldKey);
    for (const k of ["total", "subtotal", "salesTaxAmount", "transactionDate"]) {
      expect(asked, k).toContain(k);
    }
    expect(out.questions.find(q => q.fieldKey === "total")!.reason).toBe("sensitive_human_only");
  });

  it("asks nothing about a confident vendor name", () => {
    const out = extractToProposal({ ocr: receipt(), classification: classifyDocument({ ocr: receipt() }) });
    expect(out.questions.map(q => q.fieldKey)).not.toContain("vendorName");
    expect(out.counts.autoFiled).toBeGreaterThanOrEqual(1);
  });

  it("asks only what is missing — an optional absent field gets a lower priority than a required one", () => {
    const out = extractToProposal({ ocr: receipt(), classification: classifyDocument({ ocr: receipt() }) });
    const cat = out.questions.find(q => q.fieldKey === "categoryKey")!;
    const total = out.questions.find(q => q.fieldKey === "total")!;
    expect(cat.reason).toBe("low_confidence");
    expect(cat.options).toContain("fuel");
    expect(total.priority).toBeGreaterThan(cat.priority);
  });

  it("puts the document-type question first when classification is ambiguous", () => {
    const amb = classifyDocument({ ocr: receipt({ rawText: "lorem ipsum" }) });
    const out = extractToProposal({
      ocr: receipt(),
      classification: { ...amb, documentType: "expense_receipt" },
    });
    expect(out.questions[0].fieldKey).toBe("__documentType");
    expect(out.questions[0].reason).toBe("ambiguous_classification");
  });

  it("refuses to extract a document no form accepts", () => {
    // v20.16 gave scale and disposal tickets a form. These three still have
    // none, and must be filed as evidence rather than extracted into fields
    // that would have nowhere to commit.
    for (const documentType of ["invoice", "safety_document", "load_ticket"] as const) {
      const out = extractToProposal({
        ocr: receipt(),
        classification: { documentType, confidence: 95, source: "keyword", ambiguous: false, reasons: [] },
      });
      expect(out.refusal, documentType).toContain("file it as evidence, do not extract");
      expect(out.fields, documentType).toEqual([]);
    }
  });

  it("no longer refuses a scale ticket — it has a form now", () => {
    const out = extractToProposal({
      ocr: receipt(),
      classification: { documentType: "scale_ticket", confidence: 95, source: "keyword", ambiguous: false, reasons: [] },
    });
    expect(out.refusal).toBeUndefined();
    expect(out.formKey).toBe("disposal_ticket");
  });

  it("keeps the region text so a person can check the read", () => {
    const out = extractToProposal({ ocr: receipt(), classification: classifyDocument({ ocr: receipt() }) });
    expect(out.fields.find(f => f.key === "total")!.sourceUtterance).toBe("TOTAL 546.00");
  });
});

describe("merchant memory earns confidence from confirmations, not sightings", () => {
  it("is zero with no confirmations however often the vendor appears", () => {
    expect(merchantMemoryConfidence({ vendorNormalized: "x", documentType: "fuel_receipt", seenCount: 40, confirmedCount: 0 })).toBe(0);
  });

  it("grows with confirmed filings and caps", () => {
    const a = merchantMemoryConfidence({ vendorNormalized: "x", documentType: "fuel_receipt", seenCount: 2, confirmedCount: 2 });
    const b = merchantMemoryConfidence({ vendorNormalized: "x", documentType: "fuel_receipt", seenCount: 10, confirmedCount: 10 });
    expect(b).toBeGreaterThan(a);
    expect(b).toBe(100);
  });

  it("normalizes vendor names so punctuation and case do not fork the memory", () => {
    expect(normalizeVendor("FUEL-STOP #12")).toBe(normalizeVendor("fuel stop 12"));
  });
});

/* ------------------------------------------------------------------ */

const ctx = (over: Partial<AssistantCommitContext> = {}): AssistantCommitContext => ({
  proposalId: "p-1",
  formKey: "expense_receipt",
  targetRef: "ENT-1",
  targetRecordId: 7,
  actorUserId: 42,
  capturedAt: new Date("2026-09-08T18:00:00Z"),
  ...over,
});

const committed = (over: Record<string, string | number | boolean | null> = {}): CommittedField[] => {
  const base: Record<string, string | number | boolean | null> = {
    vendorName: "Fuel Stop #12",
    transactionDate: "2026-09-08",
    total: 546,
    subtotal: 520,
    salesTaxAmount: 26,
    currency: "CAD",
    ...over,
  };
  return Object.entries(base).map(([key, value]) => ({
    key, value, precision: "exact", source: "human_corrected", confidence: "high", status: "confirmed",
  })) as CommittedField[];
};

describe("the receipt adapter", () => {
  it("plans an expense draft, and only a draft", () => {
    const plan = planAssistantCommit(ctx(), committed());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.intent.kind).toBe("expense_draft_create");
    expect(plan.intent.requiredPermission).toBe("tax.expense.create");
    if (plan.intent.kind !== "expense_draft_create") return;
    expect(plan.intent.values.status).toBe("draft");
    // No treatment anywhere in the values. A receipt is not a deduction.
    expect(Object.keys(plan.intent.values)).not.toContain("treatment");
    expect(Object.keys(plan.intent.values)).not.toContain("taxTreatment");
  });

  it("refuses when the financial entity was not resolved by the server", () => {
    const plan = planAssistantCommit(ctx({ targetRecordId: null }), committed());
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusals.join(" ")).toContain("resolved by the server");
  });

  it("refuses a date that is not a calendar date", () => {
    // "10:15" is a time. "Sept 8" is ambiguous. Only ISO YYYY-MM-DD goes in.
    for (const bad of ["10:15", "Sept 8", "08/09/2026", "2026-9-8"]) {
      const plan = planAssistantCommit(ctx(), committed({ transactionDate: bad }));
      expect(plan.ok, bad).toBe(false);
    }
  });

  it("refuses three numbers that disagree with each other", () => {
    // subtotal + tax must equal total. A mismatch is a misread, not rounding.
    const plan = planAssistantCommit(ctx(), committed({ subtotal: 500 }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusals.join(" ")).toContain("does not equal total");
  });

  it("tolerates a one-cent rounding difference", () => {
    const plan = planAssistantCommit(ctx(), committed({ subtotal: 519.99, salesTaxAmount: 26.0 }));
    expect(plan.ok).toBe(true);
  });

  it("refuses a business-use percentage outside 0–100 and a non-positive total", () => {
    expect(planAssistantCommit(ctx(), committed({ businessUsePercent: 120 })).ok).toBe(false);
    expect(planAssistantCommit(ctx(), committed({ total: 0, subtotal: 0, salesTaxAmount: 0 })).ok).toBe(false);
  });

  it("records which fields came through OCR and a human", () => {
    const plan = planAssistantCommit(ctx(), committed());
    if (!plan.ok || plan.intent.kind !== "expense_draft_create") throw new Error("expected plan");
    expect(plan.intent.ocrConfirmedFields).toContain("total");
  });
});
