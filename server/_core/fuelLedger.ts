/**
 * Fuel & Energy Ledger — classification.
 *
 * Every fueling event answers four questions, and they are four different
 * questions:
 *
 *   Who physically fueled?         a person
 *   Who paid?                      a card, an account, a wallet
 *   What consumed the fuel?        a unit, a piece of equipment, a tank
 *   Whose financial record is it?  an entity
 *
 * The mistake this file exists to prevent: a worker scanning a receipt does
 * NOT make it the worker's expense. They uploaded it. That is all that is
 * known from the upload. Everything else is a resolved fact or it is unknown,
 * and unknown classifies as unknown.
 *
 * Nothing here says "tax deductible". The treatments below say whose books a
 * fuel event lands in and what review it needs. Whether any of it is
 * deductible is a determination LeaseOS does not make.
 */

export type FuelType =
  | "diesel" | "gasoline" | "def" | "propane" | "cng" | "lng" | "electric_charge" | "other";

export type FuelPaymentOwner =
  | "company" | "worker_personal" | "contractor" | "owner_shareholder" | "customer" | "unknown";

export type FuelPurpose =
  | "company_vehicle_operation"
  | "company_equipment_operation"
  | "company_business_travel"
  | "employee_business_travel"
  | "contractor_operation"
  | "bulk_tank_purchase"
  | "bulk_tank_dispense"
  | "personal"
  | "unknown";

/**
 * None of these say deductible. `contractor_own_expense` is one value beyond
 * the specification's list: a contractor buying fuel for their own truck is
 * neither reimbursement-pending nor an advance — it is their record, not the
 * company's, and the ledger has to be able to say so.
 */
export type FuelFinancialTreatment =
  | "company_operating_expense"
  | "employee_reimbursement_pending"
  | "contractor_reimbursement_pending"
  | "contractor_fuel_advance"
  | "contractor_own_expense"
  | "owner_reimbursement_or_equity_review"
  | "bulk_fuel_inventory"
  | "personal_tax_review"
  | "unknown_review_required";

/** Who paid. Resolved by the server from a card token, never from the receipt's text. */
export type FuelPayer =
  | { kind: "fleet_card"; fleetCardId: number; cardOwnerEntityId: number }
  | { kind: "personal_payment"; userId: number }
  | { kind: "contractor_account"; contractorEntityId: number }
  | { kind: "customer_account"; customerRef: string }
  | { kind: "unknown" };

/** What consumed it. Resolved from assignment, never from "Unit 142" on the slip. */
export type FuelConsumer =
  | { kind: "company_unit"; unitId: number }
  | { kind: "contractor_unit"; unitId: number; contractorEntityId: number }
  | { kind: "company_equipment"; equipmentId: number }
  | { kind: "personal_vehicle"; userId: number }
  | { kind: "bulk_tank"; tankId: number }
  | { kind: "unknown" };

export type FuelFacts = {
  companyEntityId: number;
  fueledByUserId: number | null;
  payer: FuelPayer;
  consumer: FuelConsumer;
  /** What the assignment record says the fueler was doing. */
  purposeEvidence:
    | "on_company_assignment"
    | "assigned_business_travel"
    | "declared_personal"
    | "unknown";
  fuelerIsOwnerShareholder: boolean;
  fuelerIsContractor: boolean;
};

export type FuelClassification = {
  payerType: FuelPaymentOwner;
  purpose: FuelPurpose;
  treatment: FuelFinancialTreatment;
  /** Whose books. Null when it is nobody's yet, or when it is private. */
  financialOwnerEntityId: number | null;
  /** True only when the fueler personally bore a cost that is theirs to carry. */
  workerPersonalExpense: boolean;
  /** True when the company may owe the fueler money for this. */
  reimbursementCandidate: boolean;
  /** Set when a contractor settlement line should be raised. */
  contractorSettlementLine: "fuel_advance" | "reimbursement" | null;
  /** Private to the fueler: the company's views must not show it. */
  privateToFueler: boolean;
  reasons: string[];
};

const UNKNOWN: FuelClassification = {
  payerType: "unknown",
  purpose: "unknown",
  treatment: "unknown_review_required",
  financialOwnerEntityId: null,
  workerPersonalExpense: false,
  reimbursementCandidate: false,
  contractorSettlementLine: null,
  privateToFueler: false,
  reasons: [],
};

export function classifyFuelEvent(f: FuelFacts): FuelClassification {
  const reasons: string[] = [];

  if (f.payer.kind === "unknown") {
    return {
      ...UNKNOWN,
      // The one thing an upload does establish is who uploaded it. It does
      // not establish that they paid.
      reasons: ["Payer unknown — who paid is not established by who scanned"],
    };
  }
  if (f.consumer.kind === "unknown") {
    const payerType = payerTypeOf(f);
    return {
      ...UNKNOWN,
      payerType,
      reasons: [`Consumer unknown — a ${payerType} payment with no known vehicle, equipment or tank stays unclassified`],
    };
  }

  /* ---- Fleet card ---- */
  if (f.payer.kind === "fleet_card") {
    const companyCard = f.payer.cardOwnerEntityId === f.companyEntityId;
    if (!companyCard) {
      return {
        ...UNKNOWN,
        payerType: "unknown",
        reasons: [`Fleet card belongs to entity ${f.payer.cardOwnerEntityId}, not the company — review`],
      };
    }
    switch (f.consumer.kind) {
      case "company_unit":
        reasons.push("Company fleet card, company unit");
        return {
          payerType: "company", purpose: "company_vehicle_operation", treatment: "company_operating_expense",
          financialOwnerEntityId: f.companyEntityId, workerPersonalExpense: false, reimbursementCandidate: false,
          contractorSettlementLine: null, privateToFueler: false, reasons,
        };
      case "company_equipment":
        reasons.push("Company fleet card, company equipment");
        return {
          payerType: "company", purpose: "company_equipment_operation", treatment: "company_operating_expense",
          financialOwnerEntityId: f.companyEntityId, workerPersonalExpense: false, reimbursementCandidate: false,
          contractorSettlementLine: null, privateToFueler: false, reasons,
        };
      case "bulk_tank":
        reasons.push("Company fleet card, bulk tank — inventory, not a unit expense");
        return {
          payerType: "company", purpose: "bulk_tank_purchase", treatment: "bulk_fuel_inventory",
          financialOwnerEntityId: f.companyEntityId, workerPersonalExpense: false, reimbursementCandidate: false,
          contractorSettlementLine: null, privateToFueler: false, reasons,
        };
      case "contractor_unit":
        reasons.push("Company fleet card in a contractor-owned truck — a fuel advance against settlement");
        return {
          payerType: "company", purpose: "contractor_operation", treatment: "contractor_fuel_advance",
          financialOwnerEntityId: f.companyEntityId, workerPersonalExpense: false, reimbursementCandidate: false,
          contractorSettlementLine: "fuel_advance", privateToFueler: false, reasons,
        };
      case "personal_vehicle":
        reasons.push("Company fleet card in a personal vehicle — review before treating as company or personal");
        return {
          ...UNKNOWN, payerType: "company",
          purpose: f.purposeEvidence === "assigned_business_travel" ? "company_business_travel" : "unknown",
          reasons,
        };
    }
  }

  /* ---- Personal payment ---- */
  if (f.payer.kind === "personal_payment") {
    const fuelerPaid = f.payer.userId === f.fueledByUserId;
    if (!fuelerPaid) {
      return { ...UNKNOWN, payerType: "worker_personal", reasons: ["Personal payment by someone other than the fueler — review"] };
    }

    if (f.fuelerIsOwnerShareholder && (f.consumer.kind === "company_unit" || f.consumer.kind === "company_equipment")) {
      reasons.push("Owner paid personally for company operation — company expense, owner reimbursement or equity review; NOT owner personal fuel");
      return {
        payerType: "owner_shareholder",
        purpose: f.consumer.kind === "company_unit" ? "company_vehicle_operation" : "company_equipment_operation",
        treatment: "owner_reimbursement_or_equity_review",
        financialOwnerEntityId: f.companyEntityId, workerPersonalExpense: false, reimbursementCandidate: true,
        contractorSettlementLine: null, privateToFueler: false, reasons,
      };
    }

    switch (f.consumer.kind) {
      case "company_unit":
      case "company_equipment":
        reasons.push("Worker fronted fuel for a company asset — company expense, reimbursement pending");
        return {
          payerType: "worker_personal",
          purpose: f.consumer.kind === "company_unit" ? "company_vehicle_operation" : "company_equipment_operation",
          treatment: "employee_reimbursement_pending",
          financialOwnerEntityId: f.companyEntityId, workerPersonalExpense: false, reimbursementCandidate: true,
          contractorSettlementLine: null, privateToFueler: false, reasons,
        };
      case "personal_vehicle":
        if (f.purposeEvidence === "assigned_business_travel") {
          reasons.push("Personal vehicle on assigned business travel, worker paid — reimbursement pending; worker-side evidence retained");
          return {
            payerType: "worker_personal", purpose: "employee_business_travel", treatment: "employee_reimbursement_pending",
            financialOwnerEntityId: f.companyEntityId, workerPersonalExpense: true, reimbursementCandidate: true,
            contractorSettlementLine: null, privateToFueler: false, reasons,
          };
        }
        if (f.purposeEvidence === "declared_personal") {
          reasons.push("Declared personal — private to the fueler, nothing for the company");
          return {
            payerType: "worker_personal", purpose: "personal", treatment: "personal_tax_review",
            financialOwnerEntityId: null, workerPersonalExpense: true, reimbursementCandidate: false,
            contractorSettlementLine: null, privateToFueler: true, reasons,
          };
        }
        reasons.push("Personal vehicle, worker paid, purpose unknown — not assumed personal, not assumed business");
        return { ...UNKNOWN, payerType: "worker_personal", reasons };
      case "contractor_unit":
        return { ...UNKNOWN, payerType: "worker_personal", reasons: ["Personal payment into a contractor unit — review"] };
      case "bulk_tank":
        return { ...UNKNOWN, payerType: "worker_personal", reasons: ["Personal payment for bulk tank fuel — review"] };
    }
  }

  /* ---- Contractor account ---- */
  if (f.payer.kind === "contractor_account") {
    if (f.consumer.kind === "contractor_unit" && f.consumer.contractorEntityId === f.payer.contractorEntityId) {
      reasons.push("Contractor fuelled their own truck on their own account — the contractor's record, not company fuel");
      return {
        payerType: "contractor", purpose: "contractor_operation", treatment: "contractor_own_expense",
        financialOwnerEntityId: f.payer.contractorEntityId, workerPersonalExpense: false, reimbursementCandidate: false,
        contractorSettlementLine: null, privateToFueler: false, reasons,
      };
    }
    if (f.consumer.kind === "company_unit") {
      reasons.push("Contractor paid for a company unit — contractor reimbursement pending");
      return {
        payerType: "contractor", purpose: "company_vehicle_operation", treatment: "contractor_reimbursement_pending",
        financialOwnerEntityId: f.companyEntityId, workerPersonalExpense: false, reimbursementCandidate: true,
        contractorSettlementLine: "reimbursement", privateToFueler: false, reasons,
      };
    }
    return { ...UNKNOWN, payerType: "contractor", reasons: ["Contractor account against an unexpected consumer — review"] };
  }

  /* ---- Customer ---- */
  return { ...UNKNOWN, payerType: "customer", reasons: ["Customer-paid fuel — contract terms decide; review"] };
}

function payerTypeOf(f: FuelFacts): FuelPaymentOwner {
  switch (f.payer.kind) {
    case "fleet_card": return f.payer.cardOwnerEntityId === f.companyEntityId ? "company" : "unknown";
    case "personal_payment": return f.fuelerIsOwnerShareholder ? "owner_shareholder" : "worker_personal";
    case "contractor_account": return "contractor";
    case "customer_account": return "customer";
    default: return "unknown";
  }
}

/* ------------------------------------------------------------------ */
/* Worker-side summary                                                  */
/* ------------------------------------------------------------------ */

export type ReimbursementStatus = "not_applicable" | "pending" | "paid" | "denied";

export type WorkerFuelRecord = {
  total: number;
  classification: Pick<FuelClassification, "payerType" | "treatment" | "workerPersonalExpense" | "privateToFueler">;
  reimbursement: ReimbursementStatus;
  reimbursedAmount?: number | null;
};

/**
 * What a worker sees. Only the last bucket could ever concern a personal
 * year-end, and a reimbursed expense is not a personally borne one — that is
 * the whole reason the buckets are separate.
 */
export function summarizeWorkerFuel(records: readonly WorkerFuelRecord[]): {
  fuelScanned: number;
  companyPaid: number;
  employerReimbursed: number;
  personallyPaidUnreimbursed: number;
  requiresReview: number;
} {
  let fuelScanned = 0, companyPaid = 0, employerReimbursed = 0, personallyPaidUnreimbursed = 0, requiresReview = 0;
  for (const r of records) {
    fuelScanned += r.total;
    if (r.classification.treatment === "unknown_review_required") { requiresReview++; continue; }
    if (r.classification.payerType === "company") { companyPaid += r.total; continue; }
    if (r.classification.payerType === "worker_personal" || r.classification.payerType === "owner_shareholder") {
      if (r.reimbursement === "paid") {
        employerReimbursed += r.reimbursedAmount ?? r.total;
        const shortfall = r.total - (r.reimbursedAmount ?? r.total);
        if (shortfall > 0) personallyPaidUnreimbursed += shortfall;
      } else if (r.reimbursement === "pending") {
        // Pending is neither reimbursed nor personally borne yet. Count it
        // for review rather than in either money bucket.
        requiresReview++;
      } else {
        personallyPaidUnreimbursed += r.total;
      }
    }
  }
  return { fuelScanned: r2(fuelScanned), companyPaid: r2(companyPaid), employerReimbursed: r2(employerReimbursed), personallyPaidUnreimbursed: r2(personallyPaidUnreimbursed), requiresReview };
}

/* ------------------------------------------------------------------ */
/* HOS context                                                          */
/* ------------------------------------------------------------------ */

export type DutyStatus = "driving" | "on_duty" | "off_duty" | "sleeper" | "unknown";

export type FuelHosContext = {
  operatorId: number;
  unitId: number;
  occurredAt: Date;
  commercialVehicle: boolean;
  currentDutyStatus: DutyStatus;
  ruleConclusion: "requires_status_review" | "consistent" | "unknown";
  /** A fueling event never writes a duty status. This is context, offered. */
  writesDutyStatus: false;
  sourceEventRef: string;
  reason: string;
};

/**
 * Fuel confirmed → an HOS *context*, not an HOS record. Until an authoritative
 * jurisdiction rule is loaded (P9), the conclusion is `unknown`; and even
 * loaded, the output is a proposed logbook event for a person, never a write.
 */
export function fuelHosContext(args: {
  operatorId: number;
  unitId: number;
  occurredAt: Date;
  commercialVehicle: boolean;
  currentDutyStatus: DutyStatus;
  sourceEventRef: string;
  hosRulesLoaded: boolean;
}): FuelHosContext {
  const base = {
    operatorId: args.operatorId, unitId: args.unitId, occurredAt: args.occurredAt,
    commercialVehicle: args.commercialVehicle, currentDutyStatus: args.currentDutyStatus,
    writesDutyStatus: false as const, sourceEventRef: args.sourceEventRef,
  };
  if (!args.commercialVehicle) {
    return { ...base, ruleConclusion: "consistent", reason: "Not a commercial vehicle — no duty-status implication" };
  }
  if (!args.hosRulesLoaded) {
    return { ...base, ruleConclusion: "unknown", reason: "No authoritative HOS rule loaded — statutory classification of fueling time is not determined" };
  }
  if (args.currentDutyStatus === "off_duty" || args.currentDutyStatus === "sleeper") {
    return { ...base, ruleConclusion: "requires_status_review", reason: "Fueling a commercial vehicle while logged off-duty or sleeper — a person should review the log" };
  }
  if (args.currentDutyStatus === "unknown") {
    return { ...base, ruleConclusion: "unknown", reason: "Current duty status unknown" };
  }
  return { ...base, ruleConclusion: "consistent", reason: "Fueling while on duty is consistent with the log" };
}

/* ------------------------------------------------------------------ */
/* Statement matching — two evidence sources, one transaction           */
/* ------------------------------------------------------------------ */

export type StatementLine = {
  cardLastFour: string | null;
  occurredAt: Date;
  total: number;
  quantity: number | null;
  unitHint: string | null;
};

export type StatementMatch =
  | { outcome: "match"; reason: string }
  | { outcome: "match_with_variance"; reason: string; variances: string[] }
  | { outcome: "no_match"; reason: string };

/**
 * A card statement line and a photographed receipt are two evidence sources
 * for ONE fuel transaction. Matching them is the opposite of finding a
 * duplicate: it closes the loop, it does not open a second expense.
 */
export function matchStatementLine(args: {
  transaction: { cardLastFour: string | null; occurredAt: Date; total: number; quantity: number | null; unitNumber: string | null };
  line: StatementLine;
  windowHours?: number;
}): StatementMatch {
  const t = args.transaction, l = args.line;
  const window = (args.windowHours ?? 48) * 3_600_000;
  if (t.cardLastFour && l.cardLastFour && t.cardLastFour !== l.cardLastFour) {
    return { outcome: "no_match", reason: "Different card" };
  }
  if (Math.abs(t.occurredAt.getTime() - l.occurredAt.getTime()) > window) {
    return { outcome: "no_match", reason: "Outside the time window" };
  }
  if (Math.abs(t.total - l.total) > 0.02) {
    return { outcome: "no_match", reason: `Totals differ: ${t.total} vs ${l.total}` };
  }
  const variances: string[] = [];
  if (t.quantity != null && l.quantity != null && Math.abs(t.quantity - l.quantity) > 0.5) {
    variances.push(`Quantity differs: receipt ${t.quantity}, statement ${l.quantity}`);
  }
  if (t.unitNumber && l.unitHint && t.unitNumber.toUpperCase() !== l.unitHint.toUpperCase()) {
    variances.push(`Unit differs: receipt ${t.unitNumber}, statement ${l.unitHint}`);
  }
  return variances.length
    ? { outcome: "match_with_variance", reason: "Same card, time and total; details differ", variances }
    : { outcome: "match", reason: "Same card, time and total" };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
