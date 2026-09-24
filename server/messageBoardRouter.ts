/**
 * v22.20 (0096) — the board, reachable. 0182 — the board with membership.
 *
 * `_core/messageBoard.ts` and `_core/messageLifecycle.ts` hold the rules; this
 * stores and serves. Five things it is responsible for.
 *
 * **Access is decided on the channel.** An outside viewer is refused before any
 * message is read, not filtered out of a list afterwards. Since 0182 a channel
 * is `open` (every internal viewer), `crew` (through crew membership) or
 * `explicit` (through a member row) — one door, `openChannel`, decides which.
 *
 * **A private conversation is nobody else's.** `direct` and `group` channels
 * are explicit, and holding `board.manage` or the management role admits nobody
 * to them. Moderation is a separate, sensitive authority, and every use of it
 * writes a channel event.
 *
 * **Both clocks are kept.** The device's time arrives with the message; the
 * server stamps its own alongside. Neither overwrites the other.
 *
 * **Acknowledgement is derived from priority**, so an urgent bulletin cannot be
 * posted as something people may ignore — and publishing an emergency, or into
 * an announcement channel, needs the publish authority, not the posting one.
 *
 * **A retried post is one post.** `(deviceId, clientMutationId)` names a
 * message a device already sent; the reply is the message it wrote the first
 * time, marked `replayed`. A receipt advances forward only, on evidence, and
 * the sender is never shown "delivered" for something still on a server.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, listActiveUserRoleNames, userInScope } from "./db";
import {
  boardMessages, crewMembers, crews, messageAttachments, messageChannelEvents, messageChannelMembers, messageChannels,
  messageReceipts, messageRevisions, organizationMemberships,
} from "../drizzle/schema";
import { resolveActingScope, type ActingScope } from "./_core/actingScope";
import { mayAttach, supportedKinds, viewFor } from "./_core/attachmentAuthorizers";
import { permissionsFor } from "./_core/recordsAuthorization";
import { crewPermissions, isCurrentMember, type CrewMember, type CrewRole } from "./_core/crewChannels";
import type { DbOrTx, Tx } from "./_core/dbTypes";
import {
  ACKNOWLEDGEMENT_REQUIRED, announcementAudienceRefusal, defaultMembershipMode, EXPLICIT_ONLY_TYPES, mayOpen, mayOpenExplicit,
  memberMayPost, memberStanding, requiresPublishAuthority,
  type Channel, type ChannelMember, type ChannelType, type MemberRole, type MemberStanding, type MembershipMode, type Priority, type Viewer,
} from "./_core/messageBoard";
import { acknowledgementStatus } from "./_core/messageBoard";
import { advance, currentBody, edit, originalBody, ReceiptRegression, senderLabel, withdraw,
  type Evidence, type MessageHistory, type Receipt, type ReceiptState , type Revision } from "./_core/messageLifecycle";
import { enqueueBoardEvent } from "./_core/boardOutbox";

/** Column per canonical state, for the states the server actually witnesses. */
const EVIDENCE_COLUMN: Partial<Record<ReceiptState, "acceptedAt" | "deliveredAt" | "openedAt" | "acknowledgedAt" | "actionedAt" | "resolvedAt">> = {
  accepted: "acceptedAt", delivered: "deliveredAt", opened: "openedAt",
  acknowledged: "acknowledgedAt", actioned: "actionedAt", resolved: "resolvedAt",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowToReceipt = (row: any): Receipt => ({
  messageRef: row.messageRef, userId: row.userId, state: row.state,
  at: {
    accepted: row.acceptedAt ?? undefined, delivered: row.deliveredAt ?? undefined,
    opened: row.openedAt ?? undefined, acknowledged: row.acknowledgedAt ?? undefined,
    actioned: row.actionedAt ?? undefined, resolved: row.resolvedAt ?? undefined,
  },
});

/**
 * The one place a receipt moves.
 *
 * Every resolver hands this real evidence and it asks `advance()`; none of them
 * writes a state itself, so there is a single interpretation of what a
 * transition means.
 *
 * **Earlier states are filled conservatively, never earlier than evidenced.**
 * Somebody acknowledging a message proves it reached them and that they saw it.
 * Where those moments were not separately recorded, they are recorded *at the
 * acknowledgement time* — not at some plausible earlier point, which would be
 * inventing a delivery that nothing witnessed.
 *
 * 0182 — `deviceAt` is the device's clock for the state being reached. It is
 * stored beside the server's stamp for an acknowledgement and overwrites nothing.
 */
async function advanceReceipt(d: DbOrTx, args: { messageRef: string; userId: number; evidence: Evidence; at: Date; deviceAt?: Date | null }) {
  const row = (await d.select().from(messageReceipts).where(and(
    eq(messageReceipts.messageRef, args.messageRef), eq(messageReceipts.userId, args.userId),
  )).limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No receipt for this person on that message" });

  const receipt = rowToReceipt(row);
  let next;
  try {
    next = advance(receipt, args.evidence, args.at);
  } catch (e) {
    if (e instanceof ReceiptRegression) return { moved: false as const, state: receipt.state, reason: e.message };
    throw e;
  }

  const set: Record<string, Date | string> = { state: next.state };
  for (const [state, column] of Object.entries(EVIDENCE_COLUMN)) {
    const reached = ORDER_INDEX[state as ReceiptState] <= ORDER_INDEX[next.state];
    // Not recorded and now proven: stamp it at this moment, never before.
    if (reached && !(row as Record<string, unknown>)[column]) set[column] = args.at;
  }
  if (args.evidence.to === "acknowledged" && args.deviceAt && !row.deviceAcknowledgedAt) set.deviceAcknowledgedAt = args.deviceAt;
  await d.update(messageReceipts).set(set).where(eq(messageReceipts.id, row.id));
  return { moved: true as const, state: next.state, reason: null };
}

const ORDER_INDEX: Record<ReceiptState, number> = {
  queued_offline: 0, uploaded: 1, accepted: 2, delivered: 3,
  opened: 4, acknowledged: 5, actioned: 6, resolved: 7,
};

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

const MAX_CREW_AUDIENCE = 500;
/** Bounded so one post cannot become a thousand authorization lookups. */
const MAX_ATTACHMENTS = 10;
/** A group is a conversation, not a broadcast. */
const MAX_EXPLICIT_MEMBERS = 200;

const CHANNEL_TYPE = z.enum(["announcement", "dispatch", "safety", "maintenance", "field_operations", "road_conditions", "training", "general", "job", "client", "private", "emergency", "direct", "group", "department", "unit", "shift"]);
const MEMBER_ROLE = z.enum(["member", "moderator", "dispatcher", "manager", "read_only"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toChannel = (row: any): Channel => ({
  channelRef: row.channelRef, type: row.type, name: row.name,
  jobRef: row.jobRef ?? null, clientRef: row.clientRef ?? null, archived: row.archived,
});

/**
 * Resolve a channel and decide access in one place.
 *
 * Every read and write goes through here, so there is exactly one answer to
 * "may this person open this channel" rather than one per resolver.
 */
export class CrewAccessRefused extends Error {}

/** A crew membership row as the pure engine wants it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toMember = (row: any): CrewMember => ({
  crewRef: row.crewRef, userId: row.userId, crewRole: row.crewRole as CrewRole,
  source: row.source, joinedAt: row.joinedAt, leftAt: row.leftAt ?? null,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toChannelMember = (row: any): ChannelMember => ({
  channelRef: row.channelRef, userId: row.userId, memberRole: row.memberRole as MemberRole,
  joinedAt: row.joinedAt, leftAt: row.leftAt ?? null,
});

/**
 * Admission to a crew channel.
 *
 * Being an internal user is not being in this crew. The generic channel rule
 * lets essentially any employee into any non-private channel, which was fine
 * while channels were company-wide and is wrong the moment one carries a crew.
 *
 * A former member is admitted as a historical participant — they were there,
 * and what they were sent stays theirs. Which *messages* they see is a second,
 * narrower question answered by the audience actually recorded at the time, not
 * by re-deriving it from membership dates later.
 */
/**
 * Four states, not two.
 *
 * `current = !leftAt` is wrong: a membership beginning tomorrow with no leaving
 * date is not in force today. A future-only member must not be admitted, and
 * must not be mistaken for a historical one either — they were never here.
 */
export type CrewStanding = "current" | "historical" | "future_only" | "never";

async function crewRelationship(d: DbOrTx, args: { crewRef: string; tenantId: string; userId: number; at: Date }) {
  const crew = (await d.select().from(crews).where(eq(crews.crewRef, args.crewRef)).limit(1))[0];
  // Another organization's crew is not "forbidden", it does not exist.
  if (!crew || crew.tenantId !== args.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such crew" });
  const rows = await d.select().from(crewMembers).where(and(
    eq(crewMembers.crewRef, args.crewRef), eq(crewMembers.userId, args.userId),
  )).limit(20);
  const members = rows.map(toMember);
  // One definition, the engine's.
  const current = members.find(m => isCurrentMember(m, args.at)) ?? null;
  const standing: CrewStanding = current ? "current"
    : members.some(m => m.leftAt && m.leftAt.getTime() <= args.at.getTime()) ? "historical"
    : members.length ? "future_only"
    : "never";
  if (standing === "never" || standing === "future_only") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: standing === "future_only"
        ? "Membership of this crew has not begun. A joining date in the future is not current membership."
        : "Not a member of this crew. Being an internal user is not being in this crew.",
    });
  }
  return { crew, members, current, standing };
}

/**
 * 0182 — admission to an explicit channel, by the same four standings.
 *
 * `moderating` is the one bypass, and it is not silent: the caller holds
 * `board.moderate`, and the resolver that asked for it writes the event.
 */
async function explicitRelationship(d: DbOrTx, args: { channelRef: string; userId: number; at: Date }) {
  const rows = await d.select().from(messageChannelMembers).where(and(
    eq(messageChannelMembers.channelRef, args.channelRef), eq(messageChannelMembers.userId, args.userId),
  )).limit(20);
  const members = rows.map(toChannelMember);
  const { standing, current } = memberStanding(members, args.at);
  const access = mayOpenExplicit(standing);
  return { members, current, standing, access };
}

type OpenedChannel = {
  channel: Channel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: any;
  crew: Awaited<ReturnType<typeof crewRelationship>> | null;
  member: { standing: MemberStanding; current: ChannelMember | null } | null;
};

async function openChannel(d: DbOrTx, args: { channelRef: string; tenantId: string; viewer: Viewer; at?: Date; moderating?: boolean }): Promise<OpenedChannel> {
  const row = (await d.select().from(messageChannels).where(eq(messageChannels.channelRef, args.channelRef)).limit(1))[0];
  if (!row || row.tenantId !== args.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such channel" });
  const channel = toChannel(row);
  const access = mayOpen(channel, args.viewer);
  if (!access.allowed) throw new TRPCError({ code: "FORBIDDEN", message: access.reason });
  const at = args.at ?? new Date();

  // The crew boundary belongs here, not in whichever resolver remembered it.
  // It was enforced in read and post and absent from every messageRef path,
  // which made a message reference into a way around the channel.
  if (row.crewRef) {
    if (!args.viewer.internal) throw new TRPCError({ code: "FORBIDDEN", message: "Internal channel — not visible outside the company" });
    const crew = await crewRelationship(d, {
      crewRef: row.crewRef, tenantId: args.tenantId, userId: args.viewer.userId, at,
    });
    return { channel, row, crew, member: null };
  }
  if (row.membershipMode === "explicit") {
    if (!args.viewer.internal) throw new TRPCError({ code: "FORBIDDEN", message: "Internal channel — not visible outside the company" });
    const rel = await explicitRelationship(d, { channelRef: row.channelRef, userId: args.viewer.userId, at });
    if (!rel.access.allowed && !args.moderating) throw new TRPCError({ code: "FORBIDDEN", message: rel.access.reason });
    return { channel, row, crew: null, member: { standing: rel.standing, current: rel.current } };
  }
  return { channel, row, crew: null, member: null };
}

/** Resolve a message and check channel access in one place. */
/**
 * A message reference is a locator, never a capability.
 *
 * Knowing MSG-... must grant nothing that opening the channel would not. For a
 * crew or explicit-membership message that means two checks, not one: a
 * legitimate relationship to the channel, and having been in the audience
 * actually recorded when the server accepted it. `mutating` adds the third —
 * history is a former member's to read, and not theirs to rewrite.
 */
async function messageForCaller(d: DbOrTx, userId: number, messageRef: string, opts: { mutating?: boolean; moderating?: boolean } = {}) {
  const at = new Date();
  const acting = await resolveActingScope(d, userId);
  const message = (await d.select().from(boardMessages).where(eq(boardMessages.messageRef, messageRef)).limit(1))[0];
  if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "No such message" });
  const viewer: Viewer = { userId, internal: true, clientRef: null, roles: await listActiveUserRoleNames(userId) };
  // On a channelRef path a refusal is fine: the caller named the channel, so
  // they already know it exists. On a messageRef path it is not — "you may not
  // see this crew's message" confirms there is one. Both refusals become the
  // same NOT FOUND here, so possessing a reference reveals nothing.
  let opened: OpenedChannel;
  try {
    opened = await openChannel(d, { channelRef: message.channelRef, tenantId: acting.tenantId, viewer, at, moderating: opts.moderating });
  } catch (e) {
    if (e instanceof TRPCError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND")) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such message" });
    }
    throw e;
  }

  if ((opened.crew || opened.member) && !opts.moderating) {
    const receipt = (await d.select().from(messageReceipts).where(and(
      eq(messageReceipts.messageRef, messageRef), eq(messageReceipts.userId, userId),
    )).limit(1))[0];
    // Not FORBIDDEN: telling somebody a message exists that they may not see is
    // itself the disclosure.
    if (!receipt) throw new TRPCError({ code: "NOT_FOUND", message: "No such message" });

    if (opts.mutating && opened.crew) {
      if (opened.crew.standing !== "current") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Historical membership carries the right to read what you were sent, not to change the crew's record afterwards" });
      }
      if (opened.crew.crew.state !== "active") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${opened.crew.crew.name} is ${opened.crew.crew.state} — a closed record does not keep accepting revisions` });
      }
      if (!opened.crew.current || !crewPermissions(opened.crew.current.crewRole).includes("crew.post")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This crew role may read and not write" });
      }
    }
    if (opts.mutating && opened.member) {
      if (opened.member.standing !== "current" || !opened.member.current) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Historical membership carries the right to read what you were sent, not to change the conversation afterwards" });
      }
      if (!memberMayPost(opened.member.current.memberRole)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This channel role may read and not write" });
      }
    }
  }
  return { message, channel: opened.channel, crew: opened.crew, member: opened.member, acting };
}

/**
 * Revision 1, derived rather than stored.
 *
 * The original body lives in `boardMessages.body` and nowhere else;
 * `messageRevisions` holds 2 and up. This is the single place that turns the
 * stored original into the canonical shape — it was written out in three
 * resolvers, which is the same "two writable originals" hazard §15 warns about
 * wearing a different coat: three constructions are three chances for history
 * to disagree with itself about what was first said.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function originalRevision(message: any): Revision {
  return { revision: 1, body: message.body, editedByUserId: message.authorUserId, at: message.deviceCreatedAt, reason: null };
}

/** 0182 — the append-only channel record. Nothing in production updates or deletes one of these. */
async function channelEvent(d: DbOrTx, args: {
  channelRef: string; tenantId: string; eventType: typeof messageChannelEvents.$inferInsert["eventType"];
  actorUserId: number; actorRole: string; subjectUserId?: number | null; messageRef?: string | null; detail?: string | null; at: Date;
}) {
  await d.insert(messageChannelEvents).values({
    eventRef: ref("CHE"), channelRef: args.channelRef, eventType: args.eventType,
    actorUserId: args.actorUserId, actorRole: args.actorRole, subjectUserId: args.subjectUserId ?? null,
    messageRef: args.messageRef ?? null, detail: args.detail ?? null, occurredAt: args.at,
  });
}

/** Current members of an explicit channel, bounded, refused beyond the bound rather than truncated. */
async function currentExplicitMembers(d: DbOrTx, channelRef: string, at: Date): Promise<ChannelMember[]> {
  const all = await d.select().from(messageChannelMembers).where(and(eq(messageChannelMembers.channelRef, channelRef), isNull(messageChannelMembers.leftAt))).limit(MAX_EXPLICIT_MEMBERS + 1);
  if (all.length > MAX_EXPLICIT_MEMBERS) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This channel exceeds the ${MAX_EXPLICIT_MEMBERS}-member audience this board records. Refusing rather than sending to an arbitrary subset and calling it the audience.` });
  }
  return all.map(toChannelMember).filter(m => memberStanding([m], at).standing === "current");
}

/**
 * Whether the caller may change who is in a channel: `board.manage`, or a moderator or manager of
 * that channel. A channel role, decided here; the gate is the posting permission.
 */
async function assertMayManageMembers(d: DbOrTx, args: { opened: OpenedChannel; userId: number; roles: readonly string[] }) {
  if (permissionsFor(args.roles).includes("board.manage")) return;
  const role = args.opened.member?.current?.memberRole;
  if (role === "moderator" || role === "manager") return;
  throw new TRPCError({ code: "FORBIDDEN", message: "Changing who is in a channel takes board.manage, or a moderator or manager role in that channel" });
}

/** A person the acting organization may name as a member: one of its own. Refused as not found. */
async function assertUserInScope(userId: number, acting: ActingScope) {
  if (!(await userInScope(userId, { tenantId: acting.tenantId }))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${userId} not found` });
}

/** The organization's live membership, for an announcement whose caller named no audience. */
async function organizationAudience(d: DbOrTx, acting: ActingScope, at: Date): Promise<number[]> {
  if (acting.derivedFrom !== "membership") return [];
  const rows = await d.select({ userId: organizationMemberships.userId, effectiveFrom: organizationMemberships.effectiveFrom, effectiveTo: organizationMemberships.effectiveTo })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.orgRef, acting.tenantId), eq(organizationMemberships.status, "active")))
    .limit(MAX_CREW_AUDIENCE + 1);
  return Array.from(new Set(rows.filter(r => r.effectiveFrom.getTime() <= at.getTime() && (!r.effectiveTo || r.effectiveTo.getTime() > at.getTime())).map(r => r.userId)));
}

const actorRoleOf = (roles: readonly string[]) => roles[0] ?? "user";

export const messageBoardRouter = router({
  createChannel: roleProcedure("board.createChannel")
    .input(z.object({
      type: CHANNEL_TYPE,
      name: z.string().min(2).max(220),
      jobRef: z.string().max(64).optional(),
      clientRef: z.string().max(64).optional(),
      crewRef: z.string().max(64).optional(),
      /** 0182 — omitted: direct/group are explicit, a crew channel is crew, everything else is open. */
      membershipMode: z.enum(["open", "explicit", "crew"]).optional(),
      /** Initial members of an explicit channel. The creator is always one, as a moderator. */
      members: z.array(z.object({ userId: z.number().int().positive(), memberRole: MEMBER_ROLE.default("member") })).max(MAX_EXPLICIT_MEMBERS).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      if (input.clientRef && input.crewRef) {
        // A channel cannot mean "this belongs to a client" and "this belongs to
        // an internal crew" at once. Failing closed rather than inventing a
        // mixed trust zone nobody has specified.
        throw new TRPCError({ code: "BAD_REQUEST", message: "A channel is a client channel or a crew channel, not both" });
      }
      if (input.crewRef) {
        const crew = (await d.select().from(crews).where(eq(crews.crewRef, input.crewRef)).limit(1))[0];
        if (!crew || crew.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such crew" });
      }
      if (input.type === "client" && !input.clientRef) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A client channel must name its client; that reference is what decides who may open it" });
      }
      const membershipMode: MembershipMode = input.membershipMode ?? defaultMembershipMode(input.type as ChannelType, input.crewRef ?? null);
      if (input.crewRef && membershipMode !== "crew") throw new TRPCError({ code: "BAD_REQUEST", message: "A channel that names a crew is crew-bounded; that is not a choice" });
      if (!input.crewRef && membershipMode === "crew") throw new TRPCError({ code: "BAD_REQUEST", message: "A crew-bounded channel must name its crew" });
      if (EXPLICIT_ONLY_TYPES.includes(input.type as ChannelType) && membershipMode !== "explicit") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `A ${input.type} channel is a conversation between named people; it is explicit by construction` });
      }
      if (input.type === "client" && membershipMode !== "open") throw new TRPCError({ code: "BAD_REQUEST", message: "A client channel is decided by its client reference, not by a member list" });
      if (membershipMode !== "explicit" && input.members.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Members are named on an explicit channel only" });
      for (const m of input.members) await assertUserInScope(m.userId, acting);

      const now = new Date();
      const channelRef = ref("CH");
      await d.transaction(async tx => {
        await tx.insert(messageChannels).values({
          channelRef, tenantId: acting.tenantId, type: input.type, name: input.name,
          jobRef: input.jobRef ?? null, clientRef: input.clientRef ?? null, crewRef: input.crewRef ?? null,
          membershipMode, archived: false, createdByUserId: ctx.user.id,
        });
        if (membershipMode === "explicit") {
          const seen = new Set<number>();
          const initial = [{ userId: ctx.user.id, memberRole: "moderator" as MemberRole }, ...input.members.filter(m => m.userId !== ctx.user.id)];
          for (const m of initial) {
            if (seen.has(m.userId)) continue;
            seen.add(m.userId);
            await tx.insert(messageChannelMembers).values({ channelRef, userId: m.userId, memberRole: m.memberRole, source: input.type === "direct" ? "direct" : "manual", joinedAt: now, addedByUserId: ctx.user.id });
            await channelEvent(tx, { channelRef, tenantId: acting.tenantId, eventType: "member_added", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: m.userId, detail: m.memberRole, at: now });
          }
        }
      });
      return {
        channelRef, membershipMode,
        note: input.type === "client" ? "Client channel. Internal channels are not visible to this client and this one is not internal."
          : membershipMode === "explicit" ? "Explicit channel. Only its members open it; holding a management role does not."
          : "Created.",
      };
    }),

  /**
   * 0182 — the one direct channel between two people. Created on first use, returned afterwards;
   * A→B and B→A are the same room. Both must belong to the organization.
   */
  direct: roleProcedure("board.direct")
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      if (input.userId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "A direct channel is between two people" });
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      await assertUserInScope(input.userId, acting);
      const now = new Date();
      // Channels of type direct in this organization where both are live members.
      const mine = await d.select({ channelRef: messageChannelMembers.channelRef }).from(messageChannelMembers)
        .where(and(eq(messageChannelMembers.userId, ctx.user.id), isNull(messageChannelMembers.leftAt))).limit(2000);
      if (mine.length) {
        const theirs = await d.select({ channelRef: messageChannelMembers.channelRef }).from(messageChannelMembers)
          .where(and(eq(messageChannelMembers.userId, input.userId), isNull(messageChannelMembers.leftAt), inArray(messageChannelMembers.channelRef, mine.map(m => m.channelRef)))).limit(2000);
        if (theirs.length) {
          const rows = await d.select().from(messageChannels).where(and(
            inArray(messageChannels.channelRef, theirs.map(t => t.channelRef)), eq(messageChannels.type, "direct"), eq(messageChannels.tenantId, acting.tenantId),
          )).orderBy(asc(messageChannels.id)).limit(5);
          for (const row of rows) {
            const members = await currentExplicitMembers(d, row.channelRef, now);
            if (members.length === 2) return { channelRef: row.channelRef, created: false, note: "Existing direct channel." };
          }
        }
      }
      const channelRef = ref("CH");
      await d.transaction(async tx => {
        await tx.insert(messageChannels).values({
          channelRef, tenantId: acting.tenantId, type: "direct", name: "Direct", jobRef: null, clientRef: null, crewRef: null,
          membershipMode: "explicit", archived: false, createdByUserId: ctx.user.id,
        });
        for (const userId of [ctx.user.id, input.userId]) {
          await tx.insert(messageChannelMembers).values({ channelRef, userId, memberRole: "member", source: "direct", joinedAt: now, addedByUserId: ctx.user.id });
          await channelEvent(tx, { channelRef, tenantId: acting.tenantId, eventType: "member_added", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: userId, detail: "direct", at: now });
        }
      });
      return { channelRef, created: true, note: "Direct channel. Nobody outside it — management included — opens it without a recorded moderation act." };
    }),

  /** 0182 — who is in an explicit channel. Members and `board.manage` may ask; a direct channel is its two members' to see. */
  members: roleProcedure("board.members")
    .input(z.object({ channelRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const viewer: Viewer = { userId: ctx.user.id, internal: true, clientRef: null, roles };
      const opened = await openChannel(d, { channelRef: input.channelRef, tenantId: acting.tenantId, viewer });
      if (opened.row.membershipMode !== "explicit") return { channelRef: input.channelRef, membershipMode: opened.row.membershipMode as MembershipMode, members: [], note: "Not an explicit channel — admission is by the channel rule, not a member list." };
      const rows = await d.select().from(messageChannelMembers).where(eq(messageChannelMembers.channelRef, input.channelRef)).orderBy(asc(messageChannelMembers.joinedAt)).limit(MAX_EXPLICIT_MEMBERS + 50);
      return {
        channelRef: input.channelRef, membershipMode: "explicit" as const,
        members: rows.map(r => ({ userId: r.userId, memberRole: r.memberRole, source: r.source, joinedAt: r.joinedAt, leftAt: r.leftAt, mutedAt: r.mutedAt })),
        note: "A former member stays listed with the date they left; what they were sent stays theirs to read.",
      };
    }),

  /** 0182 — add a person to an explicit channel. `board.manage`, or a moderator or manager of the channel. */
  memberAdd: roleProcedure("board.memberAdd")
    .input(z.object({ channelRef: z.string().min(1).max(64), userId: z.number().int().positive(), memberRole: MEMBER_ROLE.default("member") }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const viewer: Viewer = { userId: ctx.user.id, internal: true, clientRef: null, roles };
      const now = new Date();
      // A manager who is not a member opens the channel through the manage authority, and that is
      // recorded as a membership change, not as reading.
      const opened = await openChannel(d, { channelRef: input.channelRef, tenantId: acting.tenantId, viewer, at: now, moderating: permissionsFor(roles).includes("board.manage") });
      if (opened.row.membershipMode !== "explicit") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Members are named on an explicit channel only; an open channel admits by its rule and a crew channel by its crew" });
      if (opened.channel.archived) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That channel is archived" });
      if (opened.channel.type === "direct") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A direct channel is two people; a third makes a group" });
      await assertMayManageMembers(d, { opened, userId: ctx.user.id, roles });
      await assertUserInScope(input.userId, acting);
      const existing = await explicitRelationship(d, { channelRef: input.channelRef, userId: input.userId, at: now });
      if (existing.standing === "current") return { channelRef: input.channelRef, userId: input.userId, added: false, note: "Already a member." };
      const current = await currentExplicitMembers(d, input.channelRef, now);
      if (current.length >= MAX_EXPLICIT_MEMBERS) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A channel holds at most ${MAX_EXPLICIT_MEMBERS} members` });
      await d.transaction(async tx => {
        await tx.insert(messageChannelMembers).values({ channelRef: input.channelRef, userId: input.userId, memberRole: input.memberRole, source: "manual", joinedAt: now, addedByUserId: ctx.user.id });
        await channelEvent(tx, { channelRef: input.channelRef, tenantId: acting.tenantId, eventType: "member_added", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: input.userId, detail: input.memberRole, at: now });
        await enqueueBoardEvent(tx, {
          eventType: "board.member.added", aggregateType: "messageChannel", aggregateId: input.channelRef, transition: `member:${input.userId}:${now.getTime()}`,
          tenantId: acting.tenantId, actorUserId: ctx.user.id, occurredAt: now,
          payload: { recipientUserIds: [input.userId], title: `Added to ${opened.channel.name}`, line: `You were added to ${opened.channel.name} as ${input.memberRole}.`, deepLink: `/board/${input.channelRef}`, refs: { channelRef: input.channelRef } },
        });
      });
      return { channelRef: input.channelRef, userId: input.userId, added: true, note: "Added. A new member does not inherit the conversation before they joined." };
    }),

  /** 0182 — end a membership. The row stays; what they were sent stays theirs. A person may leave on their own. */
  memberRemove: roleProcedure("board.memberRemove")
    .input(z.object({ channelRef: z.string().min(1).max(64), userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const viewer: Viewer = { userId: ctx.user.id, internal: true, clientRef: null, roles };
      const now = new Date();
      const opened = await openChannel(d, { channelRef: input.channelRef, tenantId: acting.tenantId, viewer, at: now, moderating: permissionsFor(roles).includes("board.manage") });
      if (opened.row.membershipMode !== "explicit") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Members are named on an explicit channel only" });
      if (input.userId !== ctx.user.id) await assertMayManageMembers(d, { opened, userId: ctx.user.id, roles });
      const live = (await d.select().from(messageChannelMembers).where(and(
        eq(messageChannelMembers.channelRef, input.channelRef), eq(messageChannelMembers.userId, input.userId), isNull(messageChannelMembers.leftAt),
      )).limit(1))[0];
      if (!live) return { channelRef: input.channelRef, userId: input.userId, removed: false, note: "Not a current member." };
      await d.transaction(async tx => {
        await tx.update(messageChannelMembers).set({ leftAt: now }).where(eq(messageChannelMembers.id, live.id));
        await channelEvent(tx, { channelRef: input.channelRef, tenantId: acting.tenantId, eventType: "member_left", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: input.userId, detail: input.userId === ctx.user.id ? "left" : "removed", at: now });
      });
      return { channelRef: input.channelRef, userId: input.userId, removed: true, note: "Membership ended. The record stays: what they were sent stays theirs to read, and nothing after this reaches them." };
    }),

  /**
   * 0182 — the caller's inbox: every channel they may open, with what is waiting on them.
   * Open channels by the channel rule, crew channels by membership, explicit channels by a row.
   */
  mine: roleProcedure("board.mine")
    .query(async ({ ctx }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const now = new Date();
      const all = await d.select().from(messageChannels).where(and(eq(messageChannels.tenantId, acting.tenantId), eq(messageChannels.archived, false))).orderBy(desc(messageChannels.id)).limit(500);
      const out: { channelRef: string; type: string; name: string; membershipMode: string; jobRef: string | null; unacknowledged: number }[] = [];
      const viewer: Viewer = { userId: ctx.user.id, internal: true, clientRef: null, roles };
      for (const row of all) {
        if (row.type === "client") continue;
        try {
          await openChannel(d, { channelRef: row.channelRef, tenantId: acting.tenantId, viewer, at: now });
        } catch (e) {
          if (e instanceof TRPCError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND")) continue;
          throw e;
        }
        out.push({ channelRef: row.channelRef, type: row.type, name: row.name, membershipMode: row.membershipMode, jobRef: row.jobRef ?? null, unacknowledged: 0 });
      }
      if (out.length) {
        const waiting = await d.select({ channelRef: boardMessages.channelRef }).from(messageReceipts)
          .innerJoin(boardMessages, eq(boardMessages.messageRef, messageReceipts.messageRef))
          .where(and(
            eq(messageReceipts.userId, ctx.user.id), isNull(messageReceipts.acknowledgedAt), eq(boardMessages.requiresAcknowledgement, true), isNull(boardMessages.withdrawnAt),
            inArray(boardMessages.channelRef, out.map(o => o.channelRef)),
          )).limit(2000);
        for (const w of waiting) { const o = out.find(x => x.channelRef === w.channelRef); if (o) o.unacknowledged++; }
      }
      return { channels: out, note: "Unacknowledged counts the bulletins waiting on you, not the messages you have not read." };
    }),

  /**
   * Post a message.
   *
   * `deviceCreatedAt` comes from the caller because only the device knows when
   * it happened; `serverReceivedAt` is stamped here. A queued message posted
   * three hours later keeps both.
   *
   * 0182 — `clientMutationId` with `deviceId` is the replay identity: the same
   * pair twice returns the message written the first time.
   */
  post: roleProcedure("board.post")
    .input(z.object({
      channelRef: z.string().min(1).max(64),
      body: z.string().min(1).max(4000),
      priority: z.enum(["normal", "important", "urgent", "emergency"]).default("normal"),
      deviceCreatedAt: z.coerce.date(),
      deviceId: z.string().max(64).optional(),
      clientMutationId: z.string().min(1).max(64).optional(),
      position: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
      recipients: z.array(z.number().int().positive()).max(500).default([]),
      attachments: z.array(z.object({ kind: z.string().max(40), objectRef: z.string().min(1).max(120) })).max(MAX_ATTACHMENTS).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const viewer: Viewer = { userId: ctx.user.id, internal: true, clientRef: null, roles };
      // One timestamp for one conceptual act: membership in force, the
      // message's server clock, and every receipt's acceptance all use it.
      const acceptedAt = new Date();
      const opened = await openChannel(d, { channelRef: input.channelRef, tenantId: acting.tenantId, viewer, at: acceptedAt });
      if (opened.channel.archived) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That channel is archived" });

      // A retry from a device is answered with what it already wrote, before anything else runs.
      if (input.deviceId && input.clientMutationId) {
        const prior = (await d.select().from(boardMessages).where(and(
          eq(boardMessages.deviceId, input.deviceId), eq(boardMessages.clientMutationId, input.clientMutationId),
        )).limit(1))[0];
        if (prior) {
          if (prior.authorUserId !== ctx.user.id || prior.channelRef !== input.channelRef) throw new TRPCError({ code: "CONFLICT", message: "That client mutation id was already used by this device for a different message" });
          return { messageRef: prior.messageRef, requiresAcknowledgement: prior.requiresAcknowledgement, senderLabel: senderLabel("accepted"), lagSeconds: 0, replayed: true as const, note: "Already recorded; a retried post is one post." };
        }
      }

      const channelRow = opened.row;
      const channelType = opened.channel.type;
      // Publishing is not posting. Derived from priority and channel, never from what the poster asked for.
      if (requiresPublishAuthority(channelType, input.priority as Priority) && !permissionsFor(roles).includes("board.publish")) {
        throw new TRPCError({ code: "FORBIDDEN", message: input.priority === "emergency" ? "An emergency is published, not posted — that takes board.publish" : `Posting into a ${channelType} channel is publishing — that takes board.publish` });
      }
      let recipients = input.recipients;

      if (channelRow.crewRef) {
        if (input.recipients.length) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Crew recipients are derived from current membership" });
        }
        const rel = opened.crew!;
        if (rel.crew.state !== "active") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${rel.crew.name} is ${rel.crew.state} — the conversation is part of the job record now` });
        }
        if (rel.standing !== "current" || !rel.current) throw new TRPCError({ code: "FORBIDDEN", message: "Not a current member of this crew" });
        if (!crewPermissions(rel.current.crewRole).includes("crew.post")) {
          throw new TRPCError({ code: "FORBIDDEN", message: `A ${rel.current.crewRole} in this crew may read and not post` });
        }
        // Ask for one more than we support, so a crew at the boundary is
        // refused rather than silently redefined as its first 500 members.
        const all = await d.select().from(crewMembers).where(eq(crewMembers.crewRef, channelRow.crewRef)).limit(MAX_CREW_AUDIENCE + 1);
        const current = all.map(toMember).filter(m => isCurrentMember(m, acceptedAt));
        if (all.length > MAX_CREW_AUDIENCE) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `This crew exceeds the ${MAX_CREW_AUDIENCE}-member audience this board records. Refusing rather than sending to an arbitrary subset and calling it the audience.`,
          });
        }
        recipients = current.map(m => m.userId);
      } else if (opened.member) {
        // 0182 — an explicit channel's audience is its current members, exactly as a crew's is.
        if (input.recipients.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Recipients of an explicit channel are derived from current membership" });
        if (opened.member.standing !== "current" || !opened.member.current) throw new TRPCError({ code: "FORBIDDEN", message: "Not a current member of this channel" });
        if (!memberMayPost(opened.member.current.memberRole)) throw new TRPCError({ code: "FORBIDDEN", message: "This channel role may read and not post" });
        recipients = (await currentExplicitMembers(d, channelRow.channelRef, acceptedAt)).map(m => m.userId);
      } else if (channelType === "announcement" && !input.recipients.length) {
        // 0182 — an announcement with nobody to acknowledge it has no roll-call. The organization's
        // membership is the audience when the caller named none; the single tenant has no
        // membership table to resolve from and is refused rather than guessed.
        recipients = await organizationAudience(d, acting, acceptedAt);
      }
      const audienceRefusal = announcementAudienceRefusal(channelType, recipients.length);
      if (audienceRefusal) throw new TRPCError({ code: "PRECONDITION_FAILED", message: audienceRefusal });
      for (const userId of Array.from(new Set(recipients))) {
        // Every named recipient is one of the organization's own; a stranger's id is not found.
        if (!channelRow.crewRef && !opened.member) await assertUserInScope(userId, acting);
      }
      recipients = Array.from(new Set(recipients));

      // Every attachment is resolved before a single row is written. Validating
      // as we go would leave a message saved with the attachments that happened
      // to come before the forbidden one.
      const resolved: { kind: string; objectRef: string }[] = [];
      for (const a of input.attachments) {
        if (channelRow.clientRef) {
          // A client channel has no external authorization path for internal
          // records, so nothing is attachable there rather than everything.
          throw new TRPCError({ code: "FORBIDDEN", message: "Attachments are not available on a client channel: there is no client-side authorization path for internal records" });
        }
        // Roles are not permissions. Passing role names here compared "dispatcher"
        // against "job.read" and refused everything, indistinguishably from a
        // missing record — which is the disclosure rule working and the bug
        // hiding behind it.
        const check = await mayAttach(d, { kind: a.kind, objectRef: a.objectRef, heldPermissions: permissionsFor(roles) });
        if (!check.ok) {
          throw new TRPCError({
            code: check.refusal.reason === "not_found" ? "NOT_FOUND" : "FORBIDDEN",
            message: check.refusal.message,
          });
        }
        resolved.push({ kind: a.kind, objectRef: a.objectRef });
      }

      const now = acceptedAt;
      const messageRef = ref("MSG");
      const requiresAcknowledgement = ACKNOWLEDGEMENT_REQUIRED.includes(input.priority as Priority);
      // The message and its audience are one fact. A body committed with half
      // its receipts would be a historical audience record that never happened.
      try {
        await d.transaction(async (tx) => {
          await tx.insert(boardMessages).values({
            messageRef, channelRef: input.channelRef, authorUserId: ctx.user.id,
            authorRole: roles[0] ?? "user",
            priority: input.priority, body: input.body,
            latitude: input.position ? String(input.position.latitude) : null,
            longitude: input.position ? String(input.position.longitude) : null,
            deviceCreatedAt: input.deviceCreatedAt,
            serverReceivedAt: acceptedAt,
            deviceId: input.deviceId ?? null,
            clientMutationId: input.deviceId ? input.clientMutationId ?? null : null,
            requiresAcknowledgement,
          });
          for (const a of resolved) {
            await tx.insert(messageAttachments).values({
              attachmentRef: ref("ATT"), messageRef, kind: a.kind, objectRef: a.objectRef,
              attachedByUserId: ctx.user.id, attachedAt: acceptedAt,
            });
          }
          for (const userId of recipients) {
            await tx.insert(messageReceipts).values({ messageRef, userId, state: "accepted", acceptedAt });
          }
          if (input.priority === "emergency") {
            await channelEvent(tx, { channelRef: input.channelRef, tenantId: acting.tenantId, eventType: "emergency_posted", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), messageRef, detail: `${recipients.length} recipient(s)`, at: now });
          }
          if (requiresAcknowledgement && recipients.length) {
            // Refs and a line, never the body: the outbox row is readable by every consumer.
            await enqueueBoardEvent(tx as Tx, {
              eventType: "message.critical.created", aggregateType: "boardMessage", aggregateId: messageRef, transition: "created",
              tenantId: acting.tenantId, actorUserId: ctx.user.id, occurredAt: now, jobId: channelRow.jobRef ?? null,
              payload: { recipientUserIds: recipients, title: `${input.priority === "emergency" ? "Emergency" : "Urgent"} — ${opened.channel.name}`, line: "A bulletin requires your acknowledgement.", deepLink: `/board/${input.channelRef}/${messageRef}`, refs: { channelRef: input.channelRef, messageRef, priority: input.priority } },
            });
          }
        });
      } catch (e) {
        // The replay key is unique: a concurrent retry from the same device won the race. Answer
        // with what it wrote rather than a duplicate-key error.
        const dup = input.deviceId && input.clientMutationId
          ? (await d.select().from(boardMessages).where(and(eq(boardMessages.deviceId, input.deviceId), eq(boardMessages.clientMutationId, input.clientMutationId))).limit(1))[0]
          : undefined;
        if (dup && dup.authorUserId === ctx.user.id) {
          return { messageRef: dup.messageRef, requiresAcknowledgement: dup.requiresAcknowledgement, senderLabel: senderLabel("accepted"), lagSeconds: 0, replayed: true as const, note: "Already recorded; a retried post is one post." };
        }
        throw e;
      }
      const lagSeconds = Math.max(0, Math.round((now.getTime() - input.deviceCreatedAt.getTime()) / 1000));
      return {
        messageRef, requiresAcknowledgement,
        senderLabel: senderLabel("accepted"),
        lagSeconds,
        replayed: false as const,
        note: lagSeconds > 60
          ? `Recorded on the device ${Math.round(lagSeconds / 60)} min before it reached the server. Both times are kept.`
          : "Posted.",
      };
    }),

  /** Messages in a channel, oldest first, with both clocks intact. */
  read: roleProcedure("board.read")
    .input(z.object({ channelRef: z.string().min(1).max(64), asClientRef: z.string().max(64).optional() }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const viewer: Viewer = input.asClientRef
        ? { userId: ctx.user.id, internal: false, clientRef: input.asClientRef, roles: [] }
        : { userId: ctx.user.id, internal: true, clientRef: null, roles: await listActiveUserRoleNames(ctx.user.id) };
      // Admission — including the crew and membership boundaries — happens here,
      // before any message content is loaded. openChannel owns that now.
      const { channel, crew, member } = await openChannel(d, { channelRef: input.channelRef, tenantId: acting.tenantId, viewer });
      // Then the narrower question, answered by the audience actually recorded
      // when each message was accepted: a person who joined today does not
      // inherit yesterday's conversation, and one who left keeps what they were
      // sent. Resolved below against the candidate messages, so an unrelated
      // receipt elsewhere cannot push a message in this channel out of view.
      let audienceOnly: Set<string> | null = crew || member ? new Set<string>() : null;

      const rows = await d.select().from(boardMessages)
        .where(and(eq(boardMessages.channelRef, input.channelRef), isNull(boardMessages.withdrawnAt)))
        .orderBy(asc(boardMessages.deviceCreatedAt)).limit(200);
      if (audienceOnly) {
        const refs = rows.map(m => m.messageRef);
        const mine = refs.length
          ? await d.select({ messageRef: messageReceipts.messageRef }).from(messageReceipts)
              .where(and(eq(messageReceipts.userId, ctx.user.id), inArray(messageReceipts.messageRef, refs)))
          : [];
        audienceOnly = new Set(mine.map(r => r.messageRef));
      }
      const visible = audienceOnly ? rows.filter(m => audienceOnly!.has(m.messageRef)) : rows;
      // One query for every returned message, then the reader's own
      // authorization per reference — the sender's does not travel with it.
      const attachmentRows = visible.length
        ? await d.select().from(messageAttachments).where(inArray(messageAttachments.messageRef, visible.map(m => m.messageRef)))
        : [];
      const readerRoles = await listActiveUserRoleNames(ctx.user.id);
      const byMessage = new Map<string, { visible: boolean; kind: string; objectRef?: string; deepLink?: string; note?: string }[]>();
      for (const row of attachmentRows) {
        const view = await viewFor(d, { kind: row.kind, objectRef: row.objectRef, heldPermissions: permissionsFor(readerRoles) });
        byMessage.set(row.messageRef, [...(byMessage.get(row.messageRef) ?? []), view]);
      }

      return {
        channelRef: channel.channelRef,
        supportedAttachmentKinds: supportedKinds(),
        messages: visible.map(m => ({
          attachments: byMessage.get(m.messageRef) ?? [],
          messageRef: m.messageRef, authorUserId: m.authorUserId, priority: m.priority, body: m.body,
          deviceCreatedAt: m.deviceCreatedAt, serverReceivedAt: m.serverReceivedAt,
          requiresAcknowledgement: m.requiresAcknowledgement,
        })),
        note: "Device time is when it happened; server time is when it arrived. Both are shown because they are different facts.",
      };
    }),

  /** Mark that it appeared on screen. Not the same as accepting it. */
  open: roleProcedure("board.open")
    .input(z.object({ messageRef: z.string().min(1).max(64), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const r = await advanceReceipt(d, { messageRef: input.messageRef, userId: ctx.user.id, evidence: { to: "opened" }, at: input.at });
      return r.moved
        ? { messageRef: input.messageRef, state: r.state, note: "Opened. Opening is not acknowledging." }
        : { messageRef: input.messageRef, state: r.state, note: "Already past opened; a receipt does not go backwards." };
    }),

  /**
   * Say you have it. Only the recipient can, for their own receipt.
   *
   * 0182 — `deviceAcknowledgedAt` is the device's clock; the server's own stamp is the audit time.
   * Naturally idempotent: a second acknowledgement moves nothing and says so.
   */
  acknowledge: roleProcedure("board.acknowledge")
    .input(z.object({ messageRef: z.string().min(1).max(64), at: z.coerce.date().default(() => new Date()), deviceAcknowledgedAt: z.coerce.date().optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const serverAt = new Date();
      const r = await advanceReceipt(d, {
        messageRef: input.messageRef, userId: ctx.user.id,
        // The recipient is `ctx.user.id`; the engine refuses anybody else.
        evidence: { to: "acknowledged", byUserId: ctx.user.id }, at: input.deviceAcknowledgedAt ? serverAt : input.at,
        deviceAt: input.deviceAcknowledgedAt ?? null,
      });
      if (r.moved) {
        const message = (await d.select({ channelRef: boardMessages.channelRef, priority: boardMessages.priority, authorUserId: boardMessages.authorUserId }).from(boardMessages).where(eq(boardMessages.messageRef, input.messageRef)).limit(1))[0];
        if (message && ACKNOWLEDGEMENT_REQUIRED.includes(message.priority as Priority)) {
          const acting = await resolveActingScope(d, ctx.user.id);
          await d.transaction(async tx => {
            await enqueueBoardEvent(tx as Tx, {
              eventType: "message.acknowledged", aggregateType: "boardMessage", aggregateId: input.messageRef, transition: `acknowledged:${ctx.user.id}`,
              tenantId: acting.tenantId, actorUserId: ctx.user.id, occurredAt: serverAt,
              payload: { recipientUserIds: [], title: "Acknowledged", line: `${input.messageRef} acknowledged by ${ctx.user.id}`, deepLink: `/board/${message.channelRef}/${input.messageRef}`, refs: { messageRef: input.messageRef, userId: ctx.user.id } },
            });
          });
        }
      }
      return r.moved
        ? { messageRef: input.messageRef, state: r.state, note: "Acknowledged." }
        : { messageRef: input.messageRef, state: r.state, note: "Already acknowledged." };
    }),

  /**
   * The whole history of a message.
   *
   * Revision 1 is the original body on the message row; later revisions are
   * stored separately, so there is one writable original and the two cannot
   * disagree.
   */
  history: roleProcedure("board.history")
    .input(z.object({ messageRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const { message } = await messageForCaller(d, ctx.user.id, input.messageRef);
      const later = await d.select().from(messageRevisions)
        .where(eq(messageRevisions.messageRef, input.messageRef)).orderBy(asc(messageRevisions.revision)).limit(100);
      const history: MessageHistory = {
        messageRef: message.messageRef,
        revisions: [
          originalRevision(message),
          ...later.map(r => ({ revision: r.revision, body: r.body, editedByUserId: r.editedByUserId, at: r.editedAt, reason: r.reason })),
        ],
        withdrawnAt: message.withdrawnAt, withdrawnByUserId: message.withdrawnByUserId,
      };
      return {
        messageRef: message.messageRef,
        originalBody: originalBody(history),
        currentBody: currentBody(history),
        edited: history.revisions.length > 1,
        revisionCount: history.revisions.length,
        revisions: history.revisions,
        withdrawnAt: message.withdrawnAt,
        // 0096's clocks are untouched by anything here.
        deviceCreatedAt: message.deviceCreatedAt, serverReceivedAt: message.serverReceivedAt,
        note: "Revision 1 is what recipients originally acted on and is never rewritten.",
      };
    }),

  /** Edit your own message. Appends; never overwrites. */
  edit: roleProcedure("board.edit")
    .input(z.object({
      messageRef: z.string().min(1).max(64),
      body: z.string().min(1).max(4000),
      reason: z.string().max(600).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const { message } = await messageForCaller(d, ctx.user.id, input.messageRef, { mutating: true });
      if (message.authorUserId !== ctx.user.id) {
        // Being able to post is not being able to rewrite somebody else's words.
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the author edits their own message. Moderation is a separate authority, not a wider reading of posting." });
      }
      if (message.withdrawnAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That message is withdrawn; it is not edited afterwards" });

      const later = await d.select().from(messageRevisions).where(eq(messageRevisions.messageRef, input.messageRef)).limit(100);
      const history: MessageHistory = {
        messageRef: message.messageRef,
        revisions: [
          originalRevision(message),
          ...later.sort((a2, b2) => a2.revision - b2.revision).map(r => ({ revision: r.revision, body: r.body, editedByUserId: r.editedByUserId, at: r.editedAt, reason: r.reason })),
        ],
        withdrawnAt: null, withdrawnByUserId: null,
      };
      const next = edit(history, input.body, ctx.user.id, input.at, input.reason ?? null);
      const added = next.revisions[next.revisions.length - 1];
      await d.insert(messageRevisions).values({
        messageRef: input.messageRef, revision: added.revision, body: added.body,
        editedByUserId: ctx.user.id, editedAt: input.at, reason: input.reason ?? null,
      });
      return { messageRef: input.messageRef, revision: added.revision, note: "Appended. The original stays readable — it is what recipients acted on." };
    }),

  /** Withdraw your own message. The text stays; it no longer stands. */
  withdraw: roleProcedure("board.withdraw")
    .input(z.object({ messageRef: z.string().min(1).max(64), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const { message } = await messageForCaller(d, ctx.user.id, input.messageRef, { mutating: true });
      if (message.authorUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the author withdraws their own message. Removing the force of somebody else's is moderation, a separate authority." });
      }
      if (message.withdrawnAt) return { messageRef: input.messageRef, note: "Already withdrawn." };
      const history: MessageHistory = { messageRef: message.messageRef, revisions: [originalRevision(message)], withdrawnAt: null, withdrawnByUserId: null };
      const next = withdraw(history, ctx.user.id, input.at);
      await d.update(boardMessages).set({ withdrawnAt: next.withdrawnAt, withdrawnByUserId: ctx.user.id })
        .where(eq(boardMessages.messageRef, input.messageRef));
      return { messageRef: input.messageRef, note: "Withdrawn. Nothing is deleted: the text and every revision remain readable as history." };
    }),

  /**
   * 0182 — moderation, the one way into a conversation the caller is not in.
   *
   * Sensitive, and never silent: the read is a `moderator_read` event on the
   * channel, naming who, when and why, before a single message is returned.
   */
  moderateRead: roleProcedure("board.moderateRead")
    .input(z.object({ channelRef: z.string().min(1).max(64), reason: z.string().min(10).max(600) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const viewer: Viewer = { userId: ctx.user.id, internal: true, clientRef: null, roles: [...roles, "management"] };
      const now = new Date();
      const opened = await openChannel(d, { channelRef: input.channelRef, tenantId: acting.tenantId, viewer, at: now, moderating: true });
      await channelEvent(d, { channelRef: input.channelRef, tenantId: acting.tenantId, eventType: "moderator_read", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), detail: input.reason, at: now });
      const rows = await d.select().from(boardMessages).where(eq(boardMessages.channelRef, input.channelRef)).orderBy(asc(boardMessages.deviceCreatedAt)).limit(200);
      return {
        channelRef: opened.channel.channelRef, membershipMode: opened.row.membershipMode as MembershipMode,
        messages: rows.map(m => ({ messageRef: m.messageRef, authorUserId: m.authorUserId, priority: m.priority, body: m.body, deviceCreatedAt: m.deviceCreatedAt, serverReceivedAt: m.serverReceivedAt, withdrawnAt: m.withdrawnAt })),
        note: "This read is recorded on the channel as a moderation act. The members can see that it happened.",
      };
    }),

  /** 0182 — withdraw somebody else's message as a moderator. Recorded on the channel; nothing is deleted. */
  moderateWithdraw: roleProcedure("board.moderateWithdraw")
    .input(z.object({ messageRef: z.string().min(1).max(64), reason: z.string().min(10).max(600), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const { message, acting } = await messageForCaller(d, ctx.user.id, input.messageRef, { moderating: true });
      if (message.withdrawnAt) return { messageRef: input.messageRef, note: "Already withdrawn." };
      const history: MessageHistory = { messageRef: message.messageRef, revisions: [originalRevision(message)], withdrawnAt: null, withdrawnByUserId: null };
      const next = withdraw(history, ctx.user.id, input.at);
      await d.transaction(async tx => {
        await tx.update(boardMessages).set({ withdrawnAt: next.withdrawnAt, withdrawnByUserId: ctx.user.id }).where(eq(boardMessages.messageRef, input.messageRef));
        await channelEvent(tx, { channelRef: message.channelRef, tenantId: acting.tenantId, eventType: "moderator_withdraw", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: message.authorUserId, messageRef: input.messageRef, detail: input.reason, at: input.at });
      });
      return { messageRef: input.messageRef, note: "Withdrawn by moderation and recorded as such. The text and every revision remain readable as history." };
    }),

  /** Who has actually accepted a bulletin, and who only looked at it. */
  acknowledgements: roleProcedure("board.acknowledgements")
    .input(z.object({ messageRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      // Through the same door as every other messageRef path. This one names
      // who received and who acknowledged, so an unscoped answer is a roster
      // leak, not merely an over-share.
      const { message } = await messageForCaller(d, ctx.user.id, input.messageRef);

      const rows = await d.select().from(messageReceipts).where(eq(messageReceipts.messageRef, input.messageRef)).limit(MAX_CREW_AUDIENCE);
      const receipts = rows.map(rowToReceipt);
      return acknowledgementStatus(input.messageRef, message.requiresAcknowledgement, receipts);
    }),
});

