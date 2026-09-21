/**
 * §10.3 — the four cases the owner decision names, plus the rule underneath them.
 */
import { describe, expect, it } from "vitest";
import { provisionalRestriction, resolvePrecedence, type SourceClaim } from "./sourcePrecedence";

const AT = new Date("2026-09-19T08:00:00Z");
const claim = (o: Partial<SourceClaim> & Pick<SourceClaim, "authority" | "posture">): SourceClaim =>
  ({ statement: `${o.authority} says ${o.posture}`, observedAt: AT, verified: true, ...o });

describe("a field observation may tighten", () => {
  it("downgrades an officially open road on a credible washout report", () => {
    // Believing him costs a detour. Disbelieving him costs a truck.
    const v = resolvePrecedence([
      claim({ authority: "official_restriction", posture: "open", statement: "511 lists the corridor open" }),
      claim({ authority: "leaseos_field_hazard", posture: "restricted", statement: "Bridge deck washed out at the creek crossing", verified: false }),
    ]);
    expect(v.effective).toBe("restricted");
    expect(v.governedBy.authority).toBe("leaseos_field_hazard");
    expect(v.conflicting).toBe(true);
  });

  it("acts on an unverified observation rather than waiting for corroboration", () => {
    // Waiting for verification before acting on a reported washout means the next truck drives at it.
    const v = resolvePrecedence([claim({ authority: "leaseos_field_hazard", posture: "closed", verified: false })]);
    expect(v.effective).toBe("closed");
  });
});

describe("a field observation may never loosen", () => {
  it("leaves an officially closed road closed when a driver says it looks open", () => {
    /*
     * The absence of a visible reason is not evidence that the reason is absent. The closure may be
     * a load restriction, a permit condition, or work starting tomorrow.
     */
    const v = resolvePrecedence([
      claim({ authority: "official_restriction", posture: "closed", statement: "Closed for bridge replacement" }),
      claim({ authority: "leaseos_field_hazard", posture: "open", statement: "Road looks fine, no barricade", verified: false }),
    ]);
    expect(v.effective).toBe("closed");
    expect(v.governedBy.authority).toBe("official_restriction");
    expect(v.toLift).toMatch(/Only posted_road_authority or official_restriction may lift this/);
  });

  it("leaves an unknown road unknown when a driver says it looks clear", () => {
    // Same rule the evaluator already applies to a limit satisfied on unverified data.
    const v = resolvePrecedence([
      claim({ authority: "official_restriction", posture: "unknown", statement: "No restriction data loaded for this segment" }),
      claim({ authority: "leaseos_field_hazard", posture: "open", statement: "Drove it last week, no signs", verified: false }),
    ]);
    expect(v.effective).toBe("unknown");
  });

  it("does not let open map data override a posted sign", () => {
    const v = resolvePrecedence([
      claim({ authority: "posted_road_authority", posture: "restricted", statement: "Posted 10 t seasonal" }),
      claim({ authority: "open_map_data", posture: "open", statement: "OSM has no restriction tag", verified: false }),
    ]);
    expect(v.effective).toBe("restricted");
  });
});

describe("a disagreement is surfaced, not tidied away", () => {
  it("keeps every claim, including the ones that did not govern", () => {
    const v = resolvePrecedence([
      claim({ authority: "official_restriction", posture: "closed" }),
      claim({ authority: "leaseos_field_hazard", posture: "open", verified: false }),
      claim({ authority: "open_map_data", posture: "open", verified: false }),
    ]);
    expect(v.claims).toHaveLength(3);
    expect(v.conflicting).toBe(true);
    expect(v.explanation).toMatch(/2 other source\(s\) read it as less restrictive and do not govern/);
    expect(v.explanation).toMatch(/Both are kept on the record/);
  });

  it("is not settled by whichever record arrived last", () => {
    // Order is not authority. The same two claims resolve the same way either way round.
    const official = claim({ authority: "official_restriction", posture: "closed" });
    const field = claim({ authority: "leaseos_field_hazard", posture: "open", observedAt: new Date("2026-09-19T23:00:00Z"), verified: false });
    expect(resolvePrecedence([official, field]).effective).toBe("closed");
    expect(resolvePrecedence([field, official]).effective).toBe("closed");
  });

  it("says nothing is known rather than guessing when no source speaks", () => {
    const v = resolvePrecedence([]);
    expect(v.effective).toBe("unknown");
    expect(v.explanation).toMatch(/Nothing is recorded about this segment/);
  });
});

describe("a provisional restriction is temporary by construction", () => {
  it("is raised by one of our own people without verification", () => {
    const c = provisionalRestriction({ statement: "Culvert collapsed, road impassable", observedAt: AT, observerIsOurs: true })!;
    expect(c.posture).toBe("restricted");
    expect(c.verified).toBe(false);
    expect(c.authority).toBe("leaseos_field_hazard");
  });

  it("is not raised by an unattributed report", () => {
    // An unattributed report is not yet an observation; there is nobody to ask.
    expect(provisionalRestriction({ statement: "heard the road is out", observedAt: AT, observerIsOurs: false })).toBeNull();
  });

  it("names the authority needed to lift it, so it cannot simply lapse", () => {
    const c = provisionalRestriction({ statement: "Bridge deck damaged", observedAt: AT, observerIsOurs: true })!;
    const v = resolvePrecedence([c]);
    expect(v.toLift).toMatch(/may lift this; a lower-ranking source reporting it clear does not/);
  });
});
