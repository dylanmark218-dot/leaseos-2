/**
 * v23.26 — Customer, Contract and Rate Management: the database half.
 *
 * Every rule lives in `_core/commercialLifecycle.ts` and `_core/rateApplicability.ts`; this file
 * is where the rows are read under the money scope (P4.1, 0146: the financial entity is the
 * tenant boundary) and written inside one transaction with their audit row and outbox event.
 *
 *   - A record outside the caller's scope is NOT FOUND, never FORBIDDEN.
 *   - Every write names the row version it read; a stale write is CONFLICT.
 *   - Every state transition writes a commercialAuditEvents row in the same transaction.
 *   - Approval is a second person's act (separation of duties), as commercialSetup established.
 *   - Once a job has snapshotted a contract or a sheet version, it is frozen; a change supersedes.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import {
  chargeDefinitions, commercialAuditEvents, commercialDocumentLinks, commercialDocuments, customerAccounts, customerContactRoles, customerContacts, customerContractTerms, customerContracts,
  customerPurchaseOrders, dispatchPostings, dispatchRoles, domainEventOutbox, jobCommercialContexts, jobCommercialParties, jobCommercialReferences, jobCommercialSnapshots, jobs, operators, rateSheetVersions, rateSheets,
} from "../drizzle/schema";
import { getDb, jobInScope } from "./db";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { entityIdsInScope, notFound, type MoneyScope } from "./_core/entityScope";
import type { Db, DbOrTx, Tx } from "./_core/dbTypes";
import { buildOutboxRow } from "./_core/eventEmitter";
import { nextTrackingNumber } from "./_core/trackingNumbers";
import { parseConditions } from "./_core/rateApplicability";
import { resolveRate, type ChargeDefinition, type ResolutionContext, type Resolution } from "./_core/rateResolution";
import {
  billableContextOf, chooseVersionAt, commercialReadiness, contractTransition, contractUsable, fieldSubsetOf, requiredReferenceKinds, rowVersionCheck, snapshotHash, supersessionWindow,
  versionContentHash, versionTransition, CONTRACT_EDITABLE_STATUSES, VERSION_LINE_EDITABLE,
  type BillableCommercialContext, type ContractEvent, type FieldCommercialSubset, type SnapshotContact, type SnapshotDefinition, type SnapshotParty, type SnapshotPayload,
} from "./_core/commercialLifecycle";
import { CONTACT_PARTY_ROLES, isRateLineKind, type ContractStatus, type PartyRole, type ReferenceKind, type SheetVersionStatus } from "../shared/commercialVocabulary";
import type { DispatchBlocker } from "./_core/dispatchReadiness";

/* ----------------------------------------------------------------- plumbing */

export type Actor = { userId: number; roles: readonly string[] };
export type CommercialScope = { db: Db; scope: MoneyScope; entityIds: number[]; tenantId: string };

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const precondition = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });
const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message });
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });
const roleOf = (a: Actor) => (a.roles.length ? a.roles.join(",") : "none").slice(0, 60);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const parseJson = <T>(s: string | null | undefined, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };

/** The caller's money scope. Empty `entityIds` means the caller can see no commercial record at all. */
export async function commercialScope(userId: number): Promise<CommercialScope> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const acting = await resolveActingScope(db, userId);
  const scope = { tenantId: acting.tenantId };
  return { db, scope, entityIds: await entityIdsInScope(db, scope), tenantId: acting.tenantId };
}
const inScope = (s: CommercialScope, col: MySqlColumn) => (s.entityIds.length ? inArray(col, s.entityIds) : sql`1 = 0`);

/** The change ledger row, in the caller's transaction. */
async function audit(tx: DbOrTx, e: { financialEntityId: number; subjectType: (typeof commercialAuditEvents.$inferInsert)["subjectType"]; subjectRef: string; subjectId?: number | null; eventType: string; fromStatus?: string | null; toStatus?: string | null; changes?: Record<string, { from: unknown; to: unknown }> | null; relatedRef?: string | null; jobId?: number | null; reason?: string | null; actor: Actor; at: Date }) {
  await tx.insert(commercialAuditEvents).values({
    eventRef: ref("CAE"), financialEntityId: e.financialEntityId, subjectType: e.subjectType, subjectRef: e.subjectRef, subjectId: e.subjectId ?? null, eventType: e.eventType,
    fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null, changesJson: e.changes && Object.keys(e.changes).length ? JSON.stringify(e.changes) : null,
    relatedRef: e.relatedRef ?? null, jobId: e.jobId ?? null, reason: e.reason ?? null, actorUserId: e.actor.userId, actorRole: roleOf(e.actor), occurredAt: e.at,
  });
}
/** A domain event on the outbox, in the caller's transaction (the drizzle handle, so it lives or dies with the change). */
async function emit(tx: DbOrTx, e: { tenantId: string; type: string; entityType: string; entityId: string; actor: Actor; jobId?: number | null; payload: Record<string, unknown>; at: Date }) {
  const row = buildOutboxRow({ type: e.type, actor: { userId: String(e.actor.userId), source: "human" }, subject: { entityType: e.entityType, entityId: e.entityId }, tenantId: e.tenantId, jobId: e.jobId != null ? String(e.jobId) : null, payload: e.payload, occurredAt: e.at }, e.at);
  await tx.insert(domainEventOutbox).values({ ...row, actorSource: "human" });
}
/** Field-level diff for the audit row: only what changed. */
function diff<T extends Record<string, unknown>>(before: T, patch: Partial<T>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; const b = before[k]; if (JSON.stringify(b ?? null) !== JSON.stringify(v ?? null)) out[k] = { from: b ?? null, to: v ?? null }; }
  return out;
}

/* ---------------------------------------------------------------- customers */

export type AccountRow = typeof customerAccounts.$inferSelect;

export async function accountInScope(s: CommercialScope, accountRef: string, d: DbOrTx = s.db): Promise<AccountRow> {
  const a = (await d.select().from(customerAccounts).where(and(eq(customerAccounts.accountRef, accountRef), inScope(s, customerAccounts.financialEntityId))).limit(1))[0];
  if (!a) throw notFound(`Customer ${accountRef}`);
  return a;
}
async function accountByIdInScope(s: CommercialScope, id: number, d: DbOrTx = s.db): Promise<AccountRow> {
  const a = (await d.select().from(customerAccounts).where(and(eq(customerAccounts.id, id), inScope(s, customerAccounts.financialEntityId))).limit(1))[0];
  if (!a) throw notFound(`Customer #${id}`);
  return a;
}

export type CustomerInput = {
  financialEntityId: number; name: string; customerNumber?: string | null; legalName?: string | null; tradeName?: string | null; customerType?: AccountRow["customerType"];
  billingAddress?: unknown; physicalAddress?: unknown; province?: string | null; country?: string; gstNumber?: string | null; taxStatus?: AccountRow["taxStatus"]; defaultCurrency?: string;
  paymentTermsDays?: number; creditLimitCents?: number | null; requiresPurchaseOrder?: boolean; requiresAfe?: boolean; requiredReferenceKinds?: ReferenceKind[]; billingFrequency?: AccountRow["billingFrequency"]; notes?: string | null; orgRef?: string | null;
};

export async function customerCreate(s: CommercialScope, actor: Actor, input: CustomerInput, at = new Date()) {
  if (!s.entityIds.includes(input.financialEntityId)) throw notFound(`Financial entity ${input.financialEntityId}`);
  const customerNumber = input.customerNumber?.trim() || (await nextTrackingNumber(s.db, { sequenceType: "CN" })).trackingNumber;
  const accountRef = ref("CUST");
  return s.db.transaction(async tx => {
    const dupName = (await tx.select({ id: customerAccounts.id }).from(customerAccounts).where(and(eq(customerAccounts.financialEntityId, input.financialEntityId), eq(customerAccounts.name, input.name))).limit(1))[0];
    if (dupName) throw conflict(`A customer named "${input.name}" already exists in this entity`);
    const dupNo = (await tx.select({ id: customerAccounts.id }).from(customerAccounts).where(and(eq(customerAccounts.financialEntityId, input.financialEntityId), eq(customerAccounts.customerNumber, customerNumber))).limit(1))[0];
    if (dupNo) throw conflict(`Customer number ${customerNumber} is already used in this entity`);
    const ins = await tx.insert(customerAccounts).values({
      accountRef, financialEntityId: input.financialEntityId, name: input.name, customerNumber, legalName: input.legalName ?? null, tradeName: input.tradeName ?? null, customerType: input.customerType ?? "other",
      billingAddressJson: input.billingAddress ? JSON.stringify(input.billingAddress) : null, physicalAddressJson: input.physicalAddress ? JSON.stringify(input.physicalAddress) : null,
      province: input.province ?? null, country: input.country ?? "CA", gstNumber: input.gstNumber ?? null, taxStatus: input.taxStatus ?? "unknown", defaultCurrency: input.defaultCurrency ?? "CAD",
      paymentTermsDays: input.paymentTermsDays ?? 30, creditLimitCents: input.creditLimitCents ?? null, requiresPurchaseOrder: input.requiresPurchaseOrder ?? false, requiresAfe: input.requiresAfe ?? false,
      requiredReferenceKindsJson: input.requiredReferenceKinds?.length ? JSON.stringify(input.requiredReferenceKinds) : null, billingFrequency: input.billingFrequency ?? "per_job", notes: input.notes ?? null,
      orgRef: input.orgRef ?? null, createdByUserId: actor.userId, updatedByUserId: actor.userId, status: "active",
    });
    const id = Number(ins[0]?.insertId ?? 0);
    await audit(tx, { financialEntityId: input.financialEntityId, subjectType: "customer_account", subjectRef: accountRef, subjectId: id, eventType: "customer_created", toStatus: "active", actor, at, changes: { name: { from: null, to: input.name }, customerNumber: { from: null, to: customerNumber } } });
    await emit(tx, { tenantId: s.tenantId, type: "commercial.customer_created", entityType: "customerAccount", entityId: accountRef, actor, payload: { accountRef, customerNumber, name: input.name, financialEntityId: input.financialEntityId }, at });
    return { id, accountRef, customerNumber };
  });
}

export type CustomerPatch = Partial<Omit<CustomerInput, "financialEntityId">> & { expectedRowVersion?: number };
export async function customerUpdate(s: CommercialScope, actor: Actor, accountRef: string, patch: CustomerPatch, at = new Date()) {
  return s.db.transaction(async tx => {
    const a = (await tx.select().from(customerAccounts).where(and(eq(customerAccounts.accountRef, accountRef), inScope(s, customerAccounts.financialEntityId))).for("update").limit(1))[0];
    if (!a) throw notFound(`Customer ${accountRef}`);
    if (a.archivedAt) throw precondition("An archived customer is history; reactivate it before editing");
    const rv = rowVersionCheck(patch.expectedRowVersion, a.rowVersion); if (!rv.ok) throw conflict(`Customer ${rv.reason}`);
    const set: Partial<AccountRow> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.customerNumber !== undefined) set.customerNumber = patch.customerNumber;
    if (patch.legalName !== undefined) set.legalName = patch.legalName; if (patch.tradeName !== undefined) set.tradeName = patch.tradeName;
    if (patch.customerType !== undefined) set.customerType = patch.customerType;
    if (patch.billingAddress !== undefined) set.billingAddressJson = patch.billingAddress ? JSON.stringify(patch.billingAddress) : null;
    if (patch.physicalAddress !== undefined) set.physicalAddressJson = patch.physicalAddress ? JSON.stringify(patch.physicalAddress) : null;
    if (patch.province !== undefined) set.province = patch.province; if (patch.country !== undefined) set.country = patch.country;
    if (patch.gstNumber !== undefined) set.gstNumber = patch.gstNumber; if (patch.taxStatus !== undefined) set.taxStatus = patch.taxStatus; if (patch.defaultCurrency !== undefined) set.defaultCurrency = patch.defaultCurrency;
    if (patch.paymentTermsDays !== undefined) set.paymentTermsDays = patch.paymentTermsDays; if (patch.creditLimitCents !== undefined) set.creditLimitCents = patch.creditLimitCents;
    if (patch.requiresPurchaseOrder !== undefined) set.requiresPurchaseOrder = patch.requiresPurchaseOrder; if (patch.requiresAfe !== undefined) set.requiresAfe = patch.requiresAfe;
    if (patch.requiredReferenceKinds !== undefined) set.requiredReferenceKindsJson = patch.requiredReferenceKinds?.length ? JSON.stringify(patch.requiredReferenceKinds) : null;
    if (patch.billingFrequency !== undefined) set.billingFrequency = patch.billingFrequency; if (patch.notes !== undefined) set.notes = patch.notes; if (patch.orgRef !== undefined) set.orgRef = patch.orgRef;
    const changes = diff(a as unknown as Record<string, unknown>, set as Record<string, unknown>);
    if (!Object.keys(changes).length) return { accountRef, rowVersion: a.rowVersion, changed: 0 };
    if (set.customerNumber) { const dup = (await tx.select({ id: customerAccounts.id }).from(customerAccounts).where(and(eq(customerAccounts.financialEntityId, a.financialEntityId), eq(customerAccounts.customerNumber, set.customerNumber))).limit(1))[0]; if (dup && dup.id !== a.id) throw conflict(`Customer number ${set.customerNumber} is already used in this entity`); }
    await tx.update(customerAccounts).set({ ...set, updatedByUserId: actor.userId, rowVersion: a.rowVersion + 1 }).where(eq(customerAccounts.id, a.id));
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "customer_account", subjectRef: accountRef, subjectId: a.id, eventType: "customer_updated", changes, actor, at });
    return { accountRef, rowVersion: a.rowVersion + 1, changed: Object.keys(changes).length };
  });
}

/** Billing hold on / off. The account status is the billing status the billing check reads (`account_on_hold`). */
export async function customerHoldSet(s: CommercialScope, actor: Actor, args: { accountRef: string; hold: boolean; reason: string; expectedRowVersion?: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const a = (await tx.select().from(customerAccounts).where(and(eq(customerAccounts.accountRef, args.accountRef), inScope(s, customerAccounts.financialEntityId))).for("update").limit(1))[0];
    if (!a) throw notFound(`Customer ${args.accountRef}`);
    const rv = rowVersionCheck(args.expectedRowVersion, a.rowVersion); if (!rv.ok) throw conflict(`Customer ${rv.reason}`);
    if (a.status === "inactive") throw precondition("An inactive customer is not put on hold; it is inactive");
    const to = args.hold ? "on_hold" : "active";
    if (a.status === to) return { accountRef: a.accountRef, status: a.status, rowVersion: a.rowVersion };
    await tx.update(customerAccounts).set({ status: to, holdReason: args.hold ? args.reason : null, updatedByUserId: actor.userId, rowVersion: a.rowVersion + 1 }).where(eq(customerAccounts.id, a.id));
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "customer_account", subjectRef: a.accountRef, subjectId: a.id, eventType: args.hold ? "billing_hold_set" : "billing_hold_released", fromStatus: a.status, toStatus: to, reason: args.reason, actor, at });
    await emit(tx, { tenantId: s.tenantId, type: args.hold ? "commercial.customer_billing_hold" : "commercial.customer_billing_hold_released", entityType: "customerAccount", entityId: a.accountRef, actor, payload: { accountRef: a.accountRef, reason: args.reason }, at });
    return { accountRef: a.accountRef, status: to, rowVersion: a.rowVersion + 1 };
  });
}

export async function customerArchive(s: CommercialScope, actor: Actor, args: { accountRef: string; reason: string; expectedRowVersion?: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const a = (await tx.select().from(customerAccounts).where(and(eq(customerAccounts.accountRef, args.accountRef), inScope(s, customerAccounts.financialEntityId))).for("update").limit(1))[0];
    if (!a) throw notFound(`Customer ${args.accountRef}`);
    const rv = rowVersionCheck(args.expectedRowVersion, a.rowVersion); if (!rv.ok) throw conflict(`Customer ${rv.reason}`);
    if (a.archivedAt) return { accountRef: a.accountRef, status: a.status, archivedAt: a.archivedAt };
    const live = (await tx.select({ id: customerContracts.id }).from(customerContracts).where(and(eq(customerContracts.customerAccountId, a.id), inArray(customerContracts.status, ["active", "suspended", "pending_approval"]))).limit(1))[0];
    if (live) throw precondition("This customer has an active, suspended or pending contract; terminate or let it expire first");
    await tx.update(customerAccounts).set({ status: "inactive", archivedAt: at, archivedByUserId: actor.userId, archiveReason: args.reason, updatedByUserId: actor.userId, rowVersion: a.rowVersion + 1 }).where(eq(customerAccounts.id, a.id));
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "customer_account", subjectRef: a.accountRef, subjectId: a.id, eventType: "customer_archived", fromStatus: a.status, toStatus: "inactive", reason: args.reason, actor, at });
    return { accountRef: a.accountRef, status: "inactive" as const, archivedAt: at };
  });
}

export async function customerReactivate(s: CommercialScope, actor: Actor, args: { accountRef: string; reason: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const a = (await tx.select().from(customerAccounts).where(and(eq(customerAccounts.accountRef, args.accountRef), inScope(s, customerAccounts.financialEntityId))).for("update").limit(1))[0];
    if (!a) throw notFound(`Customer ${args.accountRef}`);
    if (!a.archivedAt && a.status !== "inactive") return { accountRef: a.accountRef, status: a.status };
    await tx.update(customerAccounts).set({ status: "active", archivedAt: null, archivedByUserId: null, archiveReason: null, updatedByUserId: actor.userId, rowVersion: a.rowVersion + 1 }).where(eq(customerAccounts.id, a.id));
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "customer_account", subjectRef: a.accountRef, subjectId: a.id, eventType: "customer_reactivated", fromStatus: a.status, toStatus: "active", reason: args.reason, actor, at });
    return { accountRef: a.accountRef, status: "active" as const };
  });
}

export type CustomerFilter = { q?: string; status?: "active" | "on_hold" | "inactive"; customerType?: AccountRow["customerType"]; includeArchived?: boolean; financialEntityId?: number; limit?: number };
export async function customersList(s: CommercialScope, f: CustomerFilter) {
  const where = [inScope(s, customerAccounts.financialEntityId)];
  if (f.financialEntityId != null) where.push(eq(customerAccounts.financialEntityId, f.financialEntityId));
  if (f.status) where.push(eq(customerAccounts.status, f.status));
  if (f.customerType) where.push(eq(customerAccounts.customerType, f.customerType));
  if (!f.includeArchived) where.push(isNull(customerAccounts.archivedAt));
  if (f.q?.trim()) { const q = `%${f.q.trim()}%`; where.push(or(like(customerAccounts.name, q), like(customerAccounts.customerNumber, q), like(customerAccounts.legalName, q), like(customerAccounts.tradeName, q))!); }
  const rows = await s.db.select().from(customerAccounts).where(and(...where)).orderBy(asc(customerAccounts.name)).limit(Math.min(f.limit ?? 200, 500));
  return rows.map(customerView);
}
export function customerView(a: AccountRow) {
  return {
    id: a.id, accountRef: a.accountRef, customerNumber: a.customerNumber, name: a.name, legalName: a.legalName, tradeName: a.tradeName, customerType: a.customerType, status: a.status, holdReason: a.holdReason,
    financialEntityId: a.financialEntityId, orgRef: a.orgRef, billingAddress: parseJson<unknown>(a.billingAddressJson, null), physicalAddress: parseJson<unknown>(a.physicalAddressJson, null), province: a.province, country: a.country,
    gstNumber: a.gstNumber, taxStatus: a.taxStatus, defaultCurrency: a.defaultCurrency, paymentTermsDays: a.paymentTermsDays, creditLimitCents: a.creditLimitCents, requiresPurchaseOrder: a.requiresPurchaseOrder, requiresAfe: a.requiresAfe,
    requiredReferenceKinds: parseJson<string[]>(a.requiredReferenceKindsJson, []), billingFrequency: a.billingFrequency, notes: a.notes, createdAt: a.createdAt, createdByUserId: a.createdByUserId, updatedAt: a.updatedAt, updatedByUserId: a.updatedByUserId,
    archivedAt: a.archivedAt, archivedByUserId: a.archivedByUserId, archiveReason: a.archiveReason, rowVersion: a.rowVersion,
  };
}
export async function customerGet(s: CommercialScope, accountRef: string) {
  const a = await accountInScope(s, accountRef);
  const [contacts, contracts, sheets, pos, snapshots] = await Promise.all([
    contactsList(s, a.id), contractsListForAccount(s, a.id), rateSheetsListForAccount(s, a.id),
    s.db.select().from(customerPurchaseOrders).where(eq(customerPurchaseOrders.customerAccountId, a.id)).orderBy(desc(customerPurchaseOrders.id)).limit(100),
    s.db.select({ id: jobCommercialSnapshots.id, snapshotRef: jobCommercialSnapshots.snapshotRef, jobId: jobCommercialSnapshots.jobId, sequenceNo: jobCommercialSnapshots.sequenceNo, status: jobCommercialSnapshots.status, capturedAt: jobCommercialSnapshots.capturedAt, contractRef: jobCommercialSnapshots.contractRef, rateSheetVersionRef: jobCommercialSnapshots.rateSheetVersionRef, poNumber: jobCommercialSnapshots.poNumber }).from(jobCommercialSnapshots).where(and(eq(jobCommercialSnapshots.customerAccountId, a.id), eq(jobCommercialSnapshots.status, "current"))).orderBy(desc(jobCommercialSnapshots.id)).limit(200),
  ]);
  const jobIds = Array.from(new Set(snapshots.map(x => x.jobId)));
  const jobRows = jobIds.length ? await s.db.select({ id: jobs.id, jobCode: jobs.jobCode, status: jobs.status, type: jobs.type, location: jobs.location }).from(jobs).where(inArray(jobs.id, jobIds)) : [];
  const jobById = new Map(jobRows.map(j => [j.id, j]));
  return { ...customerView(a), contacts, contracts, rateSheets: sheets, purchaseOrders: pos.map(p => ({ poRef: p.poRef, poNumber: p.poNumber, afeNumber: p.afeNumber, authorizedCents: p.authorizedCents, validFrom: p.validFrom, validTo: p.validTo, status: p.status })), jobs: snapshots.map(x => ({ ...x, job: jobById.get(x.jobId) ?? null })) };
}
export async function auditHistory(s: CommercialScope, subjectType: (typeof commercialAuditEvents.$inferSelect)["subjectType"], subjectRef: string, limit = 200) {
  return s.db.select().from(commercialAuditEvents).where(and(eq(commercialAuditEvents.subjectType, subjectType), eq(commercialAuditEvents.subjectRef, subjectRef), inScope(s, commercialAuditEvents.financialEntityId))).orderBy(desc(commercialAuditEvents.id)).limit(limit);
}
export async function auditHistoryForAccount(s: CommercialScope, accountRef: string, limit = 300) {
  const a = await accountInScope(s, accountRef);
  const [contracts, sheets, contacts] = await Promise.all([
    s.db.select({ r: customerContracts.contractRef }).from(customerContracts).where(eq(customerContracts.customerAccountId, a.id)),
    s.db.select({ r: rateSheets.rateSheetRef }).from(rateSheets).where(eq(rateSheets.customerAccountId, a.id)),
    s.db.select({ r: customerContacts.contactRef }).from(customerContacts).where(eq(customerContacts.customerAccountId, a.id)),
  ]);
  const refs = [a.accountRef, ...contracts.map(x => x.r), ...sheets.map(x => x.r), ...contacts.map(x => x.r)];
  const versions = sheets.length ? await s.db.select({ r: rateSheetVersions.versionRef }).from(rateSheetVersions).where(inArray(rateSheetVersions.rateSheetId, (await s.db.select({ id: rateSheets.id }).from(rateSheets).where(eq(rateSheets.customerAccountId, a.id))).map(x => x.id))) : [];
  refs.push(...versions.map(x => x.r));
  return s.db.select().from(commercialAuditEvents).where(and(inArray(commercialAuditEvents.subjectRef, refs), eq(commercialAuditEvents.financialEntityId, a.financialEntityId))).orderBy(desc(commercialAuditEvents.id)).limit(limit);
}

/* ----------------------------------------------------------------- contacts */

export type ContactInput = { displayName: string; title?: string | null; company?: string | null; phone?: string | null; mobile?: string | null; email?: string | null; preferredChannel?: "phone" | "sms" | "email" | "portal" | null; externalIdentityId?: number | null; signatoryAuthorityId?: number | null; effectiveFrom?: Date; notes?: string | null; roles?: { roleKey: string; isPrimary?: boolean }[] };

export async function contactCreate(s: CommercialScope, actor: Actor, accountRef: string, input: ContactInput, at = new Date()) {
  const a = await accountInScope(s, accountRef);
  if (a.archivedAt) throw precondition("An archived customer takes no new contacts");
  const contactRef = ref("CT");
  return s.db.transaction(async tx => {
    const ins = await tx.insert(customerContacts).values({ contactRef, financialEntityId: a.financialEntityId, customerAccountId: a.id, displayName: input.displayName, title: input.title ?? null, company: input.company ?? null, phone: input.phone ?? null, mobile: input.mobile ?? null, email: input.email ?? null, preferredChannel: input.preferredChannel ?? null, externalIdentityId: input.externalIdentityId ?? null, signatoryAuthorityId: input.signatoryAuthorityId ?? null, effectiveFrom: input.effectiveFrom ?? at, notes: input.notes ?? null, createdByUserId: actor.userId, updatedByUserId: actor.userId });
    const id = Number(ins[0]?.insertId ?? 0);
    for (const r of input.roles ?? []) await tx.insert(customerContactRoles).values({ contactId: id, customerAccountId: a.id, roleKey: r.roleKey, isPrimary: r.isPrimary ?? false, effectiveFrom: input.effectiveFrom ?? at, assignedByUserId: actor.userId });
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "customer_contact", subjectRef: contactRef, subjectId: id, eventType: "contact_created", relatedRef: a.accountRef, changes: { displayName: { from: null, to: input.displayName }, roles: { from: null, to: (input.roles ?? []).map(r => r.roleKey) } }, actor, at });
    return { id, contactRef };
  });
}
export async function contactUpdate(s: CommercialScope, actor: Actor, contactRef: string, patch: Partial<Omit<ContactInput, "roles">> & { status?: "active" | "inactive"; effectiveTo?: Date | null; expectedRowVersion?: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = (await tx.select().from(customerContacts).where(and(eq(customerContacts.contactRef, contactRef), inScope(s, customerContacts.financialEntityId))).for("update").limit(1))[0];
    if (!c) throw notFound(`Contact ${contactRef}`);
    const rv = rowVersionCheck(patch.expectedRowVersion, c.rowVersion); if (!rv.ok) throw conflict(`Contact ${rv.reason}`);
    const { expectedRowVersion: _e, ...rest } = patch;
    const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<typeof customerContacts.$inferSelect>;
    const changes = diff(c as unknown as Record<string, unknown>, set as Record<string, unknown>);
    if (!Object.keys(changes).length) return { contactRef, rowVersion: c.rowVersion };
    await tx.update(customerContacts).set({ ...set, updatedByUserId: actor.userId, rowVersion: c.rowVersion + 1 }).where(eq(customerContacts.id, c.id));
    if (set.status === "inactive") await tx.update(customerContactRoles).set({ status: "ended", endedAt: at, endedByUserId: actor.userId }).where(and(eq(customerContactRoles.contactId, c.id), eq(customerContactRoles.status, "active")));
    await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "customer_contact", subjectRef: contactRef, subjectId: c.id, eventType: set.status === "inactive" ? "contact_deactivated" : "contact_updated", changes, actor, at });
    return { contactRef, rowVersion: c.rowVersion + 1 };
  });
}
export async function contactRoleSet(s: CommercialScope, actor: Actor, args: { contactRef: string; roleKey: string; isPrimary?: boolean; effectiveFrom?: Date }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = (await tx.select().from(customerContacts).where(and(eq(customerContacts.contactRef, args.contactRef), inScope(s, customerContacts.financialEntityId))).for("update").limit(1))[0];
    if (!c) throw notFound(`Contact ${args.contactRef}`);
    if (c.status !== "active") throw precondition("An inactive contact holds no role");
    const existing = (await tx.select().from(customerContactRoles).where(and(eq(customerContactRoles.contactId, c.id), eq(customerContactRoles.roleKey, args.roleKey), eq(customerContactRoles.status, "active"))).limit(1))[0];
    if (existing) { if (args.isPrimary != null && existing.isPrimary !== args.isPrimary) await tx.update(customerContactRoles).set({ isPrimary: args.isPrimary }).where(eq(customerContactRoles.id, existing.id)); return { roleId: existing.id, created: false }; }
    if (args.isPrimary) await tx.update(customerContactRoles).set({ isPrimary: false }).where(and(eq(customerContactRoles.customerAccountId, c.customerAccountId), eq(customerContactRoles.roleKey, args.roleKey), eq(customerContactRoles.status, "active")));
    const ins = await tx.insert(customerContactRoles).values({ contactId: c.id, customerAccountId: c.customerAccountId, roleKey: args.roleKey, isPrimary: args.isPrimary ?? false, effectiveFrom: args.effectiveFrom ?? at, assignedByUserId: actor.userId });
    await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "customer_contact", subjectRef: c.contactRef, subjectId: c.id, eventType: "contact_role_assigned", changes: { roleKey: { from: null, to: args.roleKey } }, actor, at });
    return { roleId: Number(ins[0]?.insertId ?? 0), created: true };
  });
}
export async function contactRoleEnd(s: CommercialScope, actor: Actor, args: { contactRef: string; roleKey: string; reason?: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = (await tx.select().from(customerContacts).where(and(eq(customerContacts.contactRef, args.contactRef), inScope(s, customerContacts.financialEntityId))).for("update").limit(1))[0];
    if (!c) throw notFound(`Contact ${args.contactRef}`);
    const r = await tx.update(customerContactRoles).set({ status: "ended", endedAt: at, endedByUserId: actor.userId, effectiveTo: at }).where(and(eq(customerContactRoles.contactId, c.id), eq(customerContactRoles.roleKey, args.roleKey), eq(customerContactRoles.status, "active")));
    const ended = Number((r[0] as { affectedRows?: number }).affectedRows ?? 0);
    if (ended) await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "customer_contact", subjectRef: c.contactRef, subjectId: c.id, eventType: "contact_role_ended", changes: { roleKey: { from: args.roleKey, to: null } }, reason: args.reason ?? null, actor, at });
    return { contactRef: c.contactRef, ended };
  });
}
export async function contactsList(s: CommercialScope, customerAccountId: number, d: DbOrTx = s.db) {
  const rows = await d.select().from(customerContacts).where(and(eq(customerContacts.customerAccountId, customerAccountId), inScope(s, customerContacts.financialEntityId))).orderBy(asc(customerContacts.displayName));
  const roles = rows.length ? await d.select().from(customerContactRoles).where(inArray(customerContactRoles.contactId, rows.map(r => r.id))) : [];
  return rows.map(c => ({ ...c, roles: roles.filter(r => r.contactId === c.id).map(r => ({ id: r.id, roleKey: r.roleKey, isPrimary: r.isPrimary, status: r.status, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo })) }));
}

/* ---------------------------------------------------------------- contracts */

export type ContractRow = typeof customerContracts.$inferSelect;
export async function contractInScope(s: CommercialScope, contractRef: string, d: DbOrTx = s.db, lock = false): Promise<ContractRow> {
  const q = d.select().from(customerContracts).where(and(eq(customerContracts.contractRef, contractRef), inScope(s, customerContracts.financialEntityId))).limit(1);
  const c = (lock ? await q.for("update") : await q)[0];
  if (!c) throw notFound(`Contract ${contractRef}`);
  return c;
}
export type ContractInput = { accountRef: string; contractNumber?: string | null; title: string; contractType?: ContractRow["contractType"]; effectiveFrom: Date; effectiveTo?: Date | null; poRequirement?: ContractRow["poRequirement"]; requiredReferenceKinds?: ReferenceKind[]; customerReferences?: Record<string, string> | null; paymentTermsDays?: number | null; billingInstructions?: string | null; notes?: string | null; termsRef?: string | null; renewalKind?: ContractRow["renewalKind"]; renewalNoticeDays?: number | null };

async function termsIdFor(s: CommercialScope, d: DbOrTx, accountId: number, termsRef: string | null | undefined): Promise<number | null> {
  if (!termsRef) return null;
  const t = (await d.select({ id: customerContractTerms.id, customerAccountId: customerContractTerms.customerAccountId }).from(customerContractTerms).where(eq(customerContractTerms.termsRef, termsRef)).limit(1))[0];
  if (!t || t.customerAccountId !== accountId) throw notFound(`Contract terms ${termsRef}`);
  return t.id;
}
export async function contractCreate(s: CommercialScope, actor: Actor, input: ContractInput, at = new Date()) {
  const a = await accountInScope(s, input.accountRef);
  if (a.archivedAt) throw precondition("An archived customer takes no new contract");
  if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) throw bad("The contract ends before it begins");
  const contractNumber = input.contractNumber?.trim() || (await nextTrackingNumber(s.db, { sequenceType: "CON" })).trackingNumber;
  const contractRef = ref("CTR");
  return s.db.transaction(async tx => {
    const dup = (await tx.select({ id: customerContracts.id }).from(customerContracts).where(and(eq(customerContracts.financialEntityId, a.financialEntityId), eq(customerContracts.contractNumber, contractNumber))).limit(1))[0];
    if (dup) throw conflict(`Contract number ${contractNumber} already exists in this entity`);
    const termsId = await termsIdFor(s, tx, a.id, input.termsRef);
    const ins = await tx.insert(customerContracts).values({ contractRef, financialEntityId: a.financialEntityId, customerAccountId: a.id, contractNumber, title: input.title, contractType: input.contractType ?? "msa", effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, poRequirement: input.poRequirement ?? "inherit", requiredReferenceKindsJson: input.requiredReferenceKinds?.length ? JSON.stringify(input.requiredReferenceKinds) : null, customerReferencesJson: input.customerReferences ? JSON.stringify(input.customerReferences) : null, paymentTermsDays: input.paymentTermsDays ?? null, billingInstructions: input.billingInstructions ?? null, notes: input.notes ?? null, termsId, renewalKind: input.renewalKind ?? "manual", renewalNoticeDays: input.renewalNoticeDays ?? null, createdByUserId: actor.userId, updatedByUserId: actor.userId });
    const id = Number(ins[0]?.insertId ?? 0);
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "customer_contract", subjectRef: contractRef, subjectId: id, eventType: "contract_created", toStatus: "draft", relatedRef: a.accountRef, changes: { contractNumber: { from: null, to: contractNumber }, title: { from: null, to: input.title } }, actor, at });
    return { id, contractRef, contractNumber, status: "draft" as const };
  });
}
export async function contractUpdate(s: CommercialScope, actor: Actor, contractRef: string, patch: Partial<Omit<ContractInput, "accountRef">> & { expectedRowVersion?: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = await contractInScope(s, contractRef, tx, true);
    const rv = rowVersionCheck(patch.expectedRowVersion, c.rowVersion); if (!rv.ok) throw conflict(`Contract ${rv.reason}`);
    if (!CONTRACT_EDITABLE_STATUSES.includes(c.status)) throw precondition(`A ${c.status} contract is not edited; supersede it with a new version`);
    if (c.usedOperationallyAt) throw precondition("A contract a job has snapshotted is frozen; supersede it");
    const set: Partial<ContractRow> = {};
    if (patch.contractNumber !== undefined && patch.contractNumber) set.contractNumber = patch.contractNumber;
    if (patch.title !== undefined) set.title = patch.title; if (patch.contractType !== undefined) set.contractType = patch.contractType;
    if (patch.effectiveFrom !== undefined) set.effectiveFrom = patch.effectiveFrom; if (patch.effectiveTo !== undefined) set.effectiveTo = patch.effectiveTo;
    if (patch.poRequirement !== undefined) set.poRequirement = patch.poRequirement;
    if (patch.requiredReferenceKinds !== undefined) set.requiredReferenceKindsJson = patch.requiredReferenceKinds?.length ? JSON.stringify(patch.requiredReferenceKinds) : null;
    if (patch.customerReferences !== undefined) set.customerReferencesJson = patch.customerReferences ? JSON.stringify(patch.customerReferences) : null;
    if (patch.paymentTermsDays !== undefined) set.paymentTermsDays = patch.paymentTermsDays; if (patch.billingInstructions !== undefined) set.billingInstructions = patch.billingInstructions; if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.termsRef !== undefined) set.termsId = await termsIdFor(s, tx, c.customerAccountId, patch.termsRef);
    if (patch.renewalKind !== undefined) set.renewalKind = patch.renewalKind; if (patch.renewalNoticeDays !== undefined) set.renewalNoticeDays = patch.renewalNoticeDays;
    const from = set.effectiveFrom ?? c.effectiveFrom, to = set.effectiveTo === undefined ? c.effectiveTo : set.effectiveTo;
    if (to && to.getTime() <= from.getTime()) throw bad("The contract ends before it begins");
    const changes = diff(c as unknown as Record<string, unknown>, set as Record<string, unknown>);
    if (!Object.keys(changes).length) return { contractRef, rowVersion: c.rowVersion };
    await tx.update(customerContracts).set({ ...set, updatedByUserId: actor.userId, rowVersion: c.rowVersion + 1 }).where(eq(customerContracts.id, c.id));
    await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "customer_contract", subjectRef: contractRef, subjectId: c.id, eventType: "contract_updated", changes, actor, at });
    return { contractRef, rowVersion: c.rowVersion + 1 };
  });
}

/** One door for every contract status change. The transition table decides; separation of duties on approval. */
export async function contractTransitionApply(s: CommercialScope, actor: Actor, args: { contractRef: string; event: ContractEvent; reason?: string; expectedRowVersion?: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = await contractInScope(s, args.contractRef, tx, true);
    const rv = rowVersionCheck(args.expectedRowVersion, c.rowVersion); if (!rv.ok) throw conflict(`Contract ${rv.reason}`);
    const t = contractTransition(c.status, args.event);
    if (!t.ok) throw precondition(t.reason);
    if (args.event === "supersede") throw bad("A contract is superseded by approving the version that replaces it (contractSupersede), not directly");
    const set: Partial<ContractRow> = { rowVersion: c.rowVersion + 1, updatedByUserId: actor.userId, status: t.to };
    let eventType = `contract_${args.event}`;
    switch (args.event) {
      case "submit": set.submittedByUserId = actor.userId; set.submittedAt = at; break;
      case "approve": {
        if (c.submittedByUserId === actor.userId || c.createdByUserId === actor.userId) throw forbidden("The person who drafted or submitted a contract does not approve it — a second person does");
        if (c.effectiveTo && c.effectiveTo.getTime() <= at.getTime()) throw precondition("This contract's window has already closed; it cannot be activated");
        set.approvedByUserId = actor.userId; set.approvedAt = at; set.approvalNote = args.reason ?? null; set.activatedAt = at;
        if (c.supersedesContractId) {
          const prior = (await tx.select().from(customerContracts).where(eq(customerContracts.id, c.supersedesContractId)).for("update").limit(1))[0];
          if (prior && (prior.status === "active" || prior.status === "suspended" || prior.status === "expired")) {
            const pt = contractTransition(prior.status, "supersede"); if (!pt.ok) throw precondition(pt.reason);
            await tx.update(customerContracts).set({ status: "superseded", supersededByContractId: c.id, effectiveTo: prior.effectiveTo && prior.effectiveTo.getTime() < c.effectiveFrom.getTime() ? prior.effectiveTo : c.effectiveFrom, rowVersion: prior.rowVersion + 1, updatedByUserId: actor.userId }).where(eq(customerContracts.id, prior.id));
            await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "customer_contract", subjectRef: prior.contractRef, subjectId: prior.id, eventType: "contract_superseded", fromStatus: prior.status, toStatus: "superseded", relatedRef: c.contractRef, actor, at });
            await emit(tx, { tenantId: s.tenantId, type: "commercial.contract_superseded", entityType: "customerContract", entityId: prior.contractRef, actor, payload: { contractRef: prior.contractRef, supersededBy: c.contractRef }, at });
          }
        }
        eventType = "contract_approved"; break;
      }
      case "reject": if (!args.reason) throw bad("A rejection names its reason"); set.approvalNote = args.reason; set.submittedByUserId = null; set.submittedAt = null; break;
      case "suspend": if (!args.reason) throw bad("A suspension names its reason"); set.suspendedAt = at; set.suspendedByUserId = actor.userId; set.suspensionReason = args.reason; break;
      case "resume": set.suspendedAt = null; set.suspendedByUserId = null; set.suspensionReason = null; break;
      case "terminate": if (!args.reason) throw bad("A termination names its reason"); set.terminatedAt = at; set.terminatedByUserId = actor.userId; set.terminationReason = args.reason; break;
      case "expire": set.expiredAt = at; break;
    }
    await tx.update(customerContracts).set(set).where(eq(customerContracts.id, c.id));
    await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "customer_contract", subjectRef: c.contractRef, subjectId: c.id, eventType, fromStatus: c.status, toStatus: t.to, reason: args.reason ?? null, actor, at });
    const evt = args.event === "approve" ? "commercial.contract_activated" : args.event === "suspend" ? "commercial.contract_suspended" : args.event === "terminate" ? "commercial.contract_terminated" : args.event === "expire" ? "commercial.contract_expired" : null;
    if (evt) await emit(tx, { tenantId: s.tenantId, type: evt, entityType: "customerContract", entityId: c.contractRef, actor, payload: { contractRef: c.contractRef, contractNumber: c.contractNumber, accountId: c.customerAccountId, reason: args.reason ?? null }, at });
    return { contractRef: c.contractRef, status: t.to, rowVersion: c.rowVersion + 1 };
  });
}

/** A new version of a contract: a draft copy that names what it supersedes. The old one stays in force until the new one is approved. */
export async function contractSupersede(s: CommercialScope, actor: Actor, args: { contractRef: string; changes?: Partial<Omit<ContractInput, "accountRef">>; reason: string }, at = new Date()) {
  return s.db.transaction(async tx => {
    const c = await contractInScope(s, args.contractRef, tx, true);
    if (!["active", "suspended", "expired"].includes(c.status)) throw precondition(`A ${c.status} contract is not superseded`);
    const open = (await tx.select({ id: customerContracts.id }).from(customerContracts).where(and(eq(customerContracts.supersedesContractId, c.id), inArray(customerContracts.status, ["draft", "pending_approval"]))).limit(1))[0];
    if (open) throw conflict("A replacement for this contract is already drafted; approve or reject it first");
    const ch = args.changes ?? {};
    const contractRef = ref("CTR");
    const number = ch.contractNumber?.trim() || `${c.contractNumber}`;
    const ins = await tx.insert(customerContracts).values({
      contractRef, financialEntityId: c.financialEntityId, customerAccountId: c.customerAccountId,
      contractNumber: number === c.contractNumber ? `${c.contractNumber}/v${c.version + 1}` : number,
      title: ch.title ?? c.title, contractType: ch.contractType ?? c.contractType, effectiveFrom: ch.effectiveFrom ?? at, effectiveTo: ch.effectiveTo === undefined ? c.effectiveTo : ch.effectiveTo,
      poRequirement: ch.poRequirement ?? c.poRequirement, requiredReferenceKindsJson: ch.requiredReferenceKinds !== undefined ? (ch.requiredReferenceKinds?.length ? JSON.stringify(ch.requiredReferenceKinds) : null) : c.requiredReferenceKindsJson,
      customerReferencesJson: ch.customerReferences !== undefined ? (ch.customerReferences ? JSON.stringify(ch.customerReferences) : null) : c.customerReferencesJson,
      paymentTermsDays: ch.paymentTermsDays !== undefined ? ch.paymentTermsDays : c.paymentTermsDays, billingInstructions: ch.billingInstructions !== undefined ? ch.billingInstructions : c.billingInstructions, notes: ch.notes !== undefined ? ch.notes : c.notes,
      termsId: ch.termsRef !== undefined ? await termsIdFor(s, tx, c.customerAccountId, ch.termsRef) : c.termsId, renewalKind: ch.renewalKind ?? c.renewalKind, renewalNoticeDays: ch.renewalNoticeDays !== undefined ? ch.renewalNoticeDays : c.renewalNoticeDays,
      version: c.version + 1, supersedesContractId: c.id, createdByUserId: actor.userId, updatedByUserId: actor.userId,
    });
    const id = Number(ins[0]?.insertId ?? 0);
    await audit(tx, { financialEntityId: c.financialEntityId, subjectType: "customer_contract", subjectRef: contractRef, subjectId: id, eventType: "contract_version_drafted", toStatus: "draft", relatedRef: c.contractRef, reason: args.reason, actor, at });
    return { contractRef, version: c.version + 1, supersedes: c.contractRef, status: "draft" as const };
  });
}
export function contractView(c: ContractRow) {
  return { ...c, requiredReferenceKinds: parseJson<string[]>(c.requiredReferenceKindsJson, []), customerReferences: parseJson<Record<string, string>>(c.customerReferencesJson, {}) };
}
export async function contractsListForAccount(s: CommercialScope, customerAccountId: number) {
  return (await s.db.select().from(customerContracts).where(and(eq(customerContracts.customerAccountId, customerAccountId), inScope(s, customerContracts.financialEntityId))).orderBy(desc(customerContracts.id))).map(contractView);
}
export async function contractsList(s: CommercialScope, f: { status?: ContractStatus; expiringWithinDays?: number; q?: string; limit?: number }) {
  const where = [inScope(s, customerContracts.financialEntityId)];
  if (f.status) where.push(eq(customerContracts.status, f.status));
  if (f.q?.trim()) { const q = `%${f.q.trim()}%`; where.push(or(like(customerContracts.contractNumber, q), like(customerContracts.title, q))!); }
  const rows = (await s.db.select().from(customerContracts).where(and(...where)).orderBy(desc(customerContracts.id)).limit(Math.min(f.limit ?? 200, 500))).map(contractView);
  if (f.expiringWithinDays == null) return rows;
  const horizon = Date.now() + f.expiringWithinDays * 86_400_000;
  return rows.filter(c => c.effectiveTo && c.effectiveTo.getTime() <= horizon && c.effectiveTo.getTime() >= Date.now());
}
export async function contractGet(s: CommercialScope, contractRef: string) {
  const c = await contractInScope(s, contractRef);
  const account = await accountByIdInScope(s, c.customerAccountId);
  const [sheets, docs, snaps, terms, lineage] = await Promise.all([
    s.db.select().from(rateSheets).where(eq(rateSheets.contractId, c.id)),
    documentsFor("customer_contract", c.contractRef, s.db),
    s.db.select({ snapshotRef: jobCommercialSnapshots.snapshotRef, jobId: jobCommercialSnapshots.jobId, status: jobCommercialSnapshots.status, capturedAt: jobCommercialSnapshots.capturedAt }).from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.contractId, c.id)).orderBy(desc(jobCommercialSnapshots.id)).limit(200),
    c.termsId ? s.db.select({ termsRef: customerContractTerms.termsRef, version: customerContractTerms.version, title: customerContractTerms.title, status: customerContractTerms.status }).from(customerContractTerms).where(eq(customerContractTerms.id, c.termsId)).limit(1) : Promise.resolve([]),
    s.db.select({ id: customerContracts.id, contractRef: customerContracts.contractRef, version: customerContracts.version, status: customerContracts.status, effectiveFrom: customerContracts.effectiveFrom, effectiveTo: customerContracts.effectiveTo }).from(customerContracts).where(or(eq(customerContracts.id, c.supersedesContractId ?? -1), eq(customerContracts.supersedesContractId, c.id), eq(customerContracts.id, c.supersededByContractId ?? -1))!),
  ]);
  const jobIds = Array.from(new Set(snaps.map(x => x.jobId)));
  const jobRows = jobIds.length ? await s.db.select({ id: jobs.id, jobCode: jobs.jobCode, status: jobs.status }).from(jobs).where(inArray(jobs.id, jobIds)) : [];
  const jobById = new Map(jobRows.map(j => [j.id, j]));
  const history = await auditHistory(s, "customer_contract", c.contractRef);
  return { ...contractView(c), customer: { accountRef: account.accountRef, name: account.name, customerNumber: account.customerNumber }, terms: terms[0] ?? null, rateSheets: sheets, documents: docs, jobs: snaps.map(x => ({ ...x, job: jobById.get(x.jobId) ?? null })), lineage, history, renewal: renewalStatus(c) };
}
export function renewalStatus(c: { effectiveTo: Date | null; renewalKind: string; renewalNoticeDays: number | null; status: string }, now = new Date()) {
  if (!c.effectiveTo) return { state: "open_ended" as const, daysRemaining: null, noticeDue: null };
  const days = Math.ceil((c.effectiveTo.getTime() - now.getTime()) / 86_400_000);
  const noticeDue = c.renewalNoticeDays != null ? new Date(c.effectiveTo.getTime() - c.renewalNoticeDays * 86_400_000) : null;
  const state = days < 0 ? "expired" : noticeDue && now.getTime() >= noticeDue.getTime() ? "notice_period" : "in_term";
  return { state, daysRemaining: days, noticeDue };
}
export async function documentsFor(recordType: string, recordRef: string, d: DbOrTx) {
  const links = await d.select().from(commercialDocumentLinks).where(and(eq(commercialDocumentLinks.recordType, recordType), eq(commercialDocumentLinks.recordRef, recordRef)));
  if (!links.length) return [];
  const docs = await d.select().from(commercialDocuments).where(inArray(commercialDocuments.id, links.map(l => l.documentId)));
  return docs.map(x => ({ documentRef: x.documentRef, documentType: x.documentType, title: x.title, version: x.version, status: x.status, contentHash: x.contentHash, registeredAt: x.registeredAt, registeredByUserId: x.registeredByUserId, evidenceRecordId: x.evidenceRecordId, storageKey: x.storageKey != null }));
}

/* ---------------------------------------------------------------- rate sheets */

export type SheetRow = typeof rateSheets.$inferSelect;
export type VersionRowFull = typeof rateSheetVersions.$inferSelect;
export async function sheetInScope(s: CommercialScope, rateSheetRef: string, d: DbOrTx = s.db, lock = false): Promise<SheetRow> {
  const q = d.select().from(rateSheets).where(and(eq(rateSheets.rateSheetRef, rateSheetRef), inScope(s, rateSheets.financialEntityId))).limit(1);
  const r = (lock ? await q.for("update") : await q)[0];
  if (!r) throw notFound(`Rate sheet ${rateSheetRef}`);
  return r;
}
export async function versionInScope(s: CommercialScope, versionRef: string, d: DbOrTx = s.db, lock = false): Promise<VersionRowFull> {
  const q = d.select().from(rateSheetVersions).where(and(eq(rateSheetVersions.versionRef, versionRef), inScope(s, rateSheetVersions.financialEntityId))).limit(1);
  const r = (lock ? await q.for("update") : await q)[0];
  if (!r) throw notFound(`Rate sheet version ${versionRef}`);
  return r;
}

export async function rateSheetCreate(s: CommercialScope, actor: Actor, input: { accountRef: string; contractRef?: string | null; name: string; sheetNumber?: string | null; currency?: string; notes?: string | null; effectiveFrom: Date; effectiveTo?: Date | null }, at = new Date()) {
  const a = await accountInScope(s, input.accountRef);
  if (a.archivedAt) throw precondition("An archived customer takes no new rate sheet");
  const contract = input.contractRef ? await contractInScope(s, input.contractRef) : null;
  if (contract && contract.customerAccountId !== a.id) throw bad("The contract belongs to a different customer");
  if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) throw bad("The version ends before it begins");
  const sheetNumber = input.sheetNumber?.trim() || (await nextTrackingNumber(s.db, { sequenceType: "RSHT" })).trackingNumber;
  const rateSheetRef = ref("RSH"), versionRef = ref("RSV");
  return s.db.transaction(async tx => {
    const dup = (await tx.select({ id: rateSheets.id }).from(rateSheets).where(and(eq(rateSheets.financialEntityId, a.financialEntityId), eq(rateSheets.sheetNumber, sheetNumber))).limit(1))[0];
    if (dup) throw conflict(`Rate sheet number ${sheetNumber} already exists in this entity`);
    const ins = await tx.insert(rateSheets).values({ rateSheetRef, financialEntityId: a.financialEntityId, customerAccountId: a.id, contractId: contract?.id ?? null, name: input.name, sheetNumber, currency: input.currency ?? a.defaultCurrency, notes: input.notes ?? null, createdByUserId: actor.userId, updatedByUserId: actor.userId });
    const sheetId = Number(ins[0]?.insertId ?? 0);
    const vins = await tx.insert(rateSheetVersions).values({ versionRef, rateSheetId: sheetId, financialEntityId: a.financialEntityId, version: 1, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, createdByUserId: actor.userId });
    const versionId = Number(vins[0]?.insertId ?? 0);
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "rate_sheet", subjectRef: rateSheetRef, subjectId: sheetId, eventType: "rate_sheet_created", relatedRef: a.accountRef, changes: { name: { from: null, to: input.name }, sheetNumber: { from: null, to: sheetNumber }, contract: { from: null, to: contract?.contractRef ?? null } }, actor, at });
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "rate_sheet_version", subjectRef: versionRef, subjectId: versionId, eventType: "version_drafted", toStatus: "draft", relatedRef: rateSheetRef, actor, at });
    return { rateSheetRef, sheetNumber, versionRef, version: 1 };
  });
}

/** A new draft version, its lines copied from the version it will supersede (so a correction edits one line, not thirty). */
export async function rateSheetVersionCreate(s: CommercialScope, actor: Actor, input: { rateSheetRef: string; effectiveFrom: Date; effectiveTo?: Date | null; copyFromVersionRef?: string | null; notes?: string | null }, at = new Date()) {
  return s.db.transaction(async tx => {
    const sheet = await sheetInScope(s, input.rateSheetRef, tx, true);
    if (sheet.status !== "active") throw precondition("A retired sheet takes no new version");
    if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) throw bad("The version ends before it begins");
    const versions = await tx.select().from(rateSheetVersions).where(eq(rateSheetVersions.rateSheetId, sheet.id)).for("update");
    if (versions.some(v => v.status === "draft" || v.status === "pending_approval")) throw conflict("This sheet already has a version in draft or awaiting approval; approve or reject it first");
    const latestApproved = versions.filter(v => v.status === "approved").sort((x, y) => y.version - x.version)[0] ?? null;
    if (latestApproved) { const w = supersessionWindow(latestApproved, { effectiveFrom: input.effectiveFrom }); if (!w.ok) throw bad(w.reason); }
    const copyFrom = input.copyFromVersionRef ? versions.find(v => v.versionRef === input.copyFromVersionRef) ?? null : latestApproved;
    if (input.copyFromVersionRef && !copyFrom) throw notFound(`Rate sheet version ${input.copyFromVersionRef}`);
    const version = Math.max(0, ...versions.map(v => v.version)) + 1;
    const versionRef = ref("RSV");
    const vins = await tx.insert(rateSheetVersions).values({ versionRef, rateSheetId: sheet.id, financialEntityId: sheet.financialEntityId, version, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, notes: input.notes ?? null, supersedesVersionId: latestApproved?.id ?? null, createdByUserId: actor.userId });
    const versionId = Number(vins[0]?.insertId ?? 0);
    let copied = 0;
    if (copyFrom) {
      const lines = await tx.select().from(chargeDefinitions).where(and(eq(chargeDefinitions.rateSheetVersionId, copyFrom.id), inArray(chargeDefinitions.approvalStatus, ["approved", "superseded", "proposed"]))).orderBy(asc(chargeDefinitions.lineNo));
      for (const l of lines) {
        const { id: _id, definitionRef: _r, approvalStatus: _s, approvedAt: _a, approvedByUserId: _b, supersedesDefinitionId: _sd, supersededByDefinitionId: _sb, createdAt: _c, proposedAt: _p, rejectionReason: _rr, version: _v, ...rest } = l;
        await tx.insert(chargeDefinitions).values({ ...rest, definitionRef: ref("CHG"), rateSheetVersionId: versionId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, approvalStatus: "proposed", proposedByUserId: actor.userId, supersedesDefinitionId: l.id, version: 1 });
        copied++;
      }
    }
    await audit(tx, { financialEntityId: sheet.financialEntityId, subjectType: "rate_sheet_version", subjectRef: versionRef, subjectId: versionId, eventType: "version_drafted", toStatus: "draft", relatedRef: sheet.rateSheetRef, changes: { copiedFrom: { from: null, to: copyFrom?.versionRef ?? null }, linesCopied: { from: null, to: copied } }, actor, at });
    return { versionRef, version, linesCopied: copied, supersedes: latestApproved?.versionRef ?? null };
  });
}

export type LineInput = {
  serviceCode: string; lineKind: string; label?: string | null; rateKind?: "sell" | "vendor_payable" | "payroll_reference" | "internal_cost"; pricingMethod: ChargeDefinition["pricingMethod"]; unit: ChargeDefinition["unit"];
  rateMillis?: number | null; flatCents?: number | null; basisPoints?: number | null; multiplierMillis?: number | null; formula?: string | null;
  minimumQuantityMillis?: number | null; minimumChargeCents?: number | null; billingIncrementMillis?: number | null; roundingMode?: "nearest" | "up" | "down"; measurementBasis?: ChargeDefinition["measurementBasis"];
  conditionKey?: string | null; resourceClass?: string | null; unitId?: number | null; siteRef?: string | null; projectRef?: string | null; branchCode?: string | null;
  applicability?: unknown[] | null; sourceKind?: "human" | "ai_extracted" | "imported" | "negotiated"; sourceDocumentEvidenceId?: number | null; sourceClause?: string | null; notes?: string | null; vendorRef?: string | null;
};
function validateLine(l: LineInput) {
  if (!isRateLineKind(l.lineKind)) throw bad(`Unknown rate line kind ${l.lineKind}`);
  if (l.pricingMethod === "per_unit" && l.rateMillis == null) throw bad("A per-unit line carries a rate; without one it is a question, not a rate");
  if (l.pricingMethod === "flat" && l.flatCents == null) throw bad("A flat line carries an amount");
  if (l.pricingMethod === "percentage_markup" && l.basisPoints == null) throw bad("A percentage line carries basis points");
  if ((l.sourceKind === "ai_extracted" || l.sourceKind === "imported") && l.sourceDocumentEvidenceId == null) throw bad("An extracted or imported rate names the source document it was read from");
  if (l.applicability != null) { const p = parseConditions(JSON.stringify(l.applicability)); if (!p.ok) throw bad(`Applicability: ${p.error}`); }
  for (const k of ["rateMillis", "flatCents", "basisPoints", "multiplierMillis", "minimumChargeCents"] as const) { const v = l[k]; if (v != null && !Number.isInteger(v)) throw bad(`${k} is an integer (minor units / thousandths / basis points), never a float`); }
}
async function versionEditable(s: CommercialScope, tx: DbOrTx, versionRef: string) {
  const v = await versionInScope(s, versionRef, tx, true);
  if (!VERSION_LINE_EDITABLE.includes(v.status)) throw precondition(`Lines on a ${v.status} version are history; draft a new version`);
  const sheet = (await tx.select().from(rateSheets).where(eq(rateSheets.id, v.rateSheetId)).limit(1))[0]!;
  const contract = sheet.contractId ? (await tx.select({ contractRef: customerContracts.contractRef }).from(customerContracts).where(eq(customerContracts.id, sheet.contractId)).limit(1))[0] ?? null : null;
  return { v, sheet, contract };
}
export async function rateLineAdd(s: CommercialScope, actor: Actor, versionRef: string, l: LineInput, at = new Date()) {
  validateLine(l);
  return s.db.transaction(async tx => {
    const { v, sheet, contract } = await versionEditable(s, tx, versionRef);
    const maxNo = (await tx.select({ n: sql<number>`COALESCE(MAX(${chargeDefinitions.lineNo}), 0)` }).from(chargeDefinitions).where(eq(chargeDefinitions.rateSheetVersionId, v.id)))[0]?.n ?? 0;
    const definitionRef = ref("CHG");
    const ins = await tx.insert(chargeDefinitions).values({
      definitionRef, financialEntityId: sheet.financialEntityId, rateKind: l.rateKind ?? "sell", serviceCode: l.serviceCode, resourceClass: l.resourceClass ?? null, unitId: l.unitId ?? null,
      pricingMethod: l.pricingMethod, unit: l.unit, rateMillis: l.rateMillis ?? null, flatCents: l.flatCents ?? null, basisPoints: l.basisPoints ?? null, multiplierMillis: l.multiplierMillis ?? null, formula: l.formula ?? null,
      minimumQuantityMillis: l.minimumQuantityMillis ?? null, minimumChargeCents: l.minimumChargeCents ?? null, billingIncrementMillis: l.billingIncrementMillis ?? null, roundingMode: l.roundingMode ?? "nearest", measurementBasis: l.measurementBasis ?? "any", conditionKey: l.conditionKey ?? null,
      scopeLevel: contract ? "customer_contract" : "customer_rate_card", customerAccountId: sheet.customerAccountId, vendorId: null, projectRef: l.projectRef ?? null, siteRef: l.siteRef ?? null, contractRef: contract?.contractRef ?? null, jobId: null, branchCode: l.branchCode ?? null,
      currency: sheet.currency, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo, sourceKind: l.sourceKind ?? "human", sourceDocumentEvidenceId: l.sourceDocumentEvidenceId ?? null, sourceClause: l.sourceClause ?? null,
      approvalStatus: "proposed", proposedByUserId: actor.userId, notes: l.notes ?? null, rateSheetVersionId: v.id, lineNo: Number(maxNo) + 1, lineKind: l.lineKind, label: l.label ?? null, applicabilityJson: l.applicability?.length ? JSON.stringify(l.applicability) : null,
    });
    const id = Number(ins[0]?.insertId ?? 0);
    await audit(tx, { financialEntityId: sheet.financialEntityId, subjectType: "rate_line", subjectRef: definitionRef, subjectId: id, eventType: "line_added", relatedRef: v.versionRef, changes: { serviceCode: { from: null, to: l.serviceCode }, lineKind: { from: null, to: l.lineKind }, rateMillis: { from: null, to: l.rateMillis ?? null }, flatCents: { from: null, to: l.flatCents ?? null } }, actor, at });
    return { definitionRef, lineNo: Number(maxNo) + 1 };
  });
}
export async function rateLineUpdate(s: CommercialScope, actor: Actor, definitionRef: string, patch: Partial<LineInput>, at = new Date()) {
  return s.db.transaction(async tx => {
    const d = (await tx.select().from(chargeDefinitions).where(and(eq(chargeDefinitions.definitionRef, definitionRef), inScope(s, chargeDefinitions.financialEntityId))).for("update").limit(1))[0];
    if (!d || d.rateSheetVersionId == null) throw notFound(`Rate line ${definitionRef}`);
    const version = (await tx.select().from(rateSheetVersions).where(eq(rateSheetVersions.id, d.rateSheetVersionId)).for("update").limit(1))[0]!;
    if (!VERSION_LINE_EDITABLE.includes(version.status)) throw precondition(`Lines on a ${version.status} version are history; draft a new version`);
    const merged: LineInput = { serviceCode: patch.serviceCode ?? d.serviceCode, lineKind: patch.lineKind ?? d.lineKind ?? "misc", pricingMethod: patch.pricingMethod ?? d.pricingMethod, unit: patch.unit ?? d.unit, rateMillis: patch.rateMillis !== undefined ? patch.rateMillis : d.rateMillis, flatCents: patch.flatCents !== undefined ? patch.flatCents : d.flatCents, basisPoints: patch.basisPoints !== undefined ? patch.basisPoints : d.basisPoints, multiplierMillis: patch.multiplierMillis !== undefined ? patch.multiplierMillis : d.multiplierMillis, minimumChargeCents: patch.minimumChargeCents !== undefined ? patch.minimumChargeCents : d.minimumChargeCents, sourceKind: patch.sourceKind ?? d.sourceKind, sourceDocumentEvidenceId: patch.sourceDocumentEvidenceId !== undefined ? patch.sourceDocumentEvidenceId : d.sourceDocumentEvidenceId, applicability: patch.applicability !== undefined ? patch.applicability : parseJson<unknown[] | null>(d.applicabilityJson, null) };
    validateLine(merged);
    const set: Partial<typeof chargeDefinitions.$inferSelect> = {};
    for (const k of ["serviceCode", "lineKind", "label", "pricingMethod", "unit", "rateMillis", "flatCents", "basisPoints", "multiplierMillis", "formula", "minimumQuantityMillis", "minimumChargeCents", "billingIncrementMillis", "roundingMode", "measurementBasis", "conditionKey", "resourceClass", "unitId", "siteRef", "projectRef", "branchCode", "sourceKind", "sourceDocumentEvidenceId", "sourceClause", "notes"] as const) {
      const v = patch[k]; if (v !== undefined) (set as Record<string, unknown>)[k] = v;
    }
    if (patch.applicability !== undefined) set.applicabilityJson = patch.applicability?.length ? JSON.stringify(patch.applicability) : null;
    const changes = diff(d as unknown as Record<string, unknown>, set as Record<string, unknown>);
    if (!Object.keys(changes).length) return { definitionRef, changed: 0 };
    await tx.update(chargeDefinitions).set(set).where(eq(chargeDefinitions.id, d.id));
    await audit(tx, { financialEntityId: d.financialEntityId, subjectType: "rate_line", subjectRef: definitionRef, subjectId: d.id, eventType: "line_updated", relatedRef: version.versionRef, changes, actor, at });
    return { definitionRef, changed: Object.keys(changes).length };
  });
}
export async function rateLineRemove(s: CommercialScope, actor: Actor, definitionRef: string, at = new Date()) {
  return s.db.transaction(async tx => {
    const d = (await tx.select().from(chargeDefinitions).where(and(eq(chargeDefinitions.definitionRef, definitionRef), inScope(s, chargeDefinitions.financialEntityId))).for("update").limit(1))[0];
    if (!d || d.rateSheetVersionId == null) throw notFound(`Rate line ${definitionRef}`);
    const version = (await tx.select().from(rateSheetVersions).where(eq(rateSheetVersions.id, d.rateSheetVersionId)).for("update").limit(1))[0]!;
    if (!VERSION_LINE_EDITABLE.includes(version.status)) throw precondition("A line on an approved version is history and is never removed; draft a new version without it");
    // A draft line was never in force; removing it removes nothing from history. The ledger still records that it was there.
    await tx.delete(chargeDefinitions).where(eq(chargeDefinitions.id, d.id));
    await audit(tx, { financialEntityId: d.financialEntityId, subjectType: "rate_line", subjectRef: definitionRef, subjectId: d.id, eventType: "line_removed_from_draft", relatedRef: version.versionRef, changes: { serviceCode: { from: d.serviceCode, to: null }, rateMillis: { from: d.rateMillis, to: null } }, actor, at });
    return { definitionRef, removed: true };
  });
}

const lineHashView = (l: typeof chargeDefinitions.$inferSelect) => ({ lineNo: l.lineNo, serviceCode: l.serviceCode, lineKind: l.lineKind, pricingMethod: l.pricingMethod, unit: l.unit, rateMillis: l.rateMillis, flatCents: l.flatCents, basisPoints: l.basisPoints, multiplierMillis: l.multiplierMillis, minimumQuantityMillis: l.minimumQuantityMillis, minimumChargeCents: l.minimumChargeCents, billingIncrementMillis: l.billingIncrementMillis, roundingMode: l.roundingMode, measurementBasis: l.measurementBasis, conditionKey: l.conditionKey, applicabilityJson: l.applicabilityJson, resourceClass: l.resourceClass, unitId: l.unitId, effectiveFrom: l.effectiveFrom, effectiveTo: l.effectiveTo });

/** One door for version status changes. Approval is a second person's, approves every line at once, and supersedes the prior approved version in the same transaction. */
export async function rateSheetVersionTransition(s: CommercialScope, actor: Actor, args: { versionRef: string; event: "submit" | "approve" | "reject" | "reopen" | "retire"; reason?: string; expectedRowVersion?: number }, at = new Date()) {
  return s.db.transaction(async tx => {
    const v = await versionInScope(s, args.versionRef, tx, true);
    const rv = rowVersionCheck(args.expectedRowVersion, v.rowVersion); if (!rv.ok) throw conflict(`Rate sheet version ${rv.reason}`);
    const t = versionTransition(v.status, args.event);
    if (!t.ok) throw precondition(t.reason);
    const sheet = (await tx.select().from(rateSheets).where(eq(rateSheets.id, v.rateSheetId)).for("update").limit(1))[0]!;
    const lines = await tx.select().from(chargeDefinitions).where(eq(chargeDefinitions.rateSheetVersionId, v.id)).for("update");
    const set: Partial<VersionRowFull> = { status: t.to, rowVersion: v.rowVersion + 1 };
    let supersededRef: string | null = null;
    if (args.event === "submit") { if (!lines.length) throw precondition("A version with no lines is not submitted"); set.submittedByUserId = actor.userId; set.submittedAt = at; }
    if (args.event === "reject") { if (!args.reason) throw bad("A rejection names its reason"); set.rejectedByUserId = actor.userId; set.rejectedAt = at; set.rejectionReason = args.reason; }
    if (args.event === "reopen") { set.rejectedByUserId = null; set.rejectedAt = null; set.rejectionReason = null; set.submittedByUserId = null; set.submittedAt = null; }
    if (args.event === "retire") { if (v.usedOperationallyAt) throw precondition("A version a job has snapshotted is not retired; it prices its own window. Supersede it."); if (!args.reason) throw bad("Retirement names its reason"); await tx.update(chargeDefinitions).set({ approvalStatus: "rejected", rejectionReason: `retired with version: ${args.reason}` }).where(eq(chargeDefinitions.rateSheetVersionId, v.id)); }
    if (args.event === "approve") {
      if (v.submittedByUserId === actor.userId || v.createdByUserId === actor.userId) throw forbidden("The person who drafted or submitted a rate sheet version does not approve it — a second person does");
      if (lines.some(l => l.proposedByUserId === actor.userId && lines.length === 1)) throw forbidden("The person who proposed the only line does not approve it — a second person does");
      // The version's window is the lines' window; the lines say so.
      for (const l of lines) if (l.effectiveFrom.getTime() !== v.effectiveFrom.getTime()) await tx.update(chargeDefinitions).set({ effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo }).where(eq(chargeDefinitions.id, l.id));
      const prior = (await tx.select().from(rateSheetVersions).where(and(eq(rateSheetVersions.rateSheetId, sheet.id), eq(rateSheetVersions.status, "approved"))).for("update"));
      if (prior.length > 1) throw precondition("This sheet has more than one approved version at once — a data fault a person resolves before approving another");
      const p = prior[0] ?? null;
      if (p) {
        const w = supersessionWindow(p, { effectiveFrom: v.effectiveFrom }); if (!w.ok) throw precondition(w.reason);
        const priorLines = await tx.select().from(chargeDefinitions).where(eq(chargeDefinitions.rateSheetVersionId, p.id)).for("update");
        await tx.update(rateSheetVersions).set({ status: "superseded", supersededByVersionId: v.id, effectiveTo: w.priorEffectiveTo, rowVersion: p.rowVersion + 1 }).where(eq(rateSheetVersions.id, p.id));
        for (const pl of priorLines) {
          const successor = lines.find(l => l.serviceCode === pl.serviceCode && (l.lineKind ?? null) === (pl.lineKind ?? null) && (l.conditionKey ?? null) === (pl.conditionKey ?? null) && (l.applicabilityJson ?? null) === (pl.applicabilityJson ?? null));
          await tx.update(chargeDefinitions).set({ approvalStatus: pl.approvalStatus === "approved" ? "superseded" : pl.approvalStatus, effectiveTo: pl.effectiveTo && pl.effectiveTo.getTime() < w.priorEffectiveTo.getTime() ? pl.effectiveTo : w.priorEffectiveTo, supersededByDefinitionId: successor?.id ?? null }).where(eq(chargeDefinitions.id, pl.id));
          if (successor) await tx.update(chargeDefinitions).set({ supersedesDefinitionId: pl.id, version: pl.version + 1 }).where(eq(chargeDefinitions.id, successor.id));
        }
        supersededRef = p.versionRef;
        await audit(tx, { financialEntityId: v.financialEntityId, subjectType: "rate_sheet_version", subjectRef: p.versionRef, subjectId: p.id, eventType: "version_superseded", fromStatus: "approved", toStatus: "superseded", relatedRef: v.versionRef, actor, at });
      }
      await tx.update(chargeDefinitions).set({ approvalStatus: "approved", approvedByUserId: actor.userId, approvedAt: at }).where(eq(chargeDefinitions.rateSheetVersionId, v.id));
      const fresh = await tx.select().from(chargeDefinitions).where(eq(chargeDefinitions.rateSheetVersionId, v.id));
      set.approvedByUserId = actor.userId; set.approvedAt = at; set.contentHash = versionContentHash(fresh.map(lineHashView)); set.supersedesVersionId = p?.id ?? v.supersedesVersionId;
    }
    await tx.update(rateSheetVersions).set(set).where(eq(rateSheetVersions.id, v.id));
    await audit(tx, { financialEntityId: v.financialEntityId, subjectType: "rate_sheet_version", subjectRef: v.versionRef, subjectId: v.id, eventType: `version_${args.event === "approve" ? "approved" : args.event === "reject" ? "rejected" : args.event === "submit" ? "submitted" : args.event === "reopen" ? "reopened" : "retired"}`, fromStatus: v.status, toStatus: t.to, reason: args.reason ?? null, relatedRef: supersededRef, changes: args.event === "approve" ? { lines: { from: null, to: lines.length }, contentHash: { from: v.contentHash, to: set.contentHash ?? null } } : null, actor, at });
    if (args.event === "approve") await emit(tx, { tenantId: s.tenantId, type: "commercial.rate_sheet_version_approved", entityType: "rateSheetVersion", entityId: v.versionRef, actor, payload: { rateSheetRef: sheet.rateSheetRef, versionRef: v.versionRef, version: v.version, effectiveFrom: iso(v.effectiveFrom), supersedes: supersededRef, lines: lines.length }, at });
    return { versionRef: v.versionRef, status: t.to, supersedes: supersededRef, contentHash: set.contentHash ?? v.contentHash, rowVersion: v.rowVersion + 1 };
  });
}

/** What a viewer may see of a line. `confidential` false strips every price term. */
export function lineView(l: typeof chargeDefinitions.$inferSelect, confidential: boolean) {
  const base = { definitionRef: l.definitionRef, lineNo: l.lineNo, serviceCode: l.serviceCode, lineKind: l.lineKind, label: l.label, pricingMethod: l.pricingMethod, unit: l.unit, measurementBasis: l.measurementBasis, conditionKey: l.conditionKey, applicability: parseJson<unknown[]>(l.applicabilityJson, []), resourceClass: l.resourceClass, unitId: l.unitId, siteRef: l.siteRef, projectRef: l.projectRef, branchCode: l.branchCode, scopeLevel: l.scopeLevel, effectiveFrom: l.effectiveFrom, effectiveTo: l.effectiveTo, approvalStatus: l.approvalStatus, version: l.version, sourceKind: l.sourceKind, sourceClause: l.sourceClause, sourceDocumentEvidenceId: l.sourceDocumentEvidenceId, proposedByUserId: l.proposedByUserId, approvedByUserId: l.approvedByUserId, approvedAt: l.approvedAt, supersedesDefinitionId: l.supersedesDefinitionId, supersededByDefinitionId: l.supersededByDefinitionId, notes: l.notes };
  return confidential ? { ...base, rateMillis: l.rateMillis, flatCents: l.flatCents, basisPoints: l.basisPoints, multiplierMillis: l.multiplierMillis, formula: l.formula, minimumQuantityMillis: l.minimumQuantityMillis, minimumChargeCents: l.minimumChargeCents, billingIncrementMillis: l.billingIncrementMillis, roundingMode: l.roundingMode, currency: l.currency } : base;
}
export async function rateSheetsListForAccount(s: CommercialScope, customerAccountId: number) {
  const sheets = await s.db.select().from(rateSheets).where(and(eq(rateSheets.customerAccountId, customerAccountId), inScope(s, rateSheets.financialEntityId))).orderBy(desc(rateSheets.id));
  const versions = sheets.length ? await s.db.select().from(rateSheetVersions).where(inArray(rateSheetVersions.rateSheetId, sheets.map(x => x.id))) : [];
  return sheets.map(sh => { const vs = versions.filter(v => v.rateSheetId === sh.id); const cur = vs.find(v => v.status === "approved") ?? null; return { ...sh, currentVersion: cur ? { versionRef: cur.versionRef, version: cur.version, effectiveFrom: cur.effectiveFrom, effectiveTo: cur.effectiveTo, status: cur.status } : null, versions: vs.length, pending: vs.filter(v => v.status === "draft" || v.status === "pending_approval").length }; });
}
export async function rateSheetsList(s: CommercialScope, f: { status?: "active" | "retired"; q?: string; limit?: number }) {
  const where = [inScope(s, rateSheets.financialEntityId)];
  if (f.status) where.push(eq(rateSheets.status, f.status));
  if (f.q?.trim()) { const q = `%${f.q.trim()}%`; where.push(or(like(rateSheets.name, q), like(rateSheets.sheetNumber, q))!); }
  return s.db.select().from(rateSheets).where(and(...where)).orderBy(desc(rateSheets.id)).limit(Math.min(f.limit ?? 200, 500));
}
export async function rateSheetGet(s: CommercialScope, rateSheetRef: string, confidential: boolean) {
  const sheet = await sheetInScope(s, rateSheetRef);
  const account = await accountByIdInScope(s, sheet.customerAccountId);
  const contract = sheet.contractId ? (await s.db.select().from(customerContracts).where(eq(customerContracts.id, sheet.contractId)).limit(1))[0] ?? null : null;
  const versions = await s.db.select().from(rateSheetVersions).where(eq(rateSheetVersions.rateSheetId, sheet.id)).orderBy(desc(rateSheetVersions.version));
  const lines = versions.length ? await s.db.select().from(chargeDefinitions).where(inArray(chargeDefinitions.rateSheetVersionId, versions.map(v => v.id))).orderBy(asc(chargeDefinitions.lineNo)) : [];
  const snaps = await s.db.select({ snapshotRef: jobCommercialSnapshots.snapshotRef, jobId: jobCommercialSnapshots.jobId, rateSheetVersionRef: jobCommercialSnapshots.rateSheetVersionRef, status: jobCommercialSnapshots.status, capturedAt: jobCommercialSnapshots.capturedAt }).from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.rateSheetId, sheet.id)).orderBy(desc(jobCommercialSnapshots.id)).limit(200);
  const jobIds = Array.from(new Set(snaps.map(x => x.jobId)));
  const jobRows = jobIds.length ? await s.db.select({ id: jobs.id, jobCode: jobs.jobCode }).from(jobs).where(inArray(jobs.id, jobIds)) : [];
  const jobById = new Map(jobRows.map(j => [j.id, j]));
  const history = await auditHistory(s, "rate_sheet", sheet.rateSheetRef);
  const versionRefs = versions.map(v => v.versionRef);
  const versionHistory = versionRefs.length ? await s.db.select().from(commercialAuditEvents).where(and(eq(commercialAuditEvents.financialEntityId, sheet.financialEntityId), inArray(commercialAuditEvents.subjectRef, versionRefs))).orderBy(desc(commercialAuditEvents.id)).limit(300) : [];
  return {
    ...sheet, customer: { accountRef: account.accountRef, name: account.name, customerNumber: account.customerNumber }, contract: contract ? { contractRef: contract.contractRef, contractNumber: contract.contractNumber, title: contract.title, status: contract.status } : null,
    currentVersion: versions.find(v => v.status === "approved")?.versionRef ?? null,
    versions: versions.map(v => ({ ...v, lines: lines.filter(l => l.rateSheetVersionId === v.id).map(l => lineView(l, confidential)), jobs: snaps.filter(x => x.rateSheetVersionRef === v.versionRef).map(x => ({ ...x, job: jobById.get(x.jobId) ?? null })) })),
    documents: await documentsFor("rate_sheet", sheet.rateSheetRef, s.db), history: [...history, ...versionHistory].sort((a, b) => b.id - a.id), confidential,
  };
}

/* --------------------------------------------------------- job commercial */

type ContextRow = typeof jobCommercialContexts.$inferSelect;
async function jobForScope(s: CommercialScope, jobId: number) {
  const j = await jobInScope(jobId, s.scope);
  if (!j) throw notFound(`Job ${jobId}`);
  return (await s.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1))[0]!;
}
export type JobContextInput = { jobId: number; accountRef: string; billToAccountRef?: string | null; contractRef?: string | null; rateSheetRef?: string | null; pinnedVersionRef?: string | null; poRef?: string | null; notes?: string | null; expectedRowVersion?: number; reason?: string | null };

/** Dispatch selects the customer → contract → PO → sheet. Editable freely before a snapshot; after one, a change is recorded as a correction and a new snapshot is expected. */
export async function jobContextSet(s: CommercialScope, actor: Actor, input: JobContextInput, at = new Date()) {
  const job = await jobForScope(s, input.jobId);
  const a = await accountInScope(s, input.accountRef);
  if (a.archivedAt) throw precondition("An archived customer takes no new job");
  const billTo = input.billToAccountRef ? await accountInScope(s, input.billToAccountRef) : null;
  if (billTo && billTo.financialEntityId !== a.financialEntityId) throw bad("The bill-to customer must belong to the same financial entity");
  const contract = input.contractRef ? await contractInScope(s, input.contractRef) : null;
  if (contract && contract.customerAccountId !== a.id) throw bad("The contract belongs to a different customer");
  if (contract) { const u = contractUsable(contract, at); if (!u.usable && contract.status !== "pending_approval" && contract.status !== "draft") throw precondition(`Contract ${contract.contractNumber} cannot govern this job: ${u.reason}`); }
  const sheet = input.rateSheetRef ? await sheetInScope(s, input.rateSheetRef) : null;
  if (sheet && sheet.customerAccountId !== a.id) throw bad("The rate sheet belongs to a different customer");
  if (sheet && contract && sheet.contractId && sheet.contractId !== contract.id) throw bad("The rate sheet belongs to a different contract");
  const pinned = input.pinnedVersionRef ? await versionInScope(s, input.pinnedVersionRef) : null;
  if (pinned && (!sheet || pinned.rateSheetId !== sheet.id)) throw bad("The pinned version is not a version of the selected sheet");
  if (pinned && pinned.status !== "approved" && pinned.status !== "superseded") throw precondition(`A ${pinned.status} version is not pinned; only an approved one is`);
  const po = input.poRef ? (await s.db.select().from(customerPurchaseOrders).where(and(eq(customerPurchaseOrders.poRef, input.poRef), eq(customerPurchaseOrders.customerAccountId, a.id))).limit(1))[0] ?? null : null;
  if (input.poRef && !po) throw notFound(`Purchase order ${input.poRef} for ${a.accountRef}`);
  return s.db.transaction(async tx => {
    const existing = (await tx.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, job.id)).for("update").limit(1))[0] ?? null;
    const values = { financialEntityId: a.financialEntityId, customerAccountId: a.id, billToCustomerAccountId: billTo?.id ?? null, contractId: contract?.id ?? null, rateSheetId: sheet?.id ?? null, pinnedRateSheetVersionId: pinned?.id ?? null, purchaseOrderId: po?.id ?? null, notes: input.notes ?? null };
    if (!existing) {
      const ins = await tx.insert(jobCommercialContexts).values({ jobId: job.id, ...values, setByUserId: actor.userId, updatedByUserId: actor.userId });
      const id = Number(ins[0]?.insertId ?? 0);
      if (po) await tx.insert(jobCommercialReferences).values({ jobId: job.id, financialEntityId: a.financialEntityId, referenceKind: "po", referenceValue: po.poNumber, customerPurchaseOrderId: po.id, source: "dispatch", recordedByUserId: actor.userId });
      if (po?.afeNumber) await tx.insert(jobCommercialReferences).values({ jobId: job.id, financialEntityId: a.financialEntityId, referenceKind: "afe", referenceValue: po.afeNumber, customerPurchaseOrderId: po.id, source: "dispatch", recordedByUserId: actor.userId });
      await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "job_commercial_context", subjectRef: job.jobCode, subjectId: id, eventType: "job_context_set", jobId: job.id, relatedRef: a.accountRef, changes: { customer: { from: null, to: a.accountRef }, contract: { from: null, to: contract?.contractRef ?? null }, rateSheet: { from: null, to: sheet?.rateSheetRef ?? null }, po: { from: null, to: po?.poRef ?? null } }, actor, at });
      return { jobId: job.id, created: true, rowVersion: 1, snapshotRequired: true };
    }
    const rv = rowVersionCheck(input.expectedRowVersion, existing.rowVersion); if (!rv.ok) throw conflict(`Job commercial context ${rv.reason}`);
    const changes = diff(existing as unknown as Record<string, unknown>, values as Record<string, unknown>);
    if (!Object.keys(changes).length) return { jobId: job.id, created: false, rowVersion: existing.rowVersion, snapshotRequired: existing.currentSnapshotId == null };
    if (existing.currentSnapshotId != null && !input.reason) throw precondition("This job's commercial basis has been snapshotted; a change names its reason and produces a correction snapshot");
    await tx.update(jobCommercialContexts).set({ ...values, updatedByUserId: actor.userId, rowVersion: existing.rowVersion + 1 }).where(eq(jobCommercialContexts.id, existing.id));
    if (po && !(await tx.select({ id: jobCommercialReferences.id }).from(jobCommercialReferences).where(and(eq(jobCommercialReferences.jobId, job.id), eq(jobCommercialReferences.referenceKind, "po"), eq(jobCommercialReferences.referenceValue, po.poNumber), eq(jobCommercialReferences.status, "active"))).limit(1))[0]) await tx.insert(jobCommercialReferences).values({ jobId: job.id, financialEntityId: a.financialEntityId, referenceKind: "po", referenceValue: po.poNumber, customerPurchaseOrderId: po.id, source: "dispatch", recordedByUserId: actor.userId });
    await audit(tx, { financialEntityId: a.financialEntityId, subjectType: "job_commercial_context", subjectRef: job.jobCode, subjectId: existing.id, eventType: existing.currentSnapshotId != null ? "job_context_corrected" : "job_context_updated", jobId: job.id, changes, reason: input.reason ?? null, actor, at });
    return { jobId: job.id, created: false, rowVersion: existing.rowVersion + 1, snapshotRequired: true };
  });
}
export async function jobReferenceAdd(s: CommercialScope, actor: Actor, args: { jobId: number; referenceKind: ReferenceKind; referenceValue: string; source?: "office" | "dispatch" | "customer_portal" | "field" | "import" }, at = new Date()) {
  const job = await jobForScope(s, args.jobId);
  const ctx = (await s.db.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, job.id)).limit(1))[0];
  if (!ctx) throw precondition("Assign a customer to the job before recording its references");
  const value = args.referenceValue.trim(); if (!value) throw bad("A reference has a value");
  return s.db.transaction(async tx => {
    const dup = (await tx.select({ id: jobCommercialReferences.id }).from(jobCommercialReferences).where(and(eq(jobCommercialReferences.jobId, job.id), eq(jobCommercialReferences.referenceKind, args.referenceKind), eq(jobCommercialReferences.referenceValue, value), eq(jobCommercialReferences.status, "active"))).limit(1))[0];
    if (dup) return { id: dup.id, created: false };
    let poId: number | null = null;
    if (args.referenceKind === "po") { const po = (await tx.select({ id: customerPurchaseOrders.id }).from(customerPurchaseOrders).where(and(eq(customerPurchaseOrders.customerAccountId, ctx.customerAccountId), eq(customerPurchaseOrders.poNumber, value))).limit(1))[0]; poId = po?.id ?? null; }
    const ins = await tx.insert(jobCommercialReferences).values({ jobId: job.id, financialEntityId: ctx.financialEntityId, referenceKind: args.referenceKind, referenceValue: value, customerPurchaseOrderId: poId, source: args.source ?? "office", recordedByUserId: actor.userId });
    await audit(tx, { financialEntityId: ctx.financialEntityId, subjectType: "job_commercial_context", subjectRef: job.jobCode, subjectId: ctx.id, eventType: "job_reference_added", jobId: job.id, changes: { [args.referenceKind]: { from: null, to: value } }, actor, at });
    return { id: Number(ins[0]?.insertId ?? 0), created: true, linkedPurchaseOrder: poId != null };
  });
}
export async function jobReferenceEnd(s: CommercialScope, actor: Actor, args: { jobId: number; referenceId: number; reason: string }, at = new Date()) {
  const job = await jobForScope(s, args.jobId);
  return s.db.transaction(async tx => {
    const r = (await tx.select().from(jobCommercialReferences).where(and(eq(jobCommercialReferences.id, args.referenceId), eq(jobCommercialReferences.jobId, job.id), eq(jobCommercialReferences.status, "active"))).for("update").limit(1))[0];
    if (!r) throw notFound(`Reference ${args.referenceId} on job ${job.jobCode}`);
    await tx.update(jobCommercialReferences).set({ status: "ended", endedAt: at, endedByUserId: actor.userId }).where(eq(jobCommercialReferences.id, r.id));
    await audit(tx, { financialEntityId: r.financialEntityId, subjectType: "job_commercial_context", subjectRef: job.jobCode, eventType: "job_reference_ended", jobId: job.id, changes: { [r.referenceKind]: { from: r.referenceValue, to: null } }, reason: args.reason, actor, at });
    return { ended: true };
  });
}
export async function jobPartySet(s: CommercialScope, actor: Actor, args: { jobId: number; partyRole: PartyRole; accountRef?: string | null; contactRef?: string | null; orgRef?: string | null; freeText?: string | null }, at = new Date()) {
  const job = await jobForScope(s, args.jobId);
  const ctx = (await s.db.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, job.id)).limit(1))[0];
  if (!ctx) throw precondition("Assign a customer to the job before naming its parties");
  const isContactRole = CONTACT_PARTY_ROLES.includes(args.partyRole);
  const account = args.accountRef ? await accountInScope(s, args.accountRef) : null;
  const contact = args.contactRef ? (await s.db.select().from(customerContacts).where(and(eq(customerContacts.contactRef, args.contactRef), inScope(s, customerContacts.financialEntityId))).limit(1))[0] ?? null : null;
  if (args.contactRef && !contact) throw notFound(`Contact ${args.contactRef}`);
  if (isContactRole && !contact && !args.freeText) throw bad(`${args.partyRole} names a contact (or, failing a record, a name)`);
  if (!isContactRole && !account && !args.orgRef && !args.freeText) throw bad(`${args.partyRole} names a customer account, an organization, or, failing a record, a name`);
  return s.db.transaction(async tx => {
    await tx.update(jobCommercialParties).set({ status: "ended", endedAt: at, endedByUserId: actor.userId }).where(and(eq(jobCommercialParties.jobId, job.id), eq(jobCommercialParties.partyRole, args.partyRole), eq(jobCommercialParties.status, "active")));
    const ins = await tx.insert(jobCommercialParties).values({ jobId: job.id, financialEntityId: ctx.financialEntityId, partyRole: args.partyRole, customerAccountId: account?.id ?? null, contactId: contact?.id ?? null, orgRef: args.orgRef ?? null, freeText: args.freeText ?? null, recordedByUserId: actor.userId });
    await audit(tx, { financialEntityId: ctx.financialEntityId, subjectType: "job_commercial_context", subjectRef: job.jobCode, subjectId: ctx.id, eventType: "job_party_set", jobId: job.id, changes: { [args.partyRole]: { from: null, to: account?.accountRef ?? contact?.contactRef ?? args.orgRef ?? args.freeText ?? null } }, actor, at });
    return { id: Number(ins[0]?.insertId ?? 0), linked: Boolean(account || contact || args.orgRef) };
  });
}
export async function jobReferenceWaive(s: CommercialScope, actor: Actor, args: { jobId: number; reason: string }, at = new Date()) {
  const job = await jobForScope(s, args.jobId);
  return s.db.transaction(async tx => {
    const ctx = (await tx.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, job.id)).for("update").limit(1))[0];
    if (!ctx) throw precondition("Assign a customer to the job before waiving its references");
    await tx.update(jobCommercialContexts).set({ referenceWaiverReason: args.reason, referenceWaivedByUserId: actor.userId, referenceWaivedAt: at, updatedByUserId: actor.userId, rowVersion: ctx.rowVersion + 1 }).where(eq(jobCommercialContexts.id, ctx.id));
    await audit(tx, { financialEntityId: ctx.financialEntityId, subjectType: "job_commercial_context", subjectRef: job.jobCode, subjectId: ctx.id, eventType: "job_reference_waived", jobId: job.id, reason: args.reason, actor, at });
    await emit(tx, { tenantId: s.tenantId, type: "commercial.job_reference_waived", entityType: "job", entityId: job.jobCode, actor, jobId: job.id, payload: { jobCode: job.jobCode, reason: args.reason }, at });
    return { jobId: job.id, waived: true };
  });
}

/** Everything the gate and the snapshot read about a job, live. */
async function liveCommercial(d: DbOrTx, jobId: number, at: Date) {
  const ctx = (await d.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, jobId)).limit(1))[0] ?? null;
  if (!ctx) return null;
  const account = (await d.select().from(customerAccounts).where(eq(customerAccounts.id, ctx.customerAccountId)).limit(1))[0]!;
  const billTo = ctx.billToCustomerAccountId ? (await d.select().from(customerAccounts).where(eq(customerAccounts.id, ctx.billToCustomerAccountId)).limit(1))[0] ?? account : account;
  const contract = ctx.contractId ? (await d.select().from(customerContracts).where(eq(customerContracts.id, ctx.contractId)).limit(1))[0] ?? null : null;
  const sheet = ctx.rateSheetId ? (await d.select().from(rateSheets).where(eq(rateSheets.id, ctx.rateSheetId)).limit(1))[0] ?? null : null;
  const versions = sheet ? await d.select().from(rateSheetVersions).where(eq(rateSheetVersions.rateSheetId, sheet.id)) : [];
  const pinned = ctx.pinnedRateSheetVersionId ? versions.find(v => v.id === ctx.pinnedRateSheetVersionId) ?? null : null;
  const choice = !sheet ? null : pinned ? { outcome: "resolved" as const, version: pinned, reasons: [`Pinned to version ${pinned.version} (${pinned.versionRef}) by a person`] } : chooseVersionAt(versions, at);
  const references = await d.select().from(jobCommercialReferences).where(and(eq(jobCommercialReferences.jobId, jobId), eq(jobCommercialReferences.status, "active")));
  const parties = await d.select().from(jobCommercialParties).where(and(eq(jobCommercialParties.jobId, jobId), eq(jobCommercialParties.status, "active")));
  const po = ctx.purchaseOrderId ? (await d.select().from(customerPurchaseOrders).where(eq(customerPurchaseOrders.id, ctx.purchaseOrderId)).limit(1))[0] ?? null : null;
  const snapshot = ctx.currentSnapshotId ? (await d.select().from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.id, ctx.currentSnapshotId)).limit(1))[0] ?? null : null;
  const posting = (await d.select({ distribution: dispatchPostings.distribution, priority: dispatchPostings.priority }).from(dispatchPostings).where(eq(dispatchPostings.jobId, jobId)).orderBy(desc(dispatchPostings.id)).limit(1))[0] ?? null;
  const emergency = posting?.distribution === "emergency" || posting?.priority === "emergency";
  return { ctx, account, billTo, contract, sheet, versions, choice, references, parties, po, snapshot, emergency };
}
/** The commercial blockers for the readiness composer. Live rows; the composer has already checked the subject's scope. */
export async function commercialReadinessForJob(d: DbOrTx, jobId: number, at = new Date()): Promise<{ blockers: DispatchBlocker[]; version: string }> {
  const live = await liveCommercial(d, jobId, at);
  if (!live) return { blockers: commercialReadiness({ account: null, contract: null, references: [], waiver: null, emergency: false, snapshot: null, sheetChoice: "not_selected", at }), version: "none" };
  const blockers = commercialReadiness({
    account: live.account, contract: live.contract, references: live.references, waiver: live.ctx.referenceWaiverReason ? { reason: live.ctx.referenceWaiverReason } : null, emergency: live.emergency,
    snapshot: live.snapshot ? { status: "current" } : null, sheetChoice: live.choice ? live.choice.outcome : "not_selected", at,
  });
  const version = [live.ctx.id, live.ctx.rowVersion, live.account.status, live.account.rowVersion, live.contract?.status ?? "∅", live.contract?.rowVersion ?? 0, live.choice?.outcome ?? "∅", live.choice?.outcome === "resolved" ? live.choice.version.versionRef : "∅", live.references.map(r => `${r.referenceKind}=${r.referenceValue}`).sort().join(","), live.snapshot?.snapshotRef ?? "∅", live.ctx.referenceWaivedAt?.toISOString() ?? "∅"].join("|");
  return { blockers, version };
}

/**
 * Freeze the job's commercial basis. Refused (with structured reasons) when the sheet cannot be
 * resolved to exactly one version or the contract cannot govern; a missing reference is recorded
 * in the snapshot, not a refusal (the gate decides dispatch; billing sees the gap).
 */
export async function jobSnapshotCapture(s: CommercialScope, actor: Actor, args: { jobId: number; reason: "activation" | "correction" | "manual"; asOf?: Date; note?: string }, at = new Date()) {
  const job = await jobForScope(s, args.jobId);
  const asOf = args.asOf ?? at;
  return s.db.transaction(async tx => {
    const locked = (await tx.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, job.id)).for("update").limit(1))[0];
    if (!locked) throw precondition("Assign a customer to the job before snapshotting its commercial basis");
    const live = (await liveCommercial(tx, job.id, asOf))!;
    if (!s.entityIds.includes(live.ctx.financialEntityId)) throw notFound(`Job ${job.id}`);
    const reasons: string[] = [];
    if (live.contract) { const u = contractUsable(live.contract, asOf); if (!u.usable) reasons.push(`Contract ${live.contract.contractNumber}: ${u.reason}`); }
    if (live.choice && live.choice.outcome !== "resolved") reasons.push(...live.choice.reasons);
    if (live.account.archivedAt) reasons.push("Customer account is archived");
    if (reasons.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Commercial basis cannot be frozen: ${reasons.join("; ")}` });
    const version = live.choice?.outcome === "resolved" ? live.choice.version : null;
    const defs = version ? await tx.select().from(chargeDefinitions).where(and(eq(chargeDefinitions.rateSheetVersionId, version.id), inArray(chargeDefinitions.approvalStatus, ["approved", "superseded"]))).orderBy(asc(chargeDefinitions.lineNo)) : [];
    const terms = live.contract?.termsId ? (await tx.select().from(customerContractTerms).where(eq(customerContractTerms.id, live.contract.termsId)).limit(1))[0] ?? null
      : (await tx.select().from(customerContractTerms).where(and(eq(customerContractTerms.customerAccountId, live.account.id), eq(customerContractTerms.status, "approved"))).orderBy(desc(customerContractTerms.version))).find(t => t.effectiveFrom.getTime() <= asOf.getTime() && (!t.effectiveTo || asOf.getTime() < t.effectiveTo.getTime())) ?? null;
    const contactRows = await tx.select().from(customerContacts).where(and(eq(customerContacts.customerAccountId, live.account.id), eq(customerContacts.status, "active")));
    const roleRows = contactRows.length ? await tx.select().from(customerContactRoles).where(and(inArray(customerContactRoles.contactId, contactRows.map(c => c.id)), eq(customerContactRoles.status, "active"))) : [];
    const partyContactIds = live.parties.map(p => p.contactId).filter((x): x is number => x != null);
    const partyContacts = partyContactIds.length ? await tx.select().from(customerContacts).where(inArray(customerContacts.id, partyContactIds)) : [];
    const partyAccountIds = live.parties.map(p => p.customerAccountId).filter((x): x is number => x != null);
    const partyAccounts = partyAccountIds.length ? await tx.select({ id: customerAccounts.id, accountRef: customerAccounts.accountRef, name: customerAccounts.name }).from(customerAccounts).where(inArray(customerAccounts.id, partyAccountIds)) : [];
    const contacts: SnapshotContact[] = [
      ...contactRows.map(c => ({ contactRef: c.contactRef, displayName: c.displayName, company: c.company, title: c.title, phone: c.phone, mobile: c.mobile, email: c.email, roles: roleRows.filter(r => r.contactId === c.id).map(r => r.roleKey), partyRole: (live.parties.find(p => p.contactId === c.id)?.partyRole as PartyRole | undefined) ?? null })),
      ...partyContacts.filter(pc => !contactRows.some(c => c.id === pc.id)).map(c => ({ contactRef: c.contactRef, displayName: c.displayName, company: c.company, title: c.title, phone: c.phone, mobile: c.mobile, email: c.email, roles: [], partyRole: (live.parties.find(p => p.contactId === c.id)?.partyRole as PartyRole | undefined) ?? null })),
    ];
    const parties: SnapshotParty[] = live.parties.map(p => { const acc = partyAccounts.find(a => a.id === p.customerAccountId) ?? null; const ct = [...contactRows, ...partyContacts].find(c => c.id === p.contactId) ?? null; return { partyRole: p.partyRole as PartyRole, customerAccountRef: acc?.accountRef ?? null, customerName: acc?.name ?? null, contactRef: ct?.contactRef ?? null, contactName: ct?.displayName ?? null, orgRef: p.orgRef, freeText: p.freeText, linked: Boolean(acc || ct || p.orgRef) }; });
    const required = requiredReferenceKinds(live.account, live.contract);
    const present = new Set(live.references.map(r => r.referenceKind));
    const missing = required.filter(k => !present.has(k));
    const effectivePaymentTerms = live.contract?.paymentTermsDays ?? live.billTo.paymentTermsDays;
    const payload: SnapshotPayload = {
      schema: "job-commercial-snapshot/1",
      job: { id: job.id, jobCode: job.jobCode },
      customer: { accountRef: live.account.accountRef, customerNumber: live.account.customerNumber, name: live.account.name, legalName: live.account.legalName, tradeName: live.account.tradeName, customerType: live.account.customerType, status: live.account.status, taxStatus: live.account.taxStatus, gstNumber: live.account.gstNumber, billingAddress: parseJson<unknown>(live.account.billingAddressJson, null), physicalAddress: parseJson<unknown>(live.account.physicalAddressJson, null), defaultCurrency: live.account.defaultCurrency, paymentTermsDays: live.account.paymentTermsDays, requiresPurchaseOrder: live.account.requiresPurchaseOrder, requiresAfe: live.account.requiresAfe, requiredReferenceKinds: parseJson<string[]>(live.account.requiredReferenceKindsJson, []) },
      billTo: { accountRef: live.billTo.accountRef, name: live.billTo.name, billingAddress: parseJson<unknown>(live.billTo.billingAddressJson, null), paymentTermsDays: live.billTo.paymentTermsDays },
      contract: live.contract ? { contractRef: live.contract.contractRef, contractNumber: live.contract.contractNumber, title: live.contract.title, contractType: live.contract.contractType, version: live.contract.version, status: live.contract.status, effectiveFrom: live.contract.effectiveFrom.toISOString(), effectiveTo: iso(live.contract.effectiveTo), poRequirement: live.contract.poRequirement, paymentTermsDays: live.contract.paymentTermsDays, billingInstructions: live.contract.billingInstructions, customerReferences: parseJson<unknown>(live.contract.customerReferencesJson, null) } : null,
      terms: terms ? { termsRef: terms.termsRef, version: terms.version, title: terms.title, effectiveFrom: terms.effectiveFrom.toISOString(), effectiveTo: iso(terms.effectiveTo) } : null,
      rateSheet: live.sheet && version ? { rateSheetRef: live.sheet.rateSheetRef, name: live.sheet.name, sheetNumber: live.sheet.sheetNumber, currency: live.sheet.currency, versionRef: version.versionRef, version: version.version, effectiveFrom: version.effectiveFrom.toISOString(), effectiveTo: iso(version.effectiveTo), contentHash: version.contentHash, definitions: defs.map<SnapshotDefinition>(d => ({ definitionRef: d.definitionRef, version: d.version, serviceCode: d.serviceCode, lineKind: d.lineKind, lineNo: d.lineNo, label: d.label, pricingMethod: d.pricingMethod, unit: d.unit, rateMillis: d.rateMillis, flatCents: d.flatCents, basisPoints: d.basisPoints, multiplierMillis: d.multiplierMillis, minimumQuantityMillis: d.minimumQuantityMillis, minimumChargeCents: d.minimumChargeCents, billingIncrementMillis: d.billingIncrementMillis, roundingMode: d.roundingMode, measurementBasis: d.measurementBasis, conditionKey: d.conditionKey, applicabilityJson: d.applicabilityJson, scopeLevel: d.scopeLevel, effectiveFrom: d.effectiveFrom.toISOString(), effectiveTo: iso(d.effectiveTo), sourceClause: d.sourceClause })) } : null,
      purchaseOrder: live.po ? { poRef: live.po.poRef, poNumber: live.po.poNumber, afeNumber: live.po.afeNumber, authorizedCents: live.po.authorizedCents, validFrom: live.po.validFrom.toISOString(), validTo: iso(live.po.validTo), status: live.po.status } : null,
      references: live.references.map(r => ({ referenceKind: r.referenceKind, referenceValue: r.referenceValue })),
      parties, contacts, requiredReferenceKinds: required, missingReferenceKinds: missing,
      waiver: live.ctx.referenceWaiverReason ? { reason: live.ctx.referenceWaiverReason, byUserId: live.ctx.referenceWaivedByUserId!, at: live.ctx.referenceWaivedAt!.toISOString() } : null,
      effective: { paymentTermsDays: effectivePaymentTerms, currency: live.sheet?.currency ?? live.account.defaultCurrency, poRequired: required.includes("po"), billingInstructions: live.contract?.billingInstructions ?? null },
      capturedAt: at.toISOString(),
    };
    const payloadHash = snapshotHash(payload);
    const prev = (await tx.select().from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.jobId, job.id)).orderBy(desc(jobCommercialSnapshots.sequenceNo)).for("update").limit(1))[0] ?? null;
    if (prev && prev.status === "current" && prev.payloadHash === payloadHash) return { snapshotRef: prev.snapshotRef, sequenceNo: prev.sequenceNo, payloadHash, unchanged: true, missingReferenceKinds: missing };
    const snapshotRef = ref("JCS");
    const ins = await tx.insert(jobCommercialSnapshots).values({
      snapshotRef, jobId: job.id, financialEntityId: live.ctx.financialEntityId, sequenceNo: (prev?.sequenceNo ?? 0) + 1, reason: args.reason, capturedByUserId: actor.userId, capturedAt: at,
      customerAccountId: live.account.id, customerAccountRef: live.account.accountRef, customerNumber: live.account.customerNumber, customerName: live.account.name, billToCustomerAccountId: live.billTo.id,
      contractId: live.contract?.id ?? null, contractRef: live.contract?.contractRef ?? null, contractNumber: live.contract?.contractNumber ?? null, contractVersion: live.contract?.version ?? null,
      termsId: terms?.id ?? null, termsRef: terms?.termsRef ?? null, termsVersion: terms?.version ?? null,
      rateSheetId: live.sheet?.id ?? null, rateSheetVersionId: version?.id ?? null, rateSheetVersionRef: version?.versionRef ?? null, rateSheetVersion: version?.version ?? null, rateSheetContentHash: version?.contentHash ?? null,
      purchaseOrderId: live.po?.id ?? null, poRef: live.po?.poRef ?? null, poNumber: live.po?.poNumber ?? null, paymentTermsDays: effectivePaymentTerms, currency: payload.effective.currency, poRequired: payload.effective.poRequired, billingInstructions: payload.effective.billingInstructions,
      payloadJson: JSON.stringify(payload), payloadHash, supersedesSnapshotId: prev?.id ?? null,
    });
    const id = Number(ins[0]?.insertId ?? 0);
    if (prev) await tx.update(jobCommercialSnapshots).set({ status: "superseded" }).where(eq(jobCommercialSnapshots.id, prev.id));
    await tx.update(jobCommercialContexts).set({ currentSnapshotId: id, updatedByUserId: actor.userId, rowVersion: locked.rowVersion + 1 }).where(eq(jobCommercialContexts.id, locked.id));
    if (live.contract && !live.contract.usedOperationallyAt) await tx.update(customerContracts).set({ usedOperationallyAt: at }).where(eq(customerContracts.id, live.contract.id));
    if (version && !version.usedOperationallyAt) await tx.update(rateSheetVersions).set({ usedOperationallyAt: at }).where(eq(rateSheetVersions.id, version.id));
    await audit(tx, { financialEntityId: live.ctx.financialEntityId, subjectType: "job_commercial_snapshot", subjectRef: snapshotRef, subjectId: id, eventType: "snapshot_captured", jobId: job.id, relatedRef: prev?.snapshotRef ?? null, reason: args.note ?? args.reason, changes: { contract: { from: prev?.contractRef ?? null, to: live.contract?.contractRef ?? null }, rateSheetVersion: { from: prev?.rateSheetVersionRef ?? null, to: version?.versionRef ?? null }, po: { from: prev?.poRef ?? null, to: live.po?.poRef ?? null }, payloadHash: { from: prev?.payloadHash ?? null, to: payloadHash } }, actor, at });
    if (live.contract) await audit(tx, { financialEntityId: live.ctx.financialEntityId, subjectType: "customer_contract", subjectRef: live.contract.contractRef, subjectId: live.contract.id, eventType: "used_by_job", jobId: job.id, relatedRef: snapshotRef, actor, at });
    if (version) await audit(tx, { financialEntityId: live.ctx.financialEntityId, subjectType: "rate_sheet_version", subjectRef: version.versionRef, subjectId: version.id, eventType: "used_by_job", jobId: job.id, relatedRef: snapshotRef, actor, at });
    await emit(tx, { tenantId: s.tenantId, type: "commercial.job_snapshot_captured", entityType: "job", entityId: job.jobCode, actor, jobId: job.id, payload: { jobCode: job.jobCode, snapshotRef, sequenceNo: (prev?.sequenceNo ?? 0) + 1, payloadHash, contractRef: live.contract?.contractRef ?? null, rateSheetVersionRef: version?.versionRef ?? null, missingReferenceKinds: missing }, at });
    if (missing.length) await emit(tx, { tenantId: s.tenantId, type: "commercial.job_reference_missing", entityType: "job", entityId: job.jobCode, actor, jobId: job.id, payload: { jobCode: job.jobCode, missing, accountRef: live.account.accountRef, waived: live.ctx.referenceWaiverReason != null }, at });
    return { snapshotRef, sequenceNo: (prev?.sequenceNo ?? 0) + 1, payloadHash, unchanged: false, missingReferenceKinds: missing };
  });
}
/** The posting hook: capture if a context exists and nothing has been captured; never throw into dispatch. */
export async function jobSnapshotCaptureIfReady(s: CommercialScope, actor: Actor, jobId: number, at = new Date()): Promise<{ outcome: "captured" | "already" | "no_context" | "refused"; detail: string; snapshotRef?: string }> {
  const ctx = (await s.db.select({ id: jobCommercialContexts.id, currentSnapshotId: jobCommercialContexts.currentSnapshotId }).from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, jobId)).limit(1))[0];
  if (!ctx) return { outcome: "no_context", detail: "No customer assigned to this job; the readiness gate says so" };
  if (ctx.currentSnapshotId != null) return { outcome: "already", detail: "A current snapshot exists" };
  try { const r = await jobSnapshotCapture(s, actor, { jobId, reason: "activation" }, at); return { outcome: "captured", detail: `Snapshot ${r.snapshotRef}`, snapshotRef: r.snapshotRef }; }
  catch (e) { if (e instanceof TRPCError && (e.code === "PRECONDITION_FAILED" || e.code === "NOT_FOUND")) return { outcome: "refused", detail: e.message }; throw e; }
}

export async function jobCommercialGet(s: CommercialScope, jobId: number, confidential: boolean, at = new Date()) {
  const job = await jobForScope(s, jobId);
  const live = await liveCommercial(s.db, job.id, at);
  if (!live) return { jobId: job.id, jobCode: job.jobCode, context: null, snapshot: null, readiness: commercialReadiness({ account: null, contract: null, references: [], waiver: null, emergency: false, snapshot: null, sheetChoice: "not_selected", at }), history: [] as (typeof commercialAuditEvents.$inferSelect)[] };
  if (!s.entityIds.includes(live.ctx.financialEntityId)) throw notFound(`Job ${jobId}`);
  const readiness = commercialReadiness({ account: live.account, contract: live.contract, references: live.references, waiver: live.ctx.referenceWaiverReason ? { reason: live.ctx.referenceWaiverReason } : null, emergency: live.emergency, snapshot: live.snapshot ? { status: "current" } : null, sheetChoice: live.choice ? live.choice.outcome : "not_selected", at });
  const payload = live.snapshot ? parseJson<SnapshotPayload | null>(live.snapshot.payloadJson, null) : null;
  const snapshots = await s.db.select({ snapshotRef: jobCommercialSnapshots.snapshotRef, sequenceNo: jobCommercialSnapshots.sequenceNo, reason: jobCommercialSnapshots.reason, status: jobCommercialSnapshots.status, capturedAt: jobCommercialSnapshots.capturedAt, capturedByUserId: jobCommercialSnapshots.capturedByUserId, payloadHash: jobCommercialSnapshots.payloadHash, contractRef: jobCommercialSnapshots.contractRef, rateSheetVersionRef: jobCommercialSnapshots.rateSheetVersionRef, poNumber: jobCommercialSnapshots.poNumber }).from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.jobId, job.id)).orderBy(desc(jobCommercialSnapshots.sequenceNo));
  const history = await s.db.select().from(commercialAuditEvents).where(eq(commercialAuditEvents.jobId, job.id)).orderBy(desc(commercialAuditEvents.id)).limit(200);
  const stripRates = (p: SnapshotPayload | null) => p && !confidential ? { ...p, rateSheet: p.rateSheet ? { ...p.rateSheet, definitions: p.rateSheet.definitions.map(d => ({ definitionRef: d.definitionRef, version: d.version, serviceCode: d.serviceCode, lineKind: d.lineKind, lineNo: d.lineNo, label: d.label, unit: d.unit, pricingMethod: d.pricingMethod })) } : null, customer: { ...p.customer } } : p;
  return {
    jobId: job.id, jobCode: job.jobCode,
    context: { rowVersion: live.ctx.rowVersion, customer: { accountRef: live.account.accountRef, name: live.account.name, customerNumber: live.account.customerNumber, status: live.account.status }, billTo: { accountRef: live.billTo.accountRef, name: live.billTo.name }, contract: live.contract ? { contractRef: live.contract.contractRef, contractNumber: live.contract.contractNumber, title: live.contract.title, status: live.contract.status, version: live.contract.version } : null, rateSheet: live.sheet ? { rateSheetRef: live.sheet.rateSheetRef, name: live.sheet.name, sheetNumber: live.sheet.sheetNumber } : null, versionChoice: live.choice ? { outcome: live.choice.outcome, versionRef: live.choice.outcome === "resolved" ? live.choice.version.versionRef : null, reasons: live.choice.reasons } : null, purchaseOrder: live.po ? { poRef: live.po.poRef, poNumber: live.po.poNumber, status: live.po.status } : null, references: live.references, parties: live.parties, waiver: live.ctx.referenceWaiverReason ? { reason: live.ctx.referenceWaiverReason, at: live.ctx.referenceWaivedAt } : null, requiredReferenceKinds: requiredReferenceKinds(live.account, live.contract), emergency: live.emergency },
    snapshot: live.snapshot ? { snapshotRef: live.snapshot.snapshotRef, sequenceNo: live.snapshot.sequenceNo, capturedAt: live.snapshot.capturedAt, payloadHash: live.snapshot.payloadHash, payload: stripRates(payload) } : null,
    snapshots, readiness, history, confidential,
  };
}
/** The field-safe view: what a driver needs, nothing priced. */
export async function jobCommercialFieldSummary(s: CommercialScope, jobId: number): Promise<FieldCommercialSubset | { jobId: number; jobCode: string; snapshotRef: null; note: string }> {
  const job = await jobForScope(s, jobId);
  const ctx = (await s.db.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, job.id)).limit(1))[0];
  const snap = ctx?.currentSnapshotId ? (await s.db.select().from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.id, ctx.currentSnapshotId)).limit(1))[0] : null;
  if (!snap) return { jobId: job.id, jobCode: job.jobCode, snapshotRef: null, note: "No commercial basis has been frozen for this job yet" };
  return fieldSubsetOf({ snapshotRef: snap.snapshotRef, payloadHash: snap.payloadHash, payload: JSON.parse(snap.payloadJson) as SnapshotPayload });
}
/** Is this user's operator assigned to the job (a dispatch role or the legacy driver string)? For field-role callers. */
export async function callerAssignedToJob(d: DbOrTx, userId: number, jobId: number): Promise<boolean> {
  const me = (await d.select({ id: operators.id, name: operators.name }).from(operators).where(eq(operators.userId, userId)).limit(1))[0];
  if (!me) return false;
  const postings = await d.select({ id: dispatchPostings.id }).from(dispatchPostings).where(eq(dispatchPostings.jobId, jobId));
  if (postings.length) { const r = (await d.select({ id: dispatchRoles.id }).from(dispatchRoles).where(and(inArray(dispatchRoles.postingId, postings.map(p => p.id)), eq(dispatchRoles.assignedOperatorId, me.id))).limit(1))[0]; if (r) return true; }
  const j = (await d.select({ driver: jobs.driver }).from(jobs).where(eq(jobs.id, jobId)).limit(1))[0];
  return Boolean(j?.driver && me.name && j.driver.trim().toLowerCase() === me.name.trim().toLowerCase());
}

/** The Billing / AR interface. Reads the CURRENT snapshot and nothing live. */
export async function getBillableCommercialContext(s: CommercialScope, jobId: number): Promise<BillableCommercialContext | { jobId: number; jobCode: string; available: false; reasons: string[] }> {
  const job = await jobForScope(s, jobId);
  const ctx = (await s.db.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, job.id)).limit(1))[0];
  if (!ctx) return { jobId: job.id, jobCode: job.jobCode, available: false, reasons: ["No customer is assigned to this job"] };
  if (!s.entityIds.includes(ctx.financialEntityId)) throw notFound(`Job ${jobId}`);
  const snap = ctx.currentSnapshotId ? (await s.db.select().from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.id, ctx.currentSnapshotId)).limit(1))[0] : null;
  if (!snap) return { jobId: job.id, jobCode: job.jobCode, available: false, reasons: ["The job's commercial basis has not been snapshotted; capture it before billing"] };
  const docs = new Set<string>(["signed_field_ticket"]);
  const payload = JSON.parse(snap.payloadJson) as SnapshotPayload;
  if (payload.requiredReferenceKinds.includes("po")) docs.add("purchase_order_on_file");
  if (payload.rateSheet?.definitions.some(d => d.lineKind === "disposal_pass_through" || d.lineKind === "disposal_charge")) docs.add("disposal_ticket");
  if (payload.rateSheet?.definitions.some(d => d.unit === "km" || d.unit === "mile")) docs.add("distance_record");
  if (payload.rateSheet?.definitions.some(d => d.unit === "hour" || d.unit === "half_hour")) docs.add("time_record");
  return billableContextOf({ jobId: job.id, snapshotRef: snap.snapshotRef, sequenceNo: snap.sequenceNo, payloadHash: snap.payloadHash, capturedAt: snap.capturedAt, payload }, Array.from(docs).sort());
}

/** Resolve one service for a job from its snapshot's pinned version — the June job at the June rate, whatever the sheet says today. `at` is the date of the WORK (default: the snapshot's capture), never the date of asking. */
export async function resolveRateForJob(s: CommercialScope, args: { jobId: number; serviceCode: string; at?: Date; attributes?: Record<string, string | number | null>; rateKind?: "sell" | "vendor_payable" | "payroll_reference" | "internal_cost" }): Promise<{ resolution: Resolution; basis: { snapshotRef: string; rateSheetVersionRef: string | null; contractRef: string | null } | null; reasons: string[] }> {
  const job = await jobForScope(s, args.jobId);
  const ctx = (await s.db.select().from(jobCommercialContexts).where(eq(jobCommercialContexts.jobId, job.id)).limit(1))[0];
  if (!ctx || !s.entityIds.includes(ctx.financialEntityId)) return { resolution: { outcome: "unknown", considered: 0, reasons: ["No customer is assigned to this job"] }, basis: null, reasons: ["No customer is assigned to this job"] };
  const snap = ctx.currentSnapshotId ? (await s.db.select().from(jobCommercialSnapshots).where(eq(jobCommercialSnapshots.id, ctx.currentSnapshotId)).limit(1))[0] : null;
  if (!snap) return { resolution: { outcome: "unknown", considered: 0, reasons: ["The job's commercial basis has not been snapshotted"] }, basis: null, reasons: ["The job's commercial basis has not been snapshotted"] };
  const at = args.at ?? snap.capturedAt;
  const payload = JSON.parse(snap.payloadJson) as SnapshotPayload;
  const rateKind = args.rateKind ?? "sell";
  // The sheet's lines come from the SNAPSHOT, as they stood when the basis was frozen — not from the
  // live rows, whose windows a later supersession may have closed behind this job. Definitions with
  // no sheet (company, branch, a job override) are read live and stay in play by precedence.
  const live = (await s.db.select().from(chargeDefinitions).where(and(eq(chargeDefinitions.financialEntityId, ctx.financialEntityId), eq(chargeDefinitions.serviceCode, args.serviceCode), eq(chargeDefinitions.rateKind, rateKind), isNull(chargeDefinitions.rateSheetVersionId)))) as ChargeDefinition[];
  const frozenRefs = (payload.rateSheet?.definitions ?? []).filter(d => d.serviceCode === args.serviceCode);
  const ids = frozenRefs.length ? await s.db.select({ id: chargeDefinitions.id, definitionRef: chargeDefinitions.definitionRef }).from(chargeDefinitions).where(inArray(chargeDefinitions.definitionRef, frozenRefs.map(d => d.definitionRef))) : [];
  const frozen: ChargeDefinition[] = rateKind !== "sell" ? [] : frozenRefs.map(d => ({
    id: ids.find(x => x.definitionRef === d.definitionRef)?.id ?? 0, definitionRef: d.definitionRef, rateKind: "sell", serviceCode: d.serviceCode, resourceClass: null, unitId: null,
    pricingMethod: d.pricingMethod as ChargeDefinition["pricingMethod"], unit: d.unit as ChargeDefinition["unit"], rateMillis: d.rateMillis, flatCents: d.flatCents, basisPoints: d.basisPoints, multiplierMillis: d.multiplierMillis,
    minimumQuantityMillis: d.minimumQuantityMillis, minimumChargeCents: d.minimumChargeCents, billingIncrementMillis: d.billingIncrementMillis, roundingMode: d.roundingMode as ChargeDefinition["roundingMode"], measurementBasis: d.measurementBasis as ChargeDefinition["measurementBasis"], conditionKey: d.conditionKey,
    scopeLevel: d.scopeLevel as ChargeDefinition["scopeLevel"], customerAccountId: snap.customerAccountId, vendorId: null, projectRef: null, siteRef: null, contractRef: d.scopeLevel === "customer_contract" ? snap.contractRef : null, jobId: null, branchCode: null,
    effectiveFrom: new Date(d.effectiveFrom), effectiveTo: d.effectiveTo ? new Date(d.effectiveTo) : null, approvalStatus: "approved", version: d.version, sourceClause: d.sourceClause, sourceKind: "human", applicabilityJson: d.applicabilityJson, rateSheetVersionId: snap.rateSheetVersionId, lineKind: d.lineKind,
  }));
  const rctx: ResolutionContext = { rateKind, serviceCode: args.serviceCode, at, customerAccountId: snap.customerAccountId, contractRef: snap.contractRef, jobId: job.id, attributes: args.attributes ?? {}, rateSheetVersionId: snap.rateSheetVersionId };
  const resolution = resolveRate([...frozen, ...live], rctx);
  return { resolution, basis: { snapshotRef: snap.snapshotRef, rateSheetVersionRef: snap.rateSheetVersionRef, contractRef: snap.contractRef }, reasons: [`Priced against snapshot ${snap.snapshotRef}${snap.rateSheetVersionRef ? ` (version ${snap.rateSheetVersionRef})` : " (no sheet version)"} at ${at.toISOString().slice(0, 10)}`, ...resolution.reasons] };
}

/* ------------------------------------------------------------------ sweeps */

/** Contracts and sheet versions expiring within the window, and contracts past their end: emits the events (once per day per subject) and expires what has ended. */
export async function expirySweep(s: CommercialScope, actor: Actor, args: { withinDays: number }, at = new Date()) {
  const horizon = new Date(at.getTime() + args.withinDays * 86_400_000);
  const dayKey = at.toISOString().slice(0, 10);
  const contracts = await s.db.select().from(customerContracts).where(and(inScope(s, customerContracts.financialEntityId), inArray(customerContracts.status, ["active", "suspended"])));
  const versions = await s.db.select().from(rateSheetVersions).where(and(inScope(s, rateSheetVersions.financialEntityId), eq(rateSheetVersions.status, "approved")));
  let expiring = 0, expired = 0, sheetsExpiring = 0;
  for (const c of contracts) {
    if (!c.effectiveTo) continue;
    if (c.effectiveTo.getTime() <= at.getTime()) { await contractTransitionApply(s, actor, { contractRef: c.contractRef, event: "expire", reason: "window closed (sweep)" }, at); expired++; continue; }
    if (c.effectiveTo.getTime() <= horizon.getTime()) {
      const already = (await s.db.select({ id: domainEventOutbox.id }).from(domainEventOutbox).where(and(eq(domainEventOutbox.eventType, "commercial.contract_expiring"), eq(domainEventOutbox.aggregateId, c.contractRef), sql`DATE(${domainEventOutbox.occurredAt}) = ${dayKey}`)).limit(1))[0];
      if (!already) { await emit(s.db, { tenantId: s.tenantId, type: "commercial.contract_expiring", entityType: "customerContract", entityId: c.contractRef, actor, payload: { contractRef: c.contractRef, contractNumber: c.contractNumber, effectiveTo: iso(c.effectiveTo), renewalKind: c.renewalKind, daysRemaining: Math.ceil((c.effectiveTo.getTime() - at.getTime()) / 86_400_000) }, at }); expiring++; }
    }
  }
  for (const v of versions) {
    if (!v.effectiveTo || v.effectiveTo.getTime() > horizon.getTime() || v.effectiveTo.getTime() <= at.getTime()) continue;
    const already = (await s.db.select({ id: domainEventOutbox.id }).from(domainEventOutbox).where(and(eq(domainEventOutbox.eventType, "commercial.rate_sheet_expiring"), eq(domainEventOutbox.aggregateId, v.versionRef), sql`DATE(${domainEventOutbox.occurredAt}) = ${dayKey}`)).limit(1))[0];
    if (!already) { await emit(s.db, { tenantId: s.tenantId, type: "commercial.rate_sheet_expiring", entityType: "rateSheetVersion", entityId: v.versionRef, actor, payload: { versionRef: v.versionRef, rateSheetId: v.rateSheetId, effectiveTo: iso(v.effectiveTo) }, at }); sheetsExpiring++; }
  }
  return { contractsExpiring: expiring, contractsExpired: expired, sheetVersionsExpiring: sheetsExpiring };
}
