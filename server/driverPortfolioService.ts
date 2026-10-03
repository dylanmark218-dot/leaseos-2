/**
 * 0212 — the Driver Portfolio API's service layer.
 *
 * Everything here reads or writes the stores that already exist: credentials
 * are `complianceDocuments` owned by the operator, equipment is
 * `operatorEquipmentAuthorizations`, requirements are
 * `driverRequirementBindings`, and the audit is the append-only
 * `driverPortfolioEvents`. The tenant is always the caller's acting scope
 * (`actingScopeFor`), never an organization named in the request, and a record
 * another organization owns is "not found", never "forbidden".
 *
 * Nothing here decides whether somebody can work. The wallet and the Safety
 * view are projections of source records and requirements; the dispatch view
 * is `composeReadiness()`, the pipeline every award already uses, summarized.
 */

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
  complianceDocuments, driverPortfolioEvents, driverRequirementBindings, operatorEquipmentAuthorizations, operators,
} from "../drizzle/schema";
import { getDb, operatorForUserInScope, orgScopeWhere, ownershipScopeWhere, type TenantScope } from "./db";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import {
  credentialType, normalizeCode, requirementFromBinding,
  type DriverPortfolio, type DriverRequirement, type PortfolioCredential, type RequirementBinding,
} from "./_core/driverPortfolio";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CredentialRow = typeof complianceDocuments.$inferSelect;
export type BindingRow = typeof driverRequirementBindings.$inferSelect;

export async function dbOrThrow(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

export const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

/** The orgRef a row is written with: NULL for the historical single tenant (0132). */
export const orgRefFor = (scope: TenantScope): string | null => (scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId);

export const newRef = (prefix: "DRB" | "DPE" | "DCS") => `${prefix}-${randomUUID()}`;

/* ------------------------------------------------------------------ */
/* Operators and portfolios                                             */
/* ------------------------------------------------------------------ */

type OperatorRow = typeof operators.$inferSelect;

/** An operator the caller's organization owns, or "not found". */
export async function operatorInScopeOrThrow(db: Db | Tx, operatorId: number, scope: TenantScope): Promise<OperatorRow> {
  const op = (await db.select().from(operators)
    .where(and(eq(operators.id, operatorId), ownershipScopeWhere("operator", operators.id, scope))).limit(1))[0];
  if (!op) throw notFound("Operator");
  return op;
}

/**
 * The operator record linked to the logged-in user, in the caller's own
 * organization. The request names no operator: self-scope is structural.
 */
export async function myOperator(db: Db, userId: number, scope: TenantScope): Promise<OperatorRow> {
  // OPID: the person's record is resolved in one place, and two records in this organization are a
  // refusal, never a choice of the first row.
  const r = await operatorForUserInScope(userId, scope);
  if (r.kind === "none") throw new TRPCError({ code: "NOT_FOUND", message: "No operator record is linked to your user in this organization" });
  if (r.kind === "ambiguous") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "More than one operator record names this person in this organization" });
  return operatorInScopeOrThrow(db, r.operatorId, scope);
}

export async function operatorCredentials(db: Db | Tx, operatorIds: readonly number[]): Promise<CredentialRow[]> {
  if (!operatorIds.length) return [];
  return db.select().from(complianceDocuments)
    .where(and(eq(complianceDocuments.ownerType, "operator"), inArray(complianceDocuments.ownerId, [...operatorIds])));
}

export const asPortfolioCredential = (c: CredentialRow): PortfolioCredential => ({
  id: c.id, docType: c.docType, title: c.title, issuedAt: c.issuedAt, expiresAt: c.expiresAt, verificationStatus: c.verificationStatus,
  capturedAt: c.capturedAt, identifier: c.identifier, source: c.source, verifiedByUserId: c.verifiedByUserId, verifiedAt: c.verifiedAt,
  privateDetail: c.privateDetail,
});

/**
 * A portfolio as the model reads it. Private credentials (medical fitness and
 * anything else marked private) are left out: they reach dispatch only through
 * `medicalFitnessForDispatch`, and nothing in the portfolio projects them.
 */
export async function loadPortfolios(db: Db | Tx, ops: readonly OperatorRow[]): Promise<{ portfolio: DriverPortfolio; rows: CredentialRow[] }[]> {
  const creds = await operatorCredentials(db, ops.map(o => o.id));
  const userIds = ops.map(o => o.userId).filter((u): u is number => u != null);
  const equipment = userIds.length
    ? await db.select().from(operatorEquipmentAuthorizations).where(inArray(operatorEquipmentAuthorizations.userId, userIds))
    : [];
  return ops.map(op => {
    const rows = creds.filter(c => c.ownerId === op.id && !c.privateDetail);
    return {
      rows,
      portfolio: {
        operatorId: op.id, name: op.name, licenceClass: op.licenseClass ?? null,
        credentials: rows.map(asPortfolioCredential),
        equipment: op.userId == null ? [] : equipment.filter(e => e.userId === op.userId)
          .map(e => ({ equipmentType: e.equipmentType, status: e.status, expiresAt: e.expiresAt, authorizedAt: e.authorizedAt })),
      },
    };
  });
}

/** Every operator the caller's organization owns. */
export async function operatorsInScope(db: Db, scope: TenantScope): Promise<OperatorRow[]> {
  return db.select().from(operators).where(ownershipScopeWhere("operator", operators.id, scope));
}

/* ------------------------------------------------------------------ */
/* Requirements                                                         */
/* ------------------------------------------------------------------ */

export const asBinding = (b: BindingRow): RequirementBinding => ({
  bindingRef: b.bindingRef, orgRef: b.orgRef, subjectType: b.subjectType, subjectCode: b.subjectCode,
  requirementKind: b.requirementKind, requirementCode: b.requirementCode, label: b.label, enforcement: b.enforcement,
  active: b.active, effectiveAt: b.effectiveAt, expiresAt: b.expiresAt,
});

/** In force now, for the caller's organization only. */
const inForce = (b: BindingRow, at: Date) =>
  b.active && (!b.effectiveAt || b.effectiveAt.getTime() <= at.getTime()) && (!b.expiresAt || b.expiresAt.getTime() > at.getTime());

export async function bindingsInScope(db: Db | Tx, scope: TenantScope, opts: { includeRetired?: boolean } = {}): Promise<BindingRow[]> {
  const where = opts.includeRetired
    ? orgScopeWhere(driverRequirementBindings, scope)
    : and(orgScopeWhere(driverRequirementBindings, scope), eq(driverRequirementBindings.active, true));
  return db.select().from(driverRequirementBindings).where(where).orderBy(desc(driverRequirementBindings.id));
}

export async function bindingInScopeOrThrow(db: Db | Tx, bindingRef: string, scope: TenantScope): Promise<BindingRow> {
  const b = (await db.select().from(driverRequirementBindings)
    .where(and(eq(driverRequirementBindings.bindingRef, bindingRef), orgScopeWhere(driverRequirementBindings, scope))).limit(1))[0];
  if (!b) throw notFound("Requirement");
  return b;
}

/** The company baseline: in-force company-wide bindings. It is what the wallet's headline answers to. */
export function companyBaseline(bindings: readonly BindingRow[], at: Date): DriverRequirement[] {
  return bindings.filter(b => b.subjectType === "company" && inForce(b, at)).map(b => requirementFromBinding(asBinding(b)));
}

/** In-force requirements that apply only to some work: a customer, a site, a job type, equipment, a job. */
export function scopedRequirements(bindings: readonly BindingRow[], at: Date): BindingRow[] {
  return bindings.filter(b => b.subjectType !== "company" && inForce(b, at));
}

/**
 * How much a credential type matters to dispatch in this organization, for the
 * dashboard's readiness-impact filter: `mandatory` when any in-force binding
 * demands it, `informational` when bindings only mention it, `none` otherwise.
 */
export function readinessImpact(bindings: readonly BindingRow[], at: Date): (kind: "credential" | "equipment", code: string) => "mandatory" | "informational" | "none" {
  const live = bindings.filter(b => inForce(b, at));
  return (kind, code) => {
    const hits = live.filter(b => b.requirementKind === kind && normalizeCode(b.requirementCode) === normalizeCode(code));
    return hits.some(b => b.enforcement === "mandatory") ? "mandatory" : hits.length ? "informational" : "none";
  };
}

/* ------------------------------------------------------------------ */
/* Audit                                                                */
/* ------------------------------------------------------------------ */

export type PortfolioEventType = typeof driverPortfolioEvents.$inferInsert["eventType"];

/**
 * Append one audit row. Throws on failure: a mutation whose audit cannot be
 * written is refused, the same fail-closed rule `roleProcedure` applies to
 * sensitive permissions. `detail` is a short sentence and never carries a
 * token, a document's contents or a storage reference.
 */
export async function recordPortfolioEvent(db: Db | Tx, e: {
  orgRef: string | null; operatorId: number | null; credentialId?: number | null; actorUserId: number | null;
  eventType: PortfolioEventType; detail: string; at: Date;
}): Promise<string> {
  const eventRef = newRef("DPE");
  await db.insert(driverPortfolioEvents).values({
    eventRef, orgRef: e.orgRef, operatorId: e.operatorId, credentialId: e.credentialId ?? null, actorUserId: e.actorUserId,
    eventType: e.eventType, detail: e.detail.slice(0, 400), occurredAt: e.at,
  });
  return eventRef;
}

/** A read's access row. Best effort: losing one access line is not a reason to refuse the read. */
export async function recordPortfolioView(db: Db, e: Parameters<typeof recordPortfolioEvent>[1]): Promise<void> {
  try { await recordPortfolioEvent(db, e); } catch { /* the authorization decision row still exists */ }
}

/** Who submitted a credential through the portfolio, from its own audit row. Null when it came another way. */
export async function submitterOf(db: Db | Tx, credentialId: number): Promise<number | null> {
  const row = (await db.select({ actor: driverPortfolioEvents.actorUserId }).from(driverPortfolioEvents)
    .where(and(eq(driverPortfolioEvents.credentialId, credentialId), eq(driverPortfolioEvents.eventType, "credential_uploaded")))
    .orderBy(desc(driverPortfolioEvents.id)).limit(1))[0];
  return row?.actor ?? null;
}

/** Portfolio audit rows for one operator, newest first, keyset-paginated on id. */
export async function portfolioEventsPage(db: Db, scope: TenantScope, operatorId: number, limit: number, beforeId: number | null) {
  const rows = await db.select().from(driverPortfolioEvents)
    .where(and(
      eq(driverPortfolioEvents.operatorId, operatorId),
      scope.tenantId === SINGLE_TENANT_ID
        ? or(isNull(driverPortfolioEvents.orgRef), eq(driverPortfolioEvents.orgRef, SINGLE_TENANT_ID))
        : eq(driverPortfolioEvents.orgRef, scope.tenantId),
      beforeId != null ? lt(driverPortfolioEvents.id, beforeId) : undefined,
    ))
    .orderBy(desc(driverPortfolioEvents.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    events: page.map(r => ({ eventRef: r.eventRef, eventType: r.eventType, credentialId: r.credentialId, actorUserId: r.actorUserId, detail: r.detail, occurredAt: r.occurredAt })),
    nextBeforeId: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

/* ------------------------------------------------------------------ */
/* Credential summaries                                                 */
/* ------------------------------------------------------------------ */

/** A credential as the driver or Safety sees it: metadata only, never the storage key or URL. */
export const credentialSummary = (c: CredentialRow | PortfolioCredential & { storageKey?: string | null }) => ({
  credentialId: c.id,
  code: credentialType(c.docType)?.code ?? null,
  docType: c.docType,
  title: c.title,
  identifier: c.identifier ?? null,
  issuedAt: c.issuedAt,
  expiresAt: c.expiresAt,
  verificationStatus: c.verificationStatus,
  verifiedByUserId: c.verifiedByUserId ?? null,
  verifiedAt: c.verifiedAt ?? null,
  capturedAt: c.capturedAt,
  /** Whether a document image is on file. Its contents are served through the evidence vault, not here. */
  hasDocument: "storageKey" in c ? c.storageKey != null : false,
});
