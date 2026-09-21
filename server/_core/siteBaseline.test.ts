import { describe, expect, it } from "vitest";
import {
  MINIMUM_SAMPLES,
  PHASE_BOUNDARIES,
  STOP_PHASES,
  UNKNOWN_CONFIRMATION,
  UNKNOWN_PRECISION,
  assessStop,
  buildSiteBaseline,
  combineBoundaries,
  phaseConfirmation,
  unmeasuredSiteNotice,
  type BoundaryConfirmation,
  type BoundaryKey,
  type PhaseConfirmation,
  type PhasePrecision,
  type SiteKey,
  type StopPhase,
  type StopSample,
} from "./siteBaseline";

const SITE: SiteKey = { facilityId: 41, locationId: null, stopType: "unload" };

const allPhases = (v: PhaseConfirmation): Record<StopPhase, PhaseConfirmation> => ({
  setup: v, operation: v, wait: v, total: v,
});

const CONFIRMED = allPhases("confirmed");

const allPrecision = (v: PhasePrecision): Record<StopPhase, PhasePrecision> => ({
  setup: v, operation: v, wait: v, total: v,
});
const EXACT = allPrecision("exact");

const sample = (
  id: number,
  minutes: number,
  confirmation: Record<StopPhase, PhaseConfirmation> = CONFIRMED,
  overrides: Partial<StopSample> = {},
): StopSample => ({
  tripStopId: id,
  observedAt: new Date(2026, 0, id),
  setupMinutes: minutes,
  operationMinutes: minutes * 2,
  waitMinutes: 10,
  totalMinutes: minutes * 3 + 10,
  confirmation,
  precision: EXACT,
  ...overrides,
});

/** Twelve stops: setup clusters near 20 min with real spread. */
const HISTORY: StopSample[] = [18, 19, 20, 20, 21, 22, 20, 19, 23, 20, 21, 18].map((m, i) =>
  sample(i + 1, m),
);

const allBoundaries = (v: BoundaryConfirmation): Record<BoundaryKey, BoundaryConfirmation> => ({
  arrivedAt: v, setupStartedAt: v, operationStartedAt: v, operationCompletedAt: v, departedAt: v,
});

/* ------------------------------------------------------------------ */

describe("combineBoundaries", () => {
  it("confirms only when both bounds are confirmed", () => {
    expect(combineBoundaries("confirmed", "confirmed")).toBe("confirmed");
    expect(combineBoundaries("confirmed", "unconfirmed")).toBe("unconfirmed");
    expect(combineBoundaries("unconfirmed", "confirmed")).toBe("unconfirmed");
  });

  it("lets unknown dominate unconfirmed in either order", () => {
    expect(combineBoundaries("unknown", "unconfirmed")).toBe("unknown");
    expect(combineBoundaries("unconfirmed", "unknown")).toBe("unknown");
    expect(combineBoundaries("confirmed", "unknown")).toBe("unknown");
  });

  it("is symmetric across every pairing", () => {
    const states: BoundaryConfirmation[] = ["confirmed", "unconfirmed", "unknown"];
    for (const a of states) for (const b of states) {
      expect(combineBoundaries(a, b)).toBe(combineBoundaries(b, a));
    }
  });
});

describe("phaseConfirmation", () => {
  it("derives every phase from its own bounds", () => {
    expect(phaseConfirmation(allBoundaries("confirmed"))).toEqual(allPhases("confirmed"));
    expect(phaseConfirmation(allBoundaries("unknown"))).toEqual(UNKNOWN_CONFIRMATION);
  });

  it("leaves setup usable when only the departure is unconfirmed", () => {
    const c = phaseConfirmation({ ...allBoundaries("confirmed"), departedAt: "unconfirmed" });
    expect(c.setup).toBe("confirmed");
    expect(c.operation).toBe("confirmed");
    expect(c.total).toBe("unconfirmed");
  });

  it("spends an unconfirmed arrival on wait and total, not on setup", () => {
    const c = phaseConfirmation({ ...allBoundaries("confirmed"), arrivedAt: "unconfirmed" });
    expect(c.setup).toBe("confirmed");
    expect(c.wait).toBe("unconfirmed");
    expect(c.total).toBe("unconfirmed");
  });

  it("covers every phase with a boundary pair", () => {
    for (const phase of STOP_PHASES) expect(PHASE_BOUNDARIES[phase]).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */

describe("buildSiteBaseline", () => {
  it("establishes a baseline once enough confirmed samples exist", () => {
    const b = buildSiteBaseline(SITE, HISTORY);
    expect(b.phases.setup.state).toBe("established");
    expect(b.phases.setup.sampleCount).toBe(12);
    expect(b.phases.setup.medianMinutes).toBe(20);
    expect(b.unmeasured).toBe(false);
  });

  it("refuses a baseline below the sample minimum and says so", () => {
    const b = buildSiteBaseline(SITE, HISTORY.slice(0, MINIMUM_SAMPLES - 1));
    expect(b.phases.setup.state).toBe("insufficient_history");
    expect(b.unmeasured).toBe(true);
  });

  it("keeps a sound setup sample whose departure was never confirmed", () => {
    const partial = HISTORY.map(s =>
      sample(s.tripStopId, s.setupMinutes as number, {
        setup: "confirmed", operation: "confirmed", wait: "unconfirmed", total: "unconfirmed",
      }),
    );
    const b = buildSiteBaseline(SITE, partial);

    // This is the regression the per-stop boolean caused: setup survives, total does not.
    expect(b.phases.setup.state).toBe("established");
    expect(b.phases.setup.sampleCount).toBe(12);
    expect(b.phases.total.state).toBe("insufficient_history");
    expect(b.phases.total.sampleCount).toBe(0);
    expect(b.phases.total.excludedUnconfirmed).toBe(12);
  });

  it("counts unconfirmed and unrecorded exclusions separately", () => {
    const mixed = [
      ...HISTORY.slice(0, 3),
      ...[30, 31, 32].map((m, i) => sample(40 + i, m, allPhases("unconfirmed"))),
      ...[40, 41].map((m, i) => sample(60 + i, m, UNKNOWN_CONFIRMATION)),
    ];
    const b = buildSiteBaseline(SITE, mixed);
    expect(b.phases.setup.sampleCount).toBe(3);
    expect(b.phases.setup.excludedUnconfirmed).toBe(3);
    expect(b.phases.setup.excludedUnknownProvenance).toBe(2);
  });

  it("excludes unconfirmed samples entirely rather than down-weighting them", () => {
    const withProposals = [
      ...HISTORY.slice(0, 4),
      ...[400, 410, 420, 430, 440, 450, 460, 470].map((m, i) =>
        sample(100 + i, m, allPhases("unconfirmed")),
      ),
    ];
    const b = buildSiteBaseline(SITE, withProposals);
    expect(b.phases.setup.sampleCount).toBe(4);
    expect(b.phases.setup.state).toBe("insufficient_history");
    // Median of the four confirmed values [18, 19, 20, 20], untouched by the 400+ proposals.
    expect(b.phases.setup.medianMinutes).toBe(19.5);
  });

  it("reports an all-unknown history as unmeasured, not as empty", () => {
    const b = buildSiteBaseline(SITE, HISTORY.map(s => ({ ...s, confirmation: UNKNOWN_CONFIRMATION })));
    expect(b.unmeasured).toBe(true);
    expect(b.phases.setup.sampleCount).toBe(0);
    expect(b.phases.setup.excludedUnknownProvenance).toBe(12);
    expect(b.phases.setup.excludedUnconfirmed).toBe(0);
  });

  it("does not count a missing value as an exclusion", () => {
    const b = buildSiteBaseline(SITE, [
      ...HISTORY,
      sample(90, 20, UNKNOWN_CONFIRMATION, { setupMinutes: null }),
    ]);
    expect(b.phases.setup.excludedUnknownProvenance).toBe(0);
    expect(b.phases.operation.excludedUnknownProvenance).toBe(1);
  });

  it("drops negative durations as data faults instead of clamping them", () => {
    const b = buildSiteBaseline(SITE, [...HISTORY, sample(99, -5)]);
    expect(b.phases.setup.sampleCount).toBe(12);
  });

  it("records the span of the samples it actually used", () => {
    const b = buildSiteBaseline(SITE, [
      ...HISTORY,
      sample(99, 20, UNKNOWN_CONFIRMATION, { observedAt: new Date(2026, 5, 1) }),
    ]);
    expect(b.phases.setup.oldestSampleAt).toEqual(new Date(2026, 0, 1));
    expect(b.phases.setup.newestSampleAt).toEqual(new Date(2026, 0, 12));
  });
});

/* ------------------------------------------------------------------ */

describe("precision", () => {
  it("excludes an approximate phase and counts it as its own kind", () => {
    const b = buildSiteBaseline(SITE, [
      ...HISTORY.slice(0, 3),
      ...[20, 20, 20].map((m, i) => sample(70 + i, m, CONFIRMED, { precision: allPrecision("approximate") })),
    ]);
    expect(b.phases.setup.sampleCount).toBe(3);
    expect(b.phases.setup.excludedApproximate).toBe(3);
    expect(b.phases.setup.excludedUnconfirmed).toBe(0);
    expect(b.phases.setup.excludedUnknownProvenance).toBe(0);
  });

  it("treats unrecorded precision as unrecorded provenance, even when confirmed", () => {
    const b = buildSiteBaseline(SITE, [
      ...HISTORY.slice(0, 3),
      ...[20, 20].map((m, i) => sample(80 + i, m, CONFIRMED, { precision: UNKNOWN_PRECISION })),
    ]);
    expect(b.phases.setup.sampleCount).toBe(3);
    expect(b.phases.setup.excludedUnknownProvenance).toBe(2);
    expect(b.phases.setup.excludedApproximate).toBe(0);
  });

  it("counts a sample once, under the answer furthest from a remedy", () => {
    // Unconfirmed AND approximate. Confirming it would still leave it approximate,
    // so it belongs in the queue a person can actually work.
    const b = buildSiteBaseline(SITE, [
      sample(90, 20, allPhases("unconfirmed"), { precision: allPrecision("approximate") }),
    ]);
    expect(b.phases.setup.excludedUnconfirmed).toBe(1);
    expect(b.phases.setup.excludedApproximate).toBe(0);

    // Unknown provenance hides both other answers, so it wins over them.
    const c = buildSiteBaseline(SITE, [
      sample(91, 20, UNKNOWN_CONFIRMATION, { precision: allPrecision("approximate") }),
    ]);
    expect(c.phases.setup.excludedUnknownProvenance).toBe(1);
    expect(c.phases.setup.excludedApproximate).toBe(0);
  });

  /*
   * Why the rule exists, measured rather than asserted.
   *
   * Approximate durations do not raise false alarms — they silence real ones.
   * Rounding collapses the MAD to zero, which switches assessPhase off the robust
   * z-score and onto the much looser multiple-of-median fallback.
   */
  /*
   * The MAD === 0 branch is not the degenerate case, and the comment that said so
   * was wrong. It engages as soon as MORE THAN HALF the samples share the median,
   * whatever spread sits either side — so it is the ordinary state of a
   * consistent site, and likeliest of all at the sample floor.
   */
  it("collapses MAD once more than half the samples share the median", () => {
    const around = [17, 18, 19, 21, 22, 23, 16, 25];
    const withCopies = (n: number, total: number) =>
      buildSiteBaseline(SITE, [...Array(n).fill(20), ...around.slice(0, total - n)]
        .map((m, i) => sample(i + 1, m as number))).phases.setup.madMinutes;

    // Twelve samples: six at the median is not enough, seven is.
    expect(withCopies(6, 12)).toBe(0.5);
    expect(withCopies(7, 12)).toBe(0);

    // Eleven: five is not enough, six is.
    expect(withCopies(5, 11)).toBe(1);
    expect(withCopies(6, 11)).toBe(0);

    // Eight — MINIMUM_SAMPLES, so the first baseline any site ever gets. Five of
    // eight puts it on the loose rule from the very first day it has one.
    expect(withCopies(4, 8)).toBe(0.5);
    expect(withCopies(5, 8)).toBe(0);
  });

  it("would silence a real anomaly if approximations were allowed in", () => {
    const measured = [18, 19, 20, 20, 21, 22, 20, 19, 23, 20, 21, 18];
    // The same reality, spoken: "about twenty". Note the genuine 18/19/21 still
    // present — a majority on the round number is enough to zero the MAD.
    const spoken = [18, 20, 20, 20, 19, 20, 20, 20, 20, 20, 20, 21];

    const real = buildSiteBaseline(SITE, measured.map((m, i) => sample(i + 1, m)));
    const rounded = buildSiteBaseline(SITE, spoken.map((m, i) => sample(i + 1, m)));

    expect(real.phases.setup.madMinutes).toBe(1);
    expect(rounded.phases.setup.madMinutes).toBe(0);

    const verdict = (b: typeof real, min: number) =>
      assessStop({ baseline: b, setupMinutes: min, confirmation: CONFIRMED })
        .phases.find(p => p.phase === "setup")?.verdict;

    // A 26-minute setup is elevated against measurement and invisible against rounding.
    expect(verdict(real, 26)).toBe("elevated");
    expect(verdict(rounded, 26)).toBe("within_baseline");
    expect(verdict(real, 30)).toBe("elevated");
    expect(verdict(rounded, 30)).toBe("within_baseline");
    // It takes 35 for the rounded baseline to say anything at all, and then only "elevated".
    expect(verdict(real, 35)).toBe("extreme");
    expect(verdict(rounded, 35)).toBe("elevated");
  });
});

describe("assessStop", () => {
  const baseline = buildSiteBaseline(SITE, HISTORY);

  it("calls an ordinary stop within baseline", () => {
    const a = assessStop({ baseline, setupMinutes: 21, confirmation: CONFIRMED });
    expect(a.phases.find(p => p.phase === "setup")?.verdict).toBe("within_baseline");
    expect(a.alerts).toHaveLength(0);
  });

  it("flags a long setup and shows the arithmetic", () => {
    const a = assessStop({ baseline, tripStopId: 900, setupMinutes: 95, confirmation: CONFIRMED });
    const setup = a.phases.find(p => p.phase === "setup");
    expect(setup?.verdict).toBe("extreme");
    expect(setup?.math).toContain("robust z");
    expect(a.alerts[0].severity).toBe("extreme");
    expect(a.alerts[0].headline).toContain("site median");
  });

  it("never asserts a cause in an alert", () => {
    const a = assessStop({ baseline, setupMinutes: 95, confirmation: CONFIRMED });
    const text = a.alerts.map(x => x.headline).join(" ").toLowerCase();
    for (const word of ["customer", "driver", "because", "caused", "fault", "delay by"]) {
      expect(text).not.toContain(word);
    }
  });

  it("still raises an alert on an unconfirmed live stop, and says the timing is unconfirmed", () => {
    const a = assessStop({ baseline, setupMinutes: 95, confirmation: allPhases("unconfirmed") });
    expect(a.alerts).toHaveLength(1);
    expect(a.alerts[0].observationConfirmation).toBe("unconfirmed");
    expect(a.alerts[0].headline).toContain("timing unconfirmed");
  });

  it("defaults an omitted confirmation to unknown rather than to confirmed", () => {
    const a = assessStop({ baseline, setupMinutes: 95 });
    expect(a.phases.find(p => p.phase === "setup")?.observationConfirmation).toBe("unknown");
    expect(a.alerts[0].headline).toContain("timing unknown");
  });

  it("leaves a confirmed alert headline free of a confirmation clause", () => {
    const a = assessStop({ baseline, setupMinutes: 95, confirmation: CONFIRMED });
    expect(a.alerts[0].headline).not.toContain("timing");
  });

  it("reports insufficient history rather than calling an unmeasured stop normal", () => {
    const thin = buildSiteBaseline(SITE, HISTORY.slice(0, 3));
    const a = assessStop({ baseline: thin, setupMinutes: 240, confirmation: CONFIRMED });
    const setup = a.phases.find(p => p.phase === "setup");
    expect(setup?.verdict).toBe("insufficient_history");
    expect(setup?.verdict).not.toBe("within_baseline");
    expect(a.alerts).toHaveLength(0);
    expect(a.unmeasuredPhases).toContain("setup");
  });

  it("names the exclusion split when it explains the missing baseline", () => {
    const thin = buildSiteBaseline(SITE, [
      ...HISTORY.slice(0, 2),
      sample(50, 30, allPhases("unconfirmed")),
      sample(51, 30, UNKNOWN_CONFIRMATION),
    ]);
    const a = assessStop({ baseline: thin, setupMinutes: 240 });
    const math = a.phases.find(p => p.phase === "setup")?.math ?? "";
    expect(math).toContain("1 unconfirmed");
    expect(math).toContain("1 without recorded provenance");
  });

  it("distinguishes a missing observation from a zero-length one", () => {
    const missing = assessStop({ baseline, setupMinutes: null, confirmation: CONFIRMED });
    expect(missing.phases.find(p => p.phase === "setup")?.verdict).toBe("no_observation");

    const zero = assessStop({ baseline, setupMinutes: 0, confirmation: CONFIRMED });
    expect(zero.phases.find(p => p.phase === "setup")?.verdict).toBe("within_baseline");
  });

  it("falls back to a multiple of the median when the samples have no spread", () => {
    const flat = buildSiteBaseline(SITE, Array.from({ length: 10 }, (_, i) => sample(i + 1, 20)));
    expect(flat.phases.setup.madMinutes).toBe(0);

    const a = assessStop({ baseline: flat, setupMinutes: 70, confirmation: CONFIRMED });
    const setup = a.phases.find(p => p.phase === "setup");
    expect(setup?.verdict).toBe("extreme");
    expect(setup?.math).toContain("MAD 0");
    expect(setup?.multipleOfMedian).toBe(3.5);
  });
});

/* ------------------------------------------------------------------ */

describe("unmeasuredSiteNotice", () => {
  it("names the shortfall and splits the excluded samples by remedy", () => {
    const b = buildSiteBaseline(SITE, [
      ...HISTORY.slice(0, 2),
      sample(50, 30, allPhases("unconfirmed")),
      sample(51, 30, allPhases("unconfirmed")),
      sample(52, 30, UNKNOWN_CONFIRMATION),
      sample(53, 30, CONFIRMED, { precision: allPrecision("approximate") }),
    ]);
    const notice = unmeasuredSiteNotice(b);
    expect(notice).toContain("facility 41");
    expect(notice).toContain(`${MINIMUM_SAMPLES} needed`);
    expect(notice).toContain("2 awaiting confirmation");
    expect(notice).toContain("1 with no recorded provenance");
    expect(notice).toContain("1 approximate");
  });

  it("omits the exclusion clause when nothing was excluded", () => {
    const b = buildSiteBaseline(SITE, HISTORY.slice(0, 2));
    expect(unmeasuredSiteNotice(b)).not.toContain("excluded");
  });

  it("returns nothing for a measured site", () => {
    expect(unmeasuredSiteNotice(buildSiteBaseline(SITE, HISTORY))).toBeNull();
  });
});
