/**
 * The transport-date contract, pinned to instants a person can derive from the published
 * civil-time rules — never computed by the operation under test.
 *
 * A publisher's date text without an offset is wall-clock time in the publisher's zone
 * (`fromDateText(text, zone)`), and the zone's rules come from the tz database the runtime
 * ships. That makes the runtime's tz data part of the contract: on 2026-10-01 the same commit
 * answered 2026-11-08 in British Columbia as 08:00Z on Node 22.23.2 (tz 2025c) and 07:00Z on
 * 22.23.3 (tz 2026c). The second is right. British Columbia adopted permanent UTC−7 in 2026 and
 * does not fall back on 2026-11-01; tz 2026c records it. So:
 *
 *   - .nvmrc pins the exact Node build, and scripts/check-version-truth.mjs holds CI to it;
 *   - this file refuses tz data older than 2026c, so a stale runtime fails here, by name,
 *     instead of as a mysterious hour in a provider test;
 *   - every expected instant below is written out by hand from the rule, with the rule beside
 *     it. If a future tz release changes a rule, the expectation changes with a citation —
 *     the test is never rewritten to agree with whatever the runtime says.
 *
 * Rules used (tz 2026c):
 *   America/Vancouver  UTC−8 (PST) until 2026-03-08 02:00 local → UTC−7 (PDT), then permanent UTC−7.
 *   America/Toronto    UTC−5 (EST) / UTC−4 (EDT); forward 2026-03-08 02:00, back 2026-11-01 02:00.
 */
import { describe, expect, it } from "vitest";
import { fromDateText } from "./_core/transport/fields";

const VAN = "America/Vancouver";
const TOR = "America/Toronto";
const at = (s: string) => new Date(s);

/** tz identifiers order lexically within a year (2026a < 2026b < 2026c) and by year across years. */
const tzAtLeast = (have: string, floor: string) => have.length === floor.length ? have >= floor : have.length > floor.length;

describe("the runtime's tz data is new enough for the rules this contract states", () => {
  it("carries tz 2026c or later (British Columbia's permanent UTC−7)", () => {
    const tz = process.versions.tz ?? "";
    expect(tz, `process.versions.tz is ${JSON.stringify(tz)}; the contract needs 2026c or later — use the Node build .nvmrc pins`).toSatisfy((v: string) => tzAtLeast(v, "2026c"));
  });
});

describe("winter standard time", () => {
  it("Toronto 2026-01-15 00:00 is 05:00Z (EST, UTC−5)", () => {
    expect(fromDateText("2026-01-15", TOR)).toEqual(at("2026-01-15T05:00:00Z"));
  });
  it("Vancouver 2026-01-15 00:00 is 08:00Z (PST, UTC−8 — before BC's last spring-forward)", () => {
    expect(fromDateText("2026-01-15T00:00", VAN)).toEqual(at("2026-01-15T08:00:00Z"));
  });
});

describe("summer daylight time", () => {
  it("Toronto 2026-07-15 12:00 is 16:00Z (EDT, UTC−4)", () => {
    expect(fromDateText("2026-07-15T12:00", TOR)).toEqual(at("2026-07-15T16:00:00Z"));
  });
  it("Vancouver 2026-07-15 12:00 is 19:00Z (PDT, UTC−7)", () => {
    expect(fromDateText("2026-07-15 12:00:00", VAN)).toEqual(at("2026-07-15T19:00:00Z"));
  });
});

describe("the spring transition, 2026-03-08 02:00 local → 03:00", () => {
  it("Toronto 01:30 is still EST (06:30Z); 03:30 is EDT (07:30Z)", () => {
    expect(fromDateText("2026-03-08T01:30", TOR)).toEqual(at("2026-03-08T06:30:00Z"));
    expect(fromDateText("2026-03-08T03:30", TOR)).toEqual(at("2026-03-08T07:30:00Z"));
  });
  it("Vancouver 01:30 is still PST (09:30Z); 03:30 is PDT (10:30Z)", () => {
    expect(fromDateText("2026-03-08T01:30", VAN)).toEqual(at("2026-03-08T09:30:00Z"));
    expect(fromDateText("2026-03-08T03:30", VAN)).toEqual(at("2026-03-08T10:30:00Z"));
  });
});

describe("the fall transition, 2026-11-01 — Toronto falls back, British Columbia does not", () => {
  it("Toronto 00:30 is EDT (04:30Z); 03:00 is EST (08:00Z)", () => {
    expect(fromDateText("2026-11-01T00:30", TOR)).toEqual(at("2026-11-01T04:30:00Z"));
    expect(fromDateText("2026-11-01T03:00", TOR)).toEqual(at("2026-11-01T08:00:00Z"));
  });
  it("Vancouver 00:30 is PDT (07:30Z) and 03:00 is still PDT (10:00Z): no fall-back in BC", () => {
    expect(fromDateText("2026-11-01T00:30", VAN)).toEqual(at("2026-11-01T07:30:00Z"));
    expect(fromDateText("2026-11-01T03:00", VAN)).toEqual(at("2026-11-01T10:00:00Z"));
  });
  it("Vancouver 2027-01-15 00:00 is 07:00Z: permanent UTC−7 holds through the following winter", () => {
    expect(fromDateText("2027-01-15", VAN)).toEqual(at("2027-01-15T07:00:00Z"));
  });
});

describe("a bare YYYY-MM-DD is midnight in the publisher's zone", () => {
  it("2026-11-08 in British Columbia is 07:00Z — the instant that differed between tz 2025c and 2026c", () => {
    expect(fromDateText("2026-11-08", VAN)).toEqual(at("2026-11-08T07:00:00Z"));
  });
  it("2026-11-08 in Toronto is 05:00Z (EST, after the 2026-11-01 fall-back)", () => {
    expect(fromDateText("2026-11-08", TOR)).toEqual(at("2026-11-08T05:00:00Z"));
  });
  it("accepts the Québec YYYY/MM/DD hh:mm:ss shape in Toronto time", () => {
    expect(fromDateText("2026/11/08 09:15:00", TOR)).toEqual(at("2026-11-08T14:15:00Z"));
  });
});

describe("an explicit offset stays explicit, whatever zone is named", () => {
  it("−08:00 is −08:00 even for a zone that is UTC−7 on that date", () => {
    expect(fromDateText("2026-11-08T00:00:00-08:00", VAN)).toEqual(at("2026-11-08T08:00:00Z"));
  });
  it("Z is UTC even for a zone five hours away", () => {
    expect(fromDateText("2026-11-08T00:00:00Z", TOR)).toEqual(at("2026-11-08T00:00:00Z"));
  });
  it("a compact +0100 offset is read as an offset, not as wall-clock time", () => {
    expect(fromDateText("2026-11-08T01:00:00+0100", VAN)).toEqual(at("2026-11-08T00:00:00Z"));
  });
});

describe("what is not a date", () => {
  it("returns null for empty, non-string and unparseable text rather than guessing", () => {
    expect(fromDateText("", VAN)).toBeNull();
    expect(fromDateText(null, VAN)).toBeNull();
    expect(fromDateText("next Tuesday", VAN)).toBeNull();
  });
});
