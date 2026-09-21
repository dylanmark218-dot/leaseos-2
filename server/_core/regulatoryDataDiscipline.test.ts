/**
 * P2.3 — regulatory information is data, not code.
 *
 * The four clauses were already implemented; this keeps them implemented. Each assertion below
 * guards a rule that is easy to break with a one-line "fix" under pressure, and whose breakage is
 * invisible afterwards — a hard-coded axle limit looks exactly like a correct one until the
 * province changes it, and a pass on unverified data looks exactly like a pass on verified data.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const evaluation = readFileSync("server/_core/routeEvaluation.ts", "utf8");
const spatial = readFileSync("server/spatialRouter.ts", "utf8");

/** Comment-free source, so a number in an explanation is not read as a number in the logic. */
const code = (src: string) =>
  src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\/\/.*$/, "")).join("\n");

describe("no regulatory value is written into the engine", () => {
  it("has no embedded limit in the route evaluator", () => {
    // A kilogram limit, a metre clearance or a year are all four digits or more. The evaluator
    // compares against `attr.limitValue`; a literal here would be a number nobody can cite, and it
    // would keep answering confidently after the regulation that justified it changed.
    const literals = Array.from(code(evaluation).matchAll(/\b\d{4,}\b/g)).map(m => m[0]);
    expect(literals, "a numeric literal in the route evaluator that could be a regulatory value").toEqual([]);
  });

  it("takes every numeric comparison from the loaded attribute", () => {
    expect(evaluation).toMatch(/attr\.limitValue === null \|\| attr\.limitValue === undefined/);
    expect(evaluation).toMatch(/result: "unknown"/);   // no limit loaded is unknown, not clear
  });
});

describe("a limit satisfied on unverified data is not a pass", () => {
  it("answers review when the passing comparison rests on unverified data", () => {
    // The rule the whole axis exists for: "within the limit" and "within a limit we have checked"
    // are different claims, and only the second may clear a route.
    const branch = code(evaluation).slice(code(evaluation).indexOf("result: passes"));
    expect(branch).toMatch(/base\.confidence === "unverified"/);
    expect(branch).toMatch(/\?\s*"review"/);
    expect(branch).toMatch(/:\s*"pass"/);
  });

  it("defaults confidence to unverified when the attribute says nothing", () => {
    expect(evaluation).toMatch(/confidence: attr\?\.confidence \?\? \("unverified" as DataConfidence\)/);
  });
});

describe("every decision cites the data it used, by version", () => {
  it("carries source, version, verification date and confidence on each evidence entry", () => {
    for (const field of ["source", "sourceVersion", "verifiedAt", "confidence", "jurisdiction"]) {
      expect(evaluation, `evidence must carry ${field}`).toMatch(new RegExp(`${field}:`));
    }
  });

  it("writes those fields through to the stored evidence, not only to the in-memory verdict", () => {
    // A verdict that explains itself on screen and stores a bare result cannot be re-explained in
    // six months, which is when someone asks why a truck was routed this way.
    const insert = spatial.slice(spatial.indexOf("insert(routeEvidenceEntries)"), spatial.indexOf("insert(routeEvidenceEntries)") + 800);
    for (const field of ["source", "sourceVersion", "verifiedAt", "confidence"]) {
      expect(insert, `stored evidence must carry ${field}`).toContain(field);
    }
  });
});

describe("a restriction outside its effective window is not applied", () => {
  it("windows restrictions on both read paths", () => {
    const uses = Array.from(spatial.matchAll(/applicableRestrictions\(/g)).length;
    // Two paths read restrictions; both must window them. One unwindowed path is enough to enforce
    // a road ban that ended in April, or miss one that starts tomorrow.
    expect(uses).toBeGreaterThanOrEqual(2);
  });

  it("says which restrictions were set aside and why, rather than dropping them silently", () => {
    expect(spatial).toMatch(/setAside/);
    expect(spatial).toMatch(/dateNotes\.push/);
  });
});
