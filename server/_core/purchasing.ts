/**
 * Purchasing and Accounts Payable.
 *
 * The rules that turn "someone paid a vendor" into an accounting fact, and
 * the rules that stop it becoming one too early:
 *
 *   The person who requests a purchase does not approve it.
 *   Spending limits are company data, not code.
 *   A bill is matched against what was authorized, what happened, and what
 *   the evidence shows — four ways — and a mismatch is an exception before
 *   payment, not after.
 *   A core charge is open until its credit actually appears.
 *   A vendor's invoice never makes a truck dispatch-ready.
 *   A company expense is never a customer charge without a person saying so.
 *   Cost belongs to the period the service happened in, not the period the
 *   invoice arrived in.
 */

import { closureImpliesRelease, type DefectSeverity } from "./mechanicRelease";

/* ------------------------------------------------------------------ */
/* Spending limits and approval routing                                 */
/* ------------------------------------------------------------------ */

export type SpendingLimit = {
  role: string;
  emergencyPurchaseLimit: number;
  standardPurchaseLimit: number;
  canApproveUpTo: number;
};

export type ApprovalRouting = {
  /** Whether the requester may self-authorize within their own limit. */
  withinRequesterLimit: boolean;
  /** Roles that may approve this amount. Empty means "policy controlled". */
  approverRoles: string[];
  requiresApproval: boolean;
  reason: string;
};

/**
 * Who may approve a purchase of this amount. Limits are rows the company set,
 * looked up by role; nothing here knows what a driver's limit is.
 */
export function routeApproval(args: {
  amount: number;
  emergency: boolean;
  requesterRoles: readonly string[];
  limits: readonly SpendingLimit[];
}): ApprovalRouting {
  if (!(args.amount > 0)) {
    return { withinRequesterLimit: false, approverRoles: [], requiresApproval: true, reason: "Amount must be positive" };
  }
  const own = args.limits.filter(l => args.requesterRoles.includes(l.role));
  const ownLimit = Math.max(0, ...own.map(l => (args.emergency ? l.emergencyPurchaseLimit : l.standardPurchaseLimit)));
  const within = args.amount <= ownLimit;

  const approverRoles = args.limits
    .filter(l => l.canApproveUpTo >= args.amount)
    .map(l => l.role);

  if (within) {
    return {
      withinRequesterLimit: true,
      approverRoles,
      requiresApproval: false,
      reason: `Within the requester's ${args.emergency ? "emergency" : "standard"} limit of ${ownLimit}`,
    };
  }
  return {
    withinRequesterLimit: false,
    approverRoles,
    requiresApproval: true,
    reason: approverRoles.length
      ? `Exceeds the requester's limit of ${ownLimit}; approvable by ${approverRoles.join(", ")}`
      : `Exceeds every configured approval limit — policy-controlled approval required`,
  };
}

export type ApprovalDecision =
  | { ok: true; authorizedMaximum: number }
  | { ok: false; reason: string };

/**
 * Whether this approver may approve this request. Two rules hold regardless
 * of limits: the requester cannot approve their own request, and an approver
 * cannot authorize more than their own approval limit.
 */
export function decideApproval(args: {
  requestedByUserId: number;
  approverUserId: number;
  approverRoles: readonly string[];
  estimatedAmount: number;
  authorizedMaximum: number;
  limits: readonly SpendingLimit[];
}): ApprovalDecision {
  if (args.requestedByUserId === args.approverUserId) {
    return { ok: false, reason: "The person who requested a purchase does not approve it" };
  }
  if (!(args.authorizedMaximum > 0)) {
    return { ok: false, reason: "Authorized maximum must be positive" };
  }
  if (args.authorizedMaximum < args.estimatedAmount) {
    return { ok: false, reason: `Authorized maximum ${args.authorizedMaximum} is below the estimate ${args.estimatedAmount} — approve the estimate or reject it` };
  }
  const cap = Math.max(0, ...args.limits.filter(l => args.approverRoles.includes(l.role)).map(l => l.canApproveUpTo));
  if (args.authorizedMaximum > cap) {
    return { ok: false, reason: `Approver's limit is ${cap}; cannot authorize ${args.authorizedMaximum}` };
  }
  return { ok: true, authorizedMaximum: args.authorizedMaximum };
}

/* ------------------------------------------------------------------ */
/* Bill lines                                                           */
/* ------------------------------------------------------------------ */

export type BillLineType =
  | "part" | "labour" | "service_call" | "freight" | "shop_supplies"
  | "environmental_fee" | "disposal_fee" | "core_charge" | "core_credit"
  | "tire_levy" | "tax" | "warranty_credit" | "discount" | "other";

export type BillLine = {
  lineNo: number;
  lineType: BillLineType;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type LineReconciliation = {
  ok: boolean;
  refusals: string[];
  subtotal: number;
  tax: number;
  total: number;
  /** Core charges on this bill with no matching credit — money the company is owed. */
  openCoreCharges: BillLine[];
};

const CREDIT_TYPES: ReadonlySet<BillLineType> = new Set<BillLineType>(["core_credit", "warranty_credit", "discount"]);

/**
 * The lines must add up, and a credit must be negative. A core charge is
 * reported open unless a core credit on the same bill offsets it — and even
 * then the credit is the vendor's promise; the ledger keeps the charge open
 * until it clears.
 */
export function reconcileBillLines(args: {
  lines: readonly BillLine[];
  statedSubtotal: number;
  statedTax: number;
  statedTotal: number;
}): LineReconciliation {
  const refusals: string[] = [];
  for (const l of args.lines) {
    if (Math.abs(l.quantity * l.unitPrice - l.amount) > 0.02) {
      refusals.push(`Line ${l.lineNo}: ${l.quantity} × ${l.unitPrice} ≠ ${l.amount}`);
    }
    if (CREDIT_TYPES.has(l.lineType) && l.amount > 0) {
      refusals.push(`Line ${l.lineNo}: a ${l.lineType} must be negative`);
    }
    if (!CREDIT_TYPES.has(l.lineType) && l.amount < 0) {
      refusals.push(`Line ${l.lineNo}: a ${l.lineType} cannot be negative`);
    }
  }
  const tax = args.lines.filter(l => l.lineType === "tax").reduce((n, l) => n + l.amount, 0);
  const subtotal = args.lines.filter(l => l.lineType !== "tax").reduce((n, l) => n + l.amount, 0);
  const total = subtotal + tax;

  if (Math.abs(subtotal - args.statedSubtotal) > 0.02) refusals.push(`Lines sum to ${r2(subtotal)}, bill states subtotal ${args.statedSubtotal}`);
  if (Math.abs(tax - args.statedTax) > 0.02) refusals.push(`Tax lines sum to ${r2(tax)}, bill states tax ${args.statedTax}`);
  if (Math.abs(total - args.statedTotal) > 0.02) refusals.push(`Lines total ${r2(total)}, bill states ${args.statedTotal}`);

  const openCoreCharges = args.lines.filter(l => l.lineType === "core_charge");
  return { ok: refusals.length === 0, refusals, subtotal: r2(subtotal), tax: r2(tax), total: r2(total), openCoreCharges };
}

/* ------------------------------------------------------------------ */
/* Four-way match                                                       */
/* ------------------------------------------------------------------ */

export type FourWayInput = {
  authorization: { authorizedMaximum: number; vendorId: number | null; unitId: number | null; category: string; quantities?: Record<string, number> } | null;
  operationalEvent: { unitId: number | null; occurredAt: Date; quantities?: Record<string, number> } | null;
  evidence: { present: boolean; quantities?: Record<string, number> };
  bill: { vendorId: number; unitId: number | null; serviceDate: Date | null; total: number; quantities?: Record<string, number> };
};

export type FourWayMatch = {
  outcome: "match" | "partial" | "mismatch";
  variances: string[];
  missing: string[];
};

/**
 * Authorization ↔ operational event ↔ evidence ↔ invoice. Ordinary purchasing
 * matches three ways; LeaseOS has the operational record too, so it can
 * notice that two tires were authorized, the driver confirmed two, and the
 * vendor billed three — before anyone pays.
 */
export function fourWayMatch(i: FourWayInput): FourWayMatch {
  const variances: string[] = [];
  const missing: string[] = [];

  if (!i.authorization) missing.push("purchase authorization");
  if (!i.operationalEvent) missing.push("operational event");
  if (!i.evidence.present) missing.push("receipt or photo evidence");

  if (i.authorization) {
    if (i.authorization.vendorId != null && i.authorization.vendorId !== i.bill.vendorId) {
      variances.push(`Billed by vendor ${i.bill.vendorId}, authorized vendor was ${i.authorization.vendorId}`);
    }
    if (i.bill.total > i.authorization.authorizedMaximum + 0.005) {
      variances.push(`Bill ${i.bill.total} exceeds authorized maximum ${i.authorization.authorizedMaximum}`);
    }
    if (i.authorization.unitId != null && i.bill.unitId != null && i.authorization.unitId !== i.bill.unitId) {
      variances.push(`Bill is for unit ${i.bill.unitId}, authorization was for unit ${i.authorization.unitId}`);
    }
  }
  if (i.operationalEvent) {
    if (i.operationalEvent.unitId != null && i.bill.unitId != null && i.operationalEvent.unitId !== i.bill.unitId) {
      variances.push(`Bill is for unit ${i.bill.unitId}, the event was on unit ${i.operationalEvent.unitId}`);
    }
    if (i.bill.serviceDate) {
      const days = Math.abs(i.bill.serviceDate.getTime() - i.operationalEvent.occurredAt.getTime()) / 86_400_000;
      if (days > 7) variances.push(`Service date is ${Math.round(days)} days from the event`);
    }
  }

  // Quantities, wherever any two sources both state one.
  const sources: Array<[string, Record<string, number> | undefined]> = [
    ["authorized", i.authorization?.quantities],
    ["confirmed", i.operationalEvent?.quantities],
    ["evidenced", i.evidence.quantities],
    ["billed", i.bill.quantities],
  ];
  const items = Array.from(new Set(sources.flatMap(([, q]) => Object.keys(q ?? {}))));
  for (const item of items) {
    const stated = sources.filter(([, q]) => q && q[item] != null).map(([n, q]) => [n, q![item]] as const);
    const values = new Set(stated.map(([, v]) => v));
    if (values.size > 1) {
      variances.push(`${item}: ${stated.map(([n, v]) => `${n} ${v}`).join(", ")}`);
    }
  }

  if (variances.length > 0) return { outcome: "mismatch", variances, missing };
  if (missing.length > 0) return { outcome: "partial", variances, missing };
  return { outcome: "match", variances, missing };
}

/* ------------------------------------------------------------------ */
/* What a paid bill does NOT do                                         */
/* ------------------------------------------------------------------ */

/**
 * A vendor's invoice for a repair is evidence the work was billed. It is not
 * evidence the unit is safe. The mechanic-release chain decides that, and for
 * a critical defect it requires an authenticated release — `closureImpliesRelease`
 * is already false for critical, and this makes the rule explicit at the AP
 * boundary so nobody wires "bill approved" to "unit available".
 */
export function billApprovalReleasesUnit(_billStatus: string, severity: DefectSeverity): false | boolean {
  if (severity === "critical") return false;
  // For advisory defects the existing rule may allow closure to imply release.
  // Even then it is the WORK ORDER closure that does it, not the bill.
  return false;
}

export function releasePathFor(severity: DefectSeverity): string {
  return closureImpliesRelease(severity)
    ? "Work-order closure may return the unit to service; the vendor bill plays no part"
    : "Authenticated mechanic release required; neither work-order closure nor the vendor bill returns the unit to service";
}

/* ------------------------------------------------------------------ */
/* Customer recovery                                                    */
/* ------------------------------------------------------------------ */

export type RecoveryProposal = {
  companyCost: number;
  proposedRecovery: number;
  markupPercent: number | null;
  basis: string;
  /** Always. A company expense becomes a customer charge only by a person's decision. */
  status: "review_required";
  invoiced: false;
};

export function proposeCustomerRecovery(args: {
  companyCost: number;
  contract: { passThroughAllowed: boolean; markupPercent?: number | null; recoverableCategories?: readonly string[] } | null;
  category: string;
  causedByCustomer: boolean;
}): RecoveryProposal | { status: "not_recoverable"; reason: string } {
  if (!args.contract) return { status: "not_recoverable", reason: "No customer contract on file — nothing to recover under" };
  const categoryOk = !args.contract.recoverableCategories || args.contract.recoverableCategories.includes(args.category);
  if (!args.contract.passThroughAllowed && !args.causedByCustomer) {
    return { status: "not_recoverable", reason: "Contract does not allow pass-through and the customer did not cause the cost" };
  }
  if (!categoryOk && !args.causedByCustomer) {
    return { status: "not_recoverable", reason: `Contract does not list ${args.category} as recoverable` };
  }
  const markup = args.contract.markupPercent ?? null;
  const proposed = r2(args.companyCost * (1 + (markup ?? 0) / 100));
  return {
    companyCost: args.companyCost,
    proposedRecovery: proposed,
    markupPercent: markup,
    basis: args.causedByCustomer
      ? "Cost caused by customer site conditions or delay"
      : `Contract pass-through at ${markup ?? 0}% markup`,
    status: "review_required",
    invoiced: false,
  };
}

/* ------------------------------------------------------------------ */
/* Accrual                                                              */
/* ------------------------------------------------------------------ */

export type AccrualAssessment = {
  servicePeriod: string;
  invoicePeriod: string;
  accrualCandidate: boolean;
  reason: string;
  /** A controller approves any accounting entry. This only proposes. */
  requiresControllerApproval: true;
};

export function assessAccrual(args: { serviceDate: Date | null; invoiceDate: Date; estimatedAmount?: number | null }): AccrualAssessment {
  const period = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const invoicePeriod = period(args.invoiceDate);
  if (!args.serviceDate) {
    return { servicePeriod: invoicePeriod, invoicePeriod, accrualCandidate: false, reason: "No service date — period follows the invoice until one is recorded", requiresControllerApproval: true };
  }
  const servicePeriod = period(args.serviceDate);
  if (servicePeriod === invoicePeriod) {
    return { servicePeriod, invoicePeriod, accrualCandidate: false, reason: "Service and invoice fall in the same period", requiresControllerApproval: true };
  }
  return {
    servicePeriod, invoicePeriod, accrualCandidate: true,
    reason: `Service in ${servicePeriod}, invoiced in ${invoicePeriod} — cost belongs to ${servicePeriod}`,
    requiresControllerApproval: true,
  };
}

/* ------------------------------------------------------------------ */
/* Roadside consequences                                                */
/* ------------------------------------------------------------------ */

export type RoadsideConsequence = {
  defectSeverity: DefectSeverity;
  unitAvailable: false;
  dispatchBlocker: string;
  releasePath: string;
  safetyEscalation: boolean;
};

/**
 * A roadside event makes the unit unavailable and opens a defect. Severity
 * follows movability and the event type; the release path follows severity.
 * An immovable loaded truck with dangerous goods on board is a safety matter
 * before it is a maintenance one.
 */
export function roadsideConsequences(args: {
  eventType: string;
  vehicleMovable: "yes" | "no" | "unknown";
  dangerousGoods: "yes" | "no" | "unknown";
  driverSafe: "yes" | "no" | "unknown";
}): RoadsideConsequence {
  const criticalTypes = new Set(["tire_blowout", "brake_issue", "engine_failure", "collision_recovery", "trailer_failure", "air_system"]);
  const severity: DefectSeverity =
    args.vehicleMovable === "no" || criticalTypes.has(args.eventType) ? "critical"
    : args.vehicleMovable === "unknown" ? "inspection_required"
    : "advisory";
  return {
    defectSeverity: severity,
    unitAvailable: false,
    dispatchBlocker: `Roadside event: ${args.eventType.replace(/_/g, " ")} — unit held pending repair and release`,
    releasePath: releasePathFor(severity),
    safetyEscalation: args.driverSafe !== "yes" || (args.vehicleMovable === "no" && args.dangerousGoods !== "no"),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
