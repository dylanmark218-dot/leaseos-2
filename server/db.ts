import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { SINGLE_TENANT_ID, resolveActingScope } from "./_core/actingScope";
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
  InsertOperatingZone,
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
  operatingZones,
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
  coreRecordOwnership, organizationMemberships, fieldTickets } from "../drizzle/schema";
import { ENV } from "./_core/env";

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

export async function listEvidenceRecords() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(evidenceRecords)
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

export async function listSafetyEvents() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(safetyEvents)
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
export async function listTripStops(tripId?: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(tripStops)
    .where(tripId ? eq(tripStops.tripId, tripId) : undefined)
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
export async function listOperatingZones() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(operatingZones)
    .orderBy(desc(operatingZones.createdAt))
    .limit(200);
}
export async function createOperatingZone(input: InsertOperatingZone) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(operatingZones).values(input);
  return result[0]?.insertId;
}
export async function listActiveOperatingZones() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(operatingZones)
    .where(eq(operatingZones.active, 1))
    .limit(500);
}

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
export async function listZoneEvents(
  tripId?: number,
  status?: "pending" | "confirmed" | "rejected" | "expired"
) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [
    tripId ? eq(zoneEvents.tripId, tripId) : undefined,
    status ? eq(zoneEvents.status, status) : undefined,
  ].filter(Boolean);
  const query = db
    .select()
    .from(zoneEvents)
    .orderBy(desc(zoneEvents.detectedAt))
    .limit(200);
  return conditions.length
    ? query.where(and(...(conditions as Parameters<typeof and>)))
    : query;
}

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
export async function listDutyRecords(operatorId?: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(dutyRecords)
    .where(operatorId ? eq(dutyRecords.operatorId, operatorId) : undefined)
    .orderBy(desc(dutyRecords.startedAt))
    .limit(500);
}
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

export async function listRouteDecisions() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(routeDecisions)
    .orderBy(desc(routeDecisions.createdAt))
    .limit(100);
}
export async function createRouteDecision(input: InsertRouteDecision) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(routeDecisions).values(input);
  return result[0]?.insertId;
}
export async function listBillingRateCards() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(billingRateCards)
    .orderBy(desc(billingRateCards.updatedAt))
    .limit(100);
}
export async function createBillingRateCard(input: InsertBillingRateCard) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(billingRateCards).values(input);
  return result[0]?.insertId;
}
export async function listJobChargeLines(jobId?: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(jobChargeLines)
    .where(jobId ? eq(jobChargeLines.jobId, jobId) : undefined)
    .orderBy(desc(jobChargeLines.createdAt))
    .limit(100);
}
export async function createJobChargeLine(input: InsertJobChargeLine) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(jobChargeLines).values(input);
  return result[0]?.insertId;
}
export async function listVendors() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(vendors).orderBy(vendors.name).limit(100);
}
export async function createVendor(input: InsertVendor) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(vendors).values(input);
  return result[0]?.insertId;
}
export async function listUnitSafetyPlans() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(unitSafetyPlans)
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
export async function updateVendor(id: number, input: Partial<InsertVendor>) {
  const db = await getDb();
  if (!db) return false;
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

export async function listComplianceArtifacts() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(complianceArtifacts)
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
export async function listTailgateMeetings() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(tailgateMeetings)
    .orderBy(desc(tailgateMeetings.createdAt))
    .limit(100);
}
export async function createTailgateMeeting(input: InsertTailgateMeeting) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(tailgateMeetings).values(input);
  return result[0]?.insertId;
}
export async function listTransferAcknowledgements() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(transferAcknowledgements)
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

export async function listManifests() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(manifests)
    .orderBy(desc(manifests.createdAt))
    .limit(100);
}

export async function createManifest(input: InsertManifest) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(manifests).values(input);
  return result[0]?.insertId;
}

export async function listScanAudits() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(scanAudits)
    .orderBy(desc(scanAudits.scannedAt))
    .limit(100);
}

export async function createScanAudit(input: InsertScanAudit) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(scanAudits).values(input);
  return result[0]?.insertId;
}

export async function listJobUnits() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobUnits).orderBy(desc(jobUnits.joinedAt)).limit(100);
}

export async function createJobUnit(input: InsertJobUnit) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(jobUnits).values(input);
  return result[0]?.insertId;
}

export async function listInspections() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(inspections)
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

export async function listComplianceDocuments(scope: TenantScope) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(complianceDocuments)
    .where(scope.tenantId === SINGLE_TENANT_ID ? isNull(documentOwnerOrg) : eq(documentOwnerOrg, scope.tenantId))
    .orderBy(desc(complianceDocuments.createdAt))
    .limit(100);
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
  status: "verified" | "rejected"
) {
  const db = await getDb();
  if (!db) return false;
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

export async function listLoadProfiles() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(loadProfiles)
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

export async function listMaintenanceDefects() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(maintenanceDefects)
    .orderBy(desc(maintenanceDefects.reportedAt))
    .limit(100);
}

export async function createMaintenanceDefect(input: InsertMaintenanceDefect) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(maintenanceDefects).values(input);
  return result[0]?.insertId;
}

export async function listDeliveries() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(deliveries)
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
export async function listActiveUserRoles(
  userId: number
): Promise<{ role: string; scopeRef: string | null }[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      role: userRoleAssignments.role,
      scopeRef: userRoleAssignments.scopeRef,
    })
    .from(userRoleAssignments)
    .where(
      and(
        eq(userRoleAssignments.userId, userId),
        isNull(userRoleAssignments.revokedAt)
      )
    );
  return rows.map(r => ({ role: r.role as string, scopeRef: r.scopeRef ?? null }));
}

/** Role names only, for callers that do not care about branch confinement. */
export async function listActiveUserRoleNames(userId: number): Promise<string[]> {
  return (await listActiveUserRoles(userId)).map(r => r.role);
}

/**
 * Count of users currently holding management. Used only by the bootstrap
 * path, which must refuse to run once anybody holds it.
 */
export async function countActiveManagementGrants(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ userId: userRoleAssignments.userId })
    .from(userRoleAssignments)
    .where(
      and(
        eq(userRoleAssignments.role, "management"),
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
 * path across that gap, and it closes behind itself: it refuses once any active
 * management grant exists, it grants exactly `management` and nothing else, and
 * it requires a platform admin. Platform admin is not itself a domain role —
 * an admin is not automatically a mechanic, HR or legal.
 */
export async function bootstrapManagementRole(args: {
  targetUserId: number;
  performedByUserId: number;
  reason: string;
}): Promise<
  | { ok: true; grantId: number | undefined }
  | { ok: false; reason: string }
> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "No database" };
  if (!args.reason.trim()) {
    return { ok: false, reason: "Bootstrap requires a stated reason" };
  }

  const existing = await countActiveManagementGrants();
  if (existing > 0) {
    return {
      ok: false,
      reason: `Bootstrap is closed — ${existing} active management grant(s) already exist`,
    };
  }

  const now = new Date();
  const grantId = await grantUserRole({
    userId: args.targetUserId,
    role: "management",
    scopeType: "global",
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

  return { ok: true, grantId };
}

export async function grantUserRole(input: InsertUserRoleAssignment) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(userRoleAssignments).values(input);
  return result[0]?.insertId;
}

export async function revokeUserRole(args: {
  userId: number;
  role: string;
  revokedByUserId: number;
  reason: string;
}) {
  const db = await getDb();
  if (!db) return undefined;
  return db
    .update(userRoleAssignments)
    .set({
      revokedAt: new Date(),
      revokedByUserId: args.revokedByUserId,
      revokeReason: args.reason,
    })
    .where(
      and(
        eq(userRoleAssignments.userId, args.userId),
        eq(userRoleAssignments.role, args.role as never),
        isNull(userRoleAssignments.revokedAt)
      )
    );
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
