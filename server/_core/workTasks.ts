/**
 * 0170 — the task board's state machine.
 *
 * Pure. No network, no database.
 *
 * One vocabulary for two kinds of task, and the kind decides which moves are legal. A personal
 * task is a person's own list — inbox, to do, in progress, waiting, done — and nobody but its
 * owner touches it. A company task is work the company handed somebody: it is assigned, accepted,
 * started, possibly blocked, submitted and verified by a second person. Modelling those as two
 * state machines would have been two copies of "start" and "cancel" that drift; modelling them as
 * one enum with a table of legal moves per kind is what `operationalTasks` did not have and what
 * the roadside-panel and time-off engines already do for their own vocabularies.
 *
 * Three rules the table enforces that a form cannot:
 *
 *   **The verifier is not the assignee.** The same separation the mechanic's release and the
 *   Academy certificate carry. A person does not verify their own work.
 *
 *   **Regulated work does not clear because somebody pressed Done.** A task that requires
 *   completion evidence cannot be completed by its assignee; it is submitted with the evidence
 *   reference and a verifier closes it. That is `operationalTasks.requiresEvidence` kept honest.
 *
 *   **A blocked dependency is a refusal, not a warning.** Starting a task whose predecessor is
 *   open is refused with the predecessor named, because "you can start it anyway" is how the
 *   dependency becomes decoration.
 */

export type TaskKind = "personal" | "company";
export type TaskStatus = "inbox" | "todo" | "in_progress" | "waiting" | "blocked" | "submitted" | "verified" | "completed" | "cancelled";
export type AssignmentState = "unassigned" | "assigned" | "accepted" | "declined";
export type TaskPriority = "low" | "normal" | "high" | "critical";

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["verified", "completed", "cancelled"];
export const isTerminal = (s: TaskStatus) => TERMINAL_STATUSES.includes(s);

/** What the machine needs to know about a task. A row satisfies this; so does a test fixture. */
export type TaskShape = {
  taskRef: string;
  kind: TaskKind;
  status: TaskStatus;
  assignmentState: AssignmentState;
  createdByUserId: number;
  assigneeUserId: number | null;
  requiresCompletionEvidence: boolean;
  completionEvidenceRef: string | null;
  dueAt: Date | null;
};

export type TaskActor = {
  userId: number;
  /** Holds the permission to verify company work (work.verify). */
  mayVerify: boolean;
  /** Holds the permission to assign company work (work.assign). */
  mayAssign: boolean;
};

export type TaskAction =
  | "plan"      // inbox → todo
  | "accept" | "decline"
  | "start" | "wait" | "resume"
  | "block" | "unblock"
  | "submit" | "verify" | "return"
  | "complete" | "cancel" | "reopen";

export const TASK_ACTIONS: readonly TaskAction[] = ["plan", "accept", "decline", "start", "wait", "resume", "block", "unblock", "submit", "verify", "return", "complete", "cancel", "reopen"];

export type TransitionContext = {
  actor: TaskActor;
  now: Date;
  /** Checklist items not yet done. */
  checklistOpen: number;
  /** Predecessors not yet completed or verified, by reference. */
  dependenciesOpen: readonly string[];
  reason?: string | null;
  evidenceRef?: string | null;
};

export type TaskChanges = {
  status: TaskStatus;
  assignmentState: AssignmentState;
  acceptedAt?: Date | null;
  submittedAt?: Date | null;
  completedAt?: Date | null;
  completedByUserId?: number | null;
  verifiedAt?: Date | null;
  verifiedByUserId?: number | null;
  cancelledAt?: Date | null;
  cancelledByUserId?: number | null;
  blockedReason?: string | null;
  completionEvidenceRef?: string | null;
};

export type TransitionOutcome =
  | { ok: true; changes: TaskChanges; auditAction: string }
  | { ok: false; reason: string };

const isOwner = (t: TaskShape, userId: number) => t.createdByUserId === userId || t.assigneeUserId === userId;
const isAssignee = (t: TaskShape, userId: number) => t.assigneeUserId === userId;
const refuse = (reason: string): TransitionOutcome => ({ ok: false, reason });
const move = (t: TaskShape, status: TaskStatus, auditAction: string, extra: Partial<TaskChanges> = {}): TransitionOutcome =>
  ({ ok: true, changes: { status, assignmentState: t.assignmentState, ...extra }, auditAction });

/**
 * Apply one action to one task for one actor.
 *
 * Refusals name what is missing — the open predecessor, the unticked checklist, the evidence —
 * because "not allowed" is a sentence nobody can act on.
 */
export function transitionTask(task: TaskShape, action: TaskAction, ctx: TransitionContext): TransitionOutcome {
  const { actor, now } = ctx;
  if (isTerminal(task.status) && action !== "reopen") return refuse(`Task ${task.taskRef} is ${task.status}; only reopen applies`);
  return task.kind === "personal" ? personal(task, action, ctx) : company(task, action, ctx, actor, now);
}

function personal(task: TaskShape, action: TaskAction, ctx: TransitionContext): TransitionOutcome {
  const { actor, now } = ctx;
  if (!isOwner(task, actor.userId)) return refuse("A personal task is its owner's; nobody else moves it");
  const from = task.status;
  switch (action) {
    case "plan": return from === "inbox" ? move(task, "todo", "planned") : refuse(`plan applies to an inbox task, not one that is ${from}`);
    case "start": return (from === "inbox" || from === "todo" || from === "waiting") ? move(task, "in_progress", "started") : refuse(`start does not apply to a task that is ${from}`);
    case "wait": return from === "in_progress" ? move(task, "waiting", "waiting") : refuse("wait applies to a task in progress");
    case "resume": return from === "waiting" ? move(task, "in_progress", "resumed") : refuse("resume applies to a waiting task");
    case "complete": return (from === "inbox" || from === "todo" || from === "in_progress" || from === "waiting")
      ? move(task, "completed", "completed", { completedAt: now, completedByUserId: actor.userId })
      : refuse(`complete does not apply to a task that is ${from}`);
    case "cancel": return move(task, "cancelled", "cancelled", { cancelledAt: now, cancelledByUserId: actor.userId });
    case "reopen": return from === "completed" || from === "cancelled"
      ? move(task, "todo", "reopened", { completedAt: null, completedByUserId: null, cancelledAt: null, cancelledByUserId: null })
      : refuse("reopen applies to a completed or cancelled task");
    default: return refuse(`${action} is a company-task action; a personal task has no ${action}`);
  }
}

function company(task: TaskShape, action: TaskAction, ctx: TransitionContext, actor: TaskActor, now: Date): TransitionOutcome {
  const from = task.status;
  const assignee = isAssignee(task, actor.userId);
  const creator = task.createdByUserId === actor.userId;
  switch (action) {
    case "plan":
      if (from !== "inbox") return refuse(`plan applies to an inbox task, not one that is ${from}`);
      if (!creator && !actor.mayAssign) return refuse("Planning company work needs the assign permission or the creator");
      return move(task, "todo", "planned", { assignmentState: task.assigneeUserId ? "assigned" : "unassigned" });
    case "accept":
      if (!assignee) return refuse("Only the assignee accepts an assignment");
      if (task.assignmentState !== "assigned") return refuse(`This assignment is ${task.assignmentState}, not awaiting acceptance`);
      return move(task, from === "inbox" ? "todo" : from, "accepted", { assignmentState: "accepted", acceptedAt: now });
    case "decline":
      if (!assignee) return refuse("Only the assignee declines an assignment");
      if (task.assignmentState !== "assigned") return refuse(`This assignment is ${task.assignmentState}, not awaiting a decision`);
      return move(task, "todo", "declined", { assignmentState: "declined", blockedReason: ctx.reason ?? null });
    case "start": {
      if (!assignee) return refuse("Only the assignee starts company work");
      if (task.assignmentState !== "accepted") return refuse("Accept the assignment before starting it; acceptance is what makes it yours");
      if (!(from === "todo" || from === "waiting" || from === "blocked")) return refuse(`start does not apply to a task that is ${from}`);
      if (ctx.dependenciesOpen.length) return refuse(`Blocked by open predecessor(s): ${ctx.dependenciesOpen.join(", ")}`);
      return move(task, "in_progress", "started", { blockedReason: null });
    }
    case "wait":
      if (!assignee) return refuse("Only the assignee marks work as waiting");
      return from === "in_progress" ? move(task, "waiting", "waiting") : refuse("wait applies to a task in progress");
    case "resume":
      if (!assignee) return refuse("Only the assignee resumes work");
      return from === "waiting" ? move(task, "in_progress", "resumed") : refuse("resume applies to a waiting task");
    case "block":
      if (!assignee && !creator && !actor.mayAssign) return refuse("Blocking needs the assignee, the creator or the assign permission");
      if (!(from === "todo" || from === "in_progress" || from === "waiting")) return refuse(`block does not apply to a task that is ${from}`);
      if (!ctx.reason?.trim()) return refuse("A blocked task says what blocks it");
      return move(task, "blocked", "blocked", { blockedReason: ctx.reason.trim() });
    case "unblock":
      if (!assignee && !creator && !actor.mayAssign) return refuse("Unblocking needs the assignee, the creator or the assign permission");
      return from === "blocked" ? move(task, "todo", "unblocked", { blockedReason: null }) : refuse("unblock applies to a blocked task");
    case "submit": {
      if (!assignee) return refuse("Only the assignee submits work");
      if (from !== "in_progress") return refuse(`submit applies to work in progress, not ${from}`);
      if (ctx.checklistOpen > 0) return refuse(`${ctx.checklistOpen} checklist item(s) are not done`);
      const evidence = ctx.evidenceRef ?? task.completionEvidenceRef;
      if (task.requiresCompletionEvidence && !evidence) return refuse("This work requires completion evidence; attach it before submitting");
      return move(task, "submitted", "submitted", { submittedAt: now, completionEvidenceRef: evidence ?? null });
    }
    case "verify":
      if (!actor.mayVerify) return refuse("Verifying needs the verify permission");
      if (assignee) return refuse("The person who did the work does not verify it");
      if (from !== "submitted") return refuse(`verify applies to submitted work, not ${from}`);
      return move(task, "verified", "verified", { verifiedAt: now, verifiedByUserId: actor.userId });
    case "return":
      if (!actor.mayVerify) return refuse("Returning work needs the verify permission");
      if (from !== "submitted") return refuse("return applies to submitted work");
      if (!ctx.reason?.trim()) return refuse("Returned work says what was wrong with it");
      return move(task, "in_progress", "returned", { submittedAt: null, blockedReason: ctx.reason.trim() });
    case "complete": {
      if (!assignee && !creator) return refuse("Only the assignee or the creator completes company work");
      if (assignee && !creator && task.assignmentState !== "accepted") return refuse("Accept the assignment before completing it; acceptance is what makes it yours");
      if (task.requiresCompletionEvidence) return refuse("This work requires evidence and a verifier; submit it rather than completing it");
      if (!(from === "in_progress" || from === "todo" || from === "waiting")) return refuse(`complete does not apply to a task that is ${from}`);
      if (ctx.checklistOpen > 0) return refuse(`${ctx.checklistOpen} checklist item(s) are not done`);
      if (ctx.dependenciesOpen.length) return refuse(`Blocked by open predecessor(s): ${ctx.dependenciesOpen.join(", ")}`);
      return move(task, "completed", "completed", { completedAt: now, completedByUserId: actor.userId });
    }
    case "cancel":
      if (!creator && !actor.mayAssign) return refuse("Cancelling company work needs the creator or the assign permission");
      return move(task, "cancelled", "cancelled", { cancelledAt: now, cancelledByUserId: actor.userId });
    case "reopen":
      if (!creator && !actor.mayVerify && !actor.mayAssign) return refuse("Reopening company work needs the creator, the verify or the assign permission");
      if (!isTerminal(from)) return refuse("reopen applies to a completed, verified or cancelled task");
      return move(task, "todo", "reopened", { completedAt: null, completedByUserId: null, verifiedAt: null, verifiedByUserId: null, cancelledAt: null, cancelledByUserId: null, submittedAt: null });
  }
}

/** Overdue is a fact about a due date and a clock, never a status. */
export function isOverdue(task: Pick<TaskShape, "status" | "dueAt">, now: Date): boolean {
  return !!task.dueAt && !isTerminal(task.status) && task.dueAt.getTime() < now.getTime();
}

export type TaskViewer = { userId: number; maySchedule: boolean };

/**
 * Who may read a task. A personal task is its owner's. A company task is readable by the people
 * on it and by anybody who schedules others' work.
 */
export function mayViewTask(task: Pick<TaskShape, "kind" | "createdByUserId" | "assigneeUserId">, viewer: TaskViewer): boolean {
  if (task.createdByUserId === viewer.userId || task.assigneeUserId === viewer.userId) return true;
  return task.kind === "company" && viewer.maySchedule;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: "Inbox", todo: "To do", in_progress: "In progress", waiting: "Waiting", blocked: "Blocked",
  submitted: "Submitted", verified: "Verified", completed: "Completed", cancelled: "Cancelled",
};

/** The actions worth offering for this task to this actor — the ones the machine would accept. */
export function availableActions(task: TaskShape, ctx: TransitionContext): TaskAction[] {
  return TASK_ACTIONS.filter(a => transitionTask(task, a, ctx).ok);
}
