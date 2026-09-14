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
