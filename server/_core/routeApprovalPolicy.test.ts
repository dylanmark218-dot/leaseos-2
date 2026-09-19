/**
 * §10.4 — coverage is evidence, risk is the trigger, and a FAIL is nobody's to sign.
 *
 * The cases below are the ones the owner decision was written to get right, and the first is the
 * one that made a percentage threshold the wrong design.
 */
import { describe, expect, it } from "vitest";
import { assessRouteApproval, type CheckOutcome } from "./routeApprovalPolicy";

const check = (o: Partial<CheckOutcome> = {}): CheckOutcome =>
  ({ axis: "weight", segmentId: "OSM-AB-way/1", result: "unknown", verified: false,
     highConsequence: false, detail: "no weight evidence", ...o });

/** An ordinary Alberta back-road leg: topology everywhere, legal limits almost nowhere. */
const ordinaryRoute = Array.from({ length: 40 }, (_, i) =>
  check({ segmentId: `OSM-AB-way/${i}`, axis: "weight", result: "unknown" }));

describe("low coverage alone does not require a second approver", () => {
  it("lets a forty-segment route with no weight data through on one signature", () => {
    /*
     * The reason the threshold design was rejected. 24 maxweight tags exist across 512,979 ways, so
     * this route is not unusual — it is typical. A percentage gate would demand two signatures for
     * every load in the province, and a signature given hundreds of times a week is a keystroke.
     */
    const a = assessRouteApproval(ordinaryRoute);
    expect(a.secondApprovalRequired).toBe(false);
    expect(a.byAxis[0]!.coveragePercent).toBe(0);
    expect(a.explanation).toMatch(/recorded as evidence, not as a gate/);
  });

  it("still reports the coverage prominently rather than hiding it", () => {
    const a = assessRouteApproval(ordinaryRoute);
    expect(a.byAxis[0]).toMatchObject({ axis: "weight", applicable: 40, verified: 0, absent: 40 });
    expect(a.totalApplicable).toBe(40);
  });
});

describe("a specific unresolved high-consequence fact does require one", () => {
  it("triggers on an unknown capacity for a bridge this route crosses", () => {
    // Not "Alberta has not published bridge capacities" — this bridge, on this route.
    const a = assessRouteApproval([...ordinaryRoute,
      check({ axis: "bridge", segmentId: "AB-ACCESS-88", result: "unknown", highConsequence: true, detail: "no rated capacity on the Athabasca crossing" })]);
    expect(a.secondApprovalRequired).toBe(true);
    expect(a.triggers).toHaveLength(1);
    expect(a.triggers[0]!.reason).toMatch(/unresolved on AB-ACCESS-88, which this route uses/);
  });

  it("triggers when a required clearance rests on unverified evidence", () => {
    // Satisfied, and on data nobody checked — the same distinction the routing axis already makes.
    const a = assessRouteApproval([check({ axis: "height", segmentId: "AB-ACCESS-9", result: "pass", verified: false, highConsequence: true, detail: "OSM maxheight 4.3 m" })]);
    expect(a.secondApprovalRequired).toBe(true);
    expect(a.triggers[0]!.reason).toMatch(/cleared on unverified evidence/);
  });

  it("triggers on two authorities disagreeing, without averaging them", () => {
    const a = assessRouteApproval([check({ axis: "seasonal", segmentId: "AB-ACCESS-4", result: "review", verified: true, conflicting: true, detail: "road ban lifted per municipality, in force per province" })]);
    expect(a.secondApprovalRequired).toBe(true);
    expect(a.byAxis[0]!.conflicting).toBe(1);
    expect(a.triggers[0]!.reason).toMatch(/authorities disagree/);
  });

  it("does not trigger on an unresolved fact about a road the route does not use", () => {
    // highConsequence is the applicability flag: an unknown bridge rating the route never meets is
    // not this route's problem, and treating it as one is how the list stops being read.
    const a = assessRouteApproval([check({ axis: "bridge", result: "unknown", highConsequence: false })]);
    expect(a.secondApprovalRequired).toBe(false);
  });
});

describe("a failure is not approvable by anybody", () => {
  it("reports a FAIL as blocking, never as a trigger", () => {
    /*
     * The sharp one. A second approver is permission to proceed on something nobody could
     * establish; it is not permission to proceed on something established as false. If a FAIL
     * appeared in the trigger list, the interface would invite exactly that reading.
     */
    const a = assessRouteApproval([
      check({ axis: "weight", segmentId: "AB-ACCESS-12", result: "fail", verified: true, highConsequence: true, detail: "63,500 kg exceeds the posted 29,000 kg" }),
      check({ axis: "bridge", segmentId: "AB-ACCESS-88", result: "unknown", highConsequence: true }),
    ]);
    expect(a.blocking).toHaveLength(1);
    expect(a.triggers.map(t => t.segmentId)).not.toContain("AB-ACCESS-12");
    expect(a.explanation).toMatch(/^Not approvable/);
    expect(a.explanation).toMatch(/A second approver cannot clear a failed check/);
  });

  it("says so before anything else, however many other items are unresolved", () => {
    const a = assessRouteApproval([...ordinaryRoute,
      check({ axis: "weight", segmentId: "AB-ACCESS-12", result: "fail", verified: true, detail: "over the posted limit" })]);
    expect(a.explanation.startsWith("Not approvable")).toBe(true);
  });
});

describe("coverage is computed per axis, not as one number", () => {
  it("keeps the axes apart, because they are answered by different sources", () => {
    const a = assessRouteApproval([
      check({ axis: "height", result: "pass", verified: true }),
      check({ axis: "height", result: "pass", verified: true }),
      check({ axis: "weight", result: "unknown" }),
      check({ axis: "weight", result: "unknown" }),
    ]);
    const byAxis = Object.fromEntries(a.byAxis.map(x => [x.axis, x.coveragePercent]));
    expect(byAxis.height).toBe(100);
    expect(byAxis.weight).toBe(0);
    // A single blended figure would read as 50% and describe neither.
    expect(a.byAxis).toHaveLength(2);
  });
});
