import { describe, expect, it } from "vitest";
import {
  detectTransitions,
  evaluateZoneMembership,
  haversineMetres,
} from "./geofence";

const ZONE = { id: 14, latitude: 51.05, longitude: -114.07, radiusMetres: 75 };

describe("haversineMetres", () => {
  it("returns 0 for identical points", () => {
    expect(haversineMetres(51.05, -114.07, 51.05, -114.07)).toBe(0);
  });

  it("returns a sane distance for a small known offset (~1.11km per 0.01deg lat)", () => {
    const distance = haversineMetres(51.05, -114.07, 51.06, -114.07);
    expect(distance).toBeGreaterThan(1000);
    expect(distance).toBeLessThan(1200);
  });
});

describe("evaluateZoneMembership", () => {
  it("is high confidence when tight GPS accuracy sits well inside the zone", () => {
    const result = evaluateZoneMembership(
      { latitude: 51.05, longitude: -114.07, accuracyMetres: 5 },
      ZONE
    );
    expect(result.inside).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("downgrades confidence when accuracy is poor relative to the boundary margin", () => {
    // ~60m from centre of a 75m zone -> only a 15m margin to the boundary,
    // but accuracy is 40m: worse than the margin itself.
    const result = evaluateZoneMembership(
      { latitude: 51.0505, longitude: -114.07, accuracyMetres: 40 },
      ZONE
    );
    expect(result.confidence).not.toBe("high");
  });

  it("treats a missing accuracy value (e.g. dead-reckoned point) as low confidence, never as exact", () => {
    const result = evaluateZoneMembership(
      { latitude: 51.0503, longitude: -114.07 },
      ZONE
    );
    expect(result.confidence).toBe("low");
  });

  it("is outside when well beyond the radius", () => {
    const result = evaluateZoneMembership(
      { latitude: 51.2, longitude: -114.07, accuracyMetres: 5 },
      ZONE
    );
    expect(result.inside).toBe(false);
  });
});

describe("detectTransitions", () => {
  it("emits an enter event when a zone goes from outside to inside", () => {
    const events = detectTransitions(
      [{ zoneId: 14, inside: false }],
      [{ zoneId: 14, distanceMetres: 10, inside: true, confidence: "high" }]
    );
    expect(events).toEqual([
      {
        zoneId: 14,
        eventType: "enter",
        distanceMetres: 10,
        confidence: "high",
      },
    ]);
  });

  it("emits an exit event when a zone goes from inside to outside", () => {
    const events = detectTransitions(
      [{ zoneId: 14, inside: true }],
      [{ zoneId: 14, distanceMetres: 120, inside: false, confidence: "medium" }]
    );
    expect(events).toEqual([
      {
        zoneId: 14,
        eventType: "exit",
        distanceMetres: 120,
        confidence: "medium",
      },
    ]);
  });

  it("emits nothing when state is unchanged", () => {
    const events = detectTransitions(
      [{ zoneId: 14, inside: true }],
      [{ zoneId: 14, distanceMetres: 20, inside: true, confidence: "high" }]
    );
    expect(events).toEqual([]);
  });

  it("handles multiple zones independently in one breadcrumb", () => {
    const events = detectTransitions(
      [
        { zoneId: 14, inside: false },
        { zoneId: 15, inside: true },
      ],
      [
        { zoneId: 14, distanceMetres: 10, inside: true, confidence: "high" },
        {
          zoneId: 15,
          distanceMetres: 200,
          inside: false,
          confidence: "medium",
        },
      ]
    );
    expect(events).toHaveLength(2);
    expect(events.find(e => e.zoneId === 14)?.eventType).toBe("enter");
    expect(events.find(e => e.zoneId === 15)?.eventType).toBe("exit");
  });
});

describe("where the fix came from caps how far it can be trusted", () => {
  // Deliberately generous geometry: well inside the zone, a metre of claimed accuracy. On the
  // arithmetic alone every one of these is `high`, which is the point — the cap is the only thing
  // separating a satellite fix from someone typing where they think they are.
  const wellInside = { latitude: 53.5461, longitude: -113.4938, accuracyMetres: 1 };
  const zone = { id: 7, latitude: 53.5461, longitude: -113.4938, radiusMetres: 200 };

  it("leaves a satellite fix at high", () => {
    expect(evaluateZoneMembership(wellInside, zone, "gps").confidence).toBe("high");
  });

  it("caps dead reckoning at medium — inference from the last fix, not an observation", () => {
    expect(evaluateZoneMembership(wellInside, zone, "dead_reckoning").confidence).toBe("medium");
  });

  it("caps a manual position at low, however precise it claims to be", () => {
    // A driver typing "I'm at the lease" can be recorded with one metre of accuracy. Nothing stops
    // that, and without the cap it would propose an arrival that looks measured.
    expect(evaluateZoneMembership(wellInside, zone, "manual").confidence).toBe("low");
  });

  it("only ever lowers: a poor fix is not promoted by being a satellite one", () => {
    const edge = { latitude: 53.5461, longitude: -113.4920, accuracyMetres: 500 };
    const plain = evaluateZoneMembership(edge, zone).confidence;
    expect(evaluateZoneMembership(edge, zone, "gps").confidence).toBe(plain);
    expect(plain).toBe("low");
  });

  it("is unchanged when no source is given, so existing callers keep their behaviour", () => {
    expect(evaluateZoneMembership(wellInside, zone).confidence).toBe("high");
  });
});
