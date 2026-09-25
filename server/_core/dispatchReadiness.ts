/**
 * Dispatch readiness gate.
 *
 * The server-side decision on whether a job may actually be assigned. This is
 * the counterpart to dispatchMatching.ts and the two are deliberately
 * incompatible: a MatchResult carries a score, an eligibility verdict does
 * not. There is no arithmetic that converts one into the other.
 *
 *     MATCH              — looks suitable, may see and bid on the posting
 *     BID / INTEREST     — willing to take it
 *     DISPATCH ELIGIBLE  — safety, regulatory and readiness gate permits it
 *
 * Two properties the spec implies and this module enforces mechanically:
 *
 *   Emergency does not bypass safety. `priority` is not an input to this
 *   function at all. It cannot be — there is no parameter to pass it in.
 *
 *   Some blockers cannot be overridden by anyone. An expired licence is not
 *   a judgement call a manager gets to make.
 */

import { readExpiry } from "./documentValidity";
import { APPROVED_OVERRIDE_POLICIES, asFinding, resolveOverridePolicy, type OverrideClass, type OverridePolicy } from "./complianceFinding";

export type EligibilityVerdict =
  | "eligible"
  | "eligible_review"
  | "blocked"
  | "unknown";

export type BlockerSeverity = "blocking" | "review" | "unknown";

export type DispatchBlocker = {
  code: string;
  label: string;
  severity: BlockerSeverity;
  subject: "operator" | "truck" | "trailer" | "job" | "route";
  /**
   * False for safety and legal blockers. No role — including administrator —
   * may override these; the underlying condition has to be fixed.
   */
  overridable: boolean;
  /** Minimum role that may override, when overridable at all. */
  overrideAuthority?: "dispatcher" | "manager" | "administrator";
};

export type DispatchEligibility = {
  verdict: EligibilityVerdict;
  blockers: DispatchBlocker[];
  /** Eligibility is a point-in-time judgement and must be re-checked at award. */
  evaluatedAt: Date;
  explanation: string;
};

export type CredentialState = {
  label: string;
  /** null = we hold no record, which is `unknown`, never `satisfied`. */
  expiresAt: Date | null | undefined;
  present: boolean;
};

export type ReadinessInput = {
  evaluatedAt: Date;
  operator: {
    operatorId: number;
    name: string;
    licence: CredentialState;
    requiredCredentials: CredentialState[];
    hoursAvailableMinutes: number | null;
    /**
     * P8.3 — a person's statement about this driver's hours for this duty day, when the company
     * runs paper logs and there is no live figure. Deliberately a SEPARATE field: a stated number
     * copied into `hoursAvailableMinutes` would be indistinguishable from an ELD reading, and the
     * difference between "the system computed this" and "a named person said it" is exactly what
     * an audit turns on.
     */
    hoursAttestation?: {
      attestedByUserId: number;
      attestedAt: Date;
      dutyDate: string;
      method: "paper_log_reviewed" | "driver_declaration";
      statement: string;
      /** Their figure, if they gave one. Read for the label; never treated as computed. */
      minutesStated: number | null;
    } | null;
    projectedJobMinutes: number | null;
    availabilityDeclared: boolean;
  };
  truck: {
    unitNumber: string;
    inspection: CredentialState;
    registration: CredentialState;
    insurance: CredentialState;
    maintenanceOverdue: boolean;
    criticalDefectOpen: boolean;
    mechanicReleaseRequired: boolean;
    mechanicReleaseGiven: boolean;
  };
  trailer?: {
    trailerNumber: string;
    inspection: CredentialState;
    registration: CredentialState;
    insurance: CredentialState;
    maintenanceOverdue: boolean;
    compatibleWithTruck: boolean | null;
  } | null;
  job: {
    classificationComplete: boolean;
    dangerousGoods: boolean;
    tdgDocumentPrepared: boolean | null;
    requiredDocumentsPresent: boolean;
    permitRequired: boolean;
    permitOnFile: boolean | null;
    destinationAcceptanceVerified: boolean | null;
    /** The loads' latest facility assessments (loadFacilityAssessments), when some exist: the blocker names the facility and the reasons. */
    destinationAssessments?: { loadNumber: string; facilityKey: string; facilityName: string; outcome: string; blocking: boolean; reasonCodes: string[]; assessedAt: Date }[];
    emergencyPlanOnFile: boolean | null;
  };
  route: {
    /** From B12. `unknown` here must not become eligible. */
    dispatchStatus: "clear" | "warning" | "review" | "blocked" | null;
    dataTrustworthy: boolean | null;
  };
};

/** Expired or missing credential → blocking. No record at all → unknown. */
export function credentialBlocker(
  c: CredentialState,
  asOf: Date,
  subject: DispatchBlocker["subject"],
  codePrefix: string
): DispatchBlocker | null {
  if (!c.present) {
    return {
      code: `${codePrefix}_missing`,
      label: `${c.label} not on file`,
      severity: "blocking",
      subject,
      overridable: false,
    };
  }
  if (c.expiresAt === null || c.expiresAt === undefined) {
    return {
      code: `${codePrefix}_unknown`,
      label: `${c.label} expiry unknown`,
      severity: "unknown",
      subject,
      overridable: true,
      overrideAuthority: "manager",
    };
  }
  // C1b-3: the canonical expiry decision (expired once the instant has passed).
  if (readExpiry(c.expiresAt, asOf, 0).expiry === "expired") {
    return {
      code: `${codePrefix}_expired`,
      label: `${c.label} expired ${c.expiresAt.toISOString().slice(0, 10)}`,
      severity: "blocking",
      subject,
      overridable: false,
    };
  }
  return null;
}

export function evaluateDispatchReadiness(
  input: ReadinessInput
): DispatchEligibility {
  const asOf = input.evaluatedAt;
  const blockers: DispatchBlocker[] = [];
  const push = (b: DispatchBlocker | null) => {
    if (b) blockers.push(b);
  };

  // ---------------- operator ----------------
  push(
    credentialBlocker(
      input.operator.licence,
      asOf,
      "operator",
      "operator_licence"
    )
  );
  for (const c of input.operator.requiredCredentials) {
    push(
      credentialBlocker(
        c,
        asOf,
        "operator",
        `operator_${c.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
      )
    );
  }

  if (input.operator.hoursAvailableMinutes === null) {
    const att = input.operator.hoursAttestation ?? null;
    if (att) {
      /*
       * P8.3 — the paper-log path. A named person reviewed the book for this duty day and said so,
       * which is the compliance position for a carrier running paper: after-the-fact proof rather
       * than a live number. It is `review`, not clear: the check was satisfied by a person's word,
       * and the record says whose word and when so that remains visible rather than becoming
       * indistinguishable from a computed figure two screens later.
       */
      blockers.push({
        code: "hos_attested",
        label: `Hours attested by user ${att.attestedByUserId} for ${att.dutyDate} (${att.method === "paper_log_reviewed" ? "paper log reviewed" : "driver declaration"})${att.minutesStated != null ? `, stated ${att.minutesStated} min` : ""} — stated, not computed`,
        severity: "review",
        subject: "operator",
        overridable: true,
        overrideAuthority: "dispatcher",
      });
    } else {
      blockers.push({
        code: "hos_unknown",
        label: "Operator hours-of-service state unknown",
        severity: "unknown",
        subject: "operator",
        overridable: true,
        overrideAuthority: "manager",
      });
    }
  } else if (
    input.operator.projectedJobMinutes !== null &&
    input.operator.projectedJobMinutes > input.operator.hoursAvailableMinutes
  ) {
    blockers.push({
      code: "hos_insufficient",
      label: `Projected ${input.operator.projectedJobMinutes} min exceeds ${input.operator.hoursAvailableMinutes} min available`,
      severity: "blocking",
      subject: "operator",
      overridable: false,
    });
  }

  if (!input.operator.availabilityDeclared) {
    blockers.push({
      code: "availability_not_declared",
      label: "Operator has not declared availability",
      severity: "review",
      subject: "operator",
      overridable: true,
      overrideAuthority: "dispatcher",
    });
  }

  // ---------------- truck ----------------
  push(
    credentialBlocker(input.truck.inspection, asOf, "truck", "truck_inspection")
  );
  push(
    credentialBlocker(
      input.truck.registration,
      asOf,
      "truck",
      "truck_registration"
    )
  );
  push(
    credentialBlocker(input.truck.insurance, asOf, "truck", "truck_insurance")
  );

  if (input.truck.criticalDefectOpen) {
    blockers.push({
      code: "critical_defect",
      label: `${input.truck.unitNumber} has an open critical defect`,
      severity: "blocking",
      subject: "truck",
      overridable: false,
    });
  }
  if (
    input.truck.mechanicReleaseRequired &&
    !input.truck.mechanicReleaseGiven
  ) {
    blockers.push({
      code: "mechanic_release_missing",
      label: `${input.truck.unitNumber} awaiting mechanic release`,
      severity: "blocking",
      subject: "truck",
      overridable: false,
    });
  }
  if (input.truck.maintenanceOverdue) {
    blockers.push({
      code: "maintenance_overdue",
      label: `${input.truck.unitNumber} maintenance overdue`,
      severity: "review",
      subject: "truck",
      overridable: true,
      overrideAuthority: "manager",
    });
  }

  // ---------------- trailer ----------------
  if (input.trailer) {
    push(
      credentialBlocker(
        input.trailer.inspection,
        asOf,
        "trailer",
        "trailer_inspection"
      )
    );
    push(
      credentialBlocker(
        input.trailer.registration,
        asOf,
        "trailer",
        "trailer_registration"
      )
    );
    push(
      credentialBlocker(
        input.trailer.insurance,
        asOf,
        "trailer",
        "trailer_insurance"
      )
    );
    if (input.trailer.maintenanceOverdue) {
      blockers.push({
        code: "trailer_maintenance_overdue",
        label: `${input.trailer.trailerNumber} maintenance overdue`,
        severity: "review",
        subject: "trailer",
        overridable: true,
        overrideAuthority: "manager",
      });
    }
    if (input.trailer.compatibleWithTruck === false) {
      blockers.push({
        code: "trailer_incompatible",
        label: `${input.trailer.trailerNumber} not compatible with ${input.truck.unitNumber}`,
        severity: "blocking",
        subject: "trailer",
        overridable: false,
      });
    } else if (input.trailer.compatibleWithTruck === null) {
      blockers.push({
        code: "trailer_compatibility_unknown",
        label: "Truck/trailer compatibility not established",
        severity: "unknown",
        subject: "trailer",
        overridable: true,
        overrideAuthority: "manager",
      });
    }
  }

  // ---------------- job ----------------
  if (!input.job.classificationComplete) {
    blockers.push({
      code: "classification_incomplete",
      label: "Job classification incomplete",
      severity: "blocking",
      subject: "job",
      overridable: false,
    });
  }
  if (input.job.dangerousGoods) {
    if (input.job.tdgDocumentPrepared === false) {
      blockers.push({
        code: "tdg_document_missing",
        label: "Dangerous goods shipping document not prepared",
        severity: "blocking",
        subject: "job",
        overridable: false,
      });
    } else if (input.job.tdgDocumentPrepared === null) {
      blockers.push({
        code: "tdg_document_unknown",
        label: "Dangerous goods documentation state unknown",
        severity: "unknown",
        subject: "job",
        overridable: false,
      });
    }
  }
  if (!input.job.requiredDocumentsPresent) {
    blockers.push({
      code: "documents_missing",
      label: "Required job documents not all present",
      severity: "review",
      subject: "job",
      overridable: true,
      overrideAuthority: "manager",
    });
  }
  if (input.job.permitRequired) {
    if (input.job.permitOnFile === false) {
      blockers.push({
        code: "permit_missing",
        label: "Required permit not on file",
        severity: "blocking",
        subject: "job",
        overridable: false,
      });
    } else if (input.job.permitOnFile === null) {
      blockers.push({
        code: "permit_unknown",
        label: "Permit status unknown",
        severity: "unknown",
        subject: "job",
        overridable: false,
      });
    }
  }
  const blockingAssessments = (input.job.destinationAssessments ?? []).filter(a => a.blocking);
  if (input.job.destinationAcceptanceVerified === false) {
    // One blocker per blocking load, naming the facility and the engine's reasons; the generic line only when no assessment carried the detail.
    if (blockingAssessments.length) {
      for (const a of blockingAssessments) blockers.push({
        code: "destination_not_accepting",
        label: `Load ${a.loadNumber} → ${a.facilityName}: ${a.outcome.replaceAll("_", " ")} (${a.reasonCodes.join(", ")})`,
        severity: "blocking",
        subject: "job",
        overridable: false,
      });
    } else {
      blockers.push({ code: "destination_not_accepting", label: "Destination facility will not accept this material", severity: "blocking", subject: "job", overridable: false });
    }
  } else if (input.job.destinationAcceptanceVerified === null) {
    blockers.push({
      code: "destination_acceptance_unverified",
      label: "Destination facility acceptance not verified — no non-blocking facility assessment on the job's loads",
      severity: "review",
      subject: "job",
      overridable: true,
      overrideAuthority: "manager",
    });
  }
  if (input.job.emergencyPlanOnFile === false && input.job.dangerousGoods) {
    blockers.push({
      code: "erp_missing",
      label: "Emergency response plan required for this material",
      severity: "blocking",
      subject: "job",
      overridable: false,
    });
  }

  // ---------------- route (from B12) ----------------
  if (input.route.dispatchStatus === "blocked") {
    blockers.push({
      code: "route_blocked",
      label: "Route evaluation returned blocked",
      severity: "blocking",
      subject: "route",
      overridable: false,
    });
  } else if (input.route.dispatchStatus === null) {
    blockers.push({
      code: "route_not_evaluated",
      label: "Route not evaluated",
      severity: "unknown",
      subject: "route",
      overridable: true,
      overrideAuthority: "manager",
    });
  } else if (
    input.route.dispatchStatus === "warning" ||
    input.route.dispatchStatus === "review"
  ) {
    blockers.push({
      code: "route_review",
      label: `Route evaluation returned ${input.route.dispatchStatus}`,
      severity: "review",
      subject: "route",
      overridable: true,
      overrideAuthority: "manager",
    });
  }
  if (input.route.dataTrustworthy === false) {
    blockers.push({
      code: "route_data_unverified",
      label: "Routing data for this jurisdiction is not authority-confirmed",
      severity: "review",
      subject: "route",
      overridable: true,
      overrideAuthority: "manager",
    });
  }

  const verdict = deriveVerdict(blockers);
  return {
    verdict,
    blockers,
    evaluatedAt: asOf,
    explanation: explainEligibility(verdict, blockers),
  };
}

function deriveVerdict(blockers: DispatchBlocker[]): EligibilityVerdict {
  if (blockers.some(b => b.severity === "blocking")) return "blocked";
  // Unknown outranks review: an unevaluated condition is not a known-minor one.
  if (blockers.some(b => b.severity === "unknown")) return "unknown";
  if (blockers.some(b => b.severity === "review")) return "eligible_review";
  return "eligible";
}

function explainEligibility(
  verdict: EligibilityVerdict,
  blockers: DispatchBlocker[]
): string {
  if (verdict === "eligible") return "All dispatch readiness checks passed.";
  const named = blockers
    .filter(b => b.severity !== "review" || verdict === "eligible_review")
    .map(b => `${b.severity.toUpperCase()} — ${b.label}`);
  return named.join(". ") + ".";
}

/* ========================= override discipline ========================= */

export type OverrideRequest = {
  blockerCode: string;
  requestedByUserId: number;
  requestedByRole:
    | "driver"
    | "dispatcher"
    | "mechanic"
    | "office"
    | "manager"
    | "administrator";
  reason: string;
  /**
   * C1a — for an APPROVED_POLICY_ONLY finding, the owner-approved policy the grantor relies on.
   * Without one such a finding is released by nobody: there is no general manager override.
   */
  policyRef?: string | null;
};

export type OverrideOutcome =
  | { granted: true; blockerCode: string; reason: string; overrideClass: OverrideClass; policy: OverridePolicy | null }
  | { granted: false; blockerCode: string; refusal: string };

const ROLE_RANK: Record<OverrideRequest["requestedByRole"], number> = {
  driver: 0,
  dispatcher: 1,
  mechanic: 1,
  office: 1,
  manager: 2,
  administrator: 3,
};
const AUTHORITY_RANK = { dispatcher: 1, manager: 2, administrator: 3 } as const;

/**
 * Attempted overrides are recorded whether or not they succeed — a refused
 * attempt to dispatch a unit with an open critical defect is exactly the sort
 * of thing an auditor wants to see.
 *
 * C1a — decided by the finding's override CLASS, never by a bare boolean:
 *   NEVER_OVERRIDABLE     refused for every role
 *   APPROVED_POLICY_ONLY  only under a named, in-force, owner-approved policy covering this code,
 *                         and only by a role that policy names
 *   WARNING_ONLY          an acknowledgement by the producer's stated authority or above
 *   INFORMATIONAL         nothing to override
 */
export function requestOverride(
  blocker: DispatchBlocker,
  request: OverrideRequest,
  at: Date = new Date(),
  policies: readonly OverridePolicy[] = APPROVED_OVERRIDE_POLICIES,
): OverrideOutcome {
  const finding = asFinding(blocker, at);
  if (finding.overrideClass === "NEVER_OVERRIDABLE") {
    return {
      granted: false,
      blockerCode: blocker.code,
      refusal: `${blocker.label} cannot be overridden by any role. The underlying condition must be resolved.`,
    };
  }
  if (finding.overrideClass === "INFORMATIONAL") {
    return { granted: false, blockerCode: blocker.code, refusal: `${blocker.label} is informational; there is nothing to override.` };
  }
  if (!request.reason?.trim()) {
    return {
      granted: false,
      blockerCode: blocker.code,
      refusal: "An override requires a stated reason.",
    };
  }
  if (finding.overrideClass === "APPROVED_POLICY_ONLY") {
    const resolved = resolveOverridePolicy(request.policyRef, finding, at, policies);
    if (!resolved.ok) return { granted: false, blockerCode: blocker.code, refusal: resolved.refusal };
    if (ROLE_RANK[request.requestedByRole] < AUTHORITY_RANK[resolved.policy.grantorMinimumRole]) {
      return { granted: false, blockerCode: blocker.code, refusal: `${request.requestedByRole} may not act under ${resolved.policy.policyRef}; ${resolved.policy.grantorMinimumRole} or above is required.` };
    }
    return { granted: true, blockerCode: blocker.code, reason: request.reason, overrideClass: finding.overrideClass, policy: resolved.policy };
  }
  const required = finding.overrideAuthority ?? "manager";
  if (ROLE_RANK[request.requestedByRole] < AUTHORITY_RANK[required]) {
    return {
      granted: false,
      blockerCode: blocker.code,
      refusal: `${request.requestedByRole} may not override this; ${required} or above is required.`,
    };
  }
  return { granted: true, blockerCode: blocker.code, reason: request.reason, overrideClass: finding.overrideClass, policy: null };
}

/* ===================== freshness at award ===================== */

/**
 * A bid submitted three hours ago was gated against conditions that may since
 * have changed — a licence can expire at midnight between bid and award. The
 * gate must be re-run at assignment, not trusted from bid time.
 */
export function requiresReEvaluation(
  eligibility: DispatchEligibility,
  now: Date,
  maxAgeMinutes = 30
): { stale: boolean; ageMinutes: number; message: string } {
  const ageMinutes = Math.floor(
    (now.getTime() - eligibility.evaluatedAt.getTime()) / 60_000
  );
  const stale = ageMinutes > maxAgeMinutes;
  return {
    stale,
    ageMinutes,
    message: stale
      ? `Readiness was evaluated ${ageMinutes} min ago — re-run the gate before awarding.`
      : `Readiness evaluated ${ageMinutes} min ago.`,
  };
}
