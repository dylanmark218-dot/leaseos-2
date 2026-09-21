/**
 * v22.20 — making sure somebody actually saw it.
 *
 * Pure. No network, no database. It reads the delivery states the existing
 * `workflowNotifications` table already records and answers one question: given
 * what has happened so far, who should be told next?
 *
 * No second notification system is created here. The table has `sentAt`,
 * `viewedAt` and `acknowledgedAt` as three separate columns, which is the whole
 * distinction this module is built on.
 *
 * **Viewed is not acknowledged.** A notification that lit up on a phone in
 * somebody's pocket has been delivered, possibly viewed, and not accepted by
 * anyone. Only `acknowledgedAt` stops an escalation, because only that is a
 * person saying "I have this".
 *
 * **A failed channel is not a failed notification.** Push providers go down. If
 * the push failed and the in-app record is still outstanding, the event is
 * still outstanding — it has not been delivered and it has not been lost, and
 * the ladder keeps climbing.
 *
 * **The ladder is company policy.** Who is told at five minutes and who at
 * twenty is an operational decision with real cost at 3am; LeaseOS holds the
 * mechanism and the company holds the numbers.
 */

export type NotificationStatus = "queued" | "sent" | "delivered" | "viewed" | "acknowledged" | "failed";

export type NotificationState = {
  notificationKey: string;
  recipientRole: string;
  recipientUserId: number | null;
  channel: string;
  status: NotificationStatus;
  sentAt: Date | null;
  viewedAt: Date | null;
  acknowledgedAt: Date | null;
};

export type EscalationLevel = { afterMinutes: number; roles: readonly string[] };

export type EscalationPolicy = {
  policyRef: string;
  /** Level 0 is who is told immediately; the rest are the ladder. */
  levels: readonly EscalationLevel[];
  /** Roles that may not opt out of this class of event while they hold the role. */
  mandatoryRoles: readonly string[];
};

/** A sensible shape, not a mandate. Every number here is meant to be overridden. */
export const DEFAULT_CRITICAL_POLICY: EscalationPolicy = {
  policyRef: "default.critical",
  levels: [
    { afterMinutes: 0, roles: ["dispatcher", "office", "safety", "shop_lead"] },
    { afterMinutes: 5, roles: ["maintenance_manager"] },
    { afterMinutes: 10, roles: ["management"] },
    { afterMinutes: 20, roles: ["administrator"] },
  ],
  mandatoryRoles: ["dispatcher", "safety"],
};

export type EscalationOutcome = {
  /** True the moment anybody acknowledges. Escalation is about reaching a person, not all of them. */
  acknowledged: boolean;
  acknowledgedBy: { role: string; userId: number | null; at: Date } | null;
  /** The highest level whose time has come. -1 before the first is due. */
  dueLevel: number;
  /** Roles at a due level who have no outstanding or completed notification yet. */
  toNotify: string[];
  /** Roles that were told and have not acknowledged, with how long it has been. */
  awaiting: { role: string; minutesSinceSent: number | null; status: NotificationStatus }[];
  /** Channels that failed while the event remains outstanding. */
  failedChannels: { role: string; channel: string }[];
  reasons: string[];
};

const minutesBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 60_000);

/**
 * Decide the next step for one event.
 *
 * `occurredAt` is when the event happened, not when the first notification was
 * sent — a message that sat in a queue for four minutes has not bought four
 * minutes of grace.
 */
export function escalationOutcome(args: {
  occurredAt: Date;
  notifications: readonly NotificationState[];
  policy: EscalationPolicy;
  now: Date;
}): EscalationOutcome {
  const { notifications, policy, now } = args;

  const ack = notifications.find(n => n.acknowledgedAt);
  if (ack) {
    return {
      acknowledged: true,
      acknowledgedBy: { role: ack.recipientRole, userId: ack.recipientUserId, at: ack.acknowledgedAt! },
      dueLevel: -1, toNotify: [], awaiting: [], failedChannels: [],
      reasons: [`Acknowledged by ${ack.recipientRole} at ${ack.acknowledgedAt!.toISOString().slice(11, 16)} — escalation stops here`],
    };
  }

  const elapsed = minutesBetween(args.occurredAt, now);
  let dueLevel = -1;
  for (let i = 0; i < policy.levels.length; i++) if (elapsed >= policy.levels[i].afterMinutes) dueLevel = i;

  const told = new Set(notifications.map(n => n.recipientRole));
  const toNotify: string[] = [];
  for (let i = 0; i <= dueLevel; i++) for (const role of policy.levels[i].roles) if (!told.has(role) && !toNotify.includes(role)) toNotify.push(role);

  const awaiting = notifications
    .filter(n => !n.acknowledgedAt)
    .map(n => ({ role: n.recipientRole, minutesSinceSent: n.sentAt ? minutesBetween(n.sentAt, now) : null, status: n.status }));

  // A push that failed while the in-app record is still outstanding is a
  // channel problem, not a delivered notification.
  const failedChannels = notifications.filter(n => n.status === "failed" && !n.acknowledgedAt).map(n => ({ role: n.recipientRole, channel: n.channel }));

  const reasons: string[] = [];
  if (dueLevel < 0) reasons.push("No escalation level is due yet");
  else if (toNotify.length) reasons.push(`${elapsed} min with no acknowledgement — level ${dueLevel} is due and ${toNotify.join(", ")} have not been told`);
  else reasons.push(`${elapsed} min with no acknowledgement — everyone through level ${dueLevel} has been told and nobody has acknowledged`);
  const viewedNotAcked = notifications.filter(n => n.viewedAt && !n.acknowledgedAt);
  if (viewedNotAcked.length) reasons.push(`${viewedNotAcked.length} recipient(s) viewed this and did not acknowledge it — viewing is not acceptance`);
  for (const f of failedChannels) reasons.push(`${f.channel} delivery to ${f.role} failed; the in-app notification remains outstanding`);

  return { acknowledged: false, acknowledgedBy: null, dueLevel, toNotify, awaiting, failedChannels, reasons };
}

/** Whether a recipient may turn this class of notification off. Roles in the policy may not. */
export function mayOptOut(role: string, policy: EscalationPolicy): { allowed: boolean; reason: string } {
  return policy.mandatoryRoles.includes(role)
    ? { allowed: false, reason: `${role} is named in the company's critical-response policy and cannot opt out of this class of alert while holding that role` }
    : { allowed: true, reason: "Not named in the critical-response policy for this class" };
}
