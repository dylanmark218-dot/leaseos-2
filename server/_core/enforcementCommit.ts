/**
 * v22.20 (0082) — committing a confirmed roadside stop, once.
 *
 * The whole point of this being one transaction is that the two failure modes
 * are equally bad: an out-of-service order saved while the office is never told,
 * and an alert sent for a transaction that rolled back. So the event, its
 * violations, the citations, the orders and the domain event that carries the
 * notification all commit together or none of them do — and the notification is
 * *enqueued* in that transaction rather than sent from it, so a push provider
 * being down cannot corrupt a compliance record.
 *
 * Idempotency is not optional here. A driver on a bad connection taps confirm
 * twice, or the client retries a request whose response never arrived; without
 * a key that produces WO-8821, WO-8822 and WO-8823 for one brake chamber. The
 * key is derived from the content, so a retry is recognised as the same act
 * rather than trusted to arrive with the same generated reference.
 *
 * And the rule the engine already establishes survives into the database:
 * `releasable` is a computed opinion about an order. `released` is a row change
 * somebody made. Nothing in this file turns the first into the second.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "./dbTypes";
import { createHash } from "node:crypto";
import {
  enforcementCitations, enforcementDocumentExtractions, enforcementEvents,
  enforcementViolations, maintenanceDefects, oosReleaseFindings, oosReleasePolicies,
  outOfServiceOrders, workOrders,
} from "../../drizzle/schema";
import { consequencesOf, releaseReadiness, type OosOrder, type RepairRecord, type ViolationFacts } from "./enforcement";
import { mayRelease, satisfiesIssuingCondition, selectPolicyForScope, type FindingType, type ScopedPolicy } from "./oosReleasePolicy";

/**
 * How many rows an update actually changed. The driver reports this in more
 * than one shape depending on how the result is wrapped, so read it defensively
 * — and treat "cannot tell" as zero, because claiming a release nobody can
 * confirm is the failure this exists to prevent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function affectedRows(result: any): number {
  if (typeof result?.affectedRows === "number") return result.affectedRows;
  if (Array.isArray(result) && typeof result[0]?.affectedRows === "number") return result[0].affectedRows;
  if (typeof result?.rowsAffected === "number") return result.rowsAffected;
  return 0;
}

/** The insert id, read defensively across the driver's result shapes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertedId(result: any): number | null {
  if (typeof result?.insertId === "number" && result.insertId > 0) return result.insertId;
  if (Array.isArray(result) && typeof result[0]?.insertId === "number" && result[0].insertId > 0) return result[0].insertId;
  return null;
}

/** Stable across retries: derived from what the act is, not when it happened. */
export const idempotencyKey = (parts: readonly (string | number | boolean | null)[]): string =>
  createHash("sha256").update(parts.map(p => String(p)).join("\u0000")).digest("hex").slice(0, 40);

export type ConfirmInput = {
  extractionRef: string | null;
  eventType: string;
  jurisdiction: string;
  agency: string;
  occurredAt: Date;
  locationText?: string | null;
  inspectionReportNumber?: string | null;
  inspectionLevel?: string | null;
  inspectionResult: "pass" | "requires_attention" | "out_of_service" | "unknown";
  operatorId?: number | null;
  unitId?: number | null;
  trailerId?: number | null;
  jobId?: number | null;
  subjectRefFor: (scope: ViolationFacts["oosScope"]) => string | null;
  violations: readonly (ViolationFacts & { description?: string | null; citationNumber?: string | null; fineAmountCents?: number | null; releaseCondition?: string | null; requiredFindingType?: FindingType | null })[];
  confirmedByUserId: number;
  /** Snapshotted here so a later asset transfer cannot move which policy governs the release. */
  tenantId?: string | null;
  branchId?: string | null;
  terminalId?: string | null;
  /**
   * Enqueued inside this transaction, so an order cannot be saved while the
   * office is never told, and an alert cannot be sent for a transaction that
   * rolled back. The caller supplies the writer because it knows its own tenant
   * context; what matters here is only that it runs on the same `tx`.
   */
  enqueue?: (tx: Tx, event: { eventRef: string; eventType: string; severity: "critical" | "urgent" | "routine"; orderRefs: string[]; repairRequired: number }) => Promise<void>;
};

export type ConfirmResult = {
  eventRef: string;
  created: boolean;
  violationRefs: string[];
  citationRefs: string[];
  orderRefs: string[];
  /** Violations that require a defect and a work order, for the caller to raise through the existing shop path. */
  repairRequired: { violationRef: string; ownCode: string; system: string }[];
  notes: string[];
};

/**
 * Commit a confirmed enforcement event and everything that follows from it.
 *
 * `db` is the drizzle handle; the caller supplies a transaction. Defects and
 * work orders are *named* in the result rather than created here, because those
 * tables already have an owner with its own rules — this returns what must be
 * raised and lets the shop path raise it, rather than growing a second writer.
 */
export async function confirmEnforcementEvent(
  tx: Tx,
  input: ConfirmInput,
): Promise<ConfirmResult> {
  const notes: string[] = [];
  const eventKey = idempotencyKey([
    "enforcement", input.jurisdiction, input.agency, input.occurredAt.toISOString(),
    input.inspectionReportNumber ?? "", input.unitId ?? "", input.operatorId ?? "",
  ]);
  const eventRef = `ENF-${eventKey.slice(0, 16).toUpperCase()}`;

  const existing = await tx.select().from(enforcementEvents).where(eq(enforcementEvents.eventRef, eventRef)).limit(1);
  if (existing.length) {
    // The same stop, confirmed again. Report what is already there rather than
    // writing a second copy of it.
    const violations = await tx.select().from(enforcementViolations).where(eq(enforcementViolations.eventRef, eventRef));
    const citations = await tx.select().from(enforcementCitations).where(eq(enforcementCitations.eventRef, eventRef));
    const orders = await tx.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.eventRef, eventRef));
    return {
      eventRef, created: false,
      violationRefs: violations.map((v: { violationRef: string }) => v.violationRef),
      citationRefs: citations.map((c: { citationRef: string }) => c.citationRef),
      orderRefs: orders.map((o: { orderRef: string }) => o.orderRef),
      repairRequired: violations.filter((v: { repairRequired: boolean }) => v.repairRequired).map((v: { violationRef: string; ownCode: string; system: string }) => ({ violationRef: v.violationRef, ownCode: v.ownCode, system: v.system })),
      notes: ["This stop was already confirmed; nothing was written a second time"],
    };
  }

  await tx.insert(enforcementEvents).values({
    eventRef, eventType: input.eventType, jurisdiction: input.jurisdiction, agency: input.agency,
    occurredAt: input.occurredAt, locationText: input.locationText ?? null,
    inspectionReportNumber: input.inspectionReportNumber ?? null, inspectionLevel: input.inspectionLevel ?? null,
    inspectionResult: input.inspectionResult, operatorId: input.operatorId ?? null, unitId: input.unitId ?? null,
    trailerId: input.trailerId ?? null, jobId: input.jobId ?? null, extractionRef: input.extractionRef ?? null,
    tenantId: input.tenantId ?? null, branchId: input.branchId ?? null, terminalId: input.terminalId ?? null,
    status: "confirmed", confirmedByUserId: input.confirmedByUserId, confirmedAt: new Date(),
  });

  const violationRefs: string[] = [];
  const citationRefs: string[] = [];
  const orderRefs: string[] = [];
  const repairRequired: ConfirmResult["repairRequired"] = [];

  for (const v of input.violations) {
    const c = consequencesOf(v);
    notes.push(...c.reasons);
    const violationRef = `EVL-${idempotencyKey([eventRef, v.ownCode, v.system, v.violationRef]).slice(0, 16).toUpperCase()}`;
    violationRefs.push(violationRef);
    await tx.insert(enforcementViolations).values({
      violationRef, eventRef, system: v.system, ownCode: v.ownCode,
      sourceReference: v.sourceReference ?? null, description: v.description ?? null,
      citationIssued: v.citationIssued, outOfService: v.outOfService, oosScope: v.oosScope,
      defectRequired: c.createsDefect, repairRequired: v.repairRequired, courtAction: v.courtAction,
    });

    if (v.citationIssued) {
      const citationRef = `CIT-${idempotencyKey([violationRef, "citation"]).slice(0, 16).toUpperCase()}`;
      citationRefs.push(citationRef);
      await tx.insert(enforcementCitations).values({
        citationRef, eventRef, violationRef, citationNumber: v.citationNumber ?? null,
        offenceDescription: v.description ?? null, fineAmountCents: v.fineAmountCents ?? null,
        // A scanned allegation, and nothing more. It becomes a conviction only
        // when somebody records that disposition.
        status: "scanned",
      });
    }

    if (c.createsOosOrder) {
      if (!v.oosScope) {
        // Refusing is safer than guessing "vehicle": the wrong scope either
        // grounds a truck that was never prohibited or frees one that was.
        notes.push(`${v.ownCode}: out of service with no scope on the document — no order was created, and this needs confirming with the inspector`);
      } else {
        const subjectRef = input.subjectRefFor(v.oosScope);
        if (!subjectRef) {
          notes.push(`${v.ownCode}: out of service scoped to ${v.oosScope} and no such subject is on this event — no order was created`);
        } else {
          const orderRef = `OOS-${idempotencyKey([violationRef, v.oosScope, subjectRef]).slice(0, 16).toUpperCase()}`;
          orderRefs.push(orderRef);
          await tx.insert(outOfServiceOrders).values({
            orderRef, eventRef, violationRef, scope: v.oosScope, subjectRef,
            issuedAt: input.occurredAt, issuingAgency: input.agency,
            releaseCondition: v.releaseCondition ?? "as stated on the order",
            requiredFindingType: v.requiredFindingType ?? null,
            tenantId: input.tenantId ?? null, branchId: input.branchId ?? null, terminalId: input.terminalId ?? null,
            status: "active",
          });
        }
      }
    }

    /**
     * The shop bridge. Until now the commit *named* the defect and work order a
     * violation required and created neither, so `repairsForOrder` found nothing
     * and a prohibited truck could never be released through the product — the
     * chain stopped at a sentence in a return value.
     *
     * They are created inside this transaction on purpose: a prohibition that
     * committed while the work it requires did not would leave a truck grounded
     * with nothing in the shop queue explaining why.
     */
    if (c.createsDefect && input.unitId) {
      const defectRes = await tx.insert(maintenanceDefects).values({
        unitId: input.unitId,
        title: `${v.ownCode} — ${v.description ?? v.system}`.slice(0, 220),
        // The shop's own vocabulary, not the enforcement document's. A
        // prohibition is critical; a required repair needs inspecting; a noted
        // fault is advisory. `tx` is loosely typed inside the transaction, so
        // invalid enum values here fail at the database rather than at compile
        // time — worth being deliberate about.
        severity: v.outOfService ? "critical" : v.repairRequired ? "inspection_required" : "advisory",
        status: "open",
        reportedBy: input.confirmedByUserId,
        reportedAt: input.occurredAt,
      });
      const defectId = insertedId(defectRes);
      if (defectId) await tx.update(enforcementViolations).set({ defectId }).where(eq(enforcementViolations.violationRef, violationRef));

      if (c.createsWorkOrder) {
        const workOrderNumber = `WO-${idempotencyKey([violationRef, "wo"]).slice(0, 12).toUpperCase()}`;
        const woRes = await tx.insert(workOrders).values({
          workOrderNumber, unitId: input.unitId, defectId: defectId ?? null,
          // A truck under a government prohibition is not routine work.
          status: "open", priority: v.outOfService ? "critical" : "urgent",
          openedAt: input.occurredAt,
        });
        const workOrderId = insertedId(woRes);
        if (workOrderId) await tx.update(enforcementViolations).set({ workOrderId }).where(eq(enforcementViolations.violationRef, violationRef));
      }
    }

    if (c.createsWorkOrder) repairRequired.push({ violationRef, ownCode: v.ownCode, system: v.system });
  }

  if (input.extractionRef) {
    await tx.update(enforcementDocumentExtractions)
      .set({ status: "confirmed", confirmedEventRef: eventRef })
      .where(eq(enforcementDocumentExtractions.extractionRef, input.extractionRef));
  }

  if (input.enqueue) {
    // Severity follows the facts: a prohibition is critical, a required repair
    // is urgent, and a warning is neither.
    const severity = orderRefs.length ? "critical" : repairRequired.length ? "urgent" : "routine";
    await input.enqueue(tx, { eventRef, eventType: input.eventType, severity, orderRefs, repairRequired: repairRequired.length });
  }

  return { eventRef, created: true, violationRefs, citationRefs, orderRefs, repairRequired, notes };
}

/* ------------------------------------------------------------------ */
/* Releasing, which is its own act                                      */
/* ------------------------------------------------------------------ */

export type ReleaseDecision =
  | { released: true; orderRef: string; note: string }
  | { released: false; orderRef: string; state: string; reasons: string[] };

/**
 * Attempt to release an order.
 *
 * Everything this checks is a precondition. `releasable` is computed from the
 * repairs and the latest release finding; the row only changes because this
 * function was deliberately called by somebody entitled to call it. A caller
 * that merely asks whether an order is releasable gets an answer and changes
 * nothing.
 */
export async function releaseOutOfServiceOrder(
  tx: Tx,
  args: { orderRef: string; repairs: readonly RepairRecord[]; releasedByUserId: number; releaseEvidenceRef: string | null; at: Date },
): Promise<ReleaseDecision> {
  const row = (await tx.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, args.orderRef)).limit(1))[0];
  if (!row) return { released: false, orderRef: args.orderRef, state: "not_found", reasons: ["No such out-of-service order"] };
  if (row.status !== "active") return { released: false, orderRef: args.orderRef, state: row.status, reasons: [`This order is already ${row.status}`] };

  // The latest finding is the answer; earlier ones are kept as history.
  // Ordered in the database, and by id as well as time: `recordedAt` is a
  // second-precision timestamp, so two findings recorded in the same second —
  // which is exactly what happens when somebody corrects one immediately —
  // would otherwise resolve by whichever the array happened to hold first.
  const findings = await tx.select().from(oosReleaseFindings)
    .where(eq(oosReleaseFindings.orderRef, args.orderRef))
    .orderBy(desc(oosReleaseFindings.recordedAt), desc(oosReleaseFindings.id));
  const latest = findings[0];
  const satisfied: boolean | "unknown" = !latest ? "unknown" : latest.finding === "satisfied" ? true : latest.finding === "not_satisfied" ? false : "unknown";

  const order: OosOrder = {
    orderRef: row.orderRef, scope: row.scope, subjectRef: row.subjectRef, issuedAt: row.issuedAt,
    issuingAgency: row.issuingAgency, releaseCondition: row.releaseCondition,
    releasedAt: row.releasedAt, releasedByUserId: row.releasedByUserId,
    releaseEvidenceRef: row.releaseEvidenceRef, rescindedAt: row.rescindedAt,
  };
  const readiness = releaseReadiness({ order, repairs: args.repairs, releaseConditionSatisfied: satisfied, at: args.at });
  if (!readiness.releasable) return { released: false, orderRef: args.orderRef, state: readiness.state, reasons: readiness.reasons };

  // Who may release is the approved policy's answer, loaded here rather than
  // taken from the caller — so asking `releaseReadiness` five seconds ago grants
  // nothing, and the check happens at the moment the row actually changes.
  const policyRows = await tx.select().from(oosReleasePolicies).where(eq(oosReleasePolicies.status, "approved"));
  const policies: ScopedPolicy[] = policyRows.map((r: Record<string, unknown>) => ({
    policyRef: r.policyRef as string, version: r.version as number,
    scopeType: r.scopeType as "company" | "branch" | "terminal", scopeRef: (r.scopeRef as string | null) ?? null,
    tenantId: (r.tenantId as string | null) ?? null,
    effectiveFrom: r.effectiveFrom as Date, effectiveTo: (r.effectiveTo as Date | null) ?? null,
    repairerMayRecordRepairVerification: !!r.repairerMayRecordRepairVerification,
    releaserMustDifferFromRepairer: !!r.releaserMustDifferFromRepairer,
    releaserMustDifferFromFindingAuthor: !!r.releaserMustDifferFromFindingAuthor,
    allowedFindingRoles: JSON.parse(r.allowedFindingRolesJson as string),
    approvedByUserId: (r.approvedByUserId as number) ?? 0, approvedAt: (r.approvedAt as Date) ?? (r.effectiveFrom as Date),
  }));
  // The order's own snapshotted scope decides, not the unit's current branch.
  const selection = selectPolicyForScope(policies, { tenantId: row.tenantId ?? null, branchId: row.branchId ?? null, terminalId: row.terminalId ?? null }, args.at);
  if (!selection.policy) return { released: false, orderRef: args.orderRef, state: "release_blocked", reasons: [selection.reason] };
  const policy = selection.policy;
  const permitted = mayRelease({
    policy,
    releaserUserId: args.releasedByUserId,
    repairedByUserIds: args.repairs.map(r => r.repairCompletedByUserId).filter((n): n is number => n != null),
    findingAuthorUserIds: findings.map((f: { recordedByUserId: number }) => f.recordedByUserId),
  });
  if (!permitted.allowed) return { released: false, orderRef: args.orderRef, state: "release_blocked", reasons: [permitted.reason] };

  // The non-configurable half, read from the order rather than from an argument.
  if (latest) {
    const dominance = satisfiesIssuingCondition(row.requiredFindingType ?? null, { findingType: latest.findingType, finding: latest.finding });
    if (!dominance.allowed) return { released: false, orderRef: args.orderRef, state: "release_blocked", reasons: [dominance.reason] };
  }

  // The WHERE clause was already right; ignoring what it did was not. Two
  // callers reading an active order at the same moment would both have been
  // told they released it, and only one of them changed a row.
  const result = await tx.update(outOfServiceOrders)
    .set({ status: "released", releasedAt: args.at, releasedByUserId: args.releasedByUserId, releaseEvidenceRef: args.releaseEvidenceRef, releasePolicyRef: policy.policyRef, releasePolicyVersion: policy.version })
    .where(and(eq(outOfServiceOrders.orderRef, args.orderRef), eq(outOfServiceOrders.status, "active")));

  const changed = affectedRows(result);
  if (changed !== 1) {
    return {
      released: false, orderRef: args.orderRef, state: "already_released",
      reasons: ["Another release completed first — this call changed nothing. The order is released; it was not released by this caller."],
    };
  }

  return { released: true, orderRef: args.orderRef, note: `Released under the ${selection.scopeType} policy ${policy.policyRef} v${policy.version} against the recorded finding "${latest?.findingType ?? "none"}". The order, the policy version and every finding remain on record.` };
}
