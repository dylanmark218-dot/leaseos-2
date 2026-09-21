/**
 * v22.20 (0096) — the board, reachable.
 *
 * `_core/messageBoard.ts` and `_core/messageLifecycle.ts` hold the rules; this
 * stores and serves. Four things it is responsible for.
 *
 * **Access is decided on the channel.** An outside viewer is refused before any
 * message is read, not filtered out of a list afterwards.
 *
 * **Both clocks are kept.** The device's time arrives with the message; the
 * server stamps its own alongside. Neither overwrites the other.
 *
 * **Acknowledgement is derived from priority**, so an urgent bulletin cannot be
 * posted as something people may ignore.
 *
 * **A receipt advances forward only, on evidence.** Opening is not
 * acknowledging, and the sender is never shown "delivered" for something that
 * is still on a server.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, listActiveUserRoleNames } from "./db";
import { boardMessages, crewMembers, crews, messageAttachments, messageChannels, messageReceipts, messageRevisions } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";
import { mayAttach, supportedKinds, viewFor } from "./_core/attachmentAuthorizers";
import { permissionsFor } from "./_core/recordsAuthorization";
import { crewPermissions, isCurrentMember, type CrewMember, type CrewRole } from "./_core/crewChannels";
import type { DbOrTx } from "./_core/dbTypes";
import { ACKNOWLEDGEMENT_REQUIRED, mayOpen, type Channel, type Priority, type Viewer } from "./_core/messageBoard";
import { acknowledgementStatus } from "./_core/messageBoard";
import { advance, currentBody, edit, originalBody, ReceiptRegression, senderLabel, withdraw,
  type Evidence, type MessageHistory, type Receipt, type ReceiptState , type Revision } from "./_core/messageLifecycle";

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
 */
async function advanceReceipt(d: DbOrTx, args: { messageRef: string; userId: number; evidence: Evidence; at: Date }) {
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

const CHANNEL_TYPE = z.enum(["announcement", "dispatch", "safety", "maintenance", "field_operations", "road_conditions", "training", "general", "job", "client", "private", "emergency"]);

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

async function openChannel(d: DbOrTx, args: { channelRef: string; tenantId: string; viewer: Viewer; at?: Date }) {
  const row = (await d.select().from(messageChannels).where(eq(messageChannels.channelRef, args.channelRef)).limit(1))[0];
  if (!row || row.tenantId !== args.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such channel" });
  const channel = toChannel(row);
  const access = mayOpen(channel, args.viewer);
  if (!access.allowed) throw new TRPCError({ code: "FORBIDDEN", message: access.reason });

  // The crew boundary belongs here, not in whichever resolver remembered it.
  // It was enforced in read and post and absent from every messageRef path,
  // which made a message reference into a way around the channel.
  if (row.crewRef) {
    if (!args.viewer.internal) throw new TRPCError({ code: "FORBIDDEN", message: "Internal channel — not visible outside the company" });
    const crew = await crewRelationship(d, {
      crewRef: row.crewRef, tenantId: args.tenantId, userId: args.viewer.userId, at: args.at ?? new Date(),
    });
    return { channel, row, crew };
  }
  return { channel, row, crew: null };
}

/** Resolve a message and check channel access in one place. */
/**
 * A message reference is a locator, never a capability.
 *
 * Knowing MSG-... must grant nothing that opening the channel would not. For a
 * crew message that means two checks, not one: a legitimate relationship to the
 * crew, and having been in the audience actually recorded when the server
 * accepted it. `mutating` adds the third — history is a former member's to
 * read, and not theirs to rewrite.
 */
async function messageForCaller(d: DbOrTx, userId: number, messageRef: string, opts: { mutating?: boolean } = {}) {
  const at = new Date();
  const acting = await resolveActingScope(d, userId);
  const message = (await d.select().from(boardMessages).where(eq(boardMessages.messageRef, messageRef)).limit(1))[0];
  if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "No such message" });
  const viewer: Viewer = { userId, internal: true, clientRef: null, roles: await listActiveUserRoleNames(userId) };
  // On a channelRef path a refusal is fine: the caller named the channel, so
  // they already know it exists. On a messageRef path it is not — "you may not
  // see this crew's message" confirms there is one. Both refusals become the
  // same NOT FOUND here, so possessing a reference reveals nothing.
  let opened;
  try {
    opened = await openChannel(d, { channelRef: message.channelRef, tenantId: acting.tenantId, viewer, at });
  } catch (e) {
    if (e instanceof TRPCError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND")) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such message" });
    }
    throw e;
  }

  if (opened.crew) {
    const receipt = (await d.select().from(messageReceipts).where(and(
      eq(messageReceipts.messageRef, messageRef), eq(messageReceipts.userId, userId),
    )).limit(1))[0];
    // Not FORBIDDEN: telling somebody a message exists that they may not see is
    // itself the disclosure.
    if (!receipt) throw new TRPCError({ code: "NOT_FOUND", message: "No such message" });

    if (opts.mutating) {
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
  }
  return { message, channel: opened.channel, crew: opened.crew };
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

export const messageBoardRouter = router({
  createChannel: roleProcedure("board.createChannel")
    .input(z.object({
      type: CHANNEL_TYPE,
      name: z.string().min(2).max(220),
      jobRef: z.string().max(64).optional(),
      clientRef: z.string().max(64).optional(),
      crewRef: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
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
      const channelRef = ref("CH");
      await d.insert(messageChannels).values({
        channelRef, tenantId: acting.tenantId, type: input.type, name: input.name,
        jobRef: input.jobRef ?? null, clientRef: input.clientRef ?? null, crewRef: input.crewRef ?? null,
        archived: false, createdByUserId: ctx.user.id,
      });
      return { channelRef, note: input.type === "client" ? "Client channel. Internal channels are not visible to this client and this one is not internal." : "Created." };
    }),

  /**
   * Post a message.
   *
   * `deviceCreatedAt` comes from the caller because only the device knows when
   * it happened; `serverReceivedAt` is stamped here. A queued message posted
   * three hours later keeps both.
   */
  post: roleProcedure("board.post")
    .input(z.object({
      channelRef: z.string().min(1).max(64),
      body: z.string().min(1).max(4000),
      priority: z.enum(["normal", "important", "urgent", "emergency"]).default("normal"),
      deviceCreatedAt: z.coerce.date(),
      deviceId: z.string().max(64).optional(),
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

      const channelRow = opened.row;
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
      }

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
      });
      const lagSeconds = Math.max(0, Math.round((now.getTime() - input.deviceCreatedAt.getTime()) / 1000));
      return {
        messageRef, requiresAcknowledgement,
        senderLabel: senderLabel("accepted"),
        lagSeconds,
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
      // Admission — including the crew boundary — happens here, before any
      // message content is loaded. openChannel owns that now.
      const { channel, row: channelRow, crew } = await openChannel(d, { channelRef: input.channelRef, tenantId: acting.tenantId, viewer });
      // Then the narrower question, answered by the audience actually recorded
      // when each message was accepted: a person who joined today does not
      // inherit yesterday's conversation, and one who left keeps what they were
      // sent. Resolved below against the candidate messages, so an unrelated
      // receipt elsewhere cannot push a message in this channel out of view.
      let audienceOnly: Set<string> | null = crew ? new Set<string>() : null;
      void channelRow;

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

  /** Say you have it. Only the recipient can, for their own receipt. */
  acknowledge: roleProcedure("board.acknowledge")
    .input(z.object({ messageRef: z.string().min(1).max(64), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const r = await advanceReceipt(d, {
        messageRef: input.messageRef, userId: ctx.user.id,
        // The recipient is `ctx.user.id`; the engine refuses anybody else.
        evidence: { to: "acknowledged", byUserId: ctx.user.id }, at: input.at,
      });
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
