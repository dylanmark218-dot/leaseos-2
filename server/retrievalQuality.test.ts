/**
 * v22.20 — how often retrieval misses, answered with a number or not at all.
 */
import { describe, expect, it } from "vitest";
import {
  caveatFor, gradeRetrieval, MIN_MEANINGFUL_PROBES, scoreProbe, stem, vocabularyGaps,
  type Probe, type ProbeResult,
} from "./_core/retrievalQuality";

const probe = (o: Partial<Probe> = {}): Probe => ({
  probeRef: "PRB-1", question: "maximum pushrod travel", origin: "real_question",
  expectedPassageRefs: ["P1"], authoredByUserId: 7, ...o,
});

describe("a probe is scored on what was actually surfaced", () => {
  it("counts a hit inside k and reports where it landed", () => {
    const r = scoreProbe(probe(), ["PX", "P1", "PY"], 8);
    expect(r.recall).toBe(1);
    expect(r.firstExpectedRank).toBe(2);
  });

  it("does not count a passage retrieved outside k", () => {
    // Retrieved eleventh when the answer shows three is retrieved and useless.
    const r = scoreProbe(probe(), ["A", "B", "C", "P1"], 3);
    expect(r.recall).toBe(0);
    expect(r.firstExpectedRank).toBeNull();
    expect(r.missed).toEqual(["P1"]);
  });

  it("reports partial recall when some expected passages are missing", () => {
    const r = scoreProbe(probe({ expectedPassageRefs: ["P1", "P2", "P3"] }), ["P1", "P3"], 8);
    expect(r.recall).toBeCloseTo(2 / 3);
    expect(r.missed).toEqual(["P2"]);
  });
});

describe("the grade cannot exceed what the sample supports", () => {
  const perfect = (n: number): ProbeResult[] =>
    Array.from({ length: n }, (_, i) => scoreProbe(probe({ probeRef: `P${i}` }), ["P1"], 8));

  it("reports unmeasured for a corpus nobody has probed", () => {
    const q = gradeRetrieval([], 8);
    expect(q.grade).toBe("unmeasured");
    expect(q.meanRecall).toBeNull();
    expect(q.line).toContain("unknown, which is not the same as fine");
  });

  it("refuses to call nineteen perfect probes good", () => {
    const q = gradeRetrieval(perfect(MIN_MEANINGFUL_PROBES - 1), 8);
    expect(q.grade).toBe("insufficient_sample");
    // A green number from a handful of examples is worse than no number.
    expect(q.line).toContain("too few to describe the retriever rather than the probes");
  });

  it("grades once there are enough real questions", () => {
    expect(gradeRetrieval(perfect(MIN_MEANINGFUL_PROBES), 8).grade).toBe("good");
  });

  it("does not let one real question unlock a grade earned by authored probes", () => {
    // Twenty-five self-vocabulary hits and one real miss came out near ninety
    // per cent and reported the retriever as adequate.
    const authored = Array.from({ length: 25 }, (_, i) =>
      scoreProbe(probe({ probeRef: `A${i}`, origin: "authored_from_document" }), ["P1"], 8));
    const oneRealMiss = scoreProbe(probe({ probeRef: "REAL", origin: "real_question" }), ["ZZ"], 8);
    const q = gradeRetrieval([...authored, oneRealMiss], 8);
    expect(q.grade).toBe("insufficient_sample");
    expect(q.line).toContain("1 real question(s) of 26 probes");
  });

  it("averages the real questions, not the whole set", () => {
    const authored = Array.from({ length: 30 }, (_, i) =>
      scoreProbe(probe({ probeRef: `A${i}`, origin: "authored_from_document" }), ["P1"], 8));
    const realHalf = [
      ...Array.from({ length: 10 }, (_, i) => scoreProbe(probe({ probeRef: `R${i}`, origin: "real_question" }), ["P1"], 8)),
      ...Array.from({ length: 10 }, (_, i) => scoreProbe(probe({ probeRef: `M${i}`, origin: "real_question" }), ["ZZ"], 8)),
    ];
    const q = gradeRetrieval([...authored, ...realHalf], 8);
    // 50% on real questions, not 80% across everything.
    expect(q.meanRecall).toBeCloseTo(0.5);
    expect(q.grade).toBe("poor");
  });

  it("separates poor from adequate", () => {
    const mixed = (hits: number): ProbeResult[] => [
      ...Array.from({ length: hits }, (_, i) => scoreProbe(probe({ probeRef: `H${i}` }), ["P1"], 8)),
      ...Array.from({ length: 20 - hits }, (_, i) => scoreProbe(probe({ probeRef: `M${i}` }), ["ZZ"], 8)),
    ];
    expect(gradeRetrieval(mixed(19), 8).grade).toBe("good");
    expect(gradeRetrieval(mixed(16), 8).grade).toBe("adequate");
    expect(gradeRetrieval(mixed(10), 8).grade).toBe("poor");
  });

  it("names the questions that found nothing at all", () => {
    const results = [scoreProbe(probe({ probeRef: "MISS" }), ["ZZ"], 8), scoreProbe(probe({ probeRef: "HIT" }), ["P1"], 8)];
    expect(gradeRetrieval(results, 8).completeMisses).toEqual(["MISS"]);
  });
});

describe("an answer says what is known about its own retrieval", () => {
  it("caveats an unmeasured corpus without undermining the citation", () => {
    const c = caveatFor(gradeRetrieval([], 8));
    expect(c.clean).toBe(false);
    expect(c.caveat).toContain("What is cited is in the documents");
    expect(c.caveat).toContain("whether something better was missed is not established");
  });

  it("says how few probes there were when the sample is thin", () => {
    const c = caveatFor(gradeRetrieval([scoreProbe(probe(), ["P1"], 8)], 8));
    expect(c.caveat).toContain("only 1 question(s)");
  });

  it("carries no caveat only when retrieval is measured and good", () => {
    const perfect = Array.from({ length: 25 }, (_, i) => scoreProbe(probe({ probeRef: `P${i}` }), ["P1"], 8));
    expect(caveatFor(gradeRetrieval(perfect, 8))).toEqual({ clean: true, caveat: null });
  });
});

describe("the diagnosis term overlap cannot make about itself", () => {
  it("names a miss where question and passage share no words", () => {
    const r = scoreProbe(probe({ probeRef: "GAP", question: "brake adjustment limit" }), ["ZZ"], 8);
    const gaps = vocabularyGaps([r], () => "maximum pushrod travel is two inches");
    expect(gaps).toHaveLength(1);
    // Not a ranking problem; no amount of tuning the score fixes it.
    expect(gaps[0].note).toContain("only a retriever that understands meaning can");
  });

  it("does not call it a vocabulary gap when the words were there and it still missed", () => {
    const r = scoreProbe(probe({ probeRef: "RANK", question: "pushrod travel" }), ["ZZ"], 8);
    const gaps = vocabularyGaps([r], () => "maximum pushrod travel is two inches");
    // That is a ranking failure, which is a different repair.
    expect(gaps).toEqual([]);
  });

  it("says nothing about probes that succeeded", () => {
    const r = scoreProbe(probe(), ["P1"], 8);
    expect(vocabularyGaps([r], () => "anything")).toEqual([]);
  });
});


describe("a plural is not a vocabulary gap", () => {
  it("does not call a morphological variant a different word", () => {
    // Buying embeddings to solve a suffix would be an expensive misdiagnosis.
    const r = scoreProbe(probe({ probeRef: "PLURAL", question: "brakes adjusting" }), ["ZZ"], 8);
    expect(vocabularyGaps([r], () => "the brake is adjusted at the slack adjuster")).toEqual([]);
  });

  it("still names a genuine gap", () => {
    const r = scoreProbe(probe({ probeRef: "GAP", question: "slack regulator setting" }), ["ZZ"], 8);
    expect(vocabularyGaps([r], () => "maximum pushrod travel is two inches")).toHaveLength(1);
  });

  it("stems the common endings and leaves short words alone", () => {
    // The case that caught the first version: stripping "es" gave "brak".
    expect(stem("brakes")).toBe(stem("brake"));
    expect(stem("boxes")).toBe(stem("box"));
    // Over-stemming is the safe direction for this classifier: "chassis"
    // becomes "chassi", and so does "chassis" in the passage, so they still
    // match. What matters is that the function is consistent, not that it
    // returns dictionary words.
    expect(stem("chassis")).toBe(stem("chassis"));
    expect(stem("brake")).toBe(stem("brake"));
    expect(stem("adjusting")).toBe(stem("adjust"));
    expect(stem("inspected")).toBe(stem("inspect"));
    // Not a linguistics engine: short words are left whole rather than mangled.
    expect(stem("gas")).toBe("gas");   // too short to strip
  });
});

describe("the measurement says what depth it used", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => scoreProbe(probe({ probeRef: `P${i}` }), ["P1"], 8));

  it("warns when measured at a different depth than answers show", () => {
    const q = gradeRetrieval(many(25), 20, 8);
    // recall@20 does not describe an assistant that shows eight.
    expect(q.line).toContain("Measured at 20 while answers show 8");
  });

  it("says nothing extra when the depths agree", () => {
    expect(gradeRetrieval(many(25), 8, 8).line).not.toContain("Measured at");
  });
});

describe("probes written from the documents cannot grade the retriever", () => {
  const authored = (n: number) =>
    Array.from({ length: n }, (_, i) => scoreProbe(probe({ probeRef: `A${i}`, origin: "authored_from_document" }), ["P1"], 8));

  it("refuses to grade a set written entirely from the passages", () => {
    const q = gradeRetrieval(authored(30), 8);
    expect(q.grade).toBe("insufficient_sample");
    expect(q.line).toContain("none of them a question anybody asked");
  });

  it("still refuses with twenty-nine authored probes and one real question", () => {
    const mixed = [...authored(29), scoreProbe(probe({ probeRef: "REAL", origin: "real_question" }), ["P1"], 8)];
    expect(gradeRetrieval(mixed, 8).grade).toBe("insufficient_sample");
  });
});
