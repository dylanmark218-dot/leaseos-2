/**
 * Commercial transport taxonomy.
 *
 * The point of this module is NOT to hold a big list of job titles. It is to
 * make one classification decision propagate everywhere it matters:
 *
 *     service + truck + trailer + cargo
 *                  │
 *      ┌───────────┼───────────┬──────────┬──────────┐
 *      ▼           ▼           ▼          ▼          ▼
 *   ROUTING     PERMITS   INSPECTION   TICKETS    BILLING
 *   PROFILE                            & PPE      UNITS
 *
 * Routing is the priority output: deriveRoutingProfile() produces the axle
 * groups, envelope and restriction layers the map engine must evaluate. A
 * dispatcher picks "oilfield vacuum haul, tri-axle vac truck, produced water"
 * and the router already knows which weight, clearance and dangerous-goods
 * layers apply.
 *
 * REGULATORY BOUNDARY: the thresholds in this file are configuration carrying
 * source and verification metadata, not asserted law. Nothing here decides
 * that a load is legal — it decides which rules must be CHECKED, and reports
 * unverified thresholds as unverified. See RegulatoryThresholds below.
 */

/* ============================ dimensions ============================ */

export type ServiceCategory =
  | "general"
  | "refrigerated"
  | "flatbed"
  | "heavy_haul"
  | "tanker"
  | "oilfield"
  | "construction"
  | "mining"
  | "forestry"
  | "agriculture"
  | "waste"
  | "auto"
  | "moving"
  | "municipal"
  | "recovery"
  | "intermodal";

export type OperatingEnvironment =
  | "highway"
  | "urban"
  | "rural"
  | "gravel"
  | "forestry_road"
  | "oilfield_lease"
  | "mine_site"
  | "private_property"
  | "northern_remote";

export type OperatingRadius =
  | "local"
  | "short_haul"
  | "regional"
  | "provincial"
  | "interprovincial"
  | "cross_border"
  | "long_haul"
  | "remote";

export type AxlePosition = "steer" | "drive" | "trailer" | "lift" | "booster";

export type AxleGroup = {
  position: AxlePosition;
  axles: number;
  /** Manufacturer rating — the physical ceiling, not the legal one. */
  ratingKg: number;
};

export type TruckConfiguration = {
  code: string;
  label: string;
  axleGroups: AxleGroup[];
  tareKg: number;
  lengthM: number;
  widthM: number;
  heightM: number;
  canTow: boolean;
  /** Pump/PTO/vacuum plant — drives hour-based maintenance and billing. */
  hasAuxiliaryPlant?: boolean;
};

export type TrailerConfiguration = {
  code: string;
  label: string;
  axleGroups: AxleGroup[];
  tareKg: number;
  lengthM: number;
  widthM: number;
  deckHeightM: number;
  extendable?: boolean;
};

export type CargoProfile = {
  code: string;
  label: string;
  category: ServiceCategory;
  hazardous: boolean;
  tdgClass?: string;
  unNumber?: string;
  packingGroup?: "I" | "II" | "III";
  temperatureControlled?: boolean;
  foodGrade?: boolean;
  livestock?: boolean;
  densityKgPerM3?: number;
  securementRequired: boolean;
  loadMethod: string;
  unloadMethod: string;
};

/* ====================== regulatory thresholds ====================== */

/**
 * Dimensions above which a permit conversation is required. These are
 * DISPATCH TRIGGERS, not legal determinations — they decide what the system
 * checks and warns about, never whether a movement is lawful. Every set
 * carries its own provenance so a stale table is visible as stale.
 */
export type RegulatoryThresholds = {
  jurisdiction: string;
  widthM: number;
  heightM: number;
  lengthM: number;
  gvwKg: number;
  source: string;
  effectiveDate?: string;
  lastVerified?: string;
  confidence: "unverified" | "operator_supplied" | "authority_confirmed";
};

/**
 * Placeholder defaults. Deliberately marked unverified: they must be replaced
 * with values confirmed against the issuing authority before dispatch relies
 * on them. The engine reports this state rather than hiding it.
 */
export const DEFAULT_THRESHOLDS: RegulatoryThresholds = {
  jurisdiction: "UNCONFIGURED",
  widthM: 2.6,
  heightM: 4.15,
  lengthM: 23.0,
  gvwKg: 63500,
  source: "Placeholder — not confirmed against any issuing authority",
  confidence: "unverified",
};

/* ========================== routing profile ========================== */

export type RestrictionLayer =
  | "gross_weight"
  | "axle_weight"
  | "bridge_clearance"
  | "bridge_weight"
  | "height"
  | "width"
  | "length"
  | "dangerous_goods"
  | "truck_route"
  | "seasonal_road_ban"
  | "oversize_corridor"
  | "escort_route"
  | "gravel_surface"
  | "lease_access"
  | "turnaround_capability"
  | "school_zone"
  | "residential_sensitivity";

export type LoadedAxleGroup = AxleGroup & {
  loadedKg: number;
  /** True when the modelled load exceeds the manufacturer rating. */
  exceedsRating: boolean;
};

export type RoutingProfile = {
  axleGroups: LoadedAxleGroup[];
  totalAxles: number;
  gvwKg: number;
  overallLengthM: number;
  widthM: number;
  heightM: number;
  isOversize: boolean;
  isOverweight: boolean;
  requiresPermit: boolean;
  requiresEscortReview: boolean;
  /** Exactly which map layers the router must evaluate for this movement. */
  restrictionLayers: RestrictionLayer[];
  thresholds: RegulatoryThresholds;
  /** Populated whenever a value could not be established. Never silently zero. */
  unknowns: string[];
  warnings: string[];
};

export type RoutingInput = {
  truck: TruckConfiguration;
  trailer?: TrailerConfiguration | null;
  cargo?: CargoProfile | null;
  cargoWeightKg?: number | null;
  /** Overrides the computed envelope when a load sits above the deck. */
  loadedHeightM?: number | null;
  loadedWidthM?: number | null;
  loadedLengthM?: number | null;
  environments?: OperatingEnvironment[];
  thresholds?: RegulatoryThresholds;
};

/**
 * Distribute a weight across axle groups in proportion to rated capacity.
 *
 * Tare is spread across every group — the steer axle genuinely carries part of
 * the truck's own weight. Cargo is spread across load-bearing groups only,
 * since payload does not sit on the steer axle.
 *
 * A modelled distribution, explicitly not a scale reading — the router uses it
 * to decide which restrictions to check, and a real axle weight always
 * supersedes it.
 */
function distribute(
  groups: AxleGroup[],
  weightKg: number,
  includeSteer: boolean
): number[] {
  const capacity = groups.map(g =>
    !includeSteer && g.position === "steer" ? 0 : g.ratingKg
  );
  const total = capacity.reduce((a, b) => a + b, 0);
  if (total === 0) return groups.map(() => 0);
  return capacity.map(cap => (weightKg * cap) / total);
}

export function deriveRoutingProfile(input: RoutingInput): RoutingProfile {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const unknowns: string[] = [];
  const warnings: string[] = [];

  const groups: AxleGroup[] = [
    ...input.truck.axleGroups,
    ...(input.trailer?.axleGroups ?? []),
  ];

  const tare = input.truck.tareKg + (input.trailer?.tareKg ?? 0);
  const cargoKg = input.cargoWeightKg ?? 0;
  if (input.cargoWeightKg == null) {
    unknowns.push("Cargo weight not established — profile modelled empty");
  }

  const share = distribute(groups, cargoKg, false);
  const tareShare = distribute(groups, tare, true);

  const axleGroups: LoadedAxleGroup[] = groups.map((g, i) => {
    const loadedKg = Math.round(tareShare[i] + share[i]);
    return { ...g, loadedKg, exceedsRating: loadedKg > g.ratingKg };
  });

  for (const g of axleGroups) {
    if (g.exceedsRating) {
      warnings.push(
        `${g.position} group modelled at ${g.loadedKg} kg, above its ${g.ratingKg} kg rating`
      );
    }
  }

  const gvwKg = tare + cargoKg;

  const overallLengthM =
    input.loadedLengthM ?? input.truck.lengthM + (input.trailer?.lengthM ?? 0);
  const widthM =
    input.loadedWidthM ??
    Math.max(input.truck.widthM, input.trailer?.widthM ?? 0);
  const heightM = input.loadedHeightM ?? input.truck.heightM;

  if (input.loadedHeightM == null && input.trailer) {
    unknowns.push(
      "Loaded height not measured — using tractor height, which may understate it"
    );
  }

  const isOversize =
    widthM > thresholds.widthM ||
    heightM > thresholds.heightM ||
    overallLengthM > thresholds.lengthM;
  const isOverweight = gvwKg > thresholds.gvwKg;

  if (thresholds.confidence === "unverified") {
    warnings.push(
      `Oversize/overweight thresholds for ${thresholds.jurisdiction} are unverified — confirm with the issuing authority before dispatch`
    );
  }

  // Layers always evaluated for a commercial movement.
  const layers = new Set<RestrictionLayer>([
    "gross_weight",
    "axle_weight",
    "bridge_weight",
    "bridge_clearance",
    "truck_route",
  ]);

  if (isOversize) {
    layers.add("oversize_corridor");
    if (widthM > thresholds.widthM) layers.add("width");
    if (heightM > thresholds.heightM) layers.add("height");
    if (overallLengthM > thresholds.lengthM) layers.add("length");
  }
  if (input.cargo?.hazardous) layers.add("dangerous_goods");

  for (const env of input.environments ?? []) {
    if (env === "gravel" || env === "forestry_road") {
      layers.add("gravel_surface");
      layers.add("seasonal_road_ban");
    }
    if (env === "oilfield_lease") {
      layers.add("lease_access");
      layers.add("turnaround_capability");
    }
    if (env === "urban") {
      layers.add("school_zone");
      layers.add("residential_sensitivity");
    }
    if (env === "northern_remote") layers.add("seasonal_road_ban");
  }

  const requiresEscortReview =
    isOversize &&
    (widthM > thresholds.widthM + 0.6 ||
      overallLengthM > thresholds.lengthM + 8);
  if (requiresEscortReview) layers.add("escort_route");

  return {
    axleGroups,
    totalAxles: groups.reduce((n, g) => n + g.axles, 0),
    gvwKg,
    overallLengthM,
    widthM,
    heightM,
    isOversize,
    isOverweight,
    requiresPermit: isOversize || isOverweight,
    requiresEscortReview,
    restrictionLayers: Array.from(layers),
    thresholds,
    unknowns,
    warnings,
  };
}

/* ======================= derived requirements ======================= */

export type JobRequirements = {
  licenceClass: string;
  endorsements: string[];
  safetyTickets: string[];
  ppe: string[];
  permits: string[];
  documents: string[];
  inspectionItems: string[];
  billingUnits: string[];
  notes: string[];
};

export type RequirementInput = RoutingInput & {
  service: ServiceCategory;
  radius?: OperatingRadius;
};

/**
 * Derive everything a dispatcher would otherwise have to remember. Output is
 * a checklist to satisfy, not a clearance — "requires TDG documentation" is a
 * prompt for a qualified person, not a statement that paperwork exists.
 */
export function deriveRequirements(input: RequirementInput): JobRequirements {
  const routing = deriveRoutingProfile(input);
  const endorsements = new Set<string>();
  const tickets = new Set<string>();
  const ppe = new Set<string>([
    "Hard hat",
    "Safety glasses",
    "Steel-toed boots",
    "Hi-vis",
  ]);
  const permits = new Set<string>();
  const documents = new Set<string>(["Trip inspection", "Driver daily log"]);
  const inspection = new Set<string>([
    "Brakes and air system",
    "Steering",
    "Lights and markers",
    "Tires and wheels",
    "Coupling devices",
    "Fluid leaks",
    "Emergency equipment",
  ]);
  const billing = new Set<string>();
  const notes: string[] = [];

  // Licence follows combination, not job title.
  const licenceClass = input.trailer ? "Class 1 / A" : "Class 3 / D";
  if (routing.axleGroups.some(g => g.position !== "steer"))
    endorsements.add("Air brake (Z)");

  if (input.cargo?.hazardous) {
    endorsements.add("TDG certification");
    documents.add("Shipping document");
    documents.add("Emergency response information");
    inspection.add("Placarding");
    inspection.add("Emergency response kit");
    ppe.add("Chemical-resistant gloves");
    notes.push(
      `Dangerous goods — Class ${input.cargo.tdgClass ?? "not specified"}${input.cargo.unNumber ? `, ${input.cargo.unNumber}` : ""}. Requirements must be confirmed against current regulations, not assumed from this list.`
    );
  }

  if (routing.requiresPermit) {
    permits.add(routing.isOversize ? "Oversize permit" : "Overweight permit");
    documents.add("Permit copy carried in unit");
    notes.push("Permit conditions override routing recommendations.");
  }
  if (routing.requiresEscortReview) {
    permits.add("Escort / pilot vehicle assessment");
  }

  switch (input.service) {
    case "oilfield":
      tickets
        .add("H2S Alive")
        .add("First Aid")
        .add("Ground Disturbance")
        .add("Site orientation");
      ppe.add("FR coveralls").add("Gas monitor");
      documents.add("Field ticket");
      billing.add("Per hour").add("Standby").add("Per load");
      inspection
        .add("Pump / PTO")
        .add("Tank and valves")
        .add("Hoses and fittings");
      break;
    case "waste":
      tickets.add("WHMIS").add("Spill response");
      documents
        .add("Disposal ticket")
        .add("Waste manifest")
        .add("Facility receipt");
      billing
        .add("Per load")
        .add("Per tonne")
        .add("Disposal fee")
        .add("Environmental fee");
      inspection.add("Tank and valves").add("Containment");
      break;
    case "heavy_haul":
      tickets.add("Load securement");
      documents.add("Route survey");
      billing
        .add("Per km")
        .add("Per hour")
        .add("Permit recovery")
        .add("Escort");
      inspection
        .add("Securement — chains, binders, straps")
        .add("Deck and outriggers");
      break;
    case "flatbed":
      tickets.add("Load securement");
      inspection.add("Securement — chains, binders, straps").add("Tarps");
      billing.add("Per km").add("Tarping");
      break;
    case "tanker":
      endorsements.add("Tanker experience");
      inspection
        .add("Tank and valves")
        .add("Hoses and fittings")
        .add("Surge baffles");
      billing.add("Per litre").add("Per load");
      break;
    case "refrigerated":
      inspection.add("Refrigeration unit").add("Temperature log");
      documents.add("Temperature record");
      billing.add("Per km").add("Reefer hours");
      break;
    case "construction":
      tickets.add("Ground Disturbance").add("Site orientation");
      billing.add("Per hour").add("Per tonne").add("Per load");
      inspection.add("Hoist / box").add("Tailgate");
      break;
    case "forestry":
      tickets.add("Radio protocol").add("Resource road training");
      billing.add("Per tonne").add("Per load");
      inspection.add("Bunks and stakes").add("Wrappers");
      break;
    case "mining":
      tickets.add("Site orientation").add("Mine safety");
      billing.add("Per tonne").add("Per hour");
      break;
    case "agriculture":
      billing.add("Per tonne").add("Per load");
      if (input.cargo?.livestock) {
        tickets.add("Livestock handling");
        documents.add("Animal transport record");
        inspection.add("Ventilation and gates");
      }
      break;
    case "recovery":
      tickets.add("Recovery operations").add("Traffic control");
      billing.add("Per hour").add("Callout").add("Winching").add("Storage");
      inspection.add("Winch and cables").add("Boom / rotator");
      break;
    default:
      billing.add("Per km").add("Per hour");
  }

  if (input.cargo?.foodGrade) {
    documents.add("Wash / purity certificate");
    inspection.add("Tank cleanliness");
  }
  if (input.cargo?.securementRequired) tickets.add("Load securement");

  for (const env of input.environments ?? []) {
    if (env === "oilfield_lease") tickets.add("Site orientation");
    if (env === "forestry_road" || env === "northern_remote") {
      tickets.add("Radio protocol");
      notes.push(
        "Remote operating environment — confirm communications coverage before dispatch."
      );
    }
    if (env === "mine_site") tickets.add("Mine site orientation");
  }

  if (input.radius === "cross_border") {
    documents.add("Customs documentation");
    endorsements.add("FAST / border clearance");
  }
  if (input.radius === "long_haul" || input.radius === "interprovincial") {
    notes.push(
      "Federal hours-of-service rules may apply instead of provincial — confirm the regime."
    );
  }

  billing.add("Wait time / detention");
  billing.add("Fuel surcharge");

  return {
    licenceClass,
    endorsements: Array.from(endorsements),
    safetyTickets: Array.from(tickets),
    ppe: Array.from(ppe),
    permits: Array.from(permits),
    documents: Array.from(documents),
    inspectionItems: Array.from(inspection),
    billingUnits: Array.from(billing),
    notes: notes.concat(routing.warnings),
  };
}

/* ============================= registry ============================= */

/**
 * Representative entries. The full taxonomy is DATA, not code — these seed a
 * `taxonomyEntries` table an administrator extends without a deployment.
 */
export const TRUCKS: Record<string, TruckConfiguration> = {
  "TRK-TANDEM": {
    code: "TRK-TANDEM",
    label: "Tandem straight truck",
    axleGroups: [
      { position: "steer", axles: 1, ratingKg: 7300 },
      { position: "drive", axles: 2, ratingKg: 17000 },
    ],
    tareKg: 11000,
    lengthM: 10.5,
    widthM: 2.59,
    heightM: 4.1,
    canTow: false,
  },
  "TRK-TRIDEM-VAC": {
    code: "TRK-TRIDEM-VAC",
    label: "Tri-drive vacuum truck",
    axleGroups: [
      { position: "steer", axles: 1, ratingKg: 8200 },
      { position: "drive", axles: 3, ratingKg: 31000 },
    ],
    tareKg: 17500,
    lengthM: 11.6,
    widthM: 2.59,
    heightM: 4.05,
    canTow: false,
    hasAuxiliaryPlant: true,
  },
  "TRK-TRACTOR-TANDEM": {
    code: "TRK-TRACTOR-TANDEM",
    label: "Tandem-drive tractor",
    axleGroups: [
      { position: "steer", axles: 1, ratingKg: 7300 },
      { position: "drive", axles: 2, ratingKg: 17000 },
    ],
    tareKg: 8600,
    lengthM: 6.8,
    widthM: 2.59,
    heightM: 4.0,
    canTow: true,
  },
  "TRK-WINCH-TRACTOR": {
    code: "TRK-WINCH-TRACTOR",
    label: "Winch tractor",
    axleGroups: [
      { position: "steer", axles: 1, ratingKg: 8200 },
      { position: "drive", axles: 2, ratingKg: 19000 },
    ],
    tareKg: 13500,
    lengthM: 8.2,
    widthM: 2.59,
    heightM: 4.1,
    canTow: true,
    hasAuxiliaryPlant: true,
  },
};

export const TRAILERS: Record<string, TrailerConfiguration> = {
  "TRL-TANKER-TANDEM": {
    code: "TRL-TANKER-TANDEM",
    label: "Tandem tanker",
    axleGroups: [{ position: "trailer", axles: 2, ratingKg: 17000 }],
    tareKg: 7200,
    lengthM: 12.5,
    widthM: 2.59,
    deckHeightM: 1.3,
  },
  "TRL-SUPER-B": {
    code: "TRL-SUPER-B",
    label: "Super-B train",
    axleGroups: [
      { position: "trailer", axles: 3, ratingKg: 24000 },
      { position: "trailer", axles: 2, ratingKg: 17000 },
    ],
    tareKg: 13800,
    lengthM: 20.5,
    widthM: 2.59,
    deckHeightM: 1.4,
  },
  "TRL-LOWBOY-RGN": {
    code: "TRL-LOWBOY-RGN",
    label: "Removable gooseneck lowboy",
    axleGroups: [{ position: "trailer", axles: 3, ratingKg: 27000 }],
    tareKg: 12500,
    lengthM: 15.8,
    widthM: 2.9,
    deckHeightM: 0.5,
    extendable: true,
  },
};

export const CARGO: Record<string, CargoProfile> = {
  "OIL-PRODUCED-WATER": {
    code: "OIL-PRODUCED-WATER",
    label: "Produced water",
    category: "oilfield",
    hazardous: false,
    densityKgPerM3: 1020,
    securementRequired: false,
    loadMethod: "Vacuum",
    unloadMethod: "Pump",
  },
  "OIL-CRUDE": {
    code: "OIL-CRUDE",
    label: "Crude oil",
    category: "tanker",
    hazardous: true,
    tdgClass: "3",
    unNumber: "UN1267",
    packingGroup: "I",
    densityKgPerM3: 870,
    securementRequired: false,
    loadMethod: "Pump",
    unloadMethod: "Pump",
  },
  "ENV-LIQUID-WASTE": {
    code: "ENV-LIQUID-WASTE",
    label: "Liquid industrial waste",
    category: "waste",
    hazardous: true,
    tdgClass: "9",
    securementRequired: false,
    loadMethod: "Vacuum",
    unloadMethod: "Pump",
  },
  "HVY-EXCAVATOR": {
    code: "HVY-EXCAVATOR",
    label: "Tracked excavator",
    category: "heavy_haul",
    hazardous: false,
    securementRequired: true,
    loadMethod: "Self load",
    unloadMethod: "Self load",
  },
};
