/**
 * v22.20 — what an inspector sees, and what they must never be shown.
 *
 * No rule code here asserts that any jurisdiction requires anything. The codes
 * are fixtures; what is tested is how the panel treats an evaluation somebody
 * else made.
 */
import { describe, expect, it } from "vitest";
import {
  axisState, buildRoadsidePanel, checkPanelAccess, NEVER_RELEASED, panelLines,
  type PanelGrant, type PanelItem,
} from "./_core/roadsidePanel";

const at = new Date("2026-09-11T12:00:00Z");
const item = (o: Partial<PanelItem> = {}): PanelItem => ({
  ruleCode: "FIXTURE.RULE.1", label: "A requirement", axis: "periodic_inspection",
  state: "ready", reason: "current", expiresAt: new Date("2027-02-03"), documentRef: "DOC-1", authority: "a fixture authority", ...o,
});
const panel = (items: PanelItem[], over: Parameters<typeof buildRoadsidePanel>[0] extends infer T ? Partial<T> : never = {}) =>
  buildRoadsidePanel({ unitRef: "UNIT-127", plate: "ABC-1234", vin: "1FUJ...", items, generatedAt: at, ...over });

describe("one status per unit is a lie", () => {
  it("keeps a roadworthy chassis green while a lifting certification is blocked", () => {
    const p = panel([
      item({ axis: "roadworthiness", ruleCode: "FX.ROAD", state: "ready" }),
      item({ axis: "periodic_inspection", ruleCode: "FX.CVIP", state: "ready" }),
      item({ axis: "lifting_equipment", ruleCode: "FX.CRANE.NDT", state: "blocked", reason: "certification expired 2026-09-09", expiresAt: new Date("2026-09-09") }),
    ]);
    expect(p.axes.find(a => a.axis === "roadworthiness")!.state).toBe("ready");
    expect(p.axes.find(a => a.axis === "lifting_equipment")!.state).toBe("blocked");
    expect(p.verdict).toBe("blocked");
    expect(p.blockingReasons).toEqual(["FX.CRANE.NDT — certification expired 2026-09-09"]);
    expect(p.headline).toContain("NOT AUTHORIZED TO OPERATE");
  });

  it("names the rule rather than showing a red icon", () => {
    const p = panel([item({ state: "blocked", ruleCode: "FX.TANK.TEST", reason: "containment test overdue" })]);
    expect(panelLines(p).join("\n")).toContain("FX.TANK.TEST — containment test overdue");
  });

  it("orders the page so the reason a truck is stopped is not on page two", () => {
    const lines = panelLines(panel([
      item({ axis: "documentation", state: "ready" }),
      item({ axis: "maintenance", state: "blocked", ruleCode: "FX.WO.CRITICAL", reason: "critical work order open" }),
    ]));
    expect(lines.indexOf("BLOCKING")).toBeLessThan(lines.findIndex(l => l.startsWith("Documentation")));
  });
});

describe("unknown is not compliance, and not inapplicability", () => {
  it("reads an item with no verified record as UNKNOWN, never ready", () => {
    const p = panel([item({ state: "unknown", ruleCode: "FX.CVIP", reason: "no verified certificate on record", expiresAt: null })]);
    expect(p.verdict).toBe("unknown");
    expect(p.headline).toContain("Unknown is not compliance");
    expect(p.unknownReasons[0]).toContain("no verified certificate on record");
  });

  it("distinguishes an axis that does not apply from one that could not be evaluated", () => {
    // A truck with no crane: lifting is absent from the panel entirely.
    const noCrane = panel([item({ axis: "roadworthiness" })]);
    expect(noCrane.axes.some(a => a.axis === "lifting_equipment")).toBe(false);

    // A truck WITH a crane whose records could not be read: UNKNOWN, not absent.
    const unreadable = panel([item({ axis: "roadworthiness" })], { unevaluatedAxes: ["lifting_equipment"] });
    expect(unreadable.axes.find(a => a.axis === "lifting_equipment")!.state).toBe("unknown");
    expect(unreadable.unknownReasons.join(" ")).toContain("applies to this unit and no verified record was found");
    expect(unreadable.verdict).toBe("unknown");
  });

  it("lets blocked outrank unknown, and unknown outrank review", () => {
    expect(axisState([item({ state: "review" }), item({ state: "unknown" }), item({ state: "blocked" })])).toBe("blocked");
    expect(axisState([item({ state: "review" }), item({ state: "unknown" })])).toBe("unknown");
    expect(axisState([item({ state: "review" }), item({ state: "ready" })])).toBe("review");
    expect(axisState([])).toBe("not_applicable");
  });

  it("is unknown, not ready, for a unit with nothing on it at all", () => {
    expect(panel([]).verdict).toBe("unknown");
  });
});

describe("what is withheld is listed", () => {
  it("always carries a withheld section, and names why each item is absent", () => {
    const p = panel([item()], {
      withheld: [
        { label: "Driver medical certificate", because: "medical" },
        { label: "Insurance premium", because: "financial" },
        { label: "Purchase cost", because: "commercial" },
      ],
    });
    const text = panelLines(p).join("\n");
    expect(text).toContain("WITHHELD (3)");
    expect(text).toContain("Driver medical certificate — medical");
    expect(p.notice).toContain("withheld by policy and listed below");
  });

  it("carries the section even when nothing was withheld, so its absence never reads as completeness", () => {
    expect(panelLines(panel([item()])).join("\n")).toContain("WITHHELD (0)");
  });

  it("names the categories that never cross the boundary", () => {
    expect([...NEVER_RELEASED].sort()).toEqual(["commercial", "financial", "medical", "personal"]);
  });

  it("exposes no person in the data, while the notice may still name what is withheld", () => {
    const p = panel([item({ label: "Periodic inspection", reason: "current" })], {
      withheld: [{ label: "Driver medical certificate", because: "medical" }],
    });
    // The assertion is about the payload. `notice` and `withheld` deliberately
    // name the categories that are absent — saying "medical information is
    // withheld" is the honest disclosure, not a leak of medical information.
    const payload = JSON.stringify({ axes: p.axes, blockingReasons: p.blockingReasons, unknownReasons: p.unknownReasons, unitRef: p.unitRef }).toLowerCase();
    for (const forbidden of ["driverid", "operatorid", "employee", "medical", "premium", "salary", "person"]) {
      expect(payload.includes(forbidden)).toBe(false);
    }
    // And the disclosure is still there.
    expect(p.withheld).toHaveLength(1);
    expect(p.notice.toLowerCase()).toContain("medical");
  });
});

describe("possession of the code is not access", () => {
  const grant = (o: Partial<PanelGrant> = {}): PanelGrant => ({
    grantRef: "PG-1", unitRef: "UNIT-127", issuedAt: at,
    expiresAt: new Date(at.getTime() + 3_600_000), issuedFor: "roadside inspection", revokedAt: null, ...o,
  });

  it("allows a live grant for this unit, and says who it was issued for", () => {
    const r = checkPanelAccess(grant(), "UNIT-127", at);
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain("issued for roadside inspection");
  });

  it("refuses a code that resolves to nothing — a photographed sticker gets nothing", () => {
    expect(checkPanelAccess(null, "UNIT-127", at)).toMatchObject({ allowed: false, because: "no_grant" });
  });

  it("refuses an expired or revoked grant, and names when", () => {
    expect(checkPanelAccess(grant({ expiresAt: new Date(at.getTime() - 1) }), "UNIT-127", at)).toMatchObject({ allowed: false, because: "expired" });
    expect(checkPanelAccess(grant({ revokedAt: new Date(at.getTime() - 60_000) }), "UNIT-127", at)).toMatchObject({ allowed: false, because: "revoked" });
  });

  it("refuses a grant presented against a different unit", () => {
    expect(checkPanelAccess(grant(), "UNIT-999", at)).toMatchObject({ allowed: false, because: "wrong_unit" });
  });
});
