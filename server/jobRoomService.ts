/**
 * 0205 — the job room: a `job` channel, explicit by construction, created on demand.
 *
 * Design §4.5. A room is one per job in the acting organization, keyed by the job's own code. Its
 * members are whoever the canonical binding puts on the work: the dispatcher who bound the slot and
 * the operator bound to it, each with `source = job_assignment`, and an unassignment ends the
 * operator's membership the way leaving any channel does — the row stays, what they were sent
 * stays theirs. No other automation: what a room surfaces is the attachment pointer model the
 * board already has, and a room copies nothing.
 *
 * Called with the caller's transaction, so a binding and its room commit together or not at all.
 * An operator with no linked user cannot be put in a room; that is reported, never invented.
 */
import { and, eq, isNull } from "drizzle-orm";
import { jobs, messageChannelEvents, messageChannelMembers, messageChannels, operators } from "../drizzle/schema";
import type { Tx } from "./_core/dbTypes";
import { SINGLE_TENANT_ID } from "./_core/actingScope";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export type JobRoomResult = {
  channelRef: string;
  created: boolean;
  /** What happened to the operator's membership, and why nothing happened when nothing did. */
  operatorMembership: "added" | "already_member" | "ended" | "not_current" | "no_operator" | "no_user_link";
};

async function channelEvent(tx: Tx, args: { channelRef: string; eventType: "member_added" | "member_left"; actorUserId: number; actorRole: string; subjectUserId: number; detail: string; at: Date }) {
  await tx.insert(messageChannelEvents).values({
    eventRef: ref("CHE"), channelRef: args.channelRef, eventType: args.eventType, actorUserId: args.actorUserId, actorRole: args.actorRole,
    subjectUserId: args.subjectUserId, messageRef: null, detail: args.detail, occurredAt: args.at,
  });
}

/** The job's room, created if the job has none. The acting organization owns it. */
export async function ensureJobRoom(tx: Tx, args: { tenantId: string; jobId: number; actorUserId: number; actorRole: string; at: Date }): Promise<{ channelRef: string; created: boolean }> {
  const job = (await tx.select({ jobCode: jobs.jobCode }).from(jobs).where(eq(jobs.id, args.jobId)).limit(1))[0];
  if (!job) throw new Error(`Job ${args.jobId} not found`);
  const existing = (await tx.select().from(messageChannels).where(and(
    eq(messageChannels.tenantId, args.tenantId), eq(messageChannels.type, "job"), eq(messageChannels.jobRef, job.jobCode), eq(messageChannels.membershipMode, "explicit"),
  )).limit(1))[0];
  if (existing) return { channelRef: existing.channelRef, created: false };
  const channelRef = ref("CH");
  await tx.insert(messageChannels).values({
    channelRef, tenantId: args.tenantId === SINGLE_TENANT_ID ? SINGLE_TENANT_ID : args.tenantId, type: "job", name: `Job ${job.jobCode}`, jobRef: job.jobCode,
    clientRef: null, crewRef: null, membershipMode: "explicit", archived: false, createdByUserId: args.actorUserId,
  });
  await tx.insert(messageChannelMembers).values({ channelRef, userId: args.actorUserId, memberRole: "dispatcher", source: "job_assignment", joinedAt: args.at, addedByUserId: args.actorUserId });
  await channelEvent(tx, { channelRef, eventType: "member_added", actorUserId: args.actorUserId, actorRole: args.actorRole, subjectUserId: args.actorUserId, detail: "dispatcher (job room created)", at: args.at });
  return { channelRef, created: true };
}

/** Put a person in the room as a member, once. */
export async function joinJobRoom(tx: Tx, args: { channelRef: string; userId: number; memberRole: "member" | "dispatcher" | "manager"; actorUserId: number; actorRole: string; at: Date; detail: string }): Promise<"added" | "already_member"> {
  const live = (await tx.select({ id: messageChannelMembers.id }).from(messageChannelMembers).where(and(
    eq(messageChannelMembers.channelRef, args.channelRef), eq(messageChannelMembers.userId, args.userId), isNull(messageChannelMembers.leftAt),
  )).limit(1))[0];
  if (live) return "already_member";
  await tx.insert(messageChannelMembers).values({ channelRef: args.channelRef, userId: args.userId, memberRole: args.memberRole, source: "job_assignment", joinedAt: args.at, addedByUserId: args.actorUserId });
  await channelEvent(tx, { channelRef: args.channelRef, eventType: "member_added", actorUserId: args.actorUserId, actorRole: args.actorRole, subjectUserId: args.userId, detail: args.detail, at: args.at });
  return "added";
}

/** End a person's membership. The row stays. */
export async function leaveJobRoom(tx: Tx, args: { channelRef: string; userId: number; actorUserId: number; actorRole: string; at: Date; detail: string }): Promise<"ended" | "not_current"> {
  const live = (await tx.select({ id: messageChannelMembers.id }).from(messageChannelMembers).where(and(
    eq(messageChannelMembers.channelRef, args.channelRef), eq(messageChannelMembers.userId, args.userId), isNull(messageChannelMembers.leftAt),
  )).limit(1))[0];
  if (!live) return "not_current";
  await tx.update(messageChannelMembers).set({ leftAt: args.at }).where(eq(messageChannelMembers.id, live.id));
  await channelEvent(tx, { channelRef: args.channelRef, eventType: "member_left", actorUserId: args.actorUserId, actorRole: args.actorRole, subjectUserId: args.userId, detail: args.detail, at: args.at });
  return "ended";
}

/**
 * Keep the room in step with one slot's binding: the operator bound joins, the operator displaced
 * leaves. Called by the canonical binding inside its own transaction.
 */
export async function syncJobRoomWithBinding(tx: Tx, args: {
  tenantId: string; jobId: number; roleId: number; fromOperatorId: number | null; toOperatorId: number | null;
  actorUserId: number; actorRole: string; at: Date;
}): Promise<JobRoomResult> {
  const room = await ensureJobRoom(tx, { tenantId: args.tenantId, jobId: args.jobId, actorUserId: args.actorUserId, actorRole: args.actorRole, at: args.at });
  await joinJobRoom(tx, { channelRef: room.channelRef, userId: args.actorUserId, memberRole: "dispatcher", actorUserId: args.actorUserId, actorRole: args.actorRole, at: args.at, detail: `dispatcher (role ${args.roleId})` });
  let operatorMembership: JobRoomResult["operatorMembership"] = "no_operator";
  if (args.fromOperatorId != null && args.fromOperatorId !== args.toOperatorId) {
    const from = (await tx.select({ userId: operators.userId }).from(operators).where(eq(operators.id, args.fromOperatorId)).limit(1))[0];
    if (from?.userId != null) operatorMembership = await leaveJobRoom(tx, { channelRef: room.channelRef, userId: from.userId, actorUserId: args.actorUserId, actorRole: args.actorRole, at: args.at, detail: `unbound from role ${args.roleId}` });
  }
  if (args.toOperatorId != null) {
    const to = (await tx.select({ userId: operators.userId }).from(operators).where(eq(operators.id, args.toOperatorId)).limit(1))[0];
    operatorMembership = to?.userId == null ? "no_user_link"
      : await joinJobRoom(tx, { channelRef: room.channelRef, userId: to.userId, memberRole: "member", actorUserId: args.actorUserId, actorRole: args.actorRole, at: args.at, detail: `bound to role ${args.roleId}` });
  }
  return { channelRef: room.channelRef, created: room.created, operatorMembership };
}
