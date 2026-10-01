/**
 * Commercial projects — the internal API. Quotes priced from the card and
 * frozen at issue; change orders; RFIs; budgets by cost code; the forecast.
 *
 * P0-A3 — every procedure is `moneyScoped`: the caller's books come from the membership
 * (`ctx.money`), and every account, quote, budget, change order, RFI and job the input names is
 * resolved through server/financeScope.ts, which answers a foreign one exactly as a missing one.
 * Lists and sums (`forecast`) carry the book predicate in the query. This file declares no lookup
 * of its own: `server/projectFinanceBoundaryGuard.test.ts` pins that.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { budgetLines, changeOrders, customerRateCardLines, customerRateCards, invoices, jobs, paymentAllocations, projectBudgets, quoteLines, quotes, rfis } from "../drizzle/schema";
import { ownedEntityWhere } from "./_core/entityScope";
import { customerAccountInScope, ownedAccountWhere, projectBudgetInScope, quoteInScope, requireJob, rfiInScope } from "./financeScope";
import { priceLines } from "./_core/commercial";
import { projectForecast } from "./_core/commercialProjects";
import { canonicalJson } from "./_core/siteCloseout";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const UNIT = z.enum(["hour", "day", "km", "m3", "tonne", "load", "each"]);
async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }

const LINE = z.object({ serviceCode: z.string().min(1).max(60), description: z.string().min(1).max(220), quantity: z.number().positive(), unit: UNIT, explicitRateCents: z.number().int().nonnegative().optional(), costCode: z.string().max(40).optional() });

/** Price from the account's approved card; a line the card cannot price needs an explicit rate, and says so. The account was already proved the caller's. */
async function priceForAccount(accountId: number, lines: z.infer<typeof LINE>[]) {
  const db = await dbOrThrow();
  const card = (await db.select().from(customerRateCards).where(and(eq(customerRateCards.customerAccountId, accountId), eq(customerRateCards.status, "approved"))).orderBy(desc(customerRateCards.version)).limit(1))[0];
  const cardLines = card ? await db.select().from(customerRateCardLines).where(eq(customerRateCardLines.rateCardId, card.id)) : [];
  const priced = priceLines(cardLines.map(l => ({ serviceCode: l.serviceCode, unit: l.unit, rateCents: l.rateCents, minimumCents: l.minimumCents })), lines.filter(l => l.explicitRateCents == null).map(l => ({ serviceCode: l.serviceCode, quantity: l.quantity, unit: l.unit })));
  const out: { serviceCode: string; description: string; quantity: number; unit: string; rateCents: number; amountCents: number; priceSource: "rate_card" | "explicit"; costCode: string | null }[] = [];
  const unpriced: string[] = [];
  for (const l of lines) {
    if (l.explicitRateCents != null) { out.push({ serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, unit: l.unit, rateCents: l.explicitRateCents, amountCents: Math.round(l.quantity * l.explicitRateCents), priceSource: "explicit", costCode: l.costCode ?? null }); continue; }
    const p = priced.priced.find(x => x.serviceCode === l.serviceCode && x.unit === l.unit);
    if (!p) { unpriced.push(`${l.serviceCode}: ${priced.unpriced.find(u => u.serviceCode === l.serviceCode)?.reason ?? "no rate on the customer's card"}`); continue; }
    out.push({ serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, unit: l.unit, rateCents: p.rateCents, amountCents: p.amountCents, priceSource: "rate_card", costCode: l.costCode ?? null });
  }
  return { lines: out, unpriced, rateCardId: card?.id ?? null, subtotalCents: out.reduce((a, l) => a + l.amountCents, 0) };
}

export const projectRouter = router({
  quoteCreate: moneyScoped(roleProcedure("project.quoteCreate"))
    .input(z.object({ accountRef: z.string().min(1).max(64), jobId: z.number().int().positive().nullable().optional(), title: z.string().min(1).max(220), scope: z.string().max(4000).optional(), validUntil: z.coerce.date().nullable().optional(), lines: z.array(LINE).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await customerAccountInScope(db, ctx.money, input.accountRef);
      await requireJob(ctx.money, input.jobId);
      const priced = await priceForAccount(a.id, input.lines);
      if (priced.unpriced.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot price: ${priced.unpriced.join("; ")} — give an explicit rate or add the line to the card` });
      const quoteRef = ref("QT");
      const ins = await db.insert(quotes).values({ quoteRef, customerAccountId: a.id, financialEntityId: a.financialEntityId, jobId: input.jobId ?? null, title: input.title, scope: input.scope ?? null, rateCardId: priced.rateCardId, subtotalCents: priced.subtotalCents, validUntil: input.validUntil ?? null, createdByUserId: ctx.user.id });
      const id = Number(ins[0]?.insertId ?? 0);
      for (let i = 0; i < priced.lines.length; i++) { const l = priced.lines[i]!; await db.insert(quoteLines).values({ quoteId: id, lineNo: i + 1, serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents, priceSource: l.priceSource, costCode: l.costCode }); }
      return { quoteRef, subtotalCents: priced.subtotalCents, lines: priced.lines.length, pricedFromCard: priced.lines.filter(l => l.priceSource === "rate_card").length };
    }),

  /** Issuing freezes the quote: a canonical snapshot and its hash are what the customer accepts. */
  quoteIssue: moneyScoped(roleProcedure("project.quoteIssue"))
    .input(z.object({ quoteRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const q = await quoteInScope(db, ctx.money, input.quoteRef);
      if (q.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Quote is ${q.status}` });
      const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, q.id));
      const snapshot = { quoteRef: q.quoteRef, version: q.version, title: q.title, scope: q.scope, subtotalCents: q.subtotalCents, validUntil: q.validUntil?.toISOString() ?? null, lines: lines.map(l => ({ lineNo: l.lineNo, serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents, priceSource: l.priceSource })) };
      const snapshotJson = canonicalJson(snapshot);
      const snapshotHash = sha(snapshotJson);
      await db.update(quotes).set({ status: "issued", snapshotJson, snapshotHash, issuedByUserId: ctx.user.id, issuedAt: new Date() }).where(and(eq(quotes.id, q.id), ownedEntityWhere(quotes.financialEntityId, ctx.money)));
      return { quoteRef: q.quoteRef, status: "issued" as const, snapshotHash };
    }),

  /** A revision is a new version that supersedes the issued one; the old quote and its hash stand. */
  quoteRevise: moneyScoped(roleProcedure("project.quoteRevise"))
    .input(z.object({ quoteRef: z.string().min(1).max(64), lines: z.array(LINE).min(1).max(100), validUntil: z.coerce.date().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const q = await quoteInScope(db, ctx.money, input.quoteRef);
      if (q.status === "accepted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An accepted quote is not revised — propose a change order" });
      const priced = await priceForAccount(q.customerAccountId, input.lines);
      if (priced.unpriced.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot price: ${priced.unpriced.join("; ")}` });
      const quoteRef = ref("QT");
      const ins = await db.insert(quotes).values({ quoteRef, customerAccountId: q.customerAccountId, financialEntityId: q.financialEntityId, jobId: q.jobId, version: q.version + 1, title: q.title, scope: q.scope, rateCardId: priced.rateCardId, subtotalCents: priced.subtotalCents, validUntil: input.validUntil ?? q.validUntil, supersedesQuoteId: q.id, createdByUserId: ctx.user.id });
      const id = Number(ins[0]?.insertId ?? 0);
      for (let i = 0; i < priced.lines.length; i++) { const l = priced.lines[i]!; await db.insert(quoteLines).values({ quoteId: id, lineNo: i + 1, serviceCode: l.serviceCode, description: l.description, quantity: l.quantity, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents, priceSource: l.priceSource, costCode: l.costCode }); }
      if (q.status === "issued" || q.status === "draft") await db.update(quotes).set({ status: "superseded" }).where(and(eq(quotes.id, q.id), ownedEntityWhere(quotes.financialEntityId, ctx.money)));
      return { quoteRef, version: q.version + 1, supersedes: q.quoteRef, subtotalCents: priced.subtotalCents };
    }),

  changeOrderPropose: moneyScoped(roleProcedure("project.changeOrderPropose"))
    .input(z.object({ accountRef: z.string().min(1).max(64), jobId: z.number().int().positive().nullable().optional(), fieldTicketId: z.number().int().positive().nullable().optional(), quoteRef: z.string().max(64).optional(), rfiRef: z.string().max(64).optional(), description: z.string().min(5).max(600), reason: z.string().min(5).max(600), estimatedCents: z.number().int().positive(), costCode: z.string().max(40).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await customerAccountInScope(db, ctx.money, input.accountRef);
      await requireJob(ctx.money, input.jobId);
      const q = input.quoteRef ? await quoteInScope(db, ctx.money, input.quoteRef) : undefined;
      const r = input.rfiRef ? await rfiInScope(db, ctx.money, input.rfiRef) : undefined;
      const changeOrderRef = ref("CO");
      const snapshotHash = sha(canonicalJson({ changeOrderRef, description: input.description, reason: input.reason, estimatedCents: input.estimatedCents, costCode: input.costCode ?? null }));
      await db.insert(changeOrders).values({ changeOrderRef, customerAccountId: a.id, jobId: input.jobId ?? null, fieldTicketId: input.fieldTicketId ?? null, quoteId: q?.id ?? null, rfiId: r?.id ?? null, description: input.description, reason: input.reason, estimatedCents: input.estimatedCents, costCode: input.costCode ?? null, snapshotHash, proposedByUserId: ctx.user.id, proposedAt: new Date() });
      return { changeOrderRef, snapshotHash, status: "proposed" as const };
    }),

  rfiAsk: moneyScoped(roleProcedure("project.rfiAsk"))
    .input(z.object({ accountRef: z.string().min(1).max(64), jobId: z.number().int().positive().nullable().optional(), question: z.string().min(10).max(1200) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await customerAccountInScope(db, ctx.money, input.accountRef);
      await requireJob(ctx.money, input.jobId);
      const rfiRef = ref("RFI");
      await db.insert(rfis).values({ rfiRef, customerAccountId: a.id, jobId: input.jobId ?? null, question: input.question, askedByUserId: ctx.user.id, askedAt: new Date() });
      return { rfiRef, status: "open" as const };
    }),

  budgetCreate: moneyScoped(roleProcedure("project.budgetCreate"))
    .input(z.object({ accountRef: z.string().min(1).max(64), jobId: z.number().int().positive(), quoteRef: z.string().max(64).optional(), lines: z.array(z.object({ costCode: z.string().min(1).max(40), description: z.string().min(1).max(220), budgetedCents: z.number().int().nonnegative() })).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await customerAccountInScope(db, ctx.money, input.accountRef);
      await requireJob(ctx.money, input.jobId);
      const q = input.quoteRef ? await quoteInScope(db, ctx.money, input.quoteRef) : undefined;
      const prior = (await db.select({ id: projectBudgets.id, version: projectBudgets.version, status: projectBudgets.status }).from(projectBudgets).where(and(eq(projectBudgets.jobId, input.jobId), ownedAccountWhere(db, projectBudgets.customerAccountId, ctx.money))).orderBy(desc(projectBudgets.version)).limit(1))[0];
      const budgetRef = ref("BUD");
      const total = input.lines.reduce((s, l) => s + l.budgetedCents, 0);
      const ins = await db.insert(projectBudgets).values({ budgetRef, customerAccountId: a.id, jobId: input.jobId, quoteId: q?.id ?? null, version: (prior?.version ?? 0) + 1, totalCents: total, supersedesBudgetId: prior?.id ?? null, createdByUserId: ctx.user.id });
      const id = Number(ins[0]?.insertId ?? 0);
      for (const l of input.lines) await db.insert(budgetLines).values({ budgetId: id, costCode: l.costCode, description: l.description, budgetedCents: l.budgetedCents });
      return { budgetRef, version: (prior?.version ?? 0) + 1, totalCents: total };
    }),

  /** Approved by someone other than its author. */
  budgetApprove: moneyScoped(roleProcedure("project.budgetApprove"))
    .input(z.object({ budgetRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const b = await projectBudgetInScope(db, ctx.money, input.budgetRef);
      if (b.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Budget is ${b.status}` });
      if (b.createdByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The author may not approve their own budget" });
      await db.update(projectBudgets).set({ status: "approved", approvedByUserId: ctx.user.id, approvedAt: new Date() }).where(eq(projectBudgets.id, b.id));
      if (b.supersedesBudgetId) await db.update(projectBudgets).set({ status: "superseded" }).where(and(eq(projectBudgets.id, b.supersedesBudgetId), ownedAccountWhere(db, projectBudgets.customerAccountId, ctx.money)));
      return { budgetRef: b.budgetRef, status: "approved" as const };
    }),

  /** How complete the work is — a person's statement, with their name and the time. */
  percentCompleteState: moneyScoped(roleProcedure("project.percentCompleteState"))
    .input(z.object({ budgetRef: z.string().min(1).max(64), percentComplete: z.number().int().min(0).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const b = await projectBudgetInScope(db, ctx.money, input.budgetRef);
      await db.update(projectBudgets).set({ percentComplete: input.percentComplete, percentCompleteStatedByUserId: ctx.user.id, percentCompleteStatedAt: new Date() }).where(eq(projectBudgets.id, b.id));
      return { budgetRef: input.budgetRef, percentComplete: input.percentComplete };
    }),

  /** Budget vs quoted + authorized changes vs billed vs collected, and a forecast at completion only when a person stated completion. */
  forecast: moneyScoped(roleProcedure("project.forecast")).input(z.object({ jobId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    // The job must be the caller's organization's (0132); a foreign job is not found. Every row below then also
    // carries the book predicate, so a row that names this job from another book cannot enter the sums.
    await requireJob(ctx.money, input.jobId);
    const b = (await db.select().from(projectBudgets).where(and(eq(projectBudgets.jobId, input.jobId), inArray(projectBudgets.status, ["approved", "draft"]), ownedAccountWhere(db, projectBudgets.customerAccountId, ctx.money))).orderBy(desc(projectBudgets.version)).limit(1))[0];
    const acceptedQuote = (await db.select().from(quotes).where(and(eq(quotes.jobId, input.jobId), eq(quotes.status, "accepted"), ownedEntityWhere(quotes.financialEntityId, ctx.money))).orderBy(desc(quotes.version)).limit(1))[0];
    const cos = await db.select().from(changeOrders).where(and(eq(changeOrders.jobId, input.jobId), eq(changeOrders.status, "authorized"), ownedAccountWhere(db, changeOrders.customerAccountId, ctx.money)));
    const inv = await db.select().from(invoices).where(and(eq(invoices.jobId, input.jobId), inArray(invoices.status, ["sent", "viewed", "approved", "partially_paid", "paid", "disputed"]), ownedEntityWhere(invoices.financialEntityId, ctx.money)));
    const allocs = inv.length ? await db.select().from(paymentAllocations).where(inArray(paymentAllocations.invoiceId, inv.map(i => i.id))) : [];
    const jobRow = (await db.select({ jobCode: jobs.jobCode }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1))[0];
    const f = projectForecast({ budgetCents: b?.totalCents ?? 0, quotedCents: acceptedQuote?.subtotalCents ?? null, authorizedChangesCents: cos.reduce((s, c) => s + c.estimatedCents, 0), billedCents: inv.reduce((s, i) => s + i.totalCents, 0), collectedCents: allocs.reduce((s, a) => s + a.amountCents, 0), percentComplete: b?.percentComplete ?? null });
    if (!b) f.reasons.unshift("No budget for this job — budget and variance are zero by absence, not by fact");
    return { jobId: input.jobId, jobCode: jobRow?.jobCode ?? null, budget: b ? { budgetRef: b.budgetRef, version: b.version, status: b.status } : null, acceptedQuote: acceptedQuote?.quoteRef ?? null, authorizedChangeOrders: cos.map(c => c.changeOrderRef), ...f, determination: !b ? "partial" as const : f.determination };
  }),
});
