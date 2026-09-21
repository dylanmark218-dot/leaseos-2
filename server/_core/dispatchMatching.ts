/**
 * Dispatch capability matching.
 *
 * This module answers ONE question: does this operator/equipment pairing look
 * suitable enough to show them the job and let them bid?
 *
 * It deliberately does NOT decide whether the job can be assigned. That is
 * dispatchReadiness.ts, and the two return incompatible shapes on purpose —
 * a MatchResult has a score and cannot be coerced into an eligibility verdict.
 * The rule from the spec, made structural:
 *
 *     A positive match or accepted bid must NEVER imply dispatch eligibility.
 *
 * Every score is accompanied by its reasons. There is no opaque ranking — if
 * LeaseOS suggests a candidate, a dispatcher can read exactly why.
 */

export type CapabilityKind =
  | "licence"
  | "endorsement"
  | "certification"
  | "orientation"
  | "equipment_class"
  | "trailer_class"
  | "specialty"
  | "region"
  | "experience";

export type Capability = {
  kind: CapabilityKind;
  code: string;
  label: string;
  /** Certifications expire; experience does not. */
  expiresAt?: Date | null;
  /**
   * True only where the capability is an actual credential. Experience
   * ("has done rig moves before") helps matching but is not a credential and
   * must never be presented as one.
   */
  isCredential: boolean;
};

export type OperatorProfile = {
  operatorId: number;
  name: string;
  capabilities: Capability[];
  specialtyPools: string[];
  operatingRegions: string[];
  onCall: boolean;
  availableFrom?: Date | null;
  maxRadiusKm?: number | null;
  distanceFromOriginKm?: number | null;
};

export type EquipmentProfile = {
  unitId: number;
  unitNumber: string;
  equipmentClass: string;
  trailerClass?: string | null;
  axleConfiguration?: string | null;
  tankCapacityL?: number | null;
  pumpCapable?: boolean;
  ptoCapable?: boolean;
  winchRatingKg?: number | null;
  deckLengthM?: number | null;
  payloadKg?: number | null;
  dgCompatible?: boolean;
};

export type JobRequirements = {
  jobCode: string;
  specialtyPool?: string | null;
  requiredCapabilities: Array<{
    kind: CapabilityKind;
    code: string;
    label: string;
  }>;
  /** Helpful but not disqualifying. */
  preferredCapabilities?: Array<{
    kind: CapabilityKind;
    code: string;
    label: string;
  }>;
  requiredEquipmentClass?: string | null;
  requiredTrailerClass?: string | null;
  minPayloadKg?: number | null;
  minTankCapacityL?: number | null;
  requiresPump?: boolean;
  requiresDgCompatible?: boolean;
  operatingRegion?: string | null;
  scheduledStart?: Date | null;
};

export type MatchReason = {
  factor: string;
  outcome: "met" | "missing" | "expired" | "partial" | "unknown";
  detail: string;
  /** Contribution to the score, so the arithmetic is inspectable. */
  points: number;
};

export type MatchResult = {
  /** Potentially qualified — may see the posting and bid. NOT assignable. */
  matched: boolean;
  score: number;
  reasons: MatchReason[];
  missingRequirements: string[];
  explanation: string;
};

const has = (caps: Capability[], kind: CapabilityKind, code: string) =>
  caps.find(c => c.kind === kind && c.code === code);

const isExpired = (cap: Capability, asOf: Date) =>
  Boolean(cap.expiresAt && cap.expiresAt.getTime() < asOf.getTime());

/**
 * Score an operator + equipment pairing against a job.
 *
 * `matched: false` means the posting should not be advertised to this
 * operator at all — a heavy-haul assignment must not appear to someone whose
 * profile cannot satisfy its basic requirements.
 */
export function matchOperatorToJob(
  operator: OperatorProfile,
  equipment: EquipmentProfile | null,
  job: JobRequirements,
  asOf: Date
): MatchResult {
  const reasons: MatchReason[] = [];
  const missing: string[] = [];
  let disqualified = false;

  // --- required capabilities -------------------------------------------
  for (const req of job.requiredCapabilities) {
    const cap = has(operator.capabilities, req.kind, req.code);
    if (!cap) {
      reasons.push({
        factor: req.label,
        outcome: "missing",
        detail: `Not held`,
        points: 0,
      });
      missing.push(req.label);
      disqualified = true;
    } else if (isExpired(cap, asOf)) {
      reasons.push({
        factor: req.label,
        outcome: "expired",
        detail: `Expired ${cap.expiresAt?.toISOString().slice(0, 10)}`,
        points: 0,
      });
      missing.push(`${req.label} (expired)`);
      disqualified = true;
    } else {
      reasons.push({
        factor: req.label,
        outcome: "met",
        detail: "Current",
        points: 10,
      });
    }
  }

  // --- specialty pool ---------------------------------------------------
  if (job.specialtyPool) {
    if (operator.specialtyPools.includes(job.specialtyPool)) {
      reasons.push({
        factor: "Specialty pool",
        outcome: "met",
        detail: job.specialtyPool,
        points: 10,
      });
    } else {
      reasons.push({
        factor: "Specialty pool",
        outcome: "missing",
        detail: `Not in ${job.specialtyPool}`,
        points: 0,
      });
      missing.push(`Specialty pool: ${job.specialtyPool}`);
      disqualified = true;
    }
  }

  // --- equipment --------------------------------------------------------
  if (job.requiredEquipmentClass) {
    if (!equipment) {
      reasons.push({
        factor: "Equipment",
        outcome: "missing",
        detail: "No unit proposed",
        points: 0,
      });
      missing.push("Proposed unit");
      disqualified = true;
    } else if (equipment.equipmentClass !== job.requiredEquipmentClass) {
      reasons.push({
        factor: "Equipment class",
        outcome: "missing",
        detail: `${equipment.equipmentClass}, needs ${job.requiredEquipmentClass}`,
        points: 0,
      });
      missing.push(`Equipment class: ${job.requiredEquipmentClass}`);
      disqualified = true;
    } else {
      reasons.push({
        factor: "Equipment class",
        outcome: "met",
        detail: equipment.equipmentClass,
        points: 15,
      });
    }
  }

  if (equipment) {
    if (job.requiredTrailerClass) {
      const ok = equipment.trailerClass === job.requiredTrailerClass;
      reasons.push({
        factor: "Trailer class",
        outcome: ok ? "met" : "missing",
        detail: ok
          ? equipment.trailerClass!
          : `${equipment.trailerClass ?? "none"}, needs ${job.requiredTrailerClass}`,
        points: ok ? 10 : 0,
      });
      if (!ok) {
        missing.push(`Trailer class: ${job.requiredTrailerClass}`);
        disqualified = true;
      }
    }
    if (job.minTankCapacityL != null) {
      const cap = equipment.tankCapacityL ?? null;
      if (cap == null) {
        reasons.push({
          factor: "Tank capacity",
          outcome: "unknown",
          detail: "Not recorded on unit",
          points: 0,
        });
        missing.push("Tank capacity unknown");
      } else if (cap < job.minTankCapacityL) {
        reasons.push({
          factor: "Tank capacity",
          outcome: "missing",
          detail: `${cap} L, needs ${job.minTankCapacityL} L`,
          points: 0,
        });
        missing.push("Tank capacity");
        disqualified = true;
      } else {
        reasons.push({
          factor: "Tank capacity",
          outcome: "met",
          detail: `${cap} L`,
          points: 8,
        });
      }
    }
    if (job.requiresPump) {
      const ok = Boolean(equipment.pumpCapable);
      reasons.push({
        factor: "Pump",
        outcome: ok ? "met" : "missing",
        detail: ok ? "Fitted" : "Not fitted",
        points: ok ? 8 : 0,
      });
      if (!ok) {
        missing.push("Pump capability");
        disqualified = true;
      }
    }
    if (job.requiresDgCompatible) {
      const ok = Boolean(equipment.dgCompatible);
      reasons.push({
        factor: "DG compatibility",
        outcome: ok ? "met" : "missing",
        detail: ok ? "Compatible" : "Unit not DG compatible",
        points: ok ? 10 : 0,
      });
      if (!ok) {
        missing.push("DG-compatible unit");
        disqualified = true;
      }
    }
    if (job.minPayloadKg != null) {
      const p = equipment.payloadKg ?? null;
      if (p == null) {
        reasons.push({
          factor: "Payload",
          outcome: "unknown",
          detail: "Not recorded on unit",
          points: 0,
        });
        missing.push("Payload rating unknown");
      } else if (p < job.minPayloadKg) {
        reasons.push({
          factor: "Payload",
          outcome: "missing",
          detail: `${p} kg, needs ${job.minPayloadKg} kg`,
          points: 0,
        });
        missing.push("Payload");
        disqualified = true;
      } else {
        reasons.push({
          factor: "Payload",
          outcome: "met",
          detail: `${p} kg`,
          points: 8,
        });
      }
    }
  }

  // --- soft factors: never disqualifying --------------------------------
  if (job.operatingRegion) {
    const ok = operator.operatingRegions.includes(job.operatingRegion);
    reasons.push({
      factor: "Operating region",
      outcome: ok ? "met" : "partial",
      detail: ok
        ? job.operatingRegion
        : `Outside usual regions (${operator.operatingRegions.join(", ") || "none set"})`,
      points: ok ? 8 : 2,
    });
  }

  if (operator.distanceFromOriginKm != null) {
    const d = operator.distanceFromOriginKm;
    const points = d <= 25 ? 10 : d <= 75 ? 6 : d <= 150 ? 3 : 1;
    reasons.push({
      factor: "Distance from origin",
      outcome: "met",
      detail: `${d} km`,
      points,
    });
    if (operator.maxRadiusKm != null && d > operator.maxRadiusKm) {
      reasons.push({
        factor: "Working radius",
        outcome: "partial",
        detail: `${d} km exceeds the operator's stated ${operator.maxRadiusKm} km radius`,
        points: 0,
      });
    }
  }

  if (operator.onCall) {
    reasons.push({
      factor: "On call",
      outcome: "met",
      detail: "Currently on call",
      points: 5,
    });
  }

  if (job.scheduledStart && operator.availableFrom) {
    const ok = operator.availableFrom.getTime() <= job.scheduledStart.getTime();
    reasons.push({
      factor: "Availability",
      outcome: ok ? "met" : "partial",
      detail: ok
        ? "Available before start"
        : `Available from ${operator.availableFrom.toISOString().slice(11, 16)}`,
      points: ok ? 8 : 0,
    });
  }

  for (const pref of job.preferredCapabilities ?? []) {
    const cap = has(operator.capabilities, pref.kind, pref.code);
    const ok = Boolean(cap && !isExpired(cap, asOf));
    reasons.push({
      factor: `${pref.label} (preferred)`,
      outcome: ok ? "met" : "partial",
      detail: ok ? "Held" : "Not held — not disqualifying",
      points: ok ? 5 : 0,
    });
  }

  const earned = reasons.reduce((s, r) => s + r.points, 0);
  const possible =
    reasons.reduce(
      (s, r) => s + Math.max(r.points, maxPointsFor(r.factor)),
      0
    ) || 1;
  const score = disqualified
    ? 0
    : Math.min(100, Math.round((earned / possible) * 100));

  return {
    matched: !disqualified,
    score,
    reasons,
    missingRequirements: missing,
    explanation: explainMatch(operator, !disqualified, reasons, missing),
  };
}

function maxPointsFor(factor: string): number {
  if (factor.includes("Equipment class")) return 15;
  if (factor.includes("preferred")) return 5;
  if (factor === "On call") return 5;
  return 10;
}

function explainMatch(
  operator: OperatorProfile,
  matched: boolean,
  reasons: MatchReason[],
  missing: string[]
): string {
  if (!matched) {
    return `${operator.name} is not a match: ${missing.join("; ")}.`;
  }
  const met = reasons
    .filter(r => r.outcome === "met")
    .map(r => `${r.factor} (${r.detail})`);
  const partial = reasons
    .filter(r => r.outcome === "partial")
    .map(r => r.detail);
  let s = `Suggested because ${met.slice(0, 6).join(", ")}`;
  if (partial.length) s += `. Noted: ${partial.join("; ")}`;
  return `${s}. This is a suitability match only — dispatch eligibility is evaluated separately.`;
}

/**
 * Postings must only be advertised to operators who could potentially do the
 * work. Filtering here is a safety and signal-to-noise measure, not a
 * substitute for the eligibility gate at award time.
 */
export function filterVisiblePostings<
  T extends { requirements: JobRequirements },
>(
  postings: T[],
  operator: OperatorProfile,
  equipment: EquipmentProfile | null,
  asOf: Date
): T[] {
  return postings.filter(
    p => matchOperatorToJob(operator, equipment, p.requirements, asOf).matched
  );
}

/* ===================== resource conflict detection ===================== */

export type Booking = {
  resourceId: string;
  jobCode: string;
  startsAt: Date;
  endsAt: Date;
};

export type BookingConflict = {
  resourceId: string;
  existingJob: string;
  proposedJob: string;
  message: string;
};

/** Half-open intervals: a job ending at 15:30 does not conflict with one starting at 15:30. */
export function detectBookingConflicts(
  proposed: Booking,
  existing: Booking[]
): BookingConflict[] {
  return existing
    .filter(
      b =>
        b.resourceId === proposed.resourceId &&
        b.jobCode !== proposed.jobCode &&
        proposed.startsAt < b.endsAt &&
        b.startsAt < proposed.endsAt
    )
    .map(b => ({
      resourceId: proposed.resourceId,
      existingJob: b.jobCode,
      proposedJob: proposed.jobCode,
      message: `${proposed.resourceId} is assigned to ${b.jobCode} until ${b.endsAt.toISOString().slice(11, 16)} and is also proposed for ${proposed.jobCode} at ${proposed.startsAt.toISOString().slice(11, 16)}`,
    }));
}
