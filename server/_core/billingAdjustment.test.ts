import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTHORITY_BANDS,
  assessCalloutBilling,
  buildAdjustment,
  canTransitionDispute,
  checkDisputeResolution,
  checkSubcontractLine,
  effectiveInvoiceTotal,
  evaluateAdjustmentAuthority,
  resolveSubcontractedDispute,
  type AdjustmentRequest,
  type CalloutRecord,
  type SubcontractedLine,
} from "./billingAdjustment";

const NOW = new Date(Date.UTC(2026, 8, 5, 10, 0));

const request = (over: Partial<AdjustmentRequest> = {}): AdjustmentRequest => ({
  invoiceNumber: "INV-2026-000391",
  invoiceLineRef: "L3",
  kind: "credit",
  amountCents: 9_375,
  reasonCode: "client_disputed_time",
  narrative: "Client disputes 45 min standby; GPS shows 92 min on site.",
  requestedByUserId: 12,
  requestedByRole: "billing_clerk",
  evidenceRef: "FT-2026-000421",
  requestedAt: NOW,
  ...over,
});

describe("adjustment authority", () => {
  it("lets a clerk make a small, evidenced correction", () => {
    expect(evaluateAdjustmentAuthority(request()).approved).toBe(true);
  });

  it("refuses an amount above the role's ceiling and names who can approve it", () => {
    const d = evaluateAdjustmentAuthority(request({ amountCents: 250_000 }));
    expect(d.approved).toBe(false);
    if (!d.approved) {
      expect(d.refusals[0]).toContain(
        "exceeds the billing_clerk limit of $500.00"
      );
      expect(d.escalateTo).toBe("office_supervisor");
    }
  });

  it("escalates a five-figure write-off past a supervisor", () => {
    const d = evaluateAdjustmentAuthority(
      request({
        amountCents: 1_800_000,
        requestedByRole: "office_supervisor",
        kind: "write_off",
        reasonCode: "goodwill",
        narrative: "Uncollectable after 180 days.",
        evidenceRef: null,
      })
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.escalateTo).toBe("operations_manager");
  });

  it("lets a controller approve without a ceiling", () => {
    const d = evaluateAdjustmentAuthority(
      request({
        amountCents: 9_900_000,
        requestedByRole: "controller",
        reasonCode: "our_error",
        narrative: "Duplicate month-end batch reversed.",
      })
    );
    expect(d.approved).toBe(true);
  });

  it("requires evidence for a disputed-quantity credit at any amount", () => {
    const d = evaluateAdjustmentAuthority(
      request({
        amountCents: 100,
        reasonCode: "client_disputed_quantity",
        evidenceRef: null,
      })
    );
    expect(d.approved).toBe(false);
    if (!d.approved)
      expect(d.refusals.join(" ")).toContain("requires supporting evidence");
  });

  it("always requires a written explanation", () => {
    const d = evaluateAdjustmentAuthority(request({ narrative: "   " }));
    expect(d.approved).toBe(false);
  });

  it('demands a fuller explanation when the reason is "other"', () => {
    const d = evaluateAdjustmentAuthority(
      request({
        reasonCode: "other",
        narrative: "fix",
        evidenceRef: null,
      })
    );
    expect(d.approved).toBe(false);
    if (!d.approved)
      expect(d.refusals.join(" ")).toContain("fuller explanation");
  });

  it("rejects a negative amount — direction comes from the kind", () => {
    expect(
      evaluateAdjustmentAuthority(request({ amountCents: -500 })).approved
    ).toBe(false);
  });
});

describe("adjustments are append-only", () => {
  it("signs a credit negative and a debit positive", () => {
    expect(buildAdjustment(request(), "ADJ-1").signedCents).toBe(-9_375);
    expect(
      buildAdjustment(
        request({ kind: "debit", reasonCode: "missed_charge" }),
        "ADJ-2"
      ).signedCents
    ).toBe(9_375);
  });

  it("treats a reclassification as net zero", () => {
    expect(
      buildAdjustment(request({ kind: "reclassify" }), "ADJ-3").signedCents
    ).toBe(0);
  });

  it("keeps the original invoice total intact however many corrections follow", () => {
    const adjustments = [
      buildAdjustment(request({ amountCents: 9_375 }), "ADJ-1"),
      buildAdjustment(
        request({
          amountCents: 5_000,
          kind: "credit",
          reasonCode: "our_error",
        }),
        "ADJ-2"
      ),
      buildAdjustment(
        request({
          amountCents: 2_000,
          kind: "debit",
          reasonCode: "missed_charge",
        }),
        "ADJ-3"
      ),
    ];
    const t = effectiveInvoiceTotal(195_103, adjustments);
    expect(t.originalCents).toBe(195_103);
    expect(t.adjustmentCents).toBe(-12_375);
    expect(t.effectiveCents).toBe(182_728);
  });

  it("references the original invoice and line rather than replacing them", () => {
    const a = buildAdjustment(request(), "ADJ-9");
    expect(a.invoiceNumber).toBe("INV-2026-000391");
    expect(a.invoiceLineRef).toBe("L3");
    expect(a.createdByRole).toBe("billing_clerk");
    expect(a.evidenceRef).toBe("FT-2026-000421");
  });
});

describe("subcontracted disputes have two sides", () => {
  const line: SubcontractedLine = {
    lineRef: "L7",
    subcontractorId: 4,
    subcontractorName: "Peace River Hydrovac",
    basis: "marked_up",
    costCents: 120_000,
    billedCents: 156_000,
    workVerifiedBy: "D. Reid",
    workVerifiedAt: NOW,
  };

  it("pays the sub in full when the work was performed as instructed", () => {
    const r = resolveSubcontractedDispute(line, 30_000, "our_cost");
    expect(r.payableCents).toBe(0);
    expect(r.marginImpactCents).toBe(30_000);
    expect(r.requiresSubcontractorNotice).toBe(false);
    expect(r.explanation).toContain(
      "performed the work as instructed and is paid in full"
    );
  });

  it("recovers from the sub only where the shortfall is theirs", () => {
    const r = resolveSubcontractedDispute(line, 30_000, "subcontractor_fault");
    expect(r.payableCents).toBe(30_000);
    expect(r.marginImpactCents).toBe(0);
    expect(r.requiresSubcontractorNotice).toBe(true);
  });

  it("splits a shared fault and still notifies the sub", () => {
    const r = resolveSubcontractedDispute(line, 30_000, "shared");
    expect(r.payableCents).toBe(15_000);
    expect(r.marginImpactCents).toBe(15_000);
    expect(r.requiresSubcontractorNotice).toBe(true);
  });

  it("never claws back more than the subcontractor is owed", () => {
    const r = resolveSubcontractedDispute(line, 500_000, "subcontractor_fault");
    expect(r.payableCents).toBe(120_000);
    expect(r.marginImpactCents).toBe(380_000);
  });

  it("treats reducing a payable as a claim requiring notice, not a bookkeeping entry", () => {
    expect(
      resolveSubcontractedDispute(line, 1, "subcontractor_fault")
        .requiresSubcontractorNotice
    ).toBe(true);
    expect(
      resolveSubcontractedDispute(line, 50_000, "our_cost")
        .requiresSubcontractorNotice
    ).toBe(false);
  });
});

describe("checkSubcontractLine", () => {
  const base: SubcontractedLine = {
    lineRef: "L7",
    subcontractorId: 4,
    subcontractorName: "Peace River Hydrovac",
    basis: "pass_through",
    costCents: 120_000,
    billedCents: 120_000,
    workVerifiedBy: "D. Reid",
    workVerifiedAt: NOW,
  };

  it("accepts a clean pass-through", () => {
    expect(checkSubcontractLine(base)).toEqual([]);
  });

  it("catches margin hidden on a pass-through line", () => {
    expect(
      checkSubcontractLine({ ...base, billedCents: 140_000 }).join(" ")
    ).toContain("pass-through must match");
  });

  it("catches a marked-up line billed below cost", () => {
    expect(
      checkSubcontractLine({
        ...base,
        basis: "marked_up",
        billedCents: 100_000,
      }).join(" ")
    ).toContain("below its $1200.00 cost");
  });

  it("flags subcontractor work nobody verified", () => {
    expect(
      checkSubcontractLine({ ...base, workVerifiedBy: null }).join(" ")
    ).toContain("has not been verified");
  });
});

describe("callout authority", () => {
  const callout = (over: Partial<CalloutRecord> = {}): CalloutRecord => ({
    calloutRef: "CO-2026-0141",
    jobId: "JOB-8871",
    receivedAt: NOW,
    callerName: "R. Hollis",
    callerCompany: "Northridge Energy",
    callerPhone: "403-555-0148",
    claimedAuthority: "client_representative",
    authorityVerified: true,
    verifiedBy: "S. Bell",
    verifiedAt: NOW,
    afeNumber: "AFE-8841-22",
    purchaseOrder: null,
    billToParty: "Northridge Energy",
    ...over,
  });

  it("bills a verified client representative callout", () => {
    expect(assessCalloutBilling(callout()).billable).toBe("yes");
  });

  it("holds a third-party operator callout for review rather than billing it", () => {
    const r = assessCalloutBilling(
      callout({
        claimedAuthority: "third_party_operator",
        authorityVerified: false,
        callerCompany: "Bearpaw Drilling",
      })
    );
    expect(r.billable).toBe("review");
    expect(r.blockers.join(" ")).toContain(
      "confirm the client accepts the charge"
    );
  });

  it("refuses to invoice when no payer was ever established", () => {
    const r = assessCalloutBilling(
      callout({ billToParty: null, authorityVerified: false })
    );
    expect(r.billable).toBe("no");
    expect(r.message).toContain(
      "Office follow-up required before this becomes revenue"
    );
  });

  it("blocks on unknown authority — 2am work on nobody's word", () => {
    const r = assessCalloutBilling(
      callout({
        claimedAuthority: "unknown",
        authorityVerified: false,
        billToParty: null,
      })
    );
    expect(r.billable).toBe("no");
    expect(r.blockers.join(" ")).toContain(
      "authority to commit spend was never established"
    );
  });

  it("never blocks emergency work, but never assumes it is payable either", () => {
    const r = assessCalloutBilling(
      callout({
        claimedAuthority: "emergency_services",
        authorityVerified: false,
        afeNumber: null,
      })
    );
    expect(r.billable).toBe("review");
    expect(r.message).toContain("work proceeds regardless");
  });

  it("flags a missing AFE or PO, since the payer's AP will reject it", () => {
    const r = assessCalloutBilling(
      callout({ afeNumber: null, purchaseOrder: null })
    );
    expect(r.billable).toBe("review");
    expect(r.blockers.join(" ")).toContain("accounts payable will reject");
  });

  it("accepts a PO in place of an AFE", () => {
    expect(
      assessCalloutBilling(
        callout({ afeNumber: null, purchaseOrder: "PO-99120" })
      ).billable
    ).toBe("yes");
  });
});

describe("dispute lifecycle", () => {
  it("permits the investigation path", () => {
    expect(canTransitionDispute("raised", "investigating")).toBe(true);
    expect(canTransitionDispute("investigating", "evidence_gathered")).toBe(
      true
    );
    expect(canTransitionDispute("evidence_gathered", "resolved_partial")).toBe(
      true
    );
  });

  it("refuses resolving a dispute before it was investigated", () => {
    expect(canTransitionDispute("raised", "resolved_credited")).toBe(false);
  });

  it("treats a resolved dispute as final", () => {
    expect(canTransitionDispute("resolved_credited", "investigating")).toBe(
      false
    );
  });

  it("requires an adjustment when resolving in the customer's favour", () => {
    const r = checkDisputeResolution({
      status: "resolved_credited",
      adjustment: null,
      requiresEvidence: false,
    });
    expect(r.ok).toBe(false);
    expect(r.refusals[0]).toContain("requires an adjustment record");
  });

  it("requires evidence when upholding a disputed charge", () => {
    const r = checkDisputeResolution({
      status: "resolved_upheld",
      adjustment: null,
      requiresEvidence: true,
    });
    expect(r.ok).toBe(false);
    expect(r.refusals[0]).toContain("requires the evidence that supports it");
  });

  it("accepts a properly evidenced resolution", () => {
    const r = checkDisputeResolution({
      status: "resolved_partial",
      adjustment: buildAdjustment(request(), "ADJ-1"),
      requiresEvidence: false,
    });
    expect(r.ok).toBe(true);
  });
});

describe("authority bands", () => {
  it("ladders from clerk to controller without gaps", () => {
    const ceilings = DEFAULT_AUTHORITY_BANDS.map(b => b.maxCents);
    expect(ceilings).toEqual([50_000, 500_000, 2_500_000, null, null]);
  });
});
