/**
 * P7.1 — Commercial Office configuration and the organization master (0133).
 *
 * The owner's five decisions of 2026-09-17 are the seeded defaults. Every
 * procedure here reads configuration for the acting business (its own rows
 * win over the defaults) and never fills a gap with a guess: an amount no
 * tier covers is UNKNOWN, a role type that is not active cannot be assigned,
 * a sequence with no numbering policy mints no number.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { commercialApprovalPolicies, commercialCategoryTypes, commercialNumberingPolicies, commercialRoleTypes, commercialSettings, organizationCommercialRoles, organizations, userRoleAssignments } from "../drizzle/schema";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { approvalDecision, approvalRequirementFor, layerFor, numberingPolicyFor, type ApprovalPolicyRow } from "./_core/commercialPolicy";
import { nextTrackingNumber } from "./_core/trackingNumbers";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";

async function bookFor(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const scope = await resolveActingScope(db, userId);
  return { db, bookOrgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId };
}
const bookWhere = <T extends { bookOrgRef: any }>(t: T, bookOrgRef: string | null) => bookOrgRef ? or(isNull(t.bookOrgRef), eq(t.bookOrgRef, bookOrgRef)) : isNull(t.bookOrgRef);
const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const hash8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

export const commercialOfficeRouter = router({
  /** What an organization can be: the built-in roles plus this business's own. */
  roleTypes: router({
    list: roleProcedure("commercialOffice.roleTypesList").query(async ({ ctx }) => {
      const { db, bookOrgRef } = await bookFor(ctx.user.id);
      return db.select().from(commercialRoleTypes).where(bookWhere(commercialRoleTypes, bookOrgRef));
    }),
    create: roleProcedure("commercialOffice.roleTypeCreate")
      .input(z.object({ roleKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), label: z.string().min(1).max(120) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        await db.insert(commercialRoleTypes).values({ bookOrgRef, roleKey: input.roleKey, label: input.label, builtIn: false, source: `business_defined by user ${ctx.user.id}`, createdByUserId: ctx.user.id });
        return { roleKey: input.roleKey, bookOrgRef };
      }),
  }),

  /** One organization, any combination of roles, each with its own commercial number. */
  roles: router({
    assign: roleProcedure("commercialOffice.roleAssign")
      .input(z.object({ orgRef: z.string().min(1).max(64), roleKey: z.string().min(2).max(40), effectiveFrom: z.coerce.date().optional(), note: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const org = (await db.select({ orgRef: organizations.orgRef, status: organizations.status }).from(organizations).where(eq(organizations.orgRef, input.orgRef)).limit(1))[0];
        if (!org) throw new TRPCError({ code: "NOT_FOUND", message: `Organization ${input.orgRef} does not exist` });
        const types = await db.select().from(commercialRoleTypes).where(bookWhere(commercialRoleTypes, bookOrgRef));
        const type = layerFor(types.map(t => ({ ...t, category: t.roleKey })), bookOrgRef, input.roleKey).rows[0];
        if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: `BLOCKED — "${input.roleKey}" is not an active role type for this business` });
        const existing = (await db.select({ id: organizationCommercialRoles.id }).from(organizationCommercialRoles)
          .where(and(eq(organizationCommercialRoles.orgRef, input.orgRef), eq(organizationCommercialRoles.roleKey, input.roleKey), eq(organizationCommercialRoles.status, "active"),
            bookOrgRef ? eq(organizationCommercialRoles.bookOrgRef, bookOrgRef) : isNull(organizationCommercialRoles.bookOrgRef))).limit(1))[0];
        if (existing) throw new TRPCError({ code: "CONFLICT", message: `${input.orgRef} already holds the ${input.roleKey} role` });
        // A number only where a numbering policy exists for the role's sequence; the business's own format wins.
        const sequenceType = input.roleKey === "client" ? "CLI" : input.roleKey === "vendor" ? "VEN" : input.roleKey.toUpperCase().slice(0, 12);
        const policies = await db.select().from(commercialNumberingPolicies).where(bookWhere(commercialNumberingPolicies, bookOrgRef));
        const policy = numberingPolicyFor(policies, bookOrgRef, sequenceType);
        let commercialNumber: string | null = null;
        if (policy) {
          const alloc = await nextTrackingNumber(db, {
            sequenceType: policy.bookOrgRef ? `${sequenceType}@${hash8(policy.bookOrgRef)}` : sequenceType,
            format: { prefix: policy.prefix, separator: policy.separator, yearDigits: policy.yearDigits as 0 | 2 | 4, includeMonth: policy.includeMonth, sequenceDigits: policy.sequenceDigits, resetPeriod: policy.resetPeriod },
          });
          commercialNumber = alloc.trackingNumber;
        }
        const roleRef = ref("CROLE");
        await db.insert(organizationCommercialRoles).values({ roleRef, bookOrgRef, orgRef: input.orgRef, roleKey: input.roleKey, commercialNumber, status: "active", effectiveFrom: (input.effectiveFrom ?? new Date()).toISOString().slice(0, 10), note: input.note ?? null, assignedByUserId: ctx.user.id });
        return { roleRef, commercialNumber, numbered: commercialNumber !== null, reason: commercialNumber ? undefined : `no numbering policy for sequence ${sequenceType}; assign one to mint numbers` };
      }),
    end: roleProcedure("commercialOffice.roleEnd")
      .input(z.object({ roleRef: z.string().min(1), note: z.string().min(5).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const row = (await db.select().from(organizationCommercialRoles).where(eq(organizationCommercialRoles.roleRef, input.roleRef)).limit(1))[0];
        if (!row || (bookOrgRef ? row.bookOrgRef !== bookOrgRef : row.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Role assignment not found in this business's book" });
        if (row.status === "ended") throw new TRPCError({ code: "CONFLICT", message: "Already ended" });
        await db.update(organizationCommercialRoles).set({ status: "ended", effectiveTo: new Date().toISOString().slice(0, 10), endedByUserId: ctx.user.id, endedAt: new Date(), note: `${row.note ?? ""}\n[ended] ${input.note}`.trim() }).where(eq(organizationCommercialRoles.id, row.id));
        return { roleRef: input.roleRef, status: "ended" as const };
      }),
    list: roleProcedure("commercialOffice.rolesList")
      .input(z.object({ orgRef: z.string().max(64).optional(), roleKey: z.string().max(40).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const conds = [bookOrgRef ? eq(organizationCommercialRoles.bookOrgRef, bookOrgRef) : isNull(organizationCommercialRoles.bookOrgRef)];
        if (input?.orgRef) conds.push(eq(organizationCommercialRoles.orgRef, input.orgRef));
        if (input?.roleKey) conds.push(eq(organizationCommercialRoles.roleKey, input.roleKey));
        return db.select().from(organizationCommercialRoles).where(and(...conds)).limit(500);
      }),
  }),

  /** Accounting target and other settings: this business's own, else the default. */
  settings: router({
    get: roleProcedure("commercialOffice.settingsGet").query(async ({ ctx }) => {
      const { db, bookOrgRef } = await bookFor(ctx.user.id);
      const rows = await db.select().from(commercialSettings).where(bookWhere(commercialSettings, bookOrgRef));
      const own = bookOrgRef ? rows.find(r => r.bookOrgRef === bookOrgRef) : undefined;
      const row = own ?? rows.find(r => r.bookOrgRef === null) ?? null;
      return row ? { ...row, layer: own ? ("business" as const) : ("default" as const) } : null;
    }),
    set: roleProcedure("commercialOffice.settingsSet")
      .input(z.object({ accountingTarget: z.enum(["none", "quickbooks_online", "sage", "xero", "custom"]), accountingTargetLabel: z.string().max(120).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        if (input.accountingTarget === "custom" && !input.accountingTargetLabel) throw new TRPCError({ code: "BAD_REQUEST", message: "A custom accounting target needs a label" });
        const values = { bookOrgRef, accountingTarget: input.accountingTarget, accountingTargetLabel: input.accountingTargetLabel ?? null, source: `business_defined by user ${ctx.user.id}`, updatedByUserId: ctx.user.id };
        const existing = (await db.select({ id: commercialSettings.id }).from(commercialSettings).where(bookOrgRef ? eq(commercialSettings.bookOrgRef, bookOrgRef) : isNull(commercialSettings.bookOrgRef)).limit(1))[0];
        if (existing) await db.update(commercialSettings).set(values).where(eq(commercialSettings.id, existing.id)); else await db.insert(commercialSettings).values(values);
        return { bookOrgRef, ...input };
      }),
  }),

  /** Numbering: the format per sequence, per business. */
  numbering: router({
    list: roleProcedure("commercialOffice.numberingList").query(async ({ ctx }) => {
      const { db, bookOrgRef } = await bookFor(ctx.user.id);
      return db.select().from(commercialNumberingPolicies).where(bookWhere(commercialNumberingPolicies, bookOrgRef));
    }),
    set: roleProcedure("commercialOffice.numberingSet")
      .input(z.object({ sequenceType: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/), prefix: z.string().min(1).max(12), separator: z.string().max(3).default("-"), yearDigits: z.union([z.literal(0), z.literal(2), z.literal(4)]).default(4), includeMonth: z.boolean().default(false), sequenceDigits: z.number().int().min(3).max(9).default(6), resetPeriod: z.enum(["never", "yearly", "monthly"]).default("yearly") }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const values = { ...input, bookOrgRef, source: `business_defined by user ${ctx.user.id}`, updatedByUserId: ctx.user.id };
        const existing = (await db.select({ id: commercialNumberingPolicies.id }).from(commercialNumberingPolicies)
          .where(and(eq(commercialNumberingPolicies.sequenceType, input.sequenceType), bookOrgRef ? eq(commercialNumberingPolicies.bookOrgRef, bookOrgRef) : isNull(commercialNumberingPolicies.bookOrgRef))).limit(1))[0];
        if (existing) await db.update(commercialNumberingPolicies).set(values).where(eq(commercialNumberingPolicies.id, existing.id)); else await db.insert(commercialNumberingPolicies).values(values);
        return { sequenceType: input.sequenceType, bookOrgRef };
      }),
  }),

  /** Approvals: tiers per category; an amount no tier covers is UNKNOWN. */
  approvals: router({
    policies: roleProcedure("commercialOffice.approvalPoliciesList").query(async ({ ctx }) => {
      const { db, bookOrgRef } = await bookFor(ctx.user.id);
      return db.select().from(commercialApprovalPolicies).where(bookWhere(commercialApprovalPolicies, bookOrgRef));
    }),
    policySet: roleProcedure("commercialOffice.approvalPolicySet")
      .input(z.object({ category: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), maxAmountCents: z.number().int().nonnegative().nullable(), approverRole: z.string().min(2).max(40), secondPersonRequired: z.boolean().default(false), separationOfDuties: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        await db.insert(commercialApprovalPolicies).values({ ...input, bookOrgRef, status: "active", source: `business_defined by user ${ctx.user.id}`, effectiveFrom: new Date().toISOString().slice(0, 10), createdByUserId: ctx.user.id });
        return { category: input.category, bookOrgRef };
      }),
    policyRetire: roleProcedure("commercialOffice.approvalPolicyRetire")
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const row = (await db.select().from(commercialApprovalPolicies).where(eq(commercialApprovalPolicies.id, input.id)).limit(1))[0];
        if (!row || row.bookOrgRef !== bookOrgRef) throw new TRPCError({ code: "NOT_FOUND", message: "Policy not found in this business's book (defaults cannot be retired from a business's book)" });
        await db.update(commercialApprovalPolicies).set({ status: "retired" }).where(eq(commercialApprovalPolicies.id, input.id));
        return { id: input.id, status: "retired" as const };
      }),
    /** What this amount requires, and whether the asking person could approve it. */
    requirement: roleProcedure("commercialOffice.approvalRequirement")
      .input(z.object({ category: z.string().min(2).max(40), amountCents: z.number().int(), preparedByUserId: z.number().int().nullable().default(null) }))
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const rows = (await db.select().from(commercialApprovalPolicies).where(bookWhere(commercialApprovalPolicies, bookOrgRef))) as ApprovalPolicyRow[];
        const requirement = approvalRequirementFor(rows.map(r => ({ ...r, maxAmountCents: r.maxAmountCents === null ? null : Number(r.maxAmountCents) })), { bookOrgRef, category: input.category, amountCents: input.amountCents });
        const roles = (await db.select({ role: userRoleAssignments.role }).from(userRoleAssignments).where(eq(userRoleAssignments.userId, ctx.user.id))).map(r => r.role as string);
        return { requirement, couldApprove: approvalDecision(requirement, { userId: ctx.user.id, roles }, input.preparedByUserId) };
      }),
  }),

  /** Classification: document types, load categories, profitability dimensions. */
  categories: router({
    list: roleProcedure("commercialOffice.categoriesList")
      .input(z.object({ kind: z.enum(["document_type", "load_category", "profitability_dimension"]).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const conds = [bookWhere(commercialCategoryTypes, bookOrgRef)];
        if (input?.kind) conds.push(eq(commercialCategoryTypes.kind, input.kind));
        return db.select().from(commercialCategoryTypes).where(and(...conds));
      }),
    create: roleProcedure("commercialOffice.categoryCreate")
      .input(z.object({ kind: z.enum(["document_type", "load_category", "profitability_dimension"]), categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), label: z.string().min(1).max(120) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        await db.insert(commercialCategoryTypes).values({ ...input, bookOrgRef, builtIn: false, source: `business_defined by user ${ctx.user.id}`, createdByUserId: ctx.user.id });
        return { ...input, bookOrgRef };
      }),
  }),
});
