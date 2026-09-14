/**
 * v22.20 — the screen that produces the evidence, and its two traps.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

const page = readFileSync("client/src/pages/AssistantCalibration.tsx", "utf8");
const app = readFileSync("client/src/App.tsx", "utf8");
const router = readFileSync("server/assistantAskRouter.ts", "utf8");

describe("the browse is not the retriever under test", () => {
  it("lists passages with a plain scan rather than the MATCH query", () => {
    // Bounded from the declaration forward, not to a token that also appears
    // in an earlier comment — which silently produced an empty slice.
    const start = router.indexOf("passageList: roleProcedure");
    expect(start).toBeGreaterThan(-1);
    const proc = router.slice(start, router.indexOf("addProbeFromAsk: roleProcedure"));
    expect(proc.length).toBeGreaterThan(200);
    // A browse built on the retriever could only surface what already surfaced.
    expect(proc).toContain("like(knowledgePassages.body");
    expect(proc).not.toContain("MATCH(");
    expect(proc).not.toContain("retrieve(");
  });

  it("says so on the screen, so a curator knows the search is different", () => {
    expect(page).toContain("not the assistant's retriever");
  });

  it("marks a passage the assistant did cite, without preselecting it", () => {
    expect(page).toContain("was cited");
    // Preselecting would record that retrieval agreed with itself.
    expect(page).toContain("agreeing with the assistant is a finding, not the default");
    expect(page).not.toMatch(/useState\(new Set\(ask\.citedPassageRefs\)\)/);
  });
});

describe("the question is not editable here", () => {
  it("sends only the query reference and the chosen passages", () => {
    expect(page).toContain("label.mutate({ queryRef: ask.queryRef, expectedPassageRefs:");
    // Rewording would make it a question nobody asked.
    expect(page).toContain("rewording\n                it would make it a question nobody asked");
  });

  it("starts with nothing ticked on every new selection", () => {
    expect(page).toContain("setExpected(new Set())");
  });
});

describe("the finding is shown at labelling time", () => {
  it("reports passages the assistant did not return", () => {
    expect(page).toContain("label.data.notRetrievedWhenAsked");
  });

  it("does not offer to label when nothing has been chosen", () => {
    expect(page).toContain("disabled={expected.size === 0");
  });
});

describe("the screen is reachable", () => {
  it("is mounted outside the showcase namespace", () => {
    expect(app).toContain('path="/documents/calibration"');
    expect(app).not.toMatch(/ShowcaseFrame[^>]*>\s*<AssistantCalibration/);
  });
});

describe("the loop runs on the screen", () => {
  it("runs the measurement as a mutation", () => {
    expect(page).toContain("trpc.assistantAsk.measureRetrieval.useMutation");
    expect(page).not.toContain("measureRetrieval.useQuery");
  });

  it("measures at the depth answers actually show", () => {
    expect(page).toContain("measure.mutate({ k: 8 })");
    expect(page).toContain("a true\n            number about a different product");
  });

  it("shows the vocabulary gaps, which is the finding that decides the next build", () => {
    // A ranking failure and a vocabulary gap look the same in a recall number.
    expect(page).toContain("measure.data.vocabularyGaps");
    expect(page).toContain("share no words with the passage that answers them");
  });

  it("shows which asks are still unlabelled", () => {
    expect(page).toContain("q.labelled");
    expect(page).toContain("unlabelled");
  });
});
