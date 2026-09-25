/**
 * Mechanic release — the gate between "the shop is finished" and "the unit can
 * be dispatched".
 *
 * `dispatchReadiness` already consumes `mechanicReleaseGiven`, but nothing in
 * the system could legitimately set it: work orders had a `closed` status and
 * no release record at all. Closing a work order is an administrative act. A
 * release is a named, authenticated technician stating that a specific defect
 * is corrected and the unit is fit for service. Those are different events and
 * conflating them is how an unrepaired truck gets dispatched (invariant #15).
 *
 * The driver's original words are never replaced by the mechanic's diagnosis.
 * "Pump started grinding when PTO engaged" and "worn pump coupling" are both
 * kept — one is an observation, the other is a finding.
 */

export type DefectSeverity = "advisory" | "inspection_required" | "critical";
export type ReleaseType = "full" | "restricted" | "revoked";
export type TestResult = "pass" | "fail" | "not_required";

export type ReleaseAttempt = {
  workOrderStatus:
    | "draft"
    | "open"
    | "in_progress"
    | "waiting_parts"
    | "ready_for_service"
    | "closed"
    // 0198 — a cancelled work order produced no repair and cannot produce a release.
    | "cancelled";
  defectSeverity: DefectSeverity;
  releaseType: ReleaseType;
  repairSummary?: string | null;
  testProcedure?: string | null;
  testResult?: TestResult | null;
  roadTestPerformed?: boolean;
  technicianUserId?: number | null;
  technicianIdentifier?: string | null;
  restrictionDetail?: string | null;
};

export type ReleaseBlocker = { code: string; label: string };

export type ReleaseDecision = {
  valid: boolean;
  blockers: ReleaseBlocker[];
  /** What dispatch should be told. Never inferred from work order status. */
  mechanicReleaseGiven: boolean;
  unitDispatchable: boolean;
  restricted: boolean;
};

/**
 * Validate a proposed release. Critical defects carry the full evidence
 * requirement; an advisory defect does not need a road test to be signed off.
 * Requirements scale with severity so the screen does not train shop staff to
 * click through checks that never applied.
 */
export function evaluateMechanicRelease(a: ReleaseAttempt): ReleaseDecision {
  const blockers: ReleaseBlocker[] = [];

  if (a.releaseType === "revoked") {
    return {
      valid: true,
      blockers: [],
      mechanicReleaseGiven: false,
      unitDispatchable: false,
      restricted: false,
    };
  }

  if (!a.technicianUserId) {
    blockers.push({
      code: "technician_not_authenticated",
      label: "Release requires an authenticated technician, not a typed name",
    });
  }
  if (!a.technicianIdentifier?.trim()) {
    blockers.push({
      code: "technician_identifier_missing",
      label: "Technician identifier is required on the release record",
    });
  }
  if (!a.repairSummary?.trim()) {
    blockers.push({
      code: "repair_summary_missing",
      label: "Corrective action must be recorded",
    });
  }

  if (a.workOrderStatus === "draft" || a.workOrderStatus === "open") {
    blockers.push({
      code: "work_not_started",
      label: `Work order is ${a.workOrderStatus} — no repair has been performed`,
    });
  }
  if (a.workOrderStatus === "cancelled") {
    blockers.push({
      code: "work_order_cancelled",
      label: "Work order was cancelled — no repair was performed under it",
    });
  }
  if (a.workOrderStatus === "waiting_parts") {
    blockers.push({
      code: "waiting_parts",
      label: "Work order is waiting on parts",
    });
  }

  const critical = a.defectSeverity === "critical";
  const inspectionRequired = a.defectSeverity === "inspection_required";

  if (critical || inspectionRequired) {
    if (!a.testProcedure?.trim()) {
      blockers.push({
        code: "test_procedure_missing",
        label: "A test procedure must be recorded for this defect severity",
      });
    }
    if (!a.testResult || a.testResult === "not_required") {
      blockers.push({
        code: "test_result_missing",
        label: "A test result must be recorded for this defect severity",
      });
    }
  }

  if (a.testResult === "fail") {
    blockers.push({
      code: "test_failed",
      label: "Test failed — a failed test cannot produce a release",
    });
  }

  if (critical && !a.roadTestPerformed) {
    blockers.push({
      code: "road_test_missing",
      label: "A critical defect requires a road test before return to service",
    });
  }

  if (a.releaseType === "restricted" && !a.restrictionDetail?.trim()) {
    blockers.push({
      code: "restriction_undefined",
      label: "A restricted release must state the restriction",
    });
  }

  const valid = blockers.length === 0;
  const restricted = valid && a.releaseType === "restricted";

  return {
    valid,
    blockers,
    mechanicReleaseGiven: valid,
    // A restricted release returns the unit to service under stated limits.
    // It is a release, but the restriction travels with it to dispatch.
    unitDispatchable: valid,
    restricted,
  };
}

/* ------------------------------------------------------------------ */
/* Release evidence, read back                                         */
/* ------------------------------------------------------------------ */

/**
 * A stored release, as a reader sees it.
 *
 * `evaluateMechanicRelease` guards the moment a release is *written*. This half guards every later
 * read of one, and it exists because the two were not the same guard: `records.maintenance
 * .revokeRelease` appends a `revoked` row without consulting the evaluator at all, and readiness
 * matched releases to defects by comparing timestamps — so revoking a release made a unit look
 * released, and a release for one defect answered for every other defect on the truck.
 *
 * A release is evidence about *named* defects. Chronology is not identity.
 */
export type StoredRelease = {
  id: number;
  workOrderId: number;
  releaseType: ReleaseType;
  testResult: TestResult | null;
  /** JSON array of defect ids, as `shop.workOrderRelease` writes it. */
  resolvedDefectIds: string | null;
  releasedAt: Date;
};

/**
 * The defect ids a release names.
 *
 * Unparseable or non-array content names *nothing*. A release whose linkage cannot be read is not
 * evidence for a defect it cannot identify, and guessing here would restore the failure by a
 * different route.
 */
export function defectIdsNamedBy(release: Pick<StoredRelease, "resolvedDefectIds">): number[] {
  if (!release.resolvedDefectIds) return [];
  try {
    const parsed: unknown = JSON.parse(release.resolvedDefectIds);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Whether a release is positive evidence on its own face.
 *
 * A revocation is the record of a release being withdrawn; a failed test is the record of a repair
 * that did not work. Both are releases in the table and neither is a release in the ordinary sense,
 * which is exactly the confusion that let a revocation read as an approval.
 */
export function releaseIsPositiveEvidence(r: Pick<StoredRelease, "releaseType" | "testResult">): boolean {
  return r.releaseType !== "revoked" && r.testResult !== "fail";
}

/** A later revocation on the same work order withdraws an earlier release on it. */
function supersededByRevocation(r: StoredRelease, all: readonly StoredRelease[]): boolean {
  return all.some(x =>
    x.releaseType === "revoked" &&
    x.workOrderId === r.workOrderId &&
    (x.releasedAt.getTime() > r.releasedAt.getTime() ||
      (x.releasedAt.getTime() === r.releasedAt.getTime() && x.id > r.id)));
}

/**
 * The release that currently stands as evidence for one specific defect, or null.
 *
 * Four things must hold, and each one of them was a separate confirmed defect when it did not:
 * the release names this defect; it is not a revocation; its test did not fail; and it has not been
 * withdrawn by a later revocation on its own work order.
 */
export function currentReleaseEvidenceFor(
  defectId: number,
  releases: readonly StoredRelease[]
): StoredRelease | null {
  const candidates = releases
    .filter(r => releaseIsPositiveEvidence(r))
    .filter(r => defectIdsNamedBy(r).includes(defectId))
    .filter(r => !supersededByRevocation(r, releases))
    .sort((a, b) => b.releasedAt.getTime() - a.releasedAt.getTime() || b.id - a.id);
  return candidates[0] ?? null;
}

export type MaintenanceStage =
  | "driver_reported"
  | "management_review"
  | "sent_to_shop"
  | "work_in_progress"
  | "repair_complete"
  | "released"
  | "office_archived";

const STAGE_ORDER: MaintenanceStage[] = [
  "driver_reported",
  "management_review",
  "sent_to_shop",
  "work_in_progress",
  "repair_complete",
  "released",
  "office_archived",
];

/**
 * The chain from a driver's defect report to the office archive. Stages advance
 * one step at a time — a defect cannot jump from "driver reported" to
 * "released" without passing through review and the shop.
 */
export function nextMaintenanceStage(
  current: MaintenanceStage
): MaintenanceStage | null {
  const i = STAGE_ORDER.indexOf(current);
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1] : null;
}

export function canAdvanceTo(
  from: MaintenanceStage,
  to: MaintenanceStage
): boolean {
  return nextMaintenanceStage(from) === to;
}

/**
 * Whether closing the work order alone is enough to return the unit to service.
 * For anything above advisory it is not, and this is the assertion that keeps
 * `closed` from silently meaning `released`.
 */
export function closureImpliesRelease(severity: DefectSeverity): boolean {
  return severity === "advisory";
}

export type UnitServiceState = {
  status: "available" | "held" | "restricted";
  reason?: string;
  dispatchRecalculationRequired: boolean;
};

/**
 * Recompute unit availability from the release position. Any change here must
 * trigger a dispatch re-evaluation — a unit that becomes unavailable after
 * assignment is exactly the case that must not be missed.
 */
export function unitServiceStateAfterRelease(args: {
  openCriticalDefect: boolean;
  release: ReleaseDecision | null;
  previousStatus: UnitServiceState["status"];
}): UnitServiceState {
  if (args.openCriticalDefect && !args.release?.mechanicReleaseGiven) {
    return {
      status: "held",
      reason: "Open critical defect without mechanic release",
      dispatchRecalculationRequired: args.previousStatus !== "held",
    };
  }
  if (args.release?.restricted) {
    return {
      status: "restricted",
      reason: "Released under stated restriction",
      dispatchRecalculationRequired: args.previousStatus !== "restricted",
    };
  }
  if (args.release?.mechanicReleaseGiven) {
    return {
      status: "available",
      reason: "Mechanic release recorded",
      dispatchRecalculationRequired: args.previousStatus !== "available",
    };
  }
  return {
    status: args.previousStatus,
    dispatchRecalculationRequired: false,
  };
}
