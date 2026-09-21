/**
 * Domain emitters.
 *
 * The gap this closes: B17.1 built and proved the emitter, the rules and the
 * worker, but nothing in the actual operational flows called any of it. An
 * event bus with no publishers is scaffolding.
 *
 * Each function here is called by a domain service INSIDE its existing
 * transaction, so the operational write and its event commit together. None of
 * them decides anything — they report what the domain already decided.
 */

import {
  emitDomainEvent,
  guardCausationDepth,
  isMeaningfulChange,
  type EmitActor,
  type OutboxRow,
  type TxLike,
} from "./eventEmitter";

export type EmitContext = {
  tenantId: string;
  branchId?: string | null;
  actor: EmitActor;
  correlationId?: string | null;
  causationId?: string | null;
  /** How far down a causal chain we already are. Guards runaway cascades. */
  causationDepth?: number;
  now?: Date;
};

/** Emitted only when the depth guard permits; returns null when it does not. */
async function emitGuarded(
  tx: TxLike,
  ctx: EmitContext,
  input: Parameters<typeof emitDomainEvent>[1]
): Promise<OutboxRow | null> {
  const guard = guardCausationDepth(ctx.causationDepth ?? 0);
  if (!guard.allowed) return null;
  return emitDomainEvent(tx, input, ctx.now ?? new Date());
}

/* ===================== A. critical defect ===================== */

export type CriticalDefectOpened = {
  unitId: string;
  defectId: string;
  severity: "advisory" | "inspection_required" | "critical";
  reportedObservation: string;
  affectedAssignments: string[];
};

/**
 * The maintenance domain has already classified severity. This reports it —
 * it does not decide whether the unit is safe.
 */
export async function emitCriticalDefectOpened(
  tx: TxLike,
  ctx: EmitContext,
  payload: CriticalDefectOpened
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "unit.critical_defect_opened",
    actor: ctx.actor,
    subject: { entityType: "unit", entityId: payload.unitId },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    unitId: payload.unitId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

export async function emitMechanicReleased(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    unitId: string;
    workOrderRef: string;
    releasedBy: string;
    releaseVerified: boolean;
    /**
     * Added in B20. Optional so existing callers are unaffected. A restricted
     * release returns the unit to service under stated limits — dispatch needs
     * the limit, not just the fact that something was signed.
     */
    releaseType?: "full" | "restricted" | "revoked";
    restricted?: boolean;
    restrictionDetail?: string | null;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "unit.mechanic_released",
    actor: ctx.actor,
    subject: { entityType: "unit", entityId: payload.unitId },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    unitId: payload.unitId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/* ===================== B. disposal reconciliation ===================== */

export type DisposalTicketMissing = {
  loadId: string;
  tripId: string;
  jobId: string;
  facilityId: string;
  facilityIssuesTicket: boolean;
  missingChecks: string[];
};

/**
 * Emitted by disposal reconciliation when a required ticket is absent. The
 * `facilityIssuesTicket` flag matters: a facility that issues none must not
 * generate a task demanding one.
 */
export async function emitDisposalTicketMissing(
  tx: TxLike,
  ctx: EmitContext,
  payload: DisposalTicketMissing
): Promise<OutboxRow | null> {
  if (!payload.facilityIssuesTicket) return null;
  return emitGuarded(tx, ctx, {
    type: "disposal.ticket_missing",
    actor: ctx.actor,
    subject: { entityType: "load", entityId: payload.loadId },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    jobId: payload.jobId,
    tripId: payload.tripId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

export async function emitDisposalTicketVerified(
  tx: TxLike,
  ctx: EmitContext,
  payload: { loadId: string; ticketNumber: string; verifiedBy: string }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "disposal.ticket_verified",
    actor: ctx.actor,
    subject: { entityType: "load", entityId: payload.loadId },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/* ===================== C. credentials ===================== */

export async function emitCredentialExpiring(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    operatorId: string;
    credentialCode: string;
    label: string;
    daysRemaining: number;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "operator.credential_expiring",
    actor: ctx.actor,
    subject: { entityType: "operator", entityId: payload.operatorId },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/* ===================== D. dispatch invalidation ===================== */

export type AssignmentAtRisk = {
  assignmentId: string;
  postingId: string;
  operatorId: string;
  unitId: string | null;
  invalidationCause: string;
  previousVerdict: string;
  nextVerdict: string;
};

/**
 * Only emitted when the verdict actually moved. A re-evaluation that produced
 * the same answer must emit nothing, or the assignment/re-evaluate loop feeds
 * itself forever.
 */
export async function emitAssignmentAtRisk(
  tx: TxLike,
  ctx: EmitContext,
  payload: AssignmentAtRisk
): Promise<OutboxRow | null> {
  const changed = isMeaningfulChange(
    {
      previous: { verdict: payload.previousVerdict },
      next: { verdict: payload.nextVerdict },
    },
    ["verdict"]
  );
  if (!changed) return null;

  return emitGuarded(tx, ctx, {
    type: "dispatch.assignment_at_risk",
    actor: ctx.actor,
    subject: { entityType: "assignment", entityId: payload.assignmentId },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    unitId: payload.unitId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/* ===================== E. billing disputes and callouts (B18) ===================== */

export async function emitInvoiceDisputed(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    caseNumber: string;
    invoiceNumber: string;
    customer: string;
    disputedAmountCents: number;
    reasonStated: string;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "billing.invoice_disputed",
    actor: ctx.actor,
    subject: { entityType: "invoice", entityId: payload.invoiceNumber },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/**
 * A callout accepted on unverified authority. Emitting this is what turns the
 * 2am revenue leak into a task somebody owns before the invoice run.
 */
export async function emitCalloutAuthorityUnverified(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    calloutRef: string;
    callerName: string | null;
    callerCompany: string | null;
    claimedAuthority: string;
    billToParty: string | null;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "billing.callout_authority_unverified",
    actor: ctx.actor,
    subject: { entityType: "callout", entityId: payload.calloutRef },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/**
 * Reducing what a subcontractor is owed. Emitted so the notice becomes a
 * tracked obligation rather than an intention.
 */
export async function emitSubcontractorShortPayProposed(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    subcontractorId: string;
    payableAdjustmentNumber: string;
    amountCents: number;
    attribution: string;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "payable.short_pay_proposed",
    actor: ctx.actor,
    subject: { entityType: "subcontractor", entityId: payload.subcontractorId },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/* ===================== E. B20 records, safety & release ===================== */

/**
 * An incident the operator has sealed in the field.
 *
 * Emitted after sealing, never at capture: an unsealed draft is something the
 * operator is still writing, and raising a management task off a half-typed
 * statement trains people to stop typing. `severity` and `holdUnit` are already
 * decided by the safety domain — this reports them and does not re-derive them.
 */
export type IncidentSealed = {
  incidentNumber: string;
  incidentType: string;
  severity: "none" | "minor" | "moderate" | "serious" | "critical";
  unitId?: string | null;
  jobId?: string | null;
  employeeNumber?: string | null;
  injuryReported: boolean;
  environmentalRelease: boolean;
  dangerousGoodsInvolved: boolean;
  holdUnit: boolean;
  legalHoldRecommended: boolean;
  /** The operator's own words, carried so the task can quote them verbatim. */
  reportedStatement: string;
};

export async function emitIncidentSealed(
  tx: TxLike,
  ctx: EmitContext,
  payload: IncidentSealed
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "safety.incident_sealed",
    actor: ctx.actor,
    subject: { entityType: "incident", entityId: payload.incidentNumber },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    unitId: payload.unitId ?? undefined,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/**
 * A near miss that reported an injury and therefore is not a near miss.
 * The original statement travels with it; the operator retypes nothing.
 */
export async function emitNearMissEscalated(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    nearMissNumber: string;
    incidentNumber: string;
    reportedStatement: string;
    unitId?: string | null;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "safety.near_miss_escalated",
    actor: ctx.actor,
    subject: { entityType: "nearMiss", entityId: payload.nearMissNumber },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    unitId: payload.unitId ?? undefined,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/**
 * A sealed record arrived and the server could not reproduce its hash.
 *
 * This is the one sync state that is a real exception. The device copy stays
 * put, so the task exists to get the record re-sent — not to chase the driver.
 */
export async function emitEvidenceIntegrityFailed(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    trackingNumber: string;
    packageRef: string;
    deviceId: string;
    failureMode: "hash_mismatch" | "manifest_mismatch";
    employeeNumber?: string | null;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "records.evidence_integrity_failed",
    actor: ctx.actor,
    subject: { entityType: "evidenceRecord", entityId: payload.trackingNumber },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/**
 * A legal hold was placed. Emitted so retention suspension becomes a tracked
 * obligation with a review task rather than a flag nobody revisits.
 */
export async function emitLegalHoldPlaced(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    holdNumber: string;
    reason: string;
    incidentNumber?: string | null;
    recordCount: number;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "records.legal_hold_placed",
    actor: ctx.actor,
    subject: { entityType: "legalHold", entityId: payload.holdNumber },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}

/**
 * A driver defect report that management has reviewed and sent to the shop.
 * The driver's original observation is carried verbatim — the shop reads what
 * the operator actually said, not a paraphrase of it.
 */
export async function emitDefectSentToShop(
  tx: TxLike,
  ctx: EmitContext,
  payload: {
    unitId: string;
    defectId: string;
    workOrderRef: string;
    severity: "advisory" | "inspection_required" | "critical";
    reportedObservation: string;
    reviewedByUserId: number;
  }
): Promise<OutboxRow | null> {
  return emitGuarded(tx, ctx, {
    type: "fleet.defect_sent_to_shop",
    actor: ctx.actor,
    subject: { entityType: "unit", entityId: payload.unitId },
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    unitId: payload.unitId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload,
  });
}
