/**
 * Commercial core (internal) and portal administration.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nextTrackingNumber } from "./_core/trackingNumbers";
import { createHash } from "node:crypto";
import { INVITATION_TTL_MS, newToken } from "./_core/externalIdentityPolicy";
import { queueCustomerAlert } from "./customerAlertService";
import { and, desc, eq, inArray } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { toCents } from "./_core/money";
import { actingScopeFor, getDb, mintedIn, ownerFor } from "./db";
import { customerAccounts, customerCredits, customerPurchaseOrders, customerRateCardLines, customerRateCards, disposalTickets, disputeCases, externalIdentities, facilities, invoices, paymentAllocations, portalSubmissions, vendorBills, vendorBillLines, vendors } from "../drizzle/schema";
import { commercialBillingCheck, priceLines, type PurchaseOrder } from "./_core/commercial";
import { invoiceBalanceCents } from "./_core/accountsReceivable";
import type { DisposalTicketPayload, VendorBillPayload } from "./_core/portalIntake";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function poRecordFor(id: number): Promise<PurchaseOrder | null> {
  const db = await getDb();
  if (!db) return null;
  const po = (await db.select().from(customerPurchaseOrders).where(eq(customerPurchaseOrders.id, id)).limit(1))[0];
  if (!po) return null;
  const consumed = (await db.select({ total: invoices.totalCents }).from(invoices).where(and(eq(invoices.customerPurchaseOrderId, po.id), inArray(invoices.status, ["sent", "viewed", "approved", "partially_paid", "paid", "disputed"])))).reduce((a, i) => a + i.total, 0);
  return { poRef: po.poRef, poNumber: po.poNumber, afeNumber: po.afeNumber, authorizedCents: po.authorizedCents, consumedCents: consumed, validFrom: po.validFrom, validTo: po.validTo, status: po.status };
}

export const commercialRouter = router({
  termsSet: roleProcedure("commercial.termsSet")
    .input(z.object({ accountRef: z.string().min(1).max(64), paymentTermsDays: z.number().int().min(0).max(180).optional(), creditLimitCents: z.number().int().nonnegative().nullable().optional(), requiresPurchaseOrder: z.boolean().optional(), requiresAfe: z.boolean().optional(), billingFrequency: z.enum(["per_job", "weekly", "monthly"]).optional(), status: z.enum(["active", "on_hold", "inactive"]).optional(), holdReason: z.string().max(300).nullable().optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const a = (await db.select().from(customerAccounts).where(eq(customerAccounts.accountRef, input.accountRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Customer account not found" });
      if (input.status === "on_hold" && !input.holdReason) throw new TRPCError({ code: "BAD_REQUEST", message: "A hold needs a reason" });
      const { accountRef, ...patch } = input;
      await db.update(customerAccounts).set({ ...patch, holdReason: input.status === "on_hold" ? input.holdReason ?? null : input.status ? null : input.holdReason ?? a.holdReason }).where(eq(customerAccounts.id, a.id));
      return { accountRef, status: input.status ?? a.status };
    }),

  poRecord: roleProcedure("commercial.poRecord")
    .input(z.object({ accountRef: z.string().min(1).max(64), poNumber: z.string().min(1).max(80), afeNumber: z.string().max(80).nullable().optional(), authorizedCents: z.number().int().positive(), validFrom: z.coerce.date(), validTo: z.coerce.date().nullable().optional(), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const a = (await db.select().from(customerAccounts).where(eq(customerAccounts.accountRef, input.accountRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Customer account not found" });
      const poRef = ref("PO");
      await db.insert(customerPurchaseOrders).values({ poRef, customerAccountId: a.id, financialEntityId: a.financialEntityId, poNumber: input.poNumber, afeNumber: input.afeNumber ?? null, authorizedCents: input.authorizedCents, validFrom: input.validFrom, validTo: input.validTo ?? null, evidenceRecordId: input.evidenceRecordId ?? null, recordedByUserId: ctx.user.id });
      return { poRef, poNumber: input.poNumber };
    }),

  rateCardCreate: roleProcedure("commercial.rateCardCreate")
    .input(z.object({ accountRef: z.string().min(1).max(64), effectiveFrom: z.coerce.date(), lines: z.array(z.object({ serviceCode: z.string().min(1).max(60), description: z.string().min(1).max(220), unit: z.enum(["hour", "day", "km", "m3", "tonne", "load", "each"]), rateCents: z.number().int().nonnegative(), minimumCents: z.number().int().nonnegative().nullable().optional() })).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const a = (await db.select().from(customerAccounts).where(eq(customerAccounts.accountRef, input.accountRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Customer account not found" });
      const prior = (await db.select({ id: customerRateCards.id, version: customerRateCards.version }).from(customerRateCards).where(and(eq(customerRateCards.customerAccountId, a.id), eq(customerRateCards.status, "approved"))).orderBy(desc(customerRateCards.version)).limit(1))[0];
      const version = (prior?.version ?? 0) + 1;
      const rateCardRef = ref("RC");
      const ins = await db.insert(customerRateCards).values({ rateCardRef, customerAccountId: a.id, version, effectiveFrom: input.effectiveFrom, status: "approved", approvedByUserId: ctx.user.id, approvedAt: new Date(), createdByUserId: ctx.user.id });
      const id = Number(ins[0]?.insertId ?? 0);
      for (const l of input.lines) await db.insert(customerRateCardLines).values({ rateCardId: id, serviceCode: l.serviceCode, description: l.description, unit: l.unit, rateCents: l.rateCents, minimumCents: l.minimumCents ?? null });
      if (prior) await db.update(customerRateCards).set({ status: "superseded", effectiveTo: input.effectiveFrom }).where(eq(customerRateCards.id, prior.id));
      return { rateCardRef, version, supersededVersion: prior?.version ?? null };
    }),

  /** May this invoice be issued to this customer? Named blockers; a due date from the terms; lines priced from the card. */
  billingCheck: roleProcedure("commercial.billingCheck")
    .input(z.object({ accountRef: z.string().min(1).max(64), invoiceTotalCents: z.number().int().positive(), poNumber: z.string().max(80).nullable().optional(), afeNumber: z.string().max(80).nullable().optional(), at: z.coerce.date().optional(), serviceLines: z.array(z.object({ serviceCode: z.string().min(1).max(60), quantity: z.number().positive(), unit: z.enum(["hour", "day", "km", "m3", "tonne", "load", "each"]) })).optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const a = (await db.select().from(customerAccounts).where(eq(customerAccounts.accountRef, input.accountRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Customer account not found" });
      const at = input.at ?? new Date();
      const poRow = input.poNumber ? (await db.select({ id: customerPurchaseOrders.id }).from(customerPurchaseOrders).where(and(eq(customerPurchaseOrders.customerAccountId, a.id), eq(customerPurchaseOrders.poNumber, input.poNumber))).limit(1))[0] : undefined;
      const po = poRow ? await poRecordFor(poRow.id) : null;
      const inv = await db.select().from(invoices).where(eq(invoices.customerAccountId, a.id));
      const ids = inv.map(i => i.id);
      const [allocs, creds] = await Promise.all([ids.length ? db.select().from(paymentAllocations).where(inArray(paymentAllocations.invoiceId, ids)) : [], db.select().from(customerCredits).where(eq(customerCredits.customerAccountId, a.id))]);
      const outstanding = inv.filter(i => i.status !== "void" && i.status !== "draft").reduce((s, i) => s + Math.max(0, invoiceBalanceCents({ id: i.id, invoiceNumber: i.invoiceNumber, customer: i.customer, totalCents: i.totalCents, dueAt: i.dueAt, issuedAt: i.issuedAt ?? i.createdAt, status: i.status, disputed: false }, allocs.map(x => ({ invoiceId: x.invoiceId, amountCents: x.amountCents })), creds.map(c => ({ invoiceId: c.invoiceId, customer: c.customer, amountCents: c.amountCents, status: c.status })))), 0);
      const check = commercialBillingCheck({ terms: { status: a.status, holdReason: a.holdReason, paymentTermsDays: a.paymentTermsDays, creditLimitCents: a.creditLimitCents, requiresPurchaseOrder: a.requiresPurchaseOrder, requiresAfe: a.requiresAfe }, invoiceTotalCents: input.invoiceTotalCents, outstandingCents: outstanding, po, afeSupplied: input.afeNumber ?? null, at });
      let pricing: ReturnType<typeof priceLines> | null = null;
      if (input.serviceLines?.length) {
        const card = (await db.select().from(customerRateCards).where(and(eq(customerRateCards.customerAccountId, a.id), eq(customerRateCards.status, "approved"))).orderBy(desc(customerRateCards.version)).limit(1))[0];
        const lines = card ? await db.select().from(customerRateCardLines).where(eq(customerRateCardLines.rateCardId, card.id)) : [];
        pricing = priceLines(lines.map(l => ({ serviceCode: l.serviceCode, unit: l.unit, rateCents: l.rateCents, minimumCents: l.minimumCents })), input.serviceLines);
      }
      return { accountRef: a.accountRef, ...check, outstandingCents: outstanding, po: po ? { poRef: po.poRef, remainingCents: po.authorizedCents - po.consumedCents } : null, pricing };
    }),
});

export const portalAdminRouter = router({
  /**
   * v21.12 — Invite an external identity. The invitation token is returned
   * once and stored only as a hash; it expires; accepting it (through the
   * external gate) issues the bearer token. Nothing is active until accepted.
   */
  identityInvite: roleProcedure("portalAdmin.identityInvite")
    .input(z.object({ kind: z.enum(["customer", "vendor", "facility"]), accountRef: z.string().max(64).optional(), vendorId: z.number().int().positive().optional(), facilityId: z.number().int().positive().optional(), email: z.string().email().max(220), displayName: z.string().min(1).max(180) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      let customerAccountId: number | null = null, vendorId: number | null = null, facilityId: number | null = null;
      if (input.kind === "customer") { const a = input.accountRef ? (await db.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.accountRef, input.accountRef)).limit(1))[0] : undefined; if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Customer account not found" }); customerAccountId = a.id; }
      if (input.kind === "vendor") { const v = input.vendorId ? (await db.select({ id: vendors.id, portalEnabled: vendors.portalEnabled }).from(vendors).where(eq(vendors.id, input.vendorId)).limit(1))[0] : undefined; if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor not found" }); vendorId = v.id; if (!v.portalEnabled) await db.update(vendors).set({ portalEnabled: true }).where(eq(vendors.id, v.id)); }
      if (input.kind === "facility") { const f = input.facilityId ? (await db.select({ id: facilities.id }).from(facilities).where(eq(facilities.id, input.facilityId)).limit(1))[0] : undefined; if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "Facility not found" }); facilityId = f.id; }
      const invitationToken = newToken();
      const now = new Date();
      const identityRef = ref("EXT");
      // tokenHash must be unique and non-null; an unaccepted identity holds an unusable placeholder that no bearer can equal.
      await db.insert(externalIdentities).values({ identityRef, kind: input.kind, customerAccountId, vendorId, facilityId, email: input.email, displayName: input.displayName, tokenHash: sha(`unaccepted:${identityRef}:${invitationToken}`), invitationTokenHash: sha(invitationToken), invitationExpiresAt: new Date(now.getTime() + INVITATION_TTL_MS), status: "invited", invitedByUserId: ctx.user.id, invitedAt: now });
      return { identityRef, invitationToken, invitationExpiresAt: new Date(now.getTime() + INVITATION_TTL_MS), note: "The invitation token is shown once and stored only as a hash. Accepting it issues the bearer token." };
    }),

  identityRevoke: roleProcedure("portalAdmin.identityRevoke")
    .input(z.object({ identityRef: z.string().min(1).max(64), reason: z.string().min(5).max(300) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const row = (await db.select({ id: externalIdentities.id, status: externalIdentities.status }).from(externalIdentities).where(eq(externalIdentities.identityRef, input.identityRef)).limit(1))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Identity not found" });
      await db.update(externalIdentities).set({ status: "revoked", revokedAt: new Date(), revokedReason: input.reason, previousTokenHash: null, previousTokenExpiresAt: null }).where(eq(externalIdentities.id, row.id));
      return { identityRef: input.identityRef, status: "revoked" as const };
    }),

  /** A person inside accepts or rejects what came in from outside. Acceptance is what creates the LeaseOS record. */
  submissionReview: roleProcedure("portalAdmin.submissionReview")
    .input(z.object({ submissionRef: z.string().min(1).max(64), decision: z.enum(["accepted", "rejected"]), reason: z.string().min(3).max(400), financialEntityId: z.number().int().positive().optional(), loadId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const scope = await actingScopeFor(ctx.user.id);
      const sub = (await db.select().from(portalSubmissions).where(eq(portalSubmissions.submissionRef, input.submissionRef)).limit(1))[0];
      if (!sub) throw new TRPCError({ code: "NOT_FOUND", message: "Submission not found" });
      if (sub.status !== "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Submission is ${sub.status}` });
      const identity = (await db.select().from(externalIdentities).where(eq(externalIdentities.id, sub.externalIdentityId)).limit(1))[0]!;
      let resultRef: string | null = null;
      if (input.decision === "accepted") {
        if (sub.kind === "vendor_bill") {
          if (!input.financialEntityId) throw new TRPCError({ code: "BAD_REQUEST", message: "Accepting a vendor bill needs the financial entity it is billed to" });
          const p = JSON.parse(sub.payloadJson) as VendorBillPayload & { invoiceDate: string };
          const billRef = ref("BILL");
          const ins = await db.insert(vendorBills).values({ billRef, financialEntityId: input.financialEntityId, vendorId: identity.vendorId!, vendorInvoiceNumber: p.vendorInvoiceNumber, invoiceDate: new Date(p.invoiceDate), receivedAt: sub.submittedAt, subtotalCents: toCents(p.subtotal), taxAmountCents: toCents(p.taxAmount), totalCents: toCents(p.total)!, matchOutcome: "unmatched", status: "received", purchaseAuthorizationId: null });
          const billId = Number(ins[0]?.insertId ?? 0);
          // A vendor's line arrives untyped; it enters as "other" and the office codes it on review.
          for (let i = 0; i < p.lines.length; i++) { const l = p.lines[i]!; await db.insert(vendorBillLines).values({ vendorBillId: billId, lineNo: i + 1, lineType: "other", description: l.description, quantity: l.quantity, unitPriceCents: toCents(l.unitPrice), amountCents: toCents(Math.round(l.quantity * l.unitPrice * 100) / 100)! }); }
          resultRef = billRef;
        } else if (sub.kind === "disposal_ticket") {
          const p = JSON.parse(sub.payloadJson) as DisposalTicketPayload & { scaleInAt: string; confidence?: "low" | "medium" | "high" };
          const ticketNumber = (await nextTrackingNumber(db, { sequenceType: "DSP", orgRef: ownerFor(scope) })).trackingNumber;
          await db.insert(disposalTickets).values({ ticketNumber, orgRef: ownerFor(scope), loadId: input.loadId ?? null, facilityId: identity.facilityId!, facilityTicketNumber: p.facilityTicketNumber, scaleInAt: new Date(p.scaleInAt), grossKg: p.grossKg, tareKg: p.tareKg, netKg: p.netKg, quantity: p.quantity, quantityUnit: p.quantityUnit, verificationStatus: "needs_review", source: "facility_portal", confidence: p.confidence ?? "medium", evidenceRefs: p.scaleRecordHash ? JSON.stringify({ scaleRecordHash: p.scaleRecordHash }) : null });
          resultRef = ticketNumber;
        } else if (sub.kind === "invoice_dispute") {
          const p = JSON.parse(sub.payloadJson) as { invoiceNumber: string; disputedAmountCents: number; reason: string };
          const inv = (await db.select().from(invoices).where(mintedIn(invoices, invoices.invoiceNumber, p.invoiceNumber, scope)).limit(1))[0];
          if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
          const caseNumber = ref("DISP");
          await db.insert(disputeCases).values({ caseNumber, invoiceNumber: inv.invoiceNumber, jobId: inv.jobId, customer: inv.customer, raisedByName: identity.displayName, raisedByCompany: inv.customer, disputedAmountCents: p.disputedAmountCents, reasonStated: p.reason, status: "raised", raisedAt: sub.submittedAt });
          await db.update(invoices).set({ status: "disputed", disputeReason: p.reason, disputedAt: sub.submittedAt }).where(eq(invoices.id, inv.id));
          resultRef = caseNumber;
        }
      }
      await db.update(portalSubmissions).set({ status: input.decision, resultRef, reviewedByUserId: ctx.user.id, reviewedAt: new Date(), reviewReason: input.reason }).where(eq(portalSubmissions.id, sub.id));
      if (sub.kind === "invoice_dispute" && identity.customerAccountId != null) {
        const p = JSON.parse(sub.payloadJson) as { invoiceNumber: string };
        await queueCustomerAlert({ customerAccountId: identity.customerAccountId, kind: "dispute_update", ticketNumber: p.invoiceNumber, detail: `${input.decision} — ${input.reason}`, subjectRef: sub.submissionRef });
      }
      return { submissionRef: sub.submissionRef, status: input.decision, resultRef };
    }),
});
