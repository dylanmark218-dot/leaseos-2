/**
 * P0-A2.1 — the one boundary between a caller, a trip, and an organization's operating zones.
 *
 * An operating zone is one organization's geofence: its loading pad, its yard, its home terminal,
 * the radius it decided on for its own disposal run. Until 0209 the table carried no owner, any
 * organization's dispatcher could create one, every organization's list returned it, and the GPS
 * engine evaluated every active zone for every trip — so company A's zone produced pending
 * enter/exit proposals on company B's trips (reproduced 2026-10-01, OZ-T1..T5).
 *
 * The chain, read from the schema:
 *
 *   a person   → organizationMemberships (live) → orgRef → operatingZones.orgRef
 *   a position → tripBreadcrumbs.tripId → trips.orgRef (0132, authoritative) → operatingZones.orgRef
 *
 * Three rules every function below keeps:
 *
 *   1. The organization a zone is written into comes from the caller's live membership, never from
 *      input (the router refuses an `orgRef` field outright). The organization a trip's position is
 *      evaluated against comes from the trip row, never from the caller or the request: a position
 *      can only reach the engine through a trip the router already proved is the caller's, and the
 *      engine then asks the trip, not the caller.
 *   2. The organization comes from `resolveActingScopeStrict`: a live membership, or the
 *      single-tenant fallback ONLY for a person the membership table has never heard of. Two live
 *      memberships are refused; an ended, suspended or lapsed one is refused and no role grant
 *      revives it.
 *   3. Lists filter in the query; the limit applies after the tenant predicate. A legacy zone
 *      (orgRef NULL, from before 0209) is the historical single tenant's: listed to the fallback
 *      scope only, evaluated only for a trip that carries no organization, never for a member's.
 *      The unscoped helpers (`listOperatingZones`, `createOperatingZone`,
 *      `listActiveOperatingZones`) are gone from server/db.ts; the engine cannot ask for "all
 *      active zones" because no function answers that.
 *
 * `server/operatingZoneBoundaryGuard.test.ts` pins the shape; `server/tenantScopeOperatingZones.db.test.ts`
 * proves the behaviour through the real router.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { operatingZones, trips, type InsertOperatingZone } from "../drizzle/schema";
import { getDb, orgScopeWhere, type TenantScope } from "./db";
import { AmbiguousOrganization, RevivedFallbackRefused, SINGLE_TENANT_ID, resolveActingScopeStrict } from "./_core/actingScope";

export type OperatingZoneScope = TenantScope & {
  userId: number;
  derivedFrom: "membership" | "single_tenant_fallback";
};

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/**
 * Which organization this caller acts for, for operating zones. Never read from input.
 *
 * Two live memberships → PRECONDITION_FAILED, the mapping the HOS and telematics boundaries use.
 * A membership that ended → FORBIDDEN, with no organization named.
 */
export async function operatingZoneScopeFor(userId: number): Promise<OperatingZoneScope> {
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

/** The zones the caller's organization owns, newest first, at most 200 after the tenant predicate. */
export async function listOperatingZonesInScope(scope: TenantScope) {
  const db = await dbOrThrow();
  return db.select().from(operatingZones)
    .where(orgScopeWhere(operatingZones, scope))
    .orderBy(desc(operatingZones.createdAt))
    .limit(200);
}

/**
 * A new zone belongs to the acting organization — stamped here from the scope, as `createTrip`
 * does, never taken from the input (the router's schema refuses an `orgRef` field). The fallback
 * scope writes NULL: the historical single tenant's zone, exactly as its trips and rate cards.
 */
export async function createOperatingZoneInScope(scope: TenantScope, input: Omit<InsertOperatingZone, "orgRef">) {
  const db = await dbOrThrow();
  const result = await db.insert(operatingZones).values({ ...input, orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId });
  return result[0]?.insertId;
}

/**
 * The active zones the geofence engine may evaluate for THIS trip: the trip's organization's, read
 * from `trips.orgRef`. The signature takes only the trip id on purpose — there is no parameter
 * through which a caller, a request or a session could name the organization. A trip that carries
 * no organization (legacy, pre-0132) is the historical single tenant's and sees only legacy zones;
 * an unknown trip sees none.
 */
export async function activeOperatingZonesForTrip(tripId: number) {
  const db = await dbOrThrow();
  const trip = (await db.select({ orgRef: trips.orgRef }).from(trips).where(eq(trips.id, tripId)).limit(1))[0];
  if (!trip) return [];
  const scope: TenantScope = { tenantId: trip.orgRef ?? SINGLE_TENANT_ID };
  return db.select().from(operatingZones)
    .where(and(eq(operatingZones.active, 1), orgScopeWhere(operatingZones, scope)))
    .limit(500);
}
