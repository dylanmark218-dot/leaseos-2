/**
 * A standing tripwire: nothing on the task-creation path binds `undefined`.
 *
 * mysql2 refuses the value outright — `TypeError: Bind parameters must not
 * contain undefined. To pass SQL NULL specify JS null` — so an `undefined` in a
 * parameter array is not a NULL, it is a thrown error inside whatever
 * transaction was open.
 *
 * It passes today, and it passed before the `?? null` calls were added to the
 * insert, because `planTasks` already normalises every optional field to `null`
 * at construction (`workflowEngine.ts`). That is worth stating plainly rather
 * than leaving the test looking like it caught something: the invariant holds
 * because of the producer, and this asserts it at the consumer.
 *
 * Which is the reason to install it while it is vacuous. The guarantee lives in
 * two files that do not reference each other, and the ways to break it are all
 * ordinary — a new `create_task` action whose optional field the planner does
 * not normalise, a second writer to `operationalTasks` that binds a task object
 * directly, a planner refactor that returns `undefined` for an absent column
 * because the type permits it. None of those look wrong in review, and the first
 * thing that would object is the driver, at runtime, in a worker.
 *
 * The compiler is the primary guard: `SqlParam` excludes `undefined`, so a call
 * site that binds `T | undefined` fails `tsc`. This covers what a type cannot —
 * a value that is `unknown` at the boundary, or narrowed with a cast.
 */
import { describe, expect, it } from "vitest";
import { applyEventConsequences } from "./workflowRuntime";
import type { SqlRunner } from "./workflowRuntime";
import type { DomainEvent, WorkflowRule } from "./workflowEngine";

/** mysql2's own rule, in the shape a test can see. */
function rejectUnbindable(sql: string, params?: unknown[]) {
  if (!params) return;
  params.forEach((value, index) => {
    if (value === undefined) {
      throw new TypeError(
        `Bind parameters must not contain undefined (index ${index} of: ${sql.trim().split("\n")[0]})`
      );
    }
    if (typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(`Bind parameter ${index} is not a bindable value`);
    }
  });
}

function recordingRunner() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const runner = {
    execute: async <T = unknown>(sql: string, params?: readonly unknown[]) => {
      rejectUnbindable(sql, params as unknown[] | undefined);
      calls.push({ sql, params: (params ?? []) as unknown[] });
      // Every SELECT on this path asks for open tasks; none exist.
      return [[] as unknown as T, undefined] as [T, unknown];
    },
  } as SqlRunner;
  return { runner, calls };
}

/** A rule whose action fills nothing optional, and an event that links nothing. */
const MINIMAL_RULE: WorkflowRule = {
  ruleKey: "test.minimal",
  version: 1,
  name: "Minimal task, no optional fields",
  eventType: "test.happened",
  enabled: true,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  tenantId: null,
  branchId: null,
  conditions: [],
  dedupeOn: ["subject.entityId"],
  actions: [
    {
      kind: "create_task",
      taskType: "review_affected_assignments",
      title: "A task carrying no optional field",
      assignedRole: "office",
      priority: "normal",
    },
  ],
} as WorkflowRule;

const MINIMAL_EVENT: DomainEvent = {
  id: "evt-minimal-1",
  type: "test.happened",
  version: 1,
  occurredAt: new Date("2026-06-01T12:00:00Z"),
  recordedAt: new Date("2026-06-01T12:00:00Z"),
  tenantId: "T1",
  actor: { source: "system" },
  subject: { entityType: "unit", entityId: "U-1" },
  payload: {},
};

const AT = new Date("2026-06-01T12:00:00Z");

describe("workflow runtime bind parameters", () => {
  it("creates a task with no optional field set, binding no undefined", async () => {
    const { runner, calls } = recordingRunner();

    await expect(
      applyEventConsequences(runner, MINIMAL_EVENT, [MINIMAL_RULE], AT)
    ).resolves.toBeDefined();

    const insert = calls.find(c => /INSERT INTO operationalTasks/i.test(c.sql));
    expect(insert, "the task insert should have been attempted").toBeDefined();
    expect(
      insert!.params.filter(p => p === undefined),
      "an absent optional column must be bound as null, never as undefined"
    ).toEqual([]);
  });

  it("binds every absent optional column as null rather than omitting it", async () => {
    const { runner, calls } = recordingRunner();
    await applyEventConsequences(runner, MINIMAL_EVENT, [MINIMAL_RULE], AT);

    const insert = calls.find(c => /INSERT INTO operationalTasks/i.test(c.sql))!;
    // 21 placeholders, so 21 parameters: a column bound short would shift every
    // later value one column left and the insert would still succeed.
    expect(insert.params).toHaveLength(21);
    // description, branchId, jobId, tripId, unitId, rootDedupeKey, dueAt.
    expect(insert.params.filter(p => p === null)).toHaveLength(7);
  });

  it("the detector rejects what mysql2 rejects", () => {
    // A tripwire that cannot trip proves nothing, so it is exercised directly.
    expect(() => rejectUnbindable("SELECT ?", [undefined])).toThrow(
      /must not contain undefined/
    );
    expect(() => rejectUnbindable("SELECT ?", [() => 1])).toThrow(
      /not a bindable value/
    );
    expect(() => rejectUnbindable("SELECT ?", [null])).not.toThrow();
    expect(() => rejectUnbindable("SELECT ?", [0])).not.toThrow();
  });
});
