import { combineForConsumer, type CapabilityResult, type CombinedVerdict } from "./interEngineStatus";
import { BILLING_CAPABILITY, billingContractFor } from "./readinessCapabilities";
/**
 * Billing readiness.
 *
 * The rule this file exists to enforce: a charge may only be generated from
 * operational data that a human has verified. GPS distance, AI-extracted
 * quantities and OCR'd tickets are all *proposals* until confirmed — an
 * inference must never become an invoice line on its own.
 *
 * Output is always the specific missing items, never "incomplete". Office
 * staff need to know which phone call to make.
 */

export type BillingState =
  | "draft"
  | "operations_complete"
  | "documents_complete"
  | "disposal_verified"
  | "logs_complete"
  | "billing_review"
  | "approved"
  | "invoiced"
  | "disputed"
  | "closed";

export type BillingReadinessInput = {
  tripsTotal: number;
  tripsComplete: number;
  loadsTotal: number;
  loadTicketsPresent: number;
  disposalTicketsVerified: number;
  disposalTicketsRequired: number;
  /** Distance/time values still awaiting driver or office confirmation. */
  unconfirmedValues: number;
  dailyLogsComplete: boolean;
  /**
   * Ticket-level outcome: the signature status `recordSignature` recorded at signing,
   * never recomputed from per-line dispositions (those are `disputedLineCount`).
   */
  fieldTicketStatus:
    | "accepted"
    | "partially_accepted"
    | "refused"
    | "no_representative"
    | "presented"
    | "unsigned"
    | "missing";
  /** Lines the customer representative disputed. Never silently dropped. */
  disputedLineCount?: number;
  /**
   * From this customer's contract terms (0161): may accepted lines bill while others are disputed?
   * `undefined` means nobody recorded it — which readiness treats as unrecorded, not as yes.
   */
  partialAcceptanceBillable?: boolean | null;
  /** Oilfield AP rejects invoices with no cost coding. */
  afeOrPoPresent: boolean;
  rateCardAssigned: boolean;
  customerSignatureRequired: boolean;
  amendmentsAfterSignature: number;
};

export type Blocker = {
  code: string;
  label: string;
  severity: "blocking" | "review";
};

export type BillingReadiness = {
  state: BillingState;
  blockers: Blocker[];
  billable: boolean;
  completionPercent: number;
  /**
   * P8.1 — the capability picture behind this answer, including capabilities that were never
   * evaluated. Billing does not require live hours because dispatch did: an operational capability
   * irrelevant to the billed evidence travels here as NOT_EVALUATED and does **not** hold the
   * invoice. It is carried rather than dropped so the invoice can still say what was not checked
   * against the work it bills.
   */
  capabilities: CapabilityResult[];
  capabilityVerdict: CombinedVerdict;
};

export function evaluateBillingReadiness(
  input: BillingReadinessInput,
  /**
   * Operational capabilities the caller knows were not evaluated — a disabled module, an
   * unlicensed one, or one irrelevant to this invoice. Optional: a caller that passes none gets
   * exactly the behaviour it had before, which is what keeps this additive.
   */
  unevaluated: readonly CapabilityResult[] = [],
): BillingReadiness {
  const blockers: Blocker[] = [];

  if (input.tripsTotal === 0) {
    blockers.push({
      code: "no_trips",
      label: "No trips recorded on this job",
      severity: "blocking",
    });
  } else if (input.tripsComplete < input.tripsTotal) {
    blockers.push({
      code: "trips_open",
      label: `${input.tripsTotal - input.tripsComplete} trip(s) not marked complete`,
      severity: "blocking",
    });
  }

  const missingLoadTickets = input.loadsTotal - input.loadTicketsPresent;
  if (missingLoadTickets > 0) {
    blockers.push({
      code: "load_tickets_missing",
      label: `${missingLoadTickets} load ticket(s) missing`,
      severity: "blocking",
    });
  }

  const missingDisposal =
    input.disposalTicketsRequired - input.disposalTicketsVerified;
  if (missingDisposal > 0) {
    blockers.push({
      code: "disposal_unverified",
      label: `${missingDisposal} disposal ticket(s) not verified`,
      severity: "blocking",
    });
  }

  if (input.unconfirmedValues > 0) {
    blockers.push({
      code: "unconfirmed_values",
      label: `${input.unconfirmedValues} value(s) still unconfirmed — cannot bill from an inference`,
      severity: "blocking",
    });
  }

  if (!input.dailyLogsComplete) {
    blockers.push({
      code: "logs_incomplete",
      label: "Driver logs incomplete",
      severity: "blocking",
    });
  }

  if (!input.rateCardAssigned) {
    blockers.push({
      code: "no_rate_card",
      label: "No rate card assigned to this job",
      severity: "blocking",
    });
  }

  if (!input.afeOrPoPresent) {
    blockers.push({
      code: "no_cost_coding",
      label: "No AFE, cost centre or PO — the customer's AP will reject this",
      severity: "blocking",
    });
  }

  if (input.customerSignatureRequired) {
    const s = input.fieldTicketStatus;
    if (s === "missing" || s === "unsigned") {
      blockers.push({
        code: "field_ticket_unsigned",
        label: "Field ticket not presented for signature",
        severity: "blocking",
      });
    } else if (s === "presented") {
      blockers.push({
        code: "field_ticket_pending",
        label: "Field ticket presented but not yet signed",
        severity: "blocking",
      });
    } else if (s === "refused") {
      // Billable, but somebody senior needs to decide how to proceed. A
      // refusal is a commercial problem for a human, not a reason for the
      // software to freeze the invoice.
      blockers.push({
        code: "field_ticket_refused",
        label:
          "Customer representative refused to sign — review before invoicing",
        severity: "review",
      });
    } else if (s === "partially_accepted") {
      /*
       * 0161 (P3.2) — whether the accepted lines may bill while others are disputed is the
       * customer's contract to decide. This engine used to answer "accepted lines may still be
       * billed" for every customer on every ticket. Some contracts work that way; others require
       * the whole ticket accepted before any of it invoices, and billing part of a disputed ticket
       * against one of those is a dispute generator and arguably a breach.
       *
       * `undefined`/`null` is not permission. It means nobody recorded what this contract says,
       * which is a different fact from "the contract allows it" — and only one of them is a reason
       * to send an invoice.
       */
      const n = input.disputedLineCount ?? 0;
      const permitted = input.partialAcceptanceBillable;
      blockers.push({
        code: "lines_disputed",
        label:
          permitted === true
            ? (n > 0
                ? `${n} line(s) disputed by the customer — this customer's terms permit billing the accepted lines`
                : "Ticket partially accepted — review disputed lines")
            : permitted === false
              ? `${n || "Some"} line(s) disputed — this customer's terms require the whole ticket accepted before any of it bills`
              : `${n || "Some"} line(s) disputed — nobody has recorded whether this customer's terms allow billing the accepted lines; record the term before invoicing`,
        severity: "review",
      });
    } else if (s === "no_representative") {
      blockers.push({
        code: "no_rep_onsite",
        label: "No customer representative on site — needs office follow-up",
        severity: "review",
      });
    }
  }

  if (input.amendmentsAfterSignature > 0) {
    blockers.push({
      code: "amended_after_signature",
      label: `${input.amendmentsAfterSignature} change(s) made after the ticket was signed — re-confirm with the customer`,
      severity: "review",
    });
  }

  const hasBlocking = blockers.some(b => b.severity === "blocking");
  const state: BillingState = hasBlocking
    ? deriveIncompleteState(input)
    : blockers.length > 0
      ? "billing_review"
      : "approved";

  // Progress across the seven gates office staff actually watch.
  const gates = [
    input.tripsTotal > 0 && input.tripsComplete === input.tripsTotal,
    missingLoadTickets <= 0,
    missingDisposal <= 0,
    input.unconfirmedValues === 0,
    input.dailyLogsComplete,
    input.rateCardAssigned && input.afeOrPoPresent,
    !input.customerSignatureRequired || input.fieldTicketStatus === "accepted",
  ];
  const completionPercent = Math.round(
    (gates.filter(Boolean).length / gates.length) * 100
  );

  /*
   * P8.1: billing's own requirements, not dispatch's. The evidence capabilities are derived from
   * the blockers this function already raised; anything the caller reports as unevaluated is
   * carried as-is. `combineForConsumer` will not let an unevaluated *required* capability leave a
   * PASS standing, and will not let an unevaluated *irrelevant* one change the verdict at all.
   */
  const contract = billingContractFor({ lineNeedsSupportingEvidence: input.disposalTicketsRequired > 0 });
  const evidence: CapabilityResult[] = [
    { capability: BILLING_CAPABILITY.fieldTicket, status: blockers.some(b => /ticket|trip/i.test(b.code) && b.severity === "blocking") ? "BLOCKED" : blockers.some(b => /ticket|trip/i.test(b.code)) ? "REVIEW" : "PASS" },
    { capability: BILLING_CAPABILITY.acceptedLines, status: blockers.some(b => /line|accept/i.test(b.code)) ? "REVIEW" : "PASS" },
    { capability: BILLING_CAPABILITY.customerAcceptance, status: blockers.some(b => /signature|accept|dispute/i.test(b.code) && b.severity === "blocking") ? "BLOCKED" : blockers.some(b => /signature|accept|dispute/i.test(b.code)) ? "REVIEW" : "PASS" },
    { capability: BILLING_CAPABILITY.signatureIntegrity, status: blockers.some(b => /amend|integrity|hash/i.test(b.code)) ? "REVIEW" : "PASS" },
    { capability: BILLING_CAPABILITY.chargeEvidence, status: input.unconfirmedValues > 0 ? "REVIEW" : "PASS" },
    ...(input.disposalTicketsRequired > 0
      ? [{ capability: BILLING_CAPABILITY.supportingEvidence, status: (input.disposalTicketsVerified < input.disposalTicketsRequired ? "BLOCKED" : "PASS") as CapabilityResult["status"] }]
      : []),
  ];
  const capabilities = [...evidence, ...unevaluated];
  const capabilityVerdict = combineForConsumer(contract, capabilities);

  return { state, blockers, billable: !hasBlocking, completionPercent, capabilities, capabilityVerdict };
}

function deriveIncompleteState(input: BillingReadinessInput): BillingState {
  if (input.tripsTotal === 0 || input.tripsComplete < input.tripsTotal)
    return "draft";
  if (input.loadTicketsPresent < input.loadsTotal) return "operations_complete";
  if (input.disposalTicketsVerified < input.disposalTicketsRequired)
    return "documents_complete";
  if (!input.dailyLogsComplete) return "disposal_verified";
  return "logs_complete";
}

/* ------------------------------------------------------------------ */

export type ChargeLineSource = {
  description: string;
  quantity: number;
  unit: string;
  rateCents: number;
  /** The tracking number or event this line is derived from. */
  derivedFrom: string;
  verified: boolean;
};

export type CalculatedLine = ChargeLineSource & {
  amountCents: number;
  math: string;
};

/**
 * Build invoice lines and show the arithmetic. Never render a bare total —
 * a wait-time charge is only defensible if the customer can see it came from
 * a timestamped, verified event.
 *
 * Unverified sources are excluded rather than silently included.
 */
export function calculateChargeLines(sources: ChargeLineSource[]): {
  lines: CalculatedLine[];
  excluded: ChargeLineSource[];
  subtotalCents: number;
} {
  const excluded = sources.filter(s => !s.verified);
  const lines = sources
    .filter(s => s.verified)
    .map(s => ({
      ...s,
      amountCents: Math.round(s.quantity * s.rateCents),
      math: `${s.quantity} ${s.unit} × ${(s.rateCents / 100).toFixed(2)} = ${((s.quantity * s.rateCents) / 100).toFixed(2)}`,
    }));
  const subtotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  return { lines, excluded, subtotalCents };
}
