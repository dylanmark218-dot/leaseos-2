/**
 * Translating a LeaseOS constraint profile into an external truck router's
 * request.
 *
 * `compileConstraintProfile` already produces exactly what an open-source truck
 * router needs — gross weight, axle group loads, length, width, height,
 * dangerous-goods status. So the routing work is a translation, not a graph
 * algorithm, and this file is that translation.
 *
 * Two things it refuses to do.
 *
 * **Enforcement evasion.** Gap item #5 has been carried as documentation since
 * the first reconciliation because the guard was thought to belong to the
 * routing-preference structure in the unmerged Spatial branch. It belongs here
 * instead: this is LeaseOS's own outbound surface, the last point where a
 * preference becomes a request to a router. A guard here holds whatever the
 * upstream branch eventually looks like, and does not invent a structure to
 * guard. Weigh stations, inspection stations and enforcement checkpoints may be
 * *displayed* as resources so an operator knows what is ahead; they are never
 * an avoidance objective, and "avoid delays" must not become an indirect one.
 *
 * **Routing on unknowns.** A profile carrying unresolved restriction data does
 * not get quietly downgraded into a request the router will happily answer.
 * The request is emitted with the unknowns attached, and the result cannot be
 * called clear.
 */

import type { ConstraintProfile } from "./routingCompiler";

/* ------------------------------------------------------------------ */
/* The guard                                                            */
/* ------------------------------------------------------------------ */

/**
 * Preference keys that may never reach a routing engine.
 *
 * Matched on normalized substrings rather than exact keys, because the risk is
 * not someone typing `avoidWeighStations` — it is a well-meaning "avoid delays"
 * heuristic quietly acquiring a scale-avoidance term later.
 */
const PROHIBITED_PREFERENCE_TERMS = [
  "avoidweighstation",
  "avoidweighstations",
  "avoidscale",
  "avoidscales",
  "avoidinspection",
  "avoidinspectionstation",
  "avoidinspectionstations",
  "avoidenforcement",
  "avoidenforcementcheckpoint",
  "avoidenforcementcheckpoints",
  "avoidcheckpoint",
  "avoidcheckpoints",
  "avoidportofentry",
  "bypassscale",
  "bypassweigh",
  "bypassinspection",
  "evadeenforcement",
  "avoidcvsa",
  "avoiddot",
] as const;

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

export type GuardResult =
  | { ok: true }
  | { ok: false; rejected: string[]; reason: string };

/**
 * Reject prohibited routing preferences. Called before any request is built,
 * and it throws rather than filtering — silently dropping the key would let a
 * caller believe evasion was applied.
 */
export function guardRoutingPreferences(
  preferences: Record<string, unknown>
): GuardResult {
  const rejected: string[] = [];
  for (const key of Object.keys(preferences)) {
    const n = normalize(key);
    if (PROHIBITED_PREFERENCE_TERMS.some(term => n.includes(term))) {
      rejected.push(key);
    }
  }
  if (rejected.length === 0) return { ok: true };
  return {
    ok: false,
    rejected,
    reason:
      `Refused routing preference(s): ${rejected.join(", ")}. ` +
      "Mandatory enforcement checkpoints are not an avoidance optimization target. " +
      "Lawful alternatives around clearances, weight limits, closures and hazardous " +
      "terrain remain fully supported.",
  };
}

/** Enforcement facilities may be shown. Displaying is not avoiding. */
export type DisplayableResource =
  | "weigh_station"
  | "inspection_station"
  | "public_scale"
  | "port_of_entry";

export function mayDisplayResource(_r: DisplayableResource): true {
  return true;
}

/* ------------------------------------------------------------------ */
/* The translation                                                      */
/* ------------------------------------------------------------------ */

/**
 * A truck-costing request, shaped after the parameters open-source truck
 * routers accept. Deliberately engine-neutral: the fields are the physical
 * facts, so a different router can be substituted without changing the caller.
 */
export type TruckRoutingRequest = {
  costing: "truck";
  costingOptions: {
    height: number;
    width: number;
    length: number;
    /** Metric tonnes — most truck routers take weight in tonnes, not kg. */
    weight: number;
    axleLoad: number;
    axleCount: number;
    hazmat: boolean;
  };
  /** Non-prohibited preferences only. Guarded before construction. */
  preferences: Record<string, unknown>;
  /** Travels with the request so a result can never outrun its own caveats. */
  provenance: {
    routeProfileId: string;
    jurisdiction: string;
    regulatoryConfidence: string;
    unknowns: string[];
    warnings: string[];
  };
};

export type TranslationOutcome =
  | { ok: true; request: TruckRoutingRequest; caveats: string[] }
  | { ok: false; reason: string; rejected?: string[] };

/** kg → tonnes, to one gram. Rounding here is not a place to be loose. */
function kgToTonnes(kg: number): number {
  return Math.round((kg / 1000) * 1000) / 1000;
}

/** The heaviest axle group decides the axle-load parameter. */
function maxAxleLoadTonnes(profile: ConstraintProfile): number {
  const groups = profile.vehicle.axleGroups;
  if (groups.length === 0) return 0;
  const perAxle = groups.map(g =>
    g.axles > 0 ? g.loadedKg / g.axles : g.loadedKg
  );
  return kgToTonnes(Math.max(...perAxle));
}

export function buildTruckRoutingRequest(args: {
  profile: ConstraintProfile;
  preferences?: Record<string, unknown>;
}): TranslationOutcome {
  const preferences = args.preferences ?? {};

  const guard = guardRoutingPreferences(preferences);
  if (!guard.ok) {
    return { ok: false, reason: guard.reason, rejected: guard.rejected };
  }

  const p = args.profile;
  const dims = p.vehicle.dimensions;

  if (
    !(dims.heightM > 0) ||
    !(dims.widthM > 0) ||
    !(dims.lengthM > 0) ||
    !(p.vehicle.grossWeightKg > 0)
  ) {
    // A router given a zero height will route under anything.
    return {
      ok: false,
      reason:
        "Vehicle dimensions or gross weight are missing — a truck router given a zero dimension will route under a bridge it cannot clear",
    };
  }

  const caveats: string[] = [];

  if (p.unknowns.length > 0) {
    caveats.push(
      `${p.unknowns.length} unresolved constraint(s) — the returned route cannot be treated as clear`
    );
  }
  // The trunk's confidence ladder is unverified | operator_supplied |
  // authority_confirmed. Only the last certifies. Operator-supplied information
  // can warn or block a corridor but never establishes that one is clear.
  if (p.regulatoryConfidence !== "authority_confirmed") {
    caveats.push(
      `Regulatory data confidence is ${p.regulatoryConfidence} — restriction checks are advisory until authority-confirmed`
    );
  }
  if (p.dispatchStatus === "blocked") {
    caveats.push("Profile is already BLOCKED before routing");
  }

  return {
    ok: true,
    caveats,
    request: {
      costing: "truck",
      costingOptions: {
        height: dims.heightM,
        width: dims.widthM,
        length: dims.lengthM,
        weight: kgToTonnes(p.vehicle.grossWeightKg),
        axleLoad: maxAxleLoadTonnes(p),
        axleCount: p.vehicle.axleCount,
        hazmat: p.cargo.dangerousGoods,
      },
      preferences,
      provenance: {
        routeProfileId: p.routeProfileId,
        jurisdiction: p.jurisdiction,
        regulatoryConfidence: p.regulatoryConfidence,
        unknowns: p.unknowns,
        warnings: p.warnings,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Interpreting the answer                                              */
/* ------------------------------------------------------------------ */

export type RouteVerdict = "ready_to_approve" | "review" | "blocked" | "unknown";

export type RouteAssessment = {
  verdict: RouteVerdict;
  /** Never `approved`. Only an authenticated human acknowledgement approves. */
  reasons: string[];
  requiresHumanAcknowledgement: boolean;
};

/**
 * Turn an engine result plus our own constraint state into a verdict.
 *
 * An external router answers "is there a path for a vehicle of these
 * dimensions". It does not know about seasonal bans nobody has loaded, a
 * bridge posting a driver reported this morning, or whether the layer that
 * said "no restriction" was refreshed this month. So a clean engine result is
 * a necessary input to the verdict and never the verdict itself.
 */
export function assessRoutingResult(args: {
  engineFoundRoute: boolean;
  profile: Pick<
    ConstraintProfile,
    "unknowns" | "warnings" | "dispatchStatus" | "regulatoryConfidence"
  >;
  staleLayers?: string[];
}): RouteAssessment {
  const reasons: string[] = [];

  if (!args.engineFoundRoute) {
    return {
      verdict: "blocked",
      reasons: ["No route exists for this vehicle configuration"],
      requiresHumanAcknowledgement: false,
    };
  }

  if (args.profile.dispatchStatus === "blocked") {
    return {
      verdict: "blocked",
      reasons: ["Constraint profile is blocked independently of the route"],
      requiresHumanAcknowledgement: false,
    };
  }

  const stale = args.staleLayers ?? [];
  if (stale.length > 0) {
    reasons.push(`Stale restriction layer(s): ${stale.join(", ")}`);
  }
  if (args.profile.unknowns.length > 0) {
    reasons.push(...args.profile.unknowns.map(u => `Unknown: ${u}`));
  }

  if (reasons.length > 0) {
    // Unknown beats a clean engine answer. This is the invariant that stops a
    // router's "path found" from being read as "road is legal and safe".
    return {
      verdict: "unknown",
      reasons,
      requiresHumanAcknowledgement: true,
    };
  }

  if (
    args.profile.regulatoryConfidence !== "authority_confirmed" ||
    args.profile.warnings.length > 0 ||
    args.profile.dispatchStatus === "review" ||
    args.profile.dispatchStatus === "warning"
  ) {
    return {
      verdict: "review",
      reasons: [
        ...args.profile.warnings,
        ...(args.profile.regulatoryConfidence !== "authority_confirmed"
          ? [`Regulatory confidence is ${args.profile.regulatoryConfidence}`]
          : []),
      ],
      requiresHumanAcknowledgement: true,
    };
  }

  return {
    verdict: "ready_to_approve",
    reasons: [],
    requiresHumanAcknowledgement: true,
  };
}
