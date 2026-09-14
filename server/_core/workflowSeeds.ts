/**
 * Workflow rule seeds — the four reference workflows as real, versioned rules.
 *
 * Source-controlled rather than test fixtures, so the behaviour a developer
 * reads here is the behaviour production runs. `syncRuleSeeds` upserts them by
 * (ruleKey, version); editing a rule means publishing a new version, never
 * mutating a released one — a task created last month must still be
 * explainable by the rule that created it.
 *
 * The boundary held throughout: these rules COORDINATE. They create tasks,
 * mark things at risk and ask domains to re-evaluate. Not one of them decides
 * whether a truck is safe, a credential is valid or a charge is billable.
 */

import type { WorkflowRule } from "./workflowEngine";

export const RULE_SEEDS: WorkflowRule[] = [
  /* ── A. Critical defect ────────────────────────────────────────────── */
  {
    ruleKey: "fleet.critical_defect.opened",
    version: 1,
    name: "Critical defect opened on a unit",
    eventType: "unit.critical_defect_opened",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [{ path: "payload.severity", op: "eq", value: "critical" }],
    dedupeOn: ["payload.unitId"],
    actions: [
      {
        kind: "create_task",
        taskType: "resolve_critical_defect",
        title: "Inspect and resolve critical defect",
        description:
          "Unit is held from dispatch until a qualified mechanic releases it. " +
          "The workflow cannot mark the unit safe — only a release can.",
        assignedRole: "mechanic",
        priority: "critical",
        isRoot: true,
      },
      {
        kind: "create_task",
        taskType: "review_affected_assignments",
        title: "Review assignments affected by a held unit",
        assignedRole: "dispatcher",
        priority: "high",
        dueInMinutes: 60,
      },
      // The dispatch domain owns the verdict; this only invalidates the cache
      // so the next gate run recomputes instead of trusting a stale check.
      { kind: "invalidate_eligibility", scope: "unit" },
      { kind: "mark_at_risk", scope: "assignment" },
      {
        kind: "notify",
        role: "mechanic",
        message: "Critical defect opened — unit held from dispatch",
        deepLink: "/fleet/defects",
      },
    ],
  },

  /* Resolution side: a verified mechanic release asks dispatch to re-check. */
  {
    ruleKey: "fleet.mechanic_release.verified",
    version: 1,
    name: "Mechanic release verified — re-evaluate dispatch",
    eventType: "unit.mechanic_released",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    conditions: [{ path: "payload.releaseVerified", op: "eq", value: true }],
    dedupeOn: ["payload.unitId"],
    actions: [
      { kind: "reevaluate", target: "dispatch" },
      { kind: "reevaluate", target: "predeparture" },
      { kind: "close_workflow", workflowKey: "critical_defect" },
    ],
  },

  /* ── B. Missing disposal ticket ────────────────────────────────────── */
  {
    ruleKey: "billing.disposal_ticket.missing",
    version: 1,
    name: "Disposal completed without a facility ticket",
    eventType: "disposal.ticket_missing",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    conditions: [
      { path: "payload.facilityIssuesTicket", op: "eq", value: true },
    ],
    // Per load, not per job — one missing ticket must not mask another.
    dedupeOn: ["payload.loadId"],
    actions: [
      {
        kind: "create_task",
        taskType: "upload_disposal_ticket",
        // Names the specific evidence, never "job incomplete".
        title: "Photograph the disposal ticket",
        description:
          "Only the disposal charge is held. Other accepted charges may still invoice.",
        assignedRole: "driver",
        priority: "normal",
        dueInMinutes: 120,
        isRoot: true,
      },
      {
        kind: "notify",
        role: "driver",
        message: "Disposal ticket needed before this load can be billed",
        deepLink: "/trips/current",
      },
    ],
  },

  {
    ruleKey: "billing.disposal_ticket.verified",
    version: 1,
    name: "Disposal ticket verified — re-run reconciliation and billing",
    eventType: "disposal.ticket_verified",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    conditions: [{ path: "payload.verifiedBy", op: "exists" }],
    dedupeOn: ["payload.loadId"],
    actions: [
      { kind: "reevaluate", target: "billing" },
      { kind: "close_workflow", workflowKey: "missing_disposal_ticket" },
    ],
  },

  /* ── C. Expiring operator credential ───────────────────────────────── */
  {
    ruleKey: "compliance.credential.expiring",
    version: 1,
    name: "Operator credential approaching expiry",
    eventType: "operator.credential_expiring",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    // The credential domain decides what "expiring" means and emits it.
    // This rule only reacts to a threshold the domain already crossed.
    conditions: [{ path: "payload.daysRemaining", op: "lte", value: 30 }],
    dedupeOn: ["payload.operatorId", "payload.credentialCode"],
    actions: [
      {
        kind: "create_task",
        taskType: "renew_credential",
        title: "Renew expiring credential",
        description:
          "A verified replacement document is required — this cannot be closed manually.",
        assignedRole: "office",
        priority: "high",
        dueInMinutes: 1440,
        isRoot: true,
      },
      {
        kind: "notify",
        role: "operator",
        message: "One of your credentials expires soon",
        deepLink: "/people/credentials",
      },
    ],
  },

  {
    ruleKey: "compliance.credential.verified",
    version: 1,
    name: "Replacement credential verified — re-evaluate future assignments",
    eventType: "document.verified",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    conditions: [
      { path: "payload.documentKind", op: "eq", value: "operator_credential" },
    ],
    dedupeOn: ["payload.operatorId", "payload.credentialCode"],
    actions: [
      { kind: "invalidate_eligibility", scope: "operator" },
      { kind: "reevaluate", target: "dispatch" },
      { kind: "close_workflow", workflowKey: "credential_renewal" },
    ],
  },

  /* ── D. Assignment at risk ─────────────────────────────────────────── */
  {
    ruleKey: "dispatch.assignment.at_risk",
    version: 1,
    name: "Assignment invalidated by a dependency change",
    eventType: "dispatch.assignment_at_risk",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    dedupeOn: ["payload.assignmentId"],
    conditions: [{ path: "payload.invalidationCause", op: "exists" }],
    actions: [
      {
        kind: "create_task",
        taskType: "resolve_assignment_risk",
        title: "Assignment at risk — resolve or reassign",
        description:
          "Scheduled, but not cleared to depart. The cause is shown on the task.",
        assignedRole: "dispatcher",
        priority: "high",
        dueInMinutes: 120,
        isRoot: true,
      },
      {
        kind: "notify",
        role: "dispatcher",
        message: "An assignment became at risk",
        deepLink: "/dispatch/at-risk",
      },
    ],
  },

  /* ── E. B20 records, safety & release ───────────────────────────────── */

  /* A sealed incident. The rule holds the unit and notifies; it does not
     diagnose the truck and it does not decide the severity — safety already
     did, and this reports that decision. */
  {
    ruleKey: "safety.incident.sealed",
    version: 1,
    name: "Incident sealed in the field",
    eventType: "safety.incident_sealed",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [
      { path: "payload.severity", op: "in", value: ["moderate", "serious", "critical"] },
    ],
    dedupeOn: ["payload.incidentNumber"],
    actions: [
      {
        kind: "create_task",
        taskType: "review_sealed_incident",
        title: "Review sealed incident report",
        description:
          "Operator sealed an incident in the field. The original statement is " +
          "attached verbatim and must not be edited during review.",
        assignedRole: "safety",
        priority: "high",
        isRoot: true,
      },
      {
        kind: "notify",
        role: "management",
        message: "Incident sealed — management review required",
        deepLink: "/safety/incidents",
      },
    ],
  },

  /* A held unit is a dispatch fact before it is anything else. Split from the
     rule above so a hold raises the dispatch consequence even when severity
     alone would not have escalated. */
  {
    ruleKey: "safety.incident.unit_held",
    version: 1,
    name: "Incident held a unit — recalculate dispatch",
    eventType: "safety.incident_sealed",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [{ path: "payload.holdUnit", op: "eq", value: true }],
    dedupeOn: ["payload.incidentNumber"],
    actions: [
      {
        kind: "create_task",
        taskType: "inspect_unit_after_incident",
        title: "Inspect unit held after an incident",
        description:
          "Held pending inspection. The workflow cannot return it to service — " +
          "only a mechanic release can.",
        assignedRole: "mechanic",
        priority: "critical",
        isRoot: true,
      },
      {
        kind: "create_task",
        taskType: "review_affected_assignments",
        title: "Review assignments affected by a held unit",
        assignedRole: "dispatcher",
        priority: "high",
        dueInMinutes: 60,
      },
      { kind: "invalidate_eligibility", scope: "unit" },
      { kind: "mark_at_risk", scope: "assignment" },
    ],
  },

  /* A near miss that reported an injury converts. Safety reviews the converted
     incident; the original near-miss statement travels with it. */
  {
    ruleKey: "safety.near_miss.escalated",
    version: 1,
    name: "Near miss escalated to an incident",
    eventType: "safety.near_miss_escalated",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [],
    dedupeOn: ["payload.nearMissNumber"],
    actions: [
      {
        kind: "create_task",
        taskType: "review_escalated_near_miss",
        title: "Review near miss escalated to incident",
        assignedRole: "safety",
        priority: "high",
        isRoot: true,
      },
      {
        kind: "notify",
        role: "management",
        message: "Near miss escalated — injury reported",
        deepLink: "/safety/incidents",
      },
    ],
  },

  /* Integrity failure on receipt. The task is to get the record re-sent; the
     device copy is deliberately retained, so this is not a driver chase. */
  {
    ruleKey: "records.evidence.integrity_failed",
    version: 1,
    name: "Sealed record failed integrity verification",
    eventType: "records.evidence_integrity_failed",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [],
    dedupeOn: ["payload.trackingNumber"],
    actions: [
      {
        kind: "create_task",
        taskType: "resolve_evidence_integrity_failure",
        title: "Sealed record did not verify — re-transmission required",
        description:
          "Server could not reproduce the sealed hash. The operator's local " +
          "copy is retained and must not be deleted until this resolves.",
        assignedRole: "office",
        priority: "high",
        isRoot: true,
      },
      {
        kind: "notify",
        role: "office",
        message: "Evidence integrity error — local copy retained",
        deepLink: "/records/exceptions",
      },
    ],
  },

  /* Legal hold. Tracked as an obligation with a review task rather than a flag
     nobody revisits. */
  {
    ruleKey: "records.legal_hold.placed",
    version: 1,
    name: "Legal hold placed on records",
    eventType: "records.legal_hold_placed",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [],
    dedupeOn: ["payload.holdNumber"],
    actions: [
      {
        kind: "create_task",
        taskType: "confirm_legal_hold_scope",
        title: "Confirm legal hold scope covers all related records",
        assignedRole: "management",
        priority: "high",
        isRoot: true,
      },
    ],
  },

  /* Management reviewed a driver defect and sent it to the shop. */
  {
    ruleKey: "fleet.defect.sent_to_shop",
    version: 1,
    name: "Defect sent to the shop",
    eventType: "fleet.defect_sent_to_shop",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [],
    dedupeOn: ["payload.workOrderRef"],
    actions: [
      {
        kind: "create_task",
        taskType: "perform_work_order",
        title: "Work order raised from a driver defect report",
        description:
          "The driver's original observation is attached verbatim. Closing this " +
          "work order does not return the unit to service.",
        assignedRole: "mechanic",
        priority: "high",
        isRoot: true,
      },
      {
        kind: "notify",
        role: "mechanic",
        message: "Defect sent to shop — work order raised",
        deepLink: "/shop/work-orders",
      },
    ],
  },

  /* A restricted release is still a release. Dispatch is told the restriction
     rather than simply being told the unit is clear. */
  {
    ruleKey: "fleet.mechanic_release.restricted",
    version: 1,
    name: "Unit released under restriction",
    eventType: "unit.mechanic_released",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [
      { path: "payload.releaseVerified", op: "eq", value: true },
      { path: "payload.restricted", op: "eq", value: true },
    ],
    dedupeOn: ["payload.unitId"],
    actions: [
      {
        kind: "create_task",
        taskType: "apply_release_restriction",
        title: "Unit released under a stated restriction",
        description:
          "The restriction travels with the unit. Assignments must be checked " +
          "against it before dispatch.",
        assignedRole: "dispatcher",
        priority: "high",
        isRoot: true,
      },
      { kind: "invalidate_eligibility", scope: "unit" },
    ],
  },

  /* A revoked release takes the unit back out of service. */
  {
    ruleKey: "fleet.mechanic_release.revoked",
    version: 1,
    name: "Mechanic release revoked — unit held again",
    eventType: "unit.mechanic_released",
    enabled: true,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    tenantId: null,
    branchId: null,
    conditions: [{ path: "payload.releaseType", op: "eq", value: "revoked" }],
    dedupeOn: ["payload.unitId"],
    actions: [
      {
        kind: "create_task",
        taskType: "resolve_revoked_release",
        title: "Release revoked — unit held from dispatch",
        assignedRole: "mechanic",
        priority: "critical",
        isRoot: true,
      },
      { kind: "invalidate_eligibility", scope: "unit" },
      { kind: "mark_at_risk", scope: "assignment" },
    ],
  },

];

/* ===================== responsibility routing ===================== */

/**
 * Which team owns a task type, per tenant/branch. Never a named person — an
 * individual leaves and their queue disappears with them.
 */
export type ResponsibilityMapping = {
  taskType: string;
  tenantId?: string | null;
  branchId?: string | null;
  primaryRole: string;
  escalationRole?: string | null;
};

export const RESPONSIBILITY_DEFAULTS: ResponsibilityMapping[] = [
  {
    taskType: "resolve_critical_defect",
    primaryRole: "mechanic",
    escalationRole: "shop_supervisor",
  },
  {
    taskType: "review_affected_assignments",
    primaryRole: "dispatcher",
    escalationRole: "operations_manager",
  },
  {
    taskType: "upload_disposal_ticket",
    primaryRole: "driver",
    escalationRole: "office",
  },
  {
    taskType: "renew_credential",
    primaryRole: "office",
    escalationRole: "compliance",
  },
  {
    taskType: "renew_inspection",
    primaryRole: "fleet_compliance",
    escalationRole: "shop_supervisor",
  },
  {
    taskType: "resolve_assignment_risk",
    primaryRole: "dispatcher",
    escalationRole: "operations_manager",
  },
];

export function resolveResponsibility(
  taskType: string,
  tenantId?: string | null,
  branchId?: string | null,
  mappings: ResponsibilityMapping[] = RESPONSIBILITY_DEFAULTS
): ResponsibilityMapping | null {
  // Most specific wins: branch → tenant → platform default.
  const candidates = mappings.filter(m => m.taskType === taskType);
  return (
    candidates.find(m => m.branchId === branchId && m.tenantId === tenantId) ??
    candidates.find(m => !m.branchId && m.tenantId === tenantId) ??
    candidates.find(m => !m.branchId && !m.tenantId) ??
    null
  );
}

/* ===================== seed synchronisation ===================== */

export type SeedPlan = {
  insert: WorkflowRule[];
  unchanged: string[];
  /** Seeds whose released version differs — published as a new version, never edited. */
  conflicts: Array<{ ruleKey: string; version: number; reason: string }>;
};

/**
 * Compare source seeds against what is already released. A released version is
 * immutable: if its content changed, that is a conflict to resolve by bumping
 * the version, not by overwriting history.
 */
export function planSeedSync(
  seeds: WorkflowRule[],
  existing: Array<{
    ruleKey: string;
    version: number;
    conditionsJson: string;
    actionsJson: string;
  }>
): SeedPlan {
  const plan: SeedPlan = { insert: [], unchanged: [], conflicts: [] };

  for (const seed of seeds) {
    const released = existing.find(
      e => e.ruleKey === seed.ruleKey && e.version === seed.version
    );
    if (!released) {
      plan.insert.push(seed);
      continue;
    }
    const sameConditions =
      released.conditionsJson === JSON.stringify(seed.conditions);
    const sameActions = released.actionsJson === JSON.stringify(seed.actions);
    if (sameConditions && sameActions) {
      plan.unchanged.push(`${seed.ruleKey}.v${seed.version}`);
    } else {
      plan.conflicts.push({
        ruleKey: seed.ruleKey,
        version: seed.version,
        reason:
          `${seed.ruleKey}.v${seed.version} is already released with different content. ` +
          `Publish v${seed.version + 1} instead of editing a released rule.`,
      });
    }
  }
  return plan;
}
