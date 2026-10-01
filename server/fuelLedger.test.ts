import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  classifyFuelEvent,
  fuelHosContext,
  matchStatementLine,
  summarizeWorkerFuel,
  type FuelFacts,
} from "./_core/fuelLedger";
import { buildFingerprint } from "./_core/documentFingerprint";
import { planAssistantCommit, type AssistantCommitContext } from "./_core/assistantCommitAdapters";
import type { CommittedField } from "./_core/aiProposal";
import { classifyDocument, extractToProposal } from "./_core/documentExtraction";
import { executeAssistantCommit } from "./_core/assistantCommitService";
import { grantUserRole } from "./db";

const COMPANY = 100;

const facts = (over: Partial<FuelFacts> = {}): FuelFacts => ({
  companyEntityId: COMPANY,
  fueledByUserId: 9,
  payer: { kind: "fleet_card", fleetCardId: 1, cardOwnerEntityId: COMPANY },
  consumer: { kind: "company_unit", unitId: 142 },
  purposeEvidence: "on_company_assignment",
  fuelerIsOwnerShareholder: false,
  fuelerIsContractor: false,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Four questions, answered separately                                  */
/* ------------------------------------------------------------------ */

describe("who fueled, who paid, what consumed it, whose record it is", () => {
  it("company card, company unit — company fuel, not the driver's expense", () => {
    const c = classifyFuelEvent(facts());
    expect(c.payerType).toBe("company");
    expect(c.purpose).toBe("company_vehicle_operation");
    expect(c.treatment).toBe("company_operating_expense");
    expect(c.financialOwnerEntityId).toBe(COMPANY);
    expect(c.workerPersonalExpense).toBe(false);
    expect(c.reimbursementCandidate).toBe(false);
  });

  it("scanning a receipt does not make it the scanner's expense", () => {
    // The fueler is known. Who paid is not.
    const c = classifyFuelEvent(facts({ payer: { kind: "unknown" } }));
    expect(c.payerType).toBe("unknown");
    expect(c.treatment).toBe("unknown_review_required");
    expect(c.workerPersonalExpense).toBe(false);
    expect(c.financialOwnerEntityId).toBeNull();
    expect(c.reasons[0]).toContain("not established by who scanned");
  });

  it("worker pays personally on assigned travel in their own vehicle — reimbursement pending, worker evidence retained", () => {
    const c = classifyFuelEvent(facts({
      payer: { kind: "personal_payment", userId: 9 },
      consumer: { kind: "personal_vehicle", userId: 9 },
      purposeEvidence: "assigned_business_travel",
    }));
    expect(c.payerType).toBe("worker_personal");
    expect(c.purpose).toBe("employee_business_travel");
    expect(c.treatment).toBe("employee_reimbursement_pending");
    expect(c.workerPersonalExpense).toBe(true);
    expect(c.reimbursementCandidate).toBe(true);
    expect(c.financialOwnerEntityId).toBe(COMPANY);
  });

  it("owner pays personally for a company truck — company expense plus equity review, NOT owner personal fuel", () => {
    const c = classifyFuelEvent(facts({
      payer: { kind: "personal_payment", userId: 9 },
      fuelerIsOwnerShareholder: true,
    }));
    expect(c.payerType).toBe("owner_shareholder");
    expect(c.purpose).toBe("company_vehicle_operation");
    expect(c.treatment).toBe("owner_reimbursement_or_equity_review");
    expect(c.financialOwnerEntityId).toBe(COMPANY);
    expect(c.workerPersonalExpense).toBe(false);
    expect(c.reasons.join(" ")).toContain("NOT owner personal fuel");
  });

  it("contractor fuels their own truck on their own account — the contractor's record, not company fuel", () => {
    const c = classifyFuelEvent(facts({
      payer: { kind: "contractor_account", contractorEntityId: 77 },
      consumer: { kind: "contractor_unit", unitId: 500, contractorEntityId: 77 },
      fuelerIsContractor: true,
    }));
    expect(c.payerType).toBe("contractor");
    expect(c.treatment).toBe("contractor_own_expense");
    expect(c.financialOwnerEntityId).toBe(77);
    expect(c.contractorSettlementLine).toBeNull();
  });

  it("company card in a contractor truck — a fuel advance against settlement", () => {
    const c = classifyFuelEvent(facts({
      consumer: { kind: "contractor_unit", unitId: 500, contractorEntityId: 77 },
    }));
    expect(c.treatment).toBe("contractor_fuel_advance");
    expect(c.contractorSettlementLine).toBe("fuel_advance");
    expect(c.financialOwnerEntityId).toBe(COMPANY);
  });

  it("bulk tank purchase is inventory, not a unit expense", () => {
    const c = classifyFuelEvent(facts({ consumer: { kind: "bulk_tank", tankId: 3 } }));
    expect(c.purpose).toBe("bulk_tank_purchase");
    expect(c.treatment).toBe("bulk_fuel_inventory");
  });

  it("declared personal fuel is private to the fueler and nobody's company record", () => {
    const c = classifyFuelEvent(facts({
      payer: { kind: "personal_payment", userId: 9 },
      consumer: { kind: "personal_vehicle", userId: 9 },
      purposeEvidence: "declared_personal",
    }));
    expect(c.privateToFueler).toBe(true);
    expect(c.financialOwnerEntityId).toBeNull();
    expect(c.treatment).toBe("personal_tax_review");
  });

  it("personal vehicle, worker paid, purpose unknown — assumed neither personal nor business", () => {
    const c = classifyFuelEvent(facts({
      payer: { kind: "personal_payment", userId: 9 },
      consumer: { kind: "personal_vehicle", userId: 9 },
      purposeEvidence: "unknown",
    }));
    expect(c.treatment).toBe("unknown_review_required");
    expect(c.workerPersonalExpense).toBe(false);
    expect(c.privateToFueler).toBe(false);
  });

  it("a fleet card that belongs to another entity is not company fuel", () => {
    const c = classifyFuelEvent(facts({ payer: { kind: "fleet_card", fleetCardId: 2, cardOwnerEntityId: 999 } }));
    expect(c.payerType).toBe("unknown");
    expect(c.treatment).toBe("unknown_review_required");
  });

  it("never emits a treatment that says deductible", () => {
    const all = [
      facts(), facts({ payer: { kind: "unknown" } }),
      facts({ payer: { kind: "personal_payment", userId: 9 }, fuelerIsOwnerShareholder: true }),
    ].map(classifyFuelEvent);
    for (const c of all) expect(c.treatment).not.toMatch(/deduct/i);
  });
});

/* ------------------------------------------------------------------ */
/* Worker side                                                          */
/* ------------------------------------------------------------------ */

describe("the worker's year-end fuel panel separates who bore the cost", () => {
  it("does not present reimbursed fuel as personally borne", () => {
    const s = summarizeWorkerFuel([
      { total: 6941, classification: { payerType: "company", treatment: "company_operating_expense", workerPersonalExpense: false, privateToFueler: false }, reimbursement: "not_applicable" },
      { total: 634, classification: { payerType: "worker_personal", treatment: "employee_reimbursement_pending", workerPersonalExpense: true, privateToFueler: false }, reimbursement: "paid", reimbursedAmount: 634 },
      { total: 247, classification: { payerType: "worker_personal", treatment: "employee_reimbursement_pending", workerPersonalExpense: true, privateToFueler: false }, reimbursement: "denied" },
      { total: 94.6, classification: { payerType: "worker_personal", treatment: "employee_reimbursement_pending", workerPersonalExpense: true, privateToFueler: false }, reimbursement: "pending" },
      { total: 50, classification: { payerType: "unknown", treatment: "unknown_review_required", workerPersonalExpense: false, privateToFueler: false }, reimbursement: "not_applicable" },
    ]);
    expect(s.companyPaid).toBe(6941);
    expect(s.employerReimbursed).toBe(634);
    expect(s.personallyPaidUnreimbursed).toBe(247);
    // Pending is neither reimbursed nor borne yet; unknown is unknown.
    expect(s.requiresReview).toBe(2);
    expect(s.fuelScanned).toBe(7966.6);
  });

  it("counts a partial reimbursement's shortfall as personally borne", () => {
    const s = summarizeWorkerFuel([
      { total: 100, classification: { payerType: "worker_personal", treatment: "employee_reimbursement_pending", workerPersonalExpense: true, privateToFueler: false }, reimbursement: "paid", reimbursedAmount: 80 },
    ]);
    expect(s.employerReimbursed).toBe(80);
    expect(s.personallyPaidUnreimbursed).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
/* HOS boundary                                                         */
/* ------------------------------------------------------------------ */

describe("fuel informs the logbook and never writes it", () => {
  const base = { operatorId: 9, unitId: 142, occurredAt: new Date(), commercialVehicle: true, sourceEventRef: "fuel:P-1" };

  it("returns unknown while no authoritative HOS rule is loaded", () => {
    const h = fuelHosContext({ ...base, currentDutyStatus: "off_duty", hosRulesLoaded: false });
    expect(h.ruleConclusion).toBe("unknown");
    expect(h.writesDutyStatus).toBe(false);
    expect(h.reason).toContain("No authoritative HOS rule loaded");
  });

  it("with rules loaded, flags fueling while off-duty for review rather than reclassifying it", () => {
    const h = fuelHosContext({ ...base, currentDutyStatus: "sleeper", hosRulesLoaded: true });
    expect(h.ruleConclusion).toBe("requires_status_review");
    expect(h.writesDutyStatus).toBe(false);
  });

  it("is consistent for a non-commercial vehicle regardless of rules", () => {
    const h = fuelHosContext({ ...base, commercialVehicle: false, currentDutyStatus: "off_duty", hosRulesLoaded: false });
    expect(h.ruleConclusion).toBe("consistent");
  });
});

/* ------------------------------------------------------------------ */
/* Two evidence sources, one transaction                                */
/* ------------------------------------------------------------------ */

describe("a card statement line and a receipt are one transaction, not two", () => {
  const tx = { cardLastFour: "3812", occurredAt: new Date("2026-09-10T14:20:00Z"), total: 487.56, quantity: 327.4, unitNumber: "142" };

  it("matches on card, time and total", () => {
    const m = matchStatementLine({ transaction: tx, line: { cardLastFour: "3812", occurredAt: new Date("2026-09-10T14:22:00Z"), total: 487.56, quantity: 327.4, unitHint: "142" } });
    expect(m.outcome).toBe("match");
  });

  it("matches with a variance when quantity or unit differ", () => {
    const m = matchStatementLine({ transaction: tx, line: { cardLastFour: "3812", occurredAt: new Date("2026-09-10T14:22:00Z"), total: 487.56, quantity: 310, unitHint: "218" } });
    expect(m.outcome).toBe("match_with_variance");
    if (m.outcome === "match_with_variance") {
      expect(m.variances.join(" ")).toContain("Quantity differs");
      expect(m.variances.join(" ")).toContain("Unit differs");
    }
  });

  it("does not match a different card, a different total, or a distant time", () => {
    expect(matchStatementLine({ transaction: tx, line: { cardLastFour: "9999", occurredAt: tx.occurredAt, total: 487.56, quantity: null, unitHint: null } }).outcome).toBe("no_match");
    expect(matchStatementLine({ transaction: tx, line: { cardLastFour: "3812", occurredAt: tx.occurredAt, total: 487.5, quantity: null, unitHint: null } }).outcome).toBe("no_match");
    expect(matchStatementLine({ transaction: tx, line: { cardLastFour: "3812", occurredAt: new Date("2026-09-14T14:20:00Z"), total: 487.56, quantity: null, unitHint: null } }).outcome).toBe("no_match");
  });
});

describe("the fuel fingerprint keys on more than a receipt does", () => {
  it("separates two same-day, same-total fills by quantity, card and unit", () => {
    const a = buildFingerprint({ documentType: "fuel_receipt", vendorName: "Petro Cardlock", transactionDate: "2026-09-10", total: 200, quantity: 134.3, cardLastFour: "3812", unitNumber: "142" });
    const b = buildFingerprint({ documentType: "fuel_receipt", vendorName: "Petro Cardlock", transactionDate: "2026-09-10", total: 200, quantity: 131.9, cardLastFour: "3812", unitNumber: "142" });
    expect(a.structuredKeyHash).not.toBe(b.structuredKeyHash);
    const c = buildFingerprint({ documentType: "fuel_receipt", vendorName: "PETRO-CARDLOCK", transactionDate: "2026-09-10", total: 200, quantity: 134.3, cardLastFour: "3812", unitNumber: "142" });
    expect(a.structuredKeyHash).toBe(c.structuredKeyHash);
  });

  it("is incomplete without a quantity", () => {
    const fp = buildFingerprint({ documentType: "fuel_receipt", vendorName: "X", transactionDate: "2026-09-10", total: 200, quantity: null, cardLastFour: null, unitNumber: null });
    expect(fp.complete).toBe(false);
    expect(fp.missing).toContain("quantity");
  });
});

/* ------------------------------------------------------------------ */
/* Extraction and adapter                                               */
/* ------------------------------------------------------------------ */

describe("a fuel receipt is its own form", () => {
  it("routes a fuel receipt to fuel_receipt, not to the generic expense form", () => {
    const ocr = { engine: "t", rawText: "PETRO-CANADA CARDLOCK  DIESEL 327.4 L @ 1.489  PUMP 4  TOTAL 487.56", fields: [] };
    const out = extractToProposal({ ocr, classification: classifyDocument({ ocr }) });
    expect(out.formKey).toBe("fuel_receipt");
  });

  it("asks a person for the odometer and price however confident the read", () => {
    const ocr = {
      engine: "t", rawText: "DIESEL 327.4 L", documentTypeHint: "fuel_receipt" as const, documentTypeConfidence: 99,
      fields: [{ key: "odometerKm", confidence: 99, value: 284331 }, { key: "unitPrice", confidence: 99, value: 1.489 }, { key: "vendorName", confidence: 99, value: "Petro-Canada" }],
    };
    const out = extractToProposal({ ocr, classification: classifyDocument({ ocr }) });
    const asked = out.questions.map(q => q.fieldKey);
    expect(asked).toContain("odometerKm");
    expect(asked).toContain("unitPrice");
    expect(asked).not.toContain("vendorName");
  });
});

const ctx = (over: Partial<AssistantCommitContext> = {}): AssistantCommitContext => ({
  proposalId: "P-F", formKey: "fuel_receipt", targetRef: "ENT-1", targetRecordId: 1, unitId: 142, tripId: 8844, fleetCardId: 1,
  utcOffsetMinutes: -360, actorUserId: 9, capturedAt: new Date(), ...over,
});
const cf = (key: string, value: string | number): CommittedField => ({
  key, label: key, value, precision: "exact", source: "human_corrected", confidence: "high", status: "confirmed", committedAt: new Date(),
});
const slip = () => [
  cf("vendorName", "Petro-Canada Cardlock"), cf("transactionDate", "2026-09-10"), cf("transactionTime", "08:15"),
  cf("fuelType", "diesel"), cf("quantity", 327.4), cf("quantityUnit", "L"), cf("unitPrice", 1.489),
  cf("subtotal", 487.5), cf("salesTaxAmount", 24.38), cf("total", 511.88),
  cf("cardLastFour", "3812"), cf("unitNumber", "142"), cf("odometerKm", 284331),
];

describe("the adapter carries hints and refuses misreads", () => {
  it("plans a needs_review fuel transaction bound by context, with the slip's unit and card as hints", () => {
    const p = planAssistantCommit(ctx(), slip());
    expect(p.ok, JSON.stringify(p)).toBe(true);
    if (!p.ok || p.intent.kind !== "fuel_transaction_create") throw new Error("wrong plan");
    expect(p.intent.values.status).toBe("needs_review");
    expect(p.intent.values.unitId).toBe(142);          // from context
    expect(p.intent.values.fleetCardId).toBe(1);       // from context
    expect(p.intent.values.unitNumberHint).toBe("142"); // from the slip
    expect(p.intent.values.cardLastFourHint).toBe("3812");
    expect(p.intent.values.occurredAt.toISOString()).toBe("2026-09-10T14:15:00.000Z");
  });

  it("does not bind a unit from the slip when context has none", () => {
    const p = planAssistantCommit(ctx({ unitId: null }), slip());
    if (!p.ok || p.intent.kind !== "fuel_transaction_create") throw new Error("wrong plan");
    expect(p.intent.values.unitId).toBeNull();
    expect(p.intent.values.unitNumberHint).toBe("142");
  });

  it("refuses four numbers that disagree", () => {
    const bad = slip().map(f => (f.key === "subtotal" ? cf("subtotal", 400) : f));
    const p = planAssistantCommit(ctx(), bad);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.refusals.join(" ")).toMatch(/does not equal/);
  });

  it("refuses anything but exactly four digits for the card hint", () => {
    const bad = slip().map(f => (f.key === "cardLastFour" ? cf("cardLastFour", "4532123412343812") : f));
    const p = planAssistantCommit(ctx(), bad);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.refusals.join(" ")).toContain("nothing more is ever stored");
  });

  it("refuses a negative odometer and an unknown fuel type", () => {
    expect(planAssistantCommit(ctx(), slip().map(f => (f.key === "odometerKm" ? cf("odometerKm", -5) : f))).ok).toBe(false);
    expect(planAssistantCommit(ctx(), slip().map(f => (f.key === "fuelType" ? cf("fuelType", "plutonium") : f))).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* End to end                                                           */
/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 0;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
let userSeq = 640000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 6 });
});

async function driver(): Promise<number> {
  const id = nextUser();
  await grantUserRole({ userId: id, role: "driver", scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}
async function fixtures(actor: number) {
  const [ent] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId) VALUES (?, 'ABC Oilfield Ltd', 'corporation', 'CA-AB', 1)",
    [key("ENT").slice(0, 40)]
  );
  const entityId = Number(ent.insertId);
  const [unit] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO units (unitNumber, vehicleType, company) VALUES (?, 'truck', 'ABC')", [key("142").slice(0, 30)]
  );
  const [unitRow] = await pool.execute<mysql.RowDataPacket[]>("SELECT unitNumber FROM units WHERE id = ?", [Number(unit.insertId)]);
  const [card] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO fleetFuelCards (cardRef, financialEntityId, provider, lastFour, assignedUnitId, status) VALUES (?, ?, 'Petro-Canada', '3812', ?, 'active')",
    [key("CARD").slice(0, 40), entityId, Number(unit.insertId)]
  );
  // AIL-1A: a proposal's trip is checked against its organization at commit, so it has to be a real trip.
  const [trip] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO trips (tripNumber, tripType, status) VALUES (?, 'one_way', 'planned')", [key("TRP").slice(0, 30)]
  );
  return { entityId, unitId: Number(unit.insertId), unitNumber: String(unitRow[0].unitNumber), cardId: Number(card.insertId), tripId: Number(trip.insertId), actor };
}
async function fuelProposal(f: Awaited<ReturnType<typeof fixtures>>, over: { fleetCardId?: number | null; unitId?: number | null; last4?: string; unitHint?: string; vendor?: string } = {}) {
  const proposalId = key("PROP-FUEL");
  await pool.execute(
    `INSERT INTO assistantProposals (tenantId, tenantDerivedFrom, proposalId, formKey, formVersion, title, targetRef, targetRecordId, unitId, tripId, fleetCardId, utcOffsetMinutes, createdByUserId, readBack, readBackAcknowledged, commitState)
     VALUES ('default', 'single_tenant_fallback', ?, 'fuel_receipt', 1, 'Fuel', ?, ?, ?, ?, ?, -360, ?, 'ok', 1, 'awaiting_readback')`,
    [proposalId, `ENT-${f.entityId}`, f.entityId, over.unitId === undefined ? f.unitId : over.unitId, f.tripId, over.fleetCardId === undefined ? f.cardId : over.fleetCardId, f.actor]
  );
  const fields: Array<[string, string | number]> = [
    ["vendorName", over.vendor ?? key("Petro-Canada Cardlock")], ["transactionDate", "2026-09-10"], ["transactionTime", "08:15"],
    ["fuelType", "diesel"], ["quantity", 327.4], ["quantityUnit", "L"], ["unitPrice", 1.489],
    ["subtotal", 487.5], ["salesTaxAmount", 24.38], ["total", 511.88],
    ["cardLastFour", over.last4 ?? "3812"], ["unitNumber", over.unitHint ?? f.unitNumber], ["odometerKm", 284331],
  ];
  for (const [k, v] of fields) {
    await pool.execute(
      `INSERT INTO proposalFields (proposalId, fieldKey, label, fieldValue, \`precision\`, source, confidence, status) VALUES (?, ?, ?, ?, 'exact', 'human_corrected', 'high', 'confirmed')`,
      [proposalId, k, k, JSON.stringify(v)]
    );
  }
  return proposalId;
}

d("a fleet-card fill, end to end", () => {
  it("lands as company fuel in needs_review with an expense draft underneath, and no worker expense", async () => {
    const f = await fixtures(await driver());
    const proposalId = await fuelProposal(f);
    const r = await executeAssistantCommit({ proposalId, actorUserId: f.actor });
    expect(r.committed, JSON.stringify(r)).toBe(true);
    if (!r.committed) return;
    expect(r.targetType).toBe("fuel_transaction");

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT payerType, purpose, financialTreatment, status, reimbursementStatus, privateToFueler, hosRuleConclusion, expenseRecordId, unitId, fleetCardId, unitNumberHint, quantity, totalCents FROM fuelTransactions WHERE id = ?",
      [r.targetRecordId]
    );
    const t = rows[0];
    expect(t.payerType).toBe("company");
    expect(t.purpose).toBe("company_vehicle_operation");
    expect(t.financialTreatment).toBe("company_operating_expense");
    expect(t.status).toBe("needs_review");
    expect(t.reimbursementStatus).toBe("not_applicable");
    expect(Number(t.privateToFueler)).toBe(0);
    // P9: no HOS rule loaded, so the logbook context is unknown — and nothing wrote a duty status.
    expect(t.hosRuleConclusion).toBe("unknown");
    expect(Number(t.unitId)).toBe(f.unitId);
    expect(Number(t.fleetCardId)).toBe(f.cardId);
    expect(Number(t.quantity)).toBe(327.4);

    // The financial record underneath, as a draft, treatment untouched.
    const [exp] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, taxTreatment, financialEntityId FROM expenseRecords WHERE id = ?", [t.expenseRecordId]);
    expect(exp[0].status).toBe("draft");
    expect(exp[0].taxTreatment).toBe("unknown_review_required");
    expect(Number(exp[0].financialEntityId)).toBe(f.entityId);

    // Receipt row says fuel_transaction.
    const [rc] = await pool.execute<mysql.RowDataPacket[]>("SELECT targetType FROM assistantCommitReceipts WHERE proposalId = ?", [proposalId]);
    expect(rc[0].targetType).toBe("fuel_transaction");
  });

  it("refuses a slip whose printed card contradicts the card the proposal was opened against", async () => {
    const f = await fixtures(await driver());
    const proposalId = await fuelProposal(f, { last4: "9999" });
    const r = await executeAssistantCommit({ proposalId, actorUserId: f.actor });
    expect(r.committed).toBe(false);
    if (!r.committed) expect(r.refusals.join(" ")).toContain("opened against card");
  });

  it("refuses a slip whose printed unit contradicts the assignment rather than rebinding silently", async () => {
    const f = await fixtures(await driver());
    const proposalId = await fuelProposal(f, { unitHint: "218" });
    const r = await executeAssistantCommit({ proposalId, actorUserId: f.actor });
    expect(r.committed).toBe(false);
    if (!r.committed) expect(r.refusals.join(" ")).toContain("review before committing");
  });

  it("with no card token, who paid is unknown — and it is not the driver's expense", async () => {
    const f = await fixtures(await driver());
    const proposalId = await fuelProposal(f, { fleetCardId: null, last4: "" });
    // an empty last-four hint fails the four-digit check; drop the field instead
    await pool.execute("DELETE FROM proposalFields WHERE proposalId = ? AND fieldKey = 'cardLastFour'", [proposalId]);
    const r = await executeAssistantCommit({ proposalId, actorUserId: f.actor });
    expect(r.committed, JSON.stringify(r)).toBe(true);
    if (!r.committed) return;
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT payerType, financialTreatment, expenseRecordId, privateToFueler FROM fuelTransactions WHERE id = ?", [r.targetRecordId]
    );
    expect(rows[0].payerType).toBe("unknown");
    expect(rows[0].financialTreatment).toBe("unknown_review_required");
    // No financial record was created on anyone's books.
    expect(rows[0].expenseRecordId).toBeNull();
    expect(Number(rows[0].privateToFueler)).toBe(0);
  });

  it("refuses a second photo of the same fill", async () => {
    const f = await fixtures(await driver());
    const vendor = key("Husky");
    expect((await executeAssistantCommit({ proposalId: await fuelProposal(f, { vendor }), actorUserId: f.actor })).committed).toBe(true);
    const r = await executeAssistantCommit({ proposalId: await fuelProposal(f, { vendor }), actorUserId: f.actor });
    expect(r.committed).toBe(false);
    if (!r.committed) expect(r.duplicate).toBe("possible_duplicate");
  });
});
