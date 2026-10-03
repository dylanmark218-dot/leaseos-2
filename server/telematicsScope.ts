/**
 * P0-A2 — the one boundary between a caller and another company's telematics.
 *
 * The chain, read from the schema:
 *
 *   caller → organizationMemberships (live) → orgRef
 *          → coreRecordOwnership(recordType 'unit', recordId) → units.id
 *          → telemetrySnapshots.unitId · faultCodes.unitId · drivingEvents.unitId
 *            (and, for the unit view's odometer evidence, workOrders.unitId · trips.unitId)
 *   and, for the GPS trace and the geofence proposals derived from it,
 *          → trips.orgRef (0132) → tripBreadcrumbs.tripId · zoneEvents.tripId
 *
 * No telemetry row carries an organization of its own. `sourceClientId` names the machine client
 * that delivered the row and `inboundEventId` the inbound record; both are provenance, not
 * ownership. Ingestion (`integrationRouter`) already refuses a feed for a unit the client's
 * organization does not own, so at write time the unit's owner and the client's organization
 * agree; afterwards the unit's owner is the authority, which is also what the audit package, the
 * readiness composer and the shop already use for unit-keyed rows. Nothing here invents a second
 * ownership column.
 *
 * Three rules every function below keeps:
 *
 *   1. A caller-supplied unit id, fault id, event reference, trip id or zone-event id is never
 *      authority. The database says whether the record belongs to the caller's organization; the
 *      answer for one that does not is exactly the answer for one that does not exist —
 *      `NOT_FOUND`, with the same words — so ids cannot be probed. "Fault not found" and "Event
 *      not found" are the words the router has always used; `Unit N not found` and `Trip N not
 *      found` are P4.1's.
 *   2. The organization comes from `resolveActingScopeStrict`: a live membership, or the
 *      single-tenant fallback ONLY for a person the membership table has never heard of. Two live
 *      memberships are refused; an ended, suspended or lapsed membership is refused and no role
 *      grant revives it.
 *   3. Lists filter in the query. The fault list, the review queue and the zone-event list used to
 *      be every organization's rows, newest N; the limit now applies after the tenant predicate.
 *      The unscoped helpers (`listZoneEvents`, `zoneEventTripId`) are gone from server/db.ts.
 *
 * Routers consume what this returns rather than querying an id and checking afterwards.
 * `server/telematicsBoundaryGuard.test.ts` pins that the telematics router cannot reach the
 * telemetry tables except through here, and that the GPS block of the field router calls this
 * boundary and none of the retired helpers.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { drivingEvents, faultCodes, telemetrySnapshots, tripBreadcrumbs, trips, units, workOrders, zoneEvents } from "../drizzle/schema";
import { getDb, operatorForUserInScope, orgScopeWhere, ownershipScopeWhere, tripScopeSubquery, type TenantScope } from "./db";
import { AmbiguousOrganization, RevivedFallbackRefused, resolveActingScopeStrict } from "./_core/actingScope";

export type TelematicsScope = TenantScope & {
  userId: number;
  derivedFrom: "membership" | "single_tenant_fallback";
};

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** The same words a nonexistent id gets. Nothing about the company, the truck, or whether the row exists. */
export const unitNotFound = (unitId: number) => new TRPCError({ code: "NOT_FOUND", message: `Unit ${unitId} not found` });
export const faultNotFound = () => new TRPCError({ code: "NOT_FOUND", message: "Fault not found" });
export const eventNotFound = () => new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
export const tripNotFound = (tripId: number) => new TRPCError({ code: "NOT_FOUND", message: `Trip ${tripId} not found` });
export const zoneEventNotFound = (id: number) => new TRPCError({ code: "NOT_FOUND", message: `Zone event ${id} not found` });

/**
 * Which organization this caller acts for, for telematics. Never read from input.
 *
 * Two live memberships → PRECONDITION_FAILED, the mapping `hosScopeFor` and `financeScopeFor` use.
 * A membership that ended → FORBIDDEN, with no organization named.
 */
export async function telematicsScopeFor(userId: number): Promise<TelematicsScope> {
  const db = await dbOrThrow();
  try {
    const acting = await resolveActingScopeStrict(db, userId);
    return { tenantId: acting.tenantId, userId, derivedFrom: acting.derivedFrom };
  } catch (e) {
    if (e instanceof AmbiguousOrganization) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
    if (e instanceof RevivedFallbackRefused) throw new TRPCError({ code: "FORBIDDEN", message: "No active organization membership" });
    throw e;
  }
}

/** The predicate that keeps a unit-keyed telemetry query inside the caller's organization. Composable into any telematics read. */
export function telemetryUnitOwnedWhere(scope: TenantScope, unitIdColumn: typeof telemetrySnapshots.unitId | typeof faultCodes.unitId | typeof drivingEvents.unitId) {
  return ownershipScopeWhere("unit", unitIdColumn, scope);
}

/**
 * The unit, if the caller's organization owns it. Refused as not-found otherwise — the same
 * refusal a nonexistent id gets. This is the only way a telematics procedure turns an id into a unit.
 */
export async function requireTelematicsUnitInScope(scope: TenantScope, unitId: number): Promise<{ id: number; unitNumber: string }> {
  const db = await dbOrThrow();
  const row = (await db.select({ id: units.id, unitNumber: units.unitNumber }).from(units)
    .where(and(eq(units.id, unitId), ownershipScopeWhere("unit", units.id, scope))).limit(1))[0];
  if (!row) throw unitNotFound(unitId);
  return row;
}

/**
 * Everything the unit view reads, for a unit the caller's organization owns: the latest snapshot,
 * the shop's last odometer, the trips' distances, the open faults. Ownership is proved before a
 * single telemetry row is read; a foreign unit yields the not-found refusal, never an empty (and
 * therefore healthy-looking) picture. Every unit-keyed read also carries the tenant predicate,
 * so a row keyed to the proven unit is the only kind that can come back.
 */
export async function unitTelemetryInScope(scope: TenantScope, unitId: number) {
  const unit = await requireTelematicsUnitInScope(scope, unitId);
  const db = await dbOrThrow();
  const latest = (await db.select().from(telemetrySnapshots)
    .where(and(eq(telemetrySnapshots.unitId, unit.id), telemetryUnitOwnedWhere(scope, telemetrySnapshots.unitId)))
    .orderBy(desc(telemetrySnapshots.recordedAt)).limit(1))[0] ?? null;
  const shop = (await db.select({ odometerKm: workOrders.odometerKm, at: workOrders.completedAt, opened: workOrders.openedAt }).from(workOrders)
    .where(and(eq(workOrders.unitId, unit.id), isNotNull(workOrders.odometerKm), ownershipScopeWhere("unit", workOrders.unitId, scope)))
    .orderBy(desc(workOrders.openedAt)).limit(1))[0] ?? null;
  const tripRows = await db.select({ distanceKm: trips.distanceKm, completedAt: trips.completedAt }).from(trips)
    .where(and(eq(trips.unitId, unit.id), isNotNull(trips.distanceKm), ownershipScopeWhere("unit", trips.unitId, scope)));
  const faults = await db.select().from(faultCodes)
    .where(and(eq(faultCodes.unitId, unit.id), inArray(faultCodes.status, ["active", "acknowledged"]), telemetryUnitOwnedWhere(scope, faultCodes.unitId)));
  return { unit, latest, shop, tripRows, faults };
}

/**
 * The fault list, filtered to the caller's organization in the query. Newest-seen first, at most
 * 500 — the limit the old unscoped list had, now applied after the tenant predicate.
 */
export async function listFaultsInScope(scope: TenantScope, status?: "active" | "acknowledged" | "cleared") {
  const db = await dbOrThrow();
  const byStatus = status ? eq(faultCodes.status, status) : inArray(faultCodes.status, ["active", "acknowledged"]);
  return db.select().from(faultCodes)
    .where(and(byStatus, telemetryUnitOwnedWhere(scope, faultCodes.unitId)))
    .orderBy(desc(faultCodes.lastSeenAt)).limit(500);
}

/** The fault, if its unit is the caller's organization's. "Fault not found" otherwise — the words a nonexistent id gets. */
export async function requireFaultInScope(scope: TenantScope, faultId: number) {
  const db = await dbOrThrow();
  const row = (await db.select().from(faultCodes)
    .where(and(eq(faultCodes.id, faultId), telemetryUnitOwnedWhere(scope, faultCodes.unitId))).limit(1))[0];
  if (!row) throw faultNotFound();
  return row;
}

/** A write to a fault the caller's organization owns. The predicate is on the UPDATE itself, so a row that changed hands between the read and the write is not touched. */
export async function updateFaultInScope(scope: TenantScope, faultId: number, set: Partial<typeof faultCodes.$inferInsert>) {
  const db = await dbOrThrow();
  await db.update(faultCodes).set(set).where(and(eq(faultCodes.id, faultId), telemetryUnitOwnedWhere(scope, faultCodes.unitId)));
}

/** The review queue's rows: unreviewed events of the caller's organization's units, oldest first, at most 1000 after the tenant predicate. */
export async function unreviewedDrivingEventsInScope(scope: TenantScope) {
  const db = await dbOrThrow();
  return db.select().from(drivingEvents)
    .where(and(eq(drivingEvents.reviewStatus, "unreviewed"), telemetryUnitOwnedWhere(scope, drivingEvents.unitId)))
    .orderBy(drivingEvents.recordedAt).limit(1000);
}

/** The driving event, if its unit is the caller's organization's. "Event not found" otherwise — the words a nonexistent reference gets. */
export async function requireDrivingEventInScope(scope: TenantScope, eventRef: string) {
  const db = await dbOrThrow();
  const row = (await db.select().from(drivingEvents)
    .where(and(eq(drivingEvents.eventRef, eventRef), telemetryUnitOwnedWhere(scope, drivingEvents.unitId))).limit(1))[0];
  if (!row) throw eventNotFound();
  return row;
}

/** A write to a driving event the caller's organization owns; the predicate is on the UPDATE itself. */
export async function updateDrivingEventInScope(scope: TenantScope, id: number, set: Partial<typeof drivingEvents.$inferInsert>) {
  const db = await dbOrThrow();
  await db.update(drivingEvents).set(set).where(and(eq(drivingEvents.id, id), telemetryUnitOwnedWhere(scope, drivingEvents.unitId)));
}

/** A trip the caller's organization owns (trips.orgRef), or the not-found refusal a nonexistent id gets. */
export async function requireTripInTelematicsScope(scope: TenantScope, tripId: number): Promise<{ id: number; unitId: number | null }> {
  const db = await dbOrThrow();
  const row = (await db.select({ id: trips.id, unitId: trips.unitId }).from(trips)
    .where(and(eq(trips.id, tripId), orgScopeWhere(trips, scope))).limit(1))[0];
  if (!row) throw tripNotFound(tripId);
  return row;
}

/** The GPS trace of a trip the caller's organization owns, newest first. */
export async function tripBreadcrumbsInScope(scope: TenantScope, tripId: number, limit = 500) {
  const t = await requireTripInTelematicsScope(scope, tripId);
  const db = await dbOrThrow();
  return db.select().from(tripBreadcrumbs)
    .where(and(eq(tripBreadcrumbs.tripId, t.id), inArray(tripBreadcrumbs.tripId, tripScopeSubquery(db, scope))))
    .orderBy(desc(tripBreadcrumbs.recordedAt)).limit(limit);
}

/**
 * Zone events (geofence proposals), filtered to the caller's organization's trips in the query.
 * With a trip id, that trip must be the organization's (not-found otherwise); without one, every
 * row returned belongs to a trip the organization owns — the dispatch view, which used to be every
 * company's proposals. Newest first, at most 200 after the tenant predicate.
 */
export async function listZoneEventsInScope(scope: TenantScope, tripId?: number, status?: "pending" | "confirmed" | "rejected" | "expired") {
  if (tripId != null) await requireTripInTelematicsScope(scope, tripId);
  const db = await dbOrThrow();
  const conditions = [
    tripId != null ? eq(zoneEvents.tripId, tripId) : undefined,
    status ? eq(zoneEvents.status, status) : undefined,
    inArray(zoneEvents.tripId, tripScopeSubquery(db, scope)),
  ].filter((c): c is NonNullable<typeof c> => c != null);
  return db.select().from(zoneEvents).where(and(...conditions)).orderBy(desc(zoneEvents.detectedAt)).limit(200);
}

/** The zone event, if its trip is the caller's organization's. Not-found otherwise — the words a nonexistent id gets. */
export async function requireZoneEventInScope(scope: TenantScope, id: number): Promise<{ id: number; tripId: number }> {
  const db = await dbOrThrow();
  const row = (await db.select({ id: zoneEvents.id, tripId: zoneEvents.tripId }).from(zoneEvents)
    .where(and(eq(zoneEvents.id, id), inArray(zoneEvents.tripId, tripScopeSubquery(db, scope)))).limit(1))[0];
  if (!row) throw zoneEventNotFound(id);
  return row;
}

/**
 * The signed-in person's own operator record — but only if the caller's organization owns it. A
 * driver who left company B for company A does not keep sending positions to B's trip through their
 * old operator row; to A they have no operator record until A creates one.
 */
export async function selfOperatorInTelematicsScope(scope: TenantScope, userId: number): Promise<{ id: number } | null> {
  const r = await operatorForUserInScope(userId, scope);
  return r.kind === "resolved" ? { id: r.operatorId } : null;
}

/** The operator's one active trip among the trips the caller's organization owns, or null. A breadcrumb binds to this, not to a trip the request names. */
export async function activeTripForOperatorInScope(scope: TenantScope, operatorId: number): Promise<{ id: number; unitId: number | null } | null> {
  const db = await dbOrThrow();
  return (await db.select({ id: trips.id, unitId: trips.unitId }).from(trips)
    .where(and(eq(trips.operatorId, operatorId), inArray(trips.status, ["loading", "in_transit", "unloading"]), orgScopeWhere(trips, scope))).limit(1))[0] ?? null;
}
