import { describe, expect, it } from "vitest";
import {
  fleetTaskQueue,
  scoreSafetyBinder,
  type HeldDocument,
  type RequirementType,
  type UnitContext,
} from "./safetyBinder";

const NOW = new Date("2026-03-10T12:00:00Z");
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

const REQUIREMENTS: RequirementType[] = [
  { code: "REG", label: "Registration", condition: "always", warnWithinDays: 30 },
  { code: "INS", label: "Insurance slip", condition: "always", warnWithinDays: 30 },
  { code: "CVIP", label: "Annual inspection", condition: "always", warnWithinDays: 45 },
  { code: "TDG", label: "TDG documentation", condition: "if_dangerous_goods", warnWithinDays: null },
  { code: "NSC", label: "NSC safety certificate", condition: "if_interprovincial", warnWithinDays: 60 },
];

const CTX: UnitContext = {
  unitId: 142,
  unitNumber: "142",
  carriesDangerousGoods: false,
  operatesInterprovincially: true,
  hasAirBrakes: true,
  trailerAttached: false,
};

const held = (code: string, o: Partial<HeldDocument> = {}): HeldDocument => ({
  code,
  expiresAt: inDays(200),
  verification: "verified",
  evidenceRecordId: 1,
  ...o,
});

const ALL_GOOD: HeldDocument[] = [held("REG"), held("INS"), held("CVIP"), held("NSC")];

const score = (heldDocs: HeldDocument[], context: UnitContext = CTX) =>
  scoreSafetyBinder({ context, requirements: REQUIREMENTS, held: heldDocs, now: NOW });

describe("scoreSafetyBinder", () => {
  it("scores a complete binder and shows the denominator", () => {
    const s = score(ALL_GOOD);
    expect(s.satisfied).toBe(4);
    expect(s.required).toBe(4);           // TDG excluded — not applicable
    expect(s.summary).toBe("4 of 4 required documents verified and in date");
    expect(s.tasks).toHaveLength(0);
  });

  it("counts an unverified document as not present", () => {
    const s = score(ALL_GOOD.map(d => (d.code === "INS" ? { ...d, verification: "unverified" as const } : d)));
    expect(s.satisfied).toBe(3);
    expect(s.required).toBe(4);
    expect(s.items.find(i => i.code === "INS")?.status).toBe("unverified");
    expect(s.tasks.find(t => t.code === "INS")?.action).toContain("Verify");
  });

  it("counts a verified document with no recorded expiry as not satisfied", () => {
    const s = score(ALL_GOOD.map(d => (d.code === "CVIP" ? { ...d, expiresAt: null } : d)));
    const item = s.items.find(i => i.code === "CVIP");
    expect(item?.status).toBe("expiry_unrecorded");
    expect(item?.satisfied).toBe(false);
    expect(s.tasks.find(t => t.code === "CVIP")?.action).toContain("Record the expiry");
  });

  it("marks an expired document urgent and says how long ago", () => {
    const s = score(ALL_GOOD.map(d => (d.code === "REG" ? { ...d, expiresAt: inDays(-4) } : d)));
    expect(s.items.find(i => i.code === "REG")?.status).toBe("expired");
    expect(s.items.find(i => i.code === "REG")?.detail).toContain("4 day(s) ago");
    expect(s.tasks[0].priority).toBe("urgent");
  });

  it("warns inside the lead time without failing the item", () => {
    const s = score(ALL_GOOD.map(d => (d.code === "REG" ? { ...d, expiresAt: inDays(12) } : d)));
    const item = s.items.find(i => i.code === "REG");
    expect(item?.status).toBe("verified_expiring");
    expect(item?.satisfied).toBe(true);
    expect(s.tasks.find(t => t.code === "REG")?.priority).toBe("soon");
  });

  it("excludes a genuinely inapplicable requirement from the denominator", () => {
    expect(score(ALL_GOOD).items.find(i => i.code === "TDG")?.counted).toBe(false);
  });

  it("counts an unanswered applicability question as required, not as excluded", () => {
    const s = score(ALL_GOOD, { ...CTX, carriesDangerousGoods: "unknown" });
    const tdg = s.items.find(i => i.code === "TDG");
    expect(tdg?.status).toBe("applicability_unknown");
    expect(tdg?.counted).toBe(true);
    expect(tdg?.satisfied).toBe(false);
    expect(s.required).toBe(5);
    expect(s.hasOpenQuestions).toBe(true);
    expect(s.tasks.find(t => t.code === "TDG")?.priority).toBe("open_question");
  });

  it("treats a rejected document as urgent rather than merely unverified", () => {
    const s = score(ALL_GOOD.map(d => (d.code === "NSC" ? { ...d, verification: "rejected" as const } : d)));
    expect(s.items.find(i => i.code === "NSC")?.status).toBe("rejected");
    expect(s.tasks.find(t => t.code === "NSC")?.priority).toBe("urgent");
  });

  it("never reports a bare percentage without the fraction beside it", () => {
    const s = score([held("REG")]);
    expect(s.percent).toBe(25);
    expect(s.summary).toContain("of 4");
  });

  it("distinguishes 'nothing required' from a perfect score", () => {
    const s = scoreSafetyBinder({ context: CTX, requirements: [], held: [], now: NOW });
    expect(s.percent).toBeNull();
    expect(s.summary).toContain("No documents are required");
  });
});

describe("fleetTaskQueue", () => {
  it("orders urgent before soon before open questions, then by due date", () => {
    const a = score([held("REG", { expiresAt: inDays(-1) }), held("INS"), held("CVIP"), held("NSC")]);
    const b = scoreSafetyBinder({
      context: { ...CTX, unitId: 208, unitNumber: "208", carriesDangerousGoods: "unknown" },
      requirements: REQUIREMENTS,
      held: [held("REG"), held("INS", { verification: "unverified" }), held("CVIP"), held("NSC")],
      now: NOW,
    });

    const queue = fleetTaskQueue([b, a]);
    expect(queue[0].priority).toBe("urgent");
    expect(queue[0].unitNumber).toBe("142");
    expect(queue[queue.length - 1].priority).toBe("open_question");
  });
});
