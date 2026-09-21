/**
 * v22.20 — attaching a record, and the eight drivers who must not get a payroll
 * document because somebody was helpful.
 */
import { describe, expect, it } from "vitest";
import {
  attach, attachWithinOrganization, AttachmentRefused, NEVER_ATTACHABLE,
  sameOrganization, stillVisible, viewAll, viewAttachment,
  type ObjectAuthorizer, type ObjectKind,
} from "./_core/attachmentAuthorization";

const AT = new Date("2026-10-20T09:00:00Z");

/** A payroll clerk sees payroll and jobs; drivers see jobs only. */
const authorize: ObjectAuthorizer = (userId, kind) => {
  if (kind === "job" || kind === "defect" || kind === "photo") return true;
  return userId === 1;   // only the clerk
};

describe("you cannot attach what you cannot open", () => {
  it("attaches a job the sender can see", () => {
    const a = attach({ kind: "job", objectRef: "JOB-5718", senderUserId: 9, at: AT, authorize });
    expect(a).toMatchObject({ kind: "job", objectRef: "JOB-5718", attachedByUserId: 9 });
  });

  it("refuses an object the sender cannot open themselves", () => {
    expect(() => attach({ kind: "invoice", objectRef: "INV-1", senderUserId: 9, at: AT, authorize }))
      .toThrow(AttachmentRefused);
    expect(() => attach({ kind: "invoice", objectRef: "INV-1", senderUserId: 9, at: AT, authorize }))
      .toThrow(/cannot open it themselves/);
  });

  it("refuses the never-attachable kinds even from somebody who CAN open them", () => {
    // The payroll clerk can read it. Attaching means showing it to the room.
    expect(() => attach({ kind: "payrollDocument", objectRef: "PAY-88", senderUserId: 1, at: AT, authorize }))
      .toThrow(/not how this record is shared/);
    for (const kind of NEVER_ATTACHABLE) {
      expect(() => attach({ kind, objectRef: "X", senderUserId: 1, at: AT, authorize })).toThrow(AttachmentRefused);
    }
  });

  it("names the kinds that are never attachable rather than deciding case by case", () => {
    expect([...NEVER_ATTACHABLE].sort()).toEqual(["clientContract", "employeeRecord", "payrollDocument"]);
  });
});

describe("seeing the message is not seeing the thing", () => {
  const invoiceAttachment = attach({ kind: "invoice", objectRef: "INV-1", senderUserId: 1, at: AT, authorize });

  it("shows the object to a reader who can open it", () => {
    const v = viewAttachment(invoiceAttachment, 1, authorize);
    expect(v.visible).toBe(true);
    if (!v.visible) return;
    expect(v.deepLink).toBe("/invoice/INV-1");
  });

  it("gives a reader who cannot open it a stub, not the record", () => {
    // The sender's authority is the sender's. It does not travel with the message.
    const v = viewAttachment(invoiceAttachment, 9, authorize);
    expect(v.visible).toBe(false);
    if (v.visible) return;
    expect(v.note).toContain("is attached to this message and is not visible to you");
    expect(JSON.stringify(v)).not.toContain("INV-1");
  });

  it("names the absence rather than hiding it, so the conversation still makes sense", () => {
    const v = viewAttachment(invoiceAttachment, 9, authorize);
    if (v.visible) return;
    expect(v.kind).toBe("invoice");
    expect(v.reason).toContain("do not have access");
  });

  it("resolves a mixed set per reader", () => {
    const attachments = [
      attach({ kind: "job", objectRef: "JOB-1", senderUserId: 1, at: AT, authorize }),
      invoiceAttachment,
    ];
    const forDriver = viewAll(attachments, 9, authorize);
    expect(forDriver.map(v => v.visible)).toEqual([true, false]);
    const forClerk = viewAll(attachments, 1, authorize);
    expect(forClerk.map(v => v.visible)).toEqual([true, true]);
  });
});

describe("authorization is read at read time", () => {
  it("stops showing an object once the reader's access is revoked", () => {
    const a = attach({ kind: "defect", objectRef: "DF-1", senderUserId: 9, at: AT, authorize });
    expect(stillVisible(a, 9, authorize)).toBe(true);

    // The same attachment, after the reader loses access to defects.
    const revoked: ObjectAuthorizer = (userId, kind) => (kind === "defect" ? false : authorize(userId, kind, ""));
    expect(stillVisible(a, 9, revoked)).toBe(false);
  });

  it("does not preserve an old permission the way a copied file would", () => {
    const a = attach({ kind: "job", objectRef: "JOB-5718", senderUserId: 9, at: AT, authorize });
    const nobody: ObjectAuthorizer = () => false;
    expect(viewAttachment(a, 9, nobody).visible).toBe(false);
  });
});

describe("another organization's record does not resolve at all", () => {
  const ours = { orgRef: "ORG-A" };
  const theirs = { orgRef: "ORG-B" };

  it("recognises the boundary", () => {
    expect(sameOrganization(ours, ours)).toBe(true);
    expect(sameOrganization(theirs, ours)).toBe(false);
  });

  it("refuses with the same words as a missing record, revealing nothing about existence", () => {
    let message = "";
    try {
      attachWithinOrganization({ kind: "job", objectRef: "JOB-X", senderUserId: 9, at: AT, authorize, object: theirs, conversation: ours });
    } catch (e) { message = (e as Error).message; }
    expect(message).toBe("No such job");
    expect(message).not.toContain("organization");
    expect(message).not.toContain("permission");
  });

  it("attaches normally within one organization", () => {
    expect(attachWithinOrganization({ kind: "job", objectRef: "JOB-5718", senderUserId: 9, at: AT, authorize, object: ours, conversation: ours }))
      .toMatchObject({ objectRef: "JOB-5718" });
  });
});
