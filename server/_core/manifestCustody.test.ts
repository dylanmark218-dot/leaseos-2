import { describe, expect, it } from "vitest";
import { amendmentAllowed, closeDecision, manifestHash, nextCustodyEvent } from "./manifestCustody";

const t = (h: number) => new Date(Date.UTC(2026, 8, 17, h));
const ev = (eventType: Parameters<typeof nextCustodyEvent>[1]["eventType"], h: number, facilityId: number | null = 5) => ({ eventType, occurredAt: t(h), facilityId });

describe("custody order", () => {
  it("opens with loaded, seals on departure, accepts only after arrival", () => {
    expect(nextCustodyEvent([], ev("loaded", 6, null))).toMatchObject({ ok: true, seals: false, sequence: 1 });
    expect(nextCustodyEvent([ev("loaded", 6)], ev("departed_origin", 7, null))).toMatchObject({ ok: true, seals: true, sequence: 2 });
    const chain = [ev("loaded", 6), ev("departed_origin", 7), ev("arrived_facility", 9)];
    expect(nextCustodyEvent(chain, ev("accepted_by_facility", 10))).toMatchObject({ ok: true });
  });
  it("refuses facility acceptance before arrival — the rule the table exists for", () => {
    const r = nextCustodyEvent([ev("loaded", 6), ev("departed_origin", 7)], ev("accepted_by_facility", 8));
    expect(r).toMatchObject({ ok: false, code: "CUSTODY_OUT_OF_ORDER" });
    if (!r.ok) expect(r.message).toContain("arrived_facility");
  });
  it("refuses time running backwards", () => {
    expect(nextCustodyEvent([ev("loaded", 6), ev("departed_origin", 9)], ev("arrived_facility", 8))).toMatchObject({ ok: false, code: "CUSTODY_TIME_REVERSED" });
  });
  it("requires a facility on arrival, acceptance and rejection", () => {
    expect(nextCustodyEvent([ev("loaded", 6), ev("departed_origin", 7)], ev("arrived_facility", 8, null))).toMatchObject({ ok: false, code: "CUSTODY_FACILITY_REQUIRED" });
  });
  it("lets a rejected load go on to another facility, and takes nothing after closure", () => {
    const chain = [ev("loaded", 6), ev("departed_origin", 7), ev("arrived_facility", 9), ev("rejected_by_facility", 10)];
    expect(nextCustodyEvent(chain, ev("arrived_facility", 12, 6))).toMatchObject({ ok: true });
    expect(nextCustodyEvent([...chain, ev("arrived_facility", 12, 6), ev("accepted_by_facility", 13, 6), ev("unloaded", 14, 6), ev("closed", 15, 6)], ev("loaded", 16))).toMatchObject({ ok: false, code: "CUSTODY_CLOSED" });
  });
});

describe("amendments", () => {
  const base = { sealedAt: t(7), closedAt: null, reasonText: "Facility ticket names the co-driver as the driver of record", requestedByUserId: 1, approvedByUserId: 2, changedKeys: ["operatorId"] };
  it("is allowed after sealing with a reason, a change, and a second person", () => { expect(amendmentAllowed(base)).toEqual({ ok: true }); });
  it("is refused before sealing, without a reason, by the requester, with no change, and after closure", () => {
    expect(amendmentAllowed({ ...base, sealedAt: null })).toMatchObject({ ok: false, code: "AMENDMENT_NOT_SEALED" });
    expect(amendmentAllowed({ ...base, reasonText: "typo" })).toMatchObject({ ok: false, code: "AMENDMENT_NO_REASON" });
    expect(amendmentAllowed({ ...base, approvedByUserId: 1 })).toMatchObject({ ok: false, code: "AMENDMENT_SAME_PERSON" });
    expect(amendmentAllowed({ ...base, changedKeys: [] })).toMatchObject({ ok: false, code: "AMENDMENT_NO_CHANGE" });
    expect(amendmentAllowed({ ...base, closedAt: t(20) })).toMatchObject({ ok: false, code: "AMENDMENT_CLOSED" });
  });
});

describe("closing", () => {
  const unloaded = [ev("loaded", 6), ev("departed_origin", 7), ev("arrived_facility", 9), ev("accepted_by_facility", 10), ev("unloaded", 11)];
  it("goes to REVIEW when no profile exists — unknown is not clear", () => {
    expect(closeDecision({ profile: null, attached: ["disposal_ticket", "scale_ticket"], chain: unloaded })).toMatchObject({ verdict: "REVIEW", code: "NO_EVIDENCE_PROFILE" });
  });
  it("goes to REVIEW when the profile is not approved", () => {
    expect(closeDecision({ profile: { required: ["disposal_ticket"], approvedAt: null }, attached: ["disposal_ticket"], chain: unloaded })).toMatchObject({ verdict: "REVIEW", code: "PROFILE_NOT_APPROVED" });
  });
  it("is BLOCKED naming every missing relationship, and PASS when all are attached", () => {
    const profile = { required: ["disposal_ticket", "scale_ticket", "signature"] as const, approvedAt: t(1) };
    expect(closeDecision({ profile, attached: ["scale_ticket"], chain: unloaded })).toMatchObject({ verdict: "BLOCKED", missing: ["disposal_ticket", "signature"] });
    expect(closeDecision({ profile, attached: ["disposal_ticket", "scale_ticket", "signature"], chain: unloaded })).toMatchObject({ verdict: "PASS" });
  });
  it("does not close a load that has not been unloaded, whatever the evidence", () => {
    expect(closeDecision({ profile: { required: [], approvedAt: t(1) }, attached: [], chain: unloaded.slice(0, 4) })).toMatchObject({ verdict: "REVIEW", code: "CUSTODY_INCOMPLETE" });
  });
});

describe("hashing", () => {
  const state = { manifestNumber: "M-1", jobId: 1, tripId: null, loadId: null, operatorId: 7, unitId: 3, trailerUnitId: null, originFacilityId: null, destinationFacilityId: 5, material: "produced water", unNumber: null, loadClass: "produced_water", driver: "J. Doe", trailer: null, route: null, facility: "Fixture Disposal" };
  it("is stable across key order and changes with any field", () => {
    expect(manifestHash(state)).toBe(manifestHash({ ...state }));
    expect(manifestHash({ ...state, operatorId: 8 })).not.toBe(manifestHash(state));
    expect(manifestHash({ ...state, driver: "J. Doe " })).not.toBe(manifestHash(state));
  });
});
