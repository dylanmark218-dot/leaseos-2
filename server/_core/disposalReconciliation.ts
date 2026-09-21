/**
 * Disposal reconciliation — the gate between operations and money.
 *
 * Answers one question per disposal: is this movement provable? Missing
 * evidence holds the disposal charge only; every other accepted charge on the
 * job still bills. Same partial-hold principle as per-line field ticket
 * acceptance — one gap must never freeze an entire invoice.
 *
 * Requirement-aware by design. Not every facility issues a scale ticket and
 * not every material needs a manifest, so a blanket checklist would generate
 * false exceptions and train office staff to ignore the screen. Each check
 * declares whether it applies before it declares whether it passed.
 */

import { classifyMeasurementMethod } from "./measurementQuality";

export type CheckStatus = "pass" | "missing" | "not_required" | "unverified";

export type DisposalCheck = {
  key: string;
  label: string;
  status: CheckStatus;
  detail?: string;
};

export type DisposalRequirements = {
  facilityIssuesScaleTicket: boolean;
  manifestRequired: boolean;
  facilitySignatureRequired: boolean;
  /** Some facilities record volume, not weight. */
  weightRequired: boolean;
};

export type DisposalRecordInput = {
  ticketNumber?: string | null;
  jobId?: number | null;
  tripId?: number | null;
  loadId?: number | null;
  /** The authenticated user who created the record, not just an operator name. */
  createdByUserId?: number | null;
  operatorId?: number | null;
  facilityId?: number | null;
  material?: string | null;
  quantity?: number | null;
  measurementMethod?: string | null;
  arrivedAt?: Date | null;
  departedAt?: Date | null;
  facilityTicketNumber?: string | null;
  facilityAcknowledgedAt?: Date | null;
  manifestNumber?: string | null;
  billingBookEntryId?: number | null;
  netKg?: number | null;
  verificationStatus?: "unverified" | "needs_review" | "verified" | "rejected";
  requirements: DisposalRequirements;
};

export type DisposalReconciliation = {
  ticketNumber: string | null;
  checks: DisposalCheck[];
  missing: string[];
  complete: boolean;
  /** True when the disposal charge itself cannot be billed yet. */
  disposalChargeHeld: boolean;
  /** Always true — other accepted charges are never held by a disposal gap. */
  otherChargesMayProceed: true;
};

const applicable = (c: DisposalCheck) => c.status !== "not_required";

export function reconcileDisposal(
  input: DisposalRecordInput
): DisposalReconciliation {
  const req = input.requirements;
  const checks: DisposalCheck[] = [];

  const present = (
    key: string,
    label: string,
    value: unknown,
    detail?: string
  ): void => {
    checks.push({
      key,
      label,
      status:
        value === null || value === undefined || value === ""
          ? "missing"
          : "pass",
      detail,
    });
  };

  present("tracking_number", "Disposal tracking number", input.ticketNumber);
  present("job", "Linked to a job", input.jobId);
  present("trip", "Linked to a trip", input.tripId);
  present("load", "Linked to a load", input.loadId);
  present(
    "operator",
    "Authenticated operator",
    input.createdByUserId,
    input.createdByUserId ? undefined : "Record has no authenticated creator"
  );
  present("facility", "Disposal facility", input.facilityId);
  present("material", "Material identified", input.material);
  present("quantity", "Quantity recorded", input.quantity);

  // A quantity without a method is not billable — an estimate and a weighed
  // figure are not the same evidence. Classified against the single ladder in
  // measurementQuality, which fails closed: a method from a vocabulary this
  // trunk does not know is `unknown` and holds the charge. It is not waved
  // through for the sole reason that it isn't the literal string "unknown".
  const measurement = classifyMeasurementMethod(input.measurementMethod);
  checks.push({
    key: "measurement_method",
    label: "Measurement method",
    status: measurement.adequateForCharge ? "pass" : "missing",
    detail: measurement.detail,
  });

  present("arrival", "Arrival time", input.arrivedAt);
  present("departure", "Departure time", input.departedAt);

  checks.push({
    key: "facility_ticket",
    label: "Facility ticket",
    status: !req.facilityIssuesScaleTicket
      ? "not_required"
      : input.facilityTicketNumber
        ? "pass"
        : "missing",
    detail: req.facilityIssuesScaleTicket
      ? undefined
      : "This facility does not issue tickets",
  });

  checks.push({
    key: "net_weight",
    label: "Net weight",
    status: !req.weightRequired
      ? "not_required"
      : input.netKg != null
        ? "pass"
        : "missing",
    detail: req.weightRequired
      ? undefined
      : "Facility records volume, not weight",
  });

  checks.push({
    key: "facility_acknowledgement",
    label: "Facility acknowledgement",
    status: !req.facilitySignatureRequired
      ? "not_required"
      : input.facilityAcknowledgedAt
        ? "pass"
        : "missing",
  });

  checks.push({
    key: "manifest",
    label: "Manifest",
    status: !req.manifestRequired
      ? "not_required"
      : input.manifestNumber
        ? "pass"
        : "missing",
    detail: req.manifestRequired ? undefined : "Not a manifested material",
  });

  present("billing_link", "Billing relationship", input.billingBookEntryId);

  // Verified is a human decision, never an inference from completeness.
  checks.push({
    key: "verified",
    label: "Human verification",
    status: input.verificationStatus === "verified" ? "pass" : "unverified",
    detail:
      input.verificationStatus === "rejected"
        ? "Previously rejected on review"
        : undefined,
  });

  const missing = checks.filter(c => c.status === "missing").map(c => c.label);
  const unverified = checks.filter(c => c.status === "unverified").length > 0;

  return {
    ticketNumber: input.ticketNumber ?? null,
    checks,
    missing,
    complete: missing.length === 0 && !unverified,
    disposalChargeHeld: missing.length > 0 || unverified,
    otherChargesMayProceed: true,
  };
}

/* ------------------------------------------------------------------ */

export type JobDisposalSummary = {
  total: number;
  complete: number;
  requiresReview: number;
  exceptions: Array<{
    ticketNumber: string | null;
    missing: string[];
    effect: string;
  }>;
};

/**
 * Job-level rollup. Names the specific missing item on each exception rather
 * than reporting a count — office staff need to know which phone call to make.
 */
export function summariseJobDisposals(
  reconciliations: DisposalReconciliation[]
): JobDisposalSummary {
  const exceptions = reconciliations
    .filter(r => !r.complete)
    .map(r => ({
      ticketNumber: r.ticketNumber,
      missing: r.missing.length ? r.missing : ["Awaiting human verification"],
      effect: "Disposal charge held; other accepted charges may proceed",
    }));

  return {
    total: reconciliations.length,
    complete: reconciliations.filter(r => r.complete).length,
    requiresReview: exceptions.length,
    exceptions,
  };
}

/**
 * Percentage of applicable checks passing. Excludes not_required so a
 * facility that issues no ticket doesn't sit permanently below 100%.
 */
export function completenessPercent(r: DisposalReconciliation): number {
  const relevant = r.checks.filter(applicable);
  if (relevant.length === 0) return 100;
  const passing = relevant.filter(c => c.status === "pass").length;
  return Math.round((passing / relevant.length) * 100);
}
