/**
 * Incident, near miss, and the roadside inspection scope.
 *
 * Near miss stays a separate record from incident. Combining them suppresses
 * reporting: an operator who has to open an "incident" form to say a spotter
 * stepped into a swing radius will often just not report it. The near miss is
 * deliberately three questions long, and escalates into an incident when the
 * answers warrant it rather than starting as one.
 *
 * The operator's own words are stored verbatim and are never replaced by an AI
 * summary. AI may structure; it may not rewrite the statement, and it may not
 * classify dangerous goods as verified (invariants #11, #13).
 */

export type IncidentType =
  | "hazard_observation"
  | "near_miss"
  | "incident"
  | "collision"
  | "injury"
  | "environmental_release"
  | "property_damage"
  | "equipment_event";

export type Severity = "none" | "minor" | "moderate" | "serious" | "critical";

export type EscalationState =
  | "captured"
  | "sealed"
  | "management_notified"
  | "under_review"
  | "corrective_action"
  | "closed";

export type IncidentFacts = {
  incidentType: IncidentType;
  injuryReported: boolean;
  emergencyServicesAttended: boolean;
  policeAttended: boolean;
  environmentalRelease: boolean;
  dangerousGoodsInvolved: boolean;
  workStopped: boolean;
  vehicleDamage?: boolean;
  equipmentDamage?: boolean;
};

/**
 * Severity is derived from the facts, not asked as a dropdown. Asking an
 * operator to self-rate severity immediately after an event produces noise;
 * asking what happened produces evidence.
 */
export function deriveSeverity(f: IncidentFacts): Severity {
  if (f.injuryReported || f.emergencyServicesAttended) return "critical";
  if (f.environmentalRelease || f.dangerousGoodsInvolved) return "serious";
  if (f.policeAttended || f.incidentType === "collision") return "serious";
  if (f.workStopped) return "moderate";
  if (f.vehicleDamage || f.equipmentDamage) return "moderate";
  if (f.incidentType === "hazard_observation") return "none";
  return "minor";
}

export type EscalationTarget =
  | "management"
  | "safety"
  | "dispatch"
  | "maintenance"
  | "hr"
  | "legal";

export type EscalationPlan = {
  severity: Severity;
  targets: EscalationTarget[];
  holdUnit: boolean;
  legalHoldRecommended: boolean;
  /** Whether the workflow engine should raise tasks immediately on sealing. */
  immediate: boolean;
};

/**
 * Who gets told, and whether the unit comes out of service.
 *
 * The workflow engine coordinates this. It does not diagnose the truck — an
 * incident holds a unit pending inspection; it does not decide what is wrong
 * with it. That stays with the shop.
 */
export function planEscalation(f: IncidentFacts): EscalationPlan {
  const severity = deriveSeverity(f);
  const targets = new Set<EscalationTarget>();

  if (severity !== "none") targets.add("safety");
  if (severity === "moderate" || severity === "serious" || severity === "critical") {
    targets.add("management");
  }
  if (f.injuryReported) targets.add("hr");
  if (severity === "critical" || f.environmentalRelease || f.policeAttended) {
    targets.add("legal");
  }
  if (f.workStopped) targets.add("dispatch");

  const holdUnit =
    f.vehicleDamage === true ||
    f.equipmentDamage === true ||
    f.incidentType === "collision" ||
    f.incidentType === "equipment_event" ||
    severity === "critical";

  // Holding a unit is a dispatch fact before it is anything else. A unit that
  // comes out of service without dispatch being told is how an already-assigned
  // job silently keeps a held truck on it. Derived from holdUnit rather than
  // re-listed per cause, so a new hold reason cannot forget to notify.
  if (holdUnit) {
    targets.add("dispatch");
    targets.add("maintenance");
  }

  return {
    severity,
    targets: [...Array.from(targets)].sort(),
    holdUnit,
    legalHoldRecommended: severity === "critical" || f.environmentalRelease,
    immediate: severity === "serious" || severity === "critical",
  };
}

const ESCALATION_ORDER: EscalationState[] = [
  "captured",
  "sealed",
  "management_notified",
  "under_review",
  "corrective_action",
  "closed",
];

export function canAdvanceEscalation(
  from: EscalationState,
  to: EscalationState
): boolean {
  const i = ESCALATION_ORDER.indexOf(from);
  const j = ESCALATION_ORDER.indexOf(to);
  // Forward one step, or straight to closed from under_review onward.
  if (i < 0 || j < 0) return false;
  if (j === i + 1) return true;
  return to === "closed" && from === "corrective_action";
}

export type NearMissAnswers = {
  originalStatement: string;
  anyoneInjured: boolean;
  workStopped: boolean;
};

export type NearMissOutcome = {
  accepted: boolean;
  mustEscalateToIncident: boolean;
  escalationReason?: string;
  rejectionReason?: string;
};

/**
 * A near miss with an injury is not a near miss. It converts, carrying the
 * original statement with it — the operator does not retype anything.
 */
export function evaluateNearMiss(a: NearMissAnswers): NearMissOutcome {
  if (!a.originalStatement.trim()) {
    return {
      accepted: false,
      mustEscalateToIncident: false,
      rejectionReason: "A near miss requires the operator's own description",
    };
  }
  if (a.anyoneInjured) {
    return {
      accepted: true,
      mustEscalateToIncident: true,
      escalationReason:
        "Injury reported — converts to an incident, original statement carried over",
    };
  }
  return { accepted: true, mustEscalateToIncident: false };
}

/**
 * AI may propose a structured summary. It may not touch the original.
 * Returns the record shape that must be persisted.
 */
export function applyAiSummary(args: {
  originalStatement: string;
  proposedSummary: string;
  confirmedByUserId?: number | null;
}): {
  originalStatement: string;
  structuredSummary: string;
  summarySource: "ai_proposed" | "ai_confirmed";
} {
  return {
    // Returned unchanged, deliberately. This is the assertion, not a comment.
    originalStatement: args.originalStatement,
    structuredSummary: args.proposedSummary,
    summarySource: args.confirmedByUserId ? "ai_confirmed" : "ai_proposed",
  };
}

/**
 * Dangerous goods on an incident stay a candidate until a human verifies them.
 * An AI-suggested UN number is never presented as classified.
 */
export function dangerousGoodsStatus(args: {
  unNumber?: string | null;
  verified: boolean;
}): { display: string; usableForRegulatoryPurposes: boolean } {
  if (!args.unNumber) {
    return { display: "Not identified", usableForRegulatoryPurposes: false };
  }
  return args.verified
    ? { display: `${args.unNumber} — verified`, usableForRegulatoryPurposes: true }
    : {
        display: `${args.unNumber} — candidate, unverified`,
        usableForRegulatoryPurposes: false,
      };
}

/* ------------------------------------------------------------------ */
/* Roadside / scale inspection scope                                    */
/* ------------------------------------------------------------------ */

export type InspectionScopeCategory =
  | "unit_registration"
  | "unit_insurance"
  | "safety_fitness"
  | "unit_inspection"
  | "permits"
  | "hours_of_service"
  | "current_trip_manifest"
  | "tdg_documents"
  | "load_information"
  | "trip_inspection"
  | "defect_status";

/**
 * What an inspector may see. Everything else on the device stays closed.
 *
 * An operator handing over a tablet must not be handing over customer billing,
 * other employees' records, incident investigations or private messages. This
 * is an allowlist for exactly that reason — a denylist would leak whatever
 * category someone adds next.
 */
export const ROADSIDE_INSPECTION_SCOPE: readonly InspectionScopeCategory[] = [
  "unit_registration",
  "unit_insurance",
  "safety_fitness",
  "unit_inspection",
  "permits",
  "hours_of_service",
  "current_trip_manifest",
  "tdg_documents",
  "load_information",
  "trip_inspection",
  "defect_status",
] as const;

export function isInInspectionScope(category: string): boolean {
  return (ROADSIDE_INSPECTION_SCOPE as readonly string[]).includes(category);
}

export type InspectionView<T extends { category: string }> = {
  visible: T[];
  withheldCount: number;
};

export function buildInspectionView<T extends { category: string }>(
  records: T[]
): InspectionView<T> {
  const visible = records.filter(r => isInInspectionScope(r.category));
  return { visible, withheldCount: records.length - visible.length };
}

/**
 * The hours-of-service production window: the current day plus the previous 14.
 *
 * This is the one place the 14-day figure legitimately belongs — it is the ELD
 * roadside-production requirement for RODS, not a universal document-retention
 * rule. LeaseOS presenting these records does not make LeaseOS a certified ELD;
 * that is a separate certification and is not claimed anywhere here.
 */
export const HOS_PRODUCTION_PRIOR_DAYS = 14;

export function hosProductionWindow(now: Date): { from: Date; to: Date; days: number } {
  const to = new Date(now.getTime());
  const from = new Date(now.getTime() - HOS_PRODUCTION_PRIOR_DAYS * 24 * 60 * 60 * 1000);
  return { from, to, days: HOS_PRODUCTION_PRIOR_DAYS + 1 };
}
