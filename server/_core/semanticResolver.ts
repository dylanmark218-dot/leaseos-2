/**
 * Document Control — resolving semantic fields from LeaseOS Records (DC-E).
 *
 * Given the records a document is about (a job, a load, an operator, a unit,
 * a facility, a customer account), read the auto-fillable semantic fields
 * from the authoritative rows and say, for each value, exactly where it came
 * from. Scope is the acting business's: a record another business owns is
 * not found. Nothing here computes a fact; it copies one that a domain
 * already holds, and names the row it copied it from.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { billingBooks, customerAccounts, facilities, jobs, loads, operators, organizations, units } from "../../drizzle/schema";
import { SINGLE_TENANT_ID } from "./actingScope";
import { authorityOf } from "./semanticFields";

type Db = MySql2Database<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type SemanticContext = { jobId?: number | null; loadId?: number | null; operatorId?: number | null; unitId?: number | null; facilityId?: number | null; customerAccountId?: number | null };
export type ResolvedValue = { value: string | number | null; source: string; recordId: number | string };
export type Resolution = { values: Record<string, string | number | null>; provenance: Record<string, ResolvedValue>; notFound: string[]; /** The context after the load supplied its job, operator and unit: the records the document is about. */ context: SemanticContext };

export async function resolveSemanticContext(db: Db | Tx, book: { bookOrgRef: string | null }, ctx: SemanticContext): Promise<Resolution> {
  const values: Record<string, string | number | null> = {};
  const provenance: Record<string, ResolvedValue> = {};
  const notFound: string[] = [];
  const put = (key: string, value: string | number | null | undefined, source: string, recordId: number | string) => { if (authorityOf(key) !== "auto_fill") return; values[key] = value ?? null; provenance[key] = { value: value ?? null, source, recordId }; };
  const orgCond = <T extends { orgRef: any }>(t: T) => book.bookOrgRef ? eq(t.orgRef, book.bookOrgRef) : or(isNull(t.orgRef), eq(t.orgRef, SINGLE_TENANT_ID));

  if (book.bookOrgRef) {
    const o = (await db.select({ orgRef: organizations.orgRef, name: organizations.name }).from(organizations).where(eq(organizations.orgRef, book.bookOrgRef)).limit(1))[0];
    if (o) { put("organization.legalName", o.name, "organizations.name", o.orgRef); put("organization.orgRef", o.orgRef, "organizations.orgRef", o.orgRef); }
  }
  let jobId = ctx.jobId ?? null;
  if (ctx.loadId != null) {
    const l = (await db.select().from(loads).where(eq(loads.id, ctx.loadId)).limit(1))[0];
    const j = l ? (await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, l.jobId), orgCond(jobs))).limit(1))[0] : undefined;
    if (!l || !j) notFound.push(`load ${ctx.loadId}`);
    else {
      jobId ??= l.jobId;
      put("load.loadNumber", l.loadNumber, "loads.loadNumber", l.id); put("load.material", l.material, "loads.material", l.id); put("load.quantity", l.quantity, "loads.quantity", l.id);
      put("load.quantityUnit", l.quantityUnit, "loads.quantityUnit", l.id); put("load.measurementMethod", l.measurementMethod, "loads.measurementMethod", l.id); put("load.loadTicketNumber", l.loadTicketNumber, "loads.loadTicketNumber", l.id);
      if (ctx.operatorId == null && l.operatorId != null) ctx = { ...ctx, operatorId: l.operatorId };
      if (ctx.unitId == null && l.unitId != null) ctx = { ...ctx, unitId: l.unitId };
      if (l.billingBookId != null) {
        const bb = (await db.select().from(billingBooks).where(eq(billingBooks.id, l.billingBookId)).limit(1))[0];
        if (bb) { put("billing.afeNumber", bb.afeNumber, "billingBooks.afeNumber", bb.id); put("billing.purchaseOrder", bb.purchaseOrder, "billingBooks.purchaseOrder", bb.id); put("billing.costCenter", bb.costCenter, "billingBooks.costCenter", bb.id); }
      }
    }
  }
  if (jobId != null) {
    const j = (await db.select().from(jobs).where(and(eq(jobs.id, jobId), orgCond(jobs))).limit(1))[0];
    if (!j) notFound.push(`job ${jobId}`);
    else {
      put("job.jobCode", j.jobCode, "jobs.jobCode", j.id); put("job.customer", j.customer, "jobs.customer", j.id); put("job.location", j.location, "jobs.location", j.id); put("job.type", j.type, "jobs.type", j.id);
      if (values["billing.afeNumber"] === undefined) {
        const bb = (await db.select().from(billingBooks).where(eq(billingBooks.jobId, j.id)).limit(1))[0];
        if (bb) { put("billing.afeNumber", bb.afeNumber, "billingBooks.afeNumber", bb.id); put("billing.purchaseOrder", bb.purchaseOrder, "billingBooks.purchaseOrder", bb.id); put("billing.costCenter", bb.costCenter, "billingBooks.costCenter", bb.id); }
      }
    }
  }
  if (ctx.operatorId != null) {
    const owner = book.bookOrgRef ? sql`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'operator' AND o.recordId = ${operators.id} LIMIT 1) = ${book.bookOrgRef}` : sql`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'operator' AND o.recordId = ${operators.id} LIMIT 1) IS NULL`;
    const op = (await db.select({ id: operators.id, name: operators.name, company: operators.company }).from(operators).where(and(eq(operators.id, ctx.operatorId), owner)).limit(1))[0];
    if (!op) notFound.push(`operator ${ctx.operatorId}`);
    else { put("operator.id", op.id, "operators.id", op.id); put("operator.name", op.name, "operators.name", op.id); put("operator.company", op.company, "operators.company", op.id); }
  }
  if (ctx.unitId != null) {
    const owner = book.bookOrgRef ? sql`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${units.id} LIMIT 1) = ${book.bookOrgRef}` : sql`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${units.id} LIMIT 1) IS NULL`;
    const u = (await db.select({ id: units.id, unitNumber: units.unitNumber, plate: units.plate, vehicleType: units.vehicleType }).from(units).where(and(eq(units.id, ctx.unitId), owner)).limit(1))[0];
    if (!u) notFound.push(`unit ${ctx.unitId}`);
    else { put("unit.unitNumber", u.unitNumber, "units.unitNumber", u.id); put("unit.plate", u.plate, "units.plate", u.id); put("unit.vehicleType", u.vehicleType, "units.vehicleType", u.id); }
  }
  if (ctx.facilityId != null) {
    const fa = (await db.select({ id: facilities.id, name: facilities.name, legalLocation: facilities.legalLocation, regulatorRef: facilities.regulatorRef }).from(facilities).where(eq(facilities.id, ctx.facilityId)).limit(1))[0];
    if (!fa) notFound.push(`facility ${ctx.facilityId}`);
    else { put("facility.id", fa.id, "facilities.id", fa.id); put("facility.name", fa.name, "facilities.name", fa.id); put("facility.legalLocation", fa.legalLocation, "facilities.legalLocation", fa.id); put("facility.regulatorRef", fa.regulatorRef, "facilities.regulatorRef", fa.id); }
  }
  if (ctx.customerAccountId != null) {
    const ca = (await db.select({ id: customerAccounts.id, name: customerAccounts.name, accountRef: customerAccounts.accountRef }).from(customerAccounts).where(and(eq(customerAccounts.id, ctx.customerAccountId), orgCond(customerAccounts))).limit(1))[0];
    if (!ca) notFound.push(`customer account ${ctx.customerAccountId}`);
    else { put("customer.name", ca.name, "customerAccounts.name", ca.id); put("customer.accountRef", ca.accountRef, "customerAccounts.accountRef", ca.id); }
  }
  return { values, provenance, notFound, context: { ...ctx, jobId } };
}
