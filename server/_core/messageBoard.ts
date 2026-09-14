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
  | "road_conditions" | "training" | "general" | "job" | "client" | "private" | "emergency";

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
