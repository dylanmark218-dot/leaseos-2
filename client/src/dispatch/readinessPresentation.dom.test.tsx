/**
 * The readiness presentation contract.
 *
 * This is the one place a server status becomes a thing on a screen, and the reason it is a
 * separate tested module rather than JSX is that every safety property of the dispatcher slice
 * lives here: a colour, a badge or a label must never reinterpret what the server said.
 *
 * Two vocabularies, deliberately not merged:
 *   capability status  PASS | REVIEW | BLOCKED | UNKNOWN | NOT_EVALUATED   (P8.1)
 *   eligibility verdict  eligible | eligible_review | blocked | unknown     (the engine)
 *
 * Nothing here recomputes readiness. It maps a string the server produced onto a presentation,
 * and refuses to guess when the string is not one it knows.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_STATUSES, ELIGIBILITY_VERDICTS, isReady,
  presentBlocker, presentCapability, presentVerdict, UNAVAILABLE,
} from "./readinessPresentation";

describe("capability status contract", () => {
  it("maps all five canonical statuses and nothing else", () => {
    expect([...CAPABILITY_STATUSES]).toEqual(["PASS", "REVIEW", "BLOCKED", "UNKNOWN", "NOT_EVALUATED"]);
  });

  it("presents PASS as ready — and it is the only capability status that is", () => {
    expect(presentCapability("PASS").readiness).toBe("ready");
    for (const s of CAPABILITY_STATUSES) if (s !== "PASS") expect(presentCapability(s).readiness).not.toBe("ready");
  });

  it("keeps REVIEW as review", () => {
    expect(presentCapability("REVIEW").readiness).toBe("review");
  });

  it("presents BLOCKED as blocked", () => {
    expect(presentCapability("BLOCKED").readiness).toBe("blocked");
  });

  it("presents UNKNOWN as insufficient information, never as pass or review", () => {
    const p = presentCapability("UNKNOWN");
    expect(p.readiness).toBe("insufficient");
    expect(p.readiness).not.toBe("ready");
    expect(p.readiness).not.toBe("review");
    expect(isReady(p)).toBe(false);
  });

  it("presents NOT_EVALUATED as not evaluated, never as pass or review", () => {
    const p = presentCapability("NOT_EVALUATED");
    expect(p.readiness).toBe("not_evaluated");
    expect(p.readiness).not.toBe("ready");
    expect(p.readiness).not.toBe("review");
    expect(isReady(p)).toBe(false);
  });

  it("refuses to guess at a status it does not know", () => {
    // A status the server has not published yet, a typo, a truncated payload: none of them is ready.
    for (const junk of ["pass", "Pass", "OK", "", "READY", "ELIGIBLE", "undefined", "null"]) {
      expect(isReady(presentCapability(junk)), `"${junk}" must not read as ready`).toBe(false);
      expect(presentCapability(junk)).toEqual(UNAVAILABLE);
    }
  });
});

describe("eligibility verdict contract", () => {
  it("maps all four engine verdicts and nothing else", () => {
    expect([...ELIGIBILITY_VERDICTS]).toEqual(["eligible", "eligible_review", "blocked", "unknown"]);
  });

  it("presents eligible as ready — and it is the only verdict that is", () => {
    expect(presentVerdict("eligible").readiness).toBe("ready");
    for (const v of ELIGIBILITY_VERDICTS) if (v !== "eligible") expect(presentVerdict(v).readiness).not.toBe("ready");
  });

  it("never lets eligible_review read as plain ready", () => {
    const p = presentVerdict("eligible_review");
    expect(p.readiness).toBe("review");
    expect(isReady(p)).toBe(false);
  });

  it("presents blocked as blocked", () => {
    expect(presentVerdict("blocked").readiness).toBe("blocked");
  });

  it("presents unknown as insufficient, because unknown outranks review in the engine", () => {
    expect(presentVerdict("unknown").readiness).toBe("insufficient");
    expect(isReady(presentVerdict("unknown"))).toBe(false);
  });

  it("refuses to guess at a verdict it does not know", () => {
    for (const junk of ["ready", "Eligible", "", "ok", "pass"]) {
      expect(isReady(presentVerdict(junk)), `"${junk}" must not read as ready`).toBe(false);
    }
  });
});

describe("isReady is the single gate", () => {
  it("is true for exactly one readiness value", () => {
    const all = ["ready", "review", "blocked", "insufficient", "not_evaluated", "unavailable"] as const;
    expect(all.filter(r => isReady({ readiness: r, label: "", meaning: "" }))).toEqual(["ready"]);
  });
});

describe("blocker presentation", () => {
  const b = (o: Partial<Parameters<typeof presentBlocker>[0]> = {}) =>
    presentBlocker({ code: "x", label: "X", severity: "review", subject: "truck", overridable: true, ...o });

  it("says a non-overridable blocker must be resolved, with no override offered", () => {
    const p = b({ overridable: false });
    expect(p.overrideState).toBe("none");
    expect(p.overrideNote).toContain("no override");
  });

  it("names the authority for an overridable review item", () => {
    expect(b({ severity: "review", overrideAuthority: "manager" }).overrideNote).toContain("manager");
  });

  it("says an overridable UNKNOWN item needs verification first", () => {
    expect(b({ severity: "unknown", overrideAuthority: "manager" }).overrideNote).toMatch(/verif/i);
  });

  /*
   * The award gate refuses every blocking blocker before it reads overrides
   * (_core/dispatchAward.ts). Two blockers in the tree are blocking AND overridable, so the flag
   * alone would tell a dispatcher something untrue.
   */
  it("warns that a blocking item cannot be awarded even when it is marked overridable", () => {
    const p = b({ severity: "blocking", overridable: true, overrideAuthority: "manager" });
    expect(p.overrideState).toBe("marked_overridable_but_blocking");
    expect(p.overrideNote).toMatch(/refused at award|cannot permit/i);
  });

  it("maps blocker severity onto the same readiness vocabulary as everything else", () => {
    expect(b({ severity: "blocking" }).readiness).toBe("blocked");
    expect(b({ severity: "unknown" }).readiness).toBe("insufficient");
    expect(b({ severity: "review" }).readiness).toBe("review");
  });

  it("never presents a blocker as ready, whatever it carries", () => {
    for (const severity of ["blocking", "unknown", "review"] as const)
      for (const overridable of [true, false])
        expect(isReady(b({ severity, overridable }))).toBe(false);
  });
});
