/**
 * T2 — the one place a route's segments become evaluator input.
 *
 * Moved out of `spatial.routeEvaluateSegments` so the same evaluation can be re-run by readiness
 * (P5) without a second copy that could drift. It assembles evidence and calls the existing
 * `evaluateRoute`; it is not another evaluator. What it hands over, per segment:
 *
 *   - road restrictions in force at `at` (`applicableRestrictions`), each with its recorded unit;
 *   - every bridge and structure limit on the segment (defect 1B — none is dropped because a road
 *     restriction covers the same check; the evaluator picks the controlling one);
 *   - road bans resolved into per-axle-group allowances (P2): a percentage ban is a fraction of the
 *     legal axle allowance of the jurisdiction that posted it, read from the verified rule ledger
 *     (`believedRuleOn("axle_load_limit", "CA-XX", at)`). No verified rule in force, a jurisdiction
 *     that cannot be resolved, or a segment the road data places in a different province → UNKNOWN,
 *     with the reason. Nothing is estimated and no neighbouring jurisdiction is borrowed;
 *   - the vehicle's weight from `routingWeightFor` (P1): a legally determined reading controls.
 *
 * Jurisdiction (P3). A segment's rule context is the jurisdiction on the verified restriction that
 * invokes the rule — a person recorded it and a second person verified it against a source
 * document. The road-geometry resolver's province (`resolveRouteCommunicationGeography`) is only
 * "probable" (it describes the road DATASET, and the resolver itself says it cannot authorize a
 * province-limited rule), so it is used as a cross-check, never as the source: when it is known and
 * disagrees, the rule does not apply and the check is UNKNOWN. The origin's province is never
 * propagated along the route; each segment stands on its own evidence.
 */
import { inArray, eq } from "drizzle-orm";
import { bridges, roadRestrictions, structures, vehicleProfiles } from "../drizzle/schema";
import type { getDb } from "./db";
import { believedRuleOn } from "./_core/knowledge/promotionLedger";
import { evaluateRoute, type AxleGroupType, type RoadSegmentInput, type RouteVerdict, type SegmentAttribute, type VehicleValues } from "./_core/routeEvaluation";
import type { RequiredCheck } from "./_core/routingCompiler";
import { applicableRestrictions, structureAttributes } from "./_core/structures";
import { resolveRouteCommunicationGeography } from "./routeCommunicationGeography";
import { routingWeightFor, type RoutingWeight } from "./routingWeight";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type RestrictionRow = typeof roadRestrictions.$inferSelect;

/** The ledger family that holds a jurisdiction's legal axle allowances, by group type. */
export const AXLE_LOAD_RULE_FAMILY = "axle_load_limit";

/** "CA-AB", "AB", "ca-ab" → "AB". Anything else is not a jurisdiction this slice can select rules for. */
export function provinceCode(jurisdiction: string | null | undefined): string | null {
  if (!jurisdiction) return null;
  const m = /^(?:CA-)?([A-Z]{2,4})$/i.exec(jurisdiction.trim());
  return m ? m[1]!.toUpperCase() : null;
}

/** What a road ban resolved to, for the evidence trail and the approval fingerprint. */
export type RoadBanResolution = {
  segmentId: string;
  restrictionRef: string;
  percent: number | null;
  jurisdiction: string | null;
  /** The verified base rule used, or null when none applied. */
  rulePromotionRef: string | null;
  outcome: "resolved" | "unresolved";
  reason: string;
};

const isPercent = (unit: string | null) => !!unit && ["%", "percent", "pct"].includes(unit.trim().toLowerCase());

/**
 * A percentage road ban → allowances per axle-group type, or the reason it cannot be one.
 * Only a structured ban (percentage + unit) is read here; a ban recorded as prose stays a text
 * attribute for the evaluator's existing keyword reading, because nothing structured exists for it.
 */
export async function resolveRoadBan(row: RestrictionRow, segmentProvince: string | null, at: Date): Promise<{ attribute: SegmentAttribute; resolution: RoadBanResolution }> {
  const base = {
    check: "road_ban_level" as RequiredCheck,
    source: `restriction ${row.restrictionRef}: ${row.source}`,
    sourceVersion: row.sourceVersion,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    confidence: row.verificationStatus === "verified" ? "authority_confirmed" as const : "unverified" as const,
  };
  const prov = provinceCode(row.jurisdiction);
  const jurisdiction = prov ? `CA-${prov}` : null;
  const unresolved = (reason: string, rulePromotionRef: string | null = null) => ({
    attribute: { ...base, jurisdiction: row.jurisdiction, unresolvedReason: reason },
    resolution: { segmentId: row.segmentId, restrictionRef: row.restrictionRef, percent: row.limitValue, jurisdiction, rulePromotionRef, outcome: "unresolved" as const, reason },
  });

  if (row.limitValue == null || !(row.limitValue > 0)) return unresolved(`Road ban ${row.restrictionRef} records no percentage, so no allowance can be computed`);
  if (!prov) return unresolved(`Road ban ${row.restrictionRef} names "${row.jurisdiction}", which is not a jurisdiction LeaseOS can select a legal axle rule for — the allowance is UNKNOWN rather than borrowed from a neighbouring jurisdiction`);
  if (segmentProvince && segmentProvince !== prov) {
    return unresolved(`Road ban ${row.restrictionRef} names ${jurisdiction}, but this segment's road data places it in CA-${segmentProvince}; with the controlling jurisdiction in conflict, neither rule is applied`);
  }
  const rule = await believedRuleOn(AXLE_LOAD_RULE_FAMILY, jurisdiction!, at);
  if (!rule) {
    return unresolved(`${row.limitValue}% road ban ${row.restrictionRef} is in force, but no verified legal axle-load rule (${AXLE_LOAD_RULE_FAMILY}/${jurisdiction}) is in force on ${at.toISOString().slice(0, 10)} — the permitted load is UNKNOWN, not estimated`);
  }
  const groups = (rule.payload as { groups?: Partial<Record<AxleGroupType, unknown>> } | null)?.groups ?? {};
  const groupLimitsKg: Partial<Record<AxleGroupType, number>> = {};
  for (const t of ["single", "tandem", "tridem"] as const) {
    const v = groups[t];
    if (typeof v === "number" && v > 0) groupLimitsKg[t] = Math.floor((v * row.limitValue) / 100);
  }
  if (!Object.keys(groupLimitsKg).length) return unresolved(`The verified rule ${rule.promotionRef} carries no axle-group allowances this ban can be applied to`, rule.promotionRef);
  const reason = `${row.limitValue}% of ${jurisdiction} legal axle allowances (rule ${rule.promotionRef})`;
  return {
    attribute: { ...base, jurisdiction, groupLimitsKg, source: `${base.source}; ${reason}`, sourceVersion: rule.promotionRef },
    resolution: { segmentId: row.segmentId, restrictionRef: row.restrictionRef, percent: row.limitValue, jurisdiction, rulePromotionRef: rule.promotionRef, outcome: "resolved", reason },
  };
}

export type SegmentsEvaluation = {
  profile: typeof vehicleProfiles.$inferSelect;
  vehicle: VehicleValues;
  weight: RoutingWeight;
  segments: RoadSegmentInput[];
  verdict: RouteVerdict;
  roadBans: RoadBanResolution[];
  /** Segment → province from the road data (probable), when a graph build was named. */
  segmentProvinces: Record<string, string | null>;
  dateNotes: string[];
  structureNotes: string[];
};

export class NoVehicleProfile extends Error {}

export async function evaluateSegments(db: Db, input: {
  unitId: number;
  segments: { segmentId: string; label: string; lengthKm: number }[];
  at: Date;
  requiredChecks: RequiredCheck[];
  dangerousGoods: boolean;
  requiresEscort: boolean;
  tripId?: number | null;
  jobId?: number | null;
  /** When named, each segment's road-data province is cross-checked against the rule jurisdiction. */
  buildRef?: string | null;
}): Promise<SegmentsEvaluation> {
  const p = (await db.select().from(vehicleProfiles).where(eq(vehicleProfiles.unitId, input.unitId)).limit(1))[0];
  if (!p) throw new NoVehicleProfile("No vehicle profile for this unit — record its dimensions and axle weights first");
  const groups = JSON.parse(p.axleGroupsJson) as { name: string; axles?: number; loadedKg: number }[];
  // P1 — the declared profile is the fallback; a legally determined reading controls (routingWeight.ts).
  const weight = await routingWeightFor(db, {
    unitId: input.unitId, tripId: input.tripId ?? null, jobId: input.jobId ?? null, at: input.at,
    declared: { grossWeightKg: groups.reduce((a, g) => a + g.loadedKg, 0), axleGroups: groups.map(g => ({ key: g.name, label: g.name, weightKg: g.loadedKg, axles: g.axles ?? null })) },
  });
  const vehicle: VehicleValues = {
    grossWeightKg: weight.grossWeightKg, maxAxleGroupKg: Math.max(...weight.axleGroups.map(g => g.weightKg)),
    axleGroups: weight.axleGroups, weightBasis: weight.basis,
    heightM: p.heightM, widthM: p.widthM, lengthM: p.lengthM, dangerousGoods: input.dangerousGoods, requiresEscort: input.requiresEscort,
  };

  const ids = input.segments.map(s => s.segmentId);
  const [rs, bs, live] = await Promise.all([
    db.select().from(roadRestrictions).where(inArray(roadRestrictions.segmentId, ids)),
    db.select().from(bridges).where(inArray(bridges.segmentId, ids)),
    db.select().from(structures).where(inArray(structures.segmentId, ids)),
  ]);
  const segmentProvinces: Record<string, string | null> = {};
  if (input.buildRef) {
    const geo = await resolveRouteCommunicationGeography(db, { buildRef: input.buildRef, segmentIds: ids });
    for (const id of ids) segmentProvinces[id] = geo.geographyBySegment[id]?.province ?? null;
  }

  const dateNotes: string[] = [];
  const structureNotes: string[] = [];
  const roadBans: RoadBanResolution[] = [];
  const segments: RoadSegmentInput[] = [];
  for (const s of input.segments) {
    const attrs: SegmentAttribute[] = [];
    // Restrictions in force at `at`; what a window excludes is reported, never silently dropped.
    const windowed = applicableRestrictions(rs.filter(x => x.segmentId === s.segmentId), input.at);
    for (const { row, state } of windowed.setAside) dateNotes.push(`${s.label}: ${row.checkKey.replace(/_/g, " ")} restriction ${row.restrictionRef} is ${state.replace(/_/g, " ")} on ${input.at.toISOString().slice(0, 10)} and was not applied`);
    for (const r of windowed.applied) {
      if (r.checkKey === "road_ban_level" && isPercent(r.unit)) {
        const { attribute, resolution } = await resolveRoadBan(r, segmentProvinces[s.segmentId] ?? null, input.at);
        attrs.push(attribute);
        roadBans.push(resolution);
        continue;
      }
      // The recorded unit travels with the limit: one the check does not use is UNKNOWN in the evaluator.
      attrs.push({ check: r.checkKey as RequiredCheck, limitValue: r.limitValue, textValue: r.textValue, unit: r.unit, jurisdiction: r.jurisdiction, source: `restriction ${r.restrictionRef}: ${r.source}`, sourceVersion: r.sourceVersion, verifiedAt: r.verifiedAt?.toISOString() ?? null, confidence: r.verificationStatus === "verified" ? "authority_confirmed" : "unverified" });
    }
    for (const b of bs.filter(x => x.segmentId === s.segmentId)) {
      const conf = b.verifiedAt ? "authority_confirmed" as const : "unverified" as const;
      if (b.postedWeightKg != null) attrs.push({ check: "bridge_capacity", limitValue: b.postedWeightKg, jurisdiction: b.jurisdiction, source: b.source, sourceVersion: b.sourceVersion, verifiedAt: b.verifiedAt?.toISOString() ?? null, confidence: conf });
      if (b.postedAxleGroupKg != null) attrs.push({ check: "bridge_axle_limit", limitValue: b.postedAxleGroupKg, jurisdiction: b.jurisdiction, source: b.source, sourceVersion: b.sourceVersion, verifiedAt: b.verifiedAt?.toISOString() ?? null, confidence: conf });
      if (b.clearanceM != null) attrs.push({ check: "bridge_clearance", limitValue: b.clearanceM, jurisdiction: b.jurisdiction, source: b.source, sourceVersion: b.sourceVersion, verifiedAt: b.verifiedAt?.toISOString() ?? null, confidence: conf });
    }
    // Defect 1B — every structure contributes, including for a check a road restriction covers.
    for (const st of live.filter(x => x.segmentId === s.segmentId)) {
      const contributed = structureAttributes(st, input.at);
      attrs.push(...contributed.attributes.map(a => ({ ...a, source: `structure ${st.structureRef}: ${a.source ?? st.label}` })));
      structureNotes.push(...contributed.notes);
    }
    segments.push({ segmentId: s.segmentId, label: s.label, lengthKm: s.lengthKm, attributes: attrs });
  }

  const verdict = evaluateRoute(input.requiredChecks, segments, vehicle);
  return { profile: p, vehicle, weight, segments, verdict, roadBans, segmentProvinces, dateNotes, structureNotes };
}

/**
 * T2 (P5) — a route evaluation's per-check results, as readiness blockers.
 *
 * One blocker per (outcome, check), naming the segment, the actual constraint and where it came
 * from, so "route blocked" is never the whole answer. Codes are registered in `complianceFinding`:
 *   FAIL                          → `route_check_failed_<check>`   blocking, never overridable;
 *   UNKNOWN on a legal/feasible   → `route_check_unknown_<check>`  unknown (not clean eligible);
 *   REVIEW, or UNKNOWN preference → `route_check_review_<check>`   review.
 * A pass contributes nothing. Several segments failing one check fold into one blocker that names
 * the first and counts the rest, with every source kept as an evidence reference.
 */
export type RouteCheckBlocker = {
  code: string; label: string; severity: "blocking" | "unknown" | "review"; subject: "route";
  overridable: boolean; overrideAuthority?: "manager"; evidenceRefs: string[];
};
export function routeCheckBlockers(evidence: readonly RouteVerdict["evidence"][number][], evaluationRef: string | null): RouteCheckBlocker[] {
  const groups = new Map<string, { kind: "failed" | "unknown" | "review"; rows: RouteVerdict["evidence"][number][] }>();
  for (const e of evidence) {
    const kind = e.result === "fail" ? "failed" : e.result === "review" ? "review" : e.result === "unknown" ? (e.axis === "preferred" ? "review" : "unknown") : null;
    if (!kind) continue;
    const key = `route_check_${kind}_${e.check}`;
    const g = groups.get(key) ?? { kind, rows: [] };
    g.rows.push(e);
    groups.set(key, g);
  }
  const out: RouteCheckBlocker[] = [];
  for (const [code, { kind, rows }] of Array.from(groups)) {
    const first = rows[0]!;
    const src = first.source ? ` [${first.source}${first.sourceVersion ? ` @ ${first.sourceVersion}` : ""}]` : " [no source recorded]";
    const more = rows.length > 1 ? ` (and ${rows.length - 1} more segment${rows.length > 2 ? "s" : ""})` : "";
    const verb = kind === "failed" ? "FAILS" : kind === "unknown" ? "is UNKNOWN" : "needs review";
    const refs = new Set<string>();
    if (evaluationRef) refs.add(`evaluation:${evaluationRef}`);
    for (const r of rows) { refs.add(`segment:${r.segmentId}`); if (r.source) refs.add(r.source.slice(0, 200)); }
    out.push({
      code, label: `Route ${first.check.replace(/_/g, " ")} ${verb} on ${first.segmentLabel}: ${first.reason}${src}${more}`,
      severity: kind === "failed" ? "blocking" : kind, subject: "route",
      overridable: kind !== "failed", ...(kind !== "failed" ? { overrideAuthority: "manager" as const } : {}),
      evidenceRefs: Array.from(refs).sort(),
    });
  }
  return out;
}
