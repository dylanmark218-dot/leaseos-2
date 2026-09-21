/**
 * The reasoning that lives in code. Every case here is one the prompt forbids
 * the model from deciding.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeLandLocation,
  normalizeTicketNumber,
  normalizeTime,
  normalizeVolume,
} from "./validate/normalizers";

describe("volume", () => {
  it("keeps the spoken unit rather than converting it", () => {
    const r = normalizeVolume({
      amount: 16,
      quote: "dumped sixteen cubic metres",
      formUnit: "L",
      capacityLitres: 16000,
    });
    // Not 16000 L. A conversion here would put a factor between the driver's
    // words and the record, and a wrong factor is silent.
    expect(r.verdict).toBe("REVIEW");
    expect(r.reasonCode).toBe("volume_unit_mismatch");
    expect(r.value).toEqual({ amount: 16, unit: "m3" });
  });

  it("marks a number with no unit for a question", () => {
    const r = normalizeVolume({ amount: 16, quote: "dumped sixteen", formUnit: "L", capacityLitres: 16000 });
    expect(r.verdict).toBe("REVIEW");
    expect(r.reasonCode).toBe("volume_unit_missing");
    expect(r.value).toEqual({ amount: 16, unit: null });
  });

  it("blocks more volume than the tank holds", () => {
    const r = normalizeVolume({
      amount: 22000,
      quote: "twenty two thousand litres",
      formUnit: "L",
      capacityLitres: 16000,
    });
    expect(r.verdict).toBe("BLOCKED");
    expect(r.reasonCode).toBe("volume_over_capacity");
  });

  it("reports NOT_EVALUATED when no capacity is recorded, never a pass", () => {
    // `units` has no capacity column in this schema — capacityLitres belongs to
    // bulkFuelTanks — so this is the common case, and it must not read as a
    // ceiling nobody exceeded.
    const r = normalizeVolume({
      amount: 22000,
      quote: "twenty two thousand litres",
      formUnit: "L",
      capacityLitres: null,
    });
    expect(r.verdict).toBe("NOT_EVALUATED");
    expect(r.reasonCode).toBe("capacity_unknown");
  });

  it("passes a volume in the form's own unit and under capacity", () => {
    const r = normalizeVolume({
      amount: 12000,
      quote: "twelve thousand litres on the meter",
      formUnit: "L",
      capacityLitres: 16000,
    });
    expect(r.verdict).toBe("PASS");
  });

  it("blocks a volume that is not a quantity", () => {
    expect(normalizeVolume({ amount: 0, quote: "nothing", formUnit: "L", capacityLitres: 16000 }).verdict)
      .toBe("BLOCKED");
    expect(normalizeVolume({ amount: -5, quote: "minus five", formUnit: "L", capacityLitres: 16000 }).verdict)
      .toBe("BLOCKED");
  });

  it("does not evaluate an absent volume", () => {
    const r = normalizeVolume({ amount: null, quote: null, formUnit: "L", capacityLitres: 16000 });
    expect(r.verdict).toBe("NOT_EVALUATED");
  });
});

describe("times", () => {
  it("accepts a stated 24-hour time", () => {
    const r = normalizeTime({ raw: "14:20", quote: "arrived at 14:20", geofenceArrivalLocal: null });
    expect(r.verdict).toBe("PASS");
    expect(r.value).toEqual({ local: "14:20", basis: "stated" });
  });

  it("never guesses an AM/PM the driver did not say", () => {
    const r = normalizeTime({ raw: "seven", quote: "got there around seven", geofenceArrivalLocal: null });
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.reasonCode).toBe("time_meridiem_unknown");
    expect(r.value).toBeNull();
  });

  it("proposes the geofence arrival instead, tagged so a person can see where it came from", () => {
    const r = normalizeTime({
      raw: "seven",
      quote: "got there around seven",
      geofenceArrivalLocal: "07:04",
    });
    expect(r.verdict).toBe("REVIEW");
    expect(r.value).toEqual({ local: "07:04", basis: "gps_detected" });
  });

  it("reads a stated meridiem", () => {
    expect(normalizeTime({ raw: "7 pm", quote: "seven pm", geofenceArrivalLocal: null }).value)
      .toEqual({ local: "19:00", basis: "stated" });
    expect(normalizeTime({ raw: "7:15 a.m.", quote: "quarter after seven a.m.", geofenceArrivalLocal: null }).value)
      .toEqual({ local: "07:15", basis: "stated" });
  });

  it("treats an hour past twelve as unambiguous on its own", () => {
    expect(normalizeTime({ raw: "19", quote: "nineteen hundred", geofenceArrivalLocal: null }).verdict)
      .toBe("PASS");
  });

  it("does not evaluate an absent time", () => {
    expect(normalizeTime({ raw: null, quote: null, geofenceArrivalLocal: null }).verdict)
      .toBe("NOT_EVALUATED");
  });
});

describe("legal land descriptions", () => {
  it("resolves an LSD through the survey module already in the repository", () => {
    const r = normalizeLandLocation("04-12-045-05 W5");
    // Always REVIEW: the result is the theoretical centre of a survey cell,
    // roughly ±2 km, and never an entrance.
    expect(r.verdict).toBe("REVIEW");
    expect(r.value?.precision).toBe("approximate_site");
    expect(typeof r.value?.latitude).toBe("number");
  });

  it("resolves a quarter section", () => {
    expect(normalizeLandLocation("SW-12-043-07 W5M").verdict).toBe("REVIEW");
  });

  it("reports UNKNOWN for a description this module does not read", () => {
    // NTS descriptions are not converted; saying so beats a coordinate.
    const r = normalizeLandLocation("D-096-K/094-A-12");
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.value).toBeNull();
  });

  it("does not evaluate an absent location", () => {
    expect(normalizeLandLocation(null).verdict).toBe("NOT_EVALUATED");
  });
});

describe("ticket numbers", () => {
  const open = ["CW-4471", "CW-4480"];

  it("passes a number that is on the open list", () => {
    expect(normalizeTicketNumber({ raw: "CW-4471", openTickets: open }).verdict).toBe("PASS");
  });

  it("asks rather than completing a prefix, even when only one candidate matches", () => {
    const r = normalizeTicketNumber({ raw: "4471", openTickets: open });
    expect(r.verdict).toBe("REVIEW");
    expect(r.reasonCode).toBe("ticket_prefix_missing");
  });

  it("flags a number that is not open at all", () => {
    const r = normalizeTicketNumber({ raw: "CW-9999", openTickets: open });
    expect(r.verdict).toBe("REVIEW");
    expect(r.reasonCode).toBe("ticket_not_open");
  });

  it("reports NOT_EVALUATED when no open tickets were supplied", () => {
    // An empty check list must not mean every check passed.
    const r = normalizeTicketNumber({ raw: "CW-4471", openTickets: [] });
    expect(r.verdict).toBe("NOT_EVALUATED");
    expect(r.reasonCode).toBe("open_tickets_unknown");
  });
});
