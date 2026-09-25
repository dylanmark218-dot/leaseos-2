/**
 * F1 — tenant isolation for money: one resolver per record a finance procedure names.
 *
 * Every lookup proves the chain caller → organization → book → record before it returns the row:
 * the organization comes from `ctx.money` (resolved from the caller's membership by `moneyScoped`),
 * the book is the record's `financialEntityId` (or, where the record has no book column of its own,
 * the canonical parent that does), and the record is the one named. A record that fails is
 * "<what> not found" — exactly what a missing row answers — so a refusal never confirms that
 * another organization's record exists.
 *
 * A record assigned to no book (financialEntityId NULL) is in nobody's scope. Holding a finance role
 * somewhere else grants nothing here: roles are `roleProcedure`'s question, books are this module's.
 *
 * Rules for records without a book column (each is the parent that already owns them — nothing new
 * is recorded):
 *   - bank statement → its bank account; write-off request, collection event → its invoice;
 *     dispute case → the invoice it names; fuel statement line → its statement;
 *   - vendor → `bookOrgRef` (0149); roadside event → its unit's owner (coreRecordOwnership);
 *   - external identity → its customer account's book, its vendor's book, or (a facility identity,
 *     since facilities are a shared directory) the organization of the person who invited it;
 *   - audit package → its subject, resolved the same way as when it was prepared.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, notInArray, or, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { auditPackages, bankAccounts, incidentReports, insuranceClaims, insurancePolicies, bankStatements, capitalAssets, ccaSchedules, customerAccounts, customerCredits, disputeCases, externalIdentities, fuelAccounts, fuelStatements, fuelTransactions, gstReturns, iftaReturns, invoices, jurisdictionDistanceRecords, bulkFuelTanks, loads, organizationMemberships, portalSubmissions, purchaseAuthorizations, roadsideServiceEvents, safetyEvents, units, vendorBills, vendors, writeOffRequests } from "../drizzle/schema";
import { bookOrgWhere, notFound, ownsBookOrg, ownsEntity, requireOwnedEntity, type FinanceScope } from "./_core/entityScope";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { requireProvableOwnership } from "./ownershipDomain";
import { evidenceInScope, fieldTicketInScope, getDb, incidentInScope, jobInScope, jobScopeSubquery, operatorInScope, ownershipScopeWhere, tripInScope, unitInScope, userInScope } from "./db";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** "<what> not found" — or, when a router already words it as a sentence ("No such invoice"), that sentence unchanged. */
const missing = (what: string) => (/^No such |not found|no invoice on file/i.test(what) ? new TRPCError({ code: "NOT_FOUND", message: what }) : notFound(what));
/** The row, if it exists and its book is the caller's; otherwise the same answer a missing row gets. */
function owned<T>(row: T | undefined, entityOf: (r: T) => number | null | undefined, fs: FinanceScope, what: string): T {
  if (!row || !ownsEntity(fs, entityOf(row))) throw missing(what);
  return row;
}

export { requireOwnedEntity };

// ── AR ────────────────────────────────────────────────────────────────────────────────────────────
export async function invoiceInScope(db: Db, fs: FinanceScope, invoiceNumber: string, what = "Invoice") {
  return owned((await db.select().from(invoices).where(eq(invoices.invoiceNumber, invoiceNumber)).limit(1))[0], r => r.financialEntityId, fs, what);
}
export async function invoiceByIdInScope(db: Db, fs: FinanceScope, invoiceId: number, what = "Invoice") {
  return owned((await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1))[0], r => r.financialEntityId, fs, what);
}
export async function customerCreditInScope(db: Db, fs: FinanceScope, creditRef: string) {
  return owned((await db.select().from(customerCredits).where(eq(customerCredits.creditRef, creditRef)).limit(1))[0], r => r.financialEntityId, fs, "Credit");
}
export async function writeOffInScope(db: Db, fs: FinanceScope, requestRef: string) {
  const w = (await db.select().from(writeOffRequests).where(eq(writeOffRequests.requestRef, requestRef)).limit(1))[0];
  if (!w) throw notFound("Write-off request");
  const inv = (await db.select({ financialEntityId: invoices.financialEntityId }).from(invoices).where(eq(invoices.id, w.invoiceId)).limit(1))[0];
  if (!inv || !ownsEntity(fs, inv.financialEntityId)) throw notFound("Write-off request");
  return w;
}
export async function customerAccountInScope(db: Db, fs: FinanceScope, accountRef: string) {
  return owned((await db.select().from(customerAccounts).where(eq(customerAccounts.accountRef, accountRef)).limit(1))[0], r => r.financialEntityId, fs, "Customer account");
}
export async function disputeCaseInScope(db: Db, fs: FinanceScope, caseNumber: string) {
  const c = (await db.select().from(disputeCases).where(eq(disputeCases.caseNumber, caseNumber)).limit(1))[0];
  if (!c) throw notFound("Dispute case");
  // A case that names no invoice has no book to prove; it is nobody's through this path.
  if (!c.invoiceNumber) throw notFound("Dispute case");
  const inv = (await db.select({ financialEntityId: invoices.financialEntityId }).from(invoices).where(eq(invoices.invoiceNumber, c.invoiceNumber)).limit(1))[0];
  if (!inv || !ownsEntity(fs, inv.financialEntityId)) throw notFound("Dispute case");
  return c;
}

// ── Bank ──────────────────────────────────────────────────────────────────────────────────────────
export async function bankAccountInScope(db: Db, fs: FinanceScope, accountRef: string) {
  return owned((await db.select().from(bankAccounts).where(eq(bankAccounts.accountRef, accountRef)).limit(1))[0], r => r.financialEntityId, fs, "Bank account");
}
export async function bankStatementInScope(db: Db, fs: FinanceScope, statementRef: string) {
  const st = (await db.select().from(bankStatements).where(eq(bankStatements.statementRef, statementRef)).limit(1))[0];
  if (!st) throw notFound("Statement");
  const acct = (await db.select().from(bankAccounts).where(eq(bankAccounts.id, st.bankAccountId)).limit(1))[0];
  if (!acct || !ownsEntity(fs, acct.financialEntityId)) throw notFound("Statement");
  return { st, acct };
}

// ── AP / purchasing ───────────────────────────────────────────────────────────────────────────────
export async function vendorBillInScope(db: Db, fs: FinanceScope, billRef: string) {
  return owned((await db.select().from(vendorBills).where(eq(vendorBills.billRef, billRef)).limit(1))[0], r => r.financialEntityId, fs, "Bill");
}
export async function purchaseAuthorizationInScope(db: Db, fs: FinanceScope, authorizationRef: string) {
  return owned((await db.select().from(purchaseAuthorizations).where(eq(purchaseAuthorizations.authorizationRef, authorizationRef)).limit(1))[0], r => r.financialEntityId, fs, "Authorization");
}
export async function vendorInScope(db: Db, fs: FinanceScope, vendorId: number) {
  const v = (await db.select().from(vendors).where(and(eq(vendors.id, vendorId), bookOrgWhere(vendors.bookOrgRef, fs))).limit(1))[0];
  if (!v) throw notFound("Vendor");
  return v;
}
export async function vendorByRefInScope(db: Db, fs: FinanceScope, vendorRef: string) {
  const v = (await db.select().from(vendors).where(and(eq(vendors.vendorRef, vendorRef), bookOrgWhere(vendors.bookOrgRef, fs))).limit(1))[0];
  if (!v) throw notFound(`Vendor ${vendorRef}`);
  return v;
}
/** A roadside event has no book: it is the unit's, and the unit's owner is on coreRecordOwnership. */
export async function roadsideEventInScope(db: Db, fs: FinanceScope, eventRef: string) {
  const e = (await db.select().from(roadsideServiceEvents).where(eq(roadsideServiceEvents.eventRef, eventRef)).limit(1))[0];
  if (!e || !(await unitInScope(e.unitId, fs))) throw notFound("Roadside event");
  return e;
}

// ── Operational references a finance record may name ─────────────────────────────────────────────
export async function requireUnit(fs: FinanceScope, unitId: number | null | undefined) {
  if (unitId != null && !(await unitInScope(unitId, fs))) throw notFound("Unit");
}
export async function requireJob(fs: FinanceScope, jobId: number | null | undefined) {
  if (jobId != null && !(await jobInScope(jobId, fs))) throw notFound("Job");
}
export async function requireTrip(fs: FinanceScope, tripId: number | null | undefined) {
  if (tripId != null && !(await tripInScope(tripId, fs))) throw notFound("Trip");
}
/** Evidence attached to a money record must be evidence the caller could open (through its job, else its capturer). */
export async function requireEvidence(fs: FinanceScope, evidenceRecordId: number | null | undefined) {
  if (evidenceRecordId != null && !(await evidenceInScope(evidenceRecordId, fs))) throw notFound("Evidence record");
}
/** A load is scoped through its job; a load with no job belongs to the single tenant only (the 0132 rule). */
export async function requireLoad(db: Db, fs: FinanceScope, loadId: number | null | undefined) {
  if (loadId == null) return;
  const l = (await db.select({ jobId: loads.jobId }).from(loads).where(eq(loads.id, loadId)).limit(1))[0];
  const ok = !!l && (l.jobId != null ? !!(await jobInScope(l.jobId, fs)) : fs.tenantId === SINGLE_TENANT_ID);
  if (!ok) throw notFound("Load");
}

// ── Tax ───────────────────────────────────────────────────────────────────────────────────────────
export async function gstReturnInScope(db: Db, fs: FinanceScope, returnRef: string) {
  return owned((await db.select().from(gstReturns).where(eq(gstReturns.returnRef, returnRef)).limit(1))[0], r => r.financialEntityId, fs, "Return");
}
export async function iftaReturnInScope(db: Db, fs: FinanceScope, returnRef: string) {
  return owned((await db.select().from(iftaReturns).where(eq(iftaReturns.returnRef, returnRef)).limit(1))[0], r => r.financialEntityId, fs, "Return");
}
export async function distanceRecordInScope(db: Db, fs: FinanceScope, distanceRef: string) {
  return owned((await db.select().from(jurisdictionDistanceRecords).where(eq(jurisdictionDistanceRecords.distanceRef, distanceRef)).limit(1))[0], r => r.financialEntityId, fs, "Distance record");
}

// ── Assets ────────────────────────────────────────────────────────────────────────────────────────
export async function assetInScope(db: Db, fs: FinanceScope, assetRef: string) {
  return owned((await db.select().from(capitalAssets).where(eq(capitalAssets.assetRef, assetRef)).limit(1))[0], r => r.financialEntityId, fs, "Asset");
}
export async function ccaScheduleInScope(db: Db, fs: FinanceScope, scheduleRef: string) {
  return owned((await db.select().from(ccaSchedules).where(eq(ccaSchedules.scheduleRef, scheduleRef)).limit(1))[0], r => r.financialEntityId, fs, "Schedule");
}

// ── Fuel ──────────────────────────────────────────────────────────────────────────────────────────
export async function fuelTankInScope(db: Db, fs: FinanceScope, tankRef: string) {
  return owned((await db.select().from(bulkFuelTanks).where(eq(bulkFuelTanks.tankRef, tankRef)).limit(1))[0], r => r.financialEntityId, fs, "Tank");
}
export async function fuelStatementInScope(db: Db, fs: FinanceScope, statementRef: string) {
  return owned((await db.select().from(fuelStatements).where(eq(fuelStatements.statementRef, statementRef)).limit(1))[0], r => r.financialEntityId, fs, "Statement");
}
export async function fuelTransactionInScope(db: Db, fs: FinanceScope, fuelRef: string) {
  return owned((await db.select().from(fuelTransactions).where(eq(fuelTransactions.fuelRef, fuelRef)).limit(1))[0], r => r.financialEntityId, fs, "Fuel transaction");
}
/** A fuel account named alongside a book must be that book's — a card account is not borrowed across books. */
export async function requireFuelAccountOfEntity(db: Db, fuelAccountId: number | null | undefined, financialEntityId: number) {
  if (fuelAccountId == null) return;
  const a = (await db.select({ financialEntityId: fuelAccounts.financialEntityId }).from(fuelAccounts).where(eq(fuelAccounts.id, fuelAccountId)).limit(1))[0];
  if (!a || a.financialEntityId !== financialEntityId) throw notFound("Fuel account");
}

// ── Portal administration ─────────────────────────────────────────────────────────────────────────
export async function externalIdentityInScope(db: Db, fs: FinanceScope, identityRef: string) {
  const i = (await db.select().from(externalIdentities).where(eq(externalIdentities.identityRef, identityRef)).limit(1))[0];
  if (!i || !(await identityOwned(db, fs, i))) throw notFound("Identity");
  return i;
}
async function identityOwned(db: Db, fs: FinanceScope, i: { kind: string; customerAccountId: number | null; vendorId: number | null; invitedByUserId: number | null }): Promise<boolean> {
  if (i.kind === "customer") {
    if (i.customerAccountId == null) return false;
    const a = (await db.select({ financialEntityId: customerAccounts.financialEntityId }).from(customerAccounts).where(eq(customerAccounts.id, i.customerAccountId)).limit(1))[0];
    return !!a && ownsEntity(fs, a.financialEntityId);
  }
  if (i.kind === "vendor") {
    if (i.vendorId == null) return false;
    const v = (await db.select({ bookOrgRef: vendors.bookOrgRef }).from(vendors).where(eq(vendors.id, i.vendorId)).limit(1))[0];
    return !!v && ownsBookOrg(fs, v.bookOrgRef);
  }
  // A facility is a shared directory entry; the identity is the inviting organization's.
  return i.invitedByUserId != null && (await userInScope(i.invitedByUserId, fs));
}
export async function portalSubmissionInScope(db: Db, fs: FinanceScope, submissionRef: string) {
  const s = (await db.select().from(portalSubmissions).where(eq(portalSubmissions.submissionRef, submissionRef)).limit(1))[0];
  if (!s) throw notFound("Submission");
  const i = (await db.select().from(externalIdentities).where(eq(externalIdentities.id, s.externalIdentityId)).limit(1))[0];
  if (!i || !(await identityOwned(db, fs, i))) throw notFound("Submission");
  return { submission: s, identity: i };
}

// ── Audit packages ────────────────────────────────────────────────────────────────────────────────
/**
 * Whether the caller may assemble or see a package about this subject. The subject is resolved by
 * the same key `gather` uses; for the entity-keyed kinds (tax, cor, insurance) the subject is a book.
 */
export async function auditSubjectInScope(db: Db, fs: FinanceScope, kind: string, subjectRef: string): Promise<boolean> {
  switch (kind) {
    case "vehicle": {
      const u = (await db.select({ id: units.id }).from(units).where(eq(units.unitNumber, subjectRef)).limit(1))[0];
      return !!u && !!(await unitInScope(u.id, fs));
    }
    case "driver": return /^\d+$/.test(subjectRef) && !!(await operatorInScope(Number(subjectRef), fs));
    case "vendor": return !!(await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.vendorRef, subjectRef), bookOrgWhere(vendors.bookOrgRef, fs))).limit(1))[0];
    case "job": case "customer": return !!(await fieldTicketInScope(subjectRef, fs));
    case "incident": {
      if (!/^\d+$/.test(subjectRef)) return false;
      const e = (await db.select({ jobId: safetyEvents.jobId }).from(safetyEvents).where(eq(safetyEvents.id, Number(subjectRef))).limit(1))[0];
      if (!e) return false;
      return e.jobId != null ? !!(await jobInScope(e.jobId, fs)) : fs.tenantId === SINGLE_TENANT_ID;
    }
    case "tax": case "cor": case "insurance": return /^\d+$/.test(subjectRef) && ownsEntity(fs, Number(subjectRef));
    default: return false;
  }
}
export async function requireAuditSubject(db: Db, fs: FinanceScope, kind: string, subjectRef: string, what: string) {
  if (!(await auditSubjectInScope(db, fs, kind, subjectRef))) throw notFound(what);
}

// ── WHERE clauses for the rows an audit package gathers alongside its subject ─────────────────────
/** Rows keyed to a job: the job in scope, or (no job) only for the single tenant. */
export function jobKeyedWhere(db: Db, jobIdColumn: MySqlColumn, fs: FinanceScope): SQL {
  const inScope = inArray(jobIdColumn, jobScopeSubquery(db, fs));
  return fs.tenantId === SINGLE_TENANT_ID ? or(inScope, isNull(jobIdColumn))! : inScope;
}
/** Rows keyed to a unit, through its owner. */
export function unitKeyedWhere(unitIdColumn: MySqlColumn, fs: FinanceScope): SQL {
  return ownershipScopeWhere("unit", unitIdColumn, fs)!;
}
/** Rows keyed to a person: a member of the organization, or (single tenant) a person who belongs to none. */
export function userKeyedWhere(db: Db, userIdColumn: MySqlColumn, fs: FinanceScope): SQL {
  const members = db.select({ id: organizationMemberships.userId }).from(organizationMemberships).where(and(eq(organizationMemberships.status, "active"), eq(organizationMemberships.orgRef, fs.tenantId)));
  const anyMember = db.select({ id: organizationMemberships.userId }).from(organizationMemberships).where(eq(organizationMemberships.status, "active"));
  return fs.tenantId === SINGLE_TENANT_ID ? notInArray(userIdColumn, anyMember) : inArray(userIdColumn, members);
}
/** A vendor bill named by id alongside a book must be that book's bill. */
export async function vendorBillIdInScope(db: Db, fs: FinanceScope, billId: number, financialEntityId: number) {
  const b = (await db.select({ financialEntityId: vendorBills.financialEntityId }).from(vendorBills).where(eq(vendorBills.id, billId)).limit(1))[0];
  if (!b || !ownsEntity(fs, b.financialEntityId) || b.financialEntityId !== financialEntityId) throw notFound("Vendor bill");
}
/**
 * An audit package the caller may see: its subject resolves in the caller's scope AND it was prepared by
 * a member of the caller's organization. Both, because a subject key alone can collide across books
 * (`vendors.vendorRef` is not unique) and the package table records no book of its own.
 */
export async function auditPackageInScope(db: Db, fs: FinanceScope, packageRef: string) {
  const p = (await db.select().from(auditPackages).where(eq(auditPackages.packageRef, packageRef)).limit(1))[0];
  if (!p || !(await userInScope(p.preparedByUserId, fs)) || !(await auditSubjectInScope(db, fs, p.kind, p.subjectRef))) throw notFound("Package");
  return p;
}

// ── Insurance (F1.1) ──────────────────────────────────────────────────────────────────────────────
/** A policy is keyed to a book. */
export async function policyInScope(db: Db, fs: FinanceScope, policyRef: string) {
  return owned((await db.select().from(insurancePolicies).where(eq(insurancePolicies.policyRef, policyRef)).limit(1))[0], r => r.financialEntityId, fs, "Policy");
}
/** A claim has no book column; it is its policy's. */
export async function claimInScope(db: Db, fs: FinanceScope, claimRef: string) {
  const c = (await db.select().from(insuranceClaims).where(eq(insuranceClaims.claimRef, claimRef)).limit(1))[0];
  if (!c) throw notFound("Claim");
  const p = (await db.select({ financialEntityId: insurancePolicies.financialEntityId }).from(insurancePolicies).where(eq(insurancePolicies.id, c.insurancePolicyId)).limit(1))[0];
  if (!p || !ownsEntity(fs, p.financialEntityId)) throw notFound("Claim");
  return { claim: c, financialEntityId: p.financialEntityId };
}
/**
 * What a policy may cover, or be asked about: the caller's own units, trailers (units rows) and
 * operators; the caller's own book as "company"; a facility, which is a shared directory entry. An
 * "equipment" or "branch" id has no owner model at all (no equipment table, no branch table), so it is
 * accepted only while ownership is provable (`ownershipDomain`).
 */
export async function requireCoveredEntity(fs: FinanceScope, entityType: string, entityId: number) {
  if (entityType === "unit" || entityType === "trailer") return requireUnit(fs, entityId);
  if (entityType === "operator") { if (!(await operatorInScope(entityId, fs))) throw notFound("Operator"); return; }
  if (entityType === "company") { requireOwnedEntity(fs, entityId, `Financial entity ${entityId}`); return; }
  if (entityType === "facility") return;
  return requireProvableOwnership(`Insurance coverage for a ${entityType}`, "an owner model for that record type exists");
}
/** An incident report by id: through its job, else its unit, else its operator, else the single tenant only. */
export async function requireIncidentReport(db: Db, fs: FinanceScope, incidentReportId: number | null | undefined) {
  if (incidentReportId == null) return;
  const i = (await db.select({ incidentNumber: incidentReports.incidentNumber }).from(incidentReports).where(eq(incidentReports.id, incidentReportId)).limit(1))[0];
  if (!i || !(await incidentInScope(i.incidentNumber, fs))) throw notFound("Incident");
}
/** A roadside event by id: the unit's. */
export async function requireRoadsideEventId(db: Db, fs: FinanceScope, roadsideEventId: number | null | undefined) {
  if (roadsideEventId == null) return;
  const e = (await db.select({ unitId: roadsideServiceEvents.unitId }).from(roadsideServiceEvents).where(eq(roadsideServiceEvents.id, roadsideEventId)).limit(1))[0];
  if (!e || !(await unitInScope(e.unitId, fs))) throw notFound("Roadside event");
}
