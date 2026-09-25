/**
 * Field ticket rules.
 *
 * A field ticket is a billable SERVICE EVENT, not a job or a trip. Scope
 * decides what one ticket covers, so a customer who signs once per site visit
 * and a customer who signs for every load are the same table.
 *
 * This module holds facts and dispositions only. It computes no money —
 * "45 minutes standby" is a fact recorded here; whether it becomes a charge
 * is the rate engine's decision in billing.ts. Keeping those apart is what
 * stops field evidence and accounting logic from contaminating each other.
 */

export type FieldTicketScope = "job" | "trip" | "load" | "service_event";
export type LineDisposition = "not_presented" | "accepted" | "disputed";
export type SignatureResult =
  | "accepted"
  | "partially_accepted"
  | "refused"
  | "no_representative";
export type SignatureStatus = "unsigned" | SignatureResult;

export type FieldTicketRefs = {
  scope: FieldTicketScope;
  jobId: number | null | undefined;
  tripId?: number | null;
  loadId?: number | null;
};

export type ScopeViolation = { field: string; message: string };

/**
 * Scope determines which foreign keys are required and which must be absent.
 * A load-scoped ticket without a trip is a data error, not a preference.
 */
export function validateFieldTicketScope(
  refs: FieldTicketRefs
): ScopeViolation[] {
  const errors: ScopeViolation[] = [];
  const { scope, tripId, loadId } = refs;

  if (!refs.jobId) {
    errors.push({
      field: "jobId",
      message: "Every field ticket belongs to a job",
    });
  }

  if (scope === "job") {
    if (tripId)
      errors.push({
        field: "tripId",
        message: "A job-scoped ticket must not name a trip",
      });
    if (loadId)
      errors.push({
        field: "loadId",
        message: "A job-scoped ticket must not name a load",
      });
  }

  if (scope === "trip") {
    if (!tripId)
      errors.push({
        field: "tripId",
        message: "A trip-scoped ticket requires a trip",
      });
    if (loadId)
      errors.push({
        field: "loadId",
        message: "A trip-scoped ticket must not name a load",
      });
  }

  if (scope === "load") {
    if (!tripId)
      errors.push({
        field: "tripId",
        message: "A load-scoped ticket requires a trip",
      });
    if (!loadId)
      errors.push({
        field: "loadId",
        message: "A load-scoped ticket requires a load",
      });
  }

  // service_event intentionally permits any combination — standby, washout or
  // a callout may or may not attach to a specific trip or load.
  return errors;
}

/* ------------------------------------------------------------------ */

export type SignedScopeInput = {
  ticketNumber: string;
  siteName?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  signerName: string;
  signerCompany?: string | null;
  lines: Array<{
    description: string;
    quantity?: number | null;
    quantityUnit?: string | null;
  }>;
};

const hhmm = (d: Date) =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

/**
 * Build the sentence the signer is actually agreeing to. Storing
 * "John Smith signed" proves very little six weeks later; storing what he
 * accepted, where, over what window, and for what quantities is the thing
 * that settles a dispute.
 */
export function buildSignedScopeStatement(input: SignedScopeInput): string {
  const who = input.signerCompany
    ? `${input.signerName} (${input.signerCompany})`
    : input.signerName;
  const where = input.siteName ? ` at ${input.siteName}` : "";

  let when = "";
  if (input.startedAt && input.completedAt) {
    when = ` from ${hhmm(input.startedAt)} to ${hhmm(input.completedAt)}`;
  } else if (input.startedAt) {
    when = ` from ${hhmm(input.startedAt)}`;
  }

  const items = input.lines.map(l => {
    const qty =
      l.quantity != null
        ? `${l.quantity}${l.quantityUnit ? ` ${l.quantityUnit}` : ""} `
        : "";
    return `${qty}${l.description}`.trim();
  });

  const covering = items.length ? `, covering ${items.join("; ")}` : "";
  return `${who} accepted field ticket ${input.ticketNumber} for service${where}${when}${covering}.`;
}

/* ------------------------------------------------------------------ */

/**
 * Derive the ticket's signature status from the per-line dispositions the
 * representative actually gave. Partial acceptance is the common real-world
 * case — "I'll sign the three-hour service but not the standby" — and it must
 * not invalidate the accepted lines.
 */
export function deriveSignatureStatus(
  dispositions: LineDisposition[],
  representativePresent = true
): SignatureStatus {
  if (!representativePresent) return "no_representative";
  if (dispositions.length === 0) return "unsigned";

  const accepted = dispositions.filter(d => d === "accepted").length;
  const disputed = dispositions.filter(d => d === "disputed").length;

  if (disputed === 0 && accepted === dispositions.length) return "accepted";
  if (accepted === 0 && disputed > 0) return "refused";
  if (accepted > 0 && disputed > 0) return "partially_accepted";
  return "unsigned";
}

/* ------------------------------------------------------------------ */

export type ReconciliationInput = {
  trips: number;
  loads: number;
  fieldTickets: number;
  disposalTickets: number;
  manifests: number;
  signatureStatuses: SignatureStatus[];
};

export type ReconciliationResult = {
  counts: Record<string, number>;
  signed: number;
  partiallyAccepted: number;
  refused: number;
  noRepresentative: number;
  unsigned: number;
  billingReady: number;
  reviewRequired: number;
  gaps: string[];
};

/**
 * Job closeout. Office staff need to see immediately what is missing and what
 * needs a decision — counts alone don't tell them where to look.
 */
export function reconcileJob(input: ReconciliationInput): ReconciliationResult {
  const s = input.signatureStatuses;
  const count = (v: SignatureStatus) => s.filter(x => x === v).length;

  const signed = count("accepted");
  const partiallyAccepted = count("partially_accepted");
  const refused = count("refused");
  const noRepresentative = count("no_representative");
  const unsigned = count("unsigned");

  const gaps: string[] = [];
  if (input.fieldTickets < input.loads) {
    gaps.push(
      `${input.loads - input.fieldTickets} load(s) with no field ticket`
    );
  }
  if (input.disposalTickets < input.loads) {
    gaps.push(
      `${input.loads - input.disposalTickets} load(s) with no disposal ticket`
    );
  }
  if (input.manifests < input.loads) {
    gaps.push(`${input.loads - input.manifests} load(s) with no manifest`);
  }
  if (unsigned > 0)
    gaps.push(`${unsigned} ticket(s) never presented for signature`);
  if (noRepresentative > 0)
    gaps.push(`${noRepresentative} ticket(s) had no representative on site`);

  return {
    counts: {
      trips: input.trips,
      loads: input.loads,
      fieldTickets: input.fieldTickets,
      disposalTickets: input.disposalTickets,
      manifests: input.manifests,
    },
    signed,
    partiallyAccepted,
    refused,
    noRepresentative,
    unsigned,
    billingReady: signed,
    reviewRequired: partiallyAccepted + refused + noRepresentative + unsigned,
    gaps,
  };
}
