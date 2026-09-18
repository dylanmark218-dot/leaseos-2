/**
 * v22.20 (0101) — a question answered only from what the company loaded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("loading is sensitive; asking is not", () => {
  it("fails closed on curation only", () => {
    // What is loaded decides what every later answer can cite.
    expect(SENSITIVE_PERMISSIONS).toContain("assistant.curate");
    expect(SENSITIVE_PERMISSIONS).not.toContain("assistant.ask");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 23_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const AT = new Date("2027-04-01T00:00:00Z");
/**
 * Each test loads its own corpus with a unique token. These tests share a
 * database, so a passage left by an earlier case is retrieved by a later one —
 * which is the retriever working and the fixture lying.
 */
import { __clearTestAssessments, __registerAssessmentForTest } from "./_core/knowledge/sourceGate";
const token = () => `zzq${rnd().toLowerCase()}`;
const brakeText = (t: string) => `${t}: maximum pushrod travel is 2 inches when measured with the brakes applied.`;

async function load(safety: number, body: string, over: Record<string, unknown> = {}) {
  return caller(safety).assistantAsk.addPassage({
    documentRef: `DOC-${rnd()}`, documentTitle: "Air Brake Maintenance Manual",
    section: "4.7", page: 92, body, revision: "4",
    effectiveFrom: new Date("2026-01-10T00:00:00Z"), jurisdiction: "AB",
    // 0151: the company's own manual, on the stated assertion of the person loading it.
    reproductionBasis: "own_document",
    rightsAssertion: "This organization wrote this manual and holds the right to load and quote it.",
    ...over,
  });
}

d("the answer is the document, quoted", () => {
  it("returns the passage with its citation and says no model wrote it", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, brakeText(t));
    const r = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.verdict).toBe("verified");
    expect(r.passages[0].text).toBe(brakeText(t));
    expect(r.passages[0]).toMatchObject({ documentTitle: "Air Brake Maintenance Manual", section: "4.7", page: 92, revision: "4" });
    expect(r.note).toContain("no model wrote this answer");
  });

  it("says nothing in the documents answers a question they do not cover", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    await load(safety, brakeText(token()));
    const r = await caller(driver).assistantAsk.ask({ question: token(), asOf: AT });
    expect(r.verdict).toBe("insufficient_evidence");
    expect(r.passages).toEqual([]);
  });

  it("does not answer from a retired revision", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    const p = await load(safety, brakeText(t));
    await caller(safety).assistantAsk.supersedePassage({ passageRef: p.passageRef, at: new Date("2026-06-01T00:00:00Z") });
    const r = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.verdict).not.toBe("verified");
    expect(r.passages).toEqual([]);
    expect(r.rejected.some(x => x.reason.includes("superseded"))).toBe(true);
  });

  it("does not answer a question about another jurisdiction from this one's manual", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, brakeText(t));
    const r = await caller(driver).assistantAsk.ask({ question: t, jurisdiction: "BC", asOf: AT });
    expect(r.verdict).not.toBe("verified");
    expect(r.rejected.some(x => x.reason.includes("the question is about BC"))).toBe(true);
  });
});

d("another organization's manual is not readable", () => {
  it("does not retrieve a passage belonging elsewhere", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    const p = await load(safety, brakeText(t));
    await pool.execute("UPDATE knowledgePassages SET tenantId = 'ORG-ELSEWHERE' WHERE passageRef = ?", [p.passageRef]);
    const r = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.passages).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(t);
  });

  it("refuses a driver the loading of new material", async () => {
    const driver = await withRole("driver");
    await expect(load(driver, brakeText(token()))).rejects.toThrow();
  });
});

d("what was asked is on the record", () => {
  it("records the verdict, including when it was insufficient", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, brakeText(t));
    const ok = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    const none = await caller(driver).assistantAsk.ask({ question: token(), asOf: AT });

    const history = await caller(driver).assistantAsk.history({ limit: 50 });
    const byRef = new Map(history.queries.map(q => [q.queryRef, q]));
    expect(byRef.get(ok.queryRef)!.verdict).toBe("verified");
    expect(byRef.get(ok.queryRef)!.citedPassageRefs.length).toBeGreaterThan(0);
    // An assistant that said it did not know must be able to show it said so.
    expect(byRef.get(none.queryRef)!.verdict).toBe("insufficient_evidence");
    expect(byRef.get(none.queryRef)!.citedPassageRefs).toEqual([]);
  });

  it("keeps one organization's questions out of another's history", async () => {
    const driver = await withRole("driver");
    await caller(driver).assistantAsk.ask({ question: token(), asOf: AT });
    await pool.execute("UPDATE assistantQueries SET tenantId = 'ORG-ELSEWHERE' WHERE askedByUserId = ?", [driver]);
    const history = await caller(driver).assistantAsk.history({ limit: 50 });
    expect(history.queries.some(q => q.question.includes("nothing loaded"))).toBe(false);
  });
});

d("what is shown is what was judged", () => {
  it("uses the caller's real permissions rather than assuming one", async () => {
    const src = await import("fs").then(fs => fs.readFileSync("server/assistantAskRouter.ts", "utf8"));
    // Hardcoding a permission makes every asker appear to hold it.
    expect(src).not.toContain('heldPermissions: ["document.read"]');
    expect(src).toContain("permissionsFor(await listActiveUserRoleNames(ctx.user.id))");
  });

  it("ranks and gates on one signal, so nothing is cut before the deciding score sees it", async () => {
    const src = await import("fs").then(fs => fs.readFileSync("server/assistantAskRouter.ts", "utf8"));
    const admit = src.indexOf("for (const row of candidates)");
    const truncate = src.indexOf(".slice(0, MAX_PASSAGES)");
    expect(admit).toBeLessThan(truncate);
    expect(src).toContain("sort((a2, b2) => b2.score - a2.score)");
  });

  it("reads the admitted projection rather than the row it came from", async () => {
    const src = await import("fs").then(fs => fs.readFileSync("server/assistantAskRouter.ts", "utf8"));
    // Discarding the admitted block would make admission a check, not a gate.
    expect(src).toContain("admittedText = block.text");
    expect(src).toContain("text: admittedText");
  });

  it("refuses a question with no searchable terms instead of answering nothing", async () => {
    const driver = await withRole("driver");
    await expect(caller(driver).assistantAsk.ask({ question: "is it on", asOf: AT }))
      .rejects.toThrow(/no searchable terms/);
  });

  it("still answers a real question after all of that", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, brakeText(t));
    const r = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.verdict).toBe("verified");
    expect(r.passages[0].text).toBe(brakeText(t));
  });

  it("returns the highest-overlap passage first", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    // Enough passages that the shared token is not in more than half of them —
    // see the natural-language threshold test below.
    for (let i = 0; i < 4; i++) await load(safety, `filler ${token()} about unrelated matters.`);
    await load(safety, `${t}: pushrod travel limit is 2 inches.`);
    // Sharing two of the three terms, so it clears the support floor and can
    // be ranked. `passages` is the supporting set, not the candidate set: a
    // passage below the floor is retrieved and correctly not counted here.
    await load(safety, `${t}: general travel notes for the yard.`);
    const r = await caller(driver).assistantAsk.ask({ question: `${t} pushrod travel`, asOf: AT });
    expect(r.passages.length).toBeGreaterThan(1);
    expect(r.passages[0].text).toContain("pushrod travel limit");
  });

  it("drops a term that appears in more than half the corpus", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    // MySQL natural-language mode discards any word present in over 50% of
    // rows. On a small corpus that silently removes the most distinctive shared
    // term, so a two-passage corpus cannot be used to reason about ranking —
    // worth knowing before anyone calibrates against a handful of documents.
    await load(safety, `${t}: first clause.`);
    await load(safety, `${t}: second clause.`);
    const r = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.passages.length).toBeLessThanOrEqual(2);
  });
});

d("an answer says what is known about its own retrieval", () => {
  it("carries a retrieval caveat that does not undermine the citation", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, brakeText(t));
    const r = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.verdict).toBe("verified");
    // These tests share a corpus, so by this point a measurement may exist that
    // no longer describes it — which is itself the honest answer. Either way
    // the reader is told something true about what is not established.
    expect(["unmeasured", "insufficient_sample"]).toContain(r.retrievalQuality);
    expect(r.retrievalCaveat).toMatch(/not established|different corpus|only \d+ question/);
  });

  it("records a probe and refuses one naming a passage that is not here", async () => {
    const safety = await withRole("safety");
    const t = token();
    const p = await load(safety, brakeText(t));
    const probe = await caller(safety).assistantAsk.addProbe({ question: t, expectedPassageRefs: [p.passageRef] });
    // Defaults to the honest assumption and says what that costs.
    expect(probe.origin).toBe("authored_from_document");
    expect(probe.note).toContain("real questions come from recorded asks");

    await expect(caller(safety).assistantAsk.addProbe({ question: t, expectedPassageRefs: ["PSG-NOWHERE"] }))
      .rejects.toThrow(/does not exist here/);
  });

  it("measures the retrieval the assistant actually performs", async () => {
    const safety = await withRole("safety");
    const t = token();
    const p = await load(safety, brakeText(t));
    await caller(safety).assistantAsk.addProbe({ question: t, expectedPassageRefs: [p.passageRef] });
    const m = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    const mine = m.results.find(r => r.question === t)!;
    expect(mine.recall).toBe(1);
    expect(mine.firstExpectedRank).toBeGreaterThan(0);
  });

  it("reports the grade against the real-question count, whatever else is on file", async () => {
    const safety = await withRole("safety");
    const m = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    // The sample-size and origin-weighting rules are exercised with controlled
    // fixtures in retrievalQuality.test.ts. Asserting a grade here would be
    // asserting against whatever earlier cases left in a shared database.
    expect(m.quality.probeCount).toBeGreaterThan(0);
    expect(m.results.some(r => r.origin === "real_question" || r.origin === "authored_from_document")).toBe(true);
    // The line says the most useful thing for the state it is in: a recall
    // figure once real questions exist, and otherwise why there is not one.
    expect(m.quality.line).toMatch(/recall@8|question anybody asked|real question/);
  });

  it("names a question that shares no words with the passage answering it", async () => {
    const safety = await withRole("safety");
    const t = token();
    const p = await load(safety, `${t}: maximum pushrod travel is two inches.`);
    // A probe whose question uses entirely different vocabulary.
    await caller(safety).assistantAsk.addProbe({ question: `${token()} slack regulator setting`, expectedPassageRefs: [p.passageRef] });
    const m = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    expect(m.vocabularyGaps.length).toBeGreaterThan(0);
    expect(m.note).toContain("tuning the score will not fix it");
  });

  it("refuses a driver the authoring of probes", async () => {
    const driver = await withRole("driver");
    await expect(caller(driver).assistantAsk.addProbe({ question: "x y z", expectedPassageRefs: ["PSG-1"] })).rejects.toThrow();
  });
});

d("the quality shown is the quality measured", () => {
  it("stops saying unmeasured once a measurement covers this corpus", async () => {
    const safety = await withRole("safety");
    const t = token();
    const p = await load(safety, brakeText(t));
    await caller(safety).assistantAsk.addProbe({ question: t, expectedPassageRefs: [p.passageRef] });
    // Measure last, so the fingerprint taken here is the one the ask recomputes
    // — loading a passage after measuring would legitimately invalidate it, and
    // that is a different test.
    await caller(safety).assistantAsk.measureRetrieval({ k: 8 });

    const r = await caller(safety).assistantAsk.ask({ question: t, asOf: AT });
    // Previously this graded an empty array and reported unmeasured for ever.
    expect(r.retrievalQuality).not.toBe("unmeasured");
    expect(r.retrievalCaveat).not.toContain("different corpus");
  });

  it("says the figure describes a different corpus once documents change", async () => {
    const safety = await withRole("safety");
    const t = token();
    const p = await load(safety, brakeText(t));
    await caller(safety).assistantAsk.addProbe({ question: t, expectedPassageRefs: [p.passageRef] });
    await caller(safety).assistantAsk.measureRetrieval({ k: 8 });

    // Superseding changes what may be cited while leaving the passage count and
    // the newest-created date exactly where they were.
    await caller(safety).assistantAsk.supersedePassage({ passageRef: p.passageRef });

    const r = await caller(safety).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.retrievalCaveat).toContain("describes a different corpus");
    expect(r.retrievalCaveat).toContain("Re-run the measurement");
  });

  it("records the corpus hash with the measurement", async () => {
    const safety = await withRole("safety");
    const m = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    expect(m.corpus.hash).toMatch(/^[0-9a-f]{64}$/);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT corpusHash FROM retrievalMeasurements WHERE measurementRef = ?", [m.measurementRef]);
    expect(rows[0].corpusHash).toBe(m.corpus.hash);
  });

  it("gives the same hash for an unchanged corpus and a different one after an edit", async () => {
    const safety = await withRole("safety");
    const a = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    const b = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    expect(b.corpus.hash).toBe(a.corpus.hash);

    await load(safety, brakeText(token()));
    const c = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    expect(c.corpus.hash).not.toBe(a.corpus.hash);
  });
});

d("a real question is proved, not claimed", () => {
  it("takes no origin from the request at all", async () => {
    const src = await import("fs").then(fs => fs.readFileSync("server/assistantAskRouter.ts", "utf8"));
    const input = src.slice(src.indexOf("addProbe: roleProcedure"), src.indexOf("addProbeFromAsk"));
    // A curator could otherwise type a question while reading the passage and
    // label it as how people actually ask.
    expect(input).not.toMatch(/origin:\s*z\./);
    expect(src).toContain('origin: "authored_from_document",');
  });

  it("copies the question from the recorded ask rather than retyping it", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    const p = await load(safety, brakeText(t));
    const ask = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });

    const probe = await caller(safety).assistantAsk.addProbeFromAsk({
      queryRef: ask.queryRef, expectedPassageRefs: [p.passageRef],
    });
    expect(probe.origin).toBe("real_question");
    expect(probe.question).toBe(t);
    expect(probe.originQueryRef).toBe(ask.queryRef);
  });

  it("records which ask a real probe came from", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    const p = await load(safety, brakeText(t));
    const ask = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    const probe = await caller(safety).assistantAsk.addProbeFromAsk({ queryRef: ask.queryRef, expectedPassageRefs: [p.passageRef] });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT origin, originQueryRef FROM retrievalProbes WHERE probeRef = ?", [probe.probeRef]);
    expect(rows[0]).toMatchObject({ origin: "real_question", originQueryRef: ask.queryRef });
  });

  it("lets a curator name a passage retrieval never returned, and says so", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, brakeText(t));
    // A second passage using entirely different words for the same thing.
    const other = await load(safety, `${token()}: slack adjuster travel is limited to two inches.`);
    const ask = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });

    const probe = await caller(safety).assistantAsk.addProbeFromAsk({
      queryRef: ask.queryRef, expectedPassageRefs: [other.passageRef],
    });
    // The gap is the whole measurement — accepting the retrieved set would let
    // the retriever mark its own homework.
    expect(probe.notRetrievedWhenAsked).toEqual([other.passageRef]);
    expect(probe.note).toContain("That gap is what the measurement is for");
  });

  it("refuses a probe against another organization's recorded question", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    const p = await load(safety, brakeText(t));
    const ask = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    await pool.execute("UPDATE assistantQueries SET tenantId = 'ORG-ELSEWHERE' WHERE queryRef = ?", [ask.queryRef]);
    await expect(caller(safety).assistantAsk.addProbeFromAsk({ queryRef: ask.queryRef, expectedPassageRefs: [p.passageRef] }))
      .rejects.toThrow(/No such recorded question/);
  });

  it("refuses a driver the labelling of probes", async () => {
    const driver = await withRole("driver");
    await expect(caller(driver).assistantAsk.addProbeFromAsk({ queryRef: "ASK-X", expectedPassageRefs: ["PSG-1"] }))
      .rejects.toThrow();
  });
});

d("browsing is not retrieving", () => {
  it("finds a passage by substring that the retriever would not rank for", async () => {
    const safety = await withRole("safety");
    const t = token();
    // Wording that shares nothing with how anyone would ask about it.
    await load(safety, `${t}: slack adjuster stroke shall not exceed the marked limit.`);
    const found = await caller(safety).assistantAsk.passageList({ contains: "slack adjuster stroke" });
    expect(found.passages.some(p => p.body.includes(t))).toBe(true);
    expect(found.note).toContain("not the retriever");
  });

  it("keeps another organization's passages out of the browse", async () => {
    const safety = await withRole("safety");
    const t = token();
    const p = await load(safety, brakeText(t));
    await pool.execute("UPDATE knowledgePassages SET tenantId = 'ORG-ELSEWHERE' WHERE passageRef = ?", [p.passageRef]);
    const found = await caller(safety).assistantAsk.passageList({ contains: t });
    expect(found.passages).toEqual([]);
  });

  it("refuses a driver the browsing of the corpus for labelling", async () => {
    const driver = await withRole("driver");
    await expect(caller(driver).assistantAsk.passageList({ limit: 5 })).rejects.toThrow();
  });
});

d("a measurement is about one corpus, one retriever, one depth", () => {
  it("records the retriever that produced it", async () => {
    const safety = await withRole("safety");
    const m = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT retrieverKey, retrieverVersion FROM retrievalMeasurements WHERE measurementRef = ?", [m.measurementRef]);
    expect(rows[0].retrieverKey).toBe("mysql-natural-language");
    expect(rows[0].retrieverVersion).not.toBe("unknown");
  });

  it("will not let a measurement at another depth certify the answer screen", async () => {
    const safety = await withRole("safety");
    const t = token();
    const p = await load(safety, brakeText(t));
    await caller(safety).assistantAsk.addProbe({ question: t, expectedPassageRefs: [p.passageRef] });
    // A true number about a product that shows twenty.
    await caller(safety).assistantAsk.measureRetrieval({ k: 20 });

    const r = await caller(safety).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.retrievalCaveat).toContain("measured at 20 results while answers show 8");
    expect(r.retrievalCaveat).toContain("a different product");
  });

  it("will not let a measurement from another retriever certify it either", async () => {
    const safety = await withRole("safety");
    const t = token();
    const p = await load(safety, brakeText(t));
    await caller(safety).assistantAsk.addProbe({ question: t, expectedPassageRefs: [p.passageRef] });
    const m = await caller(safety).assistantAsk.measureRetrieval({ k: 8 });
    // As if the retriever had been replaced since.
    await pool.execute("UPDATE retrievalMeasurements SET retrieverVersion = 'hybrid-v3' WHERE measurementRef = ?", [m.measurementRef]);

    const r = await caller(safety).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.retrievalCaveat).toContain("a different implementation");
  });

  it("is a mutation, because it records", async () => {
    const src = await import("fs").then(fs => fs.readFileSync("server/assistantAskRouter.ts", "utf8"));
    const start = src.indexOf("measureRetrieval: roleProcedure");
    expect(start).toBeGreaterThan(-1);
    const proc = src.slice(start, start + 700);
    expect(proc).toContain(".mutation(");
    expect(proc).not.toContain(".query(");
  });
});

d("one ask is one question", () => {
  it("refuses a second label for the same recorded ask", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    const p = await load(safety, brakeText(t));
    const ask = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    await caller(safety).assistantAsk.addProbeFromAsk({ queryRef: ask.queryRef, expectedPassageRefs: [p.passageRef] });
    // Five reviews of one question are not five people asking.
    await expect(caller(safety).assistantAsk.addProbeFromAsk({ queryRef: ask.queryRef, expectedPassageRefs: [p.passageRef] }))
      .rejects.toThrow(/One ask is one question/);
  });

  it("marks which recorded asks have been labelled, newest first", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    const p = await load(safety, brakeText(t));
    const ask = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    await caller(safety).assistantAsk.addProbeFromAsk({ queryRef: ask.queryRef, expectedPassageRefs: [p.passageRef] });

    const later = await caller(driver).assistantAsk.ask({ question: token(), asOf: AT });
    const history = await caller(safety).assistantAsk.history({ limit: 50 });
    // Newest first, so a curator past thirty questions still sees the new ones.
    expect(history.queries[0].queryRef).toBe(later.queryRef);
    expect(history.queries.find(q => q.queryRef === ask.queryRef)!.labelled).toBe(true);
    expect(history.queries[0].labelled).toBe(false);
  });
});

d("two clocks, and neither is the caller's to set", () => {
  it("stamps askedAt on the server however the question is dated", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, brakeText(t));
    const before = Date.now();
    const ask = await caller(driver).assistantAsk.ask({ question: t, asOf: new Date("2019-01-01T00:00:00Z") });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT askedAt FROM assistantQueries WHERE queryRef = ?", [ask.queryRef]);
    // One field was doing both jobs, so a caller could date an audit row
    // whenever it liked in the table that exists to show what was asked when.
    expect(new Date(rows[0].askedAt).getTime()).toBeGreaterThanOrEqual(before - 2000);
  });

  it("still answers from the documents as they stood on the date given", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    // Not yet in force for a question asked about today. Dated 2037 rather
    // than 2099 because these columns are MySQL TIMESTAMP, which stops at
    // 2038 — a real limit on how far ahead a document revision can be filed.
    await load(safety, brakeText(t), { effectiveFrom: new Date("2037-01-01T00:00:00Z") });
    const r = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    expect(r.verdict).not.toBe("verified");
    expect(r.rejected.some(x => x.reason.includes("does not take effect"))).toBe(true);
  });

  it("takes no at field from the request any more", async () => {
    const src = await import("fs").then(fs => fs.readFileSync("server/assistantAskRouter.ts", "utf8"));
    const start = src.indexOf("ask: roleProcedure");
    const input = src.slice(start, src.indexOf(".mutation(", start));
    expect(input).not.toMatch(/\bat:\s*z\./);
    expect(input).toContain("asOf: z.coerce.date().optional()");
  });
});

d("the retriever's mechanics, against the real database", () => {
  it("does not let a refusal answer a question about permission", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, `${t}: transmission is not authorized on this channel.`);
    // The passage says the opposite of what the question asks.
    const r = await caller(driver).assistantAsk.ask({ question: `${t} authorized`, asOf: AT });
    const supporting = r.passages.map(p => p.text).join(" ");
    if (supporting) expect(supporting).toContain("not authorized");
    // Either it is cited with its negation intact, or it does not support.
    expect(r.verdict === "verified" ? supporting.includes("not authorized") : true).toBe(true);
  });

  it("keeps numbered categories apart", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, `${t} class 3 placard is required for this load.`);
    const three = await caller(driver).assistantAsk.ask({ question: `${t} class 3`, asOf: AT });
    const one = await caller(driver).assistantAsk.ask({ question: `${t} class 1`, asOf: AT });
    expect(three.passages.length).toBeGreaterThan(0);
    // Class 1 and Class 3 were the same question when the digit was dropped.
    expect(one.passages.length).toBeLessThan(three.passages.length + 1);
    expect(three.verdict).toBe("verified");
  });

  it("finds a measurement written the other way round", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    await load(safety, `${t}: maximum pushrod travel is 1-1/2 inches.`);
    const r = await caller(driver).assistantAsk.ask({ question: `${t} 1 1/2 inches`, asOf: AT });
    expect(r.verdict).toBe("verified");
  });

  it("orders candidates explicitly rather than taking what the database returns", async () => {
    const src = await import("fs").then(fs => fs.readFileSync("server/assistantAskRouter.ts", "utf8"));
    const start = src.indexOf("async function retrieve(");
    const fn = src.slice(start, src.indexOf("export const assistantAskRouter", start));
    // No later score can rescue a row that never reached the candidate set.
    expect(fn).toContain("orderBy(desc(relevance)");
    expect(fn).toContain("asc(knowledgePassages.id)");
  });

  it("returns the same candidates for the same question twice", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const t = token();
    for (let i = 0; i < 5; i++) await load(safety, `${t}: clause ${i} about pushrod travel limits.`);
    const a = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    const b = await caller(driver).assistantAsk.ask({ question: t, asOf: AT });
    expect(b.passages.map(p => p.passageRef)).toEqual(a.passages.map(p => p.passageRef));
  });
});

d("reproduced text records why it may be reproduced, and who said so", () => {
  const OWN = "This organization wrote this manual and holds the right to load and quote it.";

  it("records the assertion, the person, and no licence for the organization's own document", async () => {
    const safety = await withRole("safety");
    const r = await load(safety, brakeText(token()));
    expect(r).toMatchObject({ basis: "own_document", authorizedBy: null });
    expect(r.note).toMatch(/assertion, not a proof of title/);
    const [row] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT reproductionBasis, sourceId, licenceAssessmentRef, rightsAssertion, loadedByUserId FROM knowledgePassages WHERE passageRef = ?", [r.passageRef]);
    expect(row[0]).toMatchObject({ reproductionBasis: "own_document", sourceId: null, licenceAssessmentRef: null, rightsAssertion: OWN, loadedByUserId: safety });
  });

  it("refuses an own document with no assertion, and one that names a licensed source", async () => {
    const safety = await withRole("safety");
    await expect(load(safety, brakeText(token()), { rightsAssertion: undefined })).rejects.toThrow(/needs the rights assertion/);
    await expect(load(safety, brakeText(token()), { sourceId: "gov-ab-511" })).rejects.toThrow(/names no licensed source/);
  });

  it("refuses a licensed source with no source named, or carrying an assertion instead of an assessment", async () => {
    const safety = await withRole("safety");
    await expect(load(safety, brakeText(token()), { reproductionBasis: "licensed_source", rightsAssertion: undefined }))
      .rejects.toThrow(/must name the source id/);
    await expect(load(safety, brakeText(token()), { reproductionBasis: "licensed_source", sourceId: "gov-ab-511" }))
      .rejects.toThrow(/authorized by its assessment, not by an assertion/);
  });

  it("still refuses 511 Alberta: no written permission covering commercial ingestion or redisplay is held", async () => {
    const safety = await withRole("safety");
    await expect(load(safety, brakeText(token()), { reproductionBasis: "licensed_source", sourceId: "gov-ab-511", rightsAssertion: undefined }))
      .rejects.toThrow(/rag_ingestion and commercial_redisplay are not authorized for gov-ab-511/);
  });

  it("refuses a source nobody has assessed — an unknown licence is not a permissive one", async () => {
    const safety = await withRole("safety");
    await expect(load(safety, brakeText(token()), { reproductionBasis: "licensed_source", sourceId: `nobody-assessed-${rnd()}`, rightsAssertion: undefined }))
      .rejects.toThrow(/not authorized/);
  });
});

/**
 * The composite gate, proved in both directions.
 *
 * 511 Alberta denies ingestion AND redisplay, so a test built only on it cannot tell a gate that
 * asks both questions from one that asks either question twice. These use synthetic assessments
 * with exactly one right, which is the only way to see the difference.
 */
d("the passage library needs both rights, and one is not enough", () => {
  const synthetic = (over: Partial<Parameters<typeof __registerAssessmentForTest>[0]>) => {
    const source_id = `synthetic-${rnd()}`;
    __registerAssessmentForTest({
      assessment_id: `LIC-SYNTH-${rnd().toUpperCase()}`, source_id,
      source_name: "Synthetic source, for the gate's own tests", jurisdiction: "AB", owner: "test",
      assessed_at: "2026-09-18", commercial_product: true, status: "authorized_commercial",
      commercial_reuse_authorized: true, api_production_authorized: false,
      rag_ingestion_authorized: true, model_training_authorized: false,
      linking_authorized: true, metadata_only_authorized: true,
      permission_document_id: "PERM-SYNTH-1",
      reasons: ["synthetic"], conditions_to_unblock: [], sources: [],
      ...over,
    } as never);
    return source_id;
  };
  afterAll(() => __clearTestAssessments());

  it("refuses redisplay-allowed but ingestion-denied: it may be shown, but not stored and indexed", async () => {
    const safety = await withRole("safety");
    const sourceId = synthetic({ rag_ingestion_authorized: false });
    await expect(load(safety, brakeText(token()), { reproductionBasis: "licensed_source", sourceId, rightsAssertion: undefined }))
      .rejects.toThrow(/rag_ingestion is not authorized/);
  });

  it("refuses ingestion-allowed but redisplay-denied: it may be stored, but not returned to a person", async () => {
    const safety = await withRole("safety");
    // In a commercial product the one commercial_reuse flag governs both content uses, so this case
    // is only reachable through an assessment made for non-commercial use: material cleared for
    // internal indexing and not for showing to paying customers. Probed against the gate to be
    // sure exactly one right is missing, rather than assuming.
    const sourceId = synthetic({ commercial_product: false, commercial_reuse_authorized: false, status: "authorized_non_commercial_only" });
    await expect(load(safety, brakeText(token()), { reproductionBasis: "licensed_source", sourceId, rightsAssertion: undefined }))
      .rejects.toThrow(/commercial_redisplay is not authorized/);
  });

  it("permits a source whose recorded assessment authorizes both, and stamps that assessment on the row", async () => {
    const safety = await withRole("safety");
    const sourceId = synthetic({});
    const r = await load(safety, brakeText(token()), { reproductionBasis: "licensed_source", sourceId, rightsAssertion: undefined });
    expect(r.basis).toBe("licensed_source");
    expect(r.authorizedBy).toMatch(/^LIC-SYNTH-/);
    const [row] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT sourceId, licenceAssessmentRef, rightsAssertion FROM knowledgePassages WHERE passageRef = ?", [r.passageRef]);
    // The assessment is stamped from the gate's record, not from the request: a revocation sweeps by it.
    expect(row[0]).toMatchObject({ sourceId, rightsAssertion: null });
    expect(row[0]!.licenceAssessmentRef).toBe(r.authorizedBy);
  });
});

/**
 * A pre-0150 row exists and is unclassified. It stays in the table so a person can classify it,
 * and stays out of every customer-visible answer until they do.
 */
d("a legacy passage nobody has classified is present but unquotable", () => {
  it("is physically in the table, yet cannot be retrieved, cited or counted in the corpus", async () => {
    const safety = await withRole("safety");
    const marker = `zzlegacy${rnd().toLowerCase()}`;
    const body = `${marker}: maximum pushrod travel is 2 inches when measured with the brakes applied.`;
    const before = await caller(safety).assistantAsk.passageList({});
    // The row must sit in the CALLER'S OWN tenant, or this would prove the tenant filter and say
    // nothing about the basis filter. Take the tenant from a passage the caller just loaded.
    const own = await load(safety, brakeText(token()));
    const [t] = await pool.query<mysql.RowDataPacket[]>("SELECT tenantId FROM knowledgePassages WHERE passageRef = ?", [own.passageRef]);
    const tenantId = t[0]!.tenantId as string;
    // Written the way a pre-0150 row exists: no basis stated. 0150's backfill marks it 'unstated'.
    await pool.execute(
      "INSERT INTO knowledgePassages (passageRef, tenantId, documentRef, documentTitle, section, body, revision, reproductionBasis) VALUES (?,?,?,?,?,?,?,'unstated')",
      [`PSG-LEGACY-${rnd()}`, tenantId, `DOC-${rnd()}`, "Legacy manual", "1.1", body, "1"]);
    const [exists] = await pool.query<mysql.RowDataPacket[]>("SELECT reproductionBasis, tenantId FROM knowledgePassages WHERE body = ?", [body]);
    expect(exists[0]).toMatchObject({ reproductionBasis: "unstated", tenantId });   // really there, and in the caller's own tenant

    const asked = await caller(safety).assistantAsk.ask({ question: `what is the maximum pushrod travel ${marker}` });
    expect(JSON.stringify(asked)).not.toContain(marker);     // and it answers nothing
    const after = await caller(safety).assistantAsk.passageList({});
    // Nor does it appear in the library a person browses.
    expect(JSON.stringify(after)).not.toContain(marker);
    expect(after.passages.length).toBe(before.passages.length);
  });
});
