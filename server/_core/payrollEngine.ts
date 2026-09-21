/**
 * Payroll.
 *
 * Three separations this file exists to hold:
 *
 *   HOS time ≠ payroll time ≠ billable customer time. A driver can be on duty
 *   and not driving, paid standby while nothing is billable, or generate
 *   detention billed at one rate and paid at another. These are separate facts
 *   about the same hour and are reconciled, never derived from one another.
 *
 *   A rate is versioned, not overwritten. A March rerun uses the March rate.
 *   Overwriting a wage rate destroys the ability to explain a past payslip.
 *
 *   An employee is not a contractor. An owner-operator does not go through
 *   employee payroll because they drove a truck.
 */

import { classifyMeasurementMethod, MEASUREMENT_AUTHORITY_RANK } from "./measurementQuality";

export type EarningUnit = "hour" | "km" | "load" | "tonne" | "m3" | "percent" | "each";

export type PayRate = {
  rateKey: string;
  version: number;
  earningType: string;
  calculation: "hourly" | "quantity_times_rate" | "percentage" | "flat" | "formula";
  rate: number;
  unit: EarningUnit;
  effectiveFrom: Date;
  effectiveUntil?: Date | null;
  /**
   * For tonne or volume pay: the weakest measurement authority permitted to
   * create a wage. An uncalibrated estimate must not quietly become money.
   */
  minimumMeasurementAuthority?:
    | "authority_certified"
    | "instrument_calibrated"
    | "instrument_measured"
    | "system_derived"
    | null;
};

/**
 * The rate in force on a date. Not the newest rate — the one that applied when
 * the work happened.
 */
export function rateInForce(
  rates: readonly PayRate[],
  earningType: string,
  workedOn: Date
): PayRate | null {
  const eligible = rates.filter(
    r =>
      r.earningType === earningType &&
      workedOn >= r.effectiveFrom &&
      (!r.effectiveUntil || workedOn <= r.effectiveUntil)
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const d = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    return d !== 0 ? d : b.version - a.version;
  });
  return eligible[0];
}

export type EarningSource =
  | "approved_timesheet"
  | "trip"
  | "load"
  | "field_ticket"
  | "safety_meeting"
  | "work_order"
  | "manual_hr_adjustment";

export type EarningProposal = {
  earningType: string;
  source: EarningSource;
  sourceRecordRef?: string | null;
  quantity: number;
  unit: EarningUnit;
  workedOn: Date;
  /** Evidence references. An earning with none is not calculable. */
  evidenceRefs: string[];
  /** For quantity derived from a measurement, e.g. tonnes from a scale. */
  measurementMethod?: string | null;
};

export type EarningCalculation = {
  status: "calculated" | "blocked";
  calculatedAmount?: number;
  rateApplied?: number;
  rateKeyVersion?: string;
  measurementAuthority?: string;
  blockedReason?: string;
  evidenceRefs: string[];
};

/**
 * Calculate one earning.
 *
 * Every dollar points at what produced it: the rate version that applied on the
 * day, and the operational records that evidence the quantity. Four loads at
 * $35 references LOAD-9911 through LOAD-9914 rather than carrying an
 * unexplained $140.
 */
export function calculateEarning(args: {
  proposal: EarningProposal;
  rates: readonly PayRate[];
}): EarningCalculation {
  const p = args.proposal;

  if (p.evidenceRefs.length === 0 && p.source !== "manual_hr_adjustment") {
    return {
      status: "blocked",
      blockedReason:
        "No supporting record — an earning must reference what produced it",
      evidenceRefs: [],
    };
  }

  const rate = rateInForce(args.rates, p.earningType, p.workedOn);
  if (!rate) {
    return {
      status: "blocked",
      blockedReason: `No pay rate in force for ${p.earningType} on ${p.workedOn.toISOString().slice(0, 10)}`,
      evidenceRefs: p.evidenceRefs,
    };
  }

  if (rate.unit !== p.unit) {
    return {
      status: "blocked",
      blockedReason: `Rate is per ${rate.unit} but the quantity is in ${p.unit}`,
      evidenceRefs: p.evidenceRefs,
    };
  }

  // Measurement-quality gate. A tonne rate backed by an estimate does not pay.
  let measurementAuthority: string | undefined;
  if (rate.minimumMeasurementAuthority) {
    const c = classifyMeasurementMethod(p.measurementMethod);
    measurementAuthority = c.authority;
    const required = AUTHORITY_RANK[rate.minimumMeasurementAuthority];
    const actual = AUTHORITY_RANK[c.authority] ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(actual) || actual > required) {
      return {
        status: "blocked",
        measurementAuthority: c.authority,
        blockedReason: `Pay rule requires a ${rate.minimumMeasurementAuthority} measurement; this quantity is ${c.recognized ? c.authority : "from an unrecognized source"}`,
        evidenceRefs: p.evidenceRefs,
      };
    }
  }

  if (p.quantity < 0) {
    return {
      status: "blocked",
      blockedReason: "Negative quantity — record a payroll adjustment instead",
      evidenceRefs: p.evidenceRefs,
    };
  }

  const amount =
    rate.calculation === "flat"
      ? rate.rate
      : round2(p.quantity * rate.rate);

  return {
    status: "calculated",
    calculatedAmount: amount,
    rateApplied: rate.rate,
    rateKeyVersion: `${rate.rateKey}-v${rate.version}`,
    measurementAuthority,
    evidenceRefs: p.evidenceRefs,
  };
}

const AUTHORITY_RANK: Record<string, number> = MEASUREMENT_AUTHORITY_RANK;

/* ------------------------------------------------------------------ */
/* Clock reconciliation                                                 */
/* ------------------------------------------------------------------ */

export type ClockReading = {
  employeeSubmittedMinutes?: number | null;
  hosOnDutyMinutes?: number | null;
  leaseosActivityMinutes?: number | null;
};

export type ReconciliationOutcome = "match" | "within_tolerance" | "review" | "unresolved";

export type ClockReconciliation = {
  outcome: ReconciliationOutcome;
  varianceMinutes: number | null;
  /** What each clock said. None of them is overwritten. */
  readings: ClockReading;
  note: string;
  /** True when this belongs on the payroll exception list. */
  isException: boolean;
};

/**
 * Compare the clocks. The employee's submitted time is never silently changed
 * to match a system figure — a discrepancy becomes a payroll exception for a
 * human, which is the whole point of keeping the clocks separate.
 */
export function reconcileClocks(args: {
  readings: ClockReading;
  toleranceMinutes?: number;
}): ClockReconciliation {
  const tol = args.toleranceMinutes ?? 15;
  const values = [
    args.readings.employeeSubmittedMinutes,
    args.readings.hosOnDutyMinutes,
    args.readings.leaseosActivityMinutes,
  ].filter((v): v is number => typeof v === "number");

  if (values.length === 0) {
    return {
      outcome: "unresolved",
      varianceMinutes: null,
      readings: args.readings,
      note: "No clock reported time for this day",
      isException: true,
    };
  }

  if (values.length === 1) {
    return {
      outcome: "review",
      varianceMinutes: 0,
      readings: args.readings,
      note: "Only one clock reported — nothing to corroborate against",
      isException: true,
    };
  }

  const variance = Math.max(...values) - Math.min(...values);

  if (variance === 0) {
    return {
      outcome: "match",
      varianceMinutes: 0,
      readings: args.readings,
      note: "All reporting clocks agree",
      isException: false,
    };
  }
  if (variance <= tol) {
    return {
      outcome: "within_tolerance",
      varianceMinutes: variance,
      readings: args.readings,
      note: `Clocks differ by ${variance} min, within the ${tol} min tolerance`,
      isException: false,
    };
  }
  return {
    outcome: "review",
    varianceMinutes: variance,
    readings: args.readings,
    note: `Clocks differ by ${variance} min — employee time stands until reviewed`,
    isException: true,
  };
}

/**
 * A payroll activity change does not touch HOS duty status.
 *
 * The two are recorded by different systems for different purposes, and one of
 * them may be certified. Writing a duty status as a side effect of someone
 * tapping "standby" on a pay screen would corrupt a compliance record.
 */
export function payrollActivityAffectsHos(): false {
  return false;
}

/* ------------------------------------------------------------------ */
/* Pay run lifecycle                                                    */
/* ------------------------------------------------------------------ */

export type PayRunState =
  | "draft" | "collecting" | "review" | "approved"
  | "processing" | "paid" | "closed" | "amended";

const PAY_RUN_TRANSITIONS: Record<PayRunState, PayRunState[]> = {
  draft: ["collecting"],
  collecting: ["review", "draft"],
  review: ["approved", "collecting"],
  approved: ["processing", "review"],
  processing: ["paid"],
  // Paid payroll is never edited in place. It can only be amended, which
  // creates a correcting record rather than changing the original.
  paid: ["closed", "amended"],
  closed: ["amended"],
  amended: ["closed"],
};

export function canTransitionPayRun(from: PayRunState, to: PayRunState): boolean {
  return PAY_RUN_TRANSITIONS[from].includes(to);
}

export function payRunIsEditable(state: PayRunState): boolean {
  return state === "draft" || state === "collecting" || state === "review";
}

export type CorrectionRoute = "edit_in_place" | "adjustment_required";

export function correctionRouteFor(state: PayRunState): CorrectionRoute {
  return payRunIsEditable(state) ? "edit_in_place" : "adjustment_required";
}

/* ------------------------------------------------------------------ */
/* Worker classification                                                */
/* ------------------------------------------------------------------ */

export type WorkerKind = "employee" | "contractor";

export type ClassificationRefusal = {
  allowed: boolean;
  reason?: string;
};

/**
 * Refuse to run a contractor through employee payroll.
 *
 * This is a hard boundary rather than a warning because the consequences land
 * on remittances, information returns and the worker's own filing — and
 * because the mistake is easy to make when both people drove the same truck.
 */
export function assertPayrollEligibility(worker: {
  kind: WorkerKind;
  entityRef?: string | null;
}): ClassificationRefusal {
  if (worker.kind === "contractor") {
    return {
      allowed: false,
      reason:
        "This worker is a contractor — settle through contractor settlement, not employee payroll",
    };
  }
  return { allowed: true };
}

export function assertSettlementEligibility(worker: {
  kind: WorkerKind;
}): ClassificationRefusal {
  if (worker.kind === "employee") {
    return {
      allowed: false,
      reason:
        "This worker is an employee — pay through payroll, not contractor settlement",
    };
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------ */
/* Revenue-percentage pay                                               */
/* ------------------------------------------------------------------ */

export type RevenueBasis = {
  grossInvoiceAmount: number;
  excluded: Array<{ label: string; amount: number }>;
};

export type EligibleRevenue = {
  eligibleAmount: number;
  excludedTotal: number;
  breakdown: Array<{ label: string; amount: number }>;
  note: string;
};

/**
 * Percentage pay applies to eligible revenue as defined by the employment
 * agreement — not to the invoice total. Tax, customer reimbursements and
 * third-party pass-through charges are commonly excluded, and percentaging the
 * final invoice quietly overpays or underpays depending on the job mix.
 */
export function eligibleRevenueFor(basis: RevenueBasis): EligibleRevenue {
  const excludedTotal = round2(
    basis.excluded.reduce((s, e) => s + e.amount, 0)
  );
  return {
    eligibleAmount: round2(basis.grossInvoiceAmount - excludedTotal),
    excludedTotal,
    breakdown: basis.excluded,
    note: "Eligible revenue per the employment agreement, not the invoice total",
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
