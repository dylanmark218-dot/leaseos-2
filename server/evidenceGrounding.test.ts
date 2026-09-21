/**
 * v22.20 — fluent text with nothing underneath it, refused.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_SUPPORT_SCORE, needsAttention, verifyAnswer, verifyClaim,
  type Claim, type Passage,
} from "./_core/evidenceGrounding";

const AT = new Date("2026-09-13T00:00:00Z");

const passage = (o: Partial<Passage> = {}): Passage => ({
  passageRef: "P1", documentRef: "DOC-4", documentTitle: "Air Brake Maintenance Manual",
  section: "4.7", page: 92, text: "Maximum pushrod travel is 1 1/2 inches.",
  revision: "4", effectiveFrom: new Date("2026-01-10T00:00:00Z"), supersededAt: null,
  jurisdiction: "AB", score: 0.82, ...o,
});
const claim = (o: Partial<Claim> = {}): Claim => ({
  claimRef: "C1", text: "Maximum pushrod travel is 1 1/2 inches",
  citedPassageRefs: ["P1"], jurisdiction: "AB", ...o,
});

describe("a claim stands on what was retrieved", () => {
  it("cites the document, section, page and revision when it stands", () => {
    const v = verifyClaim({ claim: claim(), passages: [passage()], at: AT });
    expect(v.state).toBe("supported");
    expect(v.line).toContain("Air Brake Maintenance Manual §4.7 p.92 (rev 4)");
  });

  it("reports unsupported when nothing was retrieved, without softening it", () => {
    const v = verifyClaim({ claim: claim({ citedPassageRefs: [] }), passages: [], at: AT });
    expect(v.state).toBe("unsupported");
    expect(v.support).toEqual([]);
    // "Generally, limits are..." would be the same unsupported claim in a hedge.
    expect(v.line).toContain("It may still be true; it is not something these documents say");
  });

  it("does not treat the least irrelevant match as support", () => {
    // A retriever always returns its best match, even for an unanswerable question.
    const weak = passage({ score: MIN_SUPPORT_SCORE - 0.01 });
    const v = verifyClaim({ claim: claim(), passages: [weak], at: AT });
    expect(v.state).toBe("unsupported");
    expect(v.rejected[0].reason).toContain("still a number");
  });

  it("accepts a passage exactly at the floor", () => {
    expect(verifyClaim({ claim: claim(), passages: [passage({ score: MIN_SUPPORT_SCORE })], at: AT }).state).toBe("supported");
  });
});

describe("a revision no longer in force supports nothing", () => {
  it("reports superseded rather than unsupported, so the reader knows one existed", () => {
    const old = passage({ revision: "3", supersededAt: new Date("2026-01-10T00:00:00Z") });
    const v = verifyClaim({ claim: claim(), passages: [old], at: AT });
    expect(v.state).toBe("superseded");
    expect(v.line).toContain("no longer in force");
    expect(v.line).toContain("2026-01-10");
  });

  it("does not let a future revision answer today's question", () => {
    const future = passage({ revision: "5", effectiveFrom: new Date("2027-01-01T00:00:00Z") });
    const v = verifyClaim({ claim: claim(), passages: [future], at: AT });
    expect(v.state).toBe("superseded");
    expect(v.rejected[0].reason).toContain("does not take effect until 2027-01-01");
  });

  it("still stands when a current revision is cited alongside a retired one", () => {
    const v = verifyClaim({
      claim: claim({ citedPassageRefs: ["P1", "P0"] }),
      passages: [passage(), passage({ passageRef: "P0", revision: "3", supersededAt: new Date("2026-01-10T00:00:00Z") })],
      at: AT,
    });
    expect(v.state).toBe("supported");
    expect(v.rejected).toHaveLength(1);
  });
});

describe("another jurisdiction's rule is not this one's", () => {
  it("reports out of scope and names both", () => {
    const v = verifyClaim({ claim: claim({ jurisdiction: "BC" }), passages: [passage({ jurisdiction: "AB" })], at: AT });
    expect(v.state).toBe("out_of_scope");
    expect(v.line).toContain("states AB");
    expect(v.line).toContain("the question is about BC");
  });

  it("does not treat a document stating no jurisdiction as stating all of them", () => {
    // A silent document is usable; it simply is not evidence of applicability.
    const v = verifyClaim({ claim: claim({ jurisdiction: "BC" }), passages: [passage({ jurisdiction: null })], at: AT });
    expect(v.state).toBe("supported");
  });
});

describe("sources that disagree are reported, not resolved", () => {
  it("does not take the higher-scoring passage as the answer", () => {
    const a = passage({ passageRef: "A", score: 0.9, text: "1 1/2 inches" });
    const b = passage({ passageRef: "B", score: 0.6, text: "1 1/4 inches", section: "9.2" });
    const v = verifyClaim({
      claim: claim({ citedPassageRefs: ["A", "B"] }), passages: [a, b], at: AT,
      contradictions: [{ aPassageRef: "A", bPassageRef: "B", note: "§4.7 and §9.2 give different limits." }],
    });
    expect(v.state).toBe("conflicting");
    expect(v.line).toContain("Sources disagree");
    expect(v.line).toContain("§4.7 and §9.2 give different limits");
  });

  it("is unaffected by a contradiction between passages that did not survive", () => {
    const a = passage({ passageRef: "A" });
    const stale = passage({ passageRef: "B", supersededAt: new Date("2026-01-10T00:00:00Z") });
    const v = verifyClaim({
      claim: claim({ citedPassageRefs: ["A", "B"] }), passages: [a, stale], at: AT,
      contradictions: [{ aPassageRef: "A", bPassageRef: "B", note: "disagree" }],
    });
    expect(v.state).toBe("supported");
  });
});

describe("the answer as a whole", () => {
  const supported = (ref: string) => verifyClaim({ claim: claim({ claimRef: ref }), passages: [passage()], at: AT });
  const unsupported = (ref: string) => verifyClaim({ claim: claim({ claimRef: ref, citedPassageRefs: [] }), passages: [], at: AT });

  it("is verified only when every statement stands", () => {
    const v = verifyAnswer([supported("C1"), supported("C2")]);
    expect(v.state).toBe("verified");
    expect(v.sources).toEqual([{ documentRef: "DOC-4", documentTitle: "Air Brake Maintenance Manual", revision: "4" }]);
  });

  it("is partially supported when one sentence has nothing behind it", () => {
    const v = verifyAnswer([supported("C1"), supported("C2"), supported("C3"), unsupported("C4")]);
    expect(v.state).toBe("partially_supported");
    // The uncited sentence is exactly where the error will be.
    expect(v.headline).toContain("A citation list does not cover the uncited sentence");
    expect(needsAttention(v).map(c => c.claimRef)).toEqual(["C4"]);
  });

  it("is insufficient when none of it stands", () => {
    expect(verifyAnswer([unsupported("C1"), unsupported("C2")]).state).toBe("insufficient_evidence");
  });

  it("says nothing was checked rather than claiming verification", () => {
    const v = verifyAnswer([]);
    expect(v.state).toBe("insufficient_evidence");
    expect(v.headline).toBe("Nothing was checked, so nothing is verified.");
  });

  it("lets one conflict outrank a page of supported statements", () => {
    const conflicted = verifyClaim({
      claim: claim({ claimRef: "CX", citedPassageRefs: ["A", "B"] }),
      passages: [passage({ passageRef: "A" }), passage({ passageRef: "B", section: "9.2" })],
      at: AT, contradictions: [{ aPassageRef: "A", bPassageRef: "B", note: "differ" }],
    });
    const v = verifyAnswer([supported("C1"), supported("C2"), conflicted]);
    expect(v.state).toBe("conflicting");
    expect(v.headline).toContain("Somebody has to decide which applies");
  });

  it("lists each source revision once, however many claims cite it", () => {
    const v = verifyAnswer([supported("C1"), supported("C2"), supported("C3")]);
    expect(v.sources).toHaveLength(1);
  });
});
