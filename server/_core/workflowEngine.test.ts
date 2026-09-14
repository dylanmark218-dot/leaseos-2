import { describe, expect, it } from "vitest";
import {
  attemptTransition,
  buildDedupeKey,
  canCompleteTask,
  currentEscalation,
  evaluateRules,
  explainTask,
  groupByRootCause,
  planTasks,
  resolvePath,
  type DomainEvent,
  type OperationalTask,
  type WorkflowRule,
} from "./workflowEngine";

const NOW = new Date(Date.UTC(2026, 8, 3, 8, 0));

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  id: "EVT-1",
  type: "unit.critical_defect_opened",
  version: 1,
  occurredAt: NOW,
  recordedAt: NOW,
  tenantId: "T1",
  branchId: "GP",
  actor: { userId: "u1", role: "driver", source: "human" },
  subject: { entityType: "unit", entityId: "VAC-12" },
  unitId: "VAC-12",
  jobId: "JOB-8841",
  payload: { severity: "critical", defectId: "MD-4892" },
  ...over,
});

const shopRule: WorkflowRule = {
  ruleKey: "fleet.critical_defect",
  version: 1,
  name: "Critical defect opened",
  eventType: "unit.critical_defect_opened",
  enabled: true,
  conditions: [{ path: "payload.severity", op: "eq", value: "critical" }],
  actions: [
    {
      kind: "create_task",
      taskType: "resolve_critical_defect",
      title: "Inspect VAC-12 critical defect",
      assignedRole: "mechanic",
      priority: "critical",
      isRoot: true,
    },
    {
      kind: "create_task",
      taskType: "review_assignments",
      title: "2 assignments at risk",
      assignedRole: "dispatcher",
      priority: "high",
    },
    { kind: "invalidate_eligibility", scope: "unit" },
    { kind: "mark_at_risk", scope: "assignment" },
  ],
};

describe("resolvePath", () => {
  it("reads nested event values", () => {
    expect(resolvePath(event(), "payload.severity")).toBe("critical");
    expect(resolvePath(event(), "subject.entityId")).toBe("VAC-12");
  });
  it("returns undefined rather than throwing on a bad path", () => {
    expect(resolvePath(event(), "payload.nope.deeper")).toBeUndefined();
  });
});

describe("evaluateRules", () => {
  it("matches a rule whose conditions hold", () => {
    expect(evaluateRules(event(), [shopRule], NOW)).toHaveLength(1);
  });

  it("ignores a rule for a different event type", () => {
    expect(
      evaluateRules(event({ type: "trip.completed" }), [shopRule], NOW)
    ).toHaveLength(0);
  });

  it("ignores a rule whose condition fails", () => {
    const advisory = event({ payload: { severity: "advisory" } });
    expect(evaluateRules(advisory, [shopRule], NOW)).toHaveLength(0);
  });

  it("ignores a disabled rule", () => {
    expect(
      evaluateRules(event(), [{ ...shopRule, enabled: false }], NOW)
    ).toHaveLength(0);
  });

  it("respects the effective window", () => {
    const future = {
      ...shopRule,
      effectiveFrom: new Date(Date.UTC(2027, 0, 1)),
    };
    const expired = {
      ...shopRule,
      effectiveTo: new Date(Date.UTC(2026, 0, 1)),
    };
    expect(evaluateRules(event(), [future], NOW)).toHaveLength(0);
    expect(evaluateRules(event(), [expired], NOW)).toHaveLength(0);
  });

  it("does not apply another tenant's rule", () => {
    expect(
      evaluateRules(event(), [{ ...shopRule, tenantId: "T2" }], NOW)
    ).toHaveLength(0);
  });

  it("applies a platform default with no tenant to every tenant", () => {
    expect(
      evaluateRules(event(), [{ ...shopRule, tenantId: null }], NOW)
    ).toHaveLength(1);
  });

  it("scopes by branch when a branch is set", () => {
    expect(
      evaluateRules(event(), [{ ...shopRule, branchId: "EDM" }], NOW)
    ).toHaveLength(0);
    expect(
      evaluateRules(event(), [{ ...shopRule, branchId: "GP" }], NOW)
    ).toHaveLength(1);
  });
});

describe("planTasks — deduplication", () => {
  it("creates the tasks a matched rule calls for", () => {
    const plan = planTasks(
      event(),
      evaluateRules(event(), [shopRule], NOW),
      [],
      NOW
    );
    expect(plan.create).toHaveLength(2);
    expect(plan.create.map(t => t.assignedRole)).toEqual([
      "mechanic",
      "dispatcher",
    ]);
  });

  it("suppresses a task when an open one already covers the condition", () => {
    const first = planTasks(
      event(),
      evaluateRules(event(), [shopRule], NOW),
      [],
      NOW
    );
    const existing = first.create.map(t => ({
      dedupeKey: t.dedupeKey,
      status: t.status,
    }));
    const second = planTasks(
      event({ id: "EVT-2" }),
      evaluateRules(event(), [shopRule], NOW),
      existing,
      NOW
    );
    expect(second.create).toHaveLength(0);
    expect(second.suppressed).toHaveLength(2);
  });

  it("re-opens once the previous task is completed", () => {
    const first = planTasks(
      event(),
      evaluateRules(event(), [shopRule], NOW),
      [],
      NOW
    );
    const done = first.create.map(t => ({
      dedupeKey: t.dedupeKey,
      status: "completed" as const,
    }));
    expect(
      planTasks(
        event({ id: "EVT-3" }),
        evaluateRules(event(), [shopRule], NOW),
        done,
        NOW
      ).create
    ).toHaveLength(2);
  });

  it("keys on the subject, so a different unit gets its own task", () => {
    const a = buildDedupeKey(shopRule, event(), shopRule.actions[0] as never);
    const b = buildDedupeKey(
      shopRule,
      event({ subject: { entityType: "unit", entityId: "VAC-27" } }),
      shopRule.actions[0] as never
    );
    expect(a).not.toBe(b);
  });

  it("attaches consequences to the root task", () => {
    const plan = planTasks(
      event(),
      evaluateRules(event(), [shopRule], NOW),
      [],
      NOW
    );
    const root = plan.create.find(t => t.rootDedupeKey === null)!;
    const child = plan.create.find(t => t.rootDedupeKey !== null)!;
    expect(root.assignedRole).toBe("mechanic");
    expect(child.rootDedupeKey).toBe(root.dedupeKey);
  });

  it("marks regulated task types as requiring evidence", () => {
    const plan = planTasks(
      event(),
      evaluateRules(event(), [shopRule], NOW),
      [],
      NOW
    );
    expect(
      plan.create.find(t => t.taskType === "resolve_critical_defect")
        ?.requiresEvidence
    ).toBe(true);
    expect(
      plan.create.find(t => t.taskType === "review_assignments")
        ?.requiresEvidence
    ).toBe(false);
  });

  it("sets a due time only where the rule asks for one", () => {
    const timed: WorkflowRule = {
      ...shopRule,
      actions: [
        {
          kind: "create_task",
          taskType: "upload_disposal_ticket",
          title: "Photograph ticket",
          assignedRole: "driver",
          priority: "normal",
          dueInMinutes: 120,
        },
      ],
    };
    const plan = planTasks(
      event(),
      evaluateRules(event(), [timed], NOW),
      [],
      NOW
    );
    expect(plan.create[0].dueAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 7_200_000).toISOString()
    );
  });
});

describe("canCompleteTask — done is not the same as resolved", () => {
  it("refuses to close a regulated task without evidence", () => {
    const r = canCompleteTask({
      taskType: "renew_inspection",
      resolutionCode: "renewed",
      actorRole: "office",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("requires verified evidence");
  });

  it("closes a regulated task once evidence is attached", () => {
    expect(
      canCompleteTask({
        taskType: "renew_inspection",
        resolutionCode: "renewed",
        evidenceRef: "INS-2026-2291",
        actorRole: "office",
      }).ok
    ).toBe(true);
  });

  it("still requires a resolution code on an unregulated task", () => {
    expect(
      canCompleteTask({
        taskType: "review_assignments",
        actorRole: "dispatcher",
      }).ok
    ).toBe(false);
  });
});

describe("attemptTransition", () => {
  const base = {
    workflowKey: "critical_defect",
    actorRole: "mechanic",
    actorSource: "human" as const,
  };

  it("permits the defined path", () => {
    expect(
      attemptTransition({ ...base, from: "reported", to: "inspection" }).allowed
    ).toBe(true);
  });

  it("refuses reported → closed and says where you may go instead", () => {
    const r = attemptTransition({ ...base, from: "reported", to: "closed" });
    expect(r.allowed).toBe(false);
    if (!r.allowed)
      expect(r.refusal).toContain("you may go to: inspection, cancelled");
  });

  it("refuses any move out of a terminal state", () => {
    const r = attemptTransition({ ...base, from: "closed", to: "repair" });
    if (!r.allowed) expect(r.refusal).toContain("terminal");
  });

  it("requires evidence on a mechanic release", () => {
    const without = attemptTransition({
      ...base,
      from: "test",
      to: "mechanic_release",
    });
    const with_ = attemptTransition({
      ...base,
      from: "test",
      to: "mechanic_release",
      evidenceRef: "WO-2294",
    });
    expect(without.allowed).toBe(false);
    expect(with_.allowed).toBe(true);
  });

  it("will not let AI satisfy an evidence gate, even with a reference", () => {
    const r = attemptTransition({
      ...base,
      actorSource: "ai",
      from: "test",
      to: "mechanic_release",
      evidenceRef: "WO-2294",
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.refusal).toContain("requires a person");
  });

  it("lets AI advance a step that needs no evidence", () => {
    expect(
      attemptTransition({
        ...base,
        actorSource: "ai",
        from: "reported",
        to: "inspection",
      }).allowed
    ).toBe(true);
  });

  it("allows a failed test to send the job back to repair", () => {
    expect(
      attemptTransition({ ...base, from: "test", to: "repair" }).allowed
    ).toBe(true);
  });

  it("allows a re-evaluated assignment to fall back to at risk", () => {
    expect(
      attemptTransition({
        workflowKey: "assignment_at_risk",
        actorRole: "dispatcher",
        actorSource: "system",
        from: "predeparture_reevaluation",
        to: "at_risk",
      }).allowed
    ).toBe(true);
  });

  it("rejects an unknown workflow or state rather than guessing", () => {
    expect(
      attemptTransition({ ...base, workflowKey: "nope", from: "a", to: "b" })
        .allowed
    ).toBe(false);
    expect(
      attemptTransition({ ...base, from: "invented", to: "closed" }).allowed
    ).toBe(false);
  });
});

describe("currentEscalation", () => {
  const created = NOW;
  const later = (m: number) => new Date(created.getTime() + m * 60_000);

  it("returns nothing before the first step is due", () => {
    expect(
      currentEscalation("upload_disposal_ticket", created, later(30))
    ).toBeNull();
  });

  it("returns exactly one step, not every step passed", () => {
    const s = currentEscalation("upload_disposal_ticket", created, later(600));
    expect(s?.assignedRole).toBe("office");
  });

  it("reaches the supervisor after a day", () => {
    expect(
      currentEscalation("upload_disposal_ticket", created, later(1500))
        ?.priority
    ).toBe("critical");
  });

  it("returns null for a task type with no policy", () => {
    expect(
      currentEscalation("review_assignments", created, later(9999))
    ).toBeNull();
  });
});

describe("explainTask — deterministic, no model involved", () => {
  it("states the cause, the consequences and the rule", () => {
    const text = explainTask({
      task: {
        title: "Renew VAC-12 annual inspection",
        sourceRuleKey: "fleet.inspection.expired",
        sourceRuleVersion: 1,
        createdAt: NOW,
        subjectType: "unit",
        subjectId: "VAC-12",
      },
      triggeringEvent: {
        type: "unit.inspection_expired",
        occurredAt: NOW,
        subject: { entityType: "unit", entityId: "VAC-12" },
      },
      consequences: [
        "Unit dispatch status → blocked",
        "JOB-8851 assignment → at risk",
      ],
      evidenceRef: "INS-2025-2291",
    });
    expect(text).toContain("unit VAC-12 raised unit.inspection_expired");
    expect(text).toContain("JOB-8851 assignment → at risk");
    expect(text).toContain("fleet.inspection.expired.v1");
    expect(text).toContain("INS-2025-2291");
  });

  it("is identical on repeated calls with the same inputs", () => {
    const input = {
      task: {
        title: "t",
        sourceRuleKey: "r",
        sourceRuleVersion: 2,
        createdAt: NOW,
        subjectType: "unit",
        subjectId: "U",
      },
      triggeringEvent: {
        type: "e",
        occurredAt: NOW,
        subject: { entityType: "unit", entityId: "U" },
      },
      consequences: [],
    };
    expect(explainTask(input)).toBe(explainTask(input));
  });
});

describe("groupByRootCause", () => {
  it("shows one root problem with its consequences", () => {
    const plan = planTasks(
      event(),
      evaluateRules(event(), [shopRule], NOW),
      [],
      NOW
    );
    const groups = groupByRootCause(plan.create as OperationalTask[]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rootTitle).toContain("critical defect");
    expect(groups[0].consequences).toEqual(["2 assignments at risk"]);
    expect(groups[0].totalTasks).toBe(2);
    expect(groups[0].owner).toBe("mechanic");
  });
});
