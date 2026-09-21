/**
 * Billing adjustments, disputes and third-party work.
 *
 * Three rules this file exists to enforce.
 *
 * 1. AN ADJUSTMENT IS A NEW RECORD, NEVER AN EDIT.
 *    A finalised invoice and its hashed snapshot are immutable. Office staff
 *    correct billing by issuing a credit or debit that references the
 *    original — so "what did we originally charge, and what did we change
 *    after?" always has two separate answers.
 *
 * 2. THE CLIENT SIDE AND THE PAYABLE SIDE ARE SEPARATE DECISIONS.
 *    Crediting a customer for subcontracted work does not mean short-paying
 *    the subcontractor who performed it. Deciding it does — silently — is how
 *    a company either eats margin it did not need to, or stiffs a sub who did
 *    the work correctly.
 *
 * 3. AUTHORITY IS BANDED AND UNKNOWN IS NOT AUTHORISED.
 *    A clerk cannot write off five figures. A callout accepted on the word of
 *    someone whose authority was never verified is held for review — not
 *    silently billed, and not silently dropped.
 */

/* ===================== adjustment authority ===================== */

export type AdjustmentRole =
  | "billing_clerk"
  | "office_supervisor"
  | "operations_manager"
  | "controller"
  | "administrator";

export type AdjustmentBand = {
  role: AdjustmentRole;
  /** Inclusive ceiling in cents. Null means no ceiling. */
  maxCents: number | null;
};

/** Default ladder. Per-tenant overrides live in billingAuthorityBands. */
export const DEFAULT_AUTHORITY_BANDS: AdjustmentBand[] = [
  { role: "billing_clerk", maxCents: 50_000 }, // $500
  { role: "office_supervisor", maxCents: 500_000 }, // $5,000
  { role: "operations_manager", maxCents: 2_500_000 }, // $25,000
  { role: "controller", maxCents: null },
  { role: "administrator", maxCents: null },
];

export type AdjustmentKind =
  | "credit" // reduce what the customer owes
  | "debit" // increase it — rebill, missed charge
  | "write_off" // abandon collection
  | "reclassify" // move an amount between codes, net zero
  | "rate_correction"; // wrong rate applied originally

export type AdjustmentRequest = {
  invoiceNumber: string;
  invoiceLineRef?: string | null;
  kind: AdjustmentKind;
  /** Always positive. `kind` carries the direction. */
  amountCents: number;
  reasonCode: AdjustmentReason;
  narrative: string;
  requestedByUserId: number;
  requestedByRole: AdjustmentRole;
  /** Ticket, photo, call log or email that supports the change. */
  evidenceRef?: string | null;
  requestedAt: Date;
};

export type AdjustmentReason =
  | "client_disputed_quantity"
  | "client_disputed_time"
  | "client_disputed_rate"
  | "unauthorised_callout"
  | "duplicate_charge"
  | "service_not_performed"
  | "our_error"
  | "goodwill"
  | "subcontractor_shortfall"
  | "rework_at_our_cost"
  | "missed_charge"
  | "rate_card_correction"
  | "other";

/** Reasons that always need supporting evidence, whatever the amount. */
const EVIDENCE_REQUIRED: AdjustmentReason[] = [
  "client_disputed_quantity",
  "client_disputed_time",
  "client_disputed_rate",
  "unauthorised_callout",
  "service_not_performed",
  "subcontractor_shortfall",
];

export type AuthorityDecision =
  | { approved: true; approvedByRole: AdjustmentRole; note: string }
  | { approved: false; refusals: string[]; escalateTo: AdjustmentRole | null };

/**
 * Whether this person may make this change. Refusals are specific, and a
 * refusal for amount names who *can* approve it — an office clerk hitting a
 * ceiling needs to know where to send it, not just that they were declined.
 */
export function evaluateAdjustmentAuthority(
  request: AdjustmentRequest,
  bands: AdjustmentBand[] = DEFAULT_AUTHORITY_BANDS
): AuthorityDecision {
  const refusals: string[] = [];

  if (request.amountCents <= 0) {
    refusals.push(
      "Adjustment amount must be positive — direction comes from the kind"
    );
  }
  if (!request.narrative?.trim()) {
    refusals.push("A written explanation is required");
  }
  if (EVIDENCE_REQUIRED.includes(request.reasonCode) && !request.evidenceRef) {
    refusals.push(
      `Reason "${request.reasonCode}" requires supporting evidence`
    );
  }
  if (request.reasonCode === "other" && request.narrative.trim().length < 20) {
    refusals.push('Reason "other" needs a fuller explanation');
  }

  const band = bands.find(b => b.role === request.requestedByRole);
  if (!band) {
    refusals.push(`${request.requestedByRole} has no adjustment authority`);
  } else if (band.maxCents !== null && request.amountCents > band.maxCents) {
    const next = bands.find(
      b => b.maxCents === null || b.maxCents >= request.amountCents
    );
    refusals.push(
      `${formatMoney(request.amountCents)} exceeds the ${request.requestedByRole} limit of ${formatMoney(band.maxCents)}`
    );
    return {
      approved: false,
      refusals,
      escalateTo: next?.role ?? "controller",
    };
  }

  if (refusals.length > 0)
    return { approved: false, refusals, escalateTo: null };

  return {
    approved: true,
    approvedByRole: request.requestedByRole,
    note: `${request.kind} of ${formatMoney(request.amountCents)} approved by ${request.requestedByRole}`,
  };
}

export const formatMoney = (cents: number | null): string =>
  cents === null ? "no limit" : `$${(cents / 100).toFixed(2)}`;

/* ===================== the adjustment itself ===================== */

export type Adjustment = {
  adjustmentNumber: string;
  invoiceNumber: string;
  invoiceLineRef: string | null;
  kind: AdjustmentKind;
  amountCents: number;
  /** Signed effect on the receivable. */
  signedCents: number;
  reasonCode: AdjustmentReason;
  narrative: string;
  evidenceRef: string | null;
  createdByUserId: number;
  createdByRole: AdjustmentRole;
  createdAt: Date;
  /** Set only when a matching payable decision was taken. */
  payableAdjustmentNumber?: string | null;
};

const SIGN: Record<AdjustmentKind, -1 | 0 | 1> = {
  credit: -1,
  write_off: -1,
  debit: 1,
  rate_correction: 1,
  reclassify: 0,
};

/**
 * Build the adjustment record. The original invoice is never touched — this
 * is a sibling record that references it.
 */
export function buildAdjustment(
  request: AdjustmentRequest,
  adjustmentNumber: string
): Adjustment {
  const sign = SIGN[request.kind];
  return {
    adjustmentNumber,
    invoiceNumber: request.invoiceNumber,
    invoiceLineRef: request.invoiceLineRef ?? null,
    kind: request.kind,
    amountCents: request.amountCents,
    signedCents: sign * request.amountCents,
    reasonCode: request.reasonCode,
    narrative: request.narrative.trim(),
    evidenceRef: request.evidenceRef ?? null,
    createdByUserId: request.requestedByUserId,
    createdByRole: request.requestedByRole,
    createdAt: request.requestedAt,
    payableAdjustmentNumber: null,
  };
}

/**
 * What the customer now owes. Computed from the original plus every
 * adjustment — never by overwriting a stored total, so the original invoice
 * amount survives however many corrections follow it.
 */
export function effectiveInvoiceTotal(
  originalTotalCents: number,
  adjustments: Adjustment[]
): { originalCents: number; adjustmentCents: number; effectiveCents: number } {
  const adjustmentCents = adjustments.reduce(
    (sum, a) => sum + a.signedCents,
    0
  );
  return {
    originalCents: originalTotalCents,
    adjustmentCents,
    effectiveCents: originalTotalCents + adjustmentCents,
  };
}

/* ===================== third-party work ===================== */

export type SubcontractBasis =
  | "pass_through" // billed to the client at cost
  | "marked_up" // billed at cost plus margin
  | "fixed_resale"; // we quoted a price regardless of what the sub charges

export type SubcontractedLine = {
  lineRef: string;
  subcontractorId: number;
  subcontractorName: string;
  basis: SubcontractBasis;
  /** What the subcontractor invoices us. */
  costCents: number;
  /** What we invoice the client. */
  billedCents: number;
  workVerifiedBy?: string | null;
  workVerifiedAt?: Date | null;
};

export type TwoSidedResolution = {
  /** The credit issued to the customer. */
  clientCents: number;
  /** Reduction to what we pay the subcontractor. Zero means we absorb it. */
  payableCents: number;
  /** What this costs us. Positive means margin lost. */
  marginImpactCents: number;
  requiresSubcontractorNotice: boolean;
  explanation: string;
};

/**
 * Work out both sides of a dispute on subcontracted work.
 *
 * The decision that must never be automatic: whether the subcontractor bears
 * any of it. If they performed the work as instructed and the client simply
 * disputes it, the sub is owed in full and the credit comes out of margin.
 * Only a shortfall attributable to the sub justifies reducing their payable —
 * and that reduction is a claim against them, so they have to be told.
 */
export function resolveSubcontractedDispute(
  line: SubcontractedLine,
  clientCreditCents: number,
  attribution: "our_cost" | "subcontractor_fault" | "shared",
  sharedSubShare = 0.5
): TwoSidedResolution {
  let payableCents = 0;

  if (attribution === "subcontractor_fault") {
    // Never claw back more than we are paying them.
    payableCents = Math.min(clientCreditCents, line.costCents);
  } else if (attribution === "shared") {
    payableCents = Math.min(
      Math.round(clientCreditCents * sharedSubShare),
      line.costCents
    );
  }

  const marginImpactCents = clientCreditCents - payableCents;

  const explanation =
    attribution === "our_cost"
      ? `Client credited ${formatMoney(clientCreditCents)}. ${line.subcontractorName} performed the work as instructed and is paid in full — the credit comes out of margin.`
      : attribution === "subcontractor_fault"
        ? `Client credited ${formatMoney(clientCreditCents)}. ${formatMoney(payableCents)} is recoverable from ${line.subcontractorName} as a shortfall claim; ${formatMoney(marginImpactCents)} is absorbed.`
        : `Client credited ${formatMoney(clientCreditCents)}, shared with ${line.subcontractorName}: ${formatMoney(payableCents)} recovered, ${formatMoney(marginImpactCents)} absorbed.`;

  return {
    clientCents: clientCreditCents,
    payableCents,
    marginImpactCents,
    // Reducing what someone is owed is a claim, not a bookkeeping entry.
    requiresSubcontractorNotice: payableCents > 0,
    explanation,
  };
}

/**
 * A pass-through line billed at cost should not silently carry margin, and a
 * marked-up line should not be billed below cost. Both are quiet errors that
 * only surface at month end.
 */
export function checkSubcontractLine(line: SubcontractedLine): string[] {
  const problems: string[] = [];
  if (line.basis === "pass_through" && line.billedCents !== line.costCents) {
    problems.push(
      `Pass-through line billed ${formatMoney(line.billedCents)} against a cost of ${formatMoney(line.costCents)} — pass-through must match`
    );
  }
  if (line.basis === "marked_up" && line.billedCents < line.costCents) {
    problems.push(
      `Marked-up line billed ${formatMoney(line.billedCents)} below its ${formatMoney(line.costCents)} cost`
    );
  }
  if (!line.workVerifiedBy) {
    problems.push(
      `Subcontractor work on ${line.lineRef} has not been verified by anyone`
    );
  }
  return problems;
}

/* ===================== callout authority ===================== */

export type CalloutAuthority =
  | "client_representative" // the company rep on the AFE
  | "client_office"
  | "third_party_operator" // someone else's crew on site
  | "emergency_services"
  | "unknown";

export type CalloutRecord = {
  calloutRef: string;
  jobId: string | null;
  receivedAt: Date;
  callerName: string | null;
  callerCompany: string | null;
  callerPhone: string | null;
  claimedAuthority: CalloutAuthority;
  /** Confirmed against the client's authorised signatory list. */
  authorityVerified: boolean;
  verifiedBy?: string | null;
  verifiedAt?: Date | null;
  afeNumber: string | null;
  purchaseOrder: string | null;
  /** Which party we will actually invoice. */
  billToParty: string | null;
};

export type CalloutBillingStatus = {
  billable: "yes" | "review" | "no";
  blockers: string[];
  message: string;
};

/**
 * Whether a callout can be invoiced.
 *
 * The revenue leak this exists to stop: a driver does the work at 02:00 on the
 * word of someone from another company on the same lease, and nobody ever
 * establishes who is paying. Left alone, that becomes either an unpaid
 * invoice or work quietly written off.
 *
 * Unverified authority is `review` — a person chases it. It is never billed on
 * an assumption and never dropped on one either.
 */
export function assessCalloutBilling(
  callout: CalloutRecord
): CalloutBillingStatus {
  const blockers: string[] = [];

  if (!callout.callerName) blockers.push("No caller recorded");
  if (!callout.callerCompany) blockers.push("No calling company recorded");
  if (!callout.billToParty) blockers.push("No bill-to party established");
  if (!callout.afeNumber && !callout.purchaseOrder) {
    blockers.push(
      "No AFE or PO — the payer's accounts payable will reject this"
    );
  }

  if (callout.claimedAuthority === "unknown") {
    blockers.push(
      "The caller's authority to commit spend was never established"
    );
  }
  if (!callout.authorityVerified) {
    blockers.push(
      callout.claimedAuthority === "third_party_operator"
        ? "A third-party operator called this out — confirm the client accepts the charge before invoicing"
        : "The caller's authority has not been verified against the client's signatory list"
    );
  }

  // Emergency work gets done first and reconciled after. It is never blocked,
  // but it is never assumed payable either.
  if (callout.claimedAuthority === "emergency_services") {
    return {
      billable: "review",
      blockers,
      message:
        "Emergency callout — work proceeds regardless. Establish the payer before invoicing.",
    };
  }

  if (blockers.length === 0) {
    return {
      billable: "yes",
      blockers,
      message: "Callout is authorised and billable.",
    };
  }

  const hard = blockers.some(
    b => b.includes("bill-to party") || b.includes("never established")
  );
  return {
    billable: hard ? "no" : "review",
    blockers,
    message: hard
      ? "Cannot invoice — no established payer. Office follow-up required before this becomes revenue."
      : "Billable subject to review — the items below need confirming first.",
  };
}

/* ===================== dispute cases ===================== */

export type DisputeStatus =
  | "raised"
  | "investigating"
  | "evidence_gathered"
  | "resolved_upheld"
  | "resolved_credited"
  | "resolved_partial"
  | "escalated"
  | "withdrawn";

const DISPUTE_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  raised: ["investigating", "withdrawn"],
  investigating: ["evidence_gathered", "escalated", "withdrawn"],
  evidence_gathered: [
    "resolved_upheld",
    "resolved_credited",
    "resolved_partial",
    "escalated",
  ],
  escalated: [
    "resolved_upheld",
    "resolved_credited",
    "resolved_partial",
    "withdrawn",
  ],
  resolved_upheld: [],
  resolved_credited: [],
  resolved_partial: [],
  withdrawn: [],
};

export function canTransitionDispute(
  from: DisputeStatus,
  to: DisputeStatus
): boolean {
  return DISPUTE_TRANSITIONS[from]?.includes(to) ?? false;
}

export type DisputeResolution = {
  status: DisputeStatus;
  adjustment: Adjustment | null;
  requiresEvidence: boolean;
};

/**
 * A dispute cannot be resolved in the customer's favour without an adjustment
 * to point at, and cannot be resolved against them without evidence that the
 * charge was correct. Closing one on an opinion is how the same argument
 * recurs three months later with nothing on file.
 */
export function checkDisputeResolution(resolution: DisputeResolution): {
  ok: boolean;
  refusals: string[];
} {
  const refusals: string[] = [];

  if (
    resolution.status === "resolved_credited" ||
    resolution.status === "resolved_partial"
  ) {
    if (!resolution.adjustment) {
      refusals.push(
        "Resolving in the customer's favour requires an adjustment record"
      );
    }
  }
  if (resolution.status === "resolved_upheld" && resolution.requiresEvidence) {
    refusals.push(
      "Upholding a disputed charge requires the evidence that supports it"
    );
  }
  return { ok: refusals.length === 0, refusals };
}
