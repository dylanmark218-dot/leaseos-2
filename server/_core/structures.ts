/**
 * v22.15 — Structures, effective-dated restrictions, and route staleness.
 *
 * Three pure concerns:
 *   • a restriction applies on a date or it does not apply at all;
 *   • a structure on a road contributes limits the road itself does not state;
 *   • an approved route carries a fingerprint of everything it depended on, so
 *     changing any of them makes the approval stale by arithmetic instead of
 *     by somebody remembering.
 */
import { createHash } from "node:crypto";
import type { RequiredCheck } from "./routingCompiler";
import type { SegmentAttribute } from "./routeEvaluation";

/* ---- a restriction applies on a date, or not at all ---- */

export type Dated = { effectiveFrom?: Date | null; effectiveTo?: Date | null };
export type WindowState = "in_force" | "not_yet_in_force" | "expired" | "always";

export function windowState(d: Dated, at: Date): WindowState {
  const from = d.effectiveFrom ?? null, to = d.effectiveTo ?? null;
  if (!from && !to) return "always";
  if (from && at.getTime() < from.getTime()) return "not_yet_in_force";
  if (to && at.getTime() >= to.getTime()) return "expired";
  return "in_force";
}
export const inForce = (d: Dated, at: Date) => { const s = windowState(d, at); return s === "in_force" || s === "always"; };

/**
 * The rows that apply to a segment on a date, one per check: a verified row
 * over an unverified one, the latest within each, and **only** those in force.
 * What a row's window excludes is reported, never silently dropped — a ban
 * that ended last month is worth knowing about when a driver remembers it.
 */
export function applicableRestrictions<T extends Dated & { id: number; checkKey: string; verificationStatus: "unverified" | "verified" }>(rows: readonly T[], at: Date): { applied: T[]; setAside: { row: T; state: WindowState }[] } {
  const setAside: { row: T; state: WindowState }[] = [];
  const live: T[] = [];
  for (const r of rows) {
    const state = windowState(r, at);
    if (state === "in_force" || state === "always") live.push(r);
    else setAside.push({ row: r, state });
  }
  // Verified beats unverified. Among rows of equal standing for one check, the **most restrictive** limit governs —
  // a spring ban of 9,000 kg and a standing 29,000 kg limit are both in force, and the driver must obey 9,000. Taking
  // the latest-recorded row instead could pick the more permissive of two limits, which is the wrong way to be wrong.
  const checks = Array.from(new Set(live.map(r => r.checkKey)));
  const applied: T[] = [];
  const limitOf = (r: T): number | null => { const v = (r as unknown as { limitValue?: number | null }).limitValue; return typeof v === "number" ? v : null; };
  for (const check of checks) {
    const rows = live.filter(r => r.checkKey === check);
    const verified = rows.filter(r => r.verificationStatus === "verified");
    const pool: T[] = verified.length ? verified : rows;
    const numeric = pool.filter(r => limitOf(r) != null);
    const governing = numeric.length
      ? numeric.reduce((a: T, b: T) => (limitOf(b)! < limitOf(a)! ? b : a))
      : [...pool].sort((a: T, b: T) => b.id - a.id)[0]!;
    applied.push(governing);
  }
  return { applied, setAside };
}

/* ---- a structure's limits ---- */

export type StructureLike = {
  structureRef: string; kind: string; label: string; jurisdiction: string;
  clearanceM: number | null; postedWeightKg: number | null; postedAxleGroupKg: number | null; ratedWeightKg: number | null; widthM: number | null;
  seasonalVariation: string | null; source: string; sourceVersion: string | null;
  verificationStatus: "unverified" | "verified" | "superseded"; verifiedAt: Date | null;
} & Dated;

/**
 * What a structure contributes to the segment it sits on.
 *
 * A **posted** limit is the limit. A rated capacity with nothing posted is
 * *not* a posted limit — it is engineering data, and it produces a review
 * rather than a pass, because what governs a driver is the sign. An
 * unverified structure contributes at `operator_supplied` confidence, which
 * the evaluator already treats as not authority.
 */
export function structureAttributes(s: StructureLike, at: Date): { attributes: SegmentAttribute[]; notes: string[] } {
  const notes: string[] = [];
  const state = windowState(s, at);
  if (state === "not_yet_in_force" || state === "expired") return { attributes: [], notes: [`${s.label} (${s.structureRef}) is ${state.replace(/_/g, " ")} on this date and was not applied`] };
  if (s.verificationStatus === "superseded") return { attributes: [], notes: [`${s.label} (${s.structureRef}) is superseded and was not applied`] };
  const confidence = s.verificationStatus === "verified" ? "authority_confirmed" as const : "operator_supplied" as const;
  const base = { jurisdiction: s.jurisdiction, source: `${s.source} · ${s.kind} ${s.structureRef}`, sourceVersion: s.sourceVersion, verifiedAt: s.verifiedAt?.toISOString() ?? null, confidence };
  const attributes: SegmentAttribute[] = [];
  if (s.postedWeightKg != null) attributes.push({ check: "bridge_capacity", limitValue: s.postedWeightKg, ...base });
  else if (s.ratedWeightKg != null) notes.push(`${s.label}: a rated capacity of ${s.ratedWeightKg} kg is recorded with nothing posted — engineering data is not a posted limit, so bridge capacity stays UNKNOWN`);
  if (s.postedAxleGroupKg != null) attributes.push({ check: "bridge_axle_limit", limitValue: s.postedAxleGroupKg, ...base });
  if (s.clearanceM != null) attributes.push({ check: s.kind === "overhead" ? "overhead_clearance" : "bridge_clearance", limitValue: s.clearanceM, ...base });
  if (s.widthM != null) attributes.push({ check: "width_restriction", limitValue: s.widthM, ...base });
  if (s.seasonalVariation) { attributes.push({ check: "seasonal_closure", textValue: s.seasonalVariation, ...base }); notes.push(`${s.label}: seasonal variation recorded — ${s.seasonalVariation}`); }
  if (s.verificationStatus === "unverified") notes.push(`${s.label} (${s.structureRef}) is unverified; its limits carry operator-supplied confidence, not authority`);
  return { attributes, notes };
}

/* ---- an approved route knows when it has gone stale ---- */

export type RouteDependencies = {
  vehicleProfile: string;      // the unit's measured envelope and axle groups
  loadProfile: string;         // what is on it: weight, dangerous goods, dimensions
  permitSet: string;           // the permits relied on
  restrictionSet: string;      // the restrictions in force over the segments, as applied
  structureSet: string;        // the structures on those segments, as applied
  roadFabric: string;          // which imported roads, at which import run
  requiredChecks: string;      // what was asked of the route
  /**
   * v22.17 — the channel that governs each segment, and who says so. A road
   * operator moving a haul road to a different channel for one week is a real
   * change to the trip a driver was briefed on, so an approval that stood on
   * the old channel goes stale by arithmetic rather than by somebody
   * remembering to look. Optional, so approvals recorded before v22.17 are
   * compared on the dependencies they actually carried.
   */
  communicationsPlan?: string;
  /**
   * The provincial road advisories that touch this route's geometry and are material to it — a
   * closure, a restriction, or anything major or of unknown severity. A closure appearing, ending
   * or changing severity on THIS route moves the hash; one on a road nearby does not. Advisory
   * evidence makes an approval stale, which asks a person to look again; it never makes a route
   * legal or illegal. Optional, so approvals recorded before it are compared on what they carried.
   */
  liveAdvisories?: string;
  /**
   * T2 (P4) — the weight the route is evaluated against (basis, gross and axle groups to 100 kg).
   * Optional, so earlier approvals are compared on what they carried.
   */
  measuredWeight?: string;
  /** T2 (P4) — each road ban's resolved jurisdiction and verified base-rule promotion. Optional, likewise. */
  legalRules?: string;
};
export const DEPENDENCY_LABELS: Record<keyof RouteDependencies, string> = {
  vehicleProfile: "the unit's profile", loadProfile: "the load", permitSet: "the permits", restrictionSet: "the restrictions in force", structureSet: "the structures on the route", roadFabric: "the imported road data", requiredChecks: "the checks required", communicationsPlan: "the radio channels on the route", liveAdvisories: "the provincial road advisories on the route", measuredWeight: "the authoritative vehicle weight", legalRules: "the legal rules the road bans resolve against",
};

export function hashPart(value: unknown): string {
  const canonical = (v: unknown): unknown => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex").slice(0, 32);
}
export function fingerprintHash(d: RouteDependencies): string {
  return createHash("sha256").update(Object.keys(d).sort().map(k => `${k}=${d[k as keyof RouteDependencies]}`).join("|")).digest("hex");
}

export type Staleness = { stale: boolean; changed: (keyof RouteDependencies)[]; reasons: string[] };
/** What changed since the route was approved, named in the words a dispatcher would use. */
export function stalenessAgainst(approved: RouteDependencies, current: RouteDependencies): Staleness {
  const changed = (Object.keys(approved) as (keyof RouteDependencies)[]).filter(k => approved[k] !== current[k]);
  return {
    stale: changed.length > 0,
    changed,
    reasons: changed.map(k => `${DEPENDENCY_LABELS[k]} changed since this route was approved`),
  };
}

/** The load as a dependency. A heavier load is a different route question, not the same one. */
export function loadFingerprint(load: { grossWeightKg: number; dangerousGoods: boolean; unNumber?: string | null; heightM?: number | null; widthM?: number | null; lengthM?: number | null }): string {
  return hashPart({ grossWeightKg: load.grossWeightKg, dangerousGoods: load.dangerousGoods, unNumber: load.unNumber ?? null, heightM: load.heightM ?? null, widthM: load.widthM ?? null, lengthM: load.lengthM ?? null });
}
