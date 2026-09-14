import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
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
} from "../drizzle/schema";
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

export async function listJobs() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(100);
}

export async function getJobByCode(jobCode: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(jobs)
    .where(eq(jobs.jobCode, jobCode))
    .limit(1);
  return result[0];
}

export async function createJob(input: InsertJob) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(jobs).values(input);
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

export async function listTrips() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(trips).orderBy(desc(trips.updatedAt)).limit(200);
}
export async function createTrip(input: InsertTrip) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(trips).values(input);
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

export async function listComplianceDocuments() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(complianceDocuments)
    .orderBy(desc(complianceDocuments.createdAt))
    .limit(100);
}

export async function createComplianceDocument(
  input: InsertComplianceDocument
) {
  const db = await getDb();
  if (!db) return undefined;
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

export async function listOperators() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(operators)
    .orderBy(desc(operators.updatedAt))
    .limit(100);
}

export async function createOperator(input: InsertOperator) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(operators).values(input);
  return result[0]?.insertId;
}

export async function listUnits() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(units).orderBy(units.unitNumber).limit(100);
}

export async function createUnit(input: InsertUnit) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(units).values(input);
  return result[0]?.insertId;
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
