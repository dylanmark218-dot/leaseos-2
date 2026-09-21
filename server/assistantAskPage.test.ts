/**
 * v22.20 — the assistant screen, and what it will not soften.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

const page = readFileSync("client/src/pages/AssistantAsk.tsx", "utf8");
const app = readFileSync("client/src/App.tsx", "utf8");
const router = readFileSync("server/assistantAskRouter.ts", "utf8");

describe("asking is recorded, so it is a mutation", () => {
  it("calls a mutation rather than a query", () => {
    // A query refetching on window focus would file a second "question asked"
    // that nobody asked, and the record is the point.
    expect(page).toContain("trpc.assistantAsk.ask.useMutation");
    expect(page).not.toContain("ask.useQuery");
  });

  it("is a mutation on the server too", () => {
    const proc = router.slice(router.indexOf("ask: roleProcedure"), router.indexOf("ask: roleProcedure") + 900);
    expect(proc).toContain(".mutation(");
    expect(proc).not.toContain(".query(");
  });
});

describe("what it refuses to soften", () => {
  it("treats no answer as an answer, not an empty result", () => {
    expect(page).toContain("Nothing in the loaded documents answers this");
    expect(page).toContain("it is not\n                    something these documents say");
  });

  it("puts the retrieval caveat above the answer", () => {
    // A reader who sees three citations assumes they are the three best.
    const caveat = page.indexOf("answer.retrievalCaveat");
    const headline = page.indexOf("answer.headline");
    expect(caveat).toBeGreaterThan(-1);
    expect(caveat).toBeLessThan(headline);
  });

  it("names the retrieval quality and the probe count", () => {
    expect(page).toContain("answer.retrievalQuality");
    expect(page).toContain("answer.probesOnFile");
  });

  it("shows why a found passage was not used", () => {
    // Silence would read as "nothing else was found".
    expect(page).toContain("answer.rejected");
    expect(page).toContain("found but not used");
  });
});

describe("the answer is the document", () => {
  it("quotes passages rather than summarising them", () => {
    expect(page).toContain("<blockquote");
    expect(page).toContain("{passage.text}");
  });

  it("cites document, section, page and revision", () => {
    for (const field of ["documentTitle", "section", "page", "revision"]) {
      expect(page).toContain(`passage.${field}`);
    }
  });

  it("says no model wrote it", () => {
    expect(page).toContain("Nothing here is written\n          by a model");
  });

  it("declares no local copy of the response", () => {
    expect(page).not.toMatch(/^type (Passage|Answer|Source) = /m);
    expect(page).not.toMatch(/as \{[^}]*passages/);
  });
});

describe("the screen is reachable", () => {
  it("is mounted outside the showcase namespace", () => {
    expect(app).toContain('import AssistantAsk from "./pages/AssistantAsk"');
    expect(app).toContain('path="/documents/ask"');
    expect(app).not.toMatch(/ShowcaseFrame[^>]*>\s*<AssistantAsk/);
  });
});
