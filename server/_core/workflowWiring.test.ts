import { describe, expect, it, vi } from "vitest";
import {
  RULE_SEEDS,
  planSeedSync,
  resolveResponsibility,
} from "./workflowSeeds";
import {
  buildOutboxRow,
  guardCausationDepth,
  isMeaningfulChange,
  traceCausation,
  MAX_CAUSATION_DEPTH,
  emitDomainEvent,
  type EmitInput,
} from "./eventEmitter";
import {
  DEFAULT_WORKER_CONFIG,
  assessQueueHealth,
  backoffMs,
  classifyFailure,
  nextPollDelay,
  startDrainWorker,
  type ClaimedEvent,
} from "./drainWorker";
import { evaluateRules, planTasks, type DomainEvent } from "./workflowEngine";

const NOW = new Date(Date.UTC(2026, 8, 4, 9, 0));

/* ===================== seeds ===================== */

describe("rule seeds", () => {
  it("covers all four reference workflows, with a resolution rule for each", () => {
    const keys = RULE_SEEDS.map(r => r.ruleKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        "fleet.critical_defect.opened",
        "fleet.mechanic_release.verified",
        "billing.disposal_ticket.missing",
        "billing.disposal_ticket.verified",
        "compliance.credential.expiring",
        "compliance.credential.verified",
        "dispatch.assignment.at_risk",
      ])
    );
  });

  it("never sets a domain verdict — only coordinates", () => {
    const kinds = RULE_SEEDS.flatMap(r => r.actions.map(a => a.kind));
    expect(new Set(kinds)).toEqual(
      new Set([
        "create_task",
        "invalidate_eligibility",
        "mark_at_risk",
        "notify",
        "reevaluate",
        "close_workflow",
      ])
    );
  });

  it("dedupes the disposal ticket per load, not per job", () => {
    const rule = RULE_SEEDS.find(
      r => r.ruleKey === "billing.disposal_ticket.missing"
    )!;
    expect(rule.dedupeOn).toEqual(["payload.loadId"]);
  });

  it("names the specific evidence rather than saying the job is incomplete", () => {
    const rule = RULE_SEEDS.find(
      r => r.ruleKey === "billing.disposal_ticket.missing"
    )!;
    const task = rule.actions.find(a => a.kind === "create_task") as {
      title: string;
      description?: string;
    };
    expect(task.title).toContain("disposal ticket");
    expect(task.description).toContain(
      "Other accepted charges may still invoice"
    );
  });

  it("gives every rule an effective date so history stays explainable", () => {
    expect(RULE_SEEDS.every(r => r.effectiveFrom instanceof Date)).toBe(true);
  });
});

describe("critical defect seed, end to end through the engine", () => {
  const event: DomainEvent = {
    id: "EVT-A",
    type: "unit.critical_defect_opened",
    version: 1,
    occurredAt: NOW,
    recordedAt: NOW,
    tenantId: "T1",
    branchId: "GP",
    actor: { source: "human", role: "driver" },
    subject: { entityType: "unit", entityId: "VAC-12" },
    unitId: "VAC-12",
    payload: { severity: "critical", unitId: "VAC-12", defectId: "MD-1" },
  };

  it("creates a mechanic root task and a dispatcher consequence", () => {
    const plan = planTasks(
      event,
      evaluateRules(event, RULE_SEEDS, NOW),
      [],
      NOW
    );
    const root = plan.create.find(t => t.rootDedupeKey === null)!;
    expect(root.assignedRole).toBe("mechanic");
    expect(root.priority).toBe("critical");
    expect(root.requiresEvidence).toBe(true);
    expect(
      plan.create.find(t => t.assignedRole === "dispatcher")?.rootDedupeKey
    ).toBe(root.dedupeKey);
  });

  it("suppresses a duplicate when the same defect is reported again", () => {
    const first = planTasks(
      event,
      evaluateRules(event, RULE_SEEDS, NOW),
      [],
      NOW
    );
    const open = first.create.map(t => ({
      dedupeKey: t.dedupeKey,
      status: t.status,
    }));
    const second = planTasks(
      { ...event, id: "EVT-B" },
      evaluateRules(event, RULE_SEEDS, NOW),
      open,
      NOW
    );
    expect(second.create).toHaveLength(0);
  });

  it("does not fire for an advisory defect", () => {
    const advisory = {
      ...event,
      payload: { ...event.payload, severity: "advisory" },
    };
    expect(evaluateRules(advisory, RULE_SEEDS, NOW)).toHaveLength(0);
  });
});

describe("planSeedSync — released rules are immutable", () => {
  const seed = RULE_SEEDS[0];

  it("inserts a rule that has never been released", () => {
    expect(planSeedSync([seed], []).insert).toHaveLength(1);
  });

  it("reports an unchanged rule rather than rewriting it", () => {
    const plan = planSeedSync(
      [seed],
      [
        {
          ruleKey: seed.ruleKey,
          version: seed.version,
          conditionsJson: JSON.stringify(seed.conditions),
          actionsJson: JSON.stringify(seed.actions),
        },
      ]
    );
    expect(plan.unchanged).toEqual([`${seed.ruleKey}.v1`]);
    expect(plan.insert).toHaveLength(0);
  });

  it("refuses to overwrite a released version whose content changed", () => {
    const plan = planSeedSync(
      [seed],
      [
        {
          ruleKey: seed.ruleKey,
          version: seed.version,
          conditionsJson: JSON.stringify([{ path: "x", op: "eq", value: 1 }]),
          actionsJson: JSON.stringify(seed.actions),
        },
      ]
    );
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].reason).toContain("Publish v2 instead");
  });
});

describe("resolveResponsibility", () => {
  it("falls back to the platform default", () => {
    expect(resolveResponsibility("resolve_critical_defect")?.primaryRole).toBe(
      "mechanic"
    );
  });
  it("prefers a branch override over a tenant one", () => {
    const mappings = [
      { taskType: "renew_credential", primaryRole: "office" },
      {
        taskType: "renew_credential",
        tenantId: "T1",
        primaryRole: "compliance",
      },
      {
        taskType: "renew_credential",
        tenantId: "T1",
        branchId: "GP",
        primaryRole: "branch_admin",
      },
    ];
    expect(
      resolveResponsibility("renew_credential", "T1", "GP", mappings)
        ?.primaryRole
    ).toBe("branch_admin");
    expect(
      resolveResponsibility("renew_credential", "T1", null, mappings)
        ?.primaryRole
    ).toBe("compliance");
  });
  it("returns null for an unmapped task type rather than guessing an owner", () => {
    expect(resolveResponsibility("nonexistent")).toBeNull();
  });
});

/* ===================== emitter ===================== */

const emitInput: EmitInput = {
  type: "unit.critical_defect_opened",
  actor: { source: "human", userId: "u1", role: "driver" },
  subject: { entityType: "unit", entityId: "VAC-12" },
  tenantId: "T1",
  branchId: "GP",
  unitId: "VAC-12",
  payload: { severity: "critical" },
};

describe("buildOutboxRow", () => {
  it("roots a new correlation chain at itself when none is supplied", () => {
    const row = buildOutboxRow(emitInput, NOW);
    expect(row.correlationId).toBe(row.eventId);
    expect(row.causationId).toBeNull();
  });

  it("carries an existing correlation and causation forward", () => {
    const row = buildOutboxRow(
      { ...emitInput, correlationId: "CORR-1", causationId: "EVT-PARENT" },
      NOW
    );
    expect(row.correlationId).toBe("CORR-1");
    expect(row.causationId).toBe("EVT-PARENT");
  });

  it("generates unique ids for events emitted in the same millisecond", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => buildOutboxRow(emitInput, NOW).eventId)
    );
    expect(ids.size).toBe(50);
  });

  it("serialises the payload rather than storing an object", () => {
    expect(JSON.parse(buildOutboxRow(emitInput, NOW).payloadJson)).toEqual({
      severity: "critical",
    });
  });
});

describe("emitDomainEvent", () => {
  it("writes through the caller's transaction, never its own", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const row = await emitDomainEvent({ execute }, emitInput, NOW);
    expect(execute).toHaveBeenCalledOnce();
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO domainEventOutbox");
    expect(params[0]).toBe(row.eventId);
  });

  it("propagates a failure so the whole transaction rolls back", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("deadlock"));
    await expect(emitDomainEvent({ execute }, emitInput, NOW)).rejects.toThrow(
      "deadlock"
    );
  });
});

describe("loop protection", () => {
  it("emits only when a significant field actually changed", () => {
    const change = {
      previous: { status: "open", note: "a" },
      next: { status: "open", note: "b" },
    };
    expect(isMeaningfulChange(change, ["status"])).toBe(false);
    expect(isMeaningfulChange(change, ["status", "note"])).toBe(true);
  });

  it("detects a re-evaluation that changed nothing", () => {
    const same = {
      previous: { verdict: "eligible_review" },
      next: { verdict: "eligible_review" },
    };
    expect(isMeaningfulChange(same, ["verdict"])).toBe(false);
  });

  it("traces a causation chain back to its root", () => {
    const chain = [
      { eventId: "E3", causationId: "E2" },
      { eventId: "E2", causationId: "E1" },
      { eventId: "E1", causationId: null },
    ];
    const t = traceCausation("E3", chain);
    expect(t.path).toEqual(["E3", "E2", "E1"]);
    expect(t.runaway).toBe(false);
  });

  it("reports a cycle rather than looping forever", () => {
    const chain = [
      { eventId: "E1", causationId: "E2" },
      { eventId: "E2", causationId: "E1" },
    ];
    expect(traceCausation("E1", chain).runaway).toBe(true);
  });

  it("stops following an over-long chain", () => {
    const chain = Array.from({ length: 40 }, (_, i) => ({
      eventId: `E${i}`,
      causationId: i < 39 ? `E${i + 1}` : null,
    }));
    const t = traceCausation("E0", chain);
    expect(t.runaway).toBe(true);
    expect(t.path.length).toBe(MAX_CAUSATION_DEPTH);
  });

  it("refuses to emit past the depth limit", () => {
    expect(guardCausationDepth(3).allowed).toBe(true);
    const blocked = guardCausationDepth(MAX_CAUSATION_DEPTH);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("refusing to emit");
  });
});

/* ===================== worker ===================== */

describe("backoff", () => {
  it("grows exponentially and stays under the cap", () => {
    const cfg = { backoffBaseMs: 1000, backoffMaxMs: 30_000 };
    expect(backoffMs(1, cfg, () => 1)).toBe(1000);
    expect(backoffMs(2, cfg, () => 1)).toBe(2000);
    expect(backoffMs(4, cfg, () => 1)).toBe(8000);
    expect(backoffMs(20, cfg, () => 1)).toBe(30_000);
  });

  it("applies jitter so failing workers do not retry in lockstep", () => {
    const cfg = { backoffBaseMs: 1000, backoffMaxMs: 30_000 };
    expect(backoffMs(3, cfg, () => 0)).toBe(0);
    expect(backoffMs(3, cfg, () => 0.5)).toBe(2000);
  });
});

describe("classifyFailure", () => {
  it("retries below the attempt limit", () => {
    const o = classifyFailure(2, DEFAULT_WORKER_CONFIG, "timeout");
    expect(o.status).toBe("failed");
    expect(o.retryAfterMs).not.toBeNull();
  });

  it("dead-letters at the limit and says a person is needed", () => {
    const o = classifyFailure(5, DEFAULT_WORKER_CONFIG, "bad payload");
    expect(o.status).toBe("dead_letter");
    expect(o.retryAfterMs).toBeNull();
    expect(o.reason).toContain("Requires an administrator");
  });
});

describe("nextPollDelay", () => {
  it("waits longer after an empty poll than a productive one", () => {
    expect(nextPollDelay(0, DEFAULT_WORKER_CONFIG)).toBe(
      DEFAULT_WORKER_CONFIG.idleIntervalMs
    );
    expect(nextPollDelay(3, DEFAULT_WORKER_CONFIG)).toBe(
      DEFAULT_WORKER_CONFIG.pollIntervalMs
    );
  });
});

describe("startDrainWorker", () => {
  const evt = (id: number, attempts = 0): ClaimedEvent => ({
    id,
    eventId: `EVT-${id}`,
    eventType: "unit.critical_defect_opened",
    aggregateType: "unit",
    aggregateId: "VAC-12",
    tenantId: "T1",
    branchId: null,
    payloadJson: "{}",
    attemptCount: attempts,
    occurredAt: NOW,
  });

  it("processes a batch and marks each event done", async () => {
    const processed: number[] = [];
    let served = false;
    const w = startDrainWorker(
      {
        claimBatch: async () =>
          served ? [] : ((served = true), [evt(1), evt(2)]),
        processEvent: async () => ({ tasksCreated: 1 }),
        markProcessed: async id => {
          processed.push(id);
        },
        markFailed: async () => {},
      },
      { pollIntervalMs: 1, idleIntervalMs: 1 }
    );

    await new Promise(r => setTimeout(r, 40));
    w.stop();
    await w.done;

    expect(processed).toEqual([1, 2]);
    expect(w.stats().processed).toBe(2);
    expect(w.stats().tasksCreated).toBe(2);
  });

  it("retries a failing event without dead-lettering it early", async () => {
    let served = false;
    const outcomes: string[] = [];
    const w = startDrainWorker(
      {
        claimBatch: async () => (served ? [] : ((served = true), [evt(1, 1)])),
        processEvent: async () => {
          throw new Error("transient");
        },
        markProcessed: async () => {},
        markFailed: async (_id, o) => {
          outcomes.push(o.status);
        },
      },
      { pollIntervalMs: 1, idleIntervalMs: 1 }
    );

    await new Promise(r => setTimeout(r, 40));
    w.stop();
    await w.done;

    expect(outcomes).toEqual(["failed"]);
    expect(w.stats().deadLettered).toBe(0);
  });

  it("dead-letters an event that has exhausted its attempts, and logs it", async () => {
    let served = false;
    const logs: string[] = [];
    const w = startDrainWorker(
      {
        claimBatch: async () => (served ? [] : ((served = true), [evt(1, 4)])),
        processEvent: async () => {
          throw new Error("poison");
        },
        markProcessed: async () => {},
        markFailed: async () => {},
        log: (level, msg) => {
          logs.push(`${level}:${msg}`);
        },
      },
      { pollIntervalMs: 1, idleIntervalMs: 1 }
    );

    await new Promise(r => setTimeout(r, 40));
    w.stop();
    await w.done;

    expect(w.stats().deadLettered).toBe(1);
    expect(logs.some(l => l.startsWith("error:Event dead-lettered"))).toBe(
      true
    );
  });

  it("keeps running when a claim fails, rather than dying", async () => {
    let calls = 0;
    const w = startDrainWorker(
      {
        claimBatch: async () => {
          calls++;
          throw new Error("connection lost");
        },
        processEvent: async () => ({ tasksCreated: 0 }),
        markProcessed: async () => {},
        markFailed: async () => {},
      },
      { pollIntervalMs: 1, idleIntervalMs: 1 }
    );

    await new Promise(r => setTimeout(r, 40));
    w.stop();
    await w.done;
    expect(calls).toBeGreaterThan(1);
  });

  it("stops gracefully, finishing rather than abandoning work", async () => {
    const w = startDrainWorker(
      {
        claimBatch: async () => [],
        processEvent: async () => ({ tasksCreated: 0 }),
        markProcessed: async () => {},
        markFailed: async () => {},
      },
      { pollIntervalMs: 1, idleIntervalMs: 1 }
    );

    w.stop();
    const stats = await w.done;
    expect(stats.polls).toBeGreaterThanOrEqual(1);
  });
});

describe("assessQueueHealth", () => {
  const counts = { pending: 0, processing: 0, failed: 0, deadLetter: 0 };

  it("is healthy when current", () => {
    expect(assessQueueHealth(counts, 5).state).toBe("healthy");
  });

  it("is lagging when the oldest event is stale", () => {
    const h = assessQueueHealth({ ...counts, pending: 40 }, 400);
    expect(h.state).toBe("lagging");
    expect(h.message).toContain("the worker is behind");
  });

  it("is degraded whenever anything is dead-lettered, however fast the queue", () => {
    const h = assessQueueHealth({ ...counts, deadLetter: 2 }, 1);
    expect(h.state).toBe("degraded");
    expect(h.message).toContain("need an administrator");
  });
});
