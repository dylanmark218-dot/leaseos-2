import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { SINGLE_TENANT_ID, resolveActingScope } from "./_core/actingScope";
import type { OperatorResolution } from "./_core/operatorIdentity";
import { operatorIdFromRecord } from "./_core/operatorIdentity";
import { drizzle } from "drizzle-orm/mysql2";
import {
  userRoleAssignments,
  roleBootstrapEvents,
  authorizationDecisions,
  externalDataSources,
  type InsertUserRoleAssignment,
  InsertEvidenceRecord,
  InsertJob,
  InsertSafetyEvent,
  InsertRouteContext,
  InsertOperator,
  InsertUnit,
  InsertLoadProfile,
  InsertFacility,
  InsertMaintenanceDefect,
  InsertDelivery,
  InsertSignatureAudit,
  InsertComplianceDocument,
  InsertJobUnit,
  InsertInspection,
  InsertLocationIdentity,
  InsertManifest,
  InsertScanAudit,
  InsertComplianceArtifact,
  InsertTailgateMeeting,
  InsertTransferAcknowledgement,
  InsertBillingRateCard,
  InsertJobChargeLine,
  InsertVendor,
  InsertUnitSafetyPlan,
  InsertRouteDecision,
  InsertTrip,
  InsertTripStop,
  InsertDutyRecord,
  InsertWorkOrder,
  InsertTripBreadcrumb,
  InsertZoneEvent,
  InsertAssistantProposal,
  InsertProposalField,
  assistantProposals,
  proposalFields,
  tripBreadcrumbs,
  zoneEvents,
  billingRateCards,
  routeDecisions,
  trips,
  tripStops,
  dutyRecords,
  workOrders,
  jobChargeLines,
  vendors,
  unitSafetyPlans,
  complianceArtifacts,
  tailgateMeetings,
  transferAcknowledgements,
  complianceDocuments,
  deliveries,
  facilities,
  loadProfiles,
  maintenanceDefects,
  operators,
  signatureAudits,
  units,
  evidenceRecords,
  jobs,
  jobUnits,
  inspections,
  locationIdentities,
  manifests,
  scanAudits,
  routeContexts,
  safetyEvents,
  users,
  externalIdentities,
  integrationClients,
  coreRecordOwnership, organizationInvitationRoles, organizationInvitations, organizationMemberships, organizations, fieldTickets, incidentReports, loads } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { membershipIsLive, type MembershipFact } from "./_core/workspaceAccess";
import { grantsInOrganization, type RoleGrant } from "./_core/recordsAuthorization";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(
  user: typeof users.$inferInsert
): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values: typeof users.$inferInsert = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    textFields.forEach(field => {
      const value = user[field];
      if (value !== undefined) {
        values[field] = value ?? null;
        updateSet[field] = value ?? null;
      }
    });
    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0)
      updateSet.lastSignedIn = new Date();
    await db
      .insert(users)
      .values(values)
      .onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * 0132 — tenant scope for the legacy readers. The `default` scope (a user with
 * no organization membership) sees rows with no owner, which are the historical
 * single tenant's; a member sees rows their organization owns, and nothing else.
 */
export type TenantScope = { tenantId: string };
export function orgScopeWhere<T extends { orgRef: MySqlColumn }>(table: T, scope: TenantScope) {
  return scope.tenantId === SINGLE_TENANT_ID
    ? or(isNull(table.orgRef), eq(table.orgRef, SINGLE_TENANT_ID))
    : eq(table.orgRef, scope.tenantId);
}

export async function listJobs(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobs).where(orgScopeWhere(jobs, scope)).orderBy(desc(jobs.updatedAt)).limit(100);
}

export async function getJobByCode(jobCode: string, scope: TenantScope) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.jobCode, jobCode), orgScopeWhere(jobs, scope)))
    .limit(1);
  return result[0];
}

export async function createJob(input: InsertJob, scope: TenantScope) {
  const db = await getDb();
  if (!db) return undefined;
  // A row created under the default scope stays unowned (legacy); a member's row is theirs.
  const result = await db.insert(jobs).values({ ...input, orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId });
  return result[0]?.insertId;
}

export async function listEvidenceRecords(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(evidenceRecords)
    .where(jobKeyedScope(db, evidenceRecords.jobId, scope))
    .orderBy(desc(evidenceRecords.capturedAt))
    .limit(100);
}

export async function findEvidenceByClientCaptureRef(clientCaptureRef: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select({ id: evidenceRecords.id, storageKey: evidenceRecords.storageKey, storageUrl: evidenceRecords.storageUrl }).from(evidenceRecords).where(eq(evidenceRecords.clientCaptureRef, clientCaptureRef)).limit(1);
  return rows[0];
}

export async function createEvidenceRecord(input: InsertEvidenceRecord) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(evidenceRecords).values(input);
  return result[0]?.insertId;
}

export async function verifyEvidenceRecord(id: number) {
  const db = await getDb();
  if (!db) return false;
  await db
    .update(evidenceRecords)
    .set({ status: "verified" })
    .where(eq(evidenceRecords.id, id));
  return true;
}

export async function listRouteContexts() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(routeContexts)
    .orderBy(desc(routeContexts.verifiedAt))
    .limit(100);
}

export async function createRouteContext(input: InsertRouteContext) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(routeContexts).values(input);
  return result[0]?.insertId;
}

export async function listSafetyEvents(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(safetyEvents)
    .where(jobKeyedScope(db, safetyEvents.jobId, scope))
    .orderBy(desc(safetyEvents.occurredAt))
    .limit(100);
}

export async function createSafetyEvent(input: InsertSafetyEvent) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(safetyEvents).values(input);
  return result[0]?.insertId;
}

export async function listTrips(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(trips).where(orgScopeWhere(trips, scope)).orderBy(desc(trips.updatedAt)).limit(200);
}
export async function createTrip(input: InsertTrip, scope: TenantScope) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(trips).values({ ...input, orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId });
  return result[0]?.insertId;
}
export async function updateTrip(id: number, input: Partial<InsertTrip>) {
  const db = await getDb();
  if (!db) return false;
  await db.update(trips).set(input).where(eq(trips.id, id));
  return true;
}
export async function listTripStops(tripId: number | undefined, scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(tripStops)
    .where(tripId ? and(eq(tripStops.tripId, tripId), tripKeyedScope(db, tripStops.tripId, scope)) : tripKeyedScope(db, tripStops.tripId, scope))
    .orderBy(tripStops.sequence)
    .limit(500);
}
export async function createTripStop(input: InsertTripStop) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(tripStops).values(input);
  return result[0]?.insertId;
}
export async function updateTripStop(
  id: number,
  input: Partial<InsertTripStop>
) {
  const db = await getDb();
  if (!db) return false;
  await db.update(tripStops).set(input).where(eq(tripStops.id, id));
  return true;
}
// P0-A2.1 — `listOperatingZones`, `createOperatingZone` and `listActiveOperatingZones` (every
// organization's zones, and the engine's "all active zones") are retired; the scoped forms are in
// server/operatingZoneScope.ts.

export async function createTripBreadcrumb(input: InsertTripBreadcrumb) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(tripBreadcrumbs).values(input);
  return result[0]?.insertId;
}
export async function listTripBreadcrumbs(tripId: number, limit = 500) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(tripBreadcrumbs)
    .where(eq(tripBreadcrumbs.tripId, tripId))
    .orderBy(desc(tripBreadcrumbs.recordedAt))
    .limit(limit);
}

export async function createZoneEvent(input: InsertZoneEvent) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(zoneEvents).values(input);
  return result[0]?.insertId;
}
export async function updateZoneEvent(
  id: number,
  input: Partial<InsertZoneEvent>
) {
  const db = await getDb();
  if (!db) return false;
  await db.update(zoneEvents).set(input).where(eq(zoneEvents.id, id));
  return true;
}
// P0-A2 — `listZoneEvents` (every organization's proposals when no trip was named) is retired;
// the scoped list is `listZoneEventsInScope` in server/telematicsScope.ts.

/**
 * Derive each zone's current inside/outside state for a trip from its
 * zoneEvent history — the most recent event per zone wins. This means the
 * "previous state" the geofence engine compares against is always whatever
 * was last detected, confirmed or not, not a separately-maintained cache
 * that could drift out of sync.
 */
export async function getRecentZoneStateForTrip(
  tripId: number
): Promise<Map<number, boolean>> {
  const state = new Map<number, boolean>();
  const db = await getDb();
  if (!db) return state;
  const rows = await db
    .select()
    .from(zoneEvents)
    .where(eq(zoneEvents.tripId, tripId))
    .orderBy(desc(zoneEvents.detectedAt))
    .limit(200);
  for (const row of rows) {
    if (!state.has(row.zoneId))
      state.set(row.zoneId, row.eventType === "enter");
  }
  return state;
}
// P0-A1 — `listDutyRecords(operatorId?)` used to live here: every company's duty records when no
// operator was named. It is gone rather than guarded, so the unscoped form cannot be called back
// into use; the list is `listDutyRecordsInScope` in server/hosScope.ts.
export async function createDutyRecord(input: InsertDutyRecord) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(dutyRecords).values(input);
  return result[0]?.insertId;
}
export async function listWorkOrders(unitId?: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(workOrders)
    .where(unitId ? eq(workOrders.unitId, unitId) : undefined)
    .orderBy(desc(workOrders.updatedAt))
    .limit(200);
}
export async function createWorkOrder(input: InsertWorkOrder) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(workOrders).values(input);
  return result[0]?.insertId;
}
export async function updateWorkOrder(
  id: number,
  input: Partial<InsertWorkOrder>
) {
  const db = await getDb();
  if (!db) return false;
  await db.update(workOrders).set(input).where(eq(workOrders.id, id));
  return true;
}

export async function listRouteDecisions(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(routeDecisions)
    .where(tripRefScope(db, routeDecisions.tripId, scope))
    .orderBy(desc(routeDecisions.createdAt))
    .limit(100);
}
export async function createRouteDecision(input: InsertRouteDecision) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(routeDecisions).values(input);
  return result[0]?.insertId;
}
export async function listBillingRateCards(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(billingRateCards)
    .where(orgScopeWhere(billingRateCards, scope))
    .orderBy(desc(billingRateCards.updatedAt))
    .limit(100);
}
export async function createBillingRateCard(input: InsertBillingRateCard, scope: TenantScope) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(billingRateCards).values({ ...input, orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId });
  return result[0]?.insertId;
}
export async function listJobChargeLines(jobId: number | undefined, scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(jobChargeLines)
    .where(jobId ? and(eq(jobChargeLines.jobId, jobId), jobKeyedScope(db, jobChargeLines.jobId, scope)) : jobKeyedScope(db, jobChargeLines.jobId, scope))
    .orderBy(desc(jobChargeLines.createdAt))
    .limit(100);
}
export async function createJobChargeLine(input: InsertJobChargeLine) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(jobChargeLines).values(input);
  return result[0]?.insertId;
}
/** The book (business) that keeps a vendor record, under the 0132 record rule. */
function vendorBookWhere(scope: TenantScope) {
  return scope.tenantId === SINGLE_TENANT_ID ? isNull(vendors.bookOrgRef) : eq(vendors.bookOrgRef, scope.tenantId);
}
export async function listVendors(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(vendors).where(vendorBookWhere(scope)).orderBy(vendors.name).limit(100);
}
export async function createVendor(input: InsertVendor, scope: TenantScope) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(vendors).values({ ...input, bookOrgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId });
  return result[0]?.insertId;
}
export async function listUnitSafetyPlans(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(unitSafetyPlans)
    .where(unitKeyedScope(unitSafetyPlans.unitId, scope))
    .orderBy(desc(unitSafetyPlans.updatedAt))
    .limit(100);
}
export async function createUnitSafetyPlan(input: InsertUnitSafetyPlan) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(unitSafetyPlans).values(input);
  return result[0]?.insertId;
}
export async function updateBillingRateCard(
  id: number,
  input: Partial<InsertBillingRateCard>
) {
  const db = await getDb();
  if (!db) return false;
  await db
    .update(billingRateCards)
    .set(input)
    .where(eq(billingRateCards.id, id));
  return true;
}
export async function updateVendor(id: number, input: Partial<InsertVendor>, scope: TenantScope) {
  const db = await getDb();
  if (!db) return false;
  const inScope = (await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, id), vendorBookWhere(scope))).limit(1))[0];
  if (!inScope) return false;   // not this book's vendor: "not found" at the router
  await db.update(vendors).set(input).where(eq(vendors.id, id));
  return true;
}
export async function updateUnitSafetyPlan(
  id: number,
  input: Partial<InsertUnitSafetyPlan>
) {
  const db = await getDb();
  if (!db) return false;
  await db.update(unitSafetyPlans).set(input).where(eq(unitSafetyPlans.id, id));
  return true;
}

export async function listComplianceArtifacts(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(complianceArtifacts)
    .where(jobKeyedScope(db, complianceArtifacts.jobId, scope))
    .orderBy(desc(complianceArtifacts.createdAt))
    .limit(100);
}
export async function createComplianceArtifact(
  input: InsertComplianceArtifact
) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(complianceArtifacts).values(input);
  return result[0]?.insertId;
}
export async function listTailgateMeetings(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(tailgateMeetings)
    .where(jobKeyedScope(db, tailgateMeetings.jobId, scope))
    .orderBy(desc(tailgateMeetings.createdAt))
    .limit(100);
}
export async function createTailgateMeeting(input: InsertTailgateMeeting) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(tailgateMeetings).values(input);
  return result[0]?.insertId;
}
export async function listTransferAcknowledgements(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  const subs = trackingScopeSubqueries(db, scope);
  const inScope = or(...subs.map(s => inArray(transferAcknowledgements.trackingNumber, s)));
  return db
    .select()
    .from(transferAcknowledgements)
    .where(scope.tenantId === SINGLE_TENANT_ID ? or(inScope, and(...allTrackingSubqueries(db).map(s => notInArray(transferAcknowledgements.trackingNumber, s)))) : inScope)
    .orderBy(desc(transferAcknowledgements.createdAt))
    .limit(100);
}
export async function createTransferAcknowledgement(
  input: InsertTransferAcknowledgement
) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(transferAcknowledgements).values(input);
  return result[0]?.insertId;
}
export async function acknowledgeTransfer(id: number, acknowledgedBy: string) {
  const db = await getDb();
  if (!db) return false;
  await db
    .update(transferAcknowledgements)
    .set({
      deliveryStatus: "confirmed",
      acknowledgedBy,
      acknowledgedAt: new Date(),
    })
    .where(eq(transferAcknowledgements.id, id));
  return true;
}

export async function listLocationIdentities() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(locationIdentities)
    .orderBy(desc(locationIdentities.lastVerifiedAt))
    .limit(100);
}

export async function createLocationIdentity(input: InsertLocationIdentity) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(locationIdentities).values(input);
  return result[0]?.insertId;
}

export async function listManifests(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(manifests)
    .where(orgScopeWhere(manifests, scope))
    .orderBy(desc(manifests.createdAt))
    .limit(100);
}

export async function createManifest(input: InsertManifest, scope: TenantScope) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(manifests).values({ ...input, orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId });
  return result[0]?.insertId;
}

export async function listScanAudits(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(scanAudits)
    .where(scope.tenantId === SINGLE_TENANT_ID ? isNull(scanSubjectOwnerOrg) : eq(scanSubjectOwnerOrg, scope.tenantId))
    .orderBy(desc(scanAudits.scannedAt))
    .limit(100);
}

export async function createScanAudit(input: InsertScanAudit) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(scanAudits).values(input);
  return result[0]?.insertId;
}

export async function listJobUnits(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobUnits).where(jobKeyedScope(db, jobUnits.jobId, scope)).orderBy(desc(jobUnits.joinedAt)).limit(100);
}

export async function listInspections(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(inspections)
    .where(unitKeyedScope(inspections.unitId, scope))
    .orderBy(desc(inspections.observedAt))
    .limit(100);
}

export async function createInspection(input: InsertInspection) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(inspections).values(input);
  return result[0]?.insertId;
}

/**
 * P4.1 router 3 — a compliance document belongs to whoever owns the record it
 * is about: operators and units (and trailers/equipment, which are units)
 * through coreRecordOwnership, jobs through jobs.orgRef. A carrier or user
 * document has no organization owner on this branch and stays with the
 * default scope. Nothing here guesses.
 */
const documentOwnerOrg = sql<string | null>`(
  CASE ${complianceDocuments.ownerType}
    WHEN 'operator' THEN (SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'operator' AND o.recordId = ${complianceDocuments.ownerId} LIMIT 1)
    WHEN 'unit' THEN (SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${complianceDocuments.ownerId} LIMIT 1)
    WHEN 'trailer' THEN (SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${complianceDocuments.ownerId} LIMIT 1)
    WHEN 'equipment' THEN (SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${complianceDocuments.ownerId} LIMIT 1)
    WHEN 'job' THEN (SELECT j.orgRef FROM jobs j WHERE j.id = ${complianceDocuments.ownerId} LIMIT 1)
    ELSE NULL
  END)`;

/** The document-owner rule above as a predicate, so every reader of complianceDocuments applies the same one. */
export function complianceDocumentScopeWhere(scope: TenantScope) {
  return scope.tenantId === SINGLE_TENANT_ID ? isNull(documentOwnerOrg) : eq(documentOwnerOrg, scope.tenantId);
}

/** An organization's list is its newest hundred; one owner's is up to this many, and a caller that receives this many must not assume it has them all. */
export const OWNER_DOCUMENT_LIST_CAP = 500;

export async function listComplianceDocuments(scope: TenantScope, owner?: { ownerType: InsertComplianceDocument["ownerType"]; ownerId: number }) {
  const db = await getDb();
  if (!db) return [];
  const inScope = complianceDocumentScopeWhere(scope);
  return db
    .select()
    .from(complianceDocuments)
    .where(owner ? and(inScope, eq(complianceDocuments.ownerType, owner.ownerType), eq(complianceDocuments.ownerId, owner.ownerId)) : inScope)
    .orderBy(desc(complianceDocuments.createdAt))
    .limit(owner ? OWNER_DOCUMENT_LIST_CAP : 100);
}

/** The organization that owns a document's subject record, or null when nobody does. */
export async function documentSubjectOwner(ownerType: InsertComplianceDocument["ownerType"], ownerId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  if (ownerType === "operator" || ownerType === "unit" || ownerType === "trailer" || ownerType === "equipment") {
    const recordType = ownerType === "operator" ? "operator" : "unit";
    const row = (await db.select({ orgRef: coreRecordOwnership.orgRef }).from(coreRecordOwnership)
      .where(and(eq(coreRecordOwnership.recordType, recordType), eq(coreRecordOwnership.recordId, ownerId))).limit(1))[0];
    return row?.orgRef ?? null;
  }
  if (ownerType === "job") {
    const row = (await db.select({ orgRef: jobs.orgRef }).from(jobs).where(eq(jobs.id, ownerId)).limit(1))[0];
    return row?.orgRef ?? null;
  }
  return null;
}

export async function createComplianceDocument(
  input: InsertComplianceDocument,
  scope: TenantScope,
) {
  const db = await getDb();
  if (!db) return undefined;
  // A member may not file a document against a record another organization owns.
  const owner = await documentSubjectOwner(input.ownerType, input.ownerId);
  if (scope.tenantId !== SINGLE_TENANT_ID && owner !== null && owner !== scope.tenantId) throw new Error("DOCUMENT_SUBJECT_OWNED_BY_ANOTHER_ORGANIZATION");
  const result = await db.insert(complianceDocuments).values(input);
  return result[0]?.insertId;
}

export async function reviewComplianceDocument(
  id: number,
  status: "verified" | "rejected",
  scope: TenantScope,
) {
  const db = await getDb();
  if (!db) return false;
  // P4.1: only a document whose owner (operator, unit, job) is in scope can be reviewed here; otherwise "not found".
  const inScope = (await db.select({ id: complianceDocuments.id }).from(complianceDocuments)
    .where(and(eq(complianceDocuments.id, id), scope.tenantId === SINGLE_TENANT_ID ? isNull(documentOwnerOrg) : eq(documentOwnerOrg, scope.tenantId))).limit(1))[0];
  if (!inScope) return false;
  await db
    .update(complianceDocuments)
    .set({ verificationStatus: status })
    .where(eq(complianceDocuments.id, id));
  return true;
}

/**
 * P4.1 router 2 — units and operators are scoped through coreRecordOwnership,
 * the table that already answers recordBelongsToOrganization for them. No new
 * column: the default scope sees records with no owner (the historical single
 * tenant's); a member sees records their organization owns. A record created by
 * a member is assigned to their organization in the same call.
 */
export function ownershipScopeWhere(recordType: "unit" | "operator", idColumn: MySqlColumn, scope: TenantScope) {
  const owner = db_sub(recordType, idColumn);
  return scope.tenantId === SINGLE_TENANT_ID ? isNull(owner) : eq(owner, scope.tenantId);
}
/** Correlated subquery: the owning organization of this record, or NULL. */
function db_sub(recordType: "unit" | "operator", idColumn: MySqlColumn) {
  return sql<string | null>`(SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = ${recordType} AND o.recordId = ${idColumn} LIMIT 1)`;
}

/** P4.1 router 4 — the acting scope for a caller, for routers that key rows to units or operators. */
export async function actingScopeFor(userId: number): Promise<TenantScope> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return { tenantId: (await resolveActingScope(db, userId)).tenantId };
}
/** A unit the scope may see, or null. "Not found" is the only answer for one it may not — never "forbidden". */
export async function unitInScope(unitId: number, scope: TenantScope): Promise<{ id: number; unitNumber: string } | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select({ id: units.id, unitNumber: units.unitNumber }).from(units).where(and(eq(units.id, unitId), ownershipScopeWhere("unit", units.id, scope))).limit(1))[0] ?? null;
}
/** A work order the scope may see (through its unit), by number or by id, or null. */
export async function workOrderInScope(key: string | number, scope: TenantScope): Promise<{ id: number; unitId: number } | null> {
  const db = await getDb();
  if (!db) return null;
  const byKey = typeof key === "number" ? eq(workOrders.id, key) : eq(workOrders.workOrderNumber, key);
  return (await db.select({ id: workOrders.id, unitId: workOrders.unitId }).from(workOrders).where(and(byKey, ownershipScopeWhere("unit", workOrders.unitId, scope))).limit(1))[0] ?? null;
}

/**
 * A person the scope may see: for an organization, a user with an active membership in it; for the
 * historical single tenant, a user with no active membership anywhere. "Not found" otherwise.
 */
export async function userInScope(userId: number, scope: TenantScope): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const active = await db.select({ orgRef: organizationMemberships.orgRef }).from(organizationMemberships).where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active")));
  return scope.tenantId === SINGLE_TENANT_ID ? active.length === 0 : active.some(m => m.orgRef === scope.tenantId);
}

/** A job the scope may see (jobs.orgRef, 0132), or null. */
export async function jobInScope(jobId: number, scope: TenantScope): Promise<{ id: number; jobCode: string } | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select({ id: jobs.id, jobCode: jobs.jobCode }).from(jobs).where(and(eq(jobs.id, jobId), orgScopeWhere(jobs, scope))).limit(1))[0] ?? null;
}
/**
 * A field ticket the scope may see, or null: through its job when it has one, else through its unit's
 * owner, else only for the historical single tenant (nothing owns it). Not found otherwise.
 */
export async function fieldTicketInScope(ticketNumber: string, scope: TenantScope): Promise<{ id: number; jobId: number | null; unitId: number | null } | null> {
  const db = await getDb();
  if (!db) return null;
  const t = (await db.select({ id: fieldTickets.id, jobId: fieldTickets.jobId, unitId: fieldTickets.unitId }).from(fieldTickets).where(eq(fieldTickets.ticketNumber, ticketNumber)).limit(1))[0];
  if (!t) return null;
  if (t.jobId != null) return (await jobInScope(t.jobId, scope)) ? t : null;
  if (t.unitId != null) return (await unitInScope(t.unitId, scope)) ? t : null;
  return scope.tenantId === SINGLE_TENANT_ID ? t : null;
}

/** An operator the scope may see (coreRecordOwnership), or null. */
export async function operatorInScope(operatorId: number, scope: TenantScope): Promise<{ id: number } | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select({ id: operators.id }).from(operators).where(and(eq(operators.id, operatorId), ownershipScopeWhere("operator", operators.id, scope))).limit(1))[0] ?? null;
}
/**
 * This person's own operator record in the scope: `operators.userId`, filtered by the same
 * ownership rule as `operatorInScope`. A record owned by another organization is not theirs here.
 * `operators.userId` is not unique, so two records naming the same person is `ambiguous` — a
 * refusal, never the first row. Fetches two rows at most, which is all that question needs.
 */
export async function operatorForUserInScope(userId: number, scope: TenantScope): Promise<OperatorResolution> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select({ id: operators.id }).from(operators)
    .where(and(eq(operators.userId, userId), ownershipScopeWhere("operator", operators.id, scope))).limit(2);
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "ambiguous" };
  return { kind: "resolved", operatorId: operatorIdFromRecord(rows[0]!.id) };
}
/**
 * An evidence record the scope may see, or null: through its job when it has one, else through the
 * person who captured it, else only for the historical single tenant.
 */
export async function evidenceInScope(evidenceId: number, scope: TenantScope): Promise<{ id: number } | null> {
  const db = await getDb();
  if (!db) return null;
  const e = (await db.select({ id: evidenceRecords.id, jobId: evidenceRecords.jobId, capturedBy: evidenceRecords.capturedBy }).from(evidenceRecords).where(eq(evidenceRecords.id, evidenceId)).limit(1))[0];
  if (!e) return null;
  if (e.jobId != null) return (await jobInScope(e.jobId, scope)) ? { id: e.id } : null;
  if (e.capturedBy != null) return (await userInScope(e.capturedBy, scope)) ? { id: e.id } : null;
  return scope.tenantId === SINGLE_TENANT_ID ? { id: e.id } : null;
}
/** An incident report the scope may see, or null: through its job, else its unit, else its operator, else the single tenant only. */
export async function incidentInScope(incidentNumber: string, scope: TenantScope): Promise<{ id: number } | null> {
  const db = await getDb();
  if (!db) return null;
  const i = (await db.select({ id: incidentReports.id, jobId: incidentReports.jobId, unitId: incidentReports.unitId, operatorId: incidentReports.operatorId }).from(incidentReports).where(eq(incidentReports.incidentNumber, incidentNumber)).limit(1))[0];
  if (!i) return null;
  if (i.jobId != null) return (await jobInScope(i.jobId, scope)) ? { id: i.id } : null;
  if (i.unitId != null) return (await unitInScope(i.unitId, scope)) ? { id: i.id } : null;
  if (i.operatorId != null) return (await operatorInScope(i.operatorId, scope)) ? { id: i.id } : null;
  return scope.tenantId === SINGLE_TENANT_ID ? { id: i.id } : null;
}

/**
 * `incidentInScope`'s rule as a predicate over many rows: through the job when there is one, else the
 * unit's owner, else the operator's owner, else the historical single tenant only. For every table that
 * carries the same three references (incidentReports, nearMissReports). The precedence is the point —
 * a row with a job is decided by its job even when its unit is owned by somebody else.
 */
export function jobUnitOperatorScopeWhere(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  cols: { jobId: MySqlColumn; unitId: MySqlColumn; operatorId: MySqlColumn },
  scope: TenantScope,
) {
  const branches = [
    and(isNotNull(cols.jobId), inArray(cols.jobId, jobScopeSubquery(db, scope))),
    and(isNull(cols.jobId), isNotNull(cols.unitId), ownershipScopeWhere("unit", cols.unitId, scope)),
    and(isNull(cols.jobId), isNull(cols.unitId), isNotNull(cols.operatorId), ownershipScopeWhere("operator", cols.operatorId, scope)),
  ];
  if (scope.tenantId === SINGLE_TENANT_ID) branches.push(and(isNull(cols.jobId), isNull(cols.unitId), isNull(cols.operatorId)));
  return or(...branches);
}

/** Subquery of job ids the scope may see; `inArray(col, jobScopeSubquery(db, scope))`. */
export function jobScopeSubquery(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, scope: TenantScope) {
  return db.select({ id: jobs.id }).from(jobs).where(orgScopeWhere(jobs, scope));
}
/** Subquery of trip ids the scope may see (trips carry orgRef since 0132). */
export function tripScopeSubquery(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, scope: TenantScope) {
  return db.select({ id: trips.id }).from(trips).where(orgScopeWhere(trips, scope));
}
/** A trip the scope may see, or null. */
export async function tripInScope(tripId: number, scope: TenantScope): Promise<{ id: number; jobId: number | null } | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select({ id: trips.id, jobId: trips.jobId }).from(trips).where(and(eq(trips.id, tripId), orgScopeWhere(trips, scope))).limit(1))[0] ?? null;
}
/** Rows keyed to a job: the job in scope, or (no job) only for the single tenant. */
function jobKeyedScope(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, jobIdColumn: MySqlColumn, scope: TenantScope) {
  const inScope = inArray(jobIdColumn, jobScopeSubquery(db, scope));
  return scope.tenantId === SINGLE_TENANT_ID ? or(inScope, isNull(jobIdColumn)) : inScope;
}
function tripKeyedScope(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, tripIdColumn: MySqlColumn, scope: TenantScope) {
  const inScope = inArray(tripIdColumn, tripScopeSubquery(db, scope));
  return scope.tenantId === SINGLE_TENANT_ID ? or(inScope, isNull(tripIdColumn)) : inScope;
}
/**
 * Rows whose trip reference is free text (routeDecisions.tripId): a trip number or an id as text.
 * In scope when it names a trip the scope may see; text naming no trip at all is unowned — the
 * single tenant's, and nobody else's.
 */
function tripRefScope(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, refColumn: MySqlColumn, scope: TenantScope) {
  const numbers = db.select({ n: trips.tripNumber }).from(trips).where(orgScopeWhere(trips, scope));
  const ids = db.select({ n: trips.id }).from(trips).where(orgScopeWhere(trips, scope));
  // The text side is cast to a number for the id match (non-numeric text becomes 0, which no trip has), which
  // avoids comparing two collations.
  const asNumber = sql`CAST(${refColumn} AS UNSIGNED)`;
  const inScope = or(inArray(refColumn, numbers), inArray(asNumber, ids));
  if (scope.tenantId !== SINGLE_TENANT_ID) return inScope;
  const anyNumber = db.select({ n: trips.tripNumber }).from(trips), anyId = db.select({ n: trips.id }).from(trips);
  return or(inScope, and(notInArray(refColumn, anyNumber), notInArray(asNumber, anyId)));
}

/** An assistant proposal the scope may see, or null: through its job, else its trip, else its unit, else the single tenant only. */
export async function proposalInScope(proposalId: string, scope: TenantScope): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const p = (await db.select({ jobId: assistantProposals.jobId, tripId: assistantProposals.tripId, unitId: assistantProposals.unitId }).from(assistantProposals).where(eq(assistantProposals.proposalId, proposalId)).limit(1))[0];
  if (!p) return true;   // nothing to hide; the procedure answers its own not-found
  if (p.jobId != null) return !!(await jobInScope(p.jobId, scope));
  if (p.tripId != null) return !!(await tripInScope(p.tripId, scope));
  if (p.unitId != null) return !!(await unitInScope(p.unitId, scope));
  return scope.tenantId === SINGLE_TENANT_ID;
}

/** A billing rate card the scope may see, or null. */
export async function rateCardInScope(id: number, scope: TenantScope): Promise<{ id: number } | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select({ id: billingRateCards.id }).from(billingRateCards).where(and(eq(billingRateCards.id, id), orgScopeWhere(billingRateCards, scope))).limit(1))[0] ?? null;
}

/** Rows keyed to a unit: the unit's owner in scope (coreRecordOwnership). */
function unitKeyedScope(unitIdColumn: MySqlColumn, scope: TenantScope) {
  return ownershipScopeWhere("unit", unitIdColumn, scope);
}
/** A manifest the scope may see (manifests.orgRef, written since 0148), by number, or null. */
export async function manifestInScope(manifestNumber: string, scope: TenantScope): Promise<{ id: number } | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select({ id: manifests.id }).from(manifests).where(and(eq(manifests.manifestNumber, manifestNumber), orgScopeWhere(manifests, scope))).limit(1))[0] ?? null;
}

/** The organization that owns a scanned subject, or NULL: units/trailers/equipment and operators through ownership, jobs through orgRef. */
const scanSubjectOwnerOrg = sql<string | null>`(
  CASE ${scanAudits.subjectType}
    WHEN 'operator' THEN (SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'operator' AND o.recordId = ${scanAudits.subjectId} LIMIT 1)
    WHEN 'unit' THEN (SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${scanAudits.subjectId} LIMIT 1)
    WHEN 'trailer' THEN (SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${scanAudits.subjectId} LIMIT 1)
    WHEN 'equipment' THEN (SELECT o.orgRef FROM coreRecordOwnership o WHERE o.recordType = 'unit' AND o.recordId = ${scanAudits.subjectId} LIMIT 1)
    WHEN 'job' THEN (SELECT j.orgRef FROM jobs j WHERE j.id = ${scanAudits.subjectId} LIMIT 1)
    ELSE NULL
  END)`;
/** A tracking number's subject in scope: a trip, job, manifest, field ticket or load by its number; a number naming none is unowned. */
export async function trackingSubjectInScope(trackingNumber: string, scope: TenantScope): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const t = (await db.select({ id: trips.id }).from(trips).where(eq(trips.tripNumber, trackingNumber)).limit(1))[0];
  if (t) return !!(await tripInScope(t.id, scope));
  const j = (await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.jobCode, trackingNumber)).limit(1))[0];
  if (j) return !!(await jobInScope(j.id, scope));
  if ((await db.select({ id: manifests.id }).from(manifests).where(eq(manifests.manifestNumber, trackingNumber)).limit(1))[0]) return !!(await manifestInScope(trackingNumber, scope));
  const ft = (await db.select({ id: fieldTickets.id }).from(fieldTickets).where(eq(fieldTickets.ticketNumber, trackingNumber)).limit(1))[0];
  if (ft) return !!(await fieldTicketInScope(trackingNumber, scope));
  const ld = (await db.select({ jobId: loads.jobId }).from(loads).where(eq(loads.loadNumber, trackingNumber)).limit(1))[0];
  if (ld) return ld.jobId != null ? !!(await jobInScope(ld.jobId, scope)) : scope.tenantId === SINGLE_TENANT_ID;
  return scope.tenantId === SINGLE_TENANT_ID;
}
/** Subquery of tracking numbers the scope may see, for filtering rows keyed only by a tracking number. */
function trackingScopeSubqueries(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, scope: TenantScope) {
  return [
    db.select({ n: trips.tripNumber }).from(trips).where(orgScopeWhere(trips, scope)),
    db.select({ n: jobs.jobCode }).from(jobs).where(orgScopeWhere(jobs, scope)),
    db.select({ n: manifests.manifestNumber }).from(manifests).where(orgScopeWhere(manifests, scope)),
    db.select({ n: fieldTickets.ticketNumber }).from(fieldTickets).where(inArray(fieldTickets.jobId, jobScopeSubquery(db, scope))),
    db.select({ n: loads.loadNumber }).from(loads).where(inArray(loads.jobId, jobScopeSubquery(db, scope))),
  ];
}

function allTrackingSubqueries(db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  return [
    db.select({ n: trips.tripNumber }).from(trips),
    db.select({ n: jobs.jobCode }).from(jobs),
    db.select({ n: manifests.manifestNumber }).from(manifests),
    db.select({ n: fieldTickets.ticketNumber }).from(fieldTickets),
    db.select({ n: loads.loadNumber }).from(loads),
  ];
}

/** The tracking number a transfer acknowledgement names, or null. */
export async function transferTrackingNumber(id: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select({ trackingNumber: transferAcknowledgements.trackingNumber }).from(transferAcknowledgements).where(eq(transferAcknowledgements.id, id)).limit(1))[0]?.trackingNumber ?? null;
}

/** Parent lookups for the monolith's by-id updates: the trip behind a stop, the unit behind a safety plan. (P0-A2: the zone-event lookup moved into server/telematicsScope.ts as `requireZoneEventInScope`.) */
export async function tripStopTripId(id: number): Promise<number | null> {
  const db = await getDb(); if (!db) return null;
  return (await db.select({ tripId: tripStops.tripId }).from(tripStops).where(eq(tripStops.id, id)).limit(1))[0]?.tripId ?? null;
}
export async function unitSafetyPlanUnitId(id: number): Promise<number | null> {
  const db = await getDb(); if (!db) return null;
  return (await db.select({ unitId: unitSafetyPlans.unitId }).from(unitSafetyPlans).where(eq(unitSafetyPlans.id, id)).limit(1))[0]?.unitId ?? null;
}
/** A trip named by free text — its number or its id as text — in scope, or (naming no trip) the single tenant's. */
export async function tripRefInScope(ref: string, scope: TenantScope): Promise<boolean> {
  const db = await getDb(); if (!db) return false;
  const byNumber = (await db.select({ id: trips.id }).from(trips).where(eq(trips.tripNumber, ref)).limit(1))[0];
  const byId = /^\d+$/.test(ref) ? (await db.select({ id: trips.id }).from(trips).where(eq(trips.id, Number(ref))).limit(1))[0] : undefined;
  const t = byNumber ?? byId;
  return t ? !!(await tripInScope(t.id, scope)) : scope.tenantId === SINGLE_TENANT_ID;
}

export async function listOperators(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(operators)
    .where(ownershipScopeWhere("operator", operators.id, scope))
    .orderBy(desc(operators.updatedAt))
    .limit(100);
}

export async function createOperator(input: InsertOperator, scope: TenantScope, assignedByUserId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(operators).values(input);
  const id = result[0]?.insertId;
  if (id && scope.tenantId !== SINGLE_TENANT_ID) await db.insert(coreRecordOwnership).values({ orgRef: scope.tenantId, recordType: "operator", recordId: id, assignedByUserId });
  return id;
}

export async function listUnits(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(units).where(ownershipScopeWhere("unit", units.id, scope)).orderBy(units.unitNumber).limit(100);
}

export async function createUnit(input: InsertUnit, scope: TenantScope, assignedByUserId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(units).values(input);
  const id = result[0]?.insertId;
  if (id && scope.tenantId !== SINGLE_TENANT_ID) await db.insert(coreRecordOwnership).values({ orgRef: scope.tenantId, recordType: "unit", recordId: id, assignedByUserId });
  return id;
}

export async function listLoadProfiles(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(loadProfiles)
    .where(jobKeyedScope(db, loadProfiles.jobId, scope))
    .orderBy(desc(loadProfiles.createdAt))
    .limit(100);
}

export async function createLoadProfile(input: InsertLoadProfile) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(loadProfiles).values(input);
  return result[0]?.insertId;
}

export async function listFacilities() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(facilities).orderBy(facilities.name).limit(100);
}

export async function createFacility(input: InsertFacility) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(facilities).values(input);
  return result[0]?.insertId;
}

export async function listMaintenanceDefects(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(maintenanceDefects)
    .where(unitKeyedScope(maintenanceDefects.unitId, scope))
    .orderBy(desc(maintenanceDefects.reportedAt))
    .limit(100);
}

export async function createMaintenanceDefect(input: InsertMaintenanceDefect) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(maintenanceDefects).values(input);
  return result[0]?.insertId;
}

export async function listDeliveries(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(deliveries)
    .where(jobKeyedScope(db, deliveries.jobId, scope))
    .orderBy(desc(deliveries.createdAt))
    .limit(100);
}

export async function createDelivery(input: InsertDelivery) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(deliveries).values(input);
  return result[0]?.insertId;
}

export async function createSignatureAudit(input: InsertSignatureAudit) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(signatureAudits).values(input);
  return result[0]?.insertId;
}

/* ===================== assistant proposals ===================== */

export async function createAssistantProposal(input: InsertAssistantProposal) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(assistantProposals).values(input);
  return r[0]?.insertId;
}
export async function updateAssistantProposal(
  proposalId: string,
  input: Partial<InsertAssistantProposal>
) {
  const db = await getDb();
  if (!db) return false;
  await db
    .update(assistantProposals)
    .set(input)
    .where(eq(assistantProposals.proposalId, proposalId));
  return true;
}
export async function getAssistantProposal(proposalId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(assistantProposals)
    .where(eq(assistantProposals.proposalId, proposalId))
    .limit(1);
  return rows[0];
}
/** Everything still waiting on a person. This is the review queue. */
export async function listPendingProposals(tripId?: number) {
  const db = await getDb();
  if (!db) return [];
  const q = db
    .select()
    .from(assistantProposals)
    .orderBy(desc(assistantProposals.createdAt))
    .limit(100);
  return tripId
    ? q.where(
        and(
          eq(assistantProposals.tripId, tripId),
          sql`${assistantProposals.commitState} in ('drafting','awaiting_answers','awaiting_readback')`
        )
      )
    : q.where(
        sql`${assistantProposals.commitState} in ('drafting','awaiting_answers','awaiting_readback')`
      );
}
export async function replaceProposalFields(
  proposalId: string,
  fields: InsertProposalField[]
) {
  const db = await getDb();
  if (!db) return false;
  await db
    .delete(proposalFields)
    .where(eq(proposalFields.proposalId, proposalId));
  if (fields.length) await db.insert(proposalFields).values(fields);
  return true;
}
export async function listProposalFields(proposalId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proposalFields)
    .where(eq(proposalFields.proposalId, proposalId));
}

/* ==================================================================
 * B20.2 — role resolution & authorization audit
 * ================================================================== */

/**
 * Active domain roles for a user. Revoked grants are excluded here rather than
 * deleted at revoke time, so "what could this person do in March" stays an
 * answerable question.
 */
export async function listActiveUserRoles(userId: number): Promise<RoleGrant[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      role: userRoleAssignments.role,
      scopeType: userRoleAssignments.scopeType,
      orgRef: userRoleAssignments.orgRef,
      scopeRef: userRoleAssignments.scopeRef,
    })
    .from(userRoleAssignments)
    .where(
      and(
        eq(userRoleAssignments.userId, userId),
        isNull(userRoleAssignments.revokedAt)
      )
    );
  // B23.1 — the scope travels with the grant. `scopeType` is optional in the
  // TYPE only so pre-B23.1 pure fixtures still compile; the production reader
  // always populates it, and a grant arriving here without one would be read as
  // platform-global, so it is never left to a default.
  return rows.map(r => ({
    role: r.role as string,
    scopeType: r.scopeType as RoleGrant["scopeType"],
    orgRef: r.orgRef ?? null,
    scopeRef: r.scopeRef ?? null,
  }));
}

/**
 * B23.1 — the grants that authorize in the organization this request is acting
 * for, and the organization itself.
 *
 * The choke point. `roleProcedure` calls this instead of `listActiveUserRoles`,
 * so every one of the ~650 gated procedures inherits the organization boundary
 * without being edited — the same way B23.0's organization selection reached
 * every tenant-scoped reader through `resolveActingScope`.
 *
 * It THROWS the same refusals `resolveActingScope` throws — `AmbiguousOrganization`
 * when a person is a live member of several companies and has selected none,
 * `MembershipRevoked` when every membership they had is over — because those
 * are answers about authority and the gate is where authority is decided. Both
 * are translated to named tRPC refusals in `roleProcedure`.
 */
export async function listRoleGrantsInActingOrganization(
  userId: number
): Promise<{ grants: RoleGrant[]; organization: string | null }> {
  const db = await getDb();
  if (!db) return { grants: [], organization: null };
  const [acting, grants] = await Promise.all([
    resolveActingScope(db, userId),
    listActiveUserRoles(userId),
  ]);
  return {
    grants: grantsInOrganization(grants, acting.tenantId),
    organization: acting.tenantId,
  };
}

/**
 * The role names a caller holds GLOBALLY. Branch-confined grants are dropped.
 *
 * A bare role name is not a scope-free role — it is a global one. `normalizeGrants`
 * turns each name into `{ role, scopeRef: null }`, and `permissionsFor()` has no
 * scope axis at all, so every decision made from names alone reads a confined
 * grant as reaching every branch. This projection used to return the names of
 * confined grants too, which laundered them into global ones on the way out.
 *
 * That is exactly the case `authorize()` already rules on. When a caller cannot
 * resolve the resource's branch — which is every consumer of this function —
 * a branch-confined grant "does not apply; only a global grant passes". Filtering
 * here makes the projection obey the rule instead of quietly undoing it:
 * `authorize({ grants: [{ role: "safety", scopeRef: "YEG" }], ... })` denies, and
 * `authorize({ roles: ["safety"], ... })` allowed, for the same person.
 *
 * It narrows, never widens, so it cannot open anything that was closed.
 *
 * A caller that CAN judge a branch should use `listActiveUserRoles` and pass
 * `RoleGrant[]` to `authorize()`, the way `roleProcedure` does. A caller asking
 * which roles a person holds for a non-authorization reason wants
 * `listRoleNamesAnyScope`.
 *
 * B23.1 — the same argument now applies one level out. A name is stripped of
 * its organization as well as its branch, so returning a role granted by
 * another company would launder it into authority here, which is the exact bug
 * this checkpoint closes. The projection is therefore taken from the acting
 * organization's grants, not the account's. It still only ever narrows.
 */
export async function listActiveUserRoleNames(userId: number): Promise<string[]> {
  return (await listRoleGrantsInActingOrganization(userId)).grants
    .filter(r => r.scopeRef == null)
    .map(r => r.role);
}

/**
 * Every role name the caller holds, branch-confined ones included.
 *
 * **Not for authorization.** It exists for the one question that genuinely wants
 * the unfiltered answer: which courses a person must hold. A driver confined to
 * one branch is still a driver, and still needs the driver's training — dropping
 * confined roles there would silently stop demanding a required course, which is
 * the same class of failure as over-granting, pointed the other way.
 *
 * B23.1A — the one reader deliberately left unscoped, and the reasoning is the
 * same one level out: a driver at one company is a driver, and a grant this
 * deployment quarantined as `unscoped_legacy` still describes work that person
 * was doing. Demanding the training is the safe direction; withholding it is
 * not. `readinessComposer` is its only caller and consumes it as a training
 * requirement, never as permission. It DOES exclude revoked grants, because a
 * grant that ended is not a duty anybody still has.
 *
 * If a second caller ever appears, check it against that sentence before
 * reusing this: everything about authorization wants
 * `listRoleGrantsInActingOrganization` instead.
 */
export async function listRoleNamesAnyScope(userId: number): Promise<string[]> {
  return (await listActiveUserRoles(userId)).map(r => r.role);
}

/**
 * Count of users currently holding management IN ONE ORGANIZATION.
 *
 * B23.1A — the organization argument is required and is what makes the bootstrap
 * usable in a multi-tenant deployment at all. Counted across every organization,
 * as this did, the first company to bootstrap would close the door on every
 * company created afterwards: they could never appoint a first administrator,
 * because somebody somewhere else already held management.
 *
 * `null` means the historical single tenant, written explicitly so "count
 * everywhere" cannot be reached by omitting an argument.
 *
 * It counts grants belonging to THIS organization, and deliberately not
 * platform-wide (`scopeType='global'`) ones. That looks like the unsafe
 * direction and is not, for a specific reason: a platform-wide management
 * holder cannot appoint anybody here. `records.roles.grant` takes its
 * organization from the ACTOR's acting scope, which comes from the actor's own
 * membership — so a platform-wide admin with no membership in this company
 * grants into the historical single tenant, never into it. Counting their
 * grant as "this company already has an administrator" would close the only
 * door into a company nobody can otherwise enter, permanently, for every
 * organization created after the one legacy global grant.
 *
 * The population is not ignored: `bootstrapManagementRole` returns it,
 * `records.roles.bootstrapStatus` reports it, and `role-grant-diagnostic.sh`
 * exits 3 while any exist.
 */
export async function countActiveManagementGrants(
  organization: string | null
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ userId: userRoleAssignments.userId })
    .from(userRoleAssignments)
    .where(
      and(
        eq(userRoleAssignments.role, "management"),
        organization === null
          ? isNull(userRoleAssignments.orgRef)
          : eq(userRoleAssignments.orgRef, organization),
        isNull(userRoleAssignments.revokedAt)
      )
    );
  return rows.length;
}

/**
 * Count of PLATFORM-WIDE grants of any role.
 *
 * B23.1A — `global` crosses every organization. After 0170 the backfill creates
 * none, and no ordinary path writes one, so this number should be zero forever.
 * It exists so the deployment check and the bootstrap can both say "nobody holds
 * cross-tenant authority" as a measured fact rather than an assumption.
 */
export async function countPlatformWideGrants(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: userRoleAssignments.id })
    .from(userRoleAssignments)
    .where(
      and(
        eq(userRoleAssignments.scopeType, "global"),
        isNull(userRoleAssignments.revokedAt)
      )
    );
  return rows.length;
}

/**
 * The one-time transition from an empty role table to a usable system.
 *
 * Fail-closed authorization means nobody can grant a role until somebody holds
 * `roles.grant`, and nobody holds it while the table is empty. This is the only
 * path across that gap, and it closes behind itself: it refuses once an active
 * management grant exists in that organization, it grants exactly `management`
 * and nothing else, and it requires a platform admin. Platform admin is not
 * itself a domain role — an admin is not automatically a mechanic, HR or legal.
 *
 * ## B23.1A — bootstrap no longer creates platform authority
 *
 * It wrote `scopeType: 'global'`. Before 0170 that was the only value an
 * ordinary grant could have and meant nothing in particular; after 0170 it
 * means *reaches every organization in the deployment*. So the convenience path
 * for appointing a company's first administrator had quietly become the one
 * remaining way to mint a cross-tenant authority — exactly the distinction this
 * checkpoint exists to draw.
 *
 * It now writes an ORGANIZATION-scoped grant, and the organization is derived
 * from the target's own membership rather than named by the caller:
 *
 *   exactly one live membership -> management in that company
 *   none at all                 -> management in the historical single tenant
 *   more than one               -> REFUSED. Which company is being bootstrapped
 *                                  is not a thing to guess, and a platform
 *                                  admin guessing it is how one company's first
 *                                  administrator ends up administering another.
 *
 * There is no path here to platform-wide authority any more, deliberately. If
 * this deployment ever needs a genuine cross-tenant operator, that is its own
 * mechanism with its own review — not a side effect of onboarding.
 */
export async function bootstrapManagementRole(args: {
  targetUserId: number;
  performedByUserId: number;
  reason: string;
}): Promise<
  | { ok: true; grantId: number | undefined; organization: string; platformWideGrants: number }
  | { ok: false; reason: string }
> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "No database" };
  if (!args.reason.trim()) {
    return { ok: false, reason: "Bootstrap requires a stated reason" };
  }

  // Which company is being opened. Read from the target's membership, never
  // from the caller — a platform admin may perform the bootstrap, but may not
  // choose whose company it lands in.
  const memberships = (await listMembershipFacts(args.targetUserId)).filter(m =>
    membershipIsLive(m, new Date())
  );
  const orgs = Array.from(new Set(memberships.map(m => m.orgRef)));
  if (orgs.length > 1) {
    return {
      ok: false,
      reason:
        `Bootstrap refused — this user is a live member of ${orgs.length} organizations. ` +
        "Which one is being bootstrapped has to be established, not guessed.",
    };
  }
  const organization = orgs[0] ?? SINGLE_TENANT_ID;

  const existing = await countActiveManagementGrants(organization);
  if (existing > 0) {
    return {
      ok: false,
      reason: `Bootstrap is closed — ${existing} active management grant(s) already exist in this organization`,
    };
  }

  const now = new Date();
  const grantId = await grantUserRole({
    userId: args.targetUserId,
    role: "management",
    // Organization-scoped, never platform-wide. See the note above.
    scopeType: "organization",
    orgRef: organization,
    grantedByUserId: args.performedByUserId,
    grantedAt: now,
  });

  await db.insert(roleBootstrapEvents).values({
    targetUserId: args.targetUserId,
    performedByUserId: args.performedByUserId,
    reason: args.reason,
    activeManagementCountBefore: existing,
    occurredAt: now,
  });

  // B23.1A — reported, not counted against the bootstrap. See
  // `countActiveManagementGrants` for why a platform-wide holder does not close
  // this door, and why pretending otherwise would lock the company out.
  return { ok: true, grantId, organization, platformWideGrants: await countPlatformWideGrants() };
}

/* ==================================================================
 * v23.26 — the session surface's two reads and one write.
 *
 * Every membership row for a user, whatever its status, joined to its
 * organization's status. Deliberately unfiltered: the session resolver needs
 * to tell "you never had a membership here" (the historical single tenant)
 * apart from "your membership ended" (a refusal with a sentence a person can
 * act on), and a query that returned only live rows would collapse the two.
 * ================================================================== */
export async function listMembershipFacts(userId: number): Promise<MembershipFact[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ m: organizationMemberships, orgName: organizations.name, orgStatus: organizations.status })
    .from(organizationMemberships)
    .leftJoin(organizations, eq(organizations.orgRef, organizationMemberships.orgRef))
    .where(eq(organizationMemberships.userId, userId));
  return rows.map(r => ({
    membershipRef: r.m.membershipRef,
    orgRef: r.m.orgRef,
    organizationName: r.orgName ?? r.m.orgRef,
    // A membership pointing at no organization row resolves to "closed", not to
    // "active". There is no status to read, and an unreadable status is not a
    // live one.
    organizationStatus: (r.orgStatus ?? "closed") as MembershipFact["organizationStatus"],
    membershipType: r.m.membershipType,
    membershipStatus: r.m.status,
    effectiveFrom: r.m.effectiveFrom,
    effectiveTo: r.m.effectiveTo,
    branchId: r.m.branchId,
    defaultWorkspace: r.m.defaultWorkspace,
  }));
}

/**
 * Remember which workspace a person last entered, on the membership it belongs
 * to.
 *
 * `organizationMemberships.defaultWorkspace` has been in the schema since
 * 0086 and nothing has ever read or written it. It is the right home: the
 * preference belongs to a person *in one company*, so a driver at one employer
 * and a mechanic at another each keep their own. It is a PREFERENCE — the
 * resolver checks it against the workspaces actually open before honouring it,
 * so a stored value cannot outlive the access that justified it.
 */
export async function rememberDefaultWorkspace(args: {
  membershipRef: string;
  workspace: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(organizationMemberships)
    .set({ defaultWorkspace: args.workspace })
    .where(eq(organizationMemberships.membershipRef, args.membershipRef));
}

/* ==================================================================
 * B23.2 — People & Access.
 *
 * Every function here takes the organization as an argument that the CALLER
 * resolved from the acting scope. None of them accepts one from a request, and
 * none of them has a code path that reads across organizations — the isolation
 * is in the shape of the query rather than in a filter somebody has to
 * remember. A row belonging to another company is simply not selected, which
 * is what makes "not found" the honest answer rather than a disguised refusal.
 * ================================================================== */

/** Everyone with a membership row in this organization, live or not. */
export async function listOrganizationPeople(orgRef: string): Promise<
  Array<{
    userId: number;
    displayName: string;
    email: string | null;
    membershipRef: string;
    status: "active" | "suspended" | "ended";
    membershipType: string;
    defaultWorkspace: string | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    roles: string[];
  }>
> {
  const db = await getDb();
  if (!db) return [];
  const members = await db
    .select({ m: organizationMemberships, userName: users.name, userEmail: users.email })
    .from(organizationMemberships)
    .leftJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.orgRef, orgRef));
  if (members.length === 0) return [];

  // Only THIS organization's grants. A person who also drives for another
  // company has roles there; they are not this administrator's business and
  // never enter the query.
  const ids = members.map((r: { m: { userId: number } }) => r.m.userId);
  const grants = await db
    .select({ userId: userRoleAssignments.userId, role: userRoleAssignments.role })
    .from(userRoleAssignments)
    .where(
      and(
        inArray(userRoleAssignments.userId, ids),
        eq(userRoleAssignments.orgRef, orgRef),
        isNull(userRoleAssignments.revokedAt)
      )
    );
  const byUser = new Map<number, string[]>();
  for (const g of grants) byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g.role]);

  return members.map((r: { m: typeof organizationMemberships.$inferSelect; userName: string | null; userEmail: string | null }) => ({
    userId: r.m.userId,
    displayName: r.userName ?? `User ${r.m.userId}`,
    email: r.userEmail ?? null,
    membershipRef: r.m.membershipRef,
    status: r.m.status,
    membershipType: r.m.membershipType,
    defaultWorkspace: r.m.defaultWorkspace,
    effectiveFrom: r.m.effectiveFrom,
    effectiveTo: r.m.effectiveTo,
    roles: (byUser.get(r.m.userId) ?? []).sort(),
  }));
}

/** One person, if they belong to this organization. Null is "not found here". */
export async function personInOrganization(orgRef: string, userId: number) {
  const people = await listOrganizationPeople(orgRef);
  return people.find(p => p.userId === userId) ?? null;
}

/** Whether the organization itself is trading. A suspended company opens for nobody. */
export async function organizationStatus(orgRef: string): Promise<{ name: string; active: boolean } | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(organizations).where(eq(organizations.orgRef, orgRef)).limit(1);
  if (!row) return null;
  return { name: row.name, active: row.status === "active" };
}

/**
 * Create an invitation and its roles in one transaction.
 *
 * Only the digest is stored. The caller holds the raw token and returns it to
 * the administrator exactly once; it reaches no row and no log.
 *
 * The unique `pendingKey` generated column is what actually prevents two
 * administrators creating two live invitations for the same person at the same
 * moment — checked by the database rather than by a read-then-write race.
 */
export async function createInvitation(args: {
  orgRef: string;
  invitationRef: string;
  tokenDigest: string;
  emailHint: string | null;
  displayNameHint: string | null;
  roles: readonly string[];
  defaultWorkspace: string | null;
  expiresAt: Date;
  invitedByUserId: number;
  now: Date;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db.transaction(async tx => {
    const inserted = await tx.insert(organizationInvitations).values({
      invitationRef: args.invitationRef,
      orgRef: args.orgRef,
      emailHint: args.emailHint,
      displayNameHint: args.displayNameHint,
      tokenDigest: args.tokenDigest,
      status: "pending",
      expiresAt: args.expiresAt,
      invitedByUserId: args.invitedByUserId,
      invitedAt: args.now,
      defaultWorkspace: args.defaultWorkspace,
    });
    const invitationId = Number(inserted[0]?.insertId ?? 0);
    for (const role of args.roles) {
      await tx.insert(organizationInvitationRoles).values({ invitationId, role });
    }
    return invitationId;
  });
}

/** This organization's invitations, newest first, with their roles. */
export async function listInvitations(orgRef: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.orgRef, orgRef))
    .orderBy(desc(organizationInvitations.id))
    .limit(500);
  if (rows.length === 0) return [];
  const roleRows = await db
    .select()
    .from(organizationInvitationRoles)
    .where(inArray(organizationInvitationRoles.invitationId, rows.map((r: { id: number }) => r.id)));
  const byInvitation = new Map<number, string[]>();
  for (const r of roleRows) byInvitation.set(r.invitationId, [...(byInvitation.get(r.invitationId) ?? []), r.role]);
  // The digest never leaves this function.
  return rows.map((r: typeof organizationInvitations.$inferSelect) => ({
    invitationRef: r.invitationRef,
    emailHint: r.emailHint,
    displayNameHint: r.displayNameHint,
    status: r.status,
    expiresAt: r.expiresAt,
    invitedAt: r.invitedAt,
    invitedByUserId: r.invitedByUserId,
    acceptedAt: r.acceptedAt,
    acceptedByUserId: r.acceptedByUserId,
    cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason,
    defaultWorkspace: r.defaultWorkspace,
    roles: (byInvitation.get(r.id) ?? []).sort(),
  }));
}

/**
 * Cancel a pending invitation belonging to this organization.
 *
 * Returns false for one that is already accepted, already cancelled, or
 * belongs elsewhere — all the same answer, because distinguishing them would
 * tell an administrator about another company's rows.
 */
export async function cancelInvitation(args: {
  orgRef: string;
  invitationRef: string;
  cancelledByUserId: number;
  reason: string;
  now: Date;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  return db.transaction(async tx => {
    const [row] = await tx
      .select()
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.invitationRef, args.invitationRef),
          eq(organizationInvitations.orgRef, args.orgRef),
          eq(organizationInvitations.status, "pending")
        )
      )
      .for("update")
      .limit(1);
    if (!row) return false;
    await tx
      .update(organizationInvitations)
      .set({
        status: "cancelled",
        cancelledAt: args.now,
        cancelledByUserId: args.cancelledByUserId,
        cancelReason: args.reason.slice(0, 300),
      })
      .where(eq(organizationInvitations.id, row.id));
    return true;
  });
}

/**
 * The invitation a raw token names, looked up by digest, with its roles.
 *
 * Returns the row whatever its state: the caller decides, through
 * `acceptanceCheck`, so that "expired" and "cancelled" get their own sentences
 * instead of collapsing into "not found".
 */
export async function findInvitationByDigest(tokenDigest: string) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.tokenDigest, tokenDigest))
    .limit(1);
  if (!row) return null;
  const roles = await db
    .select({ role: organizationInvitationRoles.role })
    .from(organizationInvitationRoles)
    .where(eq(organizationInvitationRoles.invitationId, row.id));
  return { row, roles: roles.map((r: { role: string }) => r.role) };
}

/**
 * Accept an invitation: membership and every initial grant, or nothing.
 *
 * The invitation is re-read INSIDE the transaction and locked, so a cancel
 * landing between the caller's check and this write loses rather than racing.
 * `accepted` is set on the same row in the same transaction, which is what
 * makes a second acceptance impossible rather than merely unlikely.
 */
export async function acceptInvitationTransactionally(args: {
  tokenDigest: string;
  acceptingUserId: number;
  membershipRef: string;
  now: Date;
}): Promise<
  | { ok: true; orgRef: string; roles: string[]; membershipRef: string }
  | { ok: false; reason: "not_found" | "not_pending" | "expired" | "already_member" }
> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "not_found" };
  return db.transaction(async tx => {
    const [row] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.tokenDigest, args.tokenDigest))
      .for("update")
      .limit(1);
    if (!row) return { ok: false, reason: "not_found" as const };
    if (row.status !== "pending") return { ok: false, reason: "not_pending" as const };
    if (args.now >= row.expiresAt) return { ok: false, reason: "expired" as const };

    // A live membership already here makes acceptance a no-op rather than a
    // second membership row. Re-granting the invited roles on top would be a
    // silent privilege change nobody asked for.
    const existing = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.orgRef, row.orgRef),
          eq(organizationMemberships.userId, args.acceptingUserId),
          eq(organizationMemberships.status, "active")
        )
      )
      .limit(1);
    if (existing.length > 0) return { ok: false, reason: "already_member" as const };

    const roleRows = await tx
      .select({ role: organizationInvitationRoles.role })
      .from(organizationInvitationRoles)
      .where(eq(organizationInvitationRoles.invitationId, row.id));
    const roles = roleRows.map((r: { role: string }) => r.role);

    await tx.insert(organizationMemberships).values({
      membershipRef: args.membershipRef,
      orgRef: row.orgRef,
      userId: args.acceptingUserId,
      membershipType: "employee",
      status: "active",
      defaultWorkspace: row.defaultWorkspace,
      effectiveFrom: args.now,
      createdByUserId: row.invitedByUserId,
    });

    for (const role of roles) {
      // B23.1 shape, always: organization-confined, never platform-wide, and
      // the organization is the invitation's own rather than anything a request
      // could name.
      await tx.insert(userRoleAssignments).values({
        userId: args.acceptingUserId,
        role: role as never,
        scopeType: "organization",
        orgRef: row.orgRef,
        scopeRef: null,
        grantedByUserId: row.invitedByUserId,
        grantedAt: args.now,
      });
    }

    await tx
      .update(organizationInvitations)
      .set({ status: "accepted", acceptedAt: args.now, acceptedByUserId: args.acceptingUserId })
      .where(eq(organizationInvitations.id, row.id));

    return { ok: true as const, orgRef: row.orgRef, roles, membershipRef: args.membershipRef };
  });
}

/**
 * End a person's membership of ONE organization, with its grants, atomically.
 *
 * This is the organization-level offboarding B23.2 exposes, and the whole
 * reason it is here rather than reusing `workforce.offboardingRevokeAccess`:
 * that path also revokes field devices and drives an offboarding record, which
 * is a different act. This one ends access to this company and touches nothing
 * anywhere else — a person who also works for another employer keeps that job.
 *
 * The last-administrator count and the write happen in one transaction over
 * locked rows, so two administrators removing each other concurrently cannot
 * both pass the check.
 */
export async function endOrganizationMembership(args: {
  orgRef: string;
  targetUserId: number;
  actorUserId: number;
  reason: string;
  now: Date;
}): Promise<
  | { ok: true; rolesRevoked: number }
  | { ok: false; reason: "not_found" | "last_administrator"; remainingAdmins?: number }
> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "not_found" };
  return db.transaction(async tx => {
    const [membership] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.orgRef, args.orgRef),
          eq(organizationMemberships.userId, args.targetUserId),
          eq(organizationMemberships.status, "active")
        )
      )
      .for("update")
      .limit(1);
    if (!membership) return { ok: false, reason: "not_found" as const };

    // Locked before counting: this is the row another concurrent removal would
    // also have to take, which is what serialises the two.
    const managementGrants = await tx
      .select({ id: userRoleAssignments.id, userId: userRoleAssignments.userId })
      .from(userRoleAssignments)
      .where(
        and(
          eq(userRoleAssignments.orgRef, args.orgRef),
          eq(userRoleAssignments.role, "management" as never),
          isNull(userRoleAssignments.revokedAt)
        )
      )
      .for("update");
    const remaining = managementGrants.filter((g: { userId: number }) => g.userId !== args.targetUserId).length;
    const targetIsAdmin = managementGrants.some((g: { userId: number }) => g.userId === args.targetUserId);
    if (targetIsAdmin && remaining === 0) {
      return { ok: false, reason: "last_administrator" as const, remainingAdmins: 0 };
    }

    const grants = await tx
      .select({ id: userRoleAssignments.id })
      .from(userRoleAssignments)
      .where(
        and(
          eq(userRoleAssignments.userId, args.targetUserId),
          eq(userRoleAssignments.orgRef, args.orgRef),
          isNull(userRoleAssignments.revokedAt)
        )
      );
    if (grants.length > 0) {
      await tx
        .update(userRoleAssignments)
        .set({ revokedAt: args.now, revokedByUserId: args.actorUserId, revokeReason: args.reason.slice(0, 300) })
        .where(
          and(
            eq(userRoleAssignments.userId, args.targetUserId),
            eq(userRoleAssignments.orgRef, args.orgRef),
            isNull(userRoleAssignments.revokedAt)
          )
        );
    }

    await tx
      .update(organizationMemberships)
      .set({ status: "ended", effectiveTo: args.now })
      .where(eq(organizationMemberships.id, membership.id));

    return { ok: true as const, rolesRevoked: grants.length };
  });
}

/**
 * Revoke one role, refusing to remove the organization's last administrator.
 *
 * Same transaction, same lock, same reason as `endOrganizationMembership`.
 * Returns the count so a caller can tell "revoked" from "there was nothing to
 * revoke" without a second query that could disagree with this one.
 */
export async function revokeRoleWithAdminGuard(args: {
  orgRef: string;
  targetUserId: number;
  role: string;
  actorUserId: number;
  reason: string;
  now: Date;
}): Promise<{ ok: true; revoked: number } | { ok: false; reason: "last_administrator" }> {
  const db = await getDb();
  if (!db) return { ok: true, revoked: 0 };
  return db.transaction(async tx => {
    const managementGrants = await tx
      .select({ id: userRoleAssignments.id, userId: userRoleAssignments.userId })
      .from(userRoleAssignments)
      .where(
        and(
          eq(userRoleAssignments.orgRef, args.orgRef),
          eq(userRoleAssignments.role, "management" as never),
          isNull(userRoleAssignments.revokedAt)
        )
      )
      .for("update");
    if (args.role === "management") {
      const remaining = managementGrants.filter((g: { userId: number }) => g.userId !== args.targetUserId).length;
      if (managementGrants.some((g: { userId: number }) => g.userId === args.targetUserId) && remaining === 0) {
        return { ok: false, reason: "last_administrator" as const };
      }
    }
    const target = and(
      eq(userRoleAssignments.userId, args.targetUserId),
      eq(userRoleAssignments.role, args.role as never),
      eq(userRoleAssignments.orgRef, args.orgRef),
      isNull(userRoleAssignments.revokedAt)
    );
    const matched = await tx.select({ id: userRoleAssignments.id }).from(userRoleAssignments).where(target);
    if (matched.length === 0) return { ok: true as const, revoked: 0 };
    await tx
      .update(userRoleAssignments)
      .set({ revokedAt: args.now, revokedByUserId: args.actorUserId, revokeReason: args.reason.slice(0, 300) })
      .where(target);
    return { ok: true as const, revoked: matched.length };
  });
}

/**
 * Quarantined grants held by people who are live members of THIS organization.
 *
 * An `unscoped_legacy` grant has `orgRef IS NULL` — it belongs to no company,
 * which is exactly why it authorizes nowhere. So there is no such thing as
 * "Org A's quarantined grants", and this is the honest substitute: rows whose
 * HOLDER is somebody this administrator already employs. It is the same
 * predicate `records.roles.resolveLegacy` enforces before resolving, so the
 * list cannot offer a row the mutation would refuse.
 *
 * It leaks nothing. The administrator already knows this person works for them;
 * the row adds only a role name and a date, and never suggests that another
 * company exists or might be the grant's origin.
 */
export async function listUnresolvedLegacyForOrganization(orgRef: string, now: Date) {
  const db = await getDb();
  if (!db) return [];
  const members = await db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(eq(organizationMemberships.orgRef, orgRef), eq(organizationMemberships.status, "active"))
    );
  if (members.length === 0) return [];
  const ids = Array.from(new Set(members.map((m: { userId: number }) => m.userId)));
  const rows = await db
    .select({
      id: userRoleAssignments.id,
      userId: userRoleAssignments.userId,
      role: userRoleAssignments.role,
      grantedAt: userRoleAssignments.grantedAt,
      name: users.name,
    })
    .from(userRoleAssignments)
    .leftJoin(users, eq(users.id, userRoleAssignments.userId))
    .where(
      and(
        inArray(userRoleAssignments.userId, ids),
        eq(userRoleAssignments.scopeType, "unscoped_legacy"),
        isNull(userRoleAssignments.revokedAt)
      )
    );
  return rows.map((r: { id: number; userId: number; role: string; grantedAt: Date; name: string | null }) => ({
    legacyGrantId: r.id,
    userId: r.userId,
    displayName: r.name ?? `User ${r.userId}`,
    role: r.role,
    grantedAt: r.grantedAt,
  }));
}

export async function grantUserRole(input: InsertUserRoleAssignment) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(userRoleAssignments).values(input);
  return result[0]?.insertId;
}

/**
 * Revoke a grant.
 *
 * B23.1 — `organization` is REQUIRED, and it is the whole point of the change.
 * This function used to match on (userId, role) alone, so revoking a driver at
 * one employer revoked them at every employer: a person who drives for two
 * companies lost both jobs when one of them let them go. `null` means the
 * historical single tenant and is written explicitly, never defaulted, so that
 * "revoke everywhere" cannot be reached by forgetting an argument.
 *
 * Returns how many grants were actually revoked, so a caller can tell the
 * difference between "revoked" and "there was nothing to revoke" instead of
 * reporting success either way.
 */
export async function revokeUserRole(args: {
  userId: number;
  role: string;
  organization: string | null;
  revokedByUserId: number;
  reason: string;
}): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const target = and(
    eq(userRoleAssignments.userId, args.userId),
    eq(userRoleAssignments.role, args.role as never),
    args.organization === null
      ? isNull(userRoleAssignments.orgRef)
      : eq(userRoleAssignments.orgRef, args.organization),
    isNull(userRoleAssignments.revokedAt)
  );
  const matched = await db
    .select({ id: userRoleAssignments.id })
    .from(userRoleAssignments)
    .where(target);
  if (matched.length === 0) return 0;
  await db
    .update(userRoleAssignments)
    .set({
      revokedAt: new Date(),
      revokedByUserId: args.revokedByUserId,
      revokeReason: args.reason,
    })
    .where(target);
  return matched.length;
}

/**
 * B23.1A — one quarantined grant, by the id the diagnostic prints.
 *
 * Returns it only while it is BOTH quarantined and live, so a resolved grant is
 * indistinguishable from one that never existed. That is what makes resolution
 * safely repeatable: a second attempt with the same id finds nothing rather
 * than issuing a second grant.
 */
export async function findUnresolvedLegacyGrant(
  grantId: number
): Promise<{ id: number; userId: number; role: string } | null> {
  const db = await getDb();
  if (!db) return null;
  const row = (
    await db
      .select({
        id: userRoleAssignments.id,
        userId: userRoleAssignments.userId,
        role: userRoleAssignments.role,
      })
      .from(userRoleAssignments)
      .where(
        and(
          eq(userRoleAssignments.id, grantId),
          eq(userRoleAssignments.scopeType, "unscoped_legacy"),
          isNull(userRoleAssignments.revokedAt)
        )
      )
      .limit(1)
  )[0];
  return row ? { id: row.id, userId: row.userId, role: row.role as string } : null;
}

/**
 * Revoke exactly one grant, by id.
 *
 * Distinct from `revokeUserRole`, which matches on (user, role, organization),
 * because a quarantined grant has NO organization — so the ordinary revoke
 * would match every organization-less grant that person holds, platform-wide
 * ones included. Resolving one legacy row must touch one legacy row.
 */
export async function revokeGrantById(args: {
  grantId: number;
  revokedByUserId: number;
  reason: string;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  await db
    .update(userRoleAssignments)
    .set({
      revokedAt: new Date(),
      revokedByUserId: args.revokedByUserId,
      revokeReason: args.reason,
    })
    .where(
      and(eq(userRoleAssignments.id, args.grantId), isNull(userRoleAssignments.revokedAt))
    );
  return true;
}

/** Whether this person already holds this role in this organization. */
export async function holdsRoleInOrganization(args: {
  userId: number;
  role: string;
  organization: string;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: userRoleAssignments.id })
    .from(userRoleAssignments)
    .where(
      and(
        eq(userRoleAssignments.userId, args.userId),
        eq(userRoleAssignments.role, args.role as never),
        eq(userRoleAssignments.orgRef, args.organization),
        isNull(userRoleAssignments.revokedAt)
      )
    );
  return rows.length > 0;
}

/**
 * Records the decision. Never throws — an audit write failing must not become
 * a way to make the gate itself fail open or closed unpredictably.
 */
export async function recordAuthorizationDecision(input: {
  actorUserId: number | null;
  procedureName: string;
  permission: string;
  rolesHeld: string | null;
  outcome: string;
  subjectType?: string | null;
  subjectId?: string | null;
  detail: string | null;
  occurredAt: Date;
}) {
  try {
    const db = await getDb();
    if (!db) return undefined;
    const result = await db.insert(authorizationDecisions).values({
      actorUserId: input.actorUserId,
      procedureName: input.procedureName,
      permission: input.permission,
      rolesHeld: input.rolesHeld,
      outcome: input.outcome as never,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      detail: input.detail,
      occurredAt: input.occurredAt,
    });
    return result[0]?.insertId;
  } catch {
    return undefined;
  }
}

/* ==================================================================
 * B20.9 — External data source seeding
 * ================================================================== */

/**
 * Seed the verified-source registry.
 *
 * Idempotent by `sourceKey`, and deliberately **does not downgrade** an
 * existing row: if someone has since verified AER's terms and marked the row
 * verified, re-running the seed must not quietly revert that legal work.
 * It only inserts what is missing.
 */
export async function seedExternalDataSources(): Promise<{
  inserted: string[];
  existing: string[];
}> {
  const db = await getDb();
  if (!db) return { inserted: [], existing: [] };

  const { ALL_DATA_SOURCES, SOURCES_REQUIRING_API_KEY, SOURCE_CAVEATS } =
    await import("./_core/externalSourceSeeds");

  const rows = await db
    .select({ sourceKey: externalDataSources.sourceKey })
    .from(externalDataSources);
  const present = new Set(rows.map(r => r.sourceKey));

  const inserted: string[] = [];
  const existing: string[] = [];

  for (const s of ALL_DATA_SOURCES) {
    if (present.has(s.sourceKey)) {
      existing.push(s.sourceKey);
      continue;
    }
    await db.insert(externalDataSources).values({
      sourceKey: s.sourceKey,
      displayName: s.displayName,
      authority: s.authority,
      jurisdiction: s.jurisdiction ?? null,
      category: s.category,
      licenceName: s.licenceName ?? null,
      licenceUrl: s.licenceUrl ?? null,
      attributionRequired: s.attributionRequired,
      attributionText: s.attributionText ?? null,
      shareAlikeObligation: s.shareAlikeObligation,
      commercialUsePermitted: s.commercialUsePermitted,
      redistributionPermitted: s.redistributionPermitted,
      rateLimitCalls: s.rateLimitCalls ?? null,
      rateLimitWindowSeconds: s.rateLimitWindowSeconds ?? null,
      requiresApiKey: SOURCES_REQUIRING_API_KEY.includes(s.sourceKey),
      updateIntervalHours: s.updateIntervalHours ?? null,
      retrievedAt: s.retrievedAt ?? null,
      verifiedAt: s.verifiedAt ?? null,
      status: s.status,
      notes: SOURCE_CAVEATS[s.sourceKey] ?? null,
    });
    inserted.push(s.sourceKey);
  }

  return { inserted, existing };
}

export async function listExternalDataSources() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(externalDataSources);
}

/* ---- v21.10: external identities ---- */
export async function findExternalIdentityByTokenHash(tokenHash: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(externalIdentities).where(eq(externalIdentities.tokenHash, tokenHash)).limit(1);
  return rows[0];
}
export async function touchExternalIdentity(id: number, at: Date) {
  const db = await getDb();
  if (!db) return;
  await db.update(externalIdentities).set({ lastSeenAt: at }).where(eq(externalIdentities.id, id));
}

/* ---- v21.12: identity hardening ---- */
export async function findExternalIdentityByAnyTokenHash(tokenHash: string, now: Date) {
  const db = await getDb();
  if (!db) return undefined;
  const cur = await db.select().from(externalIdentities).where(eq(externalIdentities.tokenHash, tokenHash)).limit(1);
  if (cur[0]) return { identity: cur[0], viaPrevious: false as const };
  const prev = await db.select().from(externalIdentities).where(eq(externalIdentities.previousTokenHash, tokenHash)).limit(1);
  if (prev[0] && prev[0].previousTokenExpiresAt && now < prev[0].previousTokenExpiresAt) return { identity: prev[0], viaPrevious: true as const };
  return undefined;
}
export async function findExternalIdentityByInvitationHash(hash: string) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(externalIdentities).where(eq(externalIdentities.invitationTokenHash, hash)).limit(1))[0];
}
export async function updateExternalIdentity(id: number, patch: Partial<typeof externalIdentities.$inferInsert>) {
  const db = await getDb();
  if (!db) return;
  await db.update(externalIdentities).set(patch).where(eq(externalIdentities.id, id));
}

/* ---- v21.18: integration clients ---- */
export async function findIntegrationClientByKeyHash(keyHash: string) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(integrationClients).where(eq(integrationClients.keyHash, keyHash)).limit(1))[0];
}
export async function touchIntegrationClient(id: number, at: Date) {
  const db = await getDb();
  if (!db) return;
  await db.update(integrationClients).set({ lastSeenAt: at }).where(eq(integrationClients.id, id));
}
