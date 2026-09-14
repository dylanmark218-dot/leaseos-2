/**
 * Routing constraint compiler.
 *
 *   Job classification → Restriction profile → CONSTRAINT PROFILE → Map engine
 *
 * The compiler's job is subtraction. Rather than handing the router every
 * restriction that exists and asking it to work out which apply, it emits only
 * the checks this particular load actually needs. A tandem straight truck
 * carrying water on a paved highway should never cause the router to evaluate
 * dangerous-goods corridors or lease gate access.
 *
 * Determinism is a hard requirement (gate 1): the same classification must
 * always produce the same routeProfileId. That is what makes a stored routing
 * decision reproducible, and what lets a changed classification invalidate
 * dependent routes automatically (gate 9). The id therefore hashes the inputs
 * only — never the clock.
 */

import {
  deriveRoutingProfile,
  type OperatingEnvironment,
  type RegulatoryThresholds,
  type RestrictionLayer,
  type RoutingInput,
  type RoutingProfile,
} from "./taxonomy";

/** Concrete evaluations the map engine performs against a road segment. */
export type RequiredCheck =
  | "road_weight_restriction"
  | "axle_group_limit"
  | "bridge_capacity"
  | "bridge_axle_limit"
  | "overhead_clearance"
  | "bridge_clearance"
  | "width_restriction"
  | "length_restriction"
  | "truck_route_designation"
  | "dg_corridor"
  | "dg_time_restriction"
  | "seasonal_closure"
  | "road_ban_level"
  | "surface_condition"
  | "weather_interaction"
  | "lease_gate_access"
  | "road_owner_permission"
  | "turnaround_suitability"
  | "oversize_corridor_designation"
  | "escort_requirement"
  | "school_zone_timing"
  | "residential_restriction";

export type DispatchStatus = "clear" | "warning" | "review" | "blocked";

export type RegulatoryConfidence = RegulatoryThresholds["confidence"];

export type ConstraintProfile = {
  /** Deterministic over inputs. Stable across runs and machines. */
  routeProfileId: string;
  jurisdiction: string;
  vehicle: {
    grossWeightKg: number;
    axleCount: number;
    axleGroups: Array<{
      position: string;
      axles: number;
      loadedKg: number;
      ratingKg: number;
    }>;
    dimensions: { lengthM: number; widthM: number; heightM: number };
    configuration: string;
  };
  cargo: {
    classification: string | null;
    dangerousGoods: boolean;
    tdgClass?: string;
    unNumber?: string;
  };
  environment: OperatingEnvironment[];
  restrictionLayers: RestrictionLayer[];
  requiredChecks: RequiredCheck[];
  regulatoryConfidence: RegulatoryConfidence;
  dispatchStatus: DispatchStatus;
  /** Everything the profile could not establish. Never silently defaulted. */
  unknowns: string[];
  warnings: string[];
};

/**
 * Which concrete checks each restriction layer implies. Kept as an explicit
 * map so the router's workload is auditable — you can read off exactly what a
 * given layer will cost.
 */
const LAYER_CHECKS: Record<RestrictionLayer, RequiredCheck[]> = {
  gross_weight: ["road_weight_restriction", "bridge_capacity"],
  axle_weight: ["axle_group_limit", "bridge_axle_limit"],
  bridge_weight: ["bridge_capacity"],
  bridge_clearance: ["bridge_clearance", "overhead_clearance"],
  height: ["overhead_clearance", "bridge_clearance"],
  width: ["width_restriction"],
  length: ["length_restriction"],
  dangerous_goods: ["dg_corridor", "dg_time_restriction"],
  truck_route: ["truck_route_designation"],
  seasonal_road_ban: ["seasonal_closure", "road_ban_level"],
  oversize_corridor: ["oversize_corridor_designation"],
  escort_route: ["escort_requirement"],
  gravel_surface: ["surface_condition", "weather_interaction"],
  lease_access: ["lease_gate_access", "road_owner_permission"],
  turnaround_capability: ["turnaround_suitability"],
  school_zone: ["school_zone_timing"],
  residential_sensitivity: ["residential_restriction"],
};

/** FNV-1a. Deterministic, dependency-free, adequate for an identity token. */
function stableHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Key-sorted serialisation so property order can never change the hash. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${k}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export type CompilerInput = RoutingInput & {
  jurisdiction?: string;
  environments?: OperatingEnvironment[];
};

export function compileConstraintProfile(
  input: CompilerInput
): ConstraintProfile {
  const routing: RoutingProfile = deriveRoutingProfile(input);
  const jurisdiction = input.jurisdiction ?? routing.thresholds.jurisdiction;

  const checks = new Set<RequiredCheck>();
  for (const layer of routing.restrictionLayers) {
    for (const check of LAYER_CHECKS[layer] ?? []) checks.add(check);
  }
  const requiredChecks = Array.from(checks).sort();
  const restrictionLayers = routing.restrictionLayers.slice().sort();

  const vehicle = {
    grossWeightKg: routing.gvwKg,
    axleCount: routing.totalAxles,
    axleGroups: routing.axleGroups.map(g => ({
      position: g.position,
      axles: g.axles,
      loadedKg: g.loadedKg,
      ratingKg: g.ratingKg,
    })),
    dimensions: {
      lengthM: routing.overallLengthM,
      widthM: routing.widthM,
      heightM: routing.heightM,
    },
    configuration: input.trailer
      ? `${input.truck.code}+${input.trailer.code}`
      : input.truck.code,
  };

  const cargo = {
    classification: input.cargo?.code ?? null,
    dangerousGoods: Boolean(input.cargo?.hazardous),
    tdgClass: input.cargo?.tdgClass,
    unNumber: input.cargo?.unNumber,
  };

  const environment = (input.environments ?? []).slice().sort();

  // Hash inputs only — never compiledAt, or the same classification would
  // produce a different id on every run and invalidation would fire forever.
  const routeProfileId = `RP-${stableHash(
    canonical({
      jurisdiction,
      vehicle,
      cargo,
      environment,
      restrictionLayers,
      requiredChecks,
      thresholds: {
        widthM: routing.thresholds.widthM,
        heightM: routing.thresholds.heightM,
        lengthM: routing.thresholds.lengthM,
        gvwKg: routing.thresholds.gvwKg,
        confidence: routing.thresholds.confidence,
      },
    })
  )}`;

  return {
    routeProfileId,
    jurisdiction,
    vehicle,
    cargo,
    environment,
    restrictionLayers,
    requiredChecks,
    regulatoryConfidence: routing.thresholds.confidence,
    dispatchStatus: deriveDispatchStatus(routing),
    unknowns: routing.unknowns,
    warnings: routing.warnings,
  };
}

function deriveDispatchStatus(routing: RoutingProfile): DispatchStatus {
  // A group modelled past its manufacturer rating is a physical problem, not
  // a paperwork one — it blocks regardless of what the map says.
  if (routing.axleGroups.some(g => g.exceedsRating)) return "blocked";
  if (routing.thresholds.confidence === "unverified") return "warning";
  if (routing.requiresPermit) return "review";
  if (routing.unknowns.length > 0) return "warning";
  return "clear";
}

/**
 * Gate 9: a stored routing result is only valid for the classification that
 * produced it. Recompile and compare — cheap, and removes any chance of a
 * route surviving a change to the load it was computed for.
 */
export function isProfileStale(
  storedProfileId: string,
  current: CompilerInput
): boolean {
  return compileConstraintProfile(current).routeProfileId !== storedProfileId;
}
