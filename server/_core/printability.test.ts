/**
 * v23.27 — the paper rules, pinned. What matters in every case is the verdict and the exact
 * blocker or marking — "returns a result" would pass a function that printed everything.
 */
import { describe, expect, it } from "vitest";
import { assessPrintability, copyKindFor, staleCopies, type ChainDocument, type PrintField, type PrintRecord } from "@shared/printability";

const f = (key: string, state: PrintField["state"], required = true): PrintField => ({ key, label: key, required, state });

describe("what may go on a regulatory document", () => {
  it("refuses a shipping document whose UN number is only provisional", () => {
    const a = assessPrintability("regulatory", [f("unNumber", "provisional"), f("shipper", "confirmed")]);
    expect(a.verdict).toBe("refused");
    expect(a.blockers).toEqual([{ key: "unNumber", label: "unNumber", reason: "Required on a regulatory document and not yet confirmed" }]);
  });

  it("names every required value that is unknown or missing, not just the first", () => {
    const a = assessPrintability("regulatory", [f("quantity", "unknown"), f("receiver", "absent")]);
    expect(a.verdict).toBe("refused");
    expect(a.blockers.map(b => [b.key, b.reason])).toEqual([
      ["quantity", "Required on a regulatory document and not determined"],
      ["receiver", "Required on a regulatory document and missing"],
    ]);
  });

  it("prints optional values that are not confirmed, marked — never as a blank", () => {
    const a = assessPrintability("regulatory", [
      f("unNumber", "confirmed"), f("erapRef", "unknown", false), f("note", "provisional", false), f("poNumber", "absent", false),
    ]);
    expect(a.verdict).toBe("printable_with_markings");
    expect(a.markings.map(m => [m.key, m.mark])).toEqual([["erapRef", "NOT DETERMINED"], ["note", "PROVISIONAL"]]);
  });

  it("prints clean when everything required is confirmed", () => {
    expect(assessPrintability("regulatory", [f("unNumber", "confirmed"), f("poNumber", "absent", false)]))
      .toEqual({ verdict: "printable", blockers: [], markings: [] });
  });
});

describe("what may go on a commercial document", () => {
  it("lets a pending line reach the customer, marked as pending", () => {
    const a = assessPrintability("commercial", [f("standbyHours", "provisional"), f("total", "confirmed")]);
    expect(a.verdict).toBe("printable_with_markings");
    expect(a.markings).toEqual([{ key: "standbyHours", label: "standbyHours", mark: "PROVISIONAL" }]);
  });

  it("refuses a receipt with a required field missing or undetermined", () => {
    const a = assessPrintability("commercial", [f("supplierName", "absent"), f("taxRegistration", "unknown")]);
    expect(a.verdict).toBe("refused");
    expect(a.blockers.map(b => b.reason)).toEqual(["Required and missing", "Required and not determined"]);
  });
});

describe("an informational document is never refused and never dishonest", () => {
  it("marks instead of refusing, including a required value that is simply absent", () => {
    const a = assessPrintability("informational", [f("arrival", "absent"), f("litres", "provisional"), f("odometer", "unknown", false)]);
    expect(a.verdict).toBe("printable_with_markings");
    expect(a.markings.map(m => [m.key, m.mark])).toEqual([["arrival", "NOT DETERMINED"], ["litres", "PROVISIONAL"], ["odometer", "NOT DETERMINED"]]);
  });

  it("accepts an empty manifest", () => {
    expect(assessPrintability("informational", []).verdict).toBe("printable");
  });
});

describe("a manifest that was never checked", () => {
  it("refuses an empty manifest on a regulatory or commercial document", () => {
    for (const cls of ["regulatory", "commercial"] as const) {
      const a = assessPrintability(cls, []);
      expect(a.verdict).toBe("refused");
      expect(a.blockers[0].key).toBe("*");
    }
  });

  it("refuses a manifest that answers one field twice", () => {
    const a = assessPrintability("informational", [f("quantity", "confirmed"), f("quantity", "provisional")]);
    expect(a.verdict).toBe("refused");
    expect(a.blockers).toEqual([{ key: "quantity", label: "quantity", reason: "The field manifest lists this field more than once" }]);
  });
});

describe("original or reprint", () => {
  it("calls the first paper of a version the original", () => {
    expect(copyKindFor([])).toBe("original");
  });
  it("does not let a failed or queued print have been the original", () => {
    expect(copyKindFor([{ status: "failed" }, { status: "queued" }])).toBe("original");
  });
  it("calls every later paper of the same version a reprint", () => {
    expect(copyKindFor([{ status: "failed" }, { status: "sent" }])).toBe("reprint");
  });
});

describe("paper that no longer matches the record", () => {
  const p = (deliveryRef: string, documentId: number, status = "sent"): PrintRecord => ({ deliveryRef, documentId, status, copyKind: "original", sentAt: null });
  const chain: ChainDocument[] = [
    { id: 1, documentRef: "DOC-A1", version: 1, status: "superseded" },
    { id: 2, documentRef: "DOC-A2", version: 2, status: "current" },
  ];

  it("finds paper printed from a superseded version and names what replaced it", () => {
    const s = staleCopies(chain, [p("DLV-1", 1), p("DLV-2", 2)]);
    expect(s.map(x => [x.deliveryRef, x.printedVersion, x.reason, x.currentDocumentRef, x.currentVersion])).toEqual([["DLV-1", 1, "superseded", "DOC-A2", 2]]);
  });

  it("ignores prints that produced no paper", () => {
    expect(staleCopies(chain, [p("DLV-3", 1, "failed"), p("DLV-4", 1, "queued")])).toEqual([]);
  });

  it("treats all paper of a withdrawn document as stale, with nothing to point at", () => {
    const s = staleCopies([{ id: 7, documentRef: "DOC-W", version: 1, status: "withdrawn" }], [p("DLV-5", 7)]);
    expect(s.map(x => [x.reason, x.currentDocumentRef])).toEqual([["withdrawn", null]]);
  });

  it("withholds the replacement rather than guessing when two versions claim to be current", () => {
    const fault: ChainDocument[] = [...chain, { id: 3, documentRef: "DOC-A3", version: 3, status: "current" }];
    const s = staleCopies(fault, [p("DLV-6", 1), p("DLV-7", 2), p("DLV-8", 3)]);
    expect(s.map(x => [x.deliveryRef, x.currentDocumentRef])).toEqual([["DLV-6", null]]);
  });
});
