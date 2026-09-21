/**
 * S10.1 — no acknowledgement, no personal-phone monitoring. Which is not the same as no work.
 *
 * The owner decision of 2026-09-19 settled what `monitoringNotice.ts` deliberately left open. Every
 * case below is a driver who has done nothing wrong: one has not been shown a notice, one was shown
 * it and has not answered, one answered and later changed their mind.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_BLOCKER_REASON, locationCapabilityFor, mayActivatePhoneLocation,
  type LocationSource,
} from "./phoneLocationGate";
import type { Coverage, CoverageState } from "./monitoringNotice";

const coverage = (state: CoverageState): Coverage =>
  ({ purpose: "vehicle_location", state, covered: state === "acknowledged", noticeId: state === "not_notified" ? null : 7 } as Coverage);

const phone = (state: CoverageState, hasActiveTrip = true) =>
  mayActivatePhoneLocation({ coverage: coverage(state), hasActiveTrip });

describe("a phone streams only under an acknowledged notice and an active trip", () => {
  it("activates when both hold", () => {
    const v = phone("acknowledged");
    expect(v.activate).toBe(true);
  });

  it.each(["issued_not_acknowledged", "not_notified", "superseded_not_replaced"] as const)(
    "refuses when coverage is %s", (state) => {
      const v = phone(state);
      expect(v.activate).toBe(false);
      if (v.activate) throw new Error("unreachable");
      expect(v.code).toBe("NO_ACKNOWLEDGED_NOTICE");
      expect(v.because).toMatch(/until the person has been told what is collected and has said so/);
    });

  it("names a withdrawal as a withdrawal, not as a lapse", () => {
    // A person changing their mind and a person never answering are different acts, and a system
    // that reports both as "missing" will chase one of them for an acknowledgement they revoked.
    const v = phone("withdrawn");
    expect(v.activate).toBe(false);
    if (v.activate) throw new Error("unreachable");
    expect(v.code).toBe("PURPOSE_WITHDRAWN");
    expect(v.because).toMatch(/not a lapse to be chased/);
  });

  it("stops at trip close, even with an acknowledged notice", () => {
    // Collection belongs to the trip. Outside one there is nothing for it to be evidence of.
    const v = phone("acknowledged", false);
    expect(v.activate).toBe(false);
    if (v.activate) throw new Error("unreachable");
    expect(v.code).toBe("NO_ACTIVE_TRIP");
  });
});

describe("the job's need for a stream is a separate question from the driver's decision", () => {
  const declined = phone("issued_not_acknowledged");

  it("lets work continue when the job does not require live location", () => {
    // The decision's core: no acknowledgement blocks monitoring, not employment.
    const v = locationCapabilityFor({ jobRequiresLiveLocation: false, availableSources: [], phone: declined });
    expect(v.status).toBe("not_required");
  });

  it("prefers a company source over the personal phone even when the phone is available", () => {
    /*
     * Not because the phone is worse data — it is often better. Because the truck belongs to the
     * employer and the handset does not, and a system that reaches for the personal device first
     * will keep reaching for it.
     */
    const v = locationCapabilityFor({
      jobRequiresLiveLocation: true,
      availableSources: ["truck_telematics", "personal_phone"] as LocationSource[],
      phone: phone("acknowledged"),
    });
    expect(v.status).toBe("ready");
    if (v.status !== "ready") throw new Error("unreachable");
    expect(v.source).toBe("truck_telematics");
  });

  it("uses the phone when it is the only authorized source and the notice is acknowledged", () => {
    const v = locationCapabilityFor({ jobRequiresLiveLocation: true, availableSources: ["personal_phone"], phone: phone("acknowledged") });
    expect(v.status).toBe("ready");
    if (v.status !== "ready") throw new Error("unreachable");
    expect(v.source).toBe("personal_phone");
  });

  it("reports a missing capability — never the driver's choice — when the job needs a stream and none exists", () => {
    const v = locationCapabilityFor({ jobRequiresLiveLocation: true, availableSources: [], phone: declined });
    expect(v.status).toBe("unavailable");
    if (v.status !== "unavailable") throw new Error("unreachable");
    expect(v.blockers).toEqual(["live_location_stream_unavailable"]);
    // The reason is about the assignment, not about a person.
    expect(v.detail).toMatch(/no authorized source is supplying one/);
    for (const leak of ["driver", "acknowledg", "consent", "declin", "refus", "monitoring"]) {
      expect(v.detail.toLowerCase(), `a capability blocker must not mention ${leak}`).not.toContain(leak);
    }
  });
});

describe("nothing reaching dispatch names the driver's decision", () => {
  it("keeps the blocker text free of consent language", () => {
    /*
     * The guard, because this is the rule that erodes quietly. A blocker reading "driver declined
     * monitoring" turns a privacy choice into a performance record, and once dispatch can see who
     * declined, the decline becomes the thing being managed rather than the missing device.
     */
    for (const leak of ["driver", "acknowledg", "consent", "declin", "refus", "monitoring", "phone"]) {
      expect(CAPABILITY_BLOCKER_REASON.toLowerCase(), leak).not.toContain(leak);
    }
    expect(CAPABILITY_BLOCKER_REASON).toMatch(/Fit a company device, use truck telematics, or assign a unit/);
  });

  it("does not let the module itself leak a person into an unavailable verdict", () => {
    const src = readFileSync("server/_core/phoneLocationGate.ts", "utf8");
    const unavailable = src.slice(src.indexOf('status: "unavailable"'), src.indexOf('status: "unavailable"') + 500);
    expect(unavailable.toLowerCase()).not.toMatch(/driver'?s? (declin|refus|consent|acknowledg)/);
  });
});

describe("S10.2 — the customer projection has no location fields to leak", () => {
  const src = readFileSync("server/_core/customerProjections.ts", "utf8");

  it("carries no coordinate or driver-identity field, nulled or otherwise", () => {
    /*
     * The owner decision says the projection "must not contain raw latitude/longitude, driver
     * identity, **hidden/null location fields**". The nulled form is the one worth guarding: a
     * `latitude: null` proves the concept exists in the shape, and the next person to need a
     * coordinate fills it in rather than asking whether they may.
     *
     * True today. This keeps it true.
     */
    const offenders: string[] = [];
    for (const m of src.matchAll(/^\s*(latitude|longitude|lat|lng|coords?|driverName|driverId|operatorName)\s*[?:]/gm)) {
      offenders.push(m[1]!);
    }
    expect(offenders, "a coordinate or driver-identity field in the customer projection").toEqual([]);
  });

  it("still establishes operational state from business events rather than movement", () => {
    // The existing rule this sits beside: a truck's speed is not a job state.
    expect(src).toMatch(/never from a vehicle's speed/);
  });
});
