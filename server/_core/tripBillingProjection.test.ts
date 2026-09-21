import { describe, expect, it } from "vitest";
import { calculateChargeLines } from "./billing";
import {
  projectTripChargeLines,
  resolveRate,
  type RateLine,
  type TripBillingInput,
} from "./tripBillingProjection";

const COMPLETED = new Date("2026-03-10T18:00:00Z");

const RATES: RateLine[] = [
  {
    serviceCode: "KM",
    description: "Loaded kilometres",
    unit: "km",
    rateCents: 310,
    minimumCents: null,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
  },
  {
    serviceCode: "HR",
    description: "Billable hours",
    unit: "hour",
    rateCents: 19500,
    minimumCents: null,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
  },
  {
    serviceCode: "DISP",
    description: "Disposal volume",
    unit: "m3",
    rateCents: 4200,
    minimumCents: null,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
  },
];

const BASE: TripBillingInput = {
  tripId: 7,
  tripNumber: "T-2026-0007",
  completedAt: COMPLETED,
  distance: {
    odometerStartKm: 412_100,
    odometerEndKm: 412_248,
    distanceKm: 151.4,
    source: "odometer",
    confirmedByUserId: 12,
  },
  stops: [
    { tripStopId: 1, stopType: "load", billableMinutes: 75, billingClassification: "billable", confirmed: true, ticketNumber: "L-1" },
    { tripStopId: 2, stopType: "unload", billableMinutes: 45, billingClassification: "billable", confirmed: true, ticketNumber: "U-1" },
  ],
  disposalTickets: [{ ticketNumber: "D-5512", quantity: 14.5, quantityUnit: "m3", verified: true }],
  rateCard: { rateCardId: 3, lines: RATES },
  serviceCodes: { distance: "KM", billableTime: "HR", disposal: "DISP" },
};

const codes = (i: TripBillingInput) => projectTripChargeLines(i).omissions.map(o => o.code);

describe("resolveRate", () => {
  it("picks the newest line in force", () => {
    const later: RateLine = { ...RATES[0], rateCents: 330, effectiveFrom: new Date("2026-02-01T00:00:00Z") };
    const r = resolveRate([RATES[0], later], "KM", COMPLETED);
    expect(r.outcome).toBe("resolved");
    expect(r.outcome === "resolved" && r.line.rateCents).toBe(330);
  });

  it("ignores a line that had not taken effect yet", () => {
    const future: RateLine = { ...RATES[0], effectiveFrom: new Date("2027-01-01T00:00:00Z") };
    expect(resolveRate([future], "KM", COMPLETED).outcome).toBe("none");
  });

  it("refuses to break a tie between two lines with the same effective date", () => {
    const twin: RateLine = { ...RATES[0], rateCents: 999 };
    expect(resolveRate([RATES[0], twin], "KM", COMPLETED).outcome).toBe("conflict");
  });
});

describe("projectTripChargeLines", () => {
  it("projects distance, time and disposal from a clean trip", () => {
    const p = projectTripChargeLines(BASE);
    expect(p.omissions).toHaveLength(0);
    expect(p.blocked).toBe(false);
    expect(p.sources).toHaveLength(3);

    const km = p.sources.find(s => s.unit === "km");
    expect(km?.quantity).toBe(148);          // 412248 − 412100, odometer-derived
    expect(km?.verified).toBe(true);

    const hours = p.sources.find(s => s.unit === "hour");
    expect(hours?.quantity).toBe(2);          // 120 confirmed minutes
  });

  it("hands its output straight to calculateChargeLines", () => {
    const { lines, subtotalCents } = calculateChargeLines(projectTripChargeLines(BASE).sources);
    expect(lines).toHaveLength(3);
    expect(subtotalCents).toBe(148 * 310 + 2 * 19500 + Math.round(14.5 * 4200));
    expect(lines[0].math).toContain("×");
  });

  it("projects nothing from a trip that has not completed", () => {
    const p = projectTripChargeLines({ ...BASE, completedAt: null });
    expect(p.blocked).toBe(true);
    expect(p.sources).toHaveLength(0);
    expect(p.omissions[0].code).toBe("trip_not_complete");
  });

  it("prefers the odometer over a GPS distance", () => {
    const p = projectTripChargeLines({
      ...BASE,
      distance: { ...BASE.distance!, distanceKm: 151.4, source: "gps" },
    });
    expect(p.sources.find(s => s.unit === "km")?.quantity).toBe(148);
  });

  it("marks a GPS-only distance unverified and says what would fix it", () => {
    const p = projectTripChargeLines({
      ...BASE,
      distance: { odometerStartKm: null, odometerEndKm: null, distanceKm: 151.4, source: "gps", confirmedByUserId: 12 },
    });
    const km = p.sources.find(s => s.unit === "km");
    expect(km?.verified).toBe(false);
    const omission = p.omissions.find(o => o.code === "distance_unconfirmed");
    expect(omission?.needs).toContain("odometer");

    // The existing pipeline drops it rather than billing it.
    expect(calculateChargeLines(p.sources).excluded).toHaveLength(1);
  });

  it("reports a backwards odometer pair instead of taking its absolute value", () => {
    const p = projectTripChargeLines({
      ...BASE,
      distance: { ...BASE.distance!, odometerStartKm: 412_248, odometerEndKm: 412_100 },
    });
    expect(codes({ ...BASE, distance: { ...BASE.distance!, odometerStartKm: 412_248, odometerEndKm: 412_100 } }))
      .toContain("odometer_implausible");
    expect(p.sources.find(s => s.unit === "km")).toBeUndefined();
  });

  it("never invents a rate when none is in force", () => {
    const p = projectTripChargeLines({ ...BASE, rateCard: { rateCardId: 3, lines: [RATES[1], RATES[2]] } });
    expect(p.sources.find(s => s.unit === "km")).toBeUndefined();
    const omission = p.omissions.find(o => o.code === "no_effective_rate");
    expect(omission?.needs).toContain("KM");
  });

  it("names the missing rate card rather than billing at zero", () => {
    const p = projectTripChargeLines({ ...BASE, rateCard: null });
    expect(p.sources).toHaveLength(0);
    expect(p.blocked).toBe(true);
    expect(p.omissions.every(o => o.code === "no_rate_card")).toBe(true);
  });

  it("excludes review_required time and says what to decide", () => {
    const p = projectTripChargeLines({
      ...BASE,
      stops: [{ ...BASE.stops[0], billingClassification: "review_required" }, BASE.stops[1]],
    });
    expect(p.sources.find(s => s.unit === "hour")?.quantity).toBe(0.75);  // only the 45-min stop
    expect(p.omissions.find(o => o.code === "time_needs_review")?.needs).toContain("contract terms");
  });

  it("excludes unconfirmed stop time from the billable total", () => {
    const p = projectTripChargeLines({
      ...BASE,
      stops: [{ ...BASE.stops[0], confirmed: false }, BASE.stops[1]],
    });
    expect(p.sources.find(s => s.unit === "hour")?.quantity).toBe(0.75);
    expect(codes({ ...BASE, stops: [{ ...BASE.stops[0], confirmed: false }, BASE.stops[1]] }))
      .toContain("time_unconfirmed");
  });

  it("carries an unverified disposal ticket forward but does not bill it", () => {
    const input = { ...BASE, disposalTickets: [{ ...BASE.disposalTickets[0], verified: false }] };
    const p = projectTripChargeLines(input);
    const line = p.sources.find(s => s.derivedFrom.includes("D-5512"));
    expect(line?.verified).toBe(false);
    expect(calculateChargeLines(p.sources).excluded.map(e => e.derivedFrom)).toContain(line?.derivedFrom);
    expect(p.omissions.find(o => o.code === "ticket_unverified")?.needs).toContain("facility");
  });

  it("names a ticket with no quantity instead of assuming one", () => {
    const input = { ...BASE, disposalTickets: [{ ticketNumber: "D-9", quantity: null, quantityUnit: null, verified: true }] };
    expect(projectTripChargeLines(input).omissions.map(o => o.code)).toContain("ticket_quantity_missing");
  });

  it("gives every omission an actionable next step", () => {
    const p = projectTripChargeLines({ ...BASE, rateCard: null, distance: null });
    expect(p.omissions.length).toBeGreaterThan(0);
    for (const o of p.omissions) {
      expect(o.needs.length).toBeGreaterThan(10);
      expect(o.reason).not.toBe("incomplete");
    }
  });
});
