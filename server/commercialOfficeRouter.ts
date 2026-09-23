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
import { and, eq, gte, inArray, isNull, lte, notInArray, or, sql, like, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { storageKeyInput } from "./_core/storageKey";
import { commercialApprovalPolicies, commercialCategoryTypes, commercialNumberingPolicies, commercialRoleTypes, commercialSettings, facilities, jobs, organizationCommercialRoles, organizationRecordLinks, organizations, userRoleAssignments, vendors, disposalTickets, facilityStatements, facilityStatementLines, units, customerAccounts, customerCredits, customerPayments, invoices, paymentAllocations, commercialApprovals, commercialApprovalSignatures, vendorBills, commercialGlAccounts, commercialGlMappings, invoiceLines, contractorPayables, commercialJobChains, commercialDocuments, commercialDocumentLinks, commercialDocumentDeliveries, evidenceRecords, fieldTicketDocuments, retentionPolicies, documentDefinitions } from "../drizzle/schema";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { approvalDecision, approvalRequirementFor, layerFor, numberingPolicyFor, type ApprovalPolicyRow } from "./_core/commercialPolicy";
import { nextTrackingNumber } from "./_core/trackingNumbers";
import { matchFacilityStatementLine, type DisposalTicketLite } from "./_core/facilityStatements";
import { aging, type ArInvoice } from "./_core/accountsReceivable";
import { derivability, empty, finish, type Dimension, type Figures } from "./_core/profitability";
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
/** MariaDB returns JSON columns as text; read them as the arrays they are. */
const jsonArray = <T,>(v: unknown): T[] => (typeof v === "string" ? (JSON.parse(v) as T[]) : Array.isArray(v) ? (v as T[]) : []);

export const commercialOfficeRouter = router({
  /** What an organization can be: the built-in roles plus this business's own. */
  /**
   * The organization master itself. Until now an organization row came only from the tenancy
   * layer (or a fixture); the office needs to create a client or vendor and then give it roles.
   * Creating is a person's act with a name; roles and numbers follow through roles.assign.
   */
  organizations: router({
    create: roleProcedure("commercialOffice.organizationCreate")
      .input(z.object({ name: z.string().min(2).max(200) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const sameName = await db.select({ orgRef: organizations.orgRef, name: organizations.name }).from(organizations).where(eq(organizations.name, input.name.trim())).limit(3);
        if (sameName.length) throw new TRPCError({ code: "CONFLICT", message: `An organization named "${input.name.trim()}" already exists (${sameName.map(s => s.orgRef).join(", ")}); assign it a role instead of creating another` });
        const orgRef = (await nextTrackingNumber(db, { sequenceType: "ORG" })).trackingNumber;
        await db.insert(organizations).values({ orgRef, name: input.name.trim(), status: "active" });
        return { orgRef, name: input.name.trim(), bookOrgRef, note: "Give it a role with roles.assign; the commercial number is minted then." };
      }),
    list: roleProcedure("commercialOffice.organizationsList")
      .input(z.object({ roleKey: z.string().max(40).optional(), q: z.string().max(120).optional(), status: z.enum(["active", "suspended", "closed"]).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const roles = await db.select().from(organizationCommercialRoles).where(and(bookWhere(organizationCommercialRoles, bookOrgRef), eq(organizationCommercialRoles.status, "active")));
        const byOrg = new Map<string, typeof roles>();
        for (const r of roles) byOrg.set(r.orgRef, [...(byOrg.get(r.orgRef) ?? []), r]);
        const conds = [];
        if (input?.status) conds.push(eq(organizations.status, input.status));
        if (input?.q) conds.push(like(organizations.name, `%${input.q}%`));
        const orgs = await db.select().from(organizations).where(conds.length ? and(...conds) : undefined).limit(500);
        return orgs
          .map(o => ({ orgRef: o.orgRef, name: o.name, status: o.status, roles: (byOrg.get(o.orgRef) ?? []).map(r => ({ roleKey: r.roleKey, commercialNumber: r.commercialNumber, since: r.effectiveFrom })) }))
          .filter(o => !input?.roleKey || o.roles.some(r => r.roleKey === input.roleKey))
          .sort((a, b) => a.name.localeCompare(b.name));
      }),
  }),

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

  /**
   * P7.2 — linking the office's existing records to organizations is a person's act.
   * A vendor row, a facility row, or the client named on a job gets an organization
   * reference only when someone links it, and only to an organization that holds the
   * matching role in this book. Candidates are proposed by exact name and never applied.
   */
  links: router({
    set: roleProcedure("commercialOffice.linkSet")
      .input(z.object({ recordType: z.enum(["vendor", "facility", "job_customer", "customer_account"]), recordId: z.number().int().positive(), orgRef: z.string().min(1).max(64), note: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const roleKeyRequired = input.recordType === "vendor" ? "vendor" : input.recordType === "facility" ? "disposal_facility" : "client";
        const role = (await db.select({ id: organizationCommercialRoles.id }).from(organizationCommercialRoles)
          .where(and(eq(organizationCommercialRoles.orgRef, input.orgRef), eq(organizationCommercialRoles.roleKey, roleKeyRequired), eq(organizationCommercialRoles.status, "active"),
            bookOrgRef ? eq(organizationCommercialRoles.bookOrgRef, bookOrgRef) : isNull(organizationCommercialRoles.bookOrgRef))).limit(1))[0];
        if (!role) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — ${input.orgRef} does not hold the ${roleKeyRequired} role in this book; assign it first` });
        const table = input.recordType === "vendor" ? vendors : input.recordType === "facility" ? facilities : input.recordType === "customer_account" ? customerAccounts : jobs;
        const record = (await db.select({ id: table.id }).from(table).where(eq(table.id, input.recordId)).limit(1))[0];
        if (!record) throw new TRPCError({ code: "NOT_FOUND", message: `${input.recordType} ${input.recordId} does not exist` });
        const open = (await db.select({ linkRef: organizationRecordLinks.linkRef, orgRef: organizationRecordLinks.orgRef }).from(organizationRecordLinks)
          .where(and(eq(organizationRecordLinks.recordType, input.recordType), eq(organizationRecordLinks.recordId, input.recordId), eq(organizationRecordLinks.status, "active"))).limit(1))[0];
        if (open) throw new TRPCError({ code: "CONFLICT", message: `${input.recordType} ${input.recordId} is already linked to ${open.orgRef} (${open.linkRef}); end that link first` });
        const linkRef = ref("OLINK");
        await db.transaction(async tx => {
          await tx.insert(organizationRecordLinks).values({ linkRef, bookOrgRef, orgRef: input.orgRef, recordType: input.recordType, recordId: input.recordId, roleKeyRequired, note: input.note ?? null, linkedByUserId: ctx.user.id });
          if (input.recordType === "vendor") await tx.update(vendors).set({ orgRef: input.orgRef }).where(eq(vendors.id, input.recordId));
          else if (input.recordType === "facility") await tx.update(facilities).set({ orgRef: input.orgRef }).where(eq(facilities.id, input.recordId));
          else if (input.recordType === "customer_account") await tx.update(customerAccounts).set({ orgRef: input.orgRef }).where(eq(customerAccounts.id, input.recordId));
          else await tx.update(jobs).set({ customerOrgRef: input.orgRef }).where(eq(jobs.id, input.recordId));
        });
        return { linkRef, recordType: input.recordType, recordId: input.recordId, orgRef: input.orgRef };
      }),
    end: roleProcedure("commercialOffice.linkEnd")
      .input(z.object({ linkRef: z.string().min(1), reason: z.string().min(5).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const link = (await db.select().from(organizationRecordLinks).where(eq(organizationRecordLinks.linkRef, input.linkRef)).limit(1))[0];
        if (!link || (bookOrgRef ? link.bookOrgRef !== bookOrgRef : link.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Link not found in this business's book" });
        if (link.status === "ended") throw new TRPCError({ code: "CONFLICT", message: "Already ended" });
        await db.transaction(async tx => {
          await tx.update(organizationRecordLinks).set({ status: "ended", endedByUserId: ctx.user.id, endedAt: new Date(), endReason: input.reason }).where(eq(organizationRecordLinks.id, link.id));
          // The reference is cleared; the legacy text on the record stays as it was captured.
          if (link.recordType === "vendor") await tx.update(vendors).set({ orgRef: null }).where(eq(vendors.id, link.recordId));
          else if (link.recordType === "facility") await tx.update(facilities).set({ orgRef: null }).where(eq(facilities.id, link.recordId));
          else if (link.recordType === "customer_account") await tx.update(customerAccounts).set({ orgRef: null }).where(eq(customerAccounts.id, link.recordId));
          else await tx.update(jobs).set({ customerOrgRef: null }).where(eq(jobs.id, link.recordId));
        });
        return { linkRef: input.linkRef, status: "ended" as const };
      }),
    list: roleProcedure("commercialOffice.linksList")
      .input(z.object({ orgRef: z.string().max(64).optional(), recordType: z.enum(["vendor", "facility", "job_customer", "customer_account"]).optional(), includeEnded: z.boolean().default(false) }).optional())
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const conds = [bookOrgRef ? eq(organizationRecordLinks.bookOrgRef, bookOrgRef) : isNull(organizationRecordLinks.bookOrgRef)];
        if (input?.orgRef) conds.push(eq(organizationRecordLinks.orgRef, input.orgRef));
        if (input?.recordType) conds.push(eq(organizationRecordLinks.recordType, input.recordType));
        if (!input?.includeEnded) conds.push(eq(organizationRecordLinks.status, "active"));
        return db.select().from(organizationRecordLinks).where(and(...conds)).limit(500);
      }),
    /**
     * PROPOSE → SHOW EVIDENCE → HUMAN CONFIRMATION → COMMIT. Unlinked records whose captured
     * name exactly equals (case-insensitively) the name of an organization holding the matching
     * role in this book. Each is a candidate with its evidence; none is applied here.
     */
    candidates: roleProcedure("commercialOffice.linkCandidates")
      .input(z.object({ recordType: z.enum(["vendor", "facility", "job_customer"]) }))
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const roleKeyRequired = input.recordType === "vendor" ? "vendor" : input.recordType === "facility" ? "disposal_facility" : "client";
        const holders = await db.select({ orgRef: organizations.orgRef, name: organizations.name }).from(organizations)
          .innerJoin(organizationCommercialRoles, and(eq(organizationCommercialRoles.orgRef, organizations.orgRef), eq(organizationCommercialRoles.roleKey, roleKeyRequired), eq(organizationCommercialRoles.status, "active"),
            bookOrgRef ? eq(organizationCommercialRoles.bookOrgRef, bookOrgRef) : isNull(organizationCommercialRoles.bookOrgRef)));
        const byName = new Map<string, { orgRef: string; name: string }[]>();
        for (const h of holders) { const k = h.name.trim().toLowerCase(); byName.set(k, [...(byName.get(k) ?? []), h]); }
        const unlinked: { recordId: number; capturedName: string }[] = input.recordType === "vendor"
          ? (await db.select({ recordId: vendors.id, capturedName: vendors.name }).from(vendors).where(isNull(vendors.orgRef)).limit(500))
          : input.recordType === "facility"
            ? (await db.select({ recordId: facilities.id, capturedName: facilities.name }).from(facilities).where(isNull(facilities.orgRef)).limit(500))
            : (await db.select({ recordId: jobs.id, capturedName: jobs.customer }).from(jobs).where(and(isNull(jobs.customerOrgRef), sql`${jobs.customer} <> ''`)).limit(500));
        const candidates = unlinked.flatMap(r => (byName.get(r.capturedName.trim().toLowerCase()) ?? []).map(h => ({
          recordType: input.recordType, recordId: r.recordId, capturedName: r.capturedName, orgRef: h.orgRef, organizationName: h.name,
          evidence: "exact_name_match" as const, confidence: "candidate" as const, applied: false as const,
        })));
        return { unlinked: unlinked.length, candidates, note: "Candidates are proposed by exact name only and are never applied here; a person links each one with links.set." };
      }),
  }),

  /**
   * P7.3 — disposal reconciliation. The facility's statement is evidence; each line is
   * matched to a disposal ticket, outcomes are match / match_with_variance / unmatched /
   * ambiguous, and a person resolves the rest. Nothing here edits a disposal ticket.
   */
  disposal: router({
    statementImport: roleProcedure("commercialOffice.facilityStatementImport")
      .input(z.object({
        facilityId: z.number().int().positive(), facilityStatementNumber: z.string().max(80).optional(),
        periodStart: z.coerce.date(), periodEnd: z.coerce.date(), quantityTolerance: z.number().min(0).max(0.5).optional(),
        lines: z.array(z.object({ facilityTicketNumber: z.string().max(80).nullable().default(null), receivedAt: z.coerce.date(), material: z.string().max(120).nullable().default(null), quantity: z.number().nonnegative(), quantityUnit: z.string().min(1).max(16), amountCents: z.number().int().nullable().default(null), unitHint: z.string().max(40).nullable().default(null), manifestHint: z.string().max(60).nullable().default(null) })).min(1).max(2000),
      }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        if (input.periodEnd < input.periodStart) throw new TRPCError({ code: "BAD_REQUEST", message: "periodEnd is before periodStart" });
        const facility = (await db.select({ id: facilities.id, orgRef: facilities.orgRef }).from(facilities).where(eq(facilities.id, input.facilityId)).limit(1))[0];
        if (!facility) throw new TRPCError({ code: "NOT_FOUND", message: `Facility ${input.facilityId} does not exist` });
        const contentHash = createHash("sha256").update(JSON.stringify(input.lines.map(l => [l.facilityTicketNumber, l.receivedAt.toISOString(), l.material, l.quantity, l.quantityUnit, l.amountCents, l.unitHint, l.manifestHint]))).digest("hex");
        const dup = (await db.select({ statementRef: facilityStatements.statementRef }).from(facilityStatements).where(and(eq(facilityStatements.facilityId, input.facilityId), eq(facilityStatements.contentHash, contentHash))).limit(1))[0];
        if (dup) throw new TRPCError({ code: "CONFLICT", message: `This statement was already imported as ${dup.statementRef}` });
        // Tickets at this facility around the period (a day either side), with the unit number for the hint comparison.
        const lo = new Date(input.periodStart.getTime() - 86_400_000), hi = new Date(input.periodEnd.getTime() + 2 * 86_400_000);
        const rows = await db.select({ id: disposalTickets.id, facilityTicketNumber: disposalTickets.facilityTicketNumber, scaleInAt: disposalTickets.scaleInAt, material: sql<string | null>`NULL`, quantity: disposalTickets.quantity, quantityUnit: disposalTickets.quantityUnit, unitNumber: units.unitNumber })
          .from(disposalTickets).leftJoin(units, eq(units.id, disposalTickets.unitId))
          .where(and(eq(disposalTickets.facilityId, input.facilityId), or(isNull(disposalTickets.scaleInAt), and(gte(disposalTickets.scaleInAt, lo), lte(disposalTickets.scaleInAt, hi)))));
        const tickets: DisposalTicketLite[] = rows.map(r => ({ ...r, quantity: r.quantity === null ? null : Number(r.quantity) }));
        const statementRef = ref("FSTMT");
        const counts = { match: 0, match_with_variance: 0, unmatched: 0, ambiguous: 0 };
        const lineValues = input.lines.map((l, i) => {
          const m = matchFacilityStatementLine({ tickets, line: l, quantityTolerance: input.quantityTolerance });
          counts[m.outcome]++;
          return { lineNo: i + 1, facilityTicketNumber: l.facilityTicketNumber, receivedAt: l.receivedAt, material: l.material, quantity: l.quantity, quantityUnit: l.quantityUnit, amountCents: l.amountCents, unitHint: l.unitHint, manifestHint: l.manifestHint,
            matchedDisposalTicketId: "ticketId" in m ? m.ticketId : null, matchOutcome: m.outcome, matchReason: m.reason, variances: "variances" in m && m.variances.length ? m.variances : null, candidateTicketIds: m.outcome === "ambiguous" ? m.candidateTicketIds : null };
        });
        await db.transaction(async tx => {
          const ins = await tx.insert(facilityStatements).values({ statementRef, bookOrgRef, facilityId: input.facilityId, facilityOrgRef: facility.orgRef ?? null, facilityStatementNumber: input.facilityStatementNumber ?? null, periodStart: input.periodStart.toISOString().slice(0, 10), periodEnd: input.periodEnd.toISOString().slice(0, 10), lineCount: lineValues.length, matchedCount: counts.match, varianceCount: counts.match_with_variance, unmatchedCount: counts.unmatched, ambiguousCount: counts.ambiguous, contentHash, importedByUserId: ctx.user.id });
          const facilityStatementId = ins[0].insertId;
          await tx.insert(facilityStatementLines).values(lineValues.map(v => ({ ...v, facilityStatementId })));
        });
        return { statementRef, ...counts, lineCount: lineValues.length, facilityLinked: facility.orgRef !== null, note: counts.unmatched + counts.ambiguous + counts.match_with_variance ? "Lines other than clean matches wait for a person's resolution." : "Every line matched cleanly." };
      }),
    statements: roleProcedure("commercialOffice.facilityStatementsList")
      .input(z.object({ status: z.enum(["open", "closed"]).optional(), facilityOrgRef: z.string().max(64).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const conds = [bookWhere(facilityStatements, bookOrgRef)];
        if (input?.status) conds.push(eq(facilityStatements.status, input.status));
        if (input?.facilityOrgRef) conds.push(eq(facilityStatements.facilityOrgRef, input.facilityOrgRef));
        const rows = await db.select().from(facilityStatements).where(and(...conds)).orderBy(desc(facilityStatements.importedAt)).limit(200);
        return rows.map(st => ({ ...st, openLines: st.status === "open" ? st.varianceCount + st.unmatchedCount + st.ambiguousCount : 0 }));
      }),
    statementLines: roleProcedure("commercialOffice.facilityStatementLines")
      .input(z.object({ statementRef: z.string().min(1), outcome: z.enum(["match", "match_with_variance", "unmatched", "ambiguous"]).optional(), unresolvedOnly: z.boolean().default(false) }))
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const st = (await db.select().from(facilityStatements).where(eq(facilityStatements.statementRef, input.statementRef)).limit(1))[0];
        if (!st || (bookOrgRef ? st.bookOrgRef !== bookOrgRef : st.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Statement not found in this business's book" });
        const conds = [eq(facilityStatementLines.facilityStatementId, st.id)];
        if (input.outcome) conds.push(eq(facilityStatementLines.matchOutcome, input.outcome));
        if (input.unresolvedOnly) conds.push(isNull(facilityStatementLines.resolution));
        const lines = await db.select().from(facilityStatementLines).where(and(...conds)).orderBy(facilityStatementLines.lineNo);
        return { statement: st, lines: lines.map(l => ({ ...l, variances: l.variances === null ? null : jsonArray<string>(l.variances), candidateTicketIds: l.candidateTicketIds === null ? null : jsonArray<number>(l.candidateTicketIds) })) };
      }),
    lineResolve: roleProcedure("commercialOffice.facilityStatementLineResolve")
      .input(z.object({ statementRef: z.string().min(1), lineNo: z.number().int().positive(), resolution: z.enum(["accepted", "ticket_needs_correction", "facility_error", "disputed"]), note: z.string().min(10).max(500), chosenDisposalTicketId: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const st = (await db.select().from(facilityStatements).where(eq(facilityStatements.statementRef, input.statementRef)).limit(1))[0];
        if (!st || (bookOrgRef ? st.bookOrgRef !== bookOrgRef : st.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Statement not found in this business's book" });
        if (st.status === "closed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Statement is closed" });
        const line = (await db.select().from(facilityStatementLines).where(and(eq(facilityStatementLines.facilityStatementId, st.id), eq(facilityStatementLines.lineNo, input.lineNo))).limit(1))[0];
        if (!line) throw new TRPCError({ code: "NOT_FOUND", message: `Line ${input.lineNo} not on ${input.statementRef}` });
        if (line.resolution) throw new TRPCError({ code: "CONFLICT", message: `Line ${input.lineNo} was already resolved as ${line.resolution}` });
        let matched = line.matchedDisposalTicketId;
        if (line.matchOutcome === "ambiguous") {
          if (input.resolution === "accepted") {
            const candidates = jsonArray<number>(line.candidateTicketIds);
            if (!input.chosenDisposalTicketId || !candidates.includes(input.chosenDisposalTicketId)) throw new TRPCError({ code: "BAD_REQUEST", message: `BLOCKED — an ambiguous line is accepted only by choosing one of its candidates: ${candidates.join(", ")}` });
            matched = input.chosenDisposalTicketId;
          }
        } else if (input.chosenDisposalTicketId && input.chosenDisposalTicketId !== matched) throw new TRPCError({ code: "BAD_REQUEST", message: "Only an ambiguous line takes a chosen ticket" });
        await db.update(facilityStatementLines).set({ resolution: input.resolution, resolutionNote: input.note, resolvedByUserId: ctx.user.id, resolvedAt: new Date(), matchedDisposalTicketId: matched }).where(eq(facilityStatementLines.id, line.id));
        return { statementRef: input.statementRef, lineNo: input.lineNo, resolution: input.resolution, matchedDisposalTicketId: matched, ticketChanged: false as const, note: input.resolution === "ticket_needs_correction" ? "Recorded. The ticket itself is corrected through the disposal correction path with this statement as evidence; nothing was changed here." : undefined };
      }),
    statementClose: roleProcedure("commercialOffice.facilityStatementClose")
      .input(z.object({ statementRef: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const st = (await db.select().from(facilityStatements).where(eq(facilityStatements.statementRef, input.statementRef)).limit(1))[0];
        if (!st || (bookOrgRef ? st.bookOrgRef !== bookOrgRef : st.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Statement not found in this business's book" });
        const open = await db.select({ lineNo: facilityStatementLines.lineNo, outcome: facilityStatementLines.matchOutcome }).from(facilityStatementLines)
          .where(and(eq(facilityStatementLines.facilityStatementId, st.id), isNull(facilityStatementLines.resolution), inArray(facilityStatementLines.matchOutcome, ["match_with_variance", "unmatched", "ambiguous"])));
        if (open.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — ${open.length} line(s) still need a person's resolution: ${open.map(o => `#${o.lineNo} (${o.outcome})`).join(", ")}` });
        await db.update(facilityStatements).set({ status: "closed", closedByUserId: ctx.user.id, closedAt: new Date() }).where(eq(facilityStatements.id, st.id));
        return { statementRef: input.statementRef, status: "closed" as const };
      }),
  }),

  /**
   * P7.4 — receivables by organization. Balances are derived from the same invoice,
   * allocation and credit rows the existing ar.aging uses (one source of truth); the
   * organization is the one a person linked the customer account to. Accounts nobody
   * has linked are reported as `unlinked`, by their captured name — never guessed.
   */
  ar: router({
    agingByOrganization: roleProcedure("commercialOffice.arAgingByOrganization")
      .input(z.object({ financialEntityId: z.number().int().positive(), asOf: z.coerce.date().optional() }))
      .query(async ({ ctx, input }) => {
        const { db } = await bookFor(ctx.user.id);
        const inv = await db.select({ i: invoices, accountOrgRef: customerAccounts.orgRef, accountRef: customerAccounts.accountRef }).from(invoices).leftJoin(customerAccounts, eq(customerAccounts.id, invoices.customerAccountId)).where(eq(invoices.financialEntityId, input.financialEntityId));
        const ids = inv.map(r => r.i.id);
        const [allocs, creds] = await Promise.all([
          ids.length ? db.select().from(paymentAllocations).where(inArray(paymentAllocations.invoiceId, ids)) : [],
          db.select().from(customerCredits).where(eq(customerCredits.financialEntityId, input.financialEntityId)),
        ]);
        const asOf = input.asOf ?? new Date();
        const groups = new Map<string, { orgRef: string | null; label: string; invoices: ArInvoice[] }>();
        for (const r of inv) {
          const key = r.accountOrgRef ?? `unlinked:${r.i.customer}`;
          const g = groups.get(key) ?? { orgRef: r.accountOrgRef ?? null, label: r.accountOrgRef ?? r.i.customer, invoices: [] };
          g.invoices.push({ id: r.i.id, invoiceNumber: r.i.invoiceNumber, customer: r.i.customer, totalCents: r.i.totalCents, dueAt: r.i.dueAt, issuedAt: r.i.issuedAt ?? r.i.createdAt, status: r.i.status, disputed: r.i.status === "disputed" || r.i.disputedAt != null });
          groups.set(key, g);
        }
        const out = Array.from(groups.values()).map(g => {
          const a = aging({ invoices: g.invoices, allocations: allocs.map(x => ({ invoiceId: x.invoiceId, amountCents: x.amountCents })), credits: creds.map(c => ({ invoiceId: c.invoiceId, customer: c.customer, amountCents: c.amountCents, status: c.status as "requested" | "approved" | "refused" })), payments: [], paymentAllocatedCents: new Map(), asOf });
          return { orgRef: g.orgRef, label: g.label, linked: g.orgRef !== null, invoiceCount: g.invoices.length, buckets: a.buckets, totalOutstandingCents: a.totalOutstandingCents };
        }).sort((x, y) => y.totalOutstandingCents - x.totalOutstandingCents);
        return { asOf, organizations: out.filter(o => o.linked), unlinked: out.filter(o => !o.linked), note: out.some(o => !o.linked) ? "Unlinked customer accounts are shown by their captured name; link them to an organization with commercialOffice.links.set (recordType customer_account)." : undefined };
      }),
    /** The approval ledger for a subject: the requirement at the time and every signature. */
    approvalLedger: roleProcedure("commercialOffice.approvalLedger")
      .input(z.object({ subjectType: z.string().min(1).max(40), subjectRef: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        const { db } = await bookFor(ctx.user.id);
        const row = (await db.select().from(commercialApprovals).where(and(eq(commercialApprovals.subjectType, input.subjectType), eq(commercialApprovals.subjectRef, input.subjectRef))).limit(1))[0];
        if (!row) return null;
        const signatures = await db.select().from(commercialApprovalSignatures).where(eq(commercialApprovalSignatures.commercialApprovalId, row.id)).orderBy(commercialApprovalSignatures.sequence);
        return { ...row, requirement: typeof row.requirement === "string" ? JSON.parse(row.requirement) : row.requirement, signatures: signatures.map(x => ({ ...x, rolesAtApproval: jsonArray<string>(x.rolesAtApproval) })) };
      }),
  }),

  /**
   * P7.5 — payables by organization: open vendor bills aged by due date, grouped by the
   * organization a person linked the vendor to; unlinked vendors by their captured name.
   */
  ap: router({
    agingByOrganization: roleProcedure("commercialOffice.apAgingByOrganization")
      .input(z.object({ financialEntityId: z.number().int().positive(), asOf: z.coerce.date().optional() }))
      .query(async ({ ctx, input }) => {
        const { db } = await bookFor(ctx.user.id);
        const asOf = input.asOf ?? new Date();
        const rows = await db.select({ b: vendorBills, vendorName: vendors.name, vendorOrgRef: vendors.orgRef }).from(vendorBills).innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
          .where(and(eq(vendorBills.financialEntityId, input.financialEntityId), notInArray(vendorBills.status, ["paid", "cancelled"])));
        const bucketOf = (dueAt: Date | null): "not_due" | "d1_30" | "d31_60" | "d61_90" | "d90_plus" => {
          if (!dueAt) return "not_due";
          const days = Math.floor((asOf.getTime() - dueAt.getTime()) / 86_400_000);
          return days <= 0 ? "not_due" : days <= 30 ? "d1_30" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : "d90_plus";
        };
        const groups = new Map<string, { orgRef: string | null; label: string; linked: boolean; billCount: number; totalCents: number; buckets: Record<"not_due" | "d1_30" | "d31_60" | "d61_90" | "d90_plus", number>; awaitingApprovalCents: number }>();
        for (const r of rows) {
          const key = r.vendorOrgRef ?? `unlinked:${r.vendorName}`;
          const g = groups.get(key) ?? { orgRef: r.vendorOrgRef ?? null, label: r.vendorOrgRef ?? r.vendorName, linked: r.vendorOrgRef !== null, billCount: 0, totalCents: 0, buckets: { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }, awaitingApprovalCents: 0 };
          g.billCount++; g.totalCents += r.b.totalCents; g.buckets[bucketOf(r.b.dueAt)] += r.b.totalCents;
          if (r.b.status !== "ready_to_pay") g.awaitingApprovalCents += r.b.totalCents;
          groups.set(key, g);
        }
        const out = Array.from(groups.values()).sort((x, y) => y.totalCents - x.totalCents);
        return { asOf, organizations: out.filter(o => o.linked), unlinked: out.filter(o => !o.linked), note: out.some(o => !o.linked) ? "Unlinked vendors are shown by their captured name; link them to an organization with commercialOffice.links.set (recordType vendor)." : undefined };
      }),
  }),

  /**
   * P7.6 — the general-ledger mapping the accounting-neutral export needs. A business loads
   * its own chart and maps its own keys; nothing is seeded. Readiness names what is unmapped.
   */
  gl: router({
    accountSet: roleProcedure("commercialOffice.glAccountSet")
      .input(z.object({ code: z.string().regex(/^[A-Za-z0-9.\-]{1,32}$/), name: z.string().min(1).max(120), kind: z.enum(["revenue", "cost_of_sales", "expense", "asset", "liability", "equity", "tax"]), status: z.enum(["active", "retired"]).default("active") }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const existing = (await db.select({ id: commercialGlAccounts.id }).from(commercialGlAccounts).where(and(eq(commercialGlAccounts.code, input.code), bookOrgRef ? eq(commercialGlAccounts.bookOrgRef, bookOrgRef) : isNull(commercialGlAccounts.bookOrgRef))).limit(1))[0];
        const values = { ...input, bookOrgRef, source: `business_defined by user ${ctx.user.id}`, createdByUserId: ctx.user.id };
        if (existing) await db.update(commercialGlAccounts).set({ name: input.name, kind: input.kind, status: input.status }).where(eq(commercialGlAccounts.id, existing.id)); else await db.insert(commercialGlAccounts).values(values);
        return { code: input.code, bookOrgRef };
      }),
    mappingSet: roleProcedure("commercialOffice.glMappingSet")
      .input(z.object({ mappingKind: z.enum(["service_code", "coding_category", "gst_output", "gst_input"]), mappingKey: z.string().min(1).max(80), glAccountCode: z.string().min(1).max(32) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const acct = (await db.select({ id: commercialGlAccounts.id, status: commercialGlAccounts.status }).from(commercialGlAccounts).where(and(eq(commercialGlAccounts.code, input.glAccountCode), bookWhere(commercialGlAccounts, bookOrgRef))).limit(1))[0];
        if (!acct) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — GL account ${input.glAccountCode} is not in this business's chart; add it first` });
        if (acct.status === "retired") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — GL account ${input.glAccountCode} is retired` });
        const existing = (await db.select({ id: commercialGlMappings.id }).from(commercialGlMappings).where(and(eq(commercialGlMappings.mappingKind, input.mappingKind), eq(commercialGlMappings.mappingKey, input.mappingKey), bookOrgRef ? eq(commercialGlMappings.bookOrgRef, bookOrgRef) : isNull(commercialGlMappings.bookOrgRef))).limit(1))[0];
        const values = { ...input, bookOrgRef, source: `business_defined by user ${ctx.user.id}`, updatedByUserId: ctx.user.id };
        if (existing) await db.update(commercialGlMappings).set(values).where(eq(commercialGlMappings.id, existing.id)); else await db.insert(commercialGlMappings).values(values);
        return { ...input, bookOrgRef };
      }),
    list: roleProcedure("commercialOffice.glList").query(async ({ ctx }) => {
      const { db, bookOrgRef } = await bookFor(ctx.user.id);
      const [accounts, mappings] = await Promise.all([db.select().from(commercialGlAccounts).where(bookWhere(commercialGlAccounts, bookOrgRef)), db.select().from(commercialGlMappings).where(bookWhere(commercialGlMappings, bookOrgRef))]);
      return { accounts, mappings };
    }),
    /** What an export of this period could not post: every unmapped key, by name and count. Nothing is exported here. */
    exportReadiness: roleProcedure("commercialOffice.glExportReadiness")
      .input(z.object({ financialEntityId: z.number().int().positive(), from: z.coerce.date(), to: z.coerce.date() }))
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const mappings = await db.select().from(commercialGlMappings).where(bookWhere(commercialGlMappings, bookOrgRef));
        const mapped = (kind: string, key: string) => mappings.find(m => m.mappingKind === kind && m.mappingKey === key && m.bookOrgRef === bookOrgRef) ?? mappings.find(m => m.mappingKind === kind && m.mappingKey === key && m.bookOrgRef === null) ?? null;
        const inv = await db.select({ serviceCode: invoiceLines.serviceCode, gst: invoices.gstTreatment, n: sql<number>`COUNT(*)` }).from(invoiceLines).innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
          .where(and(eq(invoices.financialEntityId, input.financialEntityId), gte(invoices.issuedAt, input.from), lte(invoices.issuedAt, input.to), notInArray(invoices.status, ["draft", "void"]))).groupBy(invoiceLines.serviceCode, invoices.gstTreatment);
        const bills = await db.select({ codingCategory: vendorBills.codingCategory, gst: vendorBills.gstTreatment, n: sql<number>`COUNT(*)` }).from(vendorBills)
          .where(and(eq(vendorBills.financialEntityId, input.financialEntityId), gte(vendorBills.invoiceDate, input.from), lte(vendorBills.invoiceDate, input.to), notInArray(vendorBills.status, ["cancelled"]))).groupBy(vendorBills.codingCategory, vendorBills.gstTreatment);
        const blockers: { kind: string; key: string; count: number; reason: string }[] = [];
        const tally = (kind: "service_code" | "coding_category" | "gst_output" | "gst_input", key: string | null, n: number, what: string) => {
          if (key === null || key === "") { blockers.push({ kind, key: "(none)", count: Number(n), reason: `${what} with no ${kind.replace("_", " ")} cannot be posted` }); return; }
          if (!mapped(kind, key)) blockers.push({ kind, key, count: Number(n), reason: `${what} ${kind.replace("_", " ")} "${key}" is not mapped to a GL account in this book` });
        };
        for (const r of inv) { tally("service_code", r.serviceCode, r.n, "invoice lines"); if (r.gst === "unknown") blockers.push({ kind: "gst_output", key: "unknown", count: Number(r.n), reason: "invoice lines whose GST treatment is unknown cannot be posted" }); else tally("gst_output", r.gst, r.n, "invoice lines"); }
        for (const r of bills) { tally("coding_category", r.codingCategory, r.n, "vendor bills"); if (r.gst === "unknown") blockers.push({ kind: "gst_input", key: "unknown", count: Number(r.n), reason: "vendor bills whose GST treatment is unknown cannot be posted" }); else tally("gst_input", r.gst, r.n, "vendor bills"); }
        const chartLoaded = (await db.select({ n: sql<number>`COUNT(*)` }).from(commercialGlAccounts).where(bookWhere(commercialGlAccounts, bookOrgRef)))[0]?.n ?? 0;
        if (!Number(chartLoaded)) blockers.unshift({ kind: "chart", key: "(none)", count: 0, reason: "no chart of accounts loaded for this book" });
        return { state: blockers.length ? ("BLOCKED" as const) : ("READY" as const), blockers, exported: false as const };
      }),
  }),

  /**
   * P7.7 — the commercial document registry, over the records vault. A document is registered
   * once with its content hash and a pointer to its bytes; content is never rewritten — a
   * change is a new version that supersedes, with a reason; a withdrawal keeps the row and says
   * why. Links to many records; deliveries logged; retention assigned by a person.
   */
  documents: router({
    register: roleProcedure("commercialOffice.documentRegister")
      .input(z.object({
        documentType: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), title: z.string().min(1).max(300), contentHash: z.string().regex(/^[a-f0-9]{64}$/), sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        byteLength: z.number().int().nonnegative().optional(), mimeType: z.string().max(120).optional(), evidenceRecordId: z.number().int().positive().optional(), fieldTicketDocumentId: z.number().int().positive().optional(), storageKey: storageKeyInput.optional(),
        counterpartyOrgRef: z.string().max(64).optional(), issuedAt: z.coerce.date().optional(), links: z.array(z.object({ recordType: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), recordRef: z.string().min(1).max(80) })).max(20).default([]),
      }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        if (!input.evidenceRecordId && !input.fieldTicketDocumentId && !input.storageKey) throw new TRPCError({ code: "BAD_REQUEST", message: "BLOCKED — a document needs a pointer to its bytes: an evidence record, a generated field-ticket document, or a storage key" });
        const types = await db.select().from(commercialCategoryTypes).where(and(eq(commercialCategoryTypes.kind, "document_type"), bookWhere(commercialCategoryTypes, bookOrgRef)));
        if (!layerFor(types.map(t => ({ ...t, category: t.categoryKey })), bookOrgRef, input.documentType).rows[0]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — "${input.documentType}" is not an active document type for this business` });
        if (input.evidenceRecordId) {
          const ev = (await db.select({ id: evidenceRecords.id }).from(evidenceRecords).where(eq(evidenceRecords.id, input.evidenceRecordId)).limit(1))[0];
          if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence record ${input.evidenceRecordId} does not exist` });
        }
        if (input.fieldTicketDocumentId) {
          const ftd = (await db.select({ id: fieldTicketDocuments.id, contentHash: fieldTicketDocuments.contentHash, sourceSnapshotHash: fieldTicketDocuments.sourceSnapshotHash }).from(fieldTicketDocuments).where(eq(fieldTicketDocuments.id, input.fieldTicketDocumentId)).limit(1))[0];
          if (!ftd) throw new TRPCError({ code: "NOT_FOUND", message: `Field-ticket document ${input.fieldTicketDocumentId} does not exist` });
          if (ftd.contentHash && ftd.contentHash !== input.contentHash) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — the hash given (${input.contentHash.slice(0, 12)}…) is not the generated document's hash (${ftd.contentHash.slice(0, 12)}…)` });
        }
        const documentRef = (await nextTrackingNumber(db, { sequenceType: "DOC" })).trackingNumber;
        // DC-B: the legacy path records no origin (a NULL originKind reads as "unrecorded", never a guess) but does bind the definition and the book's scope key.
        const definition = (await db.select({ definitionRef: documentDefinitions.definitionRef }).from(documentDefinitions).where(and(eq(documentDefinitions.definitionKey, input.documentType), eq(documentDefinitions.status, "active"), bookOrgRef ? or(isNull(documentDefinitions.orgRef), eq(documentDefinitions.orgRef, bookOrgRef)) : isNull(documentDefinitions.orgRef))).limit(1))[0];
        const ins = await db.insert(commercialDocuments).values({ documentRef, bookOrgRef, bookScopeKey: bookOrgRef ?? "default", definitionKey: definition ? input.documentType : null, definitionRef: definition?.definitionRef ?? null, controlState: "confirmed", documentType: input.documentType, title: input.title, contentHash: input.contentHash, sourceSnapshotHash: input.sourceSnapshotHash ?? null, byteLength: input.byteLength ?? null, mimeType: input.mimeType ?? null, evidenceRecordId: input.evidenceRecordId ?? null, fieldTicketDocumentId: input.fieldTicketDocumentId ?? null, storageKey: input.storageKey ?? null, counterpartyOrgRef: input.counterpartyOrgRef ?? null, issuedAt: input.issuedAt ?? null, registeredByUserId: ctx.user.id });
        for (const l of input.links) await db.insert(commercialDocumentLinks).values({ documentId: ins[0].insertId, recordType: l.recordType, recordRef: l.recordRef, linkedByUserId: ctx.user.id });
        return { documentRef, version: 1, retention: "unknown — assign a retention class" as const };
      }),
    supersede: roleProcedure("commercialOffice.documentSupersede")
      .input(z.object({ documentRef: z.string().min(1), reason: z.string().min(10).max(500), contentHash: z.string().regex(/^[a-f0-9]{64}$/), sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), byteLength: z.number().int().nonnegative().optional(), evidenceRecordId: z.number().int().positive().optional(), fieldTicketDocumentId: z.number().int().positive().optional(), storageKey: storageKeyInput.optional(), title: z.string().min(1).max(300).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const old = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.documentRef, input.documentRef)).limit(1))[0];
        if (!old || (bookOrgRef ? old.bookOrgRef !== bookOrgRef : old.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Document not in this business's register" });
        if (old.status !== "current") throw new TRPCError({ code: "CONFLICT", message: `Document is ${old.status}; only the current version can be superseded` });
        if (old.contentHash === input.contentHash) throw new TRPCError({ code: "BAD_REQUEST", message: "The new version has the same content hash as the old; nothing changed" });
        if (!input.evidenceRecordId && !input.fieldTicketDocumentId && !input.storageKey) throw new TRPCError({ code: "BAD_REQUEST", message: "BLOCKED — the new version needs a pointer to its bytes" });
        const documentRef = (await nextTrackingNumber(db, { sequenceType: "DOC" })).trackingNumber;
        const links = await db.select().from(commercialDocumentLinks).where(eq(commercialDocumentLinks.documentId, old.id));
        let newId = 0;
        await db.transaction(async tx => {
          const ins = await tx.insert(commercialDocuments).values({ documentRef, bookOrgRef, bookScopeKey: old.bookScopeKey, definitionKey: old.definitionKey, definitionRef: old.definitionRef, originKind: old.originKind, issuerKind: old.issuerKind, issuerOrgRef: old.issuerOrgRef, issuerFacilityId: old.issuerFacilityId, issuerName: old.issuerName, controlState: old.controlState, templateRevisionRef: old.templateRevisionRef, importChannel: old.importChannel, documentType: old.documentType, title: input.title ?? old.title, version: old.version + 1, supersedesDocumentId: old.id, contentHash: input.contentHash, sourceSnapshotHash: input.sourceSnapshotHash ?? null, byteLength: input.byteLength ?? null, mimeType: old.mimeType, evidenceRecordId: input.evidenceRecordId ?? null, fieldTicketDocumentId: input.fieldTicketDocumentId ?? null, storageKey: input.storageKey ?? null, counterpartyOrgRef: old.counterpartyOrgRef, issuedAt: old.issuedAt, retentionPolicyId: old.retentionPolicyId, retentionClass: old.retentionClass, retentionAssignedByUserId: old.retentionAssignedByUserId, registeredByUserId: ctx.user.id, statusReason: `supersedes ${old.documentRef}: ${input.reason}` });
          newId = ins[0].insertId;
          for (const l of links) await tx.insert(commercialDocumentLinks).values({ documentId: newId, recordType: l.recordType, recordRef: l.recordRef, linkedByUserId: ctx.user.id });
          await tx.update(commercialDocuments).set({ status: "superseded", supersededByDocumentId: newId, statusReason: `superseded by ${documentRef}: ${input.reason}` }).where(eq(commercialDocuments.id, old.id));
        });
        return { documentRef, version: old.version + 1, supersedes: old.documentRef, linksCarried: links.length };
      }),
    withdraw: roleProcedure("commercialOffice.documentWithdraw")
      .input(z.object({ documentRef: z.string().min(1), reason: z.string().min(10).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const doc = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.documentRef, input.documentRef)).limit(1))[0];
        if (!doc || (bookOrgRef ? doc.bookOrgRef !== bookOrgRef : doc.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Document not in this business's register" });
        if (doc.status === "withdrawn") throw new TRPCError({ code: "CONFLICT", message: "Already withdrawn" });
        if (doc.evidenceRecordId) {
          const ev = (await db.select({ legalHold: evidenceRecords.legalHold }).from(evidenceRecords).where(eq(evidenceRecords.id, doc.evidenceRecordId)).limit(1))[0];
          if (ev?.legalHold) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BLOCKED — the underlying evidence record is under legal hold; the document cannot be withdrawn while it stands" });
        }
        await db.update(commercialDocuments).set({ status: "withdrawn", statusReason: `withdrawn by user ${ctx.user.id}: ${input.reason}` }).where(eq(commercialDocuments.id, doc.id));
        return { documentRef: input.documentRef, status: "withdrawn" as const, note: "The row and its hash stay; withdrawn is a state, not a deletion." };
      }),
    link: roleProcedure("commercialOffice.documentLink")
      .input(z.object({ documentRef: z.string().min(1), recordType: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), recordRef: z.string().min(1).max(80) }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const doc = (await db.select({ id: commercialDocuments.id, bookOrgRef: commercialDocuments.bookOrgRef }).from(commercialDocuments).where(eq(commercialDocuments.documentRef, input.documentRef)).limit(1))[0];
        if (!doc || (bookOrgRef ? doc.bookOrgRef !== bookOrgRef : doc.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Document not in this business's register" });
        const dup = (await db.select({ id: commercialDocumentLinks.id }).from(commercialDocumentLinks).where(and(eq(commercialDocumentLinks.documentId, doc.id), eq(commercialDocumentLinks.recordType, input.recordType), eq(commercialDocumentLinks.recordRef, input.recordRef))).limit(1))[0];
        if (dup) return { documentRef: input.documentRef, linked: false, note: "already linked" };
        await db.insert(commercialDocumentLinks).values({ documentId: doc.id, recordType: input.recordType, recordRef: input.recordRef, linkedByUserId: ctx.user.id });
        return { documentRef: input.documentRef, linked: true };
      }),
    retentionAssign: roleProcedure("commercialOffice.documentRetentionAssign")
      .input(z.object({ documentRef: z.string().min(1), retentionPolicyId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const doc = (await db.select({ id: commercialDocuments.id, bookOrgRef: commercialDocuments.bookOrgRef }).from(commercialDocuments).where(eq(commercialDocuments.documentRef, input.documentRef)).limit(1))[0];
        if (!doc || (bookOrgRef ? doc.bookOrgRef !== bookOrgRef : doc.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Document not in this business's register" });
        const policy = (await db.select({ id: retentionPolicies.id, policyKey: retentionPolicies.policyKey, statutorySourceStatus: retentionPolicies.statutorySourceStatus }).from(retentionPolicies).where(eq(retentionPolicies.id, input.retentionPolicyId)).limit(1))[0];
        if (!policy) throw new TRPCError({ code: "NOT_FOUND", message: `Retention policy ${input.retentionPolicyId} does not exist` });
        await db.update(commercialDocuments).set({ retentionPolicyId: policy.id, retentionClass: policy.policyKey, retentionAssignedByUserId: ctx.user.id }).where(eq(commercialDocuments.id, doc.id));
        return { documentRef: input.documentRef, retentionClass: policy.policyKey, statutorySourceStatus: policy.statutorySourceStatus };
      }),
    deliveryRecord: roleProcedure("commercialOffice.documentDeliveryRecord")
      .input(z.object({ documentRef: z.string().min(1), channel: z.enum(["email", "portal", "print", "api", "courier", "other"]), recipientOrgRef: z.string().max(64).optional(), recipientAddress: z.string().max(300).optional(), status: z.enum(["queued", "sent", "delivered", "failed", "bounced", "acknowledged"]).default("sent"), deliveryEvidence: z.string().max(300).optional(), failureReason: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const doc = (await db.select({ id: commercialDocuments.id, bookOrgRef: commercialDocuments.bookOrgRef, status: commercialDocuments.status }).from(commercialDocuments).where(eq(commercialDocuments.documentRef, input.documentRef)).limit(1))[0];
        if (!doc || (bookOrgRef ? doc.bookOrgRef !== bookOrgRef : doc.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Document not in this business's register" });
        if (doc.status !== "current" && input.status !== "failed" && input.status !== "bounced") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — ${input.documentRef} is ${doc.status}; send the current version` });
        if ((input.status === "failed" || input.status === "bounced") && !input.failureReason) throw new TRPCError({ code: "BAD_REQUEST", message: "A failed or bounced delivery needs the reason" });
        const deliveryRef = ref("DLV");
        const sent = input.status !== "queued";
        await db.insert(commercialDocumentDeliveries).values({ deliveryRef, documentId: doc.id, channel: input.channel, recipientOrgRef: input.recipientOrgRef ?? null, recipientAddress: input.recipientAddress ?? null, status: input.status, sentAt: sent ? new Date() : null, sentByUserId: sent ? ctx.user.id : null, deliveredAt: input.status === "delivered" || input.status === "acknowledged" ? new Date() : null, deliveryEvidence: input.deliveryEvidence ?? null, failureReason: input.failureReason ?? null });
        return { deliveryRef, status: input.status };
      }),
    deliveryUpdate: roleProcedure("commercialOffice.documentDeliveryUpdate")
      .input(z.object({ deliveryRef: z.string().min(1), status: z.enum(["sent", "delivered", "failed", "bounced", "acknowledged"]), deliveryEvidence: z.string().max(300).optional(), failureReason: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { db } = await bookFor(ctx.user.id);
        const d = (await db.select().from(commercialDocumentDeliveries).where(eq(commercialDocumentDeliveries.deliveryRef, input.deliveryRef)).limit(1))[0];
        if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
        if ((input.status === "failed" || input.status === "bounced") && !input.failureReason) throw new TRPCError({ code: "BAD_REQUEST", message: "A failed or bounced delivery needs the reason" });
        await db.update(commercialDocumentDeliveries).set({ status: input.status, sentAt: d.sentAt ?? new Date(), sentByUserId: d.sentByUserId ?? ctx.user.id, deliveredAt: input.status === "delivered" || input.status === "acknowledged" ? new Date() : d.deliveredAt, deliveryEvidence: input.deliveryEvidence ?? d.deliveryEvidence, failureReason: input.failureReason ?? d.failureReason }).where(eq(commercialDocumentDeliveries.id, d.id));
        return { deliveryRef: input.deliveryRef, status: input.status };
      }),
    get: roleProcedure("commercialOffice.documentGet")
      .input(z.object({ documentRef: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const doc = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.documentRef, input.documentRef)).limit(1))[0];
        if (!doc || (bookOrgRef ? doc.bookOrgRef !== bookOrgRef : doc.bookOrgRef !== null)) throw new TRPCError({ code: "NOT_FOUND", message: "Document not in this business's register" });
        const [links, deliveries] = await Promise.all([db.select().from(commercialDocumentLinks).where(eq(commercialDocumentLinks.documentId, doc.id)), db.select().from(commercialDocumentDeliveries).where(eq(commercialDocumentDeliveries.documentId, doc.id))]);
        // The version chain, walked both ways.
        const chain: { documentRef: string; version: number; status: string }[] = [];
        let cur: typeof doc | undefined = doc;
        while (cur?.supersedesDocumentId) { cur = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.id, cur.supersedesDocumentId)).limit(1))[0]; if (cur) chain.unshift({ documentRef: cur.documentRef, version: cur.version, status: cur.status }); }
        chain.push({ documentRef: doc.documentRef, version: doc.version, status: doc.status });
        cur = doc;
        while (cur?.supersededByDocumentId) { cur = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.id, cur.supersededByDocumentId)).limit(1))[0]; if (cur) chain.push({ documentRef: cur.documentRef, version: cur.version, status: cur.status }); }
        return { document: doc, retention: doc.retentionClass ?? "unknown", links, deliveries, versions: chain };
      }),
    list: roleProcedure("commercialOffice.documentsList")
      .input(z.object({ recordType: z.string().max(40).optional(), recordRef: z.string().max(80).optional(), documentType: z.string().max(40).optional(), counterpartyOrgRef: z.string().max(64).optional(), includeSuperseded: z.boolean().default(false) }).optional())
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const conds = [bookOrgRef ? eq(commercialDocuments.bookOrgRef, bookOrgRef) : isNull(commercialDocuments.bookOrgRef)];
        if (input?.documentType) conds.push(eq(commercialDocuments.documentType, input.documentType));
        if (input?.counterpartyOrgRef) conds.push(eq(commercialDocuments.counterpartyOrgRef, input.counterpartyOrgRef));
        if (!input?.includeSuperseded) conds.push(eq(commercialDocuments.status, "current"));
        if (input?.recordType && input?.recordRef) {
          const ids = (await db.select({ documentId: commercialDocumentLinks.documentId }).from(commercialDocumentLinks).where(and(eq(commercialDocumentLinks.recordType, input.recordType), eq(commercialDocumentLinks.recordRef, input.recordRef)))).map(x => x.documentId);
          if (!ids.length) return [];
          conds.push(inArray(commercialDocuments.id, ids));
        }
        return db.select().from(commercialDocuments).where(and(...conds)).limit(500);
      }),
  }),

  /** P7.6 — profitability by dimension, from evidence links only; a business hides the dimensions it does not use by retiring them. */
  profitability: router({
    byDimension: roleProcedure("commercialOffice.profitabilityByDimension")
      .input(z.object({ financialEntityId: z.number().int().positive(), dimension: z.enum(["client", "job", "load", "unit", "driver", "branch", "contractor"]), from: z.coerce.date(), to: z.coerce.date() }))
      .query(async ({ ctx, input }) => {
        const { db, bookOrgRef } = await bookFor(ctx.user.id);
        const dims = await db.select().from(commercialCategoryTypes).where(and(eq(commercialCategoryTypes.kind, "profitability_dimension"), bookWhere(commercialCategoryTypes, bookOrgRef)));
        const active = layerFor(dims.map(d => ({ ...d, category: d.categoryKey })), bookOrgRef, input.dimension).rows[0];
        if (!active) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — dimension "${input.dimension}" is not active in this business's book` });
        const d = derivability(input.dimension as Dimension);
        if (d.derivable === false) return { dimension: input.dimension, derivable: false as const, reason: d.reason, rows: [] as never[] };
        // Revenue by job (ex-tax subtotal), cost by job from bills and contractor payables.
        const inv = await db.select({ jobId: invoices.jobId, customer: invoices.customer, customerOrgRef: jobs.customerOrgRef, subtotalCents: invoices.subtotalCents }).from(invoices).leftJoin(jobs, eq(jobs.id, invoices.jobId))
          .where(and(eq(invoices.financialEntityId, input.financialEntityId), gte(invoices.issuedAt, input.from), lte(invoices.issuedAt, input.to), notInArray(invoices.status, ["draft", "void"])));
        const bills = await db.select({ jobId: vendorBills.jobId, unitId: vendorBills.unitId, subtotalCents: vendorBills.subtotalCents }).from(vendorBills)
          .where(and(eq(vendorBills.financialEntityId, input.financialEntityId), gte(vendorBills.invoiceDate, input.from), lte(vendorBills.invoiceDate, input.to), notInArray(vendorBills.status, ["cancelled"])));
        const pays = await db.select({ jobId: commercialJobChains.rootJobId, payeeOrgRef: contractorPayables.payeeOrgRef, grossAmountCents: contractorPayables.grossAmountCents, state: contractorPayables.state }).from(contractorPayables).innerJoin(commercialJobChains, eq(commercialJobChains.chainRef, contractorPayables.chainRef))
          .where(and(gte(contractorPayables.createdAt, input.from), lte(contractorPayables.createdAt, input.to), inArray(contractorPayables.state, ["approved", "posted"])));
        const rows = new Map<string, Figures & { key: string; label: string }>();
        const bump = (key: string, label: string, f: Partial<Figures>) => { const r = rows.get(key) ?? { ...empty(), key, label }; rows.set(key, { ...r, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, (r as never as Record<string, number>)[k] + (v as number)])) } as never); };
        const jobKey = (jobId: number | null) => jobId === null ? "unattributed" : `job:${jobId}`;
        const clientKey = (customerOrgRef: string | null, customer: string | null) => customerOrgRef ?? (customer ? `unlinked:${customer}` : "unattributed");
        if (input.dimension === "job") {
          for (const i of inv) bump(jobKey(i.jobId), jobKey(i.jobId), { revenueCents: i.subtotalCents ?? 0, invoiceCount: 1 });
          for (const b of bills) bump(jobKey(b.jobId), jobKey(b.jobId), { costCents: b.subtotalCents ?? 0, billCount: 1 });
          for (const p of pays) bump(jobKey(p.jobId), jobKey(p.jobId), { costCents: p.grossAmountCents, payableCount: 1 });
        } else if (input.dimension === "client") {
          const jobClient = new Map<number, { orgRef: string | null; customer: string | null }>();
          for (const i of inv) if (i.jobId !== null) jobClient.set(i.jobId, { orgRef: i.customerOrgRef, customer: i.customer });
          for (const i of inv) bump(clientKey(i.customerOrgRef, i.customer), clientKey(i.customerOrgRef, i.customer), { revenueCents: i.subtotalCents ?? 0, invoiceCount: 1 });
          for (const b of bills) { const c = b.jobId !== null ? jobClient.get(b.jobId) : undefined; const k = c ? clientKey(c.orgRef, c.customer) : "unattributed"; bump(k, k, { costCents: b.subtotalCents ?? 0, billCount: 1 }); }
          for (const p of pays) { const c = jobClient.get(p.jobId); const k = c ? clientKey(c.orgRef, c.customer) : "unattributed"; bump(k, k, { costCents: p.grossAmountCents, payableCount: 1 }); }
        } else if (input.dimension === "contractor") {
          for (const p of pays) bump(p.payeeOrgRef, p.payeeOrgRef, { costCents: p.grossAmountCents, payableCount: 1 });
        } else if (input.dimension === "unit") {
          for (const b of bills) { const k = b.unitId === null ? "unattributed" : `unit:${b.unitId}`; bump(k, k, { costCents: b.subtotalCents ?? 0, billCount: 1 }); }
        }
        const out = Array.from(rows.values()).map(r => ({ ...r, ...finish(r) })).sort((a, b) => b.revenueCents - a.revenueCents || b.costCents - a.costCents);
        return { dimension: input.dimension, derivable: d.derivable, basis: d.basis, note: d.derivable === "cost_only" ? d.reason : undefined, rows: out };
      }),
  }),
});
