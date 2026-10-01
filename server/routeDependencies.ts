/**
 * What a route approval stood on, and the one recheck that says whether it still stands.
 *
 * Moved out of `spatialRouter.ts` unchanged, so the approval procedures and the provincial feed
 * runtime share a single answer instead of two copies that could drift: `spatial.routeApprove`
 * records these dependencies, `spatial.routeApprovalCheck` and a feed ingest both call
 * `recheckRouteApproval`, and an approval goes stale by the same arithmetic whoever asks.
 *
 * Added here: `liveAdvisories`, the provincial road advisories material to THIS route's geometry.
 * It is placed by `advisoriesOnRoute` — the canonical geometric placement, never road names — over
 * the route's geometry from `resolveRouteCommunicationGeography` — the canonical resolver. Nothing
 * here decides whether a route is legal. A closure on the route makes the approval stale, which
 * puts the trip back in front of a person; readiness already refuses to report a stale approval as
 * clear (`route_approval_stale`, blocking, manager-overridable).
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { accessRoadSegments, roadAdvisories, roadRadioAssignments, roadRestrictions, routeApprovals, structures, vehicleProfiles } from "../drizzle/schema";
import type { getDb } from "./db";
import { advisoriesOnRoute, type AdvisorySeverity, type AdvisoryType, type RoadAdvisory, type RouteLeg } from "./_core/advisoryImpact";
import { resolveAssignment } from "./_core/commRoute";
import { pathLengthMetres } from "./_core/geoImport";
import { applicableRestrictions, hashPart, inForce, loadFingerprint, stalenessAgainst, type RouteDependencies } from "./_core/structures";
import { resolveRouteCommunicationGeography } from "./routeCommunicationGeography";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type RouteApprovalRow = typeof routeApprovals.$inferSelect;

/* ------------------------------------------------------------------ */
/* Which advisories a route depends on                                  */
/* ------------------------------------------------------------------ */

/**
 * Material to an approval: closures and restrictions whatever their stated severity, and anything
 * major or of unknown severity. Minor and informational roadwork is shown on the route and does not
 * by itself send an approved route back for review — DriveBC alone carries over two hundred minor
 * construction events, and an approval that went stale for each of them would teach dispatchers to
 * override the flag. Unknown is material because "the publisher did not say" is not "minor".
 */
const MATERIAL_TYPES: readonly AdvisoryType[] = ["closure", "restriction"];
const MATERIAL_SEVERITIES: readonly AdvisorySeverity[] = ["closure", "major", "unknown"];
export const isMaterialToRoute = (a: Pick<RoadAdvisory, "advisoryType" | "severity">): boolean =>
  MATERIAL_TYPES.includes(a.advisoryType) || MATERIAL_SEVERITIES.includes(a.severity);

type AdvisoryRow = typeof roadAdvisories.$inferSelect;
export const advisoryFromRow = (r: AdvisoryRow): RoadAdvisory => ({
  sourceKey: r.sourceKey, externalRef: r.externalRef, advisoryType: r.advisoryType, severity: r.severity,
  headline: r.headline, roadName: r.roadName,
  point: r.longitude != null && r.latitude != null ? [r.longitude, r.latitude] : null,
  radiusMetres: r.radiusMetres, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
  sourceUpdatedAt: r.sourceUpdatedAt, retrievedAt: r.retrievedAt, advisoryOnly: true,
});

/** The route as ordered legs with geometry, or null when no graph build was recorded. */
export async function routeLegs(db: Db, buildRef: string | null, segmentIds: readonly string[]): Promise<{ legs: RouteLeg[]; missing: number } | null> {
  if (!buildRef || !segmentIds.length) return null;
  const geo = await resolveRouteCommunicationGeography(db, { buildRef, segmentIds });
  const legs = segmentIds.map(segmentId => {
    const g = geo.geographyBySegment[segmentId] ?? null;
    return { segmentId, lengthKm: g ? pathLengthMetres(g.path) / 1000 : 0, geography: g };
  });
  return { legs, missing: geo.missing.length };
}

/**
 * Active advisories near a set of legs. The box is widened by the largest radius any active
 * advisory carries, read from the table rather than assumed, so a long closure whose circle is
 * centred far away is still a candidate. Placement itself is `advisoriesOnRoute`'s.
 */
export async function activeAdvisoriesNear(db: Db, legs: readonly RouteLeg[]): Promise<RoadAdvisory[]> {
  const pts = legs.flatMap(l => l.geography?.path ?? []);
  if (!pts.length) return [];
  const maxRadius = Number((await db.select({ r: sql<number>`COALESCE(MAX(${roadAdvisories.radiusMetres}), 0)` }).from(roadAdvisories).where(eq(roadAdvisories.status, "active")))[0]?.r ?? 0);
  const reach = Math.max(maxRadius, 2_000) + 1_000;
  const dLat = reach / 111_000;
  const lats = pts.map(p => p[1]), lngs = pts.map(p => p[0]);
  const minLat = Math.min(...lats) - dLat, maxLat = Math.max(...lats) + dLat;
  const cos = Math.max(0.05, Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));
  const dLng = reach / (111_000 * cos);
  const rows = await db.select().from(roadAdvisories).where(and(
    eq(roadAdvisories.status, "active"),
    isNotNull(roadAdvisories.latitude),
    gte(roadAdvisories.latitude, minLat), lte(roadAdvisories.latitude, maxLat),
    gte(roadAdvisories.longitude, Math.min(...lngs) - dLng), lte(roadAdvisories.longitude, Math.max(...lngs) + dLng),
  ));
  return rows.map(advisoryFromRow);
}

/**
 * The `liveAdvisories` dependency. Identity and the facts that change what a dispatcher should do —
 * type, severity, window — and not the wording or the publisher's update stamp, so a re-worded
 * headline is not a new decision and a closure becoming a lane restriction is.
 */
export async function liveAdvisoryDependency(db: Db, buildRef: string | null, segmentIds: readonly string[], at: Date): Promise<string> {
  const route = await routeLegs(db, buildRef, segmentIds);
  // No recorded build means no geometry to place anything on. Stated as such, and constant, so it
  // is honest about the gap and does not flap; readiness separately reports missing geometry.
  if (!route) return hashPart({ liveAdvisories: "no_route_geometry" });
  const advisories = await activeAdvisoriesNear(db, route.legs);
  const impact = advisoriesOnRoute({ route: route.legs, advisories, at });
  const material = impact.placed
    .map(p => p.advisory)
    .filter(isMaterialToRoute)
    .map(a => ({ source: a.sourceKey, ref: a.externalRef, type: a.advisoryType, severity: a.severity, from: a.effectiveFrom, to: a.effectiveTo }))
    .sort((a, b) => `${a.source}/${a.ref}`.localeCompare(`${b.source}/${b.ref}`));
  return hashPart({ material, missingSegments: route.missing });
}

/* ------------------------------------------------------------------ */
/* Everything an approval stood on                                       */
/* ------------------------------------------------------------------ */

/** Everything a route decision stood on, each as a hash: change one and the approval is stale. */
export async function routeDependencies(db: Db, args: { unitId: number; segmentIds: string[]; load: { grossWeightKg: number; dangerousGoods: boolean; unNumber?: string | null; heightM?: number | null; widthM?: number | null; lengthM?: number | null } | string; permitRefs: string[]; requiredChecks: string[]; at: Date; buildRef?: string | null; carryOver?: RouteDependencies }): Promise<RouteDependencies> {
  const profile = (await db.select().from(vehicleProfiles).where(eq(vehicleProfiles.unitId, args.unitId)).orderBy(desc(vehicleProfiles.id)).limit(1))[0] ?? null;
  const rs = args.segmentIds.length ? await db.select().from(roadRestrictions).where(inArray(roadRestrictions.segmentId, args.segmentIds)) : [];
  const live = applicableRestrictions(rs, args.at);
  const sts = args.segmentIds.length ? await db.select().from(structures).where(inArray(structures.segmentId, args.segmentIds)) : [];
  const liveStructures = sts.filter(x => x.verificationStatus !== "superseded" && inForce(x, args.at));
  const roads = args.segmentIds.length ? await db.select({ objectId: accessRoadSegments.objectId, importRunRef: accessRoadSegments.importRunRef }).from(accessRoadSegments).where(inArray(accessRoadSegments.objectId, args.segmentIds.map(id => Number(id.replace(/^AB-ACCESS-/, ""))).filter(n => Number.isInteger(n)))) : [];
  // v22.17 — which channel governs each segment at this moment, resolved by
  // authority exactly as the driver's screen resolves it. A temporary operator
  // change, or a driver's photographed sign confirmed by the office, moves this
  // hash and the approval says so in a dispatcher's words.
  const radio = args.segmentIds.length ? await db.select().from(roadRadioAssignments).where(inArray(roadRadioAssignments.segmentId, args.segmentIds)) : [];
  const governing = args.segmentIds.map(segmentId => {
    const chosen = resolveAssignment(
      radio.filter(r => r.segmentId === segmentId).map(r => ({ assignmentRef: r.assignmentRef, segmentId: r.segmentId, channelKey: r.channelKey, authorityTier: r.authorityTier, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, observedAt: r.observedAt, verificationStatus: r.verificationStatus })),
      args.at
    ).chosen;
    return { segmentId, channel: chosen?.channelKey ?? null, tier: chosen?.authorityTier ?? null };
  }).sort((a, b) => a.segmentId.localeCompare(b.segmentId));
  return {
    vehicleProfile: hashPart(profile ? { heightM: profile.heightM, widthM: profile.widthM, lengthM: profile.lengthM, emptyWeightKg: profile.emptyWeightKg, axleGroups: profile.axleGroupsJson, verificationStatus: profile.verificationStatus } : { absent: true }),
    loadProfile: typeof args.load === "string" ? args.load : loadFingerprint(args.load),
    permitSet: args.carryOver ? args.carryOver.permitSet : hashPart([...args.permitRefs].sort()),
    restrictionSet: hashPart(live.applied.map(r => ({ ref: r.restrictionRef, check: r.checkKey, limit: r.limitValue, text: r.textValue, verified: r.verificationStatus })).sort((a, b) => a.ref.localeCompare(b.ref))),
    structureSet: hashPart(liveStructures.map(x => ({ ref: x.structureRef, posted: x.postedWeightKg, axle: x.postedAxleGroupKg, clearance: x.clearanceM, width: x.widthM, seasonal: x.seasonalVariation, verified: x.verificationStatus })).sort((a, b) => a.ref.localeCompare(b.ref))),
    roadFabric: hashPart(roads.map(r => ({ objectId: r.objectId, run: r.importRunRef })).sort((a, b) => a.objectId - b.objectId)),
    requiredChecks: args.carryOver ? args.carryOver.requiredChecks : hashPart([...args.requiredChecks].sort()),
    communicationsPlan: hashPart(governing),
    liveAdvisories: await liveAdvisoryDependency(db, args.buildRef ?? null, args.segmentIds, args.at),
  };
}

export type ApprovalRecheck = {
  approvalRef: string;
  status: "approved" | "stale" | "revoked" | "superseded";
  stale: boolean;
  changed: (keyof RouteDependencies)[];
  reasons: string[];
  /** True when this recheck is what moved the approval from approved to stale. */
  becameStale: boolean;
};

/**
 * Is this approval still the answer? The only staleness computation — the procedure and the feed
 * runtime both call it. An approval never goes from stale back to approved here: a closure that
 * ends is a change too, and a person re-approves.
 */
export async function recheckRouteApproval(db: Db, a: RouteApprovalRow, at: Date): Promise<ApprovalRecheck> {
  if (a.status === "revoked" || a.status === "superseded") {
    return { approvalRef: a.approvalRef, status: a.status, stale: true, changed: [], reasons: [`This approval is ${a.status}`], becameStale: false };
  }
  const approved = JSON.parse(a.fingerprintJson) as RouteDependencies;
  const current = await routeDependencies(db, { unitId: a.unitId, segmentIds: JSON.parse(a.segmentIdsJson) as string[], load: approved.loadProfile, permitRefs: [], requiredChecks: [], at, buildRef: a.buildRef, carryOver: approved });
  const s = stalenessAgainst(approved, current);
  const becameStale = s.stale && a.status === "approved";
  if (becameStale) await db.update(routeApprovals).set({ status: "stale", staleReasonsJson: JSON.stringify(s.reasons), stalenessDetectedAt: new Date() }).where(eq(routeApprovals.id, a.id));
  return { approvalRef: a.approvalRef, status: s.stale ? "stale" : "approved", stale: s.stale, changed: s.changed, reasons: s.reasons, becameStale };
}

export type AdvisoryInvalidation = {
  /** Approved routes with recorded geometry that were looked at. */
  considered: number;
  /** Those whose geometry a changed advisory touches — the only ones rechecked. */
  rechecked: string[];
  /** Those the recheck moved to stale. */
  madeStale: string[];
};

/**
 * After a feed run changes advisories, recheck exactly the approvals they touch.
 *
 * `changed` holds both the new versions and the versions they replaced or withdrew: a closure that
 * moved, ended or was downgraded touches the route where it USED to be as much as where it is now.
 * Placement here ignores each advisory's time window, because "is this route near the change" is a
 * geometric question; whether it matters now is what the full recheck decides.
 *
 * Runs across every organization's approvals because a public road event is not anybody's record.
 * It reads no tenant's data into another's: the only write is the approval's own status, and the
 * reasons it records name the dependency, never another tenant's route.
 */
export async function invalidateApprovalsForAdvisoryChanges(db: Db, changed: readonly RoadAdvisory[], at: Date): Promise<AdvisoryInvalidation> {
  const out: AdvisoryInvalidation = { considered: 0, rechecked: [], madeStale: [] };
  const placeable = changed.filter(a => a.point).map(a => ({ ...a, effectiveFrom: null, effectiveTo: null }));
  if (!placeable.length) return out;
  const candidates = await db.select().from(routeApprovals).where(and(eq(routeApprovals.status, "approved"), isNotNull(routeApprovals.buildRef)));
  for (const a of candidates) {
    out.considered++;
    const route = await routeLegs(db, a.buildRef, JSON.parse(a.segmentIdsJson) as string[]);
    if (!route) continue;
    const touches = advisoriesOnRoute({ route: route.legs, advisories: placeable, at }).placed.length > 0;
    if (!touches) continue;
    out.rechecked.push(a.approvalRef);
    const r = await recheckRouteApproval(db, a, at);
    if (r.becameStale) out.madeStale.push(a.approvalRef);
  }
  return out;
}
