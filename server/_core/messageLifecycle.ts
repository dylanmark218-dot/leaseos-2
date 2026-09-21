/**
 * v22.20 — what actually happened to a message, and who is still unaccounted for.
 *
 * Pure. No network, no database.
 *
 * **A queued message has not been delivered.** On a tablet with no signal the
 * only true statements are "saved" and "queued". Showing a tick that means
 * delivered is a lie the sender acts on, and for a stop-work order it is the
 * lie that gets somebody hurt. So the state machine has no path from queued to
 * delivered that does not pass through the server actually accepting it, and
 * every advance needs evidence rather than optimism.
 *
 * **Forward only.** A receipt does not go from read back to delivered. Anything
 * that would move it backwards is refused, because the interesting question
 * after an incident is the earliest moment somebody could have known, and a
 * state that can regress cannot answer it.
 *
 * **Nobody is counted as fine by default.** In a roll-call the people who have
 * not answered are the whole point. "18 safe" is a comforting number; "18 safe,
 * 1 no response" is the one that sends somebody to look.
 */

export type ReceiptState =
  | "queued_offline"   // on the device, nothing has left it
  | "uploaded"         // the device sent it; nobody has confirmed
  | "accepted"         // the server has it
  | "delivered"        // it reached the recipient's device
  | "opened"           // they saw it on screen
  | "acknowledged"     // they said they have it
  | "actioned"         // they did the thing
  | "resolved";        // the thing it was about is over

const ORDER: ReceiptState[] = [
  "queued_offline", "uploaded", "accepted", "delivered", "opened", "acknowledged", "actioned", "resolved",
];

export type Receipt = {
  messageRef: string;
  userId: number;
  state: ReceiptState;
  /** When each state was reached. A gap means it never was. */
  at: Partial<Record<ReceiptState, Date>>;
};

export class ReceiptRegression extends Error {}
export class UnevidencedAdvance extends Error {}

/**
 * Evidence required to reach each state. Named so that a caller cannot advance
 * a receipt by asserting rather than observing.
 */
export type Evidence =
  | { to: "uploaded"; deviceId: string }
  | { to: "accepted"; serverReceivedAt: Date }
  | { to: "delivered"; recipientDeviceId: string }
  | { to: "opened" }
  | { to: "acknowledged"; byUserId: number }
  | { to: "actioned"; recordRef: string }
  | { to: "resolved"; byUserId: number };

export function advance(receipt: Receipt, evidence: Evidence, at: Date): Receipt {
  const from = ORDER.indexOf(receipt.state);
  const to = ORDER.indexOf(evidence.to);
  if (to <= from) {
    throw new ReceiptRegression(
      `${receipt.messageRef} is already ${receipt.state}; it does not go back to ${evidence.to}. The earliest moment somebody could have known is the question a regressing state cannot answer.`,
    );
  }
  if (evidence.to === "acknowledged" && evidence.byUserId !== receipt.userId) {
    throw new UnevidencedAdvance(`Only ${receipt.userId} can acknowledge their own receipt of ${receipt.messageRef}`);
  }
  return { ...receipt, state: evidence.to, at: { ...receipt.at, [evidence.to]: at } };
}

/** What may honestly be shown to the sender. */
export function senderLabel(state: ReceiptState): string {
  switch (state) {
    case "queued_offline": return "Queued — no signal";
    case "uploaded": return "Sending";
    case "accepted": return "Sent";
    // Not before this. "Sent" and "delivered" are different claims.
    case "delivered": return "Delivered";
    case "opened": return "Opened";
    case "acknowledged": return "Acknowledged";
    case "actioned": return "Actioned";
    case "resolved": return "Resolved";
  }
}

/** True only where the recipient's device actually has it. */
export const hasReachedRecipient = (r: Receipt): boolean => ORDER.indexOf(r.state) >= ORDER.indexOf("delivered");

/** True only where the person said so themselves. */
export const isAcknowledged = (r: Receipt): boolean => ORDER.indexOf(r.state) >= ORDER.indexOf("acknowledged");

/* ------------------------------------------------------------------ */
/* Roll-call                                                            */
/* ------------------------------------------------------------------ */

export type RollCallAnswer = "safe" | "needs_assistance" | "not_at_site";

export type RollCallResponse = { userId: number; answer: RollCallAnswer; at: Date; note: string | null };

export type RollCall = {
  messageRef: string;
  targeted: readonly number[];
  responses: readonly RollCallResponse[];
};

export type RollCallStatus = {
  targeted: number;
  safe: number[];
  needsAssistance: number[];
  notAtSite: number[];
  /** Everybody who has not answered, whatever their receipt says. */
  noResponse: number[];
  /** Opened the message and still did not answer — a distinct kind of silence. */
  openedWithoutAnswering: number[];
  settled: boolean;
  line: string;
};

/**
 * Where everybody is.
 *
 * Opening the evacuation notice is not answering it, and somebody whose phone
 * never got it is not the same as somebody who read it and said nothing — one
 * needs a radio call, the other needs somebody to drive out there. Both are
 * listed; neither is counted as safe.
 */
export function rollCallStatus(call: RollCall, receipts: readonly Receipt[]): RollCallStatus {
  const answered = new Map(call.responses.map(r => [r.userId, r.answer]));
  const safe: number[] = [];
  const needsAssistance: number[] = [];
  const notAtSite: number[] = [];
  const noResponse: number[] = [];

  for (const userId of call.targeted) {
    const answer = answered.get(userId);
    if (answer === "safe") safe.push(userId);
    else if (answer === "needs_assistance") needsAssistance.push(userId);
    else if (answer === "not_at_site") notAtSite.push(userId);
    else noResponse.push(userId);
  }

  const openedWithoutAnswering = noResponse.filter(userId =>
    receipts.some(r => r.userId === userId && r.messageRef === call.messageRef && ORDER.indexOf(r.state) >= ORDER.indexOf("opened")));

  return {
    targeted: call.targeted.length, safe, needsAssistance, notAtSite, noResponse, openedWithoutAnswering,
    // Assistance outstanding keeps it unsettled even when everybody has answered.
    settled: noResponse.length === 0 && needsAssistance.length === 0,
    line: `${call.targeted.length} targeted · ${safe.length} safe · ${needsAssistance.length} need assistance · ${notAtSite.length} not at site · ${noResponse.length} no response`,
  };
}

/** Who somebody has to physically go and find, in the order they should be found. */
export function unaccountedFor(status: RollCallStatus): { userId: number; why: string }[] {
  return [
    ...status.needsAssistance.map(userId => ({ userId, why: "Answered that they need assistance" })),
    ...status.openedWithoutAnswering.map(userId => ({ userId, why: "Read the notice and did not answer" })),
    ...status.noResponse.filter(u => !status.openedWithoutAnswering.includes(u))
      .map(userId => ({ userId, why: "No response and no evidence the notice reached them" })),
  ];
}

/* ------------------------------------------------------------------ */
/* Edits                                                               */
/* ------------------------------------------------------------------ */

export type Revision = { revision: number; body: string; editedByUserId: number; at: Date; reason: string | null };

export type MessageHistory = {
  messageRef: string;
  /** Revision 1 is what was originally sent, and stays. */
  revisions: Revision[];
  withdrawnAt: Date | null;
  withdrawnByUserId: number | null;
};

/**
 * Edit a message.
 *
 * Appends. The original is what recipients acted on, and a system that lets an
 * author rewrite what they said after an incident has no operational history
 * worth keeping — the same append-only rule the corrections ledger follows.
 */
export function edit(history: MessageHistory, body: string, editedByUserId: number, at: Date, reason: string | null): MessageHistory {
  if (history.withdrawnAt) throw new ReceiptRegression(`${history.messageRef} is withdrawn; it is not edited afterwards`);
  return {
    ...history,
    revisions: [...history.revisions, { revision: history.revisions.length + 1, body, editedByUserId, at, reason }],
  };
}

/** Withdraw it. The text stays; what changes is that it no longer stands. */
export function withdraw(history: MessageHistory, byUserId: number, at: Date): MessageHistory {
  return { ...history, withdrawnAt: at, withdrawnByUserId: byUserId };
}

export const currentBody = (h: MessageHistory): string | null =>
  h.withdrawnAt ? null : h.revisions[h.revisions.length - 1]?.body ?? null;

export const originalBody = (h: MessageHistory): string | null => h.revisions[0]?.body ?? null;
