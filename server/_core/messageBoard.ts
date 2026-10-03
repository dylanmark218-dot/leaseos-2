/**
 * v22.20 — a message board that turns talk into records, without turning talk
 * into facts.
 *
 * Pure. No network, no database.
 *
 * The thing that makes this worth building rather than using a chat product is
 * **message → action**. A driver saying "my steer tire has wire showing" should
 * be able to become a defect report without anybody retyping it. But the
 * message is not the defect: text is an observation, and an operational record
 * created from it silently would be a compliance fact nobody verified. So a
 * message produces a *proposal*, through the model that already exists for
 * exactly this, and a person completes it.
 *
 * Three other rules.
 *
 * **A client channel is not a company channel.** Not filtered — separated. A
 * message addressed to an internal channel has no path into a client one, and
 * the check is on the channel rather than on each message, because a filter
 * applied per message is a filter somebody eventually forgets.
 *
 * **Read is not acknowledged.** The same distinction the notification ladder
 * already draws, for the same reason: a bulletin that lit up on a phone in
 * somebody's pocket has been delivered and accepted by nobody.
 *
 * **An offline message keeps both clocks.** The device's time is when it
 * happened; the server's is when it arrived. Overwriting the first loses the
 * only record of when the driver actually saw the washout.
 */

import type { EventSource } from "./calendarProjection";
import type { ProposalAction } from "./secretaryCoordination";
import type { Receipt as LifecycleReceipt } from "./messageLifecycle";

export type ChannelType =
  | "announcement" | "dispatch" | "safety" | "maintenance" | "field_operations"
  | "road_conditions" | "training" | "general" | "job" | "client" | "private" | "emergency"
  // 0205 — conversations between named people, a department, a unit, a shift.
  | "direct" | "group" | "department" | "unit" | "shift";

export type Channel = {
  channelRef: string;
  type: ChannelType;
  name: string;
  /** A job channel carries its job; a client channel carries its client. */
  jobRef: string | null;
  clientRef: string | null;
  archived: boolean;
};

/** Channels a person outside the company may ever see. */
export const EXTERNAL_CHANNEL_TYPES: readonly ChannelType[] = ["client"];

export type Priority = "normal" | "important" | "urgent" | "emergency";

/** Priorities that demand a name against them rather than a glance. */
export const ACKNOWLEDGEMENT_REQUIRED: readonly Priority[] = ["urgent", "emergency"];

/**
 * The lifecycle owns receipt state. This module had its own five-value
 * vocabulary until v22.20 (0097); two vocabularies meant a translation table in
 * the router, and a translation table between two models of the same fact is a
 * place for them to disagree. Re-exported so existing readers find it here.
 */
export type { Receipt, ReceiptState } from "./messageLifecycle";

export type Message = {
  messageRef: string;
  channelRef: string;
  authorUserId: number;
  authorRole: string;
  priority: Priority;
  body: string;
  /** Where the driver was, when they can give it. */
  position: { latitude: number; longitude: number } | null;
  /** When the device recorded it. Never overwritten by the server's clock. */
  deviceCreatedAt: Date;
  /** When it reached the server. Null while it is still on a tablet. */
  serverReceivedAt: Date | null;
  deviceId: string | null;
  requiresAcknowledgement: boolean;
  /** Records this message points at. References, never copies. */
  attachedRefs: readonly EventSource[];
};

export class ChannelViolation extends Error {}

/**
 * Post a message.
 *
 * `requiresAcknowledgement` is derived from priority rather than chosen, so an
 * urgent bulletin cannot be posted as something people may ignore.
 */
export function post(args: {
  messageRef: string; channel: Channel; authorUserId: number; authorRole: string;
  priority: Priority; body: string; deviceCreatedAt: Date;
  serverReceivedAt?: Date | null; deviceId?: string | null;
  position?: { latitude: number; longitude: number } | null;
  attachedRefs?: readonly EventSource[];
}): Message {
  if (args.channel.archived) throw new ChannelViolation(`${args.channel.channelRef} is archived`);
  if (args.channel.type === "client" && !args.channel.clientRef) {
    throw new ChannelViolation(`${args.channel.channelRef} is a client channel and names no client`);
  }
  return {
    messageRef: args.messageRef, channelRef: args.channel.channelRef,
    authorUserId: args.authorUserId, authorRole: args.authorRole,
    priority: args.priority, body: args.body,
    position: args.position ?? null,
    deviceCreatedAt: args.deviceCreatedAt,
    serverReceivedAt: args.serverReceivedAt ?? null,
    deviceId: args.deviceId ?? null,
    requiresAcknowledgement: ACKNOWLEDGEMENT_REQUIRED.includes(args.priority),
    attachedRefs: args.attachedRefs ?? [],
  };
}

/** The state of one message for one recipient. */
export type AcknowledgementStatus = {
  messageRef: string;
  required: boolean;
  acknowledged: number[];
  /** Opened and not acknowledged. The group a supervisor actually chases. */
  readNotAcknowledged: number[];
  neverDelivered: number[];
  outstanding: boolean;
  line: string;
};

/**
 * Who has actually accepted a bulletin.
 *
 * Reading it does not count, and the people who read it without acknowledging
 * are listed separately from those it never reached — they are different
 * problems with different fixes.
 */
export function acknowledgementStatus(messageRef: string, required: boolean, receipts: readonly LifecycleReceipt[]): AcknowledgementStatus {
  // Read from the evidence timestamps, never from the state name. A receipt
  // that has reached `resolved` was acknowledged on the way, and translating
  // `resolved` back to `acknowledged` to discover that would be inventing a
  // lossy mapping to answer a question the timestamps already answer.
  const mine = receipts.filter(r => r.messageRef === messageRef);
  const acknowledged = mine.filter(r => r.at.acknowledged).map(r => r.userId);
  const readNotAcknowledged = mine.filter(r => !r.at.acknowledged && r.at.opened).map(r => r.userId);
  const neverDelivered = mine.filter(r => !r.at.delivered).map(r => r.userId);
  const outstanding = required && acknowledged.length < mine.length;
  return {
    messageRef, required, acknowledged, readNotAcknowledged, neverDelivered, outstanding,
    line: !required
      ? `${acknowledged.length} of ${mine.length} acknowledged (not required)`
      : outstanding
        ? `${acknowledged.length} of ${mine.length} acknowledged — ${readNotAcknowledged.length} read without acknowledging, ${neverDelivered.length} never reached`
        : `all ${mine.length} acknowledged`,
  };
}

/* ------------------------------------------------------------------ */
/* A client sees a client channel and nothing else                      */
/* ------------------------------------------------------------------ */

export type Viewer = { userId: number; internal: boolean; clientRef: string | null; roles: readonly string[] };

export type ChannelAccess = { allowed: boolean; reason: string };

/**
 * Whether a viewer may open a channel.
 *
 * The check is on the channel, not on each message. A per-message filter is one
 * somebody eventually forgets to apply, and the failure is a customer reading
 * an internal conversation about their own dispute.
 */
export function mayOpen(channel: Channel, viewer: Viewer): ChannelAccess {
  if (!viewer.internal) {
    if (!EXTERNAL_CHANNEL_TYPES.includes(channel.type)) {
      return { allowed: false, reason: "Internal channel — not visible outside the company" };
    }
    if (!channel.clientRef || channel.clientRef !== viewer.clientRef) {
      return { allowed: false, reason: "This channel belongs to a different client" };
    }
    return { allowed: true, reason: `Client channel for ${channel.clientRef}` };
  }
  if (channel.type === "private" && !viewer.roles.includes("management")) {
    return { allowed: false, reason: "Private management channel" };
  }
  return { allowed: true, reason: "Internal viewer" };
}

/* ------------------------------------------------------------------ */
/* Message becomes a proposal, never a record                           */
/* ------------------------------------------------------------------ */

export type SuggestedAction = {
  action: ProposalAction | "create_defect" | "create_incident" | "add_route_hazard" | "create_work_order";
  title: string;
  /** The words that prompted it, kept verbatim — the driver's account, not a summary. */
  fromMessage: string;
  messageRef: string;
  /** Always. A message proposes; a person completes. */
  performed: false;
  note: string;
};

/**
 * What a message might be asking for.
 *
 * Deliberately conservative: a suggestion that misfires costs one dismissal,
 * and a suggestion that silently created a defect report would put a made-up
 * mechanical record into a compliance history. The driver's own words are
 * carried through so whoever completes it sees what was actually said rather
 * than an interpretation.
 */
export function suggestActions(message: Message, hints: readonly { pattern: RegExp; action: SuggestedAction["action"]; title: string }[]): SuggestedAction[] {
  return hints
    .filter(h => h.pattern.test(message.body))
    .map(h => ({
      action: h.action, title: h.title,
      fromMessage: message.body, messageRef: message.messageRef,
      performed: false,
      note: "Suggested from a message. Nothing is created until somebody completes the record — the message is an observation, not a finding.",
    }));
}

/* ------------------------------------------------------------------ */
/* Emergency broadcast                                                  */
/* ------------------------------------------------------------------ */

export type BroadcastTarget =
  | { kind: "company" }
  | { kind: "branch"; branchRef: string }
  | { kind: "job"; jobRef: string }
  | { kind: "units"; unitRefs: readonly string[] };

export type Broadcast = {
  message: Message;
  target: BroadcastTarget;
  /** Stays on screen until somebody with authority clears it. */
  pinnedUntilCleared: true;
  clearedAt: Date | null;
  clearedByUserId: number | null;
};

export function broadcast(args: { message: Message; target: BroadcastTarget }): Broadcast {
  if (args.message.priority !== "emergency") {
    throw new ChannelViolation("A broadcast is an emergency message; anything less goes to a channel");
  }
  return { message: args.message, target: args.target, pinnedUntilCleared: true, clearedAt: null, clearedByUserId: null };
}

/** Whether a broadcast reaches somebody, from the target it declares. */
export function broadcastReaches(target: BroadcastTarget, person: { branchRef: string | null; jobRefs: readonly string[]; unitRef: string | null }): boolean {
  switch (target.kind) {
    case "company": return true;
    case "branch": return person.branchRef === target.branchRef;
    case "job": return person.jobRefs.includes(target.jobRef);
    case "units": return person.unitRef != null && target.unitRefs.includes(person.unitRef);
  }
}

/* ------------------------------------------------------------------ */
/* 0205 — membership: who may open an explicit channel                  */
/* ------------------------------------------------------------------ */

/**
 * How a person is admitted to a channel.
 *
 *   open      the rule above — every internal viewer, `private` for management only
 *   crew      through a current or historical crew membership (crewChannels)
 *   explicit  through a `messageChannelMembers` row, by the same four standings the crew rule draws
 *
 * A channel is one of the three. The router decides once, in `openChannel`.
 */
export type MembershipMode = "open" | "explicit" | "crew";

/** A channel role. It confers nothing outside this channel and is not a domain role. */
export type MemberRole = "member" | "moderator" | "dispatcher" | "manager" | "read_only";

export type ChannelMember = {
  channelRef: string;
  userId: number;
  memberRole: MemberRole;
  joinedAt: Date;
  /** Set when the person left. The row stays: what they were sent stays theirs to read. */
  leftAt: Date | null;
};

/**
 * Four standings, not two — the crew rule, reused verbatim.
 *
 * `current = !leftAt` is wrong: a membership beginning tomorrow with no leaving date is not in
 * force today. A future-only member must not be admitted, and must not be mistaken for a
 * historical one either — they were never here.
 */
export type MemberStanding = "current" | "historical" | "future_only" | "never";

export function memberStanding(rows: readonly ChannelMember[], at: Date): { standing: MemberStanding; current: ChannelMember | null } {
  const current = rows.find(m => m.joinedAt.getTime() <= at.getTime() && (!m.leftAt || m.leftAt.getTime() > at.getTime())) ?? null;
  if (current) return { standing: "current", current };
  if (rows.some(m => m.leftAt && m.leftAt.getTime() <= at.getTime())) return { standing: "historical", current: null };
  if (rows.length) return { standing: "future_only", current: null };
  return { standing: "never", current: null };
}

/**
 * Admission to an explicit channel. Reading is a member's — current or historical; writing is a
 * current member's whose channel role allows it. A moderator is not admitted here: moderation is a
 * separate authority (`board.moderate`) and every use of it is an event, never a wider reading of
 * membership.
 */
export function mayOpenExplicit(standing: MemberStanding): ChannelAccess {
  if (standing === "current") return { allowed: true, reason: "Member" };
  if (standing === "historical") return { allowed: true, reason: "Former member — what you were sent stays yours to read" };
  if (standing === "future_only") return { allowed: false, reason: "Membership of this channel has not begun. A joining date in the future is not current membership." };
  return { allowed: false, reason: "Not a member of this channel. Being an internal user is not being in this conversation." };
}

/** Whether a channel role may post. `read_only` reads. */
export function memberMayPost(role: MemberRole): boolean {
  return role !== "read_only";
}

/** Channel types whose posts are publications rather than conversation. */
export const PUBLISH_CHANNEL_TYPES: readonly ChannelType[] = ["announcement", "emergency"];

/**
 * Whether posting this needs the publish authority (`board.publish`) rather than `board.post`.
 *
 * Derived, like `requiresAcknowledgement`: an emergency is an emergency whatever channel it lands
 * in, and an announcement channel is a publication whatever priority the poster chose.
 */
export function requiresPublishAuthority(channelType: ChannelType, priority: Priority): boolean {
  return priority === "emergency" || PUBLISH_CHANNEL_TYPES.includes(channelType)
    // Checkpoint 5 — a safety channel is where anyone reports a hazard, but a post there that demands
    // a roll-call of acknowledgements is a safety bulletin, and a bulletin is published, not sent.
    || (channelType === "safety" && ACKNOWLEDGEMENT_REQUIRED.includes(priority));
}

/** Channel types that are explicit by construction: a conversation between named people. */
export const EXPLICIT_ONLY_TYPES: readonly ChannelType[] = ["direct", "group"];

/**
 * The membership mode a new channel takes when the caller names none: a direct or group channel is
 * explicit (it has no meaning otherwise), a crew channel is crew, everything else is open.
 */
export function defaultMembershipMode(type: ChannelType, crewRef: string | null): MembershipMode {
  if (crewRef) return "crew";
  if (EXPLICIT_ONLY_TYPES.includes(type)) return "explicit";
  return "open";
}

/** The audience an announcement must have: nobody is not an audience. */
export const MAX_ANNOUNCEMENT_AUDIENCE = 500;

/**
 * Whether a post's audience is acceptable for its channel. An announcement with no recipients has
 * no roll-call and is refused; a larger company gets branch channels rather than a truncated list.
 */
export function announcementAudienceRefusal(channelType: ChannelType, recipientCount: number): string | null {
  if (channelType !== "announcement") return null;
  if (recipientCount === 0) return "An announcement with no audience has no roll-call. Name recipients, or let the organization's membership be resolved as the audience.";
  if (recipientCount > MAX_ANNOUNCEMENT_AUDIENCE) return `An announcement reaches at most ${MAX_ANNOUNCEMENT_AUDIENCE} people here; a larger company announces by branch channel rather than to an arbitrary subset called the audience.`;
  return null;
}

/** The one channel two people share. Order-independent, so A→B and B→A resolve to the same room. */
export function directChannelKey(a: number, b: number): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `direct:${x}:${y}`;
}
