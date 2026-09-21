/**
 * P4.6 — the states a monitoring notice can be in, and why each is kept apart.
 *
 * Every case is one a real fleet reaches: a new hire nobody sent anything to, a notice sitting
 * unsigned in an inbox, a policy update that retired the old notice and never issued the new one.
 * Collapsing them into "not covered" would hide which of those a company is actually facing.
 */
import { describe, expect, it } from "vitest";
import { coverageAcross, coverageFor, noticeIsIntelligible, type NoticeRow } from "./monitoringNotice";

const AT = new Date("2026-09-18T12:00:00Z");
const notice = (over: Partial<NoticeRow> = {}): NoticeRow => ({
  id: 1, subjectUserId: 7, purpose: "vehicle_location", noticeVersion: "GPS-v3",
  issuedAt: new Date("2026-01-10T00:00:00Z"), acknowledgedAt: new Date("2026-01-11T00:00:00Z"),
  supersededAt: null, withdrawnAt: null, ...over,
});

describe("absence means not notified", () => {
  it("does not treat a worker with no notice as covered", () => {
    const c = coverageFor(7, "vehicle_location", [], AT);
    expect(c.covered).toBe(false);
    expect(c.state).toBe("not_notified");
    // The distinction that decides what somebody does next.
    expect(c.detail).toMatch(/Nobody told them; that is not the same as a notice they have not signed/);
  });

  it("does not let another person's notice cover this one", () => {
    expect(coverageFor(7, "vehicle_location", [notice({ subjectUserId: 8 })], AT).state).toBe("not_notified");
  });

  it("does not let a notice for one purpose cover another", () => {
    // Telling someone their truck reports its position does not cover reading the in-cab camera.
    const c = coverageFor(7, "in_cab_camera", [notice()], AT);
    expect(c.state).toBe("not_notified");
    expect(c.detail).toMatch(/video from inside the cab/);
  });

  it("ignores a notice issued after the moment being asked about", () => {
    const c = coverageFor(7, "vehicle_location", [notice({ issuedAt: new Date("2026-10-01T00:00:00Z") })], AT);
    expect(c.state).toBe("not_notified");
  });
});

describe("issued is not acknowledged", () => {
  it("keeps an unsigned notice separate from no notice at all", () => {
    const c = coverageFor(7, "vehicle_location", [notice({ acknowledgedAt: null })], AT);
    expect(c.covered).toBe(false);
    expect(c.state).toBe("issued_not_acknowledged");
    expect(c.detail).toMatch(/Sending it and their having read it are different facts/);
    expect(c.noticeVersion).toBe("GPS-v3");   // there is something to chase, and it is named
  });

  it("covers only an acknowledged, live notice", () => {
    const c = coverageFor(7, "vehicle_location", [notice()], AT);
    expect(c.covered).toBe(true);
    expect(c.state).toBe("acknowledged");
  });
});

describe("a notice that stopped applying", () => {
  it("reports a withdrawn notice as collection nobody has been told about", () => {
    const c = coverageFor(7, "vehicle_location", [notice({ withdrawnAt: new Date("2026-08-01T00:00:00Z") })], AT);
    expect(c.covered).toBe(false);
    expect(c.state).toBe("withdrawn");
    expect(c.detail).toMatch(/collection nobody has been told about/);
  });

  it("catches the quiet one: superseded and never replaced", () => {
    // A policy is updated, the old notice retired, and the replacement never issued to this person.
    // Both halves look done from their own side; nobody is covered.
    const c = coverageFor(7, "vehicle_location", [notice({ supersededAt: new Date("2026-07-01T00:00:00Z") })], AT);
    expect(c.state).toBe("superseded_not_replaced");
    expect(c.detail).toMatch(/The old one no longer covers them and the new one never reached them/);
  });

  it("is covered again once the replacement is issued and acknowledged", () => {
    const c = coverageFor(7, "vehicle_location", [
      notice({ id: 1, supersededAt: new Date("2026-07-01T00:00:00Z") }),
      notice({ id: 2, noticeVersion: "GPS-v4", issuedAt: new Date("2026-07-02T00:00:00Z"), acknowledgedAt: new Date("2026-07-03T00:00:00Z") }),
    ], AT);
    expect(c.covered).toBe(true);
    expect(c.noticeVersion).toBe("GPS-v4");
  });
});

describe("across the purposes a deployment actually uses", () => {
  it("names every gap rather than returning a count", () => {
    const r = coverageAcross(7, ["vehicle_location", "driver_duty_hours", "in_cab_camera"], [notice()], AT);
    expect(r.covered).toBe(false);
    expect(r.gaps.map(g => g.purpose)).toEqual(["driver_duty_hours", "in_cab_camera"]);
    expect(r.all).toHaveLength(3);
  });
});

describe("a notice has to say something", () => {
  it("refuses one too short to say what is collected", () => {
    const v = noticeIsIntelligible("vehicle_location", "We collect data.");
    expect(v.ok).toBe(false);
  });

  it("refuses one that points at a policy instead of saying what is collected", () => {
    const v = noticeIsIntelligible("vehicle_location", "The Company may collect operational data in accordance with its policies, as amended from time to time and available on request.");
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toMatch(/only function is to have been sent/);
  });

  it("accepts one that tells the person what happens", () => {
    const v = noticeIsIntelligible("vehicle_location",
      "While you are on duty, the vehicle you are driving reports its position continuously to LeaseOS. Dispatch and safety staff can see it. It is kept for two years and you can ask the office for a copy of yours at any time.");
    expect(v).toEqual({ ok: true });
  });
});
