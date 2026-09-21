/**
 * v22.20 — the tick that must not lie, and the person nobody has heard from.
 */
import { describe, expect, it } from "vitest";
import {
  advance, currentBody, edit, hasReachedRecipient, isAcknowledged, originalBody,
  ReceiptRegression, rollCallStatus, senderLabel, unaccountedFor, UnevidencedAdvance,
  withdraw, type MessageHistory, type Receipt,
} from "./_core/messageLifecycle";

const AT = new Date("2026-10-20T14:00:00Z");
const later = (m: number) => new Date(AT.getTime() + m * 60_000);
const receipt = (userId: number, o: Partial<Receipt> = {}): Receipt =>
  ({ messageRef: "MSG-1", userId, state: "queued_offline", at: {}, ...o });

describe("a queued message has not been delivered", () => {
  it("shows the sender the truth at every stage", () => {
    expect(senderLabel("queued_offline")).toBe("Queued — no signal");
    expect(senderLabel("uploaded")).toBe("Sending");
    // "Sent" and "delivered" are different claims and this is where they part.
    expect(senderLabel("accepted")).toBe("Sent");
    expect(senderLabel("delivered")).toBe("Delivered");
  });

  it("does not count anything before delivered as having reached the recipient", () => {
    for (const state of ["queued_offline", "uploaded", "accepted"] as const) {
      expect(hasReachedRecipient(receipt(1, { state }))).toBe(false);
    }
    expect(hasReachedRecipient(receipt(1, { state: "delivered" }))).toBe(true);
  });

  it("walks the whole path, each step needing its own evidence", () => {
    let r = receipt(7);
    r = advance(r, { to: "uploaded", deviceId: "TAB-9" }, later(1));
    r = advance(r, { to: "accepted", serverReceivedAt: later(2) }, later(2));
    r = advance(r, { to: "delivered", recipientDeviceId: "TAB-3" }, later(3));
    r = advance(r, { to: "opened" }, later(4));
    r = advance(r, { to: "acknowledged", byUserId: 7 }, later(5));
    expect(r.state).toBe("acknowledged");
    expect(Object.keys(r.at)).toEqual(["uploaded", "accepted", "delivered", "opened", "acknowledged"]);
  });

  it("refuses to skip backwards, because the earliest known moment is the question that matters", () => {
    const opened = receipt(7, { state: "opened" });
    expect(() => advance(opened, { to: "delivered", recipientDeviceId: "X" }, later(9))).toThrow(ReceiptRegression);
    expect(() => advance(opened, { to: "opened" }, later(9))).toThrow(/does not go back/);
  });

  it("lets only the recipient acknowledge their own receipt", () => {
    const delivered = receipt(7, { state: "delivered" });
    expect(() => advance(delivered, { to: "acknowledged", byUserId: 8 }, later(5))).toThrow(UnevidencedAdvance);
    expect(advance(delivered, { to: "acknowledged", byUserId: 7 }, later(5)).state).toBe("acknowledged");
  });

  it("treats opened as short of acknowledged", () => {
    expect(isAcknowledged(receipt(7, { state: "opened" }))).toBe(false);
    expect(isAcknowledged(receipt(7, { state: "acknowledged" }))).toBe(true);
    expect(isAcknowledged(receipt(7, { state: "actioned" }))).toBe(true);
  });
});

describe("the roll-call counts the silence", () => {
  const call = {
    messageRef: "MSG-EVAC", targeted: [1, 2, 3, 4, 5],
    responses: [
      { userId: 1, answer: "safe" as const, at: AT, note: null },
      { userId: 2, answer: "safe" as const, at: AT, note: null },
      { userId: 3, answer: "needs_assistance" as const, at: AT, note: "twisted ankle" },
      { userId: 4, answer: "not_at_site" as const, at: AT, note: null },
    ],
  };
  const receipts = [
    receipt(5, { messageRef: "MSG-EVAC", state: "opened" }),
  ];

  it("never counts an unanswered person as safe", () => {
    const s = rollCallStatus(call, receipts);
    expect(s.safe).toEqual([1, 2]);
    expect(s.noResponse).toEqual([5]);
    expect(s.line).toBe("5 targeted · 2 safe · 1 need assistance · 1 not at site · 1 no response");
  });

  it("separates somebody who read it and said nothing from somebody it never reached", () => {
    const s = rollCallStatus(call, receipts);
    expect(s.openedWithoutAnswering).toEqual([5]);

    const neverReached = rollCallStatus(call, [receipt(5, { messageRef: "MSG-EVAC", state: "queued_offline" })]);
    expect(neverReached.openedWithoutAnswering).toEqual([]);
    expect(neverReached.noResponse).toEqual([5]);
  });

  it("is unsettled while anybody needs assistance, even with everybody answered", () => {
    const everyone = { ...call, responses: [...call.responses, { userId: 5, answer: "safe" as const, at: AT, note: null }] };
    const s = rollCallStatus(everyone, receipts);
    expect(s.noResponse).toEqual([]);
    expect(s.settled).toBe(false);   // person 3 still needs help
  });

  it("settles only when nobody is missing and nobody needs help", () => {
    const allSafe = {
      messageRef: "MSG-EVAC", targeted: [1, 2],
      responses: [
        { userId: 1, answer: "safe" as const, at: AT, note: null },
        { userId: 2, answer: "safe" as const, at: AT, note: null },
      ],
    };
    expect(rollCallStatus(allSafe, []).settled).toBe(true);
  });

  it("lists who to go and find, worst first, with the reason", () => {
    const who = unaccountedFor(rollCallStatus(call, receipts));
    expect(who[0]).toEqual({ userId: 3, why: "Answered that they need assistance" });
    expect(who[1]).toEqual({ userId: 5, why: "Read the notice and did not answer" });
  });

  it("distinguishes the unreached in the list that sends somebody out", () => {
    const who = unaccountedFor(rollCallStatus(call, [receipt(5, { messageRef: "MSG-EVAC", state: "accepted" })]));
    expect(who.find(w => w.userId === 5)!.why).toContain("no evidence the notice reached them");
  });
});

describe("what was said stays said", () => {
  const history = (): MessageHistory => ({
    messageRef: "MSG-1", withdrawnAt: null, withdrawnByUserId: null,
    revisions: [{ revision: 1, body: "Use the north access", editedByUserId: 7, at: AT, reason: null }],
  });

  it("keeps the original alongside the edit", () => {
    const h = edit(history(), "Use the SOUTH access", 7, later(10), "wrong direction");
    expect(h.revisions).toHaveLength(2);
    expect(originalBody(h)).toBe("Use the north access");
    expect(currentBody(h)).toBe("Use the SOUTH access");
    expect(h.revisions[1].reason).toBe("wrong direction");
  });

  it("withdraws without erasing — the text stays, it just no longer stands", () => {
    const h = withdraw(edit(history(), "second", 7, later(5), null), 7, later(20));
    expect(currentBody(h)).toBeNull();
    expect(originalBody(h)).toBe("Use the north access");
    expect(h.revisions).toHaveLength(2);
    expect(h.withdrawnByUserId).toBe(7);
  });

  it("refuses to edit something already withdrawn", () => {
    const h = withdraw(history(), 7, later(20));
    expect(() => edit(h, "sneaky", 7, later(30), null)).toThrow(/is withdrawn/);
  });
});
