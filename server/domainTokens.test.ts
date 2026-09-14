/**
 * v22.20 — what counts as a word in a question about a truck.
 *
 * Every case here is vocabulary already present in this system, not a question
 * anybody has asked. That is the limit of what this can prove: it finds
 * structural failures in the tokenizer, and it says nothing about whether
 * retrieval finds the right passage for a real question.
 */
import { describe, expect, it } from "vitest";
import { domainTerms, STOPWORDS, termOverlap } from "./_core/domainTokens";
import { stem } from "./_core/retrievalQuality";

const overlap = (passage: string, question: string) => termOverlap(passage, question, stem);

describe("function words are not evidence", () => {
  it("drops stopwords that were being scored as terms", () => {
    // "UWI for the well" scored four terms, two of them function words.
    expect(domainTerms("UWI for the well")).toEqual(["uwi", "well"]);
    expect(STOPWORDS.has("the")).toBe(true);
  });

  it("no longer lets a passage earn support from function words alone", () => {
    // Under the old tokenizer this scored 0.5, above the 0.35 support floor.
    const unrelated = "The driver signed for the load at the yard.";
    expect(overlap(unrelated, "UWI for the well")).toBe(0);
  });

  it("still scores a passage that shares real vocabulary", () => {
    expect(overlap("The UWI identifies the well bore.", "UWI for the well")).toBe(1);
  });
});

describe("the answer is often a number", () => {
  it("keeps a measurement whole rather than discarding it", () => {
    // "1 1/2 inches" previously kept only "inches".
    expect(domainTerms("is 1-1/2 inches within the limit")).toContain("1-1/2");
    expect(domainTerms("is 1-1/2 inches within the limit")).toContain("inches");
  });

  it("keeps a decimal and a bare quantity", () => {
    expect(domainTerms("2.5 metres of clearance")).toContain("2.5");
    expect(domainTerms("axle weight 9100")).toContain("9100");
  });

  it("binds a bare digit to the word it identifies", () => {
    // This previously required "class 3 placard" to become ["class","placard"],
    // making Class 1, Class 2 and Class 3 the same question — the same defect
    // as kg and lb tokenising alike.
    expect(domainTerms("class 3 placard")).toEqual(["class_3", "placard"]);
    expect(domainTerms("class 1 placard")).not.toEqual(domainTerms("class 3 placard"));
    expect(domainTerms("cycle 1 hours")).not.toEqual(domainTerms("cycle 2 hours"));
  });

  it("drops a digit with no word in front of it", () => {
    expect(domainTerms("3")).toEqual([]);
  });

  it("keeps a legal land description in one piece", () => {
    // Split on its hyphens it is not a location.
    expect(domainTerms("LSD 04-16-083-05W6 access")).toContain("04-16-083-05w6");
  });
});

describe("units are short and they matter", () => {
  it("no longer conflates kilograms with pounds", () => {
    const kg = domainTerms("axle weight limit in kg");
    const lb = domainTerms("axle weight limit in lb");
    expect(kg).toContain("kg");
    expect(lb).toContain("lb");
    expect(kg).not.toEqual(lb);
  });

  it("keeps the units this domain actually uses", () => {
    for (const u of ["mm", "psi", "kpa", "ppm", "hr"]) {
      expect(domainTerms(`reading in ${u}`)).toContain(u);
    }
  });

  it("keeps acronyms of three and four letters", () => {
    for (const a of ["cvip", "tdg", "h2s", "uwi", "lsd", "afe"]) {
      expect(domainTerms(`what is the ${a} requirement`)).toContain(a);
    }
  });
});

describe("what this cannot tell us", () => {
  it("scores zero when a passage answers in different words", () => {
    // Still true, and still the thing only a real corpus can size.
    expect(overlap("maximum pushrod travel is two inches", "brake adjustment limit")).toBe(0);
  });

  it("scores one for a passage that restates the question without answering it", () => {
    expect(overlap("This section covers maximum pushrod travel.", "maximum pushrod travel")).toBe(1);
  });
});


describe("a negation is not a stopword", () => {
  it("does not let a refusal tokenise as a permission", () => {
    // "not authorized" and "authorized" produced identical terms, so a passage
    // refusing something scored a perfect match against a question asking
    // whether it was permitted.
    expect(domainTerms("not authorized")).toEqual(["not_authorized"]);
    expect(domainTerms("not authorized")).not.toEqual(domainTerms("authorized"));
    expect(overlap("not authorized on this channel", "authorized on this channel")).toBeLessThan(1);
  });

  it("binds the other negators too", () => {
    expect(domainTerms("no permit required")).toEqual(["no_permit", "required"]);
    expect(domainTerms("never exceed the limit")).toContain("never_exceed");
    expect(domainTerms("cannot proceed")).toEqual(["cannot_proceed"]);
    expect(domainTerms("without authorization")).toEqual(["without_authorization"]);
  });

  it("keeps a trailing negator rather than dropping it", () => {
    expect(domainTerms("authorized or not")).toContain("not");
  });

  it("still matches a passage that carries the same negation", () => {
    expect(overlap("transmission is not authorized here", "not authorized")).toBe(1);
  });
});

describe("a mixed fraction is one measurement", () => {
  it("joins the spaced form, which was losing its whole number", () => {
    // "1 1/2 inches" kept "1/2": one and a half inches became half an inch.
    expect(domainTerms("is 1 1/2 inches")).toEqual(["1-1/2", "inches"]);
    expect(domainTerms("is 1 1/2 inches")).not.toEqual(domainTerms("is 1/2 inches"));
  });

  it("treats the spaced and hyphenated forms as the same thing", () => {
    expect(domainTerms("1 1/2 inches")).toEqual(domainTerms("1-1/2 inches"));
    expect(overlap("maximum travel is 1-1/2 inches", "is 1 1/2 inches within the limit")).toBeGreaterThan(0);
  });

  it("leaves a bare fraction alone", () => {
    expect(domainTerms("1/2 inch clearance")).toContain("1/2");
  });
});
