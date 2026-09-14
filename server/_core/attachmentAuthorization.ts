/**
 * v22.20 — attaching a record to a message, without the message becoming a way
 * around the record's permissions.
 *
 * Pure. No network, no database.
 *
 * The attack is mundane and that is what makes it dangerous. Somebody with
 * payroll access attaches a payroll document to a crew chat. Eight drivers can
 * read the crew chat. If an attachment is a *copy*, eight drivers now have a
 * payroll document, and no permission check was ever bypassed — one was simply
 * never asked.
 *
 * So an attachment is a **reference**, and the object's own authorization is
 * evaluated twice:
 *
 *   ATTACHING   the sender must currently be able to see the object. You
 *               cannot put into a room something you could not open yourself.
 *   OPENING     every reader is checked against the object, not against the
 *               conversation. Seeing the message is not seeing the thing.
 *
 * The second is the one people get wrong, because it feels redundant: the
 * sender was allowed, so surely the room is allowed. It is not. The sender's
 * authority is the sender's.
 *
 * What a reader who cannot open it sees is a stub — that a record was attached,
 * its type, and nothing else. Hiding the attachment entirely would make the
 * conversation misleading ("what did she mean, 'see attached'?"); showing it
 * would be the leak. Naming its absence is the honest middle.
 */

/** Anything a message can point at. */
export type ObjectKind =
  | "job" | "ticket" | "load" | "unit" | "trailer" | "route" | "location"
  | "defect" | "workOrder" | "incident" | "inspection" | "invoice"
  | "payrollDocument" | "employeeRecord" | "clientContract" | "trainingRecord"
  | "photo" | "safetyForm" | "tdgDocument" | "permit";

/**
 * Kinds that are never made visible by being attached, whatever the
 * conversation is. A crew chat is not a place a payroll document becomes
 * readable, even to somebody who could open it elsewhere — because the point of
 * attaching is to show it to the room.
 */
export const NEVER_ATTACHABLE: readonly ObjectKind[] = [
  "payrollDocument", "employeeRecord", "clientContract",
];

export type AttachmentRef = {
  kind: ObjectKind;
  objectRef: string;
  /** Who attached it, and therefore whose authority was checked at the time. */
  attachedByUserId: number;
  attachedAt: Date;
};

/** Whether a given person can see a given object, answered by whoever owns it. */
export type ObjectAuthorizer = (userId: number, kind: ObjectKind, objectRef: string) => boolean;

export class AttachmentRefused extends Error {}

/**
 * Attach a record to a message.
 *
 * Refuses what the sender cannot open, and refuses the kinds that are never
 * attachable regardless. The second check is not about the sender at all: it is
 * about what attaching *means*, which is "show this to the room".
 */
export function attach(args: {
  kind: ObjectKind;
  objectRef: string;
  senderUserId: number;
  at: Date;
  authorize: ObjectAuthorizer;
}): AttachmentRef {
  if (NEVER_ATTACHABLE.includes(args.kind)) {
    throw new AttachmentRefused(
      `A ${args.kind} is not attached to a conversation. Attaching means showing it to the room, and that is not how this record is shared.`,
    );
  }
  if (!args.authorize(args.senderUserId, args.kind, args.objectRef)) {
    throw new AttachmentRefused(
      `Cannot attach ${args.kind} ${args.objectRef}: this person cannot open it themselves.`,
    );
  }
  return { kind: args.kind, objectRef: args.objectRef, attachedByUserId: args.senderUserId, attachedAt: args.at };
}

export type AttachmentView =
  | { visible: true; kind: ObjectKind; objectRef: string; deepLink: string }
  | { visible: false; kind: ObjectKind; reason: string; note: string };

/**
 * What one reader sees.
 *
 * Checked against the object, never against the conversation. A reader who can
 * see the message and not the record gets a stub that says so — enough for the
 * conversation to make sense, not enough to be the leak.
 */
export function viewAttachment(attachment: AttachmentRef, readerUserId: number, authorize: ObjectAuthorizer): AttachmentView {
  if (!authorize(readerUserId, attachment.kind, attachment.objectRef)) {
    return {
      visible: false, kind: attachment.kind,
      reason: `You do not have access to this ${attachment.kind}`,
      // Naming the absence rather than hiding it: otherwise "see attached"
      // reads as a broken message rather than a permission boundary.
      note: `A ${attachment.kind} is attached to this message and is not visible to you.`,
    };
  }
  return { visible: true, kind: attachment.kind, objectRef: attachment.objectRef, deepLink: `/${attachment.kind}/${encodeURIComponent(attachment.objectRef)}` };
}

/** Every attachment on a message, resolved for one reader. */
export const viewAll = (attachments: readonly AttachmentRef[], readerUserId: number, authorize: ObjectAuthorizer): AttachmentView[] =>
  attachments.map(a => viewAttachment(a, readerUserId, authorize));

/**
 * Whether a reader's authority has since been revoked.
 *
 * Attachment authorization is evaluated at read time on purpose. Somebody who
 * could open a job yesterday and cannot today sees the stub today — the
 * attachment does not preserve an old permission the way a copied file would.
 */
export function stillVisible(attachment: AttachmentRef, readerUserId: number, authorize: ObjectAuthorizer): boolean {
  return viewAttachment(attachment, readerUserId, authorize).visible;
}

/* ------------------------------------------------------------------ */
/* Cross-company                                                        */
/* ------------------------------------------------------------------ */

export type OrgScoped = { orgRef: string };

/**
 * The outermost boundary, checked before anything else.
 *
 * An object belonging to another organization is not merely unauthorized — it
 * should not resolve at all, so that failing to attach it reveals nothing about
 * whether it exists.
 */
export function sameOrganization(object: OrgScoped, conversation: OrgScoped): boolean {
  return object.orgRef === conversation.orgRef;
}

export function attachWithinOrganization(args: Parameters<typeof attach>[0] & { object: OrgScoped; conversation: OrgScoped }): AttachmentRef {
  if (!sameOrganization(args.object, args.conversation)) {
    // Deliberately the same message as a missing record.
    throw new AttachmentRefused(`No such ${args.kind}`);
  }
  return attach(args);
}
