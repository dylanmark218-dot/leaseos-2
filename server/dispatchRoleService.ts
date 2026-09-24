/**
 * The canonical dispatch slot subsystem — creating postings and roles, and reading them.
 *
 * Until this existed, `dispatchRoles` had no production INSERT anywhere in the tree: the slot model
 * was complete in schema and in pure logic and could only be populated by a test fixture. Every
 * function here is a door into a model that was already designed and already unreachable.
 *
 * The one rule that governs the whole file: **creating and reading slots is planning, never
 * awarding.** Nothing here writes `resourceBookings`, `dispatchAuditEvents`,
 * `dispatchEligibilityChecks.usedForAward`, `dispatchBids` or `dispatchInvitations`. Those are the
 * award's durable evidence and they stay the award's alone.
 */

import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb, jobInScope, operatorInScope, unitInScope } from "./db";
import { SINGLE_TENANT_ID, resolveActingScope } from "./_core/actingScope";
import {
  dispatchPostings, dispatchRoleAssignmentEvents, dispatchRoles, dispatchRoleTypes,
} from "../drizzle/schema";
import { resolveRoleType, requirementDefaultsOf, type RoleType } from "./_core/dispatchRoleCatalog";
import { assessStaffing, canTransitionPosting } from "./_core/dispatchLifecycle";
import { describeTransition, headEventId, type AssignmentEventType, type Binding } from "./_core/dispatchAssignmentEvents";
import type { Tx } from "./_core/dbTypes";
import { syncJobRoomWithBinding, type JobRoomResult } from "./jobRoomService";

export type Scope = { tenantId: string };

export async function scopeOf(userId: number): Promise<Scope> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return { tenantId: (await resolveActingScope(db, userId)).tenantId };
}

async function database() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

const mintRef = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/**
 * The catalog this tenant can see: global rows plus its own.
 *
 * Deliberately not `orgScopeWhere`. For a real tenant that helper is `orgRef = :tenant`, which
 * matches no NULL row — so a member of any organization would be handed an empty catalog and then
 * told every seeded code was unknown. A catalog is shared vocabulary, not an owned record.
 */
export async function catalogFor(scope: Scope): Promise<RoleType[]> {
  const db = await database();
  const rows = await db
    .select()
    .from(dispatchRoleTypes)
    .where(or(isNull(dispatchRoleTypes.orgRef), eq(dispatchRoleTypes.orgRef, scope.tenantId)))
    .limit(500);
  return rows.map(r => ({
    roleCode: r.roleCode, orgRef: r.orgRef, displayName: r.displayName,
    description: r.description, defaultEquipmentClass: r.defaultEquipmentClass,
    defaultTrailerClass: r.defaultTrailerClass, active: r.active,
  }));
}

/** A posting this scope may act on, with its job. Throws NOT_FOUND rather than leaking existence. */
async function postingInScope(postingId: number, scope: Scope) {
  const db = await database();
  const posting = (await db.select().from(dispatchPostings).where(eq(dispatchPostings.id, postingId)).limit(1))[0];
  if (!posting) throw new TRPCError({ code: "NOT_FOUND", message: `Posting ${postingId} not found` });
  if (!(await jobInScope(posting.jobId, scope))) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Posting ${postingId} not found` });
  }
  return posting;
}

export type RoleDraft = {
  roleCode: string;
  roleLabel?: string;
  required?: boolean;
  requiredEquipmentClass?: string | null;
  requiredTrailerClass?: string | null;
};

/**
 * Turn a draft into the row a slot starts life as: open, unbound, carrying a snapshot of its type's
 * requirements.
 *
 * The snapshot matters. If the slot pointed at its type instead, editing the catalog would silently
 * restate what an existing posting requires, and a dispatcher who read "tandem" yesterday would
 * find the slot demanding something else today without anyone having touched it.
 */
function roleRowFor(draft: RoleDraft, postingId: number, catalog: readonly RoleType[], scope: Scope) {
  const type = resolveRoleType(draft.roleCode, scope.tenantId, catalog);
  if (!type) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `No active role type "${draft.roleCode}" — a role code must exist in the dispatch role catalog`,
    });
  }
  const defaults = requirementDefaultsOf(type);
  return {
    postingId,
    roleCode: type.roleCode,
    roleLabel: draft.roleLabel ?? type.displayName,
    required: draft.required ?? true,
    requiredEquipmentClass: draft.requiredEquipmentClass !== undefined ? draft.requiredEquipmentClass : defaults.requiredEquipmentClass,
    requiredTrailerClass: draft.requiredTrailerClass !== undefined ? draft.requiredTrailerClass : defaults.requiredTrailerClass,
    status: "open" as const,
  };
}

/**
 * Create a dispatch posting for a job, optionally with its slots.
 *
 * A direct job is still a posting: `direct_assignment` is a distribution the enum has always
 * carried and `direct` is a planning state the lifecycle has always permitted. That is what keeps
 * one model for bid-driven and direct dispatch rather than two.
 */
export async function createPosting(args: {
  jobId: number;
  distribution?: "direct_assignment" | "public_internal_bid" | "invite_only" | "selected_pool" | "on_call" | "emergency" | "subcontractor_bid";
  roles?: RoleDraft[];
  actorUserId: number;
  scope: Scope;
}): Promise<{ postingId: number; postingNumber: string; roleIds: number[] }> {
  const db = await database();
  if (!(await jobInScope(args.jobId, args.scope))) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Job ${args.jobId} not found` });
  }
  const distribution = args.distribution ?? "direct_assignment";
  const catalog = args.roles?.length ? await catalogFor(args.scope) : [];
  // Resolve every draft before writing anything, so a bad role code refuses the whole call rather
  // than leaving a posting with some of the slots it was asked for.
  const drafts = (args.roles ?? []).map(dft => ({ dft, resolved: true as const }));

  const postingNumber = mintRef("POST");
  return db.transaction(async tx => {
    const ins = await tx.insert(dispatchPostings).values({
      postingNumber,
      jobId: args.jobId,
      distribution,
      // `direct` is the lifecycle's own state for a posting nobody bids on.
      planningState: distribution === "direct_assignment" ? "direct" : "planning",
      createdByUserId: args.actorUserId,
    } as never);
    const postingId = Number(ins[0]?.insertId ?? 0);

    const roleIds: number[] = [];
    for (const { dft } of drafts) {
      const row = roleRowFor(dft, postingId, catalog, args.scope);
      const r = await tx.insert(dispatchRoles).values(row as never);
      roleIds.push(Number(r[0]?.insertId ?? 0));
    }
    return { postingId, postingNumber, roleIds };
  });
}

/** Add one open slot to an existing posting. Never binds a resource. */
export async function addRole(args: {
  postingId: number;
  draft: RoleDraft;
  scope: Scope;
}): Promise<{ roleId: number }> {
  const db = await database();
  await postingInScope(args.postingId, args.scope);
  const catalog = await catalogFor(args.scope);
  const row = roleRowFor(args.draft, args.postingId, catalog, args.scope);
  const r = await db.insert(dispatchRoles).values(row as never);
  return { roleId: Number(r[0]?.insertId ?? 0) };
}

export type RoleView = {
  roleId: number;
  postingId: number;
  jobId: number;
  roleCode: string;
  roleLabel: string;
  displayName: string | null;
  required: boolean;
  requiredEquipmentClass: string | null;
  requiredTrailerClass: string | null;
  status: string;
  operatorId: number | null;
  unitId: number | null;
  trailerId: number | null;
  /** The concurrency token for this slot: the head of its own history, or null if it has none. */
  lastEventId: number | null;
};

/**
 * Every slot for a job or a posting, with the precise staffing picture.
 *
 * `planningState` and `staffing` are returned side by side and never merged. The persisted field
 * cannot express zero-of-N — its legal backward transition from `staffed` is `partially_staffed`,
 * which would be a lie — so the derived `assessStaffing` result is what a screen should show, and
 * the coarse lifecycle value is reported as itself.
 */
export async function listRoles(args: {
  jobId?: number;
  postingId?: number;
  includeHistory?: boolean;
  scope: Scope;
}): Promise<{
  jobId: number | null;
  postings: { postingId: number; postingNumber: string; planningState: string }[];
  planningState: string | null;
  roles: RoleView[];
  staffing: ReturnType<typeof assessStaffing>;
  history: (typeof dispatchRoleAssignmentEvents.$inferSelect)[];
}> {
  const db = await database();

  let postings: (typeof dispatchPostings.$inferSelect)[];
  let jobId: number | null;
  if (args.postingId != null) {
    const p = await postingInScope(args.postingId, args.scope);
    postings = [p];
    jobId = p.jobId;
  } else if (args.jobId != null) {
    if (!(await jobInScope(args.jobId, args.scope))) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Job ${args.jobId} not found` });
    }
    jobId = args.jobId;
    postings = await db.select().from(dispatchPostings).where(eq(dispatchPostings.jobId, args.jobId)).orderBy(asc(dispatchPostings.id)).limit(50);
  } else {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Name a jobId or a postingId" });
  }

  const postingIds = postings.map(p => p.id);
  const roleRows = postingIds.length
    ? await db.select().from(dispatchRoles).where(inArray(dispatchRoles.postingId, postingIds)).orderBy(asc(dispatchRoles.id)).limit(500)
    : [];

  const catalog = await catalogFor(args.scope);
  const heads = roleRows.length
    ? await db.select().from(dispatchRoleAssignmentEvents).where(inArray(dispatchRoleAssignmentEvents.roleId, roleRows.map(r => r.id))).limit(2000)
    : [];
  const headFor = (roleId: number) => {
    const mine = heads.filter(e => e.roleId === roleId);
    return mine.length ? mine.reduce((hi, e) => (e.id > hi ? e.id : hi), mine[0]!.id) : null;
  };

  const byPosting = new Map(postings.map(p => [p.id, p]));
  const roles: RoleView[] = roleRows.map(r => ({
    roleId: r.id,
    postingId: r.postingId,
    jobId: byPosting.get(r.postingId)?.jobId ?? jobId!,
    roleCode: r.roleCode,
    roleLabel: r.roleLabel,
    displayName: resolveRoleType(r.roleCode, args.scope.tenantId, catalog)?.displayName ?? null,
    required: r.required,
    requiredEquipmentClass: r.requiredEquipmentClass,
    requiredTrailerClass: r.requiredTrailerClass,
    status: r.status,
    operatorId: r.assignedOperatorId,
    unitId: r.assignedUnitId,
    trailerId: r.assignedTrailerId,
    lastEventId: headFor(r.id),
  }));

  // Cancelled slots are not part of the staffing question: they were withdrawn, not left unfilled.
  const staffing = assessStaffing(
    roles.filter(r => r.status !== "cancelled").map(r => ({
      roleId: r.roleId, roleLabel: r.roleLabel, required: r.required, assignedOperatorId: r.operatorId,
    })),
  );

  const history = args.includeHistory && roleRows.length
    ? await db.select().from(dispatchRoleAssignmentEvents)
        .where(inArray(dispatchRoleAssignmentEvents.roleId, roleRows.map(r => r.id)))
        .orderBy(desc(dispatchRoleAssignmentEvents.occurredAt), desc(dispatchRoleAssignmentEvents.id))
        .limit(200)
    : [];

  return {
    jobId,
    postings: postings.map(p => ({ postingId: p.id, postingNumber: p.postingNumber, planningState: p.planningState })),
    planningState: postings[0]?.planningState ?? null,
    roles,
    staffing,
    history,
  };
}

/* ================================================================== */
/* Assignment                                                          */
/* ================================================================== */

export type AssignmentOutcome = {
  roleId: number;
  status: string;
  binding: { operatorId: number | null; unitId: number | null; trailerId: number | null };
  eventId: number;
  eventType: AssignmentEventType;
  lastEventId: number;
  planningState: string;
  staffing: ReturnType<typeof assessStaffing>;
  /** 0182 — the job room the binding kept in step: the operator bound joins it, the one displaced leaves it. */
  jobRoom: JobRoomResult | null;
};

/**
 * Bind, rebind or clear one slot.
 *
 * The whole transaction exists to keep three promises, and each one costs something structural:
 *
 * **It is not an award.** It writes `dispatchRoles`, `dispatchRoleAssignmentEvents` and — derived —
 * `dispatchPostings.planningState`, and nothing else. No booking, no `usedForAward`, no
 * `assignment_approved`, no bid or invitation touched. Those are the award's durable evidence and
 * the reason `jobUnits.create` became an award path by accident.
 *
 * **It takes the posting lock, not just the role lock.** OD-1 — one operator and one unit per
 * posting at a time — is a claim about a *set* of rows, and MariaDB has no filtered unique index
 * that can say "unique among rows whose status is assigned". Two dispatchers filling two slots of
 * one posting with the same driver would both pass a read-then-write check. Locking the posting is
 * what makes the check true rather than likely, and it is the same lock the award already takes.
 *
 * **Staleness is refused, not merged.** `expectedLastEventId` is the head of this slot's own
 * history: a version that already had to exist. A client that submits the token it read before
 * somebody else's change landed is told so.
 *
 * Cross-posting exclusivity is deliberately absent. The repository's conflict checker compares
 * `resourceBookings` windows; assignment creates no booking and a posting carries no window at all
 * (the award takes `startsAt`/`endsAt` as call input). Enforcing it here would mean inventing a
 * window — a weaker second conflict engine. It stays the award's job, against real bookings.
 */
async function applyBinding(args: {
  roleId: number;
  next: Binding;
  expectedLastEventId: number | null;
  reason: string | null;
  actorUserId: number;
  actorRole: string;
  scope: Scope;
  /** A clear always needs a reason; a first binding does not. */
  requireReason: boolean;
}, outer?: Tx): Promise<AssignmentOutcome> {
  const db = await database();
  const now = new Date();

  /*
   * 0183 — a caller that already holds the posting lock (the marketplace award, which locks the
   * posting first, then the role, then the post and its offers) runs the binding inside its own
   * transaction. The body is unchanged: the same lock order, the same checks, the same writes.
   */
  const body = async (tx: Tx): Promise<AssignmentOutcome> => {
    // 1. The role, and through it the posting we must serialise on.
    const role = (await tx.select().from(dispatchRoles).where(eq(dispatchRoles.id, args.roleId)).limit(1))[0];
    if (!role) throw new TRPCError({ code: "NOT_FOUND", message: `Role ${args.roleId} not found` });

    // 2. Posting lock FIRST, then the role — a deterministic order, so two callers touching the
    //    same posting queue rather than deadlock.
    const lockedPosting = (await tx.select().from(dispatchPostings)
      .where(eq(dispatchPostings.id, role.postingId)).for("update").limit(1))[0];
    if (!lockedPosting) throw new TRPCError({ code: "NOT_FOUND", message: `Role ${args.roleId} not found` });

    const locked = (await tx.select().from(dispatchRoles)
      .where(eq(dispatchRoles.id, args.roleId)).for("update").limit(1))[0]!;

    // 3. Tenancy, on the job the posting belongs to.
    if (!(await jobInScope(lockedPosting.jobId, args.scope))) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Role ${args.roleId} not found` });
    }
    if (locked.status === "cancelled") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Role ${args.roleId} is cancelled` });
    }
    if (lockedPosting.planningState === "cancelled" || lockedPosting.planningState === "completed") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Posting ${lockedPosting.id} is ${lockedPosting.planningState}` });
    }

    // 4. Every resource named must be one this scope may use. A trailer is a `units` row here —
    //    see the module note on what that can and cannot prove.
    if (args.next.unitId != null && !(await unitInScope(args.next.unitId, args.scope))) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${args.next.unitId} not found` });
    }
    if (args.next.trailerId != null && !(await unitInScope(args.next.trailerId, args.scope))) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Trailer ${args.next.trailerId} not found` });
    }
    if (args.next.operatorId != null && !(await operatorInScope(args.next.operatorId, args.scope))) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Operator ${args.next.operatorId} not found` });
    }

    // 5. The concurrency head, read under the lock.
    // Locking read for the same snapshot reason as the sibling scan below.
    const priorEvents = await tx.select({ id: dispatchRoleAssignmentEvents.id })
      .from(dispatchRoleAssignmentEvents).where(eq(dispatchRoleAssignmentEvents.roleId, args.roleId)).for("update").limit(1000);
    const head = headEventId(priorEvents);
    if (head !== args.expectedLastEventId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Role ${args.roleId} changed since you loaded it — reload and try again`,
      });
    }

    const previous: Binding = {
      operatorId: locked.assignedOperatorId, unitId: locked.assignedUnitId, trailerId: locked.assignedTrailerId,
    };
    const eventType = describeTransition(previous, args.next);
    if (!eventType) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That is already the assignment" });
    }
    if (args.requireReason && !args.reason?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "A reason is required" });
    }
    // A reassignment displaces somebody; that always needs accounting for.
    if (eventType === "assignment_reassigned" && !args.reason?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "A reason is required to reassign a filled slot" });
    }

    // 6. OD-1, under the posting lock: one operator and one unit per posting at a time.
    //    A cancelled slot reserves nothing — it was withdrawn, not left occupied.
    //    `.for("update")` is not decoration. MariaDB's default REPEATABLE READ establishes the
    //    transaction's snapshot at its FIRST plain SELECT — which happens above, before the posting
    //    lock — so a plain read here returns the world as it was before the other dispatcher
    //    committed, even while we hold the lock. A locking read always sees the latest committed
    //    row. Without it, two slots of one posting both take the same driver; D14 proves it.
    const siblings = (await tx.select().from(dispatchRoles)
      .where(eq(dispatchRoles.postingId, lockedPosting.id)).for("update").limit(200))
      .filter(r => r.id !== args.roleId && r.status !== "cancelled");
    if (args.next.operatorId != null && siblings.some(r => r.assignedOperatorId === args.next.operatorId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Operator ${args.next.operatorId} is already on another role of this posting — one person cannot hold two slots at once`,
      });
    }
    if (args.next.unitId != null && siblings.some(r => r.assignedUnitId === args.next.unitId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Unit ${args.next.unitId} is already on another role of this posting — one truck cannot hold two slots at once`,
      });
    }

    // 7. The binding.
    await tx.update(dispatchRoles).set({
      assignedOperatorId: args.next.operatorId,
      assignedUnitId: args.next.unitId,
      assignedTrailerId: args.next.trailerId,
      status: eventType === "assignment_unassigned" ? "open" : "assigned",
    }).where(eq(dispatchRoles.id, args.roleId));

    // 8. The history. Append-only; nothing in production updates or deletes one of these.
    const insEvent = await tx.insert(dispatchRoleAssignmentEvents).values({
      eventRef: mintRef("RAE"),
      roleId: args.roleId,
      postingId: lockedPosting.id,
      jobId: lockedPosting.jobId,
      orgRef: args.scope.tenantId === SINGLE_TENANT_ID ? null : args.scope.tenantId,
      eventType,
      fromOperatorId: previous.operatorId, fromUnitId: previous.unitId, fromTrailerId: previous.trailerId,
      toOperatorId: args.next.operatorId, toUnitId: args.next.unitId, toTrailerId: args.next.trailerId,
      reason: args.reason ?? null,
      actorUserId: args.actorUserId,
      actorRole: args.actorRole,
      occurredAt: now,
    } as never);
    const eventId = Number(insEvent[0]?.insertId ?? 0);

    // 9. Staffing, recomputed from current occupancy — the same assessStaffing the award calls, so
    //    the two can never disagree about whether a posting is crewed.
    const after = (await tx.select().from(dispatchRoles)
      .where(eq(dispatchRoles.postingId, lockedPosting.id)).for("update").limit(200))
      .filter(r => r.status !== "cancelled");
    const staffing = assessStaffing(after.map(r => ({
      roleId: r.id, roleLabel: r.roleLabel, required: r.required, assignedOperatorId: r.assignedOperatorId,
    })));

    // The persisted field is a coarse lifecycle marker and cannot express zero-of-N: from `staffed`
    // its only legal backward transition is `partially_staffed`. So it is clamped to what the state
    // machine permits and the precise truth is returned beside it, never merged into it.
    const desired = staffing.state === "staffed" ? "staffed" : "partially_staffed";
    const from = lockedPosting.planningState;
    if (from !== desired && canTransitionPosting(from, desired)) {
      await tx.update(dispatchPostings).set({ planningState: desired }).where(eq(dispatchPostings.id, lockedPosting.id));
    }
    const planningState = from !== desired && canTransitionPosting(from, desired) ? desired : from;

    // 10. The job room, kept in step with the binding in the same transaction. An operator with no
    //     linked user is reported, never invented.
    const jobRoom = await syncJobRoomWithBinding(tx, {
      tenantId: args.scope.tenantId, jobId: lockedPosting.jobId, roleId: args.roleId,
      fromOperatorId: previous.operatorId, toOperatorId: args.next.operatorId,
      actorUserId: args.actorUserId, actorRole: args.actorRole, at: now,
    });

    return {
      roleId: args.roleId,
      status: eventType === "assignment_unassigned" ? "open" : "assigned",
      binding: { ...args.next },
      eventId, eventType, lastEventId: eventId,
      planningState, staffing, jobRoom,
    };
  };
  return outer ? body(outer) : db.transaction(body);
}

/**
 * 0183 — the binding inside a transaction the caller already holds. The marketplace award takes
 * the posting lock first, exactly as this does, so the two never deadlock; then it asks for the
 * binding here rather than restating any of it.
 */
export function setRoleAssignmentIn(tx: Tx, args: {
  roleId: number;
  operatorId: number | null;
  unitId: number | null;
  trailerId: number | null;
  expectedLastEventId: number | null;
  reason: string | null;
  actorUserId: number;
  actorRole: string;
  scope: Scope;
}): Promise<AssignmentOutcome> {
  return applyBinding({
    roleId: args.roleId,
    next: { operatorId: args.operatorId, unitId: args.unitId, trailerId: args.trailerId },
    expectedLastEventId: args.expectedLastEventId,
    reason: args.reason,
    actorUserId: args.actorUserId,
    actorRole: args.actorRole,
    scope: args.scope,
    requireReason: false,
  }, tx);
}

/** Assign or reassign — which one it is, is server state, not caller intent. */
export function setRoleAssignment(args: {
  roleId: number;
  operatorId: number | null;
  unitId: number | null;
  trailerId: number | null;
  expectedLastEventId: number | null;
  reason: string | null;
  actorUserId: number;
  actorRole: string;
  scope: Scope;
}): Promise<AssignmentOutcome> {
  return applyBinding({
    roleId: args.roleId,
    next: { operatorId: args.operatorId, unitId: args.unitId, trailerId: args.trailerId },
    expectedLastEventId: args.expectedLastEventId,
    reason: args.reason,
    actorUserId: args.actorUserId,
    actorRole: args.actorRole,
    scope: args.scope,
    requireReason: false,
  });
}

/**
 * Return a slot to `open`.
 *
 * Always takes a reason: an unassignment removes somebody from work they were expected to do, and
 * it is the one operation that can move a staffed posting backwards. It destroys nothing — the
 * history keeps the binding, and the award's records are untouched.
 */
export function clearRoleAssignment(args: {
  roleId: number;
  expectedLastEventId: number | null;
  reason: string;
  actorUserId: number;
  actorRole: string;
  scope: Scope;
}): Promise<AssignmentOutcome> {
  return applyBinding({
    roleId: args.roleId,
    next: { operatorId: null, unitId: null, trailerId: null },
    expectedLastEventId: args.expectedLastEventId,
    reason: args.reason,
    actorUserId: args.actorUserId,
    actorRole: args.actorRole,
    scope: args.scope,
    requireReason: true,
  });
}

export { and, eq };
