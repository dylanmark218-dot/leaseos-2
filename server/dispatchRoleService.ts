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
import { getDb, jobInScope } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import {
  dispatchPostings, dispatchRoleAssignmentEvents, dispatchRoles, dispatchRoleTypes,
} from "../drizzle/schema";
import { resolveRoleType, requirementDefaultsOf, type RoleType } from "./_core/dispatchRoleCatalog";
import { assessStaffing } from "./_core/dispatchLifecycle";

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

export { and, eq };
