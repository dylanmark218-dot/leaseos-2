/**
 * v22.9 — The invoice path. Drafted from a signed ticket's accepted lines and
 * their pricing decisions; the billing book opened for the job and its
 * entries written; finalized by a second permission into an immutable
 * snapshot whose hash the invoice carries. A taxable invoice needs a
 * verified rate — a P9 rule, never a figure typed here.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { billingBookEntries, billingBooks, billingSnapshots, customerAccounts, customerBillingConfigs, customerCredits, disputeCases, fieldTicketDocuments, fieldTicketLines, fieldTicketSignatures, fieldTickets, invoiceLines, invoices, jobs, paymentAllocations, pricingDecisions } from "../drizzle/schema";
import { renderPdf, sha256Hex } from "./_core/ticketPdf";
import { storagePut } from "./storage";
import { queueCustomerAlert } from "./customerAlertService";
import { getDb } from "./db";
import { roleProcedure, router } from "./_core/trpc";
import { disputeResolution, draftFromTicket, finalizeCheck, snapshotHash, voidCheck, type TicketLineForInvoice } from "./_core/invoiceDraft";
import { determine } from "./_core/taxRuleEngine";
import { GST_RATE_RULE_TYPE, GST_RATE_SEEDS } from "./_core/gstSeeds";
import { loadTaxRules } from "./payrollService";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

async function ticketForInvoice(d: Awaited<ReturnType<typeof db>>, ticketNumber: string) {
  const t = (await d.select().from(fieldTickets).where(eq(fieldTickets.ticketNumber, ticketNumber)).limit(1))[0];
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket" });
  const [sigs, lines, job, account] = await Promise.all([
    d.select().from(fieldTicketSignatures).where(eq(fieldTicketSignatures.fieldTicketId, t.id)),
    d.select().from(fieldTicketLines).where(eq(fieldTicketLines.fieldTicketId, t.id)),
    d.select().from(jobs).where(eq(jobs.id, t.jobId)).limit(1).then(r => r[0] ?? null),
    t.customerAccountId != null ? d.select().from(customerAccounts).where(eq(customerAccounts.id, t.customerAccountId)).limit(1).then(r => r[0] ?? null) : Promise.resolve(null),
  ]);
  const refs = lines.map(l => l.pricingDecisionRef).filter((r): r is string => !!r);
  const decisions = refs.length ? await d.select().from(pricingDecisions).where(inArray(pricingDecisions.decisionRef, refs)) : [];
  const byRef = new Map(decisions.map(x => [x.decisionRef, x]));
  const forDraft: TicketLineForInvoice[] = lines.map(l => { const dec = l.pricingDecisionRef ? byRef.get(l.pricingDecisionRef) : null; return { id: l.id, description: l.description, serviceCode: l.serviceCode, disposition: l.disposition, quantity: l.quantity, quantityUnit: l.quantityUnit, decision: dec ? { decisionRef: dec.decisionRef, outcome: dec.outcome, amountCents: dec.amountCents, billableQuantityMillis: dec.billableQuantityMillis, rateMillis: dec.rateMillis, unit: dec.unit, quantityMillis: dec.quantityMillis, scopeLevel: dec.scopeLevel, reasons: JSON.parse(dec.reasonsJson) as string[] } : null }; });
  const signed = sigs.some(s => s.result === "accepted" || s.result === "partially_accepted");   // a refusal or an absent representative is not a signature to invoice on
  const config = account ? (await d.select().from(customerBillingConfigs).where(eq(customerBillingConfigs.customer, account.name)).limit(1))[0] ?? null : null;
  return { t, job, account, lines, forDraft, signed, partialAcceptanceAllowed: !!config?.partialAcceptanceAllowed };
}

/** The invoice document's lines, from the frozen snapshot only — nothing re-read from live records. */
export function invoiceDocumentLines(inv: { invoiceNumber: string; customer: string; issuedAt: Date | null; dueAt: Date | null; purchaseOrder: string | null; afeNumber: string | null; gstTreatment: string; currency: string }, calc: { lines: { lineNo: number; description: string; billableQuantityMillis: number; unit: string; rateMillis: number | null; amountCents: number; basis: string }[]; subtotalCents: number; taxCents: number | null; totalCents: number; ratePercent: number | null }, snapshotHash: string): string[] {
  const money = (c: number) => `${inv.currency} ${(c / 100).toFixed(2)}`;
  const out = [`INVOICE ${inv.invoiceNumber}`, `Customer: ${inv.customer}`, `Issued: ${inv.issuedAt ? inv.issuedAt.toISOString().slice(0, 10) : "—"}    Due: ${inv.dueAt ? inv.dueAt.toISOString().slice(0, 10) : "—"}`];
  if (inv.purchaseOrder) out.push(`PO: ${inv.purchaseOrder}`);
  if (inv.afeNumber) out.push(`AFE: ${inv.afeNumber}`);
  out.push("");
  for (const l of calc.lines) out.push(`${l.lineNo}. ${l.description}: ${(l.billableQuantityMillis / 1000).toFixed(3)} ${l.unit}${l.rateMillis != null ? ` × ${inv.currency} ${(l.rateMillis / 1000).toFixed(2)}/${l.unit}` : ""} = ${money(l.amountCents)}   [${l.basis}]`);
  out.push("", `Subtotal: ${money(calc.subtotalCents)}`, `GST/HST (${inv.gstTreatment}${calc.ratePercent != null ? ` ${calc.ratePercent}%` : ""}): ${money(calc.taxCents ?? 0)}`, `Total: ${money(calc.totalCents)}`, "", `Snapshot ${snapshotHash}`);
  return out;
}

export const invoicingRouter = router({
  /** Render the invoice's document from its frozen snapshot — deterministic, idempotent, stored beside the ticket's documents. */
  render: roleProcedure("invoicing.render").input(z.object({ invoiceNumber: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    const d = await db();
    const inv = (await d.select().from(invoices).where(eq(invoices.invoiceNumber, input.invoiceNumber)).limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice" });
    if (inv.status === "draft" || inv.status === "void") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Invoice is ${inv.status} — a document is rendered from a finalized invoice's snapshot` });
    const existing = (await d.select().from(fieldTicketDocuments).where(and(eq(fieldTicketDocuments.invoiceId, inv.id), eq(fieldTicketDocuments.kind, "invoice"))).limit(1))[0];
    if (existing) return { documentRef: existing.documentRef, contentHash: existing.contentHash, byteLength: existing.byteLength, alreadyRendered: true as const };
    const snap = (await d.select().from(billingSnapshots).where(eq(billingSnapshots.invoiceId, inv.id)).limit(1))[0];
    if (!snap) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Invoice has no snapshot" });
    const calc = JSON.parse(snap.calculatedLinesJson) as Parameters<typeof invoiceDocumentLines>[1];
    const bytes = renderPdf(`Invoice ${inv.invoiceNumber}`, invoiceDocumentLines(inv, calc, snap.payloadHash));
    const contentHash = sha256Hex(bytes);
    const stored = await storagePut(`invoices/${inv.invoiceNumber}/${contentHash.slice(0, 12)}.pdf`, bytes, "application/pdf");
    const ticketLineIds = (await d.select({ fieldTicketLineId: invoiceLines.fieldTicketLineId }).from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))).map(l => l.fieldTicketLineId).filter((x): x is number => x != null);
    const ticketId = ticketLineIds.length ? (await d.select({ fieldTicketId: fieldTicketLines.fieldTicketId }).from(fieldTicketLines).where(eq(fieldTicketLines.id, ticketLineIds[0]!)).limit(1))[0]?.fieldTicketId ?? null : null;
    if (ticketId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Invoice lines reference no ticket" });
    const documentRef = `${inv.invoiceNumber}-PDF`;
    await d.insert(fieldTicketDocuments).values({ documentRef, fieldTicketId: ticketId, revisionId: null, invoiceId: inv.id, kind: "invoice", storageKey: stored.key, contentHash, sourceSnapshotHash: snap.payloadHash, byteLength: bytes.length, generatedByUserId: ctx.user.id, generatedAt: new Date() });
    return { documentRef, contentHash, byteLength: bytes.length, alreadyRendered: false as const };
  }),

  /** Void: recorded on the invoice, never by deleting it. Refused where money is applied — that is a credit. The book's entries are released. */
  void: roleProcedure("invoicing.void").input(z.object({ invoiceNumber: z.string().min(1).max(64), reason: z.string().min(5).max(400) })).mutation(async ({ ctx, input }) => {
    const d = await db();
    const inv = (await d.select().from(invoices).where(eq(invoices.invoiceNumber, input.invoiceNumber)).limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice" });
    const allocated = (await d.select({ amountCents: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.invoiceId, inv.id))).reduce((a, r) => a + r.amountCents, 0);
    const credited = (await d.select({ amountCents: customerCredits.amountCents, status: customerCredits.status }).from(customerCredits).where(eq(customerCredits.invoiceId, inv.id))).filter(c => c.status === "approved").reduce((a, r) => a + r.amountCents, 0);
    const check = voidCheck({ status: inv.status, allocatedCents: allocated, approvedCreditCents: credited });
    if (!check.permitted) return { voided: false as const, refusals: check.refusals };
    await d.update(invoices).set({ status: "void", voidedAt: new Date(), voidedByUserId: ctx.user.id, voidReason: input.reason }).where(eq(invoices.id, inv.id));
    const lineIds = (await d.select({ fieldTicketLineId: invoiceLines.fieldTicketLineId }).from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))).map(l => l.fieldTicketLineId).filter((x): x is number => x != null);
    if (lineIds.length) await d.update(billingBookEntries).set({ billingStatus: "ready", holdReason: `Released: invoice ${inv.invoiceNumber} voided — ${input.reason}`.slice(0, 300) }).where(and(eq(billingBookEntries.billingBookId, inv.billingBookId), inArray(billingBookEntries.fieldTicketLineId, lineIds)));
    await d.update(billingBooks).set({ billingState: "billing_review" }).where(eq(billingBooks.id, inv.billingBookId));
    return { voided: true as const, invoiceNumber: inv.invoiceNumber, releasedLines: lineIds.length };
  }),

  /** Resolve a dispute: upheld, credited or partial. A credit is requested here and approved by a second person in AR; the invoice returns to its delivery state. */
  disputeResolve: roleProcedure("invoicing.disputeResolve").input(z.object({ caseNumber: z.string().min(1).max(64), outcome: z.enum(["upheld", "credited", "partial"]), creditAmountCents: z.number().int().positive().optional(), narrative: z.string().min(10).max(2000) })).mutation(async ({ ctx, input }) => {
    const d = await db();
    const c = (await d.select().from(disputeCases).where(eq(disputeCases.caseNumber, input.caseNumber)).limit(1))[0];
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "No such dispute case" });
    if (!c.invoiceNumber) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The case names no invoice" });
    const inv = (await d.select().from(invoices).where(eq(invoices.invoiceNumber, c.invoiceNumber)).limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "The case names no invoice on file" });
    const res = disputeResolution({ caseStatus: c.status, outcome: input.outcome, disputedAmountCents: c.disputedAmountCents ?? 0, creditAmountCents: input.creditAmountCents ?? null });
    if (!res.permitted) return { resolved: false as const, refusals: res.refusals };
    let creditRef: string | null = null;
    if (res.creditCents > 0) {
      creditRef = ref("CR");
      if (inv.financialEntityId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The invoice carries no financial entity — assign it before a credit is requested against it" });
      await d.insert(customerCredits).values({ creditRef, financialEntityId: inv.financialEntityId, customer: inv.customer, customerAccountId: inv.customerAccountId, invoiceId: inv.id, amountCents: res.creditCents, reason: `Dispute ${c.caseNumber}: ${input.narrative}`.slice(0, 400), requestedByUserId: ctx.user.id, status: "requested" });
    }
    await d.update(disputeCases).set({ status: res.caseStatus!, resolutionNarrative: input.narrative, resolvedAt: new Date(), assignedUserId: ctx.user.id }).where(eq(disputeCases.id, c.id));
    const delivery = inv.viewedAt ? "viewed" : "sent";
    if (inv.status === "disputed") await d.update(invoices).set({ status: delivery }).where(eq(invoices.id, inv.id));
    await queueCustomerAlert({ customerAccountId: inv.customerAccountId, kind: "dispute_update", ticketNumber: inv.invoiceNumber, subjectRef: c.caseNumber, detail: `Dispute ${c.caseNumber} ${res.caseStatus!.replace("resolved_", "")}${res.creditCents ? ` — credit of ${inv.currency} ${(res.creditCents / 100).toFixed(2)} requested, pending approval` : ""}` });
    return { resolved: true as const, caseNumber: c.caseNumber, caseStatus: res.caseStatus!, creditRef, creditCents: res.creditCents, invoiceStatus: inv.status === "disputed" ? delivery : inv.status, next: creditRef ? "A second person approves the credit (ar.creditDecide)." : null };
  }),

  /** Send: a finalized, rendered invoice goes to the customer's portal with its due date from the account's terms; the customer is alerted. */
  send: roleProcedure("invoicing.send").input(z.object({ invoiceNumber: z.string().min(1).max(64) })).mutation(async ({ input }) => {
    const d = await db();
    const inv = (await d.select().from(invoices).where(eq(invoices.invoiceNumber, input.invoiceNumber)).limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice" });
    if (inv.status !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Invoice is ${inv.status} — only a finalized, unsent invoice is sent` });
    const doc = (await d.select().from(fieldTicketDocuments).where(and(eq(fieldTicketDocuments.invoiceId, inv.id), eq(fieldTicketDocuments.kind, "invoice"))).limit(1))[0];
    if (!doc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Render the invoice document before sending" });
    const account = inv.customerAccountId != null ? (await d.select().from(customerAccounts).where(eq(customerAccounts.id, inv.customerAccountId)).limit(1))[0] ?? null : null;
    const termsDays = account?.paymentTermsDays ?? 30;
    const sentAt = new Date();
    const dueAt = new Date((inv.issuedAt ?? sentAt).getTime() + termsDays * 86_400_000);
    await d.update(invoices).set({ status: "sent", sentAt, dueAt }).where(eq(invoices.id, inv.id));
    const ticket = (await d.select({ ticketNumber: fieldTickets.ticketNumber }).from(fieldTickets).where(eq(fieldTickets.id, doc.fieldTicketId)).limit(1))[0];
    const alert = await queueCustomerAlert({ customerAccountId: inv.customerAccountId, kind: "billing_update", ticketNumber: ticket?.ticketNumber ?? inv.invoiceNumber, subjectRef: inv.invoiceNumber, detail: `Invoice ${inv.invoiceNumber} issued: ${inv.currency} ${(inv.totalCents / 100).toFixed(2)}, due ${dueAt.toISOString().slice(0, 10)}` });
    return { invoiceNumber: inv.invoiceNumber, status: "sent" as const, sentAt, dueAt, termsDays, documentRef: doc.documentRef, alertsQueued: alert.queued };
  }),

  /** Draft an invoice from a signed ticket: accepted, priced lines enter; the rest are excluded with a reason or block the draft. */
  draftFromTicket: roleProcedure("invoicing.draftFromTicket")
    .input(z.object({ ticketNumber: z.string().min(1).max(64), purchaseOrder: z.string().max(80).optional(), afeNumber: z.string().max(80).optional() }))
    .mutation(async ({ input }) => {
      const d = await db();
      const x = await ticketForInvoice(d, input.ticketNumber);
      if (!x.account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ticket has no customer account — an invoice is addressed to an account" });
      // v22.11 — lines already on a live (non-void) invoice are excluded; what remains is a supplemental draft, or nothing new
      const onLines = x.lines.length ? await d.select({ fieldTicketLineId: invoiceLines.fieldTicketLineId, invoiceId: invoiceLines.invoiceId }).from(invoiceLines).where(inArray(invoiceLines.fieldTicketLineId, x.lines.map(l => l.id))) : [];
      const liveInvoices = onLines.length ? await d.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status }).from(invoices).where(inArray(invoices.id, Array.from(new Set(onLines.map(o => o.invoiceId))))) : [];
      const liveByInvoice = new Map(liveInvoices.filter(i => i.status !== "void").map(i => [i.id, i.invoiceNumber]));
      const alreadyInvoiced = new Map<number, string>();
      for (const o of onLines) { const n = liveByInvoice.get(o.invoiceId); if (n && o.fieldTicketLineId != null) alreadyInvoiced.set(o.fieldTicketLineId, n); }
      const draft = draftFromTicket({ signed: x.signed, ticketStatus: x.t.status, lines: x.forDraft, partialAcceptanceAllowed: x.partialAcceptanceAllowed, alreadyInvoiced });
      if (draft.blockers.length) return { drafted: false as const, blockers: draft.blockers, excluded: draft.excluded, subtotalCents: draft.subtotalCents };
      // the job's billing book, opened if absent
      let book = (await d.select().from(billingBooks).where(eq(billingBooks.jobId, x.t.jobId)).limit(1))[0];
      if (!book) {
        const ins = await d.insert(billingBooks).values({ bookNumber: ref("BB"), jobId: x.t.jobId, customer: x.account.name, afeNumber: input.afeNumber ?? null, purchaseOrder: input.purchaseOrder ?? null, billingState: "billing_review", openedAt: new Date() });
        book = (await d.select().from(billingBooks).where(eq(billingBooks.id, Number(ins[0]?.insertId ?? 0))).limit(1))[0]!;
      }
      const invoiceNumber = ref("INV");
      const ins = await d.insert(invoices).values({ invoiceNumber, financialEntityId: x.account.financialEntityId, billingBookId: book.id, jobId: x.t.jobId, customer: x.account.name, customerAccountId: x.account.id, afeNumber: input.afeNumber ?? null, purchaseOrder: input.purchaseOrder ?? null, subtotalCents: draft.subtotalCents, taxCents: 0, gstTreatment: "unknown", gstTreatmentSource: null, totalCents: draft.subtotalCents, currency: "CAD", status: "draft" });
      const invoiceId = Number(ins[0]?.insertId ?? 0);
      await d.insert(invoiceLines).values(draft.lines.map(l => ({ invoiceId, lineNo: l.lineNo, fieldTicketLineId: l.fieldTicketLineId, pricingDecisionRef: l.pricingDecisionRef, serviceCode: l.serviceCode, description: l.description, quantityMillis: l.quantityMillis, billableQuantityMillis: l.billableQuantityMillis, unit: l.unit, rateMillis: l.rateMillis, amountCents: l.amountCents, basis: l.basis })));
      const existingEntries = await d.select({ id: billingBookEntries.id, fieldTicketLineId: billingBookEntries.fieldTicketLineId }).from(billingBookEntries).where(eq(billingBookEntries.billingBookId, book.id));
      const entryByLine = new Map(existingEntries.map(e => [e.fieldTicketLineId, e.id]));
      for (const l of draft.lines) {
        const id = entryByLine.get(l.fieldTicketLineId);
        if (id) await d.update(billingBookEntries).set({ billingUnit: l.unit, billingStatus: "ready", holdReason: null }).where(eq(billingBookEntries.id, id));
        else await d.insert(billingBookEntries).values({ billingBookId: book.id, fieldTicketLineId: l.fieldTicketLineId, billingUnit: l.unit, billingStatus: "ready" });
      }
      for (const e of draft.excluded) {
        if (e.reason.startsWith("Already on invoice")) continue;
        const id = entryByLine.get(e.fieldTicketLineId);
        if (id) await d.update(billingBookEntries).set({ billingStatus: "held", holdReason: e.reason.slice(0, 300) }).where(eq(billingBookEntries.id, id));
        else await d.insert(billingBookEntries).values({ billingBookId: book.id, fieldTicketLineId: e.fieldTicketLineId, billingUnit: "n/a", billingStatus: "held", holdReason: e.reason.slice(0, 300) });
      }
      return { drafted: true as const, invoiceNumber, bookNumber: book.bookNumber, subtotalCents: draft.subtotalCents, lines: draft.lines.length, excluded: draft.excluded, gstTreatment: "unknown" as const, next: "Set the GST/HST treatment (gst.treatmentSet), then finalize." };
    }),

  get: roleProcedure("invoicing.get").input(z.object({ invoiceNumber: z.string().min(1).max(64) })).query(async ({ input }) => {
    const d = await db();
    const inv = (await d.select().from(invoices).where(eq(invoices.invoiceNumber, input.invoiceNumber)).limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice" });
    const lines = await d.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const snap = (await d.select({ payloadHash: billingSnapshots.payloadHash, capturedAt: billingSnapshots.capturedAt }).from(billingSnapshots).where(eq(billingSnapshots.invoiceId, inv.id)).limit(1))[0] ?? null;
    return { ...inv, lines: lines.sort((a, b) => a.lineNo - b.lineNo), snapshot: snap };
  }),

  /** Finalize: a second permission freezes the snapshot. A taxable invoice needs a verified rate; an unknown treatment is refused. */
  finalize: roleProcedure("invoicing.finalize")
    .input(z.object({ invoiceNumber: z.string().min(1).max(64), jurisdiction: z.string().min(2).max(20).default("CA-AB") }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const inv = (await d.select().from(invoices).where(eq(invoices.invoiceNumber, input.invoiceNumber)).limit(1))[0];
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "No such invoice" });
      const lines = await d.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      const rules = await loadTaxRules(input.jurisdiction);
      const keys = new Set(rules.map(r => r.ruleKey));
      const det = determine([...rules, ...GST_RATE_SEEDS.filter(s => !keys.has(s.ruleKey))], { jurisdiction: input.jurisdiction, ruleType: GST_RATE_RULE_TYPE, asOf: new Date() }) as { outcome: string; reason?: string | null; parameters?: { ratePercent?: number | null } };
      const rate = { outcome: (det.outcome === "determined" ? "determined" : /unverified/i.test(det.reason ?? "") ? "unverified" : "missing") as "determined" | "unverified" | "missing", ratePercent: typeof det.parameters?.ratePercent === "number" ? det.parameters.ratePercent : null, reason: det.reason ?? null };
      const check = finalizeCheck({ status: inv.status, gstTreatment: inv.gstTreatment, jurisdiction: input.jurisdiction, rate, subtotalCents: inv.subtotalCents, lineCount: lines.length });
      if (!check.permitted) return { finalized: false as const, refusals: check.refusals };
      const decisions = await d.select().from(pricingDecisions).where(inArray(pricingDecisions.decisionRef, lines.map(l => l.pricingDecisionRef!).filter(Boolean)));
      const ticketLines = await d.select().from(fieldTicketLines).where(inArray(fieldTicketLines.id, lines.map(l => l.fieldTicketLineId!).filter((x): x is number => x != null)));
      const totalCents = inv.subtotalCents + check.taxCents!;
      const sourceFacts = { invoiceNumber: inv.invoiceNumber, ticketLines: ticketLines.map(l => ({ id: l.id, description: l.description, quantity: l.quantity, quantityUnit: l.quantityUnit, measurementMethod: l.measurementMethod, disposition: l.disposition })), decisions: decisions.map(x => ({ decisionRef: x.decisionRef, serviceCode: x.serviceCode, quantityMillis: x.quantityMillis, billableQuantityMillis: x.billableQuantityMillis, rateMillis: x.rateMillis, amountCents: x.amountCents, scopeLevel: x.scopeLevel, formula: x.formula, reasons: JSON.parse(x.reasonsJson) })) };
      const calculated = { lines: lines.map(l => ({ lineNo: l.lineNo, description: l.description, billableQuantityMillis: l.billableQuantityMillis, unit: l.unit, rateMillis: l.rateMillis, amountCents: l.amountCents, basis: l.basis })), gstTreatment: inv.gstTreatment, ratePercent: rate.ratePercent, taxCents: check.taxCents, subtotalCents: inv.subtotalCents, totalCents };
      const payloadHash = snapshotHash({ sourceFacts, calculated });
      await d.insert(billingSnapshots).values({ invoiceId: inv.id, billingBookId: inv.billingBookId, capturedAt: new Date(), capturedByUserId: ctx.user.id, rateCardVersion: null, sourceFactsJson: JSON.stringify(sourceFacts), calculatedLinesJson: JSON.stringify(calculated), excludedLinesJson: "[]", subtotalCents: inv.subtotalCents, totalCents, payloadHash });
      await d.update(invoices).set({ status: "approved", issuedAt: new Date(), taxCents: check.taxCents!, totalCents }).where(eq(invoices.id, inv.id));
      await d.update(billingBookEntries).set({ billingStatus: "billed" }).where(and(eq(billingBookEntries.billingBookId, inv.billingBookId), inArray(billingBookEntries.fieldTicketLineId, lines.map(l => l.fieldTicketLineId!).filter((x): x is number => x != null))));
      await d.update(billingBooks).set({ billingState: "invoiced" }).where(eq(billingBooks.id, inv.billingBookId));
      return { finalized: true as const, invoiceNumber: inv.invoiceNumber, subtotalCents: inv.subtotalCents, taxCents: check.taxCents!, totalCents, ratePercent: rate.ratePercent, payloadHash };
    }),
});
