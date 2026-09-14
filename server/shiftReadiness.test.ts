/**
 * v22.20 — the 9pm screen, and the swap two people cannot approve themselves.
 */
import { describe, expect, it } from "vitest";
import {
  checkSeverity, evaluateSwap, readyForShift,
  type Assignment, type Person, type ReadinessCheck,
} from "./_core/shiftReadiness";

const START = new Date("2026-09-19T06:00:00Z");
const check = (o: Partial<ReadinessCheck> = {}): ReadinessCheck => ({
  key: "unit", label: "Unit 127 assigned", state: "satisfied", blocksShift: true, reason: null, ...o,
});

describe("ready for tomorrow is honest at 9pm or it is worthless", () => {
  it("reads READY only when everything checked actually answered", () => {
    const r = readyForShift({ shiftStartsAt: START, checks: [check(), check({ key: "route", label: "Route downloaded" })] });
    expect(r.verdict).toBe("ready");
    expect(r.headline).toContain("everything checked is in order");
  });

  it("reads INCOMPLETE, not READY, when a check could not run", () => {
    const r = readyForShift({
      shiftStartsAt: START,
      checks: [check(), check({ key: "orientation", label: "Client orientation", state: "unknown", reason: "no verified record on file" })],
    });
    expect(r.verdict).toBe("incomplete");
    expect(r.headline).toContain("Unknown is not ready");
    expect(r.unknown).toHaveLength(1);
  });

  it("keeps 'something is missing' apart from 'we could not tell'", () => {
    // They send a person to different places: one to fix it, one to ask.
    const missing = readyForShift({ shiftStartsAt: START, checks: [check({ key: "permit", label: "Job permit", state: "failed", reason: "not uploaded" })] });
    const cannotTell = readyForShift({ shiftStartsAt: START, checks: [check({ key: "permit", label: "Job permit", state: "unknown", reason: "permit system unreachable" })] });
    expect(missing.verdict).toBe("not_ready");
    expect(cannotTell.verdict).toBe("incomplete");
  });

  it("does not let an advisory failure stop the shift", () => {
    const r = readyForShift({
      shiftStartsAt: START,
      checks: [check(), check({ key: "receipt", label: "Yesterday's meal receipt", state: "failed", blocksShift: false, reason: "not submitted" })],
    });
    expect(r.verdict).toBe("ready");
    expect(r.advisory).toHaveLength(1);
    expect(r.headline).toContain("1 thing(s) worth knowing");
  });

  it("puts the reason a person cannot start above the list of things that are fine", () => {
    const r = readyForShift({
      shiftStartsAt: START,
      checks: [
        check({ key: "route", label: "Route downloaded" }),
        check({ key: "tdg", label: "TDG current", state: "failed", reason: "expired 2026-09-10" }),
        check({ key: "orient", label: "Site orientation", state: "unknown", reason: "not established" }),
      ],
    });
    expect(r.lines[0]).toContain("MISSING · TDG current");
    expect(r.lines[1]).toContain("UNKNOWN · Site orientation");
    expect(r.lines[2]).toContain("OK · Route downloaded");
  });

  it("drops a check that does not apply, rather than showing it as satisfied", () => {
    const r = readyForShift({ shiftStartsAt: START, checks: [check(), check({ key: "crane", label: "Crane certification", state: "not_applicable" })] });
    expect(r.satisfied).toHaveLength(1);
    expect(r.lines.some(l => l.includes("Crane"))).toBe(false);
  });

  it("speaks the calendar's severity vocabulary rather than inventing a second one", () => {
    expect(checkSeverity(check({ state: "unknown" }))).toBe("unknown");
    expect(checkSeverity(check({ state: "failed", blocksShift: true }))).toBe("blocking");
    expect(checkSeverity(check({ state: "failed", blocksShift: false }))).toBe("overdue");
    expect(checkSeverity(check({ state: "satisfied" }))).toBe("informational");
  });
});

const assignment = (ref: string, o: Partial<Assignment> = {}): Assignment => ({
  assignmentRef: ref, startsAt: new Date("2026-09-24T18:00:00Z"), endsAt: new Date("2026-09-25T06:00:00Z"),
  requiredQualifications: ["TDG"], requiredRole: "driver", ...o,
});
const person = (name: string, o: Partial<Person> = {}): Person => ({
  userId: name.length, name, roles: ["driver"], currentQualifications: ["TDG"], existingAssignments: [], ...o,
});

describe("two people agreeing is not coverage", () => {
  const jordanGives = assignment("SHIFT-24-NIGHT");
  const mikeGives = assignment("SHIFT-26-DAY", { startsAt: new Date("2026-09-26T06:00:00Z"), endsAt: new Date("2026-09-26T18:00:00Z") });

  it("permits a swap where both can do the other's work, and still sends it to a supervisor", () => {
    const r = evaluateSwap({ a: person("Jordan"), aGives: jordanGives, b: person("Mike"), bGives: mikeGives, hosKnown: true });
    expect(r.permitted).toBe(true);
    expect(r.requiresSupervisorApproval).toBe(true);
    expect(r.note).toContain("Two people agreeing is not coverage");
  });

  it("refuses when the taker lacks a qualification the work requires", () => {
    const mike = person("Mike", { currentQualifications: [] });   // an expired one is simply absent
    const r = evaluateSwap({ a: person("Jordan"), aGives: jordanGives, b: mike, bGives: mikeGives, hosKnown: true });
    expect(r.permitted).toBe(false);
    expect(r.objections[0]).toMatchObject({ code: "missing_qualification", who: "Mike" });
    expect(r.objections[0].detail).toContain("no current TDG");
    expect(r.note).toContain("does not make either of them qualified");
  });

  it("refuses when the taker does not hold the role the assignment is for", () => {
    const r = evaluateSwap({
      a: person("Jordan"), aGives: jordanGives,
      b: person("Mike", { roles: ["swamper"] }), bGives: mikeGives, hosKnown: true,
    });
    expect(r.objections.some(o => o.code === "wrong_role")).toBe(true);
  });

  it("refuses when the taker is already working then, ignoring the shift they are handing over", () => {
    const clash = assignment("OTHER-JOB", { startsAt: new Date("2026-09-24T20:00:00Z"), endsAt: new Date("2026-09-25T04:00:00Z") });
    const mike = person("Mike", { existingAssignments: [mikeGives, clash] });
    const r = evaluateSwap({ a: person("Jordan"), aGives: jordanGives, b: mike, bGives: mikeGives, hosKnown: true });
    expect(r.objections.some(o => o.code === "overlaps_existing" && o.detail.includes("OTHER-JOB"))).toBe(true);
    // The shift being given away is not counted as a clash with itself.
    expect(r.objections.some(o => o.detail.includes("SHIFT-26-DAY, which Mike already holds"))).toBe(false);
  });

  it("objects when the hours-of-service effect is not established, rather than assuming it away", () => {
    const r = evaluateSwap({ a: person("Jordan"), aGives: jordanGives, b: person("Mike"), bGives: mikeGives, hosKnown: false });
    expect(r.permitted).toBe(false);
    expect(r.objections[0]).toMatchObject({ code: "hos_unknown" });
  });

  it("checks both directions, not just the person who asked", () => {
    const jordan = person("Jordan", { currentQualifications: [] });
    const r = evaluateSwap({ a: jordan, aGives: jordanGives, b: person("Mike"), bGives: mikeGives, hosKnown: true });
    expect(r.objections.some(o => o.who === "Jordan")).toBe(true);
  });
});
