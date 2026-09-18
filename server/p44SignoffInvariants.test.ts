/**
 * The P4.4 sign-off is held by the gate, not only by a document.
 *
 * The owner approved six named rules on 2026-09-18 and asked that the write-path tripwire "remain
 * in place so another ungoverned knowledge-ingestion path cannot be introduced silently". An
 * approval whose subject can drift afterwards is an approval of something that no longer exists, so
 * each signed rule is checked here against the source that enforces it.
 *
 * This is deliberately a structural check, not a second copy of the behaviour tests. Those live in
 * `assistantAskApi.test.ts` and `knowledgeWritePaths.test.ts` and would fail on their own if a rule
 * broke. What this adds is the link between the approval and the code: if an enforcement point is
 * deleted or renamed, the failure names the signed rule that lost its enforcement, rather than
 * leaving someone to work out which document went stale.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SIGNOFF = "docs/P4_4_OWNER_SIGNOFF.md";
const router = () => readFileSync("server/assistantAskRouter.ts", "utf8");
const gate = () => readFileSync("server/_core/knowledge/sourceGate.ts", "utf8");

describe("the six rules the owner signed are still enforced", () => {
  it("has the sign-off on the branch, with its scope limit intact", () => {
    expect(existsSync(SIGNOFF), "the sign-off document is gone").toBe(true);
    const text = readFileSync(SIGNOFF, "utf8");
    // The limit is the part most likely to be lost in a later summary, and the part that matters:
    // approving the software is not licensing a source.
    expect(text).toMatch(/DOES NOT.*constitute a legal determination/s);
    expect(text).toMatch(/Alberta 511/);
    expect(text).toMatch(/4626eb6/);
  });

  it("still requires an accountable person and records the assertion as an assertion", () => {
    const src = router();
    expect(src).toMatch(/loadedByUserId: ctx\.user\.id/);
    expect(src).toMatch(/rightsAssertion: z\.string\(\)\.min\(20\)/);
    // The wording matters: the response must not imply the claim was verified.
    expect(src).toMatch(/assertion, not a proof of title/);
  });

  it("still requires a licensed source to clear both rights, through one helper", () => {
    expect(router()).toMatch(/checkAssistantPassageUse\(input\.sourceId\)/);
    const g = gate();
    expect(g).toMatch(/const REQUIRED: readonly IngestionPurpose\[\] = \["rag_ingestion", "commercial_redisplay"\]/);
    // Neither purpose may be dropped to make a source pass.
    expect(g).toMatch(/rag_ingestion/);
    expect(g).toMatch(/commercial_redisplay/);
  });

  it("still stamps the assessment from the gate's record rather than from the request", () => {
    const src = router();
    expect(src).toMatch(/stampedAssessment = use\.assessmentId/);
    // The caller supplies a source id and nothing else about authorization.
    expect(src).not.toMatch(/licenceAssessmentRef: input\./);
  });

  it("still fails closed on all four read paths for an unclassified passage", () => {
    const src = router();
    expect(src).toMatch(/const QUOTABLE_BASES = \["own_document", "licensed_source"\]/);
    // Four, not three: the library listing was missed once already.
    expect(src.split("quotable()").length - 1).toBeGreaterThanOrEqual(4);
    expect(src).not.toMatch(/QUOTABLE_BASES.*unstated/);
  });

  it("still refuses rather than defaults to permission when a licence is unknown", () => {
    // An unregistered source has no record, and no record is a refusal, not a gap to fill.
    expect(gate()).toMatch(/NO_LICENCE_ASSESSMENT/);
  });

  it("still has the write-path tripwire the owner asked to keep", () => {
    expect(existsSync("server/knowledgeWritePaths.test.ts"), "the tripwire the sign-off names is gone").toBe(true);
    const t = readFileSync("server/knowledgeWritePaths.test.ts", "utf8");
    expect(t).toMatch(/knowledgeChunks/);
    expect(t).toMatch(/knowledgePassages/);
    // It must still look beyond the server tree; an importer is the likely second path.
    expect(t).toMatch(/"scripts"/);
    expect(t).toMatch(/INSERT\\\\s\+INTO|INSERT\\s\+INTO/);
  });
});
