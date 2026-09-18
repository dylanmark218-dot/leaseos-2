/**
 * P8.1 — the contract's two rules, and the failure each one prevents.
 *
 * Every case here is a state the system could reach with a feature switched off, which is the
 * situation the contract exists for: a company that did not buy compliance, or turned a module off,
 * must not have its dispatch bricked and must not have its invoices certify checks nobody ran.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  carryForward, combineForConsumer, fromCheckResult, fromEligibility, fromProjection, notEvaluated,
  type CapabilityResult, type ConsumerContract,
} from "./interEngineStatus";

const pass = (c: string): CapabilityResult => ({ capability: c, status: "PASS" });
const blocked = (c: string, detail: string): CapabilityResult => ({ capability: c, status: "BLOCKED", detail });

const DISPATCH: ConsumerContract = { consumer: "dispatch readiness", requires: ["hos", "inspection", "insurance"] };
const BILLING: ConsumerContract = { consumer: "billing readiness", requires: ["field ticket"], optional: ["hos"] };

describe("NOT_EVALUATED never rounds up to PASS", () => {
  it("holds a required unevaluated capability at REVIEW even when everything else passed", () => {
    const v = combineForConsumer(DISPATCH, [
      pass("inspection"), pass("insurance"),
      notEvaluated("hos", "module_disabled", "this company keeps paper logs"),
    ]);
    expect(v.status).toBe("REVIEW");                      // not PASS, though two of three passed
    expect(v.missingRequired).toEqual(["hos"]);
    expect(v.notEvaluated.map(r => r.capability)).toEqual(["hos"]);
    expect(v.explanation).toMatch(/hos not evaluated and required here/);
  });

  it("leaves the verdict alone for an optional capability, but still records the absence", () => {
    const v = combineForConsumer(BILLING, [
      pass("field ticket"),
      notEvaluated("hos", "not_licensed", "mapping-only account"),
    ]);
    expect(v.status).toBe("PASS");                        // billing does not need live hours
    expect(v.missingRequired).toEqual([]);
    expect(v.notEvaluated.map(r => r.capability)).toEqual(["hos"]);   // and it is still on the record
    expect(v.explanation).toMatch(/hos not evaluated, not required here/);
  });

  it("does not let an unrelated blocker hide the unevaluated one", () => {
    const v = combineForConsumer(DISPATCH, [
      blocked("inspection", "annual inspection expired 2026-08-14"),
      notEvaluated("hos", "module_disabled"),
      pass("insurance"),
    ]);
    expect(v.status).toBe("BLOCKED");
    expect(v.blockers.map(b => b.capability)).toEqual(["inspection"]);
    expect(v.missingRequired).toEqual(["hos"]);           // both facts survive, neither masks the other
    expect(v.explanation).toMatch(/blocked by inspection; hos not evaluated and required here/);
  });

  it("treats a required capability that answered nothing at all as an absence, not as consent", () => {
    // The module did not even report. Silence is the easiest thing to read as a pass.
    const v = combineForConsumer(DISPATCH, [pass("inspection"), pass("insurance")]);
    expect(v.status).toBe("REVIEW");
    expect(v.explanation).toMatch(/hos gave no answer at all/);
  });

  it("answers NOT_EVALUATED when nothing decided anything and the consumer requires nothing", () => {
    const v = combineForConsumer({ consumer: "route preview", requires: [] }, [
      notEvaluated("road bans", "no_data_source_loaded"),
      notEvaluated("bridge limits", "no_data_source_loaded"),
    ]);
    expect(v.status).toBe("NOT_EVALUATED");               // not PASS; nobody checked anything
    expect(v.notEvaluated.length).toBe(2);
  });

  it("refuses an unevaluated result with no reason", () => {
    expect(() => combineForConsumer(DISPATCH, [{ capability: "hos", status: "NOT_EVALUATED" }]))
      .toThrow(/no reason; an unexplained absence is not a record/);
  });
});

describe("the absence survives into billing and the archive", () => {
  it("carries the list forward with the reasons, rather than a summary that says everything was fine", () => {
    const v = combineForConsumer(BILLING, [pass("field ticket"), notEvaluated("hos", "module_disabled")]);
    const invoice = carryForward(v, "invoice INV-1042");
    expect(invoice.status).toBe("PASS");                  // the invoice may proceed
    expect(invoice.notEvaluated.map(r => r.capability)).toEqual(["hos"]);   // and still says what was not checked
    expect(invoice.note).toMatch(/not evaluated when billing readiness answered: hos \(module_disabled\)/);

    const archive = carryForward(v, "archive 2026-Q3");
    expect(archive.notEvaluated).toEqual(invoice.notEvaluated);
  });

  it("says plainly when there was nothing unevaluated, so the empty case is also a statement", () => {
    const v = combineForConsumer(BILLING, [pass("field ticket"), pass("hos")]);
    expect(carryForward(v, "invoice INV-1043").note).toMatch(/Every capability billing readiness reads was evaluated/);
  });
});

describe("each engine keeps its own union; the adapters translate", () => {
  it("maps routing's CheckResult, treating fail as an answer and unknown as unknown", () => {
    expect(fromCheckResult("bridge limit", "pass").status).toBe("PASS");
    expect(fromCheckResult("bridge limit", "fail").status).toBe("BLOCKED");    // fail decided something
    expect(fromCheckResult("bridge limit", "review").status).toBe("REVIEW");
    expect(fromCheckResult("bridge limit", "unknown").status).toBe("UNKNOWN"); // and unknown is not NOT_EVALUATED:
    // the check ran and could not tell. Not asking and not knowing are different facts.
  });

  it("maps the customer projection's READY onto PASS and leaves the rest alone", () => {
    expect(fromProjection("unit", "READY").status).toBe("PASS");
    expect(fromProjection("unit", "BLOCKED").status).toBe("BLOCKED");
    expect(fromProjection("worker", "UNKNOWN").status).toBe("UNKNOWN");
  });

  it("maps readiness eligibility, with eligible_review as a pass a person must look at", () => {
    expect(fromEligibility("dispatch", "eligible").status).toBe("PASS");
    expect(fromEligibility("dispatch", "eligible_review").status).toBe("REVIEW");
    expect(fromEligibility("dispatch", "ineligible").status).toBe("BLOCKED");
    expect(fromEligibility("dispatch", "something new").status).toBe("UNKNOWN");   // fail closed on a word we do not know
  });

  it("combines adapted results from three different engines without any of them changing", () => {
    const v = combineForConsumer(DISPATCH, [
      fromEligibility("inspection", "eligible"),
      fromProjection("insurance", "READY"),
      notEvaluated("hos", "not_licensed", "this account is mapping-only"),
    ]);
    expect(v.status).toBe("REVIEW");
    expect(v.notEvaluated[0]!.reason).toBe("not_licensed");
  });
});

describe("the structure, not only the behaviour", () => {
  it("keeps NOT_EVALUATED out of the severity table, which is what makes rule 1 structural", () => {
    // Rule 1 holds because NOT_EVALUATED cannot take part in the worst-of comparison at all. If a
    // later edit gave it a severity, every test above would still pass while the rule quietly
    // became a convention again - a set of passes plus one absence would compare as PASS.
    const src = readFileSync("server/_core/interEngineStatus.ts", "utf8");
    const decl = src.slice(src.indexOf("const SEVERITY"));
    // The KEYS only. The type annotation names NOT_EVALUATED in order to exclude it, so slicing
    // from the declaration would match the very thing being asserted absent.
    const keys = decl.slice(decl.indexOf("{") + 1, decl.indexOf("}"));
    expect(keys).not.toContain("NOT_EVALUATED");
    expect(decl).toMatch(/Record<Exclude<InterEngineStatus, "NOT_EVALUATED">, number>/);
    // And every adapter maps into a decided state: an adapter is a translation, never a way to
    // declare that something was not asked. Only notEvaluated() may say that.
    // Code only: the adapter comments name NOT_EVALUATED to explain why they never return it, and
    // an assertion that cannot tell prose from code fails on its own explanation.
    const adapterCode = src.slice(src.indexOf("/* Adapters"))
      .split("\n").filter(l => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");
    expect(adapterCode).not.toContain("NOT_EVALUATED");
    expect(adapterCode).toMatch(/fromCheckResult|fromProjection|fromEligibility/);
  });
});
