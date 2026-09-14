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
