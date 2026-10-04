/**
 * T2 (P1) — which weight a route is evaluated against.
 *
 * The weight hierarchy is not decided here. It already exists twice over and both are reused:
 *   - `measurementQuality.authorityForWeightSource` ranks a source (certified scale → authority
 *     certified; calibrated LoadSense → instrument calibrated; driver entry → operator stated; …);
 *   - `loadSense.legalAxleDetermination` decided, when the reading was ingested, whether that reading
 *     may stand as a legal determination, and froze the answer on the snapshot (`legalDetermination`,
 *     0159). It is read as stored, never re-derived, so a calibration withdrawn later does not quietly
 *     un-make a determination that was legal when the reading was taken.
 *
 * What this adds is only the routing rule over those two answers:
 *
 *   a legally determined measurement exists for this trip/job/unit  → it controls, gross and every
 *                                                                     axle group, heavier OR lighter
 *                                                                     than what was declared;
 *   a measurement exists that is NOT legally determined              → it can tighten (if heavier than
 *                                                                     declared, it is used) but cannot
 *                                                                     establish compliance: a weight
 *                                                                     check it passes is REVIEW;
 *   no measurement                                                   → the declared profile, as before.
 *
 * A declared value never overrides an authoritative measurement.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { loadSenseAxleWeights, loadSenseWeightSnapshots } from "../drizzle/schema";
import type { getDb } from "./db";
import { authorityForWeightSource, type MeasurementAuthority, type WeightSource } from "./_core/measurementQuality";
import type { VehicleAxleGroup, WeightBasis } from "./_core/routeEvaluation";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * How old a unit-level reading may be and still describe the load on the road. A trip- or
 * job-matched reading is used regardless; an unmatched one older than this describes some earlier
 * load. Twelve hours is a shift.
 */
export const UNIT_READING_WINDOW_HOURS = 12;

export type RoutingWeight = {
  grossWeightKg: number;
  axleGroups: VehicleAxleGroup[];
  basis: WeightBasis;
  /** The snapshot used, when one was. */
  snapshotRef: string | null;
  authority: MeasurementAuthority | "declared";
  /** One sentence for the evidence trail. */
  note: string;
};

type Declared = { grossWeightKg: number; axleGroups: VehicleAxleGroup[] };

export async function routingWeightFor(db: Db, input: { unitId: number; tripId?: number | null; jobId?: number | null; at: Date; declared: Declared }): Promise<RoutingWeight> {
  const { declared } = input;
  const notAfter = lte(loadSenseWeightSnapshots.measuredAt, input.at);
  const pick = async (cond: ReturnType<typeof and>) =>
    (await db.select().from(loadSenseWeightSnapshots).where(cond).orderBy(desc(loadSenseWeightSnapshots.measuredAt), desc(loadSenseWeightSnapshots.id)).limit(1))[0];
  const snapshot =
    (input.tripId != null ? await pick(and(eq(loadSenseWeightSnapshots.unitId, input.unitId), eq(loadSenseWeightSnapshots.tripId, input.tripId), notAfter)) : undefined)
    ?? (input.jobId != null ? await pick(and(eq(loadSenseWeightSnapshots.unitId, input.unitId), eq(loadSenseWeightSnapshots.jobId, input.jobId), notAfter)) : undefined)
    ?? await pick(and(eq(loadSenseWeightSnapshots.unitId, input.unitId), notAfter, gte(loadSenseWeightSnapshots.measuredAt, new Date(input.at.getTime() - UNIT_READING_WINDOW_HOURS * 3_600_000))));

  if (!snapshot) {
    return { ...declared, basis: "declared", snapshotRef: null, authority: "declared", note: "Weight is the unit's declared profile; no measured reading applies to this trip" };
  }

  const groups = await db.select().from(loadSenseAxleWeights).where(eq(loadSenseAxleWeights.snapshotId, snapshot.id));
  // A measured group carries the axle count of the declared group with the same key, so its legal
  // type (single / tandem / tridem) is known; an unmatched group's type stays unknown.
  const declaredAxles = new Map(declared.axleGroups.map(g => [g.key, g.axles ?? null]));
  const measured: Declared = {
    grossWeightKg: snapshot.grossKg,
    axleGroups: groups.map(g => ({ key: g.axleGroupKey, label: g.label, weightKg: g.weightKg, axles: declaredAxles.get(g.axleGroupKey) ?? null })),
  };
  const authority = authorityForWeightSource(snapshot.measurementSource as WeightSource);

  if (snapshot.legalDetermination === true) {
    return {
      grossWeightKg: measured.grossWeightKg,
      // A determination with no per-group rows controls gross only; axle checks then fall back to the
      // declared groups, and the note says so rather than presenting them as measured.
      axleGroups: measured.axleGroups.length ? measured.axleGroups : declared.axleGroups,
      basis: "measured_legal", snapshotRef: snapshot.snapshotRef, authority,
      note: `Weight is the legally determined ${snapshot.measurementSource.replace(/_/g, " ")} reading ${snapshot.snapshotRef} (${snapshot.grossKg} kg gross); it controls over the declared ${declared.grossWeightKg} kg${measured.axleGroups.length ? "" : ". It carries no axle-group readings, so axle checks use the declared groups"}`,
    };
  }

  // Not legally determined: it may tighten, never establish compliance.
  const heavier = measured.grossWeightKg > declared.grossWeightKg;
  const why = snapshot.legalDeterminationCode ? ` (${snapshot.legalDeterminationCode})` : "";
  return {
    grossWeightKg: Math.max(measured.grossWeightKg, declared.grossWeightKg),
    axleGroups: heavier && measured.axleGroups.length ? measured.axleGroups : declared.axleGroups,
    basis: "measured_not_legal", snapshotRef: snapshot.snapshotRef, authority,
    note: `Reading ${snapshot.snapshotRef} (${snapshot.measurementSource.replace(/_/g, " ")}, ${snapshot.grossKg} kg) is not a legal determination${why}; ${heavier ? "it is heavier than declared, so it is used — " : "the declared weight is used — "}and no weight check can pass on it without review`,
  };
}
