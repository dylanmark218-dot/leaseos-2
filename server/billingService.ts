/**
 * v23.32 — Billing, Invoicing and Accounts Receivable: the database half.
 *
 * The rules are `_core/billingEngine.ts`. This file reads under the strict money scope (financeScopeFor through
 * `commercialScope`: an ended, lapsed or suspended membership is refused, never revived by the single-tenant
 * fallback), and writes each act in ONE transaction with its rows locked, its audit row on the existing change
 * ledger (commercialAuditEvents) and its domain event on the existing outbox.
 *
 *   - Billing CONSUMES the commercial source of truth: getBillableCommercialContext and resolveRateForJob read the
 *     job's frozen snapshot. No customer, contract or rate logic is restated here, and no rate is ever substituted.
 *   - A record outside the caller's books is NOT FOUND, never FORBIDDEN.
 *   - An issued invoice is never rewritten: corrections are credit notes, adjustments, allocation reversals or voids.
 *   - Separation of duties is checked here AND held by CHECK constraints (0233).
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, ne, or, sql, type SQL } from "drizzle-orm";
import {
  accountingSyncRecords, billableCharges, billingBooks, billingSnapshots, billingWorkspaces, commercialAuditEvents, customerAccounts, customerCredits, customerPayments,
  disposalTickets, disputeCases, fieldTicketDocuments, fieldTicketLines, fieldTicketRevisions, fieldTicketSignatures, fieldTickets, invoiceAdjustments, invoiceJobLinks, invoiceLines,
  invoices, jobCommercialSnapshots, jobs, paymentAllocations,
} from "../drizzle/schema";
import { jobInScope } from "./db";
import { notFound } from "./_core/entityScope";
import type { Db, DbOrTx, Tx } from "./_core/dbTypes";
import { nextTrackingNumber } from "./_core/trackingNumbers";
import { priceQuantity, type MeasurementBasis, type Unit } from "./_core/rateResolution";
import { normaliseUnit } from "./_core/linePricing";
import { fieldTicketSignatureVerdict } from "./_core/fieldTicketSignature";
import { determine } from "./_core/taxRuleEngine";
import { GST_RATE_RULE_TYPE, GST_RATE_SEEDS } from "./_core/gstSeeds";
import { loadTaxRules } from "./payrollService";
import { renderPdf, sha256Hex } from "./_core/ticketPdf";
import { storagePut } from "./storage";
import { registerControlledDocument } from "./_core/documentRegisterService";
import { assertPeriodOpen } from "./periodCloseService";
import { disputeResolution, voidCheck } from "./_core/invoiceDraft";
import { audit, emit, getBillableCommercialContext, resolveRateForJob, type Actor, type CommercialScope } from "./customerCommercialService";
import type { BillableCommercialContext, SnapshotPayload } from "./_core/commercialLifecycle";
import { bindNumber, ledgerSubjectRef, mintScopedNumber, prepareSeries, voidBoundNumber } from "./billingNumbers";
import {
  MEASUREMENT_TO_BASIS, POST_INVOICE_STATES, READINESS_STATES, adjustmentCheck, agingTotals, allocationCheck, approvalCheck, canonicalHash, chargeStatusFor, creditCheck, deliveryState,
  disputeOpenCheck, evaluateReadiness, exportPayload, invoiceStatusFromBalance, invoiceTransition, isIssued, lineTaxCents, overrideCheck, receivable, sliceCharge, syncTransition, taxDecision,
  workspaceTransition, type ChargeFact, type Readiness, type ReadinessFacts, type Receivable, type WorkspaceState,
} from "./_core/billingEngine";

export type BillingScope = CommercialScope;
export { commercialScope as billingScope } from "./customerCommercialService";

/* ----------------------------------------------------------------- plumbing */

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const precondition = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });
const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message });
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });
const parse = <T>(s: string | null | undefined, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };
const books = (s: BillingScope) => (s.entityIds.length ? s.entityIds : [-1]);
const owns = (s: BillingScope, entityId: number | null | undefined): entityId is number => entityId != null && s.entityIds.includes(entityId);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export type InvoiceRow = typeof invoices.$inferSelect;
export type ChargeRow = typeof billableCharges.$inferSelect;
export type WorkspaceRow = typeof billingWorkspaces.$inferSelect;

/** A job the caller's organization owns, or NOT FOUND. */
async function jobFor(s: BillingScope, jobId: number) {
  const j = await jobInScope(jobId, s.scope);
  if (!j) throw notFound(`Job ${jobId}`);
  return (await s.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1))[0]!;
}

/**
 * An invoice by number in the caller's books. Numbers are unique per organization (0233); a number that names two
 * records in one organization's books (possible only for pre-0233 data) is refused rather than guessed.
 */
export async function invoiceByNumber(s: BillingScope, invoiceNumber: string, d: DbOrTx = s.db, lock = false): Promise<InvoiceRow> {
  const q = d.select().from(invoices).where(and(eq(invoices.invoiceNumber, invoiceNumber), inArray(invoices.financialEntityId, books(s)))).limit(2);
  const rows = lock ? await q.for("update") : await q;
  if (rows.length === 0) throw notFound(`Invoice ${invoiceNumber}`);
  if (rows.length > 1) throw precondition(`Invoice number ${invoiceNumber} names more than one record in your books — refer to it from the job`);
  return rows[0]!;
}
async function chargeByRef(s: BillingScope, chargeRef: string, d: DbOrTx = s.db, lock = false): Promise<ChargeRow> {
  const q = d.select().from(billableCharges).where(eq(billableCharges.chargeRef, chargeRef)).limit(1);
  const c = (lock ? await q.for("update") : await q)[0];
  if (!c || !owns(s, c.financialEntityId)) throw notFound(`Charge ${chargeRef}`);
  return c;
}

/* ------------------------------------------------------------------ tax rate */

/** The GST/HST rate rule for a jurisdiction, from the verified rule tables (never a remembered figure). */
export async function gstRateFor(jurisdiction: string, at: Date): Promise<{ outcome: "determined" | "unverified" | "missing"; ratePercent: number | null; kind: string | null; reason: string | null }> {
  const rules = await loadTaxRules(jurisdiction);
  const keys = new Set(rules.map(r => r.ruleKey));
  const det = determine([...rules, ...GST_RATE_SEEDS.filter(x => !keys.has(x.ruleKey))], { jurisdiction, ruleType: GST_RATE_RULE_TYPE, asOf: at }) as { outcome: string; reason?: string | null; parameters?: { ratePercent?: number | null; kind?: string | null } };
  const outcome = det.outcome === "determined" ? "determined" : /unverified/i.test(det.reason ?? "") ? "unverified" : "missing";
  return { outcome, ratePercent: typeof det.parameters?.ratePercent === "number" ? det.parameters.ratePercent : null, kind: det.parameters?.kind ?? null, reason: det.reason ?? null };
}

/* ---------------------------------------------------------------- workspace */

/** The job's workspace, created on first touch, locked. */
async function workspaceLocked(tx: Tx, jobId: number, financialEntityId: number): Promise<WorkspaceRow> {
  // Lock first; insert only when absent. (INSERT IGNORE on an existing row takes a SHARED lock, and two transactions
  // upgrading it to the exclusive one deadlock.)
  let w = (await tx.select().from(billingWorkspaces).where(eq(billingWorkspaces.jobId, jobId)).for("update").limit(1))[0];
  if (!w) {
    await tx.execute(sql`INSERT IGNORE INTO billingWorkspaces (workspaceRef, jobId, financialEntityId, state) VALUES (${ref("BWS")}, ${jobId}, ${financialEntityId}, 'not_ready')`);
    w = (await tx.select().from(billingWorkspaces).where(eq(billingWorkspaces.jobId, jobId)).for("update").limit(1))[0]!;
  }
  if (w.financialEntityId !== financialEntityId) throw precondition(`Job ${jobId}'s billing is kept in another book`);
  return w;
}
/** Move the workspace through the transition table, with its audit row; anything else is refused. */
async function moveWorkspace(tx: Tx, s: BillingScope, actor: Actor, w: WorkspaceRow, to: WorkspaceState, eventType: string, at: Date, extra: Partial<typeof billingWorkspaces.$inferInsert> = {}, reason?: string | null): Promise<WorkspaceRow> {
  const t = workspaceTransition(w.state, to);
  if (!t.ok) throw precondition(t.reason);
  await tx.update(billingWorkspaces).set({ ...extra, state: to, rowVersion: w.rowVersion + 1 }).where(and(eq(billingWorkspaces.id, w.id), eq(billingWorkspaces.rowVersion, w.rowVersion)));
  await audit(tx, { financialEntityId: w.financialEntityId, subjectType: "billing_workspace", subjectRef: w.workspaceRef, subjectId: w.id, eventType, fromStatus: w.state, toStatus: to, jobId: w.jobId, reason: reason ?? null, actor, at });
  if (to === "ready" && w.state !== "ready") await emit(tx, { tenantId: s.tenantId, type: "billing.ready", entityType: "job", entityId: String(w.jobId), actor, jobId: w.jobId, payload: { jobId: w.jobId, workspaceRef: w.workspaceRef }, at });
  return { ...w, ...extra, state: to, rowVersion: w.rowVersion + 1 } as WorkspaceRow;
}

/* ---------------------------------------------------------------- readiness */

type Facts = { facts: ReadinessFacts; context: BillableCommercialContext | null; snapshot: typeof jobCommercialSnapshots.$inferSelect | null; job: typeof jobs.$inferSelect };

async function gatherFacts(s: BillingScope, jobId: number, d: DbOrTx): Promise<Facts> {
  const job = await jobFor(s, jobId);
  const bc = await getBillableCommercialContext(s, jobId);
  const context = "available" in bc ? null : bc;
  const snapshot = context ? (await d.select().from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.snapshotRef, context.snapshotRef)).limit(1))[0] ?? null : null;
  const commercialBlockers = context ? context.blockers.map(b => ({ code: b.code, message: b.detail })) : [];
  // A credit hold placed AFTER the snapshot is read live: the snapshot froze the basis, not the account's standing.
  if (snapshot && !commercialBlockers.some(b => b.code === "account_on_hold")) {
    const live = (await d.select({ status: customerAccounts.status, name: customerAccounts.name }).from(customerAccounts).where(eq(customerAccounts.id, snapshot.billToCustomerAccountId)).limit(1))[0];
    if (live?.status === "on_hold") commercialBlockers.push({ code: "account_on_hold", message: `${live.name} is on hold` });
  }
  const tickets = await d.select().from(fieldTickets).where(eq(fieldTickets.jobId, jobId)).orderBy(asc(fieldTickets.id));
  const tIds = tickets.map(t => t.id);
  const [lines, sigs, revs] = tIds.length ? await Promise.all([
    d.select().from(fieldTicketLines).where(inArray(fieldTicketLines.fieldTicketId, tIds)),
    d.select().from(fieldTicketSignatures).where(inArray(fieldTicketSignatures.fieldTicketId, tIds)),
    d.select().from(fieldTicketRevisions).where(inArray(fieldTicketRevisions.fieldTicketId, tIds)),
  ]) : [[], [], []];
  const disposal = await d.select({ ticketNumber: disposalTickets.ticketNumber, verificationStatus: disposalTickets.verificationStatus }).from(disposalTickets).where(eq(disposalTickets.jobId, jobId));
  const charges = await d.select().from(billableCharges).where(eq(billableCharges.jobId, jobId)).orderBy(asc(billableCharges.id));
  const w = (await d.select().from(billingWorkspaces).where(eq(billingWorkspaces.jobId, jobId)).limit(1))[0] ?? null;
  const facts: ReadinessFacts = {
    jobId, jobCode: job.jobCode, jobStatus: job.status,
    commercial: context ? { available: true, snapshotRef: context.snapshotRef, currency: context.currency, blockers: commercialBlockers } : { available: false, reasons: (bc as { reasons: string[] }).reasons },
    tickets: tickets.map(t => {
      const tl = lines.filter(l => l.fieldTicketId === t.id);
      const v = fieldTicketSignatureVerdict({ ticket: t, signatures: sigs.filter(x => x.fieldTicketId === t.id), revisions: revs.filter(x => x.fieldTicketId === t.id) });
      return { ticketNumber: t.ticketNumber, status: t.status, signature: { state: v.state, satisfied: v.satisfied, reason: v.reason }, lineCount: tl.length, disputedLines: tl.filter(l => l.disposition === "disputed").length, unpresentedLines: tl.filter(l => l.disposition === "not_presented").length };
    }),
    disposal: { required: context?.supportingDocumentRequirements.includes("disposal_ticket") ?? false, tickets: disposal },
    charges: charges.length ? charges.map<ChargeFact>(c => ({ chargeRef: c.chargeRef, status: c.status, pricingOutcome: c.pricingOutcome, amountCents: c.amountCents, billableQuantityMillis: c.billableQuantityMillis, billedQuantityMillis: c.billedQuantityMillis, billedAmountCents: c.billedAmountCents, overrideStatus: c.overrideStatus, sourceKind: c.sourceKind, currency: c.currency, reasons: parse<string[]>(c.reasonsJson, []) })) : null,
    hold: { active: w?.holdActive ?? false, reason: w?.holdReason ?? null },
  };
  return { facts, context, snapshot, job };
}

/** evaluateBillingReadiness(jobId): structured blockers and warnings, each with a machine code and a sentence. Read-only. */
export async function evaluateBillingReadiness(s: BillingScope, jobId: number): Promise<Readiness> {
  return evaluateReadiness((await gatherFacts(s, jobId, s.db)).facts);
}

/** Re-evaluate and move the workspace among the readiness states (a job under review or approved that is no longer ready returns to them). */
async function refreshInTx(tx: Tx, s: BillingScope, actor: Actor, jobId: number, financialEntityId: number, at: Date): Promise<{ readiness: Readiness; state: WorkspaceState }> {
  const w = await workspaceLocked(tx, jobId, financialEntityId);
  const { facts } = await gatherFacts(s, jobId, tx);
  const r = evaluateReadiness(facts);
  const record = { readinessJson: JSON.stringify({ blockers: r.blockers, warnings: r.warnings, billableCents: r.billableCents, remainingCents: r.remainingCents }), readinessHash: r.hash, evaluatedAt: at };
  let state = w.state;
  const inReadiness = READINESS_STATES.includes(w.state);
  const reviewedButChanged = (w.state === "under_review" || w.state === "approved_for_invoicing") && (!r.ready || r.hash !== w.readinessHash);
  if (inReadiness || reviewedButChanged) {
    // a job that already has invoices falls back to `invoiced` (its AR picture), never to a pre-invoice state
    const invoiced = reviewedButChanged && (await tx.select({ id: invoiceJobLinks.id }).from(invoiceJobLinks).where(eq(invoiceJobLinks.jobId, jobId)).limit(1)).length > 0;
    const target: WorkspaceState = invoiced ? "invoiced" : r.suggestedState;
    if (state !== target) { await moveWorkspace(tx, s, actor, w, target, reviewedButChanged ? "review_invalidated" : "readiness_evaluated", at, record, reviewedButChanged ? "The evidence or charges changed after review" : null); state = target; }
    else await tx.update(billingWorkspaces).set(record).where(eq(billingWorkspaces.id, w.id));
  } else await tx.update(billingWorkspaces).set(record).where(eq(billingWorkspaces.id, w.id));
  return { readiness: r, state };
}
export async function readinessRefresh(s: BillingScope, actor: Actor, jobId: number, at = new Date()) {
  const { context, job } = await gatherFacts(s, jobId, s.db);
  const entityId = await bookForJob(s, jobId, context);
  return s.db.transaction(async tx => ({ jobId: job.id, jobCode: job.jobCode, ...(await refreshInTx(tx, s, actor, jobId, entityId, at)) }));
}
/** The job's book: the commercial context's, which must be the caller's. */
async function bookForJob(s: BillingScope, jobId: number, context: BillableCommercialContext | null): Promise<number> {
  const snap = context ? (await s.db.select({ financialEntityId: jobCommercialSnapshots.financialEntityId }).from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.snapshotRef, context.snapshotRef)).limit(1))[0] : null;
  if (snap) { if (!owns(s, snap.financialEntityId)) throw notFound(`Job ${jobId}`); return snap.financialEntityId; }
  const w = (await s.db.select({ financialEntityId: billingWorkspaces.financialEntityId }).from(billingWorkspaces).where(eq(billingWorkspaces.jobId, jobId)).limit(1))[0];
  if (w) { if (!owns(s, w.financialEntityId)) throw notFound(`Job ${jobId}`); return w.financialEntityId; }
  throw precondition("The job has no commercial basis yet — assign its customer and capture the snapshot before billing");
}

/* ------------------------------------------------------------------ charges */

type PricedLine = { line: typeof fieldTicketLines.$inferSelect; ticket: typeof fieldTickets.$inferSelect };

/**
 * prepareBilling: turn the job's accepted evidence into charges, priced by the commercial rate engine against the
 * job's frozen snapshot. A line already on a live invoice, or already carrying a live charge, is skipped; a line the
 * engine cannot price becomes a HELD charge with the engine's reasons — never a guessed, default or current rate.
 */
export async function prepareBilling(s: BillingScope, actor: Actor, args: { jobId: number }, at = new Date()) {
  const { context, snapshot, job } = await gatherFacts(s, args.jobId, s.db);
  if (!context || !snapshot) throw precondition("The job has no frozen commercial basis — billing never prices from live rates; capture the job's commercial snapshot first");
  const entityId = await bookForJob(s, args.jobId, context);
  const payload = JSON.parse(snapshot.payloadJson) as SnapshotPayload;
  // Pricing reads the snapshot (and the company's no-sheet definitions) — computed before the transaction, applied inside it.
  const tickets = await s.db.select().from(fieldTickets).where(eq(fieldTickets.jobId, job.id));
  const candidates: PricedLine[] = [];
  for (const t of tickets) for (const l of await s.db.select().from(fieldTicketLines).where(eq(fieldTicketLines.fieldTicketId, t.id))) if (l.disposition === "accepted") candidates.push({ line: l, ticket: t });
  const priced = await Promise.all(candidates.map(async c => ({ c, p: await priceLine(s, job.id, c, payload) })));
  return s.db.transaction(async tx => {
    const w = await workspaceLocked(tx, job.id, entityId);
    if (w.state === "under_review" || w.state === "approved_for_invoicing") throw precondition(`Job ${job.jobCode} is ${w.state.replace(/_/g, " ")} — return the review before preparing charges again`);
    if (tickets.length) await tx.select({ id: fieldTickets.id }).from(fieldTickets).where(inArray(fieldTickets.id, tickets.map(t => t.id))).for("update");
    const lineIds = candidates.map(c => c.line.id);
    const onLegacy = lineIds.length ? new Set((await tx.select({ id: invoiceLines.liveTicketLineKey }).from(invoiceLines).where(inArray(invoiceLines.liveTicketLineKey, lineIds))).map(r => r.id)) : new Set<number | null>();
    const live = lineIds.length ? new Set((await tx.select({ sourceId: billableCharges.sourceId }).from(billableCharges).where(and(eq(billableCharges.sourceKind, "field_ticket_line"), inArray(billableCharges.sourceId, lineIds), inArray(billableCharges.status, ["proposed", "ready", "held"])))).map(r => r.sourceId)) : new Set<number | null>();
    const created: { chargeRef: string; status: string; amountCents: number | null; outcome: string }[] = [];
    const skipped: { fieldTicketLineId: number; reason: string }[] = [];
    for (const { c, p } of priced) {
      if (onLegacy.has(c.line.id)) { skipped.push({ fieldTicketLineId: c.line.id, reason: "Already on a live field-ticket invoice" }); continue; }
      if (live.has(c.line.id)) { skipped.push({ fieldTicketLineId: c.line.id, reason: "Already carries a live charge" }); continue; }
      const chargeRef = ref("CHG");
      const st = chargeStatusFor(p.outcome, p.amountCents, p.billableQuantityMillis);
      await tx.insert(billableCharges).values({
        chargeRef, financialEntityId: entityId, jobId: job.id, customerAccountId: snapshot.billToCustomerAccountId, commercialSnapshotId: snapshot.id, commercialSnapshotRef: snapshot.snapshotRef, contractRef: snapshot.contractRef, rateSheetVersionRef: snapshot.rateSheetVersionRef,
        sourceKind: "field_ticket_line", sourceId: c.line.id, sourceRef: `${c.ticket.ticketNumber}#${c.line.id}`, fieldTicketId: c.ticket.id, serviceCode: c.line.serviceCode, lineKind: p.lineKind, description: c.line.description.slice(0, 300),
        quantityMillis: p.quantityMillis, unit: p.unit, measurementSource: p.measurementSource, definitionRef: p.definitionRef, definitionVersion: p.definitionVersion, scopeLevel: p.scopeLevel, pricingMethod: p.pricingMethod, rateMillis: p.rateMillis,
        billableQuantityMillis: p.billableQuantityMillis, pricedAmountCents: p.amountCents, amountCents: p.amountCents, currency: snapshot.currency, pricingOutcome: p.outcome, formula: p.formula.slice(0, 400), inputsJson: JSON.stringify(p.inputs), reasonsJson: JSON.stringify(p.reasons),
        status: st.status, holdReason: st.holdReason, createdByUserId: actor.userId,
      });
      await audit(tx, { financialEntityId: entityId, subjectType: "billable_charge", subjectRef: chargeRef, eventType: "charge_prepared", toStatus: st.status, jobId: job.id, relatedRef: snapshot.snapshotRef, changes: { amountCents: { from: null, to: p.amountCents }, outcome: { from: null, to: p.outcome } }, actor, at });
      created.push({ chargeRef, status: st.status, amountCents: p.amountCents, outcome: p.outcome });
    }
    await audit(tx, { financialEntityId: entityId, subjectType: "billing_workspace", subjectRef: w.workspaceRef, subjectId: w.id, eventType: "charges_prepared", jobId: job.id, relatedRef: snapshot.snapshotRef, reason: `${created.length} created, ${skipped.length} skipped`, actor, at });
    const r = await refreshInTx(tx, s, actor, job.id, entityId, at);
    return { jobId: job.id, jobCode: job.jobCode, snapshotRef: snapshot.snapshotRef, created, skipped, state: r.state, readiness: r.readiness };
  });
}

type LinePrice = ReturnType<typeof priceQuantity> & { quantityMillis: number; unit: string; measurementSource: string; lineKind: string | null; definitionRef: string | null; definitionVersion: number | null; pricingMethod: string | null };
/** Price one accepted line through the commercial engine (resolveRateForJob: the snapshot's pinned version, at the date of the work). */
async function priceLine(s: BillingScope, jobId: number, c: PricedLine, payload: SnapshotPayload): Promise<LinePrice> {
  const quantityMillis = Math.round((c.line.quantity ?? 0) * 1000);
  const unit = normaliseUnit(c.line.quantityUnit);
  const measurementSource = MEASUREMENT_TO_BASIS[c.line.measurementMethod] ?? "manual_entry";
  const none = (reason: string): LinePrice => ({ outcome: "unknown_rate", amountCents: null, rateMillis: null, billableQuantityMillis: null, minimumApplied: false, incrementApplied: false, formula: "none", inputs: { quantityMillis, unit: c.line.quantityUnit }, reasons: [reason], definition: null, scopeLevel: null, quantityMillis, unit: unit ?? (c.line.quantityUnit ?? "none").slice(0, 20), measurementSource, lineKind: null, definitionRef: null, definitionVersion: null, pricingMethod: null });
  if (!c.line.serviceCode) return none("The line carries no service code — nothing on the rate sheet can be matched to it");
  if (!unit) return none(`The unit "${c.line.quantityUnit ?? ""}" is not one the rate engine knows`);
  const at = c.ticket.completedAt ?? c.ticket.startedAt ?? undefined;
  const res = await resolveRateForJob(s, { jobId, serviceCode: c.line.serviceCode, at });
  const p = priceQuantity(res.resolution, { quantityMillis, unit: unit as Unit, measurementSource: measurementSource as MeasurementBasis });
  const def = p.definition;
  const frozen = def ? payload.rateSheet?.definitions.find(d => d.definitionRef === def.definitionRef) : undefined;
  return { ...p, reasons: [...res.reasons.slice(0, 1), ...p.reasons], quantityMillis, unit, measurementSource, lineKind: frozen?.lineKind ?? def?.lineKind ?? null, definitionRef: def?.definitionRef ?? null, definitionVersion: def?.version ?? null, pricingMethod: def?.pricingMethod ?? null };
}

/**
 * recalculateBilling: re-price every UNBILLED field-ticket charge against the job's CURRENT snapshot (after a
 * correction snapshot, say). Old charges are superseded, never edited; a charge any invoice has consumed is history
 * and is left as it is. Manual charges and approved overrides are a person's decision and are not recalculated.
 */
export async function recalculateBilling(s: BillingScope, actor: Actor, args: { jobId: number; reason: string }, at = new Date()) {
  const job = await jobFor(s, args.jobId);
  const ctx = await getBillableCommercialContext(s, job.id);
  const entityId = await bookForJob(s, job.id, "available" in ctx ? null : ctx);
  const superseded = await s.db.transaction(async tx => {
    const w = await workspaceLocked(tx, job.id, entityId);
    if (w.state === "under_review" || w.state === "approved_for_invoicing") throw precondition(`Job ${job.jobCode} is ${w.state.replace(/_/g, " ")} — return the review before recalculating`);
    const rows = await tx.select().from(billableCharges).where(and(eq(billableCharges.jobId, job.id), eq(billableCharges.sourceKind, "field_ticket_line"), inArray(billableCharges.status, ["ready", "held", "proposed"]))).for("update");
    const out: string[] = [];
    for (const c of rows) {
      if (c.billedQuantityMillis > 0 || c.overrideStatus === "approved" || c.overrideStatus === "pending") continue;
      await tx.update(billableCharges).set({ status: "superseded", rowVersion: c.rowVersion + 1 }).where(eq(billableCharges.id, c.id));
      await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "billable_charge", subjectRef: c.chargeRef, subjectId: c.id, eventType: "charge_superseded", fromStatus: c.status, toStatus: "superseded", jobId: job.id, reason: args.reason, actor, at });
      out.push(c.chargeRef);
    }
    await audit(tx, { financialEntityId: entityId, subjectType: "billing_workspace", subjectRef: w.workspaceRef, subjectId: w.id, eventType: "billing_recalculated", jobId: job.id, reason: args.reason, changes: { superseded: { from: null, to: out } }, actor, at });
    return out;
  });
  const prepared = await prepareBilling(s, actor, { jobId: job.id }, at);
  // link each new charge to the one it replaced, by source line
  for (const n of prepared.created) {
    const row = (await s.db.select().from(billableCharges).where(eq(billableCharges.chargeRef, n.chargeRef)).limit(1))[0]!;
    const old = (await s.db.select({ id: billableCharges.id }).from(billableCharges).where(and(eq(billableCharges.sourceKind, "field_ticket_line"), eq(billableCharges.sourceId, row.sourceId!), eq(billableCharges.status, "superseded"), inArray(billableCharges.chargeRef, superseded.length ? superseded : ["-"]))).orderBy(desc(billableCharges.id)).limit(1))[0];
    if (old) await s.db.update(billableCharges).set({ supersedesChargeId: old.id }).where(and(eq(billableCharges.id, row.id), isNull(billableCharges.supersedesChargeId)));
  }
  return { ...prepared, superseded };
}

/** A charge with no evidence line: a person's, in the job's currency, and billable only once a second person approves it. */
export async function chargeAddManual(s: BillingScope, actor: Actor, args: { jobId: number; description: string; serviceCode?: string | null; quantityMillis: number; unit: string; amountCents: number; reason: string }, at = new Date()) {
  const job = await jobFor(s, args.jobId);
  const ctx = await getBillableCommercialContext(s, job.id);
  if ("available" in ctx) throw precondition(`A manual charge bills under the job's commercial basis: ${ctx.reasons.join("; ")}`);
  const snap = (await s.db.select().from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.snapshotRef, ctx.snapshotRef)).limit(1))[0]!;
  if (!owns(s, snap.financialEntityId)) throw notFound(`Job ${args.jobId}`);
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) throw bad("A manual charge is a positive amount in cents — a reduction is a credit note");
  if (!Number.isInteger(args.quantityMillis) || args.quantityMillis <= 0) throw bad("A manual charge bills a positive quantity");
  return s.db.transaction(async tx => {
    const w = await workspaceLocked(tx, job.id, snap.financialEntityId);
    if (w.state === "approved_for_invoicing") throw precondition("The job is approved for invoicing — return it to add a charge");
    const chargeRef = ref("CHG");
    await tx.insert(billableCharges).values({
      chargeRef, financialEntityId: snap.financialEntityId, jobId: job.id, customerAccountId: snap.billToCustomerAccountId, commercialSnapshotId: snap.id, commercialSnapshotRef: snap.snapshotRef, contractRef: snap.contractRef, rateSheetVersionRef: snap.rateSheetVersionRef,
      sourceKind: "manual", serviceCode: args.serviceCode ?? null, description: args.description.slice(0, 300), quantityMillis: args.quantityMillis, unit: args.unit.slice(0, 20), billableQuantityMillis: args.quantityMillis,
      pricedAmountCents: null, amountCents: args.amountCents, currency: snap.currency, pricingOutcome: "manual", formula: `manual: ${args.reason}`.slice(0, 400), inputsJson: JSON.stringify({ enteredBy: actor.userId }), reasonsJson: JSON.stringify([`Manual charge: ${args.reason}`]),
      status: "proposed", createdByUserId: actor.userId,
    });
    await audit(tx, { financialEntityId: snap.financialEntityId, subjectType: "billable_charge", subjectRef: chargeRef, eventType: "manual_charge_proposed", toStatus: "proposed", jobId: job.id, reason: args.reason, changes: { amountCents: { from: null, to: args.amountCents } }, actor, at });
    await refreshInTx(tx, s, actor, job.id, snap.financialEntityId, at);
    return { chargeRef, status: "proposed" as const };
  });
}
export async function chargeManualDecide(s: BillingScope, actor: Actor, args: { chargeRef: string; decision: "approve" | "refuse"; note: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = await chargeByRef(s, args.chargeRef, tx, true);
    if (c.sourceKind !== "manual" || c.status !== "proposed") throw precondition(`Charge ${c.chargeRef} is not a manual charge awaiting approval`);
    if (c.createdByUserId === actor.userId) throw forbidden("The person who entered a manual charge does not approve it");
    const to = args.decision === "approve" ? "ready" as const : "cancelled" as const;
    await tx.update(billableCharges).set({ status: to, approvedByUserId: args.decision === "approve" ? actor.userId : null, approvedAt: args.decision === "approve" ? at : null, rowVersion: c.rowVersion + 1 }).where(eq(billableCharges.id, c.id));
    await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "billable_charge", subjectRef: c.chargeRef, subjectId: c.id, eventType: args.decision === "approve" ? "manual_charge_approved" : "manual_charge_refused", fromStatus: c.status, toStatus: to, jobId: c.jobId, reason: args.note, actor, at });
    await refreshInTx(tx, s, actor, c.jobId, c.financialEntityId, at);
    return { chargeRef: c.chargeRef, status: to };
  });
}

/** Request a manual override: permission, reason, actor and time, old and new value; effective only after a second person approves. */
export async function chargeOverrideRequest(s: BillingScope, actor: Actor, args: { chargeRef: string; amountCents: number; quantityMillis?: number | null; reason: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = await chargeByRef(s, args.chargeRef, tx, true);
    if (c.status !== "ready" && c.status !== "held") throw precondition(`Charge ${c.chargeRef} is ${c.status}`);
    if (c.overrideStatus === "pending") throw conflict(`Charge ${c.chargeRef} already has an override awaiting approval`);
    const chk = overrideCheck({ requestedByUserId: actor.userId, amountCents: args.amountCents, quantityMillis: args.quantityMillis ?? null, billedAmountCents: c.billedAmountCents, billedQuantityMillis: c.billedQuantityMillis, currentQuantityMillis: c.billableQuantityMillis ?? c.quantityMillis });
    if (!chk.permitted) throw precondition(chk.refusals.join("; "));
    await tx.update(billableCharges).set({ overrideStatus: "pending", overrideAmountCents: args.amountCents, overrideQuantityMillis: args.quantityMillis ?? null, overrideReason: args.reason, overrideRequestedByUserId: actor.userId, overrideRequestedAt: at, overrideDecidedByUserId: null, overrideDecidedAt: null, rowVersion: c.rowVersion + 1 }).where(eq(billableCharges.id, c.id));
    await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "billable_charge", subjectRef: c.chargeRef, subjectId: c.id, eventType: "override_requested", jobId: c.jobId, reason: args.reason, changes: { amountCents: { from: c.amountCents, to: args.amountCents }, billableQuantityMillis: { from: c.billableQuantityMillis, to: args.quantityMillis ?? c.billableQuantityMillis ?? c.quantityMillis } }, actor, at });
    await refreshInTx(tx, s, actor, c.jobId, c.financialEntityId, at);
    return { chargeRef: c.chargeRef, overrideStatus: "pending" as const };
  });
}
export async function chargeOverrideDecide(s: BillingScope, actor: Actor, args: { chargeRef: string; decision: "approve" | "refuse"; note: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = await chargeByRef(s, args.chargeRef, tx, true);
    if (c.overrideStatus !== "pending") throw precondition(`Charge ${c.chargeRef} has no override awaiting a decision`);
    if (c.overrideRequestedByUserId === actor.userId) throw forbidden("The person who requested an override does not approve it");
    if (args.decision === "refuse") {
      await tx.update(billableCharges).set({ overrideStatus: "refused", overrideDecidedByUserId: actor.userId, overrideDecidedAt: at, rowVersion: c.rowVersion + 1 }).where(eq(billableCharges.id, c.id));
      await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "billable_charge", subjectRef: c.chargeRef, subjectId: c.id, eventType: "override_refused", jobId: c.jobId, reason: args.note, actor, at });
    } else {
      const qty = c.overrideQuantityMillis ?? c.billableQuantityMillis ?? c.quantityMillis;
      const chk = overrideCheck({ requestedByUserId: c.overrideRequestedByUserId!, deciderUserId: actor.userId, amountCents: c.overrideAmountCents!, quantityMillis: qty, billedAmountCents: c.billedAmountCents, billedQuantityMillis: c.billedQuantityMillis, currentQuantityMillis: qty });
      if (!chk.permitted) throw precondition(chk.refusals.join("; "));
      await tx.update(billableCharges).set({ overrideStatus: "approved", overrideDecidedByUserId: actor.userId, overrideDecidedAt: at, amountCents: c.overrideAmountCents, billableQuantityMillis: qty, status: "ready", holdReason: null, rowVersion: c.rowVersion + 1 }).where(eq(billableCharges.id, c.id));
      await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "billable_charge", subjectRef: c.chargeRef, subjectId: c.id, eventType: "override_approved", fromStatus: c.status, toStatus: "ready", jobId: c.jobId, reason: args.note, changes: { amountCents: { from: c.amountCents, to: c.overrideAmountCents }, billableQuantityMillis: { from: c.billableQuantityMillis, to: qty } }, actor, at });
    }
    await refreshInTx(tx, s, actor, c.jobId, c.financialEntityId, at);
    return { chargeRef: c.chargeRef, overrideStatus: args.decision === "approve" ? "approved" as const : "refused" as const };
  });
}

/* ------------------------------------------------------------- review, hold */

export async function reviewSubmit(s: BillingScope, actor: Actor, args: { jobId: number; note?: string | null }, at = new Date()) {
  const job = await jobFor(s, args.jobId);
  const ctx = await getBillableCommercialContext(s, job.id);
  const entityId = await bookForJob(s, job.id, "available" in ctx ? null : ctx);
  return s.db.transaction(async tx => {
    const { readiness, state } = await refreshInTx(tx, s, actor, job.id, entityId, at);
    const w = await workspaceLocked(tx, job.id, entityId);
    const supplemental = POST_INVOICE_STATES.includes(state);
    if (!readiness.ready) throw precondition(`Job ${job.jobCode} is not ready to bill: ${readiness.blockers.map(b => b.message).join("; ")}`);
    if (supplemental && readiness.remainingCents <= 0) throw precondition("Nothing on this job remains to bill");
    if (state !== "ready" && !supplemental) throw precondition(`Job ${job.jobCode} is ${state.replace(/_/g, " ")}`);
    await moveWorkspace(tx, s, actor, w, "under_review", "review_submitted", at, { reviewSubmittedByUserId: actor.userId, reviewSubmittedAt: at, reviewDecidedByUserId: null, reviewDecidedAt: null, reviewNote: args.note ?? null }, args.note);
    return { jobId: job.id, state: "under_review" as const, readinessHash: readiness.hash };
  });
}
export async function reviewDecide(s: BillingScope, actor: Actor, args: { jobId: number; decision: "approve" | "return"; note: string }, at = new Date()) {
  const job = await jobFor(s, args.jobId);
  const ctx = await getBillableCommercialContext(s, job.id);
  const entityId = await bookForJob(s, job.id, "available" in ctx ? null : ctx);
  return s.db.transaction(async tx => {
    const w = await workspaceLocked(tx, job.id, entityId);
    if (w.state !== "under_review") throw precondition(`Job ${job.jobCode} is ${w.state.replace(/_/g, " ")}, not under review`);
    if (args.decision === "return") {
      const r = evaluateReadiness((await gatherFacts(s, job.id, tx)).facts);
      const back: WorkspaceState = (await tx.select({ id: invoiceJobLinks.id }).from(invoiceJobLinks).where(eq(invoiceJobLinks.jobId, job.id)).limit(1)).length ? "invoiced" : r.suggestedState;
      const to = workspaceTransition("under_review", back).ok ? back : r.suggestedState;
      await moveWorkspace(tx, s, actor, w, to, "review_returned", at, { reviewDecidedByUserId: actor.userId === w.reviewSubmittedByUserId ? null : actor.userId, reviewDecidedAt: at, reviewNote: args.note }, args.note);
      return { jobId: job.id, state: to };
    }
    if (w.reviewSubmittedByUserId === actor.userId) throw forbidden("The person who submitted the job for review does not approve it");
    const r = evaluateReadiness((await gatherFacts(s, job.id, tx)).facts);
    if (!r.ready) throw precondition(`Readiness changed since submission: ${r.blockers.map(b => b.message).join("; ")}`);
    await moveWorkspace(tx, s, actor, w, "approved_for_invoicing", "review_approved", at, { reviewDecidedByUserId: actor.userId, reviewDecidedAt: at, reviewNote: args.note, readinessHash: r.hash }, args.note);
    return { jobId: job.id, state: "approved_for_invoicing" as const };
  });
}
/** A billing hold on one job. An ACCOUNTING flag: it stops this job's invoicing only, never dispatch or emergency work. */
export async function holdSet(s: BillingScope, actor: Actor, args: { jobId: number; active: boolean; reason: string }, at = new Date()) {
  const job = await jobFor(s, args.jobId);
  const ctx = await getBillableCommercialContext(s, job.id);
  const entityId = await bookForJob(s, job.id, "available" in ctx ? null : ctx);
  return s.db.transaction(async tx => {
    const w = await workspaceLocked(tx, job.id, entityId);
    if (w.holdActive === args.active) throw precondition(args.active ? "Billing is already on hold" : "Billing is not on hold");
    await tx.update(billingWorkspaces).set({ holdActive: args.active, holdReason: args.active ? args.reason : null, holdByUserId: args.active ? actor.userId : null, holdAt: args.active ? at : null, rowVersion: w.rowVersion + 1 }).where(eq(billingWorkspaces.id, w.id));
    await audit(tx, { financialEntityId: entityId, subjectType: "billing_workspace", subjectRef: w.workspaceRef, subjectId: w.id, eventType: args.active ? "hold_placed" : "hold_released", jobId: job.id, reason: args.reason, changes: { holdActive: { from: w.holdActive, to: args.active } }, actor, at });
    const r = await refreshInTx(tx, s, actor, job.id, entityId, at);
    return { jobId: job.id, holdActive: args.active, state: r.state };
  });
}

/* ----------------------------------------------------------------- invoices */

const BILLABLE_FROM: readonly WorkspaceState[] = ["approved_for_invoicing"];

/** Open (or find) the job's billing book — the legacy container every invoice row names. Outside the money transaction: a book is a container, not money. */
async function bookIdFor(s: BillingScope, jobId: number, customer: string): Promise<number> {
  const b = (await s.db.select({ id: billingBooks.id }).from(billingBooks).where(eq(billingBooks.jobId, jobId)).limit(1))[0];
  if (b) return b.id;
  const ins = await s.db.insert(billingBooks).values({ bookNumber: (await nextTrackingNumber(s.db, { sequenceType: "BB" })).trackingNumber, jobId, customer, billingState: "billing_review", openedAt: new Date() });
  return Number(ins[0]?.insertId ?? 0);
}

export type DraftArgs = { jobIds: number[]; slices?: { chargeRef: string; quantityMillis: number }[]; jurisdiction?: string; purchaseOrder?: string | null; afeNumber?: string | null; note?: string | null };
/**
 * Draft an invoice from approved charges — one job or several (same book, bill-to customer and currency), all of
 * a charge or a slice of it. Concurrency-safe: the workspaces and the charges are locked, the slice is computed
 * under the lock, and the table's CHECK refuses consumption beyond the charge if anything slips past.
 */
export async function invoiceDraft(s: BillingScope, actor: Actor, args: DraftArgs, at = new Date()) {
  const jobIds = Array.from(new Set(args.jobIds)).sort((a, b) => a - b);
  if (!jobIds.length) throw bad("Name at least one job");
  const ctxs: { job: typeof jobs.$inferSelect; ctx: BillableCommercialContext; snap: typeof jobCommercialSnapshots.$inferSelect }[] = [];
  for (const id of jobIds) {
    const job = await jobFor(s, id);
    const ctx = await getBillableCommercialContext(s, id);
    if ("available" in ctx) throw precondition(`Job ${job.jobCode}: ${ctx.reasons.join("; ")}`);
    const snap = (await s.db.select().from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.snapshotRef, ctx.snapshotRef)).limit(1))[0]!;
    if (!owns(s, snap.financialEntityId)) throw notFound(`Job ${id}`);
    ctxs.push({ job, ctx, snap });
  }
  const first = ctxs[0]!;
  for (const c of ctxs.slice(1)) {
    if (c.snap.financialEntityId !== first.snap.financialEntityId) throw precondition(`Jobs ${first.job.jobCode} and ${c.job.jobCode} are billed from different books`);
    if (c.snap.billToCustomerAccountId !== first.snap.billToCustomerAccountId) throw precondition(`Jobs ${first.job.jobCode} and ${c.job.jobCode} bill different customers`);
    if (c.snap.currency !== first.snap.currency) throw precondition(`Jobs ${first.job.jobCode} and ${c.job.jobCode} bill in different currencies`);
    if (c.ctx.customer.taxStatus !== first.ctx.customer.taxStatus) throw precondition("The jobs' customer tax status differs between their snapshots — capture a correction snapshot");
  }
  const entityId = first.snap.financialEntityId;
  const jurisdiction = args.jurisdiction ?? "CA-AB";
  const tax = taxDecision({ taxStatus: first.ctx.customer.taxStatus, jurisdiction, rate: await gstRateFor(jurisdiction, at) });
  const billTo = (await s.db.select().from(customerAccounts).where(eq(customerAccounts.id, first.snap.billToCustomerAccountId)).limit(1))[0]!;
  const bookId = await bookIdFor(s, first.job.id, billTo.name);
  await prepareSeries(s.db, s.tenantId, "INV", at);
  const sliceByRef = new Map((args.slices ?? []).map(x => [x.chargeRef, x.quantityMillis]));
  return s.db.transaction(async tx => {
    const wss: WorkspaceRow[] = [];
    for (const c of ctxs) {
      const w = await workspaceLocked(tx, c.job.id, entityId);
      if (!BILLABLE_FROM.includes(w.state)) throw precondition(`Job ${c.job.jobCode} is ${w.state.replace(/_/g, " ")} — a job is invoiced once its billing review is approved`);
      if (w.holdActive) throw precondition(`Job ${c.job.jobCode}'s billing is on hold: ${w.holdReason}`);
      wss.push(w);
    }
    const charges = await tx.select().from(billableCharges).where(and(inArray(billableCharges.jobId, jobIds), eq(billableCharges.status, "ready"))).orderBy(asc(billableCharges.id)).for("update");
    for (const ref_ of Array.from(sliceByRef.keys())) if (!charges.some(c => c.chargeRef === ref_)) throw notFound(`Charge ${ref_} on these jobs`);
    const picked = charges.filter(c => (args.slices ? sliceByRef.has(c.chargeRef) : true) && (c.billableQuantityMillis ?? 0) > c.billedQuantityMillis);
    if (!picked.length) throw precondition("Nothing on these jobs remains to invoice");
    for (const c of picked) if (c.overrideStatus === "pending") throw precondition(`Charge ${c.chargeRef} has an override awaiting approval`);
    const lines: (typeof invoiceLines.$inferInsert)[] = [];
    let subtotal = 0, taxTotal = 0, lineNo = 0;
    const consumption: { c: ChargeRow; q: number; a: number }[] = [];
    for (const c of picked) {
      const sl = sliceCharge({ billableQuantityMillis: c.billableQuantityMillis!, amountCents: c.amountCents!, billedQuantityMillis: c.billedQuantityMillis, billedAmountCents: c.billedAmountCents }, sliceByRef.get(c.chargeRef) ?? null);
      if (!sl.ok) throw precondition(`Charge ${c.chargeRef}: ${sl.reason}`);
      const lineTax = lineTaxCents(sl.amountCents, tax.taxRateBps);
      subtotal += sl.amountCents; taxTotal += lineTax;
      const partial = !(sl.completes && c.billedQuantityMillis === 0);
      lines.push({
        invoiceId: 0, lineNo: ++lineNo, fieldTicketLineId: c.sourceKind === "field_ticket_line" ? c.sourceId : null, pricingDecisionRef: null, serviceCode: c.serviceCode,
        description: (partial ? `${c.description} (part: ${(sl.quantityMillis / 1000).toFixed(3)} of ${((c.billableQuantityMillis ?? 0) / 1000).toFixed(3)} ${c.unit})` : c.description).slice(0, 300),
        quantityMillis: sl.quantityMillis, billableQuantityMillis: sl.quantityMillis, unit: c.unit.slice(0, 20), rateMillis: c.rateMillis, amountCents: sl.amountCents,
        basis: (c.sourceKind === "manual" ? `manual charge ${c.chargeRef}` : `${c.rateSheetVersionRef ?? "no sheet"} ${c.definitionRef ?? ""}`.trim()).slice(0, 160),
        billableChargeId: c.id, jobId: c.jobId, taxCode: tax.taxCode, taxRateBps: tax.taxRateBps, taxCents: lineTax,
        provenanceJson: JSON.stringify({ chargeRef: c.chargeRef, jobId: c.jobId, evidence: c.sourceKind === "field_ticket_line" ? { fieldTicketLineId: c.sourceId, sourceRef: c.sourceRef } : { manual: true, approvedByUserId: c.approvedByUserId }, commercialSnapshotRef: c.commercialSnapshotRef, contractRef: c.contractRef, rateSheetVersionRef: c.rateSheetVersionRef, rateLine: { definitionRef: c.definitionRef, version: c.definitionVersion, scopeLevel: c.scopeLevel, pricingMethod: c.pricingMethod }, inputs: parse(c.inputsJson, {}), formula: c.formula, override: c.overrideStatus === "approved" ? { reason: c.overrideReason, by: c.overrideRequestedByUserId, approvedBy: c.overrideDecidedByUserId, pricedAmountCents: c.pricedAmountCents } : null, slice: { quantityMillis: sl.quantityMillis, of: c.billableQuantityMillis, amountCents: sl.amountCents, of_amount: c.amountCents } }),
      });
      consumption.push({ c, q: sl.quantityMillis, a: sl.amountCents });
    }
    const minted = await mintScopedNumber(tx, s, "INV", { recordType: "invoice", actorUserId: actor.userId, at });
    const po = first.ctx.purchaseOrder?.poNumber ?? first.ctx.references.find(r => r.referenceKind === "po")?.referenceValue ?? args.purchaseOrder ?? null;
    const afe = first.ctx.references.find(r => r.referenceKind === "afe")?.referenceValue ?? first.ctx.purchaseOrder?.afeNumber ?? args.afeNumber ?? null;
    const ins = await tx.insert(invoices).values({
      invoiceNumber: minted.number, numberScope: minted.numberScope, numberAllocationRef: minted.allocationRef, origin: "billing_charges", financialEntityId: entityId, billingBookId: bookId, jobId: first.job.id,
      customer: billTo.name, customerAccountId: billTo.id, afeNumber: afe, purchaseOrder: po, customerPurchaseOrderId: first.snap.purchaseOrderId, subtotalCents: subtotal, taxCents: taxTotal, totalCents: subtotal + taxTotal,
      gstTreatment: first.ctx.customer.taxStatus === "taxable" ? "taxable" : first.ctx.customer.taxStatus === "zero_rated" ? "zero_rated" : first.ctx.customer.taxStatus === "exempt" ? "exempt" : "unknown", gstTreatmentSource: "commercial_snapshot",
      taxCode: tax.taxCode, taxRateBps: tax.taxRateBps, taxJurisdiction: jurisdiction, paymentTermsDays: first.ctx.paymentTermsDays, currency: first.snap.currency, status: "draft", draftedByUserId: actor.userId,
    });
    const invoiceId = Number(ins[0]?.insertId ?? 0);
    await bindNumber(tx, minted.allocationRef, invoiceId);
    await tx.insert(invoiceLines).values(lines.map(l => ({ ...l, invoiceId })));
    for (const { c, q, a } of consumption) {
      await tx.update(billableCharges).set({ billedQuantityMillis: c.billedQuantityMillis + q, billedAmountCents: c.billedAmountCents + a, rowVersion: c.rowVersion + 1 }).where(and(eq(billableCharges.id, c.id), eq(billableCharges.rowVersion, c.rowVersion)));
      await audit(tx, { financialEntityId: entityId, subjectType: "billable_charge", subjectRef: c.chargeRef, subjectId: c.id, eventType: "charge_invoiced", jobId: c.jobId, relatedRef: minted.number, changes: { billedQuantityMillis: { from: c.billedQuantityMillis, to: c.billedQuantityMillis + q }, billedAmountCents: { from: c.billedAmountCents, to: c.billedAmountCents + a } }, actor, at });
    }
    for (const w of wss) {
      await tx.insert(invoiceJobLinks).values({ invoiceId, jobId: w.jobId });
      if (w.state !== "invoiced") await moveWorkspace(tx, s, actor, w, "invoiced", "invoiced", at, {}, `Invoice ${minted.number}`);
    }
    await audit(tx, { financialEntityId: entityId, subjectType: "invoice", subjectRef: minted.number, subjectId: invoiceId, eventType: "invoice_created", toStatus: "draft", jobId: first.job.id, relatedRef: minted.allocationRef, reason: args.note ?? null, changes: { subtotalCents: { from: null, to: subtotal }, taxCents: { from: null, to: taxTotal }, taxCode: { from: null, to: tax.taxCode }, jobs: { from: null, to: ctxs.map(c => c.job.jobCode) } }, actor, at });
    return { invoiceNumber: minted.number, status: "draft" as const, subtotalCents: subtotal, taxCents: taxTotal, totalCents: subtotal + taxTotal, currency: first.snap.currency, taxCode: tax.taxCode, taxDetermined: tax.determined, taxReason: tax.reason, lines: lines.length, jobs: ctxs.map(c => c.job.jobCode) };
  });
}

/** Recalculate a DRAFT: re-determine its tax (a rate verified since drafting) and re-add its lines. An issued invoice is never recalculated. */
export async function invoiceRecalculate(s: BillingScope, actor: Actor, args: { invoiceNumber: string; jurisdiction?: string }, at = new Date()) {
  const pre = await invoiceByNumber(s, args.invoiceNumber);
  const jurisdiction = args.jurisdiction ?? pre.taxJurisdiction ?? "CA-AB";
  const rate = await gstRateFor(jurisdiction, at);
  const snap = pre.jobId ? await getBillableCommercialContext(s, pre.jobId) : null;
  const taxStatus = snap && !("available" in snap) ? snap.customer.taxStatus : (await s.db.select({ t: customerAccounts.taxStatus }).from(customerAccounts).where(eq(customerAccounts.id, pre.customerAccountId!)).limit(1))[0]?.t ?? "unknown";
  const tax = taxDecision({ taxStatus, jurisdiction, rate });
  return s.db.transaction(async tx => {
    const inv = await invoiceByNumber(s, args.invoiceNumber, tx, true);
    if (inv.origin !== "billing_charges") throw precondition("Only a billing invoice is recalculated here");
    if (inv.status !== "draft") throw precondition(`Invoice ${inv.invoiceNumber} is ${inv.status.replace(/_/g, " ")} — an issued or submitted invoice is never rewritten; return it to draft or correct it with a credit note`);
    const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const subtotal = sum(ls.map(l => l.amountCents));
    let taxTotal = 0;
    for (const l of ls) { const t = lineTaxCents(l.amountCents, tax.taxRateBps); taxTotal += t; await tx.update(invoiceLines).set({ taxCode: tax.taxCode, taxRateBps: tax.taxRateBps, taxCents: t }).where(eq(invoiceLines.id, l.id)); }
    await tx.update(invoices).set({ subtotalCents: subtotal, taxCents: taxTotal, totalCents: subtotal + taxTotal, taxCode: tax.taxCode, taxRateBps: tax.taxRateBps, taxJurisdiction: jurisdiction, rowVersion: inv.rowVersion + 1 }).where(eq(invoices.id, inv.id));
    await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "invoice", subjectRef: inv.invoiceNumber, subjectId: inv.id, eventType: "invoice_recalculated", jobId: inv.jobId, changes: { subtotalCents: { from: inv.subtotalCents, to: subtotal }, taxCents: { from: inv.taxCents, to: taxTotal }, taxCode: { from: inv.taxCode, to: tax.taxCode } }, reason: tax.reason, actor, at });
    return { invoiceNumber: inv.invoiceNumber, subtotalCents: subtotal, taxCents: taxTotal, totalCents: subtotal + taxTotal, taxCode: tax.taxCode, taxDetermined: tax.determined, taxReason: tax.reason };
  });
}

async function moveInvoice(tx: Tx, actor: Actor, inv: InvoiceRow, event: "submit" | "return" | "approve" | "issue" | "void", at: Date, set: Partial<typeof invoices.$inferInsert>, reason?: string | null) {
  const t = invoiceTransition(inv.status, event);
  if (!t.ok) throw precondition(t.reason);
  const r = await tx.update(invoices).set({ ...set, status: t.to, rowVersion: inv.rowVersion + 1 }).where(and(eq(invoices.id, inv.id), eq(invoices.rowVersion, inv.rowVersion)));
  if (((r as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 1) !== 1) throw conflict(`Invoice ${inv.invoiceNumber} changed while this was decided — reload it`);
  await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "invoice", subjectRef: inv.invoiceNumber, subjectId: inv.id, eventType: `invoice_${event === "submit" ? "submitted" : event === "return" ? "returned" : event === "approve" ? "approved" : event === "issue" ? "issued" : "voided"}`, fromStatus: inv.status, toStatus: t.to, jobId: inv.jobId, reason: reason ?? null, actor, at });
  return t.to;
}
function billingOnly(inv: InvoiceRow) { if (inv.origin !== "billing_charges") throw precondition(`Invoice ${inv.invoiceNumber} was drafted from a field ticket; it follows the field-ticket path (invoicing.*)`); }

export async function invoiceSubmit(s: BillingScope, actor: Actor, args: { invoiceNumber: string; expectedRowVersion?: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const inv = await invoiceByNumber(s, args.invoiceNumber, tx, true); billingOnly(inv);
    if (args.expectedRowVersion != null && args.expectedRowVersion !== inv.rowVersion) throw conflict(`Invoice ${inv.invoiceNumber} changed since it was read`);
    const status = await moveInvoice(tx, actor, inv, "submit", at, { submittedByUserId: actor.userId, submittedAt: at });
    return { invoiceNumber: inv.invoiceNumber, status };
  });
}
export async function invoiceReturn(s: BillingScope, actor: Actor, args: { invoiceNumber: string; reason: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const inv = await invoiceByNumber(s, args.invoiceNumber, tx, true); billingOnly(inv);
    const status = await moveInvoice(tx, actor, inv, "return", at, { submittedByUserId: null, submittedAt: null }, args.reason);
    return { invoiceNumber: inv.invoiceNumber, status };
  });
}

/** Supporting documents BY REFERENCE: the evidence chain's own records, never copies of their blobs. */
export async function supportingDocuments(s: BillingScope, invoiceId: number, d: DbOrTx = s.db) {
  const jobIds = (await d.select({ jobId: invoiceJobLinks.jobId }).from(invoiceJobLinks).where(eq(invoiceJobLinks.invoiceId, invoiceId))).map(r => r.jobId);
  if (!jobIds.length) return { fieldTickets: [], ticketDocuments: [], disposalTickets: [], commercialSnapshots: [] };
  const tickets = await d.select({ id: fieldTickets.id, ticketNumber: fieldTickets.ticketNumber, jobId: fieldTickets.jobId, status: fieldTickets.status, signatureStatus: fieldTickets.signatureStatus }).from(fieldTickets).where(inArray(fieldTickets.jobId, jobIds));
  const docs = tickets.length ? await d.select({ documentRef: fieldTicketDocuments.documentRef, kind: fieldTicketDocuments.kind, contentHash: fieldTicketDocuments.contentHash, fieldTicketId: fieldTicketDocuments.fieldTicketId }).from(fieldTicketDocuments).where(inArray(fieldTicketDocuments.fieldTicketId, tickets.map(t => t.id))) : [];
  const disposal = await d.select({ ticketNumber: disposalTickets.ticketNumber, jobId: disposalTickets.jobId, verificationStatus: disposalTickets.verificationStatus, facilityTicketNumber: disposalTickets.facilityTicketNumber }).from(disposalTickets).where(inArray(disposalTickets.jobId, jobIds));
  const charges = await d.select({ commercialSnapshotRef: billableCharges.commercialSnapshotRef }).from(billableCharges).innerJoin(invoiceLines, eq(invoiceLines.billableChargeId, billableCharges.id)).where(eq(invoiceLines.invoiceId, invoiceId));
  const snapRefs = Array.from(new Set(charges.map(c => c.commercialSnapshotRef).filter((x): x is string => !!x)));
  const snaps = snapRefs.length ? await d.select({ snapshotRef: jobCommercialSnapshots.snapshotRef, payloadHash: jobCommercialSnapshots.payloadHash, jobId: jobCommercialSnapshots.jobId }).from(jobCommercialSnapshots).where(inArray(jobCommercialSnapshots.snapshotRef, snapRefs)) : [];
  return { fieldTickets: tickets, ticketDocuments: docs.filter(x => x.kind !== "invoice"), disposalTickets: disposal, commercialSnapshots: snaps };
}

/** Approve: a second person freezes the billing snapshot — provenance, commercial snapshots, tax and supporting-document references. */
export async function invoiceApprove(s: BillingScope, actor: Actor, args: { invoiceNumber: string; expectedRowVersion?: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const inv = await invoiceByNumber(s, args.invoiceNumber, tx, true); billingOnly(inv);
    if (args.expectedRowVersion != null && args.expectedRowVersion !== inv.rowVersion) throw conflict(`Invoice ${inv.invoiceNumber} changed since it was read`);
    const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(asc(invoiceLines.lineNo));
    const chk = approvalCheck({ submittedByUserId: inv.submittedByUserId, draftedByUserId: inv.draftedByUserId, approverUserId: actor.userId, taxCode: inv.taxCode, lineCount: ls.length, totalCents: inv.totalCents, subtotalCents: inv.subtotalCents, taxCents: inv.taxCents, lineSumCents: sum(ls.map(l => l.amountCents)), lineTaxSumCents: sum(ls.map(l => l.taxCents ?? 0)) });
    if (inv.status === "in_review" && !chk.permitted) {
      if (chk.refusals.some(r => r.startsWith("The person who submitted"))) throw forbidden(chk.refusals.join("; "));
      throw precondition(chk.refusals.join("; "));
    }
    const docs = await supportingDocuments(s, inv.id, tx);
    const sourceFacts = { schema: "billing-invoice-snapshot/1", invoiceNumber: inv.invoiceNumber, numberScope: inv.numberScope, provenance: ls.map(l => ({ lineNo: l.lineNo, ...parse<Record<string, unknown>>(l.provenanceJson, {}) })), supportingDocuments: docs };
    const calculated = { lines: ls.map(l => ({ lineNo: l.lineNo, description: l.description, billableQuantityMillis: l.billableQuantityMillis, unit: l.unit, rateMillis: l.rateMillis, amountCents: l.amountCents, basis: l.basis, taxCode: l.taxCode, taxRateBps: l.taxRateBps, taxCents: l.taxCents })), taxCode: inv.taxCode, taxRateBps: inv.taxRateBps, taxJurisdiction: inv.taxJurisdiction, ratePercent: inv.taxRateBps != null ? inv.taxRateBps / 100 : null, subtotalCents: inv.subtotalCents, taxCents: inv.taxCents, totalCents: inv.totalCents, currency: inv.currency, gstTreatment: inv.gstTreatment };
    const payloadHash = canonicalHash({ sourceFacts, calculated });
    const status = await moveInvoice(tx, actor, inv, "approve", at, { approvedByUserId: actor.userId, approvedAt: at });
    const rateVersions = Array.from(new Set(ls.map(l => parse<{ rateSheetVersionRef?: string }>(l.provenanceJson, {}).rateSheetVersionRef).filter(Boolean))).join(",");
    await tx.insert(billingSnapshots).values({ invoiceId: inv.id, billingBookId: inv.billingBookId, capturedAt: at, capturedByUserId: actor.userId, rateCardVersion: rateVersions.slice(0, 64) || null, sourceFactsJson: JSON.stringify(sourceFacts), calculatedLinesJson: JSON.stringify(calculated), excludedLinesJson: "[]", subtotalCents: inv.subtotalCents, totalCents: inv.totalCents, payloadHash });
    await emit(tx, { tenantId: s.tenantId, type: "invoice.approved", entityType: "invoice", entityId: inv.invoiceNumber, actor, jobId: inv.jobId, payload: { invoiceNumber: inv.invoiceNumber, totalCents: inv.totalCents, currency: inv.currency, payloadHash }, at });
    return { invoiceNumber: inv.invoiceNumber, status, payloadHash };
  });
}

/** The invoice document's lines, from the FROZEN snapshot only. Customer descriptions; no internal provenance. */
function documentLines(inv: InvoiceRow, calc: { lines: { lineNo: number; description: string; billableQuantityMillis: number; unit: string; rateMillis: number | null; amountCents: number; taxCode: string | null; taxCents: number | null }[]; subtotalCents: number; taxCents: number; totalCents: number; taxCode: string | null; ratePercent: number | null }, hash: string, dueAt: Date): string[] {
  const money = (c: number) => `${inv.currency} ${(c / 100).toFixed(2)}`;
  const out = [`INVOICE ${inv.invoiceNumber}`, `Bill to: ${inv.customer}`, `Issued: ${new Date().toISOString().slice(0, 10)}    Due: ${dueAt.toISOString().slice(0, 10)}`];
  if (inv.purchaseOrder) out.push(`PO: ${inv.purchaseOrder}`);
  if (inv.afeNumber) out.push(`AFE: ${inv.afeNumber}`);
  out.push("");
  for (const l of calc.lines) out.push(`${l.lineNo}. ${l.description}: ${(l.billableQuantityMillis / 1000).toFixed(3)} ${l.unit}${l.rateMillis != null ? ` @ ${(l.rateMillis / 1000).toFixed(2)}/${l.unit}` : ""} = ${money(l.amountCents)}`);
  out.push("", `Subtotal: ${money(calc.subtotalCents)}`, `Tax (${calc.taxCode ?? "—"}${calc.ratePercent != null ? ` ${calc.ratePercent}%` : ""}): ${money(calc.taxCents)}`, `Total: ${money(calc.totalCents)}`, "", `Snapshot ${hash}`);
  return out;
}

/**
 * Issue: the approved invoice is rendered from its frozen snapshot, stored, registered in Document Control (the
 * invoice definition, domain-numbered), dated, and becomes a receivable. Its export record is queued.
 */
export async function invoiceIssue(s: BillingScope, actor: Actor, args: { invoiceNumber: string }, at = new Date()) {
  const pre = await invoiceByNumber(s, args.invoiceNumber); billingOnly(pre);
  if (pre.status !== "approved") throw precondition(`An invoice that is ${pre.status.replace(/_/g, " ")} cannot be issued — it is approved by a second person first`);
  const snap = (await s.db.select().from(billingSnapshots).where(eq(billingSnapshots.invoiceId, pre.id)).orderBy(desc(billingSnapshots.id)).limit(1))[0];
  if (!snap) throw precondition("The invoice has no frozen snapshot");
  const dueAt = new Date(at.getTime() + (pre.paymentTermsDays ?? 30) * 86_400_000);
  const bytes = renderPdf(`Invoice ${pre.invoiceNumber}`, documentLines(pre, JSON.parse(snap.calculatedLinesJson), snap.payloadHash, dueAt));
  const contentHash = sha256Hex(bytes);
  const stored = await storagePut(`invoices/${pre.numberScope}/${pre.invoiceNumber}/${contentHash.slice(0, 12)}.pdf`, bytes, "application/pdf");
  const result = await s.db.transaction(async tx => {
    const inv = await invoiceByNumber(s, args.invoiceNumber, tx, true);
    await assertPeriodOpen(inv.financialEntityId!, at, `Issue of invoice ${inv.invoiceNumber}`);
    const status = await moveInvoice(tx, actor, inv, "issue", at, { issuedAt: at, sentAt: at, dueAt, issuedByUserId: actor.userId });
    await emit(tx, { tenantId: s.tenantId, type: "invoice.issued", entityType: "invoice", entityId: inv.invoiceNumber, actor, jobId: inv.jobId, payload: { invoiceNumber: inv.invoiceNumber, totalCents: inv.totalCents, currency: inv.currency, dueAt: dueAt.toISOString(), contentHash }, at });
    await queueExport(tx, inv.financialEntityId!, "invoice", inv.id, inv.invoiceNumber, { invoiceNumber: inv.invoiceNumber, numberScope: inv.numberScope, customerAccountId: inv.customerAccountId, issuedAt: at.toISOString(), dueAt: dueAt.toISOString(), currency: inv.currency, subtotalCents: inv.subtotalCents, taxCents: inv.taxCents, totalCents: inv.totalCents, taxCode: inv.taxCode, status: "issued", snapshotHash: snap.payloadHash });
    return { status };
  });
  let document: { documentRef: string | null; registered: boolean; error: string | null } = { documentRef: null, registered: false, error: null };
  try {
    const jobLinks = (await s.db.select({ jobId: invoiceJobLinks.jobId }).from(invoiceJobLinks).where(eq(invoiceJobLinks.invoiceId, pre.id))).map(r => r.jobId);
    const jobCodes = jobLinks.length ? await s.db.select({ id: jobs.id, jobCode: jobs.jobCode }).from(jobs).where(inArray(jobs.id, jobLinks)) : [];
    const reg = await registerControlledDocument(s.db, {
      book: { bookOrgRef: s.tenantId === "default" ? null : s.tenantId }, actor: { userId: actor.userId, source: "system" }, definitionKey: "invoice", title: `Invoice ${pre.invoiceNumber}`, originKind: "system_rendered",
      issuer: { issuerKind: "tenant", issuerOrgRef: s.tenantId === "default" ? null : s.tenantId }, contentHash, sourceSnapshotHash: snap.payloadHash, byteLength: bytes.length, mimeType: "application/pdf", storageKey: stored.key, issuedAt: at,
      controlNumber: pre.invoiceNumber, requestedState: "issued", importChannel: "system",
      links: [{ recordType: "invoice", recordRef: pre.invoiceNumber, recordId: pre.id, role: "subject" }, ...jobCodes.map(j => ({ recordType: "job", recordRef: j.jobCode, recordId: j.id, role: "related" }))],
    });
    document = { documentRef: reg.documentRef, registered: true, error: null };
  } catch (e) { document = { documentRef: null, registered: false, error: e instanceof Error ? e.message : String(e) }; }
  return { invoiceNumber: pre.invoiceNumber, status: result.status, issuedAt: at, dueAt, contentHash, storageKey: stored.key, document };
}

/** Void: recorded on the invoice, never a delete; refused where money is applied (that is a credit note). Releases the charges it consumed. */
export async function invoiceVoid(s: BillingScope, actor: Actor, args: { invoiceNumber: string; reason: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const inv = await invoiceByNumber(s, args.invoiceNumber, tx, true); billingOnly(inv);
    const allocated = sum((await tx.select({ a: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.invoiceId, inv.id))).map(r => r.a));
    const credited = sum((await tx.select({ a: customerCredits.amountCents }).from(customerCredits).where(and(eq(customerCredits.invoiceId, inv.id), eq(customerCredits.status, "approved")))).map(r => r.a));
    // An unissued billing invoice (a draft, one in review, one approved) carries no money and is voided freely; an issued one only where none is applied.
    const chk = isIssued(inv) ? voidCheck({ status: inv.status, allocatedCents: allocated, approvedCreditCents: credited }) : { permitted: allocated === 0 && credited === 0, refusals: ["Money is applied to an invoice that was never issued — reverse it first"] };
    if (!chk.permitted) throw precondition(chk.refusals.join("; "));
    if (inv.issuedAt) await assertPeriodOpen(inv.financialEntityId!, inv.issuedAt, `Void of invoice ${inv.invoiceNumber}`);
    await moveInvoice(tx, actor, inv, "void", at, { voidedAt: at, voidedByUserId: actor.userId, voidReason: args.reason }, args.reason);
    const ls = await tx.select().from(invoiceLines).where(and(eq(invoiceLines.invoiceId, inv.id), isNull(invoiceLines.releasedAt)));
    const chargeIds = ls.map(l => l.billableChargeId).filter((x): x is number => x != null).sort((a, b) => a - b);
    const cs = chargeIds.length ? await tx.select().from(billableCharges).where(inArray(billableCharges.id, chargeIds)).orderBy(asc(billableCharges.id)).for("update") : [];
    for (const l of ls) {
      const c = cs.find(x => x.id === l.billableChargeId);
      if (c) {
        const nq = c.billedQuantityMillis - l.billableQuantityMillis, na = c.billedAmountCents - l.amountCents;
        await tx.update(billableCharges).set({ billedQuantityMillis: nq, billedAmountCents: na, rowVersion: c.rowVersion + 1 }).where(eq(billableCharges.id, c.id));
        c.billedQuantityMillis = nq; c.billedAmountCents = na; c.rowVersion += 1;
        await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "billable_charge", subjectRef: c.chargeRef, subjectId: c.id, eventType: "charge_released", jobId: c.jobId, relatedRef: inv.invoiceNumber, reason: args.reason, actor, at });
      }
    }
    await tx.update(invoiceLines).set({ releasedAt: at }).where(and(eq(invoiceLines.invoiceId, inv.id), isNull(invoiceLines.releasedAt)));
    await voidBoundNumber(tx, { numberScope: inv.numberScope, allocationRef: inv.numberAllocationRef, reason: `Invoice voided: ${args.reason}`, actorUserId: actor.userId, at });
    if (inv.issuedAt) await queueExport(tx, inv.financialEntityId!, "invoice", inv.id, inv.invoiceNumber, { invoiceNumber: inv.invoiceNumber, numberScope: inv.numberScope, status: "void", voidedAt: at.toISOString(), reason: args.reason, totalCents: inv.totalCents, currency: inv.currency });
    // a job whose only live invoice this was returns to approved-for-invoicing
    for (const { jobId } of await tx.select({ jobId: invoiceJobLinks.jobId }).from(invoiceJobLinks).where(eq(invoiceJobLinks.invoiceId, inv.id))) {
      const other = await tx.select({ id: invoices.id }).from(invoices).innerJoin(invoiceJobLinks, eq(invoiceJobLinks.invoiceId, invoices.id)).where(and(eq(invoiceJobLinks.jobId, jobId), ne(invoices.id, inv.id), ne(invoices.status, "void"))).limit(1);
      const w = await workspaceLocked(tx, jobId, inv.financialEntityId!);
      if (!other.length && POST_INVOICE_STATES.includes(w.state)) await moveWorkspace(tx, s, actor, w, "approved_for_invoicing", "invoice_voided", at, {}, `Invoice ${inv.invoiceNumber} voided: ${args.reason}`);
      else await syncWorkspaceFromAr(tx, s, actor, jobId, inv.financialEntityId!, at);
    }
    return { invoiceNumber: inv.invoiceNumber, status: "void" as const, releasedLines: ls.length };
  });
}

/* -------------------------------------------------------------- receivables */

type ArPieces = { netAllocatedCents: number; approvedCreditCents: number; pendingCreditCents: number; approvedAdjustmentCents: number; openDispute: boolean };
async function arPieces(d: DbOrTx, invoiceIds: number[]): Promise<Map<number, ArPieces>> {
  const out = new Map<number, ArPieces>(invoiceIds.map(id => [id, { netAllocatedCents: 0, approvedCreditCents: 0, pendingCreditCents: 0, approvedAdjustmentCents: 0, openDispute: false }]));
  if (!invoiceIds.length) return out;
  const [allocs, creds, adjs, disputes] = await Promise.all([
    d.select({ invoiceId: paymentAllocations.invoiceId, a: paymentAllocations.amountCents }).from(paymentAllocations).where(inArray(paymentAllocations.invoiceId, invoiceIds)),
    d.select({ invoiceId: customerCredits.invoiceId, a: customerCredits.amountCents, status: customerCredits.status }).from(customerCredits).where(inArray(customerCredits.invoiceId, invoiceIds)),
    d.select({ invoiceId: invoiceAdjustments.invoiceId, a: invoiceAdjustments.amountCents }).from(invoiceAdjustments).where(and(inArray(invoiceAdjustments.invoiceId, invoiceIds), eq(invoiceAdjustments.status, "approved"))),
    d.select({ invoiceId: disputeCases.invoiceId }).from(disputeCases).where(and(inArray(disputeCases.invoiceId, invoiceIds), sql`${disputeCases.openKey} IS NOT NULL`)),
  ]);
  for (const a of allocs) out.get(a.invoiceId)!.netAllocatedCents += a.a;
  for (const c of creds) { const p = out.get(c.invoiceId!)!; if (c.status === "approved") p.approvedCreditCents += c.a; else if (c.status === "requested") p.pendingCreditCents += c.a; }
  for (const a of adjs) out.get(a.invoiceId)!.approvedAdjustmentCents += a.a;
  for (const x of disputes) out.get(x.invoiceId!)!.openDispute = true;
  return out;
}
function receivableOf(inv: InvoiceRow, p: ArPieces, asOf: Date): Receivable {
  return receivable({ totalCents: inv.totalCents, status: inv.status, dueAt: inv.dueAt, issuedAt: inv.issuedAt, issued: isIssued(inv), asOf, ...p });
}
async function receivableFor(d: DbOrTx, inv: InvoiceRow, asOf = new Date()): Promise<Receivable> {
  return receivableOf(inv, (await arPieces(d, [inv.id])).get(inv.id)!, asOf);
}
/** Set the invoice's status from its AR records (paid / partially paid / back to its delivery state). Disputes and voids are not decided here. */
async function settleInvoiceStatus(tx: Tx, s: BillingScope, actor: Actor, inv: InvoiceRow, at: Date): Promise<{ status: string; receivable: Receivable }> {
  const r = await receivableFor(tx, inv, at);
  const next = invoiceStatusFromBalance(inv.status, r, deliveryState(inv));
  if (next !== inv.status) {
    await tx.update(invoices).set({ status: next as InvoiceRow["status"], rowVersion: inv.rowVersion + 1 }).where(eq(invoices.id, inv.id));
    await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "invoice", subjectRef: inv.invoiceNumber, subjectId: inv.id, eventType: "invoice_settled", fromStatus: inv.status, toStatus: next, jobId: inv.jobId, actor, at });
    if (next === "paid") await emit(tx, { tenantId: s.tenantId, type: "invoice.paid", entityType: "invoice", entityId: inv.invoiceNumber, actor, jobId: inv.jobId, payload: { invoiceNumber: inv.invoiceNumber, totalCents: inv.totalCents, currency: inv.currency }, at });
  }
  for (const { jobId } of await tx.select({ jobId: invoiceJobLinks.jobId }).from(invoiceJobLinks).where(eq(invoiceJobLinks.invoiceId, inv.id))) await syncWorkspaceFromAr(tx, s, actor, jobId, inv.financialEntityId!, at);
  return { status: next, receivable: r };
}
/** The job's billing state follows its invoices' AR picture once it is invoiced. */
async function syncWorkspaceFromAr(tx: Tx, s: BillingScope, actor: Actor, jobId: number, financialEntityId: number, at: Date): Promise<void> {
  const w = (await tx.select().from(billingWorkspaces).where(eq(billingWorkspaces.jobId, jobId)).for("update").limit(1))[0];
  if (!w || !POST_INVOICE_STATES.includes(w.state)) return;
  const invs = await tx.select().from(invoices).innerJoin(invoiceJobLinks, eq(invoiceJobLinks.invoiceId, invoices.id)).where(and(eq(invoiceJobLinks.jobId, jobId), ne(invoices.status, "void")));
  const rows = invs.map(r => r.invoices);
  const pieces = await arPieces(tx, rows.map(i => i.id));
  const rs = rows.map(i => ({ i, r: receivableOf(i, pieces.get(i.id)!, at) }));
  const issued = rs.filter(x => isIssued(x.i));
  let to: WorkspaceState = "invoiced";
  if (rs.some(x => x.r.arStatus === "disputed")) to = "disputed";
  else if (issued.length && issued.every(x => x.r.outstandingCents <= 0) && issued.length === rs.length) to = issued.some(x => x.r.paidCents > 0) ? "paid" : "credited";
  else if (issued.some(x => x.r.paidCents > 0)) to = "partially_paid";
  else if (issued.some(x => x.r.creditedCents > 0)) to = "credited";
  if (to !== w.state && workspaceTransition(w.state, to).ok) await moveWorkspace(tx, s, actor, w, to, "ar_state_changed", at);
}

/* ---------------------------------------------------------------- payments */

export type PaymentInput = { financialEntityId: number; accountRef: string; receivedAt: Date; amountCents: number; currency?: string; method: "eft" | "cheque" | "card" | "cash" | "other" | "wire" | "import"; reference?: string | null; payerName?: string | null; notes?: string | null; source?: "manual" | "import" | "bank_match" | "portal"; idempotencyKey?: string | null; evidenceRecordId?: number | null };
/** Record a payment received: unapplied until allocated. Idempotent on (book, key): an import replayed is the same payment, never a second one. */
export async function paymentRecord(s: BillingScope, actor: Actor, a: PaymentInput, at = new Date()) {
  if (!owns(s, a.financialEntityId)) throw notFound(`Financial entity ${a.financialEntityId}`);
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) throw bad("A payment is a positive amount in cents");
  if (a.method === "card" && a.reference && /\b\d{13,19}\b/.test(a.reference.replace(/[\s-]/g, ""))) throw bad("A card payment records an authorization or receipt reference — never a card number");
  const account = (await s.db.select().from(customerAccounts).where(and(eq(customerAccounts.accountRef, a.accountRef), eq(customerAccounts.financialEntityId, a.financialEntityId))).limit(1))[0];
  if (!account) throw notFound(`Customer ${a.accountRef}`);
  const currency = a.currency ?? account.defaultCurrency;
  const replay = async () => {
    if (!a.idempotencyKey) return null;
    const p = (await s.db.select().from(customerPayments).where(and(eq(customerPayments.financialEntityId, a.financialEntityId), eq(customerPayments.idempotencyKey, a.idempotencyKey))).limit(1))[0];
    if (!p) return null;
    if (p.amountCents !== a.amountCents || p.customerAccountId !== account.id || p.currency !== currency) throw conflict(`Idempotency key ${a.idempotencyKey} was already used for a different payment (${p.paymentRef})`);
    return { paymentRef: p.paymentRef, status: p.status, replayed: true as const };
  };
  const prior = await replay();
  if (prior) return prior;
  await assertPeriodOpen(a.financialEntityId, a.receivedAt, "Customer payment");
  try {
    return await s.db.transaction(async tx => {
      const paymentRef = ref("PAY");
      const ins = await tx.insert(customerPayments).values({ paymentRef, financialEntityId: a.financialEntityId, customer: account.name, customerAccountId: account.id, receivedAt: a.receivedAt, amountCents: a.amountCents, currency, method: a.method, reference: a.reference ?? null, payerName: a.payerName ?? null, notes: a.notes ?? null, source: a.source ?? "manual", idempotencyKey: a.idempotencyKey ?? null, recordedByUserId: actor.userId, evidenceRecordId: a.evidenceRecordId ?? null });
      const id = Number(ins[0]?.insertId ?? 0);
      await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "customer_payment", subjectRef: paymentRef, subjectId: id, eventType: "payment_recorded", toStatus: "unapplied", reason: a.notes ?? null, changes: { amountCents: { from: null, to: a.amountCents }, method: { from: null, to: a.method }, customer: { from: null, to: account.accountRef } }, actor, at });
      await emit(tx, { tenantId: s.tenantId, type: "payment.received", entityType: "customer_payment", entityId: paymentRef, actor, payload: { paymentRef, accountRef: account.accountRef, amountCents: a.amountCents, currency, method: a.method, receivedAt: a.receivedAt.toISOString() }, at });
      await queueExport(tx, a.financialEntityId, "payment", id, paymentRef, { paymentRef, accountRef: account.accountRef, receivedAt: a.receivedAt.toISOString(), amountCents: a.amountCents, currency, method: a.method, reference: a.reference ?? null });
      return { paymentRef, status: "unapplied" as const, replayed: false as const };
    });
  } catch (e) {
    // two imports of the same key racing: the loser reads the winner's row
    if (a.idempotencyKey && /Duplicate entry/i.test(String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error).message))) { const p = await replay(); if (p) return p; }
    throw e;
  }
}

async function paymentByRef(s: BillingScope, paymentRef: string, d: DbOrTx, lock: boolean) {
  const q = d.select().from(customerPayments).where(eq(customerPayments.paymentRef, paymentRef)).limit(1);
  const p = (lock ? await q.for("update") : await q)[0];
  if (!p || !owns(s, p.financialEntityId)) throw notFound(`Payment ${paymentRef}`);
  return p;
}
async function paymentNetAllocated(d: DbOrTx, paymentId: number): Promise<number> {
  return sum((await d.select({ a: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.customerPaymentId, paymentId))).map(r => r.a));
}
const paymentStatusFor = (amount: number, net: number) => (net <= 0 ? "unapplied" as const : net >= amount ? "applied" as const : "partially_applied" as const);

/**
 * Apply cash to an invoice. Locks the payment, then the invoice (always that order), recomputes both balances under
 * the lock: two allocations racing for the same unapplied amount — one succeeds, the other is refused.
 */
export async function paymentAllocate(s: BillingScope, actor: Actor, a: { paymentRef: string; invoiceNumber: string; amountCents: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const p = await paymentByRef(s, a.paymentRef, tx, true);
    const inv = await invoiceByNumber(s, a.invoiceNumber, tx, true);
    const net = await paymentNetAllocated(tx, p.id);
    const r = await receivableFor(tx, inv, at);
    const chk = allocationCheck({ payment: { status: p.status, amountCents: p.amountCents, netAllocatedCents: net, financialEntityId: p.financialEntityId, customerAccountId: p.customerAccountId, currency: p.currency }, invoice: { status: inv.status, issued: isIssued(inv), outstandingCents: r.outstandingCents, financialEntityId: inv.financialEntityId, customerAccountId: inv.customerAccountId, currency: inv.currency }, amountCents: a.amountCents });
    if (!chk.permitted) throw precondition(chk.refusals.join("; "));
    const allocationRef = ref("ALC");
    const ins = await tx.insert(paymentAllocations).values({ allocationRef, customerPaymentId: p.id, invoiceId: inv.id, amountCents: a.amountCents, allocatedByUserId: actor.userId, allocatedAt: at });
    const pStatus = paymentStatusFor(p.amountCents, net + a.amountCents);
    await tx.update(customerPayments).set({ status: pStatus }).where(eq(customerPayments.id, p.id));
    await audit(tx, { financialEntityId: p.financialEntityId, subjectType: "payment_allocation", subjectRef: allocationRef, subjectId: Number(ins[0]?.insertId ?? 0), eventType: "payment_allocated", relatedRef: inv.invoiceNumber, jobId: inv.jobId, changes: { amountCents: { from: null, to: a.amountCents }, payment: { from: p.status, to: pStatus } }, actor, at });
    await queueExport(tx, p.financialEntityId, "allocation", Number(ins[0]?.insertId ?? 0), allocationRef, { allocationRef, paymentRef: p.paymentRef, invoiceNumber: inv.invoiceNumber, amountCents: a.amountCents, currency: p.currency, at: at.toISOString() });
    const settled = await settleInvoiceStatus(tx, s, actor, inv, at);
    return { allocationRef, paymentRef: p.paymentRef, invoiceNumber: inv.invoiceNumber, paymentUnappliedAfterCents: chk.paymentUnappliedAfterCents, invoiceOutstandingAfterCents: settled.receivable.outstandingCents, invoiceStatus: settled.status, paymentStatus: pStatus };
  });
}

/** Reverse an allocation by a NEGATIVE row naming it — never an update or a delete. Once per allocation (UNIQUE). */
export async function allocationReverse(s: BillingScope, actor: Actor, a: { allocationRef: string; reason: string }, at = new Date()) {
  const pre = (await s.db.select().from(paymentAllocations).where(eq(paymentAllocations.allocationRef, a.allocationRef)).limit(1))[0];
  if (!pre) throw notFound(`Allocation ${a.allocationRef}`);
  const payRef = (await s.db.select({ paymentRef: customerPayments.paymentRef }).from(customerPayments).where(eq(customerPayments.id, pre.customerPaymentId)).limit(1))[0]?.paymentRef ?? "-";
  return s.db.transaction(async tx => {
    const p = await paymentByRef(s, payRef, tx, true);
    const invRow = (await tx.select().from(invoices).where(eq(invoices.id, pre.invoiceId)).for("update").limit(1))[0]!;
    if (!owns(s, invRow.financialEntityId)) throw notFound(`Allocation ${a.allocationRef}`);
    if (pre.reversesAllocationId != null) throw precondition("A reversal is not itself reversed — record a new allocation");
    const already = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(eq(paymentAllocations.reversesAllocationId, pre.id)).limit(1);
    if (already.length) throw conflict(`Allocation ${a.allocationRef} is already reversed`);
    const reversalRef = ref("ALR");
    try {
      await tx.insert(paymentAllocations).values({ allocationRef: reversalRef, customerPaymentId: p.id, invoiceId: invRow.id, amountCents: -pre.amountCents, allocatedByUserId: actor.userId, allocatedAt: at, reversesAllocationId: pre.id, reason: a.reason });
    } catch (e) { if (/Duplicate entry/i.test(String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error).message))) throw conflict(`Allocation ${a.allocationRef} is already reversed`); throw e; }
    const net = await paymentNetAllocated(tx, p.id);
    if (p.status !== "reversed") await tx.update(customerPayments).set({ status: paymentStatusFor(p.amountCents, net) }).where(eq(customerPayments.id, p.id));
    await audit(tx, { financialEntityId: p.financialEntityId, subjectType: "payment_allocation", subjectRef: a.allocationRef, subjectId: pre.id, eventType: "allocation_reversed", relatedRef: reversalRef, jobId: invRow.jobId, reason: a.reason, changes: { amountCents: { from: pre.amountCents, to: 0 } }, actor, at });
    await queueExport(tx, p.financialEntityId, "allocation", pre.id, reversalRef, { allocationRef: reversalRef, reverses: a.allocationRef, paymentRef: p.paymentRef, invoiceNumber: invRow.invoiceNumber, amountCents: -pre.amountCents, currency: p.currency, at: at.toISOString() });
    const settled = await settleInvoiceStatus(tx, s, actor, invRow, at);
    return { allocationRef: a.allocationRef, reversalRef, invoiceNumber: invRow.invoiceNumber, invoiceStatus: settled.status, invoiceOutstandingAfterCents: settled.receivable.outstandingCents, paymentUnappliedAfterCents: p.amountCents - net };
  });
}

/** A returned cheque or a recalled EFT: the payment is reversed once nothing of it is applied (reverse its allocations first). */
export async function paymentReverse(s: BillingScope, actor: Actor, a: { paymentRef: string; reason: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const p = await paymentByRef(s, a.paymentRef, tx, true);
    if (p.status === "reversed") throw conflict(`Payment ${p.paymentRef} is already reversed`);
    const net = await paymentNetAllocated(tx, p.id);
    if (net !== 0) throw precondition(`${net} cents of payment ${p.paymentRef} are applied — reverse those allocations first`);
    await assertPeriodOpen(p.financialEntityId, at, `Reversal of payment ${p.paymentRef}`);
    await tx.update(customerPayments).set({ status: "reversed", reversedAt: at, reversedByUserId: actor.userId, reversalReason: a.reason }).where(eq(customerPayments.id, p.id));
    await audit(tx, { financialEntityId: p.financialEntityId, subjectType: "customer_payment", subjectRef: p.paymentRef, subjectId: p.id, eventType: "payment_reversed", fromStatus: p.status, toStatus: "reversed", reason: a.reason, actor, at });
    await queueExport(tx, p.financialEntityId, "payment", p.id, p.paymentRef, { paymentRef: p.paymentRef, status: "reversed", reversedAt: at.toISOString(), reason: a.reason, amountCents: p.amountCents, currency: p.currency });
    return { paymentRef: p.paymentRef, status: "reversed" as const };
  });
}

/* --------------------------------------------------------- credits, adjustments */

/** A credit note: numbered in the organization's CR series, tied to the customer and the invoice, reasoned, approved by a second person. */
export async function creditCreate(s: BillingScope, actor: Actor, a: { invoiceNumber: string; amountCents: number; reason: string; source?: "manual" | "dispute" | "billing"; disputeCaseId?: number | null }, at = new Date(), tx0?: Tx) {
  const run = async (tx: Tx) => {
    const inv = await invoiceByNumber(s, a.invoiceNumber, tx, true);
    const pieces = (await arPieces(tx, [inv.id])).get(inv.id)!;
    const r = receivableOf(inv, pieces, at);
    const chk = creditCheck({ invoiceStatus: inv.status, issued: isIssued(inv), outstandingCents: r.outstandingCents, pendingCreditCents: pieces.pendingCreditCents, amountCents: a.amountCents, deciding: false });
    if (!chk.permitted) throw precondition(chk.refusals.join("; "));
    const n = await mintScopedNumber(tx, s, "CR", { recordType: "customer_credit", actorUserId: actor.userId, at });
    const ins = await tx.insert(customerCredits).values({ creditRef: n.number, numberScope: n.numberScope, numberAllocationRef: n.allocationRef, financialEntityId: inv.financialEntityId!, customer: inv.customer, customerAccountId: inv.customerAccountId, invoiceId: inv.id, amountCents: a.amountCents, currency: inv.currency, reason: a.reason.slice(0, 400), requestedByUserId: actor.userId, status: "requested", source: a.source ?? "manual", disputeCaseId: a.disputeCaseId ?? null });
    const id = Number(ins[0]?.insertId ?? 0);
    await bindNumber(tx, n.allocationRef, id);
    await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "customer_credit", subjectRef: n.number, subjectId: id, eventType: "credit_created", toStatus: "requested", relatedRef: inv.invoiceNumber, jobId: inv.jobId, reason: a.reason, changes: { amountCents: { from: null, to: a.amountCents } }, actor, at });
    await settleInvoiceStatus(tx, s, actor, inv, at);
    return { creditRef: n.number, status: "requested" as const, invoiceNumber: inv.invoiceNumber, amountCents: a.amountCents };
  };
  if (tx0) return run(tx0);
  await prepareSeries(s.db, s.tenantId, "CR", at);
  return s.db.transaction(run);
}
async function creditByRef(s: BillingScope, creditRef: string, d: DbOrTx, lock: boolean) {
  const q = d.select().from(customerCredits).where(and(eq(customerCredits.creditRef, creditRef), inArray(customerCredits.financialEntityId, books(s)))).limit(2);
  const rows = lock ? await q.for("update") : await q;
  if (!rows.length) throw notFound(`Credit ${creditRef}`);
  if (rows.length > 1) throw precondition(`Credit number ${creditRef} names more than one record in your books`);
  return rows[0]!;
}
/**
 * What the approval ladder is asked about a credit decision: the credit in the caller's books, still requested, not
 * the decider's own. The ladder itself is called by the router with the SESSION's user (authArchitecture: the
 * approval service's actor is always `ctx.user.id` at the call site), and its outcome is handed to `creditDecide`.
 */
export async function creditDecisionSubject(s: BillingScope, actorUserId: number, creditRef: string) {
  const pre = await creditByRef(s, creditRef, s.db, false);
  if (pre.status !== "requested") throw precondition(`Credit ${pre.creditRef} is ${pre.status}`);
  if (pre.requestedByUserId === actorUserId) throw forbidden("The person who requested a credit does not decide it");
  return { creditRef: pre.creditRef, subjectRef: ledgerSubjectRef(pre.creditRef, pre.numberScope), amountCents: pre.amountCents, preparedByUserId: pre.requestedByUserId };
}
export type LedgerOutcome = { outcome: "blocked"; reason: string } | { outcome: "awaiting"; awaiting?: string } | { outcome: string; reason?: string; awaiting?: string };
/** Approve or refuse a credit note, given the ladder's outcome. The invoice is locked and the credit re-checked against what is outstanding NOW: two approvals racing to over-credit — one is refused. */
export async function creditDecide(s: BillingScope, actor: Actor, a: { creditRef: string; decision: "approved" | "refused"; note: string }, ledger: LedgerOutcome, at = new Date()) {
  const pre = await creditByRef(s, a.creditRef, s.db, false);
  if (pre.requestedByUserId === actor.userId) throw forbidden("The person who requested a credit does not decide it");
  if (ledger.outcome === "blocked") throw new TRPCError({ code: (ledger.reason ?? "").startsWith("REVIEW") ? "PRECONDITION_FAILED" : "FORBIDDEN", message: ledger.reason ?? "blocked by the approval ladder" });
  if (ledger.outcome === "awaiting") return { creditRef: pre.creditRef, status: "requested" as const, awaiting: ledger.awaiting ?? null };
  return s.db.transaction(async tx => {
    const invRow = pre.invoiceId != null ? (await tx.select().from(invoices).where(eq(invoices.id, pre.invoiceId)).for("update").limit(1))[0] ?? null : null;
    const c = await creditByRef(s, a.creditRef, tx, true);
    if (c.status !== "requested") throw conflict(`Credit ${c.creditRef} was decided meanwhile (${c.status})`);
    if (a.decision === "approved" && invRow) {
      const r = await receivableFor(tx, invRow, at);
      const chk = creditCheck({ invoiceStatus: invRow.status, issued: isIssued(invRow), outstandingCents: r.outstandingCents, pendingCreditCents: 0, amountCents: c.amountCents, requestedByUserId: c.requestedByUserId, deciderUserId: actor.userId, deciding: true });
      if (!chk.permitted) throw precondition(chk.refusals.join("; "));
    }
    await tx.update(customerCredits).set({ status: a.decision, approvedByUserId: actor.userId, approvedAt: at, decisionNote: a.note }).where(eq(customerCredits.id, c.id));
    await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "customer_credit", subjectRef: c.creditRef, subjectId: c.id, eventType: a.decision === "approved" ? "credit_approved" : "credit_refused", fromStatus: "requested", toStatus: a.decision, relatedRef: invRow?.invoiceNumber ?? null, jobId: invRow?.jobId ?? null, reason: a.note, actor, at });
    if (a.decision === "approved") {
      await emit(tx, { tenantId: s.tenantId, type: "credit.approved", entityType: "customer_credit", entityId: c.creditRef, actor, jobId: invRow?.jobId ?? null, payload: { creditRef: c.creditRef, invoiceNumber: invRow?.invoiceNumber ?? null, amountCents: c.amountCents, currency: c.currency }, at });
      await queueExport(tx, c.financialEntityId, "credit_note", c.id, c.creditRef, { creditRef: c.creditRef, numberScope: c.numberScope, invoiceNumber: invRow?.invoiceNumber ?? null, amountCents: c.amountCents, currency: c.currency, approvedAt: at.toISOString(), reason: c.reason });
    }
    const settled = invRow ? await settleInvoiceStatus(tx, s, actor, invRow, at) : null;
    return { creditRef: c.creditRef, status: a.decision, invoiceStatus: settled?.status ?? null, invoiceOutstandingAfterCents: settled?.receivable.outstandingCents ?? null };
  });
}

export async function adjustmentRequest(s: BillingScope, actor: Actor, a: { invoiceNumber: string; amountCents: number; reasonCode: "late_fee" | "rounding" | "fx" | "correction" | "other"; reason: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const inv = await invoiceByNumber(s, a.invoiceNumber, tx, true);
    const r = await receivableFor(tx, inv, at);
    const chk = adjustmentCheck({ invoiceStatus: inv.status, issued: isIssued(inv), outstandingCents: r.outstandingCents, amountCents: a.amountCents, deciding: false });
    if (!chk.permitted) throw precondition(chk.refusals.join("; "));
    const adjustmentRef = ref("ADJ");
    const ins = await tx.insert(invoiceAdjustments).values({ adjustmentRef, financialEntityId: inv.financialEntityId!, invoiceId: inv.id, amountCents: a.amountCents, currency: inv.currency, reasonCode: a.reasonCode, reason: a.reason, requestedByUserId: actor.userId, requestedAt: at });
    await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "invoice_adjustment", subjectRef: adjustmentRef, subjectId: Number(ins[0]?.insertId ?? 0), eventType: "adjustment_requested", toStatus: "requested", relatedRef: inv.invoiceNumber, jobId: inv.jobId, reason: a.reason, changes: { amountCents: { from: null, to: a.amountCents } }, actor, at });
    return { adjustmentRef, status: "requested" as const };
  });
}
export async function adjustmentDecide(s: BillingScope, actor: Actor, a: { adjustmentRef: string; decision: "approved" | "refused"; note: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const pre = (await tx.select().from(invoiceAdjustments).where(eq(invoiceAdjustments.adjustmentRef, a.adjustmentRef)).limit(1))[0];
    if (!pre || !owns(s, pre.financialEntityId)) throw notFound(`Adjustment ${a.adjustmentRef}`);
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, pre.invoiceId)).for("update").limit(1))[0]!;
    const adj = (await tx.select().from(invoiceAdjustments).where(eq(invoiceAdjustments.id, pre.id)).for("update").limit(1))[0]!;
    if (adj.status !== "requested") throw conflict(`Adjustment ${adj.adjustmentRef} is ${adj.status}`);
    if (adj.requestedByUserId === actor.userId) throw forbidden("The person who requested an adjustment does not decide it");
    if (a.decision === "approved") {
      const r = await receivableFor(tx, inv, at);
      const chk = adjustmentCheck({ invoiceStatus: inv.status, issued: isIssued(inv), outstandingCents: r.outstandingCents, amountCents: adj.amountCents, requestedByUserId: adj.requestedByUserId, deciderUserId: actor.userId, deciding: true });
      if (!chk.permitted) throw precondition(chk.refusals.join("; "));
    }
    await tx.update(invoiceAdjustments).set({ status: a.decision, decidedByUserId: actor.userId, decidedAt: at, decisionNote: a.note }).where(eq(invoiceAdjustments.id, adj.id));
    await audit(tx, { financialEntityId: adj.financialEntityId, subjectType: "invoice_adjustment", subjectRef: adj.adjustmentRef, subjectId: adj.id, eventType: `adjustment_${a.decision}`, fromStatus: "requested", toStatus: a.decision, relatedRef: inv.invoiceNumber, jobId: inv.jobId, reason: a.note, actor, at });
    if (a.decision === "approved") await queueExport(tx, adj.financialEntityId, "adjustment", adj.id, adj.adjustmentRef, { adjustmentRef: adj.adjustmentRef, invoiceNumber: inv.invoiceNumber, amountCents: adj.amountCents, currency: adj.currency, reasonCode: adj.reasonCode, approvedAt: at.toISOString() });
    const settled = await settleInvoiceStatus(tx, s, actor, inv, at);
    return { adjustmentRef: adj.adjustmentRef, status: a.decision, invoiceOutstandingAfterCents: settled.receivable.outstandingCents };
  });
}

/* ----------------------------------------------------------------- disputes */

export async function disputeOpen(s: BillingScope, actor: Actor, a: { invoiceNumber: string; lineNo?: number | null; amountCents?: number | null; reason: string; notes?: string | null; documentRefs?: string[]; raisedByName?: string | null }, at = new Date()) {
  return s.db.transaction(async tx => {
    const inv = await invoiceByNumber(s, a.invoiceNumber, tx, true);
    const line = a.lineNo != null ? (await tx.select().from(invoiceLines).where(and(eq(invoiceLines.invoiceId, inv.id), eq(invoiceLines.lineNo, a.lineNo))).limit(1))[0] : null;
    if (a.lineNo != null && !line) throw notFound(`Line ${a.lineNo} on invoice ${inv.invoiceNumber}`);
    const r = await receivableFor(tx, inv, at);
    const chk = disputeOpenCheck({ invoiceStatus: inv.status, issued: isIssued(inv), outstandingCents: r.outstandingCents, amountCents: a.amountCents ?? null, lineAmountCents: line ? line.amountCents + (line.taxCents ?? 0) : null });
    if (!chk.permitted) throw precondition(chk.refusals.join("; "));
    const caseNumber = ref("DSC");
    try {
      await tx.insert(disputeCases).values({ caseNumber, invoiceNumber: inv.invoiceNumber, invoiceId: inv.id, invoiceLineId: line?.id ?? null, invoiceLineRef: line ? `${inv.invoiceNumber}#${line.lineNo}` : null, financialEntityId: inv.financialEntityId, jobId: line?.jobId ?? inv.jobId, customer: inv.customer, raisedByName: a.raisedByName ?? null, disputedAmountCents: a.amountCents ?? (line ? line.amountCents + (line.taxCents ?? 0) : r.outstandingCents), reasonStated: a.reason, notes: a.notes ?? null, documentRefsJson: a.documentRefs?.length ? JSON.stringify(a.documentRefs) : null, openedByUserId: actor.userId, assignedUserId: actor.userId, raisedAt: at });
    } catch (e) { if (/Duplicate entry/i.test(String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error).message))) throw conflict(`An open dispute already covers ${line ? `line ${line.lineNo} of ` : ""}invoice ${inv.invoiceNumber}`); throw e; }
    const prev = inv.status;
    if (inv.status !== "disputed") await tx.update(invoices).set({ status: "disputed", disputedAt: at, disputeReason: a.reason, rowVersion: inv.rowVersion + 1 }).where(eq(invoices.id, inv.id));
    await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "dispute_case", subjectRef: caseNumber, eventType: "dispute_opened", toStatus: "raised", relatedRef: inv.invoiceNumber, jobId: inv.jobId, reason: a.reason, actor, at });
    await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "invoice", subjectRef: inv.invoiceNumber, subjectId: inv.id, eventType: "invoice_disputed", fromStatus: prev, toStatus: "disputed", relatedRef: caseNumber, jobId: inv.jobId, actor, at });
    await emit(tx, { tenantId: s.tenantId, type: "dispute.opened", entityType: "dispute_case", entityId: caseNumber, actor, jobId: inv.jobId, payload: { caseNumber, invoiceNumber: inv.invoiceNumber, lineNo: line?.lineNo ?? null, amountCents: a.amountCents ?? null }, at });
    for (const { jobId } of await tx.select({ jobId: invoiceJobLinks.jobId }).from(invoiceJobLinks).where(eq(invoiceJobLinks.invoiceId, inv.id))) await syncWorkspaceFromAr(tx, s, actor, jobId, inv.financialEntityId!, at);
    return { caseNumber, invoiceNumber: inv.invoiceNumber, status: "raised" as const };
  });
}
/** Resolve: upheld (no credit), credited / partial (a credit note is REQUESTED; a second person approves it), or withdrawn. */
export async function disputeResolve(s: BillingScope, actor: Actor, a: { caseNumber: string; outcome: "upheld" | "credited" | "partial" | "withdrawn"; creditAmountCents?: number | null; narrative: string }, at = new Date()) {
  await prepareSeries(s.db, s.tenantId, "CR", at);
  return s.db.transaction(async tx => {
    const c0 = (await tx.select().from(disputeCases).where(eq(disputeCases.caseNumber, a.caseNumber)).limit(1))[0];
    if (!c0 || c0.invoiceId == null || !owns(s, c0.financialEntityId)) throw notFound(`Dispute case ${a.caseNumber}`);
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, c0.invoiceId)).for("update").limit(1))[0]!;
    const c = (await tx.select().from(disputeCases).where(eq(disputeCases.id, c0.id)).for("update").limit(1))[0]!;
    if (c.openKey == null) throw conflict(`Dispute ${c.caseNumber} is ${c.status}`);
    let caseStatus: (typeof disputeCases.$inferSelect)["status"]; let creditCents = 0;
    if (a.outcome === "withdrawn") caseStatus = "withdrawn";
    else {
      const res = disputeResolution({ caseStatus: c.status, outcome: a.outcome, disputedAmountCents: c.disputedAmountCents ?? 0, creditAmountCents: a.creditAmountCents ?? null });
      if (!res.permitted) throw precondition(res.refusals.join("; "));
      caseStatus = res.caseStatus!; creditCents = res.creditCents;
    }
    await tx.update(disputeCases).set({ status: caseStatus, resolutionNarrative: a.narrative, resolvedAt: at, resolvedByUserId: actor.userId, resolutionAmountCents: creditCents }).where(eq(disputeCases.id, c.id));
    const stillOpen = await tx.select({ id: disputeCases.id }).from(disputeCases).where(and(eq(disputeCases.invoiceId, inv.id), sql`${disputeCases.openKey} IS NOT NULL`)).limit(1);
    if (!stillOpen.length && inv.status === "disputed") await tx.update(invoices).set({ status: deliveryState(inv), rowVersion: inv.rowVersion + 1 }).where(eq(invoices.id, inv.id));
    let creditRef: string | null = null;
    const fresh = (await tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1))[0]!;
    if (creditCents > 0) { const cr = await creditCreate(s, actor, { invoiceNumber: inv.invoiceNumber, amountCents: creditCents, reason: `Dispute ${c.caseNumber}: ${a.narrative}`, source: "dispute", disputeCaseId: c.id }, at, tx); creditRef = cr.creditRef; await tx.update(disputeCases).set({ creditId: (await tx.select({ id: customerCredits.id }).from(customerCredits).where(and(eq(customerCredits.creditRef, cr.creditRef), eq(customerCredits.numberScope, s.tenantId))).limit(1))[0]?.id ?? null }).where(eq(disputeCases.id, c.id)); }
    await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "dispute_case", subjectRef: c.caseNumber, subjectId: c.id, eventType: "dispute_resolved", fromStatus: c.status, toStatus: caseStatus, relatedRef: creditRef ?? inv.invoiceNumber, jobId: inv.jobId, reason: a.narrative, actor, at });
    await emit(tx, { tenantId: s.tenantId, type: "dispute.resolved", entityType: "dispute_case", entityId: c.caseNumber, actor, jobId: inv.jobId, payload: { caseNumber: c.caseNumber, invoiceNumber: inv.invoiceNumber, outcome: caseStatus, creditRef, creditCents }, at });
    const settled = await settleInvoiceStatus(tx, s, actor, fresh, at);
    return { caseNumber: c.caseNumber, status: caseStatus, creditRef, creditCents, invoiceStatus: settled.status, next: creditRef ? "A second person approves the credit note (billing.creditDecide)" : null };
  });
}

/* --------------------------------------------------- accounting boundary, sweep */

/** Queue a fact for the external ledger. Idempotent on its payload hash; a changed fact supersedes the earlier pending one. */
export async function queueExport(tx: Tx, financialEntityId: number, kind: "invoice" | "payment" | "credit_note" | "adjustment" | "allocation", entityId: number, entityRef: string, record: Record<string, unknown>): Promise<void> {
  const { payload, hash } = exportPayload(kind, record);
  await tx.update(accountingSyncRecords).set({ status: "superseded" }).where(and(eq(accountingSyncRecords.financialEntityId, financialEntityId), eq(accountingSyncRecords.entityType, kind), eq(accountingSyncRecords.entityRef, entityRef), inArray(accountingSyncRecords.status, ["pending", "failed", "conflict"]), ne(accountingSyncRecords.payloadHash, hash)));
  await tx.execute(sql`INSERT IGNORE INTO accountingSyncRecords (syncRef, financialEntityId, entityType, entityId, entityRef, payloadJson, payloadHash) VALUES (${ref("SYN")}, ${financialEntityId}, ${kind}, ${entityId}, ${entityRef}, ${JSON.stringify(payload)}, ${hash})`);
}
export async function exportQueue(s: BillingScope, f: { status?: "pending" | "exported" | "failed" | "conflict" | "superseded"; limit?: number }) {
  return s.db.select().from(accountingSyncRecords).where(and(inArray(accountingSyncRecords.financialEntityId, books(s)), f.status ? eq(accountingSyncRecords.status, f.status) : sql`1 = 1`)).orderBy(asc(accountingSyncRecords.id)).limit(Math.min(f.limit ?? 200, 500));
}
/** An exporter reports back: exported (with the external id), failed (with the error; retried), or conflict (a person decides). */
export async function exportMark(s: BillingScope, actor: Actor, a: { syncRef: string; outcome: "exported" | "failed" | "conflict" | "pending"; externalId?: string | null; externalSystem?: string | null; error?: string | null }, at = new Date()) {
  return s.db.transaction(async tx => {
    const r = (await tx.select().from(accountingSyncRecords).where(eq(accountingSyncRecords.syncRef, a.syncRef)).for("update").limit(1))[0];
    if (!r || !owns(s, r.financialEntityId)) throw notFound(`Export record ${a.syncRef}`);
    if (r.status === "exported" && a.outcome === "exported" && r.externalId === (a.externalId ?? null)) return { syncRef: r.syncRef, status: r.status, replayed: true };
    if (!syncTransition(r.status, a.outcome)) throw precondition(`An export that is ${r.status} cannot become ${a.outcome}`);
    if (a.outcome === "exported" && !a.externalId) throw bad("An exported record names the external system's id");
    await tx.update(accountingSyncRecords).set({ status: a.outcome, externalId: a.externalId ?? r.externalId, externalSystem: a.externalSystem ?? r.externalSystem, lastError: a.outcome === "failed" || a.outcome === "conflict" ? (a.error ?? "unspecified").slice(0, 600) : null, attempts: a.outcome === "pending" ? r.attempts : r.attempts + 1, lastAttemptAt: at, lastSyncedAt: a.outcome === "exported" ? at : r.lastSyncedAt, markedByUserId: actor.userId }).where(eq(accountingSyncRecords.id, r.id));
    await audit(tx, { financialEntityId: r.financialEntityId, subjectType: "accounting_sync", subjectRef: r.syncRef, subjectId: r.id, eventType: `export_${a.outcome}`, fromStatus: r.status, toStatus: a.outcome, relatedRef: r.entityRef, reason: a.error ?? null, actor, at });
    return { syncRef: r.syncRef, status: a.outcome, replayed: false };
  });
}

/** Emit invoice.overdue once per invoice that has passed its due date with money outstanding. Idempotent. */
export async function overdueSweep(s: BillingScope, actor: Actor, at = new Date()) {
  const cands = await s.db.select().from(invoices).where(and(inArray(invoices.financialEntityId, books(s)), lt(invoices.dueAt, at), isNull(invoices.overdueNotifiedAt), inArray(invoices.status, ["sent", "viewed", "partially_paid", "approved"])));
  const out: string[] = [];
  for (const c of cands) {
    await s.db.transaction(async tx => {
      const inv = (await tx.select().from(invoices).where(eq(invoices.id, c.id)).for("update").limit(1))[0]!;
      if (inv.overdueNotifiedAt || !isIssued(inv)) return;
      const r = await receivableFor(tx, inv, at);
      if (r.outstandingCents <= 0 || r.arStatus === "disputed") return;
      await tx.update(invoices).set({ overdueNotifiedAt: at }).where(eq(invoices.id, inv.id));
      await audit(tx, { financialEntityId: inv.financialEntityId!, subjectType: "invoice", subjectRef: inv.invoiceNumber, subjectId: inv.id, eventType: "invoice_overdue", jobId: inv.jobId, changes: { daysOverdue: { from: null, to: r.daysOverdue }, outstandingCents: { from: null, to: r.outstandingCents } }, actor, at });
      await emit(tx, { tenantId: s.tenantId, type: "invoice.overdue", entityType: "invoice", entityId: inv.invoiceNumber, actor, jobId: inv.jobId, payload: { invoiceNumber: inv.invoiceNumber, outstandingCents: r.outstandingCents, daysOverdue: r.daysOverdue, dueAt: inv.dueAt?.toISOString() ?? null }, at });
      out.push(inv.invoiceNumber);
    });
  }
  return { notified: out };
}

/* -------------------------------------------------------------------- views */

const lineView = (l: typeof invoiceLines.$inferSelect, internal: boolean) => ({ lineNo: l.lineNo, description: l.description, quantityMillis: l.billableQuantityMillis, unit: l.unit, rateMillis: l.rateMillis, amountCents: l.amountCents, taxCode: l.taxCode, taxRateBps: l.taxRateBps, taxCents: l.taxCents, jobId: l.jobId, released: l.releasedAt != null, provenance: internal ? parse<Record<string, unknown> | null>(l.provenanceJson, null) : null });

export async function invoiceGet(s: BillingScope, invoiceNumber: string, internal = true, at = new Date()) {
  const inv = await invoiceByNumber(s, invoiceNumber);
  const [ls, allocs, credits, adjs, disputes, snap, jobsLinked, history, sync] = await Promise.all([
    s.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(asc(invoiceLines.lineNo)),
    s.db.select({ allocationRef: paymentAllocations.allocationRef, amountCents: paymentAllocations.amountCents, allocatedAt: paymentAllocations.allocatedAt, reversesAllocationId: paymentAllocations.reversesAllocationId, id: paymentAllocations.id, reason: paymentAllocations.reason, paymentRef: customerPayments.paymentRef, method: customerPayments.method }).from(paymentAllocations).innerJoin(customerPayments, eq(customerPayments.id, paymentAllocations.customerPaymentId)).where(eq(paymentAllocations.invoiceId, inv.id)).orderBy(asc(paymentAllocations.id)),
    s.db.select().from(customerCredits).where(eq(customerCredits.invoiceId, inv.id)).orderBy(asc(customerCredits.id)),
    s.db.select().from(invoiceAdjustments).where(eq(invoiceAdjustments.invoiceId, inv.id)).orderBy(asc(invoiceAdjustments.id)),
    s.db.select().from(disputeCases).where(eq(disputeCases.invoiceId, inv.id)).orderBy(desc(disputeCases.id)),
    s.db.select({ payloadHash: billingSnapshots.payloadHash, capturedAt: billingSnapshots.capturedAt, capturedByUserId: billingSnapshots.capturedByUserId }).from(billingSnapshots).where(eq(billingSnapshots.invoiceId, inv.id)).orderBy(desc(billingSnapshots.id)).limit(1),
    s.db.select({ jobId: invoiceJobLinks.jobId, jobCode: jobs.jobCode }).from(invoiceJobLinks).innerJoin(jobs, eq(jobs.id, invoiceJobLinks.jobId)).where(eq(invoiceJobLinks.invoiceId, inv.id)),
    s.db.select().from(commercialAuditEvents).where(and(eq(commercialAuditEvents.financialEntityId, inv.financialEntityId!), or(and(eq(commercialAuditEvents.subjectType, "invoice"), eq(commercialAuditEvents.subjectRef, inv.invoiceNumber)), eq(commercialAuditEvents.relatedRef, inv.invoiceNumber)))).orderBy(desc(commercialAuditEvents.id)).limit(200),
    s.db.select().from(accountingSyncRecords).where(and(eq(accountingSyncRecords.financialEntityId, inv.financialEntityId!), eq(accountingSyncRecords.entityType, "invoice"), eq(accountingSyncRecords.entityRef, inv.invoiceNumber))).orderBy(desc(accountingSyncRecords.id)).limit(5),
  ]);
  const reversed = new Set(allocs.map(a => a.reversesAllocationId).filter((x): x is number => x != null));
  return {
    invoice: { invoiceNumber: inv.invoiceNumber, numberScope: inv.numberScope, origin: inv.origin, status: inv.status, rowVersion: inv.rowVersion, customer: inv.customer, customerAccountId: inv.customerAccountId, currency: inv.currency, subtotalCents: inv.subtotalCents, taxCents: inv.taxCents, totalCents: inv.totalCents, taxCode: inv.taxCode, taxRateBps: inv.taxRateBps, taxJurisdiction: inv.taxJurisdiction, purchaseOrder: inv.purchaseOrder, afeNumber: inv.afeNumber, paymentTermsDays: inv.paymentTermsDays, issuedAt: inv.issuedAt, dueAt: inv.dueAt, draftedByUserId: inv.draftedByUserId, submittedByUserId: inv.submittedByUserId, submittedAt: inv.submittedAt, approvedByUserId: inv.approvedByUserId, approvedAt: inv.approvedAt, voidedAt: inv.voidedAt, voidReason: inv.voidReason, createdAt: inv.createdAt },
    receivable: await receivableFor(s.db, inv, at),
    lines: ls.map(l => lineView(l, internal)), jobs: jobsLinked,
    allocations: allocs.map(a => ({ ...a, reversed: reversed.has(a.id) })), credits, adjustments: adjs, disputes, snapshot: snap[0] ?? null,
    supportingDocuments: await supportingDocuments(s, inv.id), history, export: sync[0] ?? null,
  };
}

export type InvoiceFilter = { status?: string[]; accountRef?: string; q?: string; from?: Date; to?: Date; limit?: number };
export async function invoicesList(s: BillingScope, f: InvoiceFilter, at = new Date()) {
  const where: SQL[] = [inArray(invoices.financialEntityId, books(s))];
  if (f.status?.length) where.push(inArray(invoices.status, f.status as InvoiceRow["status"][]));
  if (f.accountRef) { const acc = (await s.db.select({ id: customerAccounts.id }).from(customerAccounts).where(and(eq(customerAccounts.accountRef, f.accountRef), inArray(customerAccounts.financialEntityId, books(s)))).limit(1))[0]; where.push(eq(invoices.customerAccountId, acc?.id ?? -1)); }
  if (f.q) where.push(or(like(invoices.invoiceNumber, `%${f.q}%`), like(invoices.customer, `%${f.q}%`))!);
  if (f.from) where.push(gt(invoices.createdAt, f.from));
  if (f.to) where.push(lt(invoices.createdAt, f.to));
  const rows = await s.db.select().from(invoices).where(and(...where)).orderBy(desc(invoices.id)).limit(Math.min(f.limit ?? 200, 500));
  const pieces = await arPieces(s.db, rows.map(r => r.id));
  return rows.map(i => ({ invoiceNumber: i.invoiceNumber, origin: i.origin, status: i.status, customer: i.customer, currency: i.currency, totalCents: i.totalCents, issuedAt: i.issuedAt, dueAt: i.dueAt, createdAt: i.createdAt, jobId: i.jobId, receivable: receivableOf(i, pieces.get(i.id)!, at) }));
}

/** Receivables: every issued, unsettled invoice in the caller's books, aged by due date, with unapplied cash beside it. */
export async function receivables(s: BillingScope, f: { accountRef?: string; asOf?: Date }) {
  const asOf = f.asOf ?? new Date();
  const list = (await invoicesList(s, { accountRef: f.accountRef, limit: 500 }, asOf)).filter(x => x.receivable.bucket != null);
  const totals = agingTotals(list.map(x => ({ key: x.invoiceNumber, outstandingCents: x.receivable.outstandingCents, bucket: x.receivable.bucket! })));
  const unapplied = await unappliedPayments(s, f.accountRef);
  return { asOf, invoices: list.sort((a, b) => b.receivable.daysOverdue - a.receivable.daysOverdue), totals, unapplied, unappliedCents: sum(unapplied.map(u => u.unappliedCents)) };
}
export async function unappliedPayments(s: BillingScope, accountRef?: string) {
  const acc = accountRef ? (await s.db.select({ id: customerAccounts.id }).from(customerAccounts).where(and(eq(customerAccounts.accountRef, accountRef), inArray(customerAccounts.financialEntityId, books(s)))).limit(1))[0] : null;
  const pays = await s.db.select().from(customerPayments).where(and(inArray(customerPayments.financialEntityId, books(s)), inArray(customerPayments.status, ["unapplied", "partially_applied"]), accountRef ? eq(customerPayments.customerAccountId, acc?.id ?? -1) : sql`1 = 1`)).orderBy(asc(customerPayments.receivedAt)).limit(500);
  const allocs = pays.length ? await s.db.select({ p: paymentAllocations.customerPaymentId, a: paymentAllocations.amountCents }).from(paymentAllocations).where(inArray(paymentAllocations.customerPaymentId, pays.map(p => p.id))) : [];
  return pays.map(p => ({ paymentRef: p.paymentRef, customer: p.customer, customerAccountId: p.customerAccountId, receivedAt: p.receivedAt, amountCents: p.amountCents, currency: p.currency, method: p.method, reference: p.reference, unappliedCents: p.amountCents - sum(allocs.filter(a => a.p === p.id).map(a => a.a)) })).filter(p => p.unappliedCents > 0);
}
export async function customerBalance(s: BillingScope, accountRef: string, asOf = new Date()) {
  const account = (await s.db.select().from(customerAccounts).where(and(eq(customerAccounts.accountRef, accountRef), inArray(customerAccounts.financialEntityId, books(s)))).limit(1))[0];
  if (!account) throw notFound(`Customer ${accountRef}`);
  const r = await receivables(s, { accountRef, asOf });
  const recent = await s.db.select({ paymentRef: customerPayments.paymentRef, receivedAt: customerPayments.receivedAt, amountCents: customerPayments.amountCents, currency: customerPayments.currency, method: customerPayments.method, status: customerPayments.status }).from(customerPayments).where(eq(customerPayments.customerAccountId, account.id)).orderBy(desc(customerPayments.receivedAt)).limit(10);
  const disputes = await s.db.select({ caseNumber: disputeCases.caseNumber, invoiceNumber: disputeCases.invoiceNumber, status: disputeCases.status, disputedAmountCents: disputeCases.disputedAmountCents, raisedAt: disputeCases.raisedAt }).from(disputeCases).innerJoin(invoices, eq(invoices.id, disputeCases.invoiceId)).where(and(eq(invoices.customerAccountId, account.id), sql`${disputeCases.openKey} IS NOT NULL`));
  return {
    account: { accountRef: account.accountRef, name: account.name, status: account.status, currency: account.defaultCurrency, paymentTermsDays: account.paymentTermsDays, creditLimitCents: account.creditLimitCents ?? null },
    openInvoices: r.invoices, outstandingCents: r.totals.total, overdueCents: r.totals.d1_30 + r.totals.d31_60 + r.totals.d61_90 + r.totals.d90_plus, aging: r.totals,
    unapplied: r.unapplied, unappliedCents: r.unappliedCents, disputes, recentPayments: recent, netOwingCents: r.totals.total - r.unappliedCents,
  };
}

/** The billing workspace for one job: readiness, charges, invoices and history. Rate-backed — never offered to a field role. */
export async function workspaceGet(s: BillingScope, jobId: number) {
  const { facts, context, job } = await gatherFacts(s, jobId, s.db);
  const readiness = evaluateReadiness(facts);
  const w = (await s.db.select().from(billingWorkspaces).where(eq(billingWorkspaces.jobId, jobId)).limit(1))[0] ?? null;
  if (w && !owns(s, w.financialEntityId)) throw notFound(`Job ${jobId}`);
  const charges = await s.db.select().from(billableCharges).where(eq(billableCharges.jobId, jobId)).orderBy(asc(billableCharges.id));
  const invs = await s.db.select({ invoiceNumber: invoices.invoiceNumber, status: invoices.status, totalCents: invoices.totalCents, currency: invoices.currency, createdAt: invoices.createdAt }).from(invoices).innerJoin(invoiceJobLinks, eq(invoiceJobLinks.invoiceId, invoices.id)).where(eq(invoiceJobLinks.jobId, jobId)).orderBy(desc(invoices.id));
  const history = w ? await s.db.select().from(commercialAuditEvents).where(and(eq(commercialAuditEvents.financialEntityId, w.financialEntityId), eq(commercialAuditEvents.jobId, jobId))).orderBy(desc(commercialAuditEvents.id)).limit(200) : [];
  return {
    job: { id: job.id, jobCode: job.jobCode, status: job.status, customer: job.customer, location: job.location },
    workspace: w ? { workspaceRef: w.workspaceRef, state: w.state, rowVersion: w.rowVersion, holdActive: w.holdActive, holdReason: w.holdReason, reviewSubmittedByUserId: w.reviewSubmittedByUserId, reviewSubmittedAt: w.reviewSubmittedAt, reviewDecidedByUserId: w.reviewDecidedByUserId, reviewDecidedAt: w.reviewDecidedAt, reviewNote: w.reviewNote, evaluatedAt: w.evaluatedAt } : null,
    readiness, commercial: context ? { snapshotRef: context.snapshotRef, customer: context.customer.name, billTo: context.billTo.name, contract: context.contract?.contractNumber ?? null, rateSheetVersion: context.rateSheet?.versionRef ?? null, currency: context.currency, paymentTermsDays: context.paymentTermsDays, purchaseOrder: context.purchaseOrder?.poNumber ?? null, references: context.references } : null,
    charges: charges.map(c => ({ ...c, inputs: parse(c.inputsJson, {}), reasons: parse<string[]>(c.reasonsJson, []), remainingQuantityMillis: (c.billableQuantityMillis ?? 0) - c.billedQuantityMillis, remainingAmountCents: (c.amountCents ?? 0) - c.billedAmountCents })),
    invoices: invs, history,
  };
}

const DASHBOARD_BUCKETS = ["needs_attention", "ready", "draft", "awaiting_approval", "issued", "overdue", "disputed", "paid"] as const;
/** The billing dashboard: work by bucket, filterable by customer, state and text. */
export async function dashboard(s: BillingScope, f: { accountRef?: string; q?: string; limit?: number }, at = new Date()) {
  const ws = await s.db.select({ w: billingWorkspaces, jobCode: jobs.jobCode, customer: jobs.customer }).from(billingWorkspaces).innerJoin(jobs, eq(jobs.id, billingWorkspaces.jobId)).where(and(inArray(billingWorkspaces.financialEntityId, books(s)), f.q ? like(jobs.jobCode, `%${f.q}%`) : sql`1 = 1`)).orderBy(desc(billingWorkspaces.updatedAt)).limit(Math.min(f.limit ?? 300, 500));
  const pendingCharges = await s.db.select({ jobId: billableCharges.jobId, n: sql<number>`count(*)` }).from(billableCharges).where(and(inArray(billableCharges.financialEntityId, books(s)), or(eq(billableCharges.status, "held"), eq(billableCharges.overrideStatus, "pending"), and(eq(billableCharges.sourceKind, "manual"), eq(billableCharges.status, "proposed"))))).groupBy(billableCharges.jobId);
  const pend = new Map(pendingCharges.map(p => [p.jobId, Number(p.n)]));
  const jobRow = (x: (typeof ws)[number]) => ({ jobId: x.w.jobId, jobCode: x.jobCode, customer: x.customer, state: x.w.state, holdActive: x.w.holdActive, blockers: parse<{ blockers?: { code: string; message: string }[] }>(x.w.readinessJson, {}).blockers ?? [], attention: pend.get(x.w.jobId) ?? 0, updatedAt: x.w.updatedAt });
  const invs = await invoicesList(s, { accountRef: f.accountRef, q: f.q, limit: 500 }, at);
  const buckets: Record<(typeof DASHBOARD_BUCKETS)[number], unknown[]> = {
    needs_attention: ws.filter(x => (READINESS_STATES.includes(x.w.state) && x.w.state !== "ready") || x.w.holdActive || (pend.get(x.w.jobId) ?? 0) > 0).map(jobRow),
    ready: ws.filter(x => x.w.state === "ready" || x.w.state === "approved_for_invoicing").map(jobRow),
    draft: invs.filter(i => i.status === "draft"),
    awaiting_approval: [...ws.filter(x => x.w.state === "under_review").map(jobRow), ...invs.filter(i => i.status === "in_review")],
    issued: invs.filter(i => ["sent", "viewed", "partially_paid"].includes(i.status) && i.receivable.arStatus !== "overdue"),
    overdue: invs.filter(i => i.receivable.arStatus === "overdue"),
    disputed: invs.filter(i => i.receivable.arStatus === "disputed"),
    paid: invs.filter(i => i.status === "paid").slice(0, 50),
  };
  return { asOf: at, counts: Object.fromEntries(DASHBOARD_BUCKETS.map(k => [k, buckets[k].length])), buckets };
}
