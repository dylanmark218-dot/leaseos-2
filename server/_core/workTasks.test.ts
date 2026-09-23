/**
 * 0170 — the task board's state machine: one vocabulary, two kinds, and the moves each refuses.
 */
import { describe, expect, it } from "vitest";
import { availableActions, isOverdue, mayViewTask, transitionTask, type TaskShape, type TransitionContext } from "./workTasks";

const NOW = new Date("2027-04-10T15:00:00Z");
const task = (over: Partial<TaskShape> = {}): TaskShape => ({
  taskRef: "TSK-1", kind: "personal", status: "inbox", assignmentState: "unassigned", createdByUserId: 7, assigneeUserId: 7,
  requiresCompletionEvidence: false, completionEvidenceRef: null, dueAt: null, ...over,
});
const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  actor: { userId: 7, mayVerify: false, mayAssign: false }, now: NOW, checklistOpen: 0, dependenciesOpen: [], ...over,
});

describe("a personal task", () => {
  it("walks inbox → todo → in progress → waiting → in progress → completed", () => {
    let t = task();
    for (const [action, status] of [["plan", "todo"], ["start", "in_progress"], ["wait", "waiting"], ["resume", "in_progress"], ["complete", "completed"]] as const) {
      const r = transitionTask(t, action, ctx());
      expect(r.ok, action).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      expect(r.changes.status).toBe(status);
      t = { ...t, status: r.changes.status };
    }
    expect(t.status).toBe("completed");
  });

  it("is nobody else's to move, whatever they hold", () => {
    const r = transitionTask(task(), "start", ctx({ actor: { userId: 99, mayVerify: true, mayAssign: true } }));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/its owner's/) });
  });

  it("has no submit, verify or accept", () => {
    for (const a of ["submit", "verify", "accept", "block"] as const) {
      expect(transitionTask(task({ status: "in_progress" }), a, ctx()).ok, a).toBe(false);
    }
  });

  it("reopens a completed task to todo and clears the completion", () => {
    const r = transitionTask(task({ status: "completed" }), "reopen", ctx());
    expect(r.ok && r.changes.status).toBe("todo");
    expect(r.ok && r.changes.completedAt).toBeNull();
  });
});

describe("a company task", () => {
  const company = (over: Partial<TaskShape> = {}) => task({ kind: "company", status: "todo", assignmentState: "assigned", createdByUserId: 1, assigneeUserId: 7, ...over });
  const assignee = ctx();
  const creator = ctx({ actor: { userId: 1, mayVerify: false, mayAssign: true } });
  const verifier = ctx({ actor: { userId: 50, mayVerify: true, mayAssign: false } });

  it("cannot be started until the assignee accepts it", () => {
    const r = transitionTask(company(), "start", assignee);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Accept the assignment/) });
    const accepted = transitionTask(company(), "accept", assignee);
    expect(accepted.ok && accepted.changes.assignmentState).toBe("accepted");
  });

  it("only the assignee accepts or declines", () => {
    expect(transitionTask(company(), "accept", creator).ok).toBe(false);
    expect(transitionTask(company(), "decline", verifier).ok).toBe(false);
  });

  it("refuses to start while a predecessor is open, and names it", () => {
    const r = transitionTask(company({ assignmentState: "accepted" }), "start", ctx({ dependenciesOpen: ["TSK-0"] }));
    expect(r).toMatchObject({ ok: false, reason: "Blocked by open predecessor(s): TSK-0" });
    expect(transitionTask(company({ assignmentState: "accepted" }), "start", assignee).ok).toBe(true);
  });

  it("a blocked task says why, and unblocks to todo", () => {
    expect(transitionTask(company({ status: "in_progress", assignmentState: "accepted" }), "block", assignee).ok).toBe(false);
    const b = transitionTask(company({ status: "in_progress", assignmentState: "accepted" }), "block", ctx({ reason: "waiting on parts" }));
    expect(b.ok && b.changes).toMatchObject({ status: "blocked", blockedReason: "waiting on parts" });
    const u = transitionTask(company({ status: "blocked", assignmentState: "accepted" }), "unblock", creator);
    expect(u.ok && u.changes).toMatchObject({ status: "todo", blockedReason: null });
  });

  it("regulated work is submitted with evidence and verified by somebody else", () => {
    const t = company({ status: "in_progress", assignmentState: "accepted", requiresCompletionEvidence: true });
    expect(transitionTask(t, "complete", assignee)).toMatchObject({ ok: false, reason: expect.stringMatching(/requires evidence and a verifier/) });
    expect(transitionTask(t, "submit", assignee)).toMatchObject({ ok: false, reason: expect.stringMatching(/requires completion evidence/) });
    expect(transitionTask(t, "submit", ctx({ checklistOpen: 2, evidenceRef: "EV-1" }))).toMatchObject({ ok: false, reason: "2 checklist item(s) are not done" });
    const s = transitionTask(t, "submit", ctx({ evidenceRef: "EV-1" }));
    expect(s.ok && s.changes).toMatchObject({ status: "submitted", completionEvidenceRef: "EV-1" });
    const submitted = { ...t, status: "submitted" as const, completionEvidenceRef: "EV-1" };
    // The assignee holding the verify permission still does not verify their own work.
    expect(transitionTask(submitted, "verify", ctx({ actor: { userId: 7, mayVerify: true, mayAssign: false } }))).toMatchObject({ ok: false, reason: "The person who did the work does not verify it" });
    expect(transitionTask(submitted, "verify", creator)).toMatchObject({ ok: false, reason: expect.stringMatching(/verify permission/) });
    const v = transitionTask(submitted, "verify", verifier);
    expect(v.ok && v.changes).toMatchObject({ status: "verified", verifiedByUserId: 50 });
    const back = transitionTask(submitted, "return", ctx({ actor: verifier.actor, reason: "photo is of the wrong unit" }));
    expect(back.ok && back.changes).toMatchObject({ status: "in_progress", blockedReason: "photo is of the wrong unit" });
  });

  it("ordinary company work may be completed by its assignee without a verifier", () => {
    const r = transitionTask(company({ status: "in_progress", assignmentState: "accepted" }), "complete", assignee);
    expect(r.ok && r.changes).toMatchObject({ status: "completed", completedByUserId: 7 });
  });

  it("cancelling needs the creator or the assign permission; a terminal task only reopens", () => {
    expect(transitionTask(company(), "cancel", assignee).ok).toBe(false);
    expect(transitionTask(company(), "cancel", creator).ok).toBe(true);
    expect(transitionTask(company({ status: "verified" }), "start", assignee)).toMatchObject({ ok: false, reason: expect.stringMatching(/only reopen applies/) });
    expect(transitionTask(company({ status: "verified" }), "reopen", assignee).ok).toBe(false);
    expect(transitionTask(company({ status: "verified" }), "reopen", verifier).ok).toBe(true);
  });

  it("offers only the moves it would accept", () => {
    expect(availableActions(company(), assignee)).toEqual(["accept", "decline"]);
    expect(availableActions(company({ assignmentState: "accepted" }), assignee)).toEqual(["start", "complete"]);
  });
});

describe("overdue and who may look", () => {
  it("overdue is a due date behind the clock on a task that is not done", () => {
    expect(isOverdue({ status: "todo", dueAt: new Date("2027-04-10T14:00:00Z") }, NOW)).toBe(true);
    expect(isOverdue({ status: "completed", dueAt: new Date("2027-04-10T14:00:00Z") }, NOW)).toBe(false);
    expect(isOverdue({ status: "todo", dueAt: null }, NOW)).toBe(false);
  });

  it("a personal task is invisible to a scheduler; a company task is not", () => {
    expect(mayViewTask({ kind: "personal", createdByUserId: 7, assigneeUserId: 7 }, { userId: 3, maySchedule: true })).toBe(false);
    expect(mayViewTask({ kind: "company", createdByUserId: 1, assigneeUserId: 7 }, { userId: 3, maySchedule: true })).toBe(true);
    expect(mayViewTask({ kind: "company", createdByUserId: 1, assigneeUserId: 7 }, { userId: 3, maySchedule: false })).toBe(false);
  });
});
