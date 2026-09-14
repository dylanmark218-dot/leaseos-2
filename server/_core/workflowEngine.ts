/**
 * Workflow orchestration core.
 *
 *   EVENT → POLICY → CONSEQUENCES → TASKS → OWNER → NOTIFY
 *         → ACTION → RE-EVALUATION → CLOSE → AUDIT
 *
 * The boundary this file must never cross:
 *
 *     Workflow rules COORDINATE. Domain engines DECIDE.
 *
 * This engine does not judge whether a truck is mechanically safe, a route is
 * legal, a TDG classification is right or an invoice is valid. It reacts to
 * what the domain engines already decided, works out who needs to do
 * something about it, and keeps track until it's resolved.
 *
 * Everything here is pure. Persistence and outbox draining live in
 * eventOutbox.ts so the coordination logic can be tested without a database.
 */

/* ============================== events ============================== */

export type EventSource = "human" | "system" | "ai" | "integration";

export type DomainEvent<TPayload = Record<string, unknown>> = {
  id: string;
  type: string;
  version: number;
  occurredAt: Date;
  recordedAt: Date;
  tenantId: string;
  branchId?: string | null;
  actor?: {
    userId?: string | null;
    operatorId?: string | null;
    role?: string | null;
    source: EventSource;
  };
  subject: { entityType: string; entityId: string };
  jobId?: string | null;
  tripId?: string | null;
  unitId?: string | null;
  trailerId?: string | null;
  equipmentId?: string | null;
  correlationId?: string | null;
  /** The event that caused this one. Builds the causal chain for "why?". */
  causationId?: string | null;
  payload: TPayload;
};

/* ============================== rules ============================== */

export type Comparator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "absent"
  | "in";

export type RuleCondition = { path: string; op: Comparator; value?: unknown };

export type TaskAction = {
  kind: "create_task";
  taskType: string;
  title: string;
  description?: string;
  assignedRole: string;
  priority: "low" | "normal" | "high" | "critical";
  dueInMinutes?: number;
  /** Marks the task as the root cause; others attach to it as consequences. */
  isRoot?: boolean;
};

export type ConsequenceAction =
  | TaskAction
  | { kind: "invalidate_eligibility"; scope: "unit" | "operator" | "trailer" }
  | { kind: "mark_at_risk"; scope: "assignment" }
  | { kind: "notify"; role: string; message: string; deepLink?: string }
  | { kind: "reevaluate"; target: "dispatch" | "billing" | "predeparture" }
  | { kind: "close_workflow"; workflowKey: string };

export type WorkflowRule = {
  ruleKey: string;
  version: number;
  name: string;
  eventType: string;
  enabled: boolean;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  tenantId?: string | null;
  branchId?: string | null;
  conditions: RuleCondition[];
  actions: ConsequenceAction[];
  /** Used to collapse repeat firings onto one task. See buildDedupeKey. */
  dedupeOn?: string[];
};

/** Dotted lookup into the event, so conditions read `payload.severity` etc. */
export function resolvePath(event: DomainEvent, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined || typeof acc !== "object")
      return undefined;
    return (acc as Record<string, unknown>)[part];
  }, event as unknown);
}

function testCondition(event: DomainEvent, c: RuleCondition): boolean {
  const actual = resolvePath(event, c.path);
  switch (c.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "absent":
      return actual === undefined || actual === null;
    case "eq":
      return actual === c.value;
    case "neq":
      return actual !== c.value;
    case "in":
      return Array.isArray(c.value) && c.value.includes(actual);
    case "gt":
      return typeof actual === "number" && actual > (c.value as number);
    case "gte":
      return typeof actual === "number" && actual >= (c.value as number);
    case "lt":
      return typeof actual === "number" && actual < (c.value as number);
    case "lte":
      return typeof actual === "number" && actual <= (c.value as number);
  }
}

export type RuleMatch = { rule: WorkflowRule; actions: ConsequenceAction[] };

/**
 * Which rules apply to this event, right now, for this tenant. A rule is only
 * considered if it is enabled, in its effective window, and scoped to the
 * event's tenant (or is a platform default with no tenant).
 */
export function evaluateRules(
  event: DomainEvent,
  rules: WorkflowRule[],
  now: Date
): RuleMatch[] {
  return rules
    .filter(r => r.enabled)
    .filter(r => r.eventType === event.type)
    .filter(r => !r.effectiveFrom || r.effectiveFrom.getTime() <= now.getTime())
    .filter(r => !r.effectiveTo || r.effectiveTo.getTime() > now.getTime())
    .filter(r => !r.tenantId || r.tenantId === event.tenantId)
    .filter(r => !r.branchId || r.branchId === event.branchId)
    .filter(r => r.conditions.every(c => testCondition(event, c)))
    .map(rule => ({ rule, actions: rule.actions }));
}

/* ============================== tasks ============================== */

export type TaskStatus =
  | "open"
  | "acknowledged"
  | "in_progress"
  | "waiting"
  | "completed"
  | "cancelled";

export type OperationalTask = {
  taskNumber: string;
  taskType: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskAction["priority"];
  tenantId: string;
  branchId?: string | null;
  assignedRole: string;
  assignedUserId?: string | null;
  subjectType: string;
  subjectId: string;
  jobId?: string | null;
  tripId?: string | null;
  unitId?: string | null;
  sourceEventId: string;
  sourceRuleKey: string;
  sourceRuleVersion: number;
  dedupeKey: string;
  /** Set on consequence tasks; points at the root cause's dedupeKey. */
  rootDedupeKey?: string | null;
  createdAt: Date;
  dueAt?: Date | null;
  completedAt?: Date | null;
  resolutionCode?: string | null;
  requiresEvidence: boolean;
};

/**
 * One unresolved condition produces one active task, however many times the
 * event fires. Key is rule + subject, not rule + event — otherwise a defect
 * re-reported three times creates three identical shop tasks.
 */
export function buildDedupeKey(
  rule: WorkflowRule,
  event: DomainEvent,
  action: TaskAction
): string {
  const parts = [
    rule.ruleKey,
    action.taskType,
    event.subject.entityType,
    event.subject.entityId,
  ];
  for (const path of rule.dedupeOn ?? []) {
    const v = resolvePath(event, path);
    parts.push(`${path}=${String(v)}`);
  }
  return parts.join("|");
}

export type TaskPlan = {
  create: OperationalTask[];
  suppressed: Array<{ dedupeKey: string; reason: string }>;
};

/**
 * Turn matched rules into the tasks that should actually exist, given what is
 * already open. Reprocessing the same event must produce an empty plan —
 * that is what makes outbox retries safe.
 */
export function planTasks(
  event: DomainEvent,
  matches: RuleMatch[],
  existingOpen: Array<Pick<OperationalTask, "dedupeKey" | "status">>,
  now: Date,
  numberFor: (seq: number) => string = n => `TASK-${String(n).padStart(6, "0")}`
): TaskPlan {
  const openKeys = new Set(
    existingOpen
      .filter(t => t.status !== "completed" && t.status !== "cancelled")
      .map(t => t.dedupeKey)
  );
  const create: OperationalTask[] = [];
  const suppressed: TaskPlan["suppressed"] = [];

  // Root first, so consequences can point at it.
  const ordered = matches
    .flatMap(m =>
      m.actions
        .filter((a): a is TaskAction => a.kind === "create_task")
        .map(a => ({ rule: m.rule, action: a }))
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.action.isRoot)) - Number(Boolean(a.action.isRoot))
    );

  const rootKey = ordered.find(o => o.action.isRoot)
    ? buildDedupeKey(
        ordered.find(o => o.action.isRoot)!.rule,
        event,
        ordered.find(o => o.action.isRoot)!.action
      )
    : null;

  let seq = 1;
  for (const { rule, action } of ordered) {
    const dedupeKey = buildDedupeKey(rule, event, action);

    if (openKeys.has(dedupeKey)) {
      suppressed.push({
        dedupeKey,
        reason: "An open task already covers this condition",
      });
      continue;
    }
    openKeys.add(dedupeKey);

    create.push({
      taskNumber: numberFor(seq++),
      taskType: action.taskType,
      title: action.title,
      description: action.description ?? null,
      status: "open",
      priority: action.priority,
      tenantId: event.tenantId,
      branchId: event.branchId ?? null,
      assignedRole: action.assignedRole,
      assignedUserId: null,
      subjectType: event.subject.entityType,
      subjectId: event.subject.entityId,
      jobId: event.jobId ?? null,
      tripId: event.tripId ?? null,
      unitId: event.unitId ?? null,
      sourceEventId: event.id,
      sourceRuleKey: rule.ruleKey,
      sourceRuleVersion: rule.version,
      dedupeKey,
      rootDedupeKey: action.isRoot ? null : rootKey,
      createdAt: now,
      dueAt: action.dueInMinutes
        ? new Date(now.getTime() + action.dueInMinutes * 60_000)
        : null,
      completedAt: null,
      resolutionCode: null,
      // Regulated conditions do not clear because somebody pressed Done.
      requiresEvidence: REQUIRE_EVIDENCE.has(action.taskType),
    });
  }

  return { create, suppressed };
}

/** Task types whose completion must carry verified evidence, not a click. */
const REQUIRE_EVIDENCE = new Set([
  "renew_inspection",
  "renew_credential",
  "mechanic_release",
  "upload_disposal_ticket",
  "verify_document",
  "resolve_critical_defect",
]);

export type CompletionAttempt = {
  taskType: string;
  resolutionCode?: string | null;
  evidenceRef?: string | null;
  actorRole: string;
};

/**
 * "Completed" must not mean "the problem stopped being visible". A renewal
 * task closes because a verified document exists, not because someone is
 * tired of seeing it.
 */
export function canCompleteTask(attempt: CompletionAttempt): {
  ok: boolean;
  reason?: string;
} {
  if (REQUIRE_EVIDENCE.has(attempt.taskType) && !attempt.evidenceRef) {
    return {
      ok: false,
      reason: `${attempt.taskType} requires verified evidence to complete`,
    };
  }
  if (!attempt.resolutionCode) {
    return { ok: false, reason: "A resolution code is required" };
  }
  return { ok: true };
}

/* ========================= workflow instances ========================= */

export type WorkflowDefinition = {
  workflowKey: string;
  name: string;
  initial: string;
  /** state → allowed next states. Anything absent is refused. */
  transitions: Record<string, string[]>;
  terminal: string[];
  /** Transitions that may only be taken with evidence attached. */
  evidenceRequired?: Record<string, string[]>;
};

export const WORKFLOWS: Record<string, WorkflowDefinition> = {
  critical_defect: {
    workflowKey: "critical_defect",
    name: "Critical defect",
    initial: "reported",
    transitions: {
      reported: ["inspection", "cancelled"],
      inspection: ["work_order", "cancelled"],
      work_order: ["repair", "cancelled"],
      repair: ["test", "cancelled"],
      test: ["mechanic_release", "repair"],
      mechanic_release: ["dispatch_reevaluation"],
      dispatch_reevaluation: ["closed"],
      closed: [],
      cancelled: [],
    },
    terminal: ["closed", "cancelled"],
    evidenceRequired: {
      mechanic_release: ["dispatch_reevaluation"],
      test: ["mechanic_release"],
    },
  },
  missing_disposal_ticket: {
    workflowKey: "missing_disposal_ticket",
    name: "Missing disposal ticket",
    initial: "ticket_missing",
    transitions: {
      ticket_missing: ["driver_requested", "cancelled"],
      driver_requested: ["office_followup", "ticket_received", "cancelled"],
      office_followup: ["ticket_received", "cancelled"],
      ticket_received: ["verified", "driver_requested"],
      verified: ["billing_reevaluated"],
      billing_reevaluated: ["closed"],
      closed: [],
      cancelled: [],
    },
    terminal: ["closed", "cancelled"],
    evidenceRequired: { ticket_received: ["verified"] },
  },
  credential_renewal: {
    workflowKey: "credential_renewal",
    name: "Credential renewal",
    initial: "expiry_warning",
    transitions: {
      expiry_warning: ["renewal_requested", "cancelled"],
      renewal_requested: ["document_received", "cancelled"],
      document_received: ["human_verify", "renewal_requested"],
      human_verify: ["credential_updated", "renewal_requested"],
      credential_updated: ["dispatch_reevaluation"],
      dispatch_reevaluation: ["closed"],
      closed: [],
      cancelled: [],
    },
    terminal: ["closed", "cancelled"],
    evidenceRequired: {
      document_received: ["human_verify"],
      human_verify: ["credential_updated"],
    },
  },
  assignment_at_risk: {
    workflowKey: "assignment_at_risk",
    name: "Assignment at risk",
    initial: "at_risk",
    transitions: {
      at_risk: ["condition_resolved", "reassigned", "cancelled"],
      condition_resolved: ["predeparture_reevaluation"],
      reassigned: ["predeparture_reevaluation"],
      predeparture_reevaluation: ["closed", "at_risk"],
      closed: [],
      cancelled: [],
    },
    terminal: ["closed", "cancelled"],
  },
};

export type TransitionAttempt = {
  workflowKey: string;
  from: string;
  to: string;
  actorRole: string;
  actorSource: EventSource;
  evidenceRef?: string | null;
  reason?: string | null;
};

export type TransitionResult =
  | { allowed: true; from: string; to: string }
  | { allowed: false; refusal: string };

/**
 * The engine decides whether a transition is legal, not the caller. A critical
 * defect cannot go reported → closed however senior the person asking is.
 */
export function attemptTransition(
  attempt: TransitionAttempt
): TransitionResult {
  const def = WORKFLOWS[attempt.workflowKey];
  if (!def)
    return {
      allowed: false,
      refusal: `Unknown workflow: ${attempt.workflowKey}`,
    };

  if (def.terminal.includes(attempt.from)) {
    return {
      allowed: false,
      refusal: `${attempt.from} is terminal — this workflow is finished`,
    };
  }

  const allowedNext = def.transitions[attempt.from];
  if (!allowedNext)
    return { allowed: false, refusal: `Unknown state: ${attempt.from}` };

  if (!allowedNext.includes(attempt.to)) {
    return {
      allowed: false,
      refusal: `${attempt.from} → ${attempt.to} is not a permitted step. From ${attempt.from} you may go to: ${allowedNext.join(", ") || "nowhere"}`,
    };
  }

  const needsEvidence = def.evidenceRequired?.[attempt.from]?.includes(
    attempt.to
  );
  if (needsEvidence && !attempt.evidenceRef) {
    return {
      allowed: false,
      refusal: `${attempt.from} → ${attempt.to} requires evidence`,
    };
  }

  // AI may move a workflow along, but never through a gate that needs proof.
  if (attempt.actorSource === "ai" && needsEvidence) {
    return {
      allowed: false,
      refusal:
        "This step requires a person; AI cannot satisfy an evidence gate",
    };
  }

  return { allowed: true, from: attempt.from, to: attempt.to };
}

/* ========================= escalation ========================= */

export type EscalationStep = {
  afterMinutes: number;
  assignedRole: string;
  priority: TaskAction["priority"];
  label: string;
};

export type EscalationPolicy = { taskType: string; steps: EscalationStep[] };

export const ESCALATIONS: Record<string, EscalationPolicy> = {
  upload_disposal_ticket: {
    taskType: "upload_disposal_ticket",
    steps: [
      {
        afterMinutes: 120,
        assignedRole: "driver",
        priority: "normal",
        label: "Driver reminder",
      },
      {
        afterMinutes: 480,
        assignedRole: "office",
        priority: "high",
        label: "Office follow-up",
      },
      {
        afterMinutes: 1440,
        assignedRole: "supervisor",
        priority: "critical",
        label: "Supervisor",
      },
    ],
  },
  renew_inspection: {
    taskType: "renew_inspection",
    steps: [
      {
        afterMinutes: 0,
        assignedRole: "fleet_compliance",
        priority: "high",
        label: "Compliance",
      },
      {
        afterMinutes: 1440,
        assignedRole: "supervisor",
        priority: "critical",
        label: "Supervisor",
      },
    ],
  },
};

/**
 * The single step this task should be at now — not every step it has passed.
 * Returning one prevents a task escalating into three notifications at once.
 */
export function currentEscalation(
  taskType: string,
  createdAt: Date,
  now: Date
): EscalationStep | null {
  const policy = ESCALATIONS[taskType];
  if (!policy) return null;
  const ageMinutes = (now.getTime() - createdAt.getTime()) / 60_000;
  const due = policy.steps.filter(s => ageMinutes >= s.afterMinutes);
  return due.length ? due[due.length - 1] : null;
}

/* ========================= explanation ========================= */

export type ExplanationInput = {
  task: Pick<
    OperationalTask,
    | "title"
    | "sourceRuleKey"
    | "sourceRuleVersion"
    | "createdAt"
    | "subjectType"
    | "subjectId"
  >;
  /** Friendly rule name, when one is configured. Falls back to key.vN. */
  sourceRuleLabel?: string;
  triggeringEvent: Pick<DomainEvent, "type" | "occurredAt" | "subject">;
  consequences: string[];
  evidenceRef?: string | null;
};

/**
 * Deterministic. Assembled from stored workflow evidence, with no model
 * involved — AI may translate this into plainer language, but it must never
 * be the source of it. An explanation that can hallucinate is not an
 * explanation.
 */
export function explainTask(input: ExplanationInput): string {
  const when = input.triggeringEvent.occurredAt
    .toISOString()
    .replace("T", " ")
    .slice(0, 16);
  const lines = [
    `Because ${input.triggeringEvent.subject.entityType} ${input.triggeringEvent.subject.entityId} ` +
      `raised ${input.triggeringEvent.type} at ${when}.`,
  ];
  if (input.consequences.length) {
    lines.push(`This caused: ${input.consequences.join("; ")}.`);
  }
  lines.push(
    `Rule: ${input.sourceRuleLabel ?? `${input.task.sourceRuleKey}.v${input.task.sourceRuleVersion}`}`
  );
  if (input.evidenceRef) lines.push(`Source: ${input.evidenceRef}`);
  return lines.join(" ");
}

/* ========================= root-cause grouping ========================= */

export type GroupedException = {
  rootTitle: string;
  rootDedupeKey: string;
  owner: string;
  consequences: string[];
  totalTasks: number;
};

/**
 * One root problem with its consequences, rather than four unrelated alerts
 * for the same expired inspection.
 */
export function groupByRootCause(tasks: OperationalTask[]): GroupedException[] {
  const roots = tasks.filter(t => !t.rootDedupeKey);
  return roots.map(root => {
    const children = tasks.filter(t => t.rootDedupeKey === root.dedupeKey);
    return {
      rootTitle: root.title,
      rootDedupeKey: root.dedupeKey,
      owner: root.assignedRole,
      consequences: children.map(c => c.title),
      totalTasks: 1 + children.length,
    };
  });
}
