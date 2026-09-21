/**
 * v22.17 — Communications on the route, tested where the behaviour lives.
 *
 * These assert outcomes, not shapes. "Returns an authorization" is worthless
 * here; whether it says `authorized`, `not_authorized`,
 * `requires_posted_channel` or `unknown` is the entire product.
 */
import { describe, expect, it } from "vitest";
import {
  ADVISORY_POLICY, AUTHORITY_TIERS, authorityRank, communicationBlockers,
  communicationsFingerprintParts, evaluateCondition, inForce, planCommunications,
  evaluateConditionOverGeography, resolveAssignment, transmitAuthorization, windowState,
  type SegmentGeography,
  type CompanyAuthorization, type CoverageObservation, type RadioChannel,
  type RoadRadioAssignment, type UnitRadioCapability,
} from "./_core/commRoute";
import {
  ALL_CHANNEL_SEEDS, BC_LOADING_CHANNELS, BC_RESOURCE_ROAD_CHANNELS,
  CB_GRS_CHANNELS, ISED_B1_WESTERN_CHANNELS,
} from "./_core/radioChannelSeeds";

const at = new Date("2026-09-11T12:00:00Z");
const d1 = (s: string) => new Date(`${s}T00:00:00Z`);
const seed = (key: string) => ALL_CHANNEL_SEEDS.find(c => c.channelKey === key)!;

const channel = (o: Partial<RadioChannel> = {}): RadioChannel => ({
  channelKey: "TEST-1", alias: "Test 1", serviceClass: "land_mobile_b1", systemType: "simplex",
  rxMHz: 154.1, txMHz: 154.1, licenceRequired: true, conditions: [],
  sourceKey: "ised_b1_western", sourceCitation: "ISED B1", verificationStatus: "verified", ...o,
});

const assignment = (o: Partial<RoadRadioAssignment> = {}): RoadRadioAssignment => ({
  assignmentRef: "A-1", segmentId: "SEG-1", channelKey: "TEST-1", authorityTier: "planning_map",
  verificationStatus: "verified", ...o,
});

const capableUnit = (o: Partial<UnitRadioCapability> = {}): UnitRadioCapability => ({
  unitId: 1, vhf: true, uhf: false, cb: true, satellite: false, cellular: true,
  programmingProfileRef: "AB-NORTH-07", programmedChannelKeys: ["TEST-1"], verificationStatus: "verified", ...o,
});

const licensed = (o: Partial<CompanyAuthorization> = {}): CompanyAuthorization => ({
  channelKey: "TEST-1", authorized: true, licenceRef: "L-1", licenceExpiresAt: d1("2027-01-01"),
  verificationStatus: "verified", ...o,
});

/* ------------------------------------------------------------------ */

describe("the road sign outranks the database", () => {
  it("orders the tiers with the posted sign first and an unverified submission last", () => {
    expect(AUTHORITY_TIERS[0]).toBe("posted_sign");
    expect(AUTHORITY_TIERS[AUTHORITY_TIERS.length - 1]).toBe("unverified_submission");
    expect(authorityRank("posted_sign")).toBeLessThan(authorityRank("regulatory_authority"));
    expect(authorityRank("regulatory_authority")).toBeLessThan(authorityRank("planning_map"));
    expect(authorityRank("driver_observation")).toBeLessThan(authorityRank("community_reference"));
  });

  it("chooses a week-old sign over a regulator's dataset published this morning, and says why each lost", () => {
    const r = resolveAssignment([
      assignment({ assignmentRef: "A-MAP", channelKey: "RR-25", authorityTier: "planning_map", observedAt: at }),
      assignment({ assignmentRef: "A-REG", channelKey: "RR-25", authorityTier: "regulatory_authority", observedAt: at }),
      assignment({ assignmentRef: "A-SIGN", channelKey: "RR-30", authorityTier: "posted_sign", observedAt: d1("2026-09-04") }),
    ], at);
    expect(r.chosen!.assignmentRef).toBe("A-SIGN");
    expect(r.chosen!.channelKey).toBe("RR-30");
    expect(r.considered.find(c => c.assignmentRef === "A-REG")!.outcome).toBe("outranked");
    expect(r.considered.find(c => c.assignmentRef === "A-REG")!.reason).toContain("the channel posted on the road");
  });

  it("prefers the fresher record only within one tier — never a weaker tier because it is newer", () => {
    const r = resolveAssignment([
      assignment({ assignmentRef: "A-OLD", channelKey: "RR-01", authorityTier: "operator_instruction", observedAt: d1("2026-01-01") }),
      assignment({ assignmentRef: "A-NEW", channelKey: "RR-02", authorityTier: "operator_instruction", observedAt: d1("2026-08-01") }),
      assignment({ assignmentRef: "A-NEWEST", channelKey: "RR-03", authorityTier: "company_entry", observedAt: at }),
    ], at);
    expect(r.chosen!.assignmentRef).toBe("A-NEW");
  });

  it("adds the standing caveat whenever the governing record is not the sign itself", () => {
    const fromMap = resolveAssignment([assignment({ authorityTier: "planning_map" })], at);
    expect(fromMap.reasons.some(x => x.includes("posted on the road governs"))).toBe(true);
    const fromSign = resolveAssignment([assignment({ authorityTier: "posted_sign" })], at);
    expect(fromSign.reasons.some(x => x.includes("posted on the road governs"))).toBe(false);
  });
});

describe("a temporary channel change expires by arithmetic", () => {
  it("lets a one-week operator change govern inside its window and hands the road back afterwards, keeping both records", () => {
    const normal = assignment({ assignmentRef: "A-NORMAL", channelKey: "RR-01", authorityTier: "operator_instruction" });
    const temporary = assignment({
      assignmentRef: "A-TEMP", channelKey: "RR-20", authorityTier: "operator_instruction",
      effectiveFrom: d1("2026-09-08"), effectiveTo: d1("2026-09-18"), observedAt: d1("2026-09-08"),
    });

    expect(resolveAssignment([normal, temporary], d1("2026-09-05")).chosen!.channelKey).toBe("RR-01");
    expect(resolveAssignment([normal, temporary], d1("2026-09-12")).chosen!.channelKey).toBe("RR-20");
    expect(resolveAssignment([normal, temporary], d1("2026-09-20")).chosen!.channelKey).toBe("RR-01");

    const after = resolveAssignment([normal, temporary], d1("2026-09-20"));
    expect(after.considered.find(c => c.assignmentRef === "A-TEMP")).toMatchObject({ outcome: "not_in_force" });
    expect(after.considered.find(c => c.assignmentRef === "A-TEMP")!.reason).toContain("window has ended");
  });

  it("uses the same window arithmetic a road ban uses — from inclusive, to exclusive", () => {
    const w = { effectiveFrom: d1("2026-09-08"), effectiveTo: d1("2026-09-18") };
    expect(windowState(w, d1("2026-09-07"))).toBe("not_yet_in_force");
    expect(windowState(w, d1("2026-09-08"))).toBe("in_force");
    expect(windowState(w, d1("2026-09-18"))).toBe("expired");
    expect(windowState({}, at)).toBe("always");
    expect(inForce({}, at)).toBe(true);
  });

  it("never lets a superseded assignment govern", () => {
    const r = resolveAssignment([
      assignment({ assignmentRef: "A-OLD", channelKey: "RR-01", authorityTier: "posted_sign", verificationStatus: "superseded" }),
      assignment({ assignmentRef: "A-NEW", channelKey: "RR-07", authorityTier: "planning_map" }),
    ], at);
    expect(r.chosen!.channelKey).toBe("RR-07");
    expect(r.considered.find(c => c.assignmentRef === "A-OLD")!.outcome).toBe("superseded");
  });
});

/* ------------------------------------------------------------------ */

describe("a geographic exclusion is arithmetic, and it is stated", () => {
  it("names the distance south of the line rather than saying 'restricted'", () => {
    const line = { kind: "excluded_south_of_latitude" as const, latitude: 53.5, note: "Alberta exclusion south of 53°30′00″" };
    const red_deer = evaluateCondition(line, [-113.8, 52.27], "AB");
    expect(red_deer.result).toBe("excluded");
    expect(red_deer.reason).toContain("53°30′00″N");
    expect(red_deer.reason).toContain("km south of the line");
    const grande_prairie = evaluateCondition(line, [-118.8, 55.17], "AB");
    expect(grande_prairie.result).toBe("permitted");
  });

  it("measures a radius exclusion in kilometres and says how far away the truck is", () => {
    const bonnyville = { kind: "excluded_within_radius" as const, latitude: 54.2667, longitude: -110.7333, radiusKm: 100, placeName: "Bonnyville" };
    const inside = evaluateCondition(bonnyville, [-110.9, 54.3], "AB");
    expect(inside.result).toBe("excluded");
    expect(inside.reason).toContain("Bonnyville");
    const outside = evaluateCondition(bonnyville, [-113.5, 53.5], "AB");
    expect(outside.result).toBe("permitted");
    expect(outside.reason).toContain("outside the 100 km exclusion");
  });

  it("refuses a province the authorization does not list, and stays unknown when the province is not established", () => {
    const bcOnly = { kind: "provinces_permitted" as const, provinces: ["BC", "YT", "NT", "NU"] };
    expect(evaluateCondition(bcOnly, [-113.5, 53.5], "AB").result).toBe("excluded");
    expect(evaluateCondition(bcOnly, [-123.1, 49.3], "BC").result).toBe("permitted");
    expect(evaluateCondition(bcOnly, [-113.5, 53.5], null).result).toBe("unknown");
  });

  it("is unknown — not permitted — when a geographic condition exists and no position was supplied", () => {
    const line = { kind: "excluded_south_of_latitude" as const, latitude: 53.5 };
    expect(evaluateCondition(line, null, "AB").result).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */

describe("a frequency is not a permission to transmit", () => {
  it("answers UNKNOWN on a seeded channel nobody has verified, however complete everything else is", () => {
    const r = transmitAuthorization({
      channel: channel({ verificationStatus: "unverified" }), channelKey: "TEST-1",
      companyAuthorization: licensed(), unit: capableUnit(), position: [-118.8, 55.17], province: "AB", at,
    });
    expect(r.status).toBe("unknown");
    expect(r.gates.find(g => g.gate === "channel_record")!.result).toBe("unknown");
    expect(r.reasons.join(" ")).toContain("not yet checked against it by a person");
  });

  it("answers UNKNOWN when the channel is known and no company authorization exists at all", () => {
    const r = transmitAuthorization({ channel: channel(), channelKey: "TEST-1", companyAuthorization: null, unit: capableUnit(), province: "AB", at });
    expect(r.status).toBe("unknown");
    expect(r.gates.find(g => g.gate === "company_authorization")!.reason).toContain("a known frequency is not a permission to transmit");
  });

  it("answers NOT AUTHORIZED on an expired licence, a province the licence does not cover, and a unit outside it", () => {
    const expired = transmitAuthorization({ channel: channel(), channelKey: "TEST-1", companyAuthorization: licensed({ licenceExpiresAt: d1("2026-01-01") }), unit: capableUnit(), province: "AB", at });
    expect(expired.status).toBe("not_authorized");
    expect(expired.reasons.join(" ")).toContain("expired 2026-01-01");

    const wrongProvince = transmitAuthorization({ channel: channel(), channelKey: "TEST-1", companyAuthorization: licensed({ provinces: ["BC"] }), unit: capableUnit(), province: "AB", at });
    expect(wrongProvince.status).toBe("not_authorized");

    const otherUnit = transmitAuthorization({ channel: channel(), channelKey: "TEST-1", companyAuthorization: licensed({ approvedUnitIds: [99] }), unit: capableUnit({ unitId: 1 }), province: "AB", at });
    expect(otherUnit.status).toBe("not_authorized");
  });

  it("refuses a channel the radio shop has not programmed, and does not offer to program it", () => {
    const r = transmitAuthorization({
      channel: channel(), channelKey: "TEST-1", companyAuthorization: licensed(),
      unit: capableUnit({ programmedChannelKeys: ["OTHER-9"] }), province: "AB", at,
    });
    expect(r.status).toBe("not_authorized");
    expect(r.reasons.join(" ")).toContain("LeaseOS does not program radios");
  });

  it("is UNKNOWN when the truck's programmed list is simply not recorded, and NOT AUTHORIZED when the radio is absent", () => {
    const unrecorded = transmitAuthorization({ channel: channel(), channelKey: "TEST-1", companyAuthorization: licensed(), unit: capableUnit({ programmedChannelKeys: null }), province: "AB", at });
    expect(unrecorded.status).toBe("unknown");
    const noRadio = transmitAuthorization({ channel: channel(), channelKey: "TEST-1", companyAuthorization: licensed(), unit: capableUnit({ vhf: false }), province: "AB", at });
    expect(noRadio.status).toBe("not_authorized");
    expect(noRadio.reasons.join(" ")).toContain("carries no VHF radio");
  });

  it("authorizes only when every gate says yes", () => {
    const r = transmitAuthorization({ channel: channel(), channelKey: "TEST-1", companyAuthorization: licensed(), unit: capableUnit(), province: "AB", at });
    expect(r.status).toBe("authorized");
    expect(r.gates.every(g => g.result === "yes")).toBe(true);
  });

  it("keeps a public-safety or amateur allocation off a driver's operational list even with a licence on file", () => {
    for (const serviceClass of ["public_safety", "amateur"] as const) {
      const r = transmitAuthorization({ channel: channel({ serviceClass }), channelKey: "TEST-1", companyAuthorization: licensed(), unit: capableUnit(), province: "AB", at });
      expect(r.status).toBe("not_authorized");
      expect(r.gates.find(g => g.gate === "service_class")!.result).toBe("no");
    }
  });

  it("knows nothing about a channel that is not in the registry, and says so rather than guessing", () => {
    const r = transmitAuthorization({ channel: null, channelKey: "WHO-KNOWS", at });
    expect(r.status).toBe("unknown");
    expect(r.reasons[0]).toContain("not a channel LeaseOS holds a record for");
  });

  it("treats a posted-use channel as REQUIRES POSTED CHANNEL until the sign on this road says so", () => {
    const posted = channel({ serviceClass: "bc_resource_road", conditions: [{ kind: "provinces_permitted", provinces: ["BC"] }, { kind: "posted_use_only" }] });
    const notPosted = transmitAuthorization({ channel: posted, channelKey: "TEST-1", companyAuthorization: licensed(), unit: capableUnit(), province: "BC", position: [-123.1, 49.3], at, postedOnThisRoad: false });
    expect(notPosted.status).toBe("requires_posted_channel");
    const onSign = transmitAuthorization({ channel: posted, channelKey: "TEST-1", companyAuthorization: licensed(), unit: capableUnit(), province: "BC", position: [-123.1, 49.3], at, postedOnThisRoad: true });
    expect(onSign.status).toBe("authorized");
  });

  it("lets an exclusion beat everything — a licensed company on an equipped truck is still excluded by geography", () => {
    const excluded = channel({ conditions: [{ kind: "excluded_within_radius", latitude: 51.4254, longitude: -116.1773, radiusKm: 50, placeName: "Lake Louise" }] });
    const r = transmitAuthorization({ channel: excluded, channelKey: "TEST-1", companyAuthorization: licensed(), unit: capableUnit(), province: "AB", position: [-116.2, 51.43], at });
    expect(r.status).toBe("not_authorized");
    expect(r.reasons.join(" ")).toContain("Lake Louise");
  });

  it("needs no licence for CB, and still needs the radio", () => {
    const cb = channel({ serviceClass: "cb_grs", systemType: "cb", licenceRequired: false, rxMHz: 27.185, txMHz: 27.185, channelKey: "CB-19" });
    const ok = transmitAuthorization({ channel: cb, channelKey: "CB-19", companyAuthorization: null, unit: capableUnit({ programmedChannelKeys: ["CB-19"] }), province: "AB", at });
    expect(ok.status).toBe("authorized");
    const noCb = transmitAuthorization({ channel: cb, channelKey: "CB-19", companyAuthorization: null, unit: capableUnit({ cb: false, programmedChannelKeys: ["CB-19"] }), province: "AB", at });
    expect(noCb.status).toBe("not_authorized");
    expect(noCb.reasons.join(" ")).toContain("carries no CB radio");
  });
});

/* ------------------------------------------------------------------ */

const path = [
  { segmentId: "S-1", label: "Forestry Trunk Road", lengthKm: 20 },
  { segmentId: "S-2", label: "Forestry Trunk Road", lengthKm: 15 },
  { segmentId: "S-3", label: "Smoky Main", lengthKm: 25 },
];

describe("the plan along a route", () => {
  const channels = [
    channel({ channelKey: "LAD-1", alias: "LADD 1 — 154.100 MHz" }),
    channel({ channelKey: "RR-07", alias: "BC Resource Road 07", rxMHz: 150.26, txMHz: 150.26 }),
  ];
  const assignments = [
    assignment({ assignmentRef: "A-1", segmentId: "S-1", channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road", callDirectionLoaded: "decreasing_km", callIntervalKm: 5, mustCallKm: [10, 25] }),
    assignment({ assignmentRef: "A-2", segmentId: "S-2", channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road", callDirectionLoaded: "decreasing_km", callIntervalKm: 5, mustCallKm: [10, 25] }),
    assignment({ assignmentRef: "A-3", segmentId: "S-3", channelKey: "RR-07", authorityTier: "posted_sign", roadName: "Smoky Main" }),
  ];

  it("merges consecutive segments on one channel into a zone and marks the change at the kilometre it happens", () => {
    const plan = planCommunications({ path, assignments, channels, companyAuthorizations: [licensed({ channelKey: "LAD-1" }), licensed({ channelKey: "RR-07" })], unit: capableUnit({ programmedChannelKeys: ["LAD-1", "RR-07"] }), province: "AB", at });
    expect(plan.totalKm).toBe(60);
    expect(plan.zones).toHaveLength(2);
    expect(plan.zones[0]).toMatchObject({ fromKm: 0, toKm: 35, channelKey: "LAD-1" });
    expect(plan.zones[0].segmentIds).toEqual(["S-1", "S-2"]);
    expect(plan.zones[1]).toMatchObject({ fromKm: 35, toKm: 60, channelKey: "RR-07" });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ atKm: 35, from: "LAD-1", to: "RR-07" });
    expect(plan.changes[0].note).toContain("verify the posted sign");
  });

  it("carries the operator's own calling convention rather than inventing one", () => {
    const plan = planCommunications({ path, assignments, channels, at });
    expect(plan.zones[0].callDirectionLoaded).toBe("decreasing_km");
    expect(plan.zones[0].callIntervalKm).toBe(5);
    expect(plan.mustCall.map(m => m.atKm)).toEqual([10, 25]);
    expect(plan.zones[1].callDirectionLoaded).toBeNull();
  });

  it("holds a stretch with no assignment as UNKNOWN kilometres, never as 'no radio needed'", () => {
    const plan = planCommunications({ path, assignments: assignments.slice(0, 2), channels, at });
    expect(plan.unknownChannelKm).toBe(25);
    expect(plan.verdict).toBe("unknown");
    const gap = plan.zones.find(z => z.channelKey === null)!;
    expect(gap.unknownReason).toContain("No channel assignment is on record");
    expect(plan.explanation).toContain("Unknown is not coverage");
  });

  it("counts coverage per medium and leaves silence as unknown kilometres", () => {
    const coverage: CoverageObservation[] = [
      { segmentId: "S-1", medium: "cellular", state: "available", sourceKey: "crtc_coverage", authorityTier: "regulatory_authority", verificationStatus: "verified" },
      { segmentId: "S-2", medium: "cellular", state: "unavailable", sourceKey: "field", authorityTier: "driver_observation", verificationStatus: "unverified" },
    ];
    const plan = planCommunications({ path, assignments, channels, coverage, at });
    const cell = plan.coverage.find(c => c.medium === "cellular")!;
    expect(cell).toMatchObject({ availableKm: 20, unavailableKm: 15, unknownKm: 25 });
    const sat = plan.coverage.find(c => c.medium === "satellite")!;
    expect(sat.unknownKm).toBe(60);
    expect(plan.ladder.find(l => l.level === 4)!.state).toBe("unknown");
  });

  it("prefers the stronger authority when two sources disagree about coverage", () => {
    const coverage: CoverageObservation[] = [
      { segmentId: "S-1", medium: "cellular", state: "available", sourceKey: "community", authorityTier: "community_reference", verificationStatus: "unverified" },
      { segmentId: "S-1", medium: "cellular", state: "unavailable", sourceKey: "crtc_coverage", authorityTier: "regulatory_authority", verificationStatus: "verified" },
    ];
    const plan = planCommunications({ path: [path[0]], assignments, channels, coverage, at });
    expect(plan.coverage.find(c => c.medium === "cellular")!.unavailableKm).toBe(20);
  });

  it("separates 'nothing is known' from 'nothing works' — the second is a gap, the first is unknown", () => {
    const dead: CoverageObservation[] = [
      { segmentId: "S-3", medium: "cellular", state: "unavailable", sourceKey: "crtc_coverage", authorityTier: "regulatory_authority", verificationStatus: "verified" },
      { segmentId: "S-3", medium: "satellite", state: "unavailable", sourceKey: "field", authorityTier: "driver_observation", verificationStatus: "unverified" },
    ];
    const withChannel = planCommunications({ path: [path[2]], assignments, channels, coverage: dead, at });
    expect(withChannel.noCommunicationKm).toBe(0);   // a governing road channel is a communication

    const withoutChannel = planCommunications({ path: [path[2]], assignments: [], channels, coverage: dead, at });
    expect(withoutChannel.noCommunicationKm).toBe(25);
    expect(withoutChannel.verdict).toBe("gaps");
  });

  it("reaches `covered` only when every zone is authorized and every medium has an answer", () => {
    const full: CoverageObservation[] = path.flatMap(s => ([
      { segmentId: s.segmentId, medium: "cellular" as const, state: "available" as const, sourceKey: "crtc_coverage", authorityTier: "regulatory_authority" as const, verificationStatus: "verified" as const },
      { segmentId: s.segmentId, medium: "satellite" as const, state: "available" as const, sourceKey: "fleet", authorityTier: "company_entry" as const, verificationStatus: "verified" as const },
      { segmentId: s.segmentId, medium: "radio" as const, state: "available" as const, sourceKey: "fleet", authorityTier: "company_entry" as const, verificationStatus: "verified" as const },
    ]));
    const plan = planCommunications({
      path, assignments, channels, coverage: full,
      companyAuthorizations: [licensed({ channelKey: "LAD-1" }), licensed({ channelKey: "RR-07" })],
      unit: capableUnit({ programmedChannelKeys: ["LAD-1", "RR-07"] }), province: "AB", at,
    });
    expect(plan.verdict).toBe("covered");
    expect(plan.explanation).toContain("Posted road signs govern");
  });
});

/* ------------------------------------------------------------------ */

describe("what dispatch makes of the plan is company policy, not a hard-coded rule", () => {
  const thin = planCommunications({ path, assignments: [], channels: [], at });

  it("advises by default and blocks only where a company has said to", () => {
    const advisory = communicationBlockers(thin, ADVISORY_POLICY);
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toMatchObject({ code: "communication_plan_unknown", severity: "unknown", subject: "route" });

    const strict = communicationBlockers(thin, { unknownPlanBlocks: true, requireTransmitAuthorization: true, toleratedNoCommunicationKm: 0 });
    expect(strict.find(b => b.code === "communication_plan_unknown")!.severity).toBe("blocking");
    expect(strict.some(b => b.code === "radio_authorization_unknown")).toBe(true);
  });

  it("makes a channel the company is refused on a blocker no role may override", () => {
    const refused = planCommunications({
      path: [path[0]],
      assignments: [assignment({ segmentId: "S-1", channelKey: "LAD-2", authorityTier: "operator_instruction" })],
      channels: [channel({ channelKey: "LAD-2", conditions: [{ kind: "provinces_permitted", provinces: ["BC", "YT", "NT", "NU"] }] })],
      companyAuthorizations: [licensed({ channelKey: "LAD-2" })], unit: capableUnit({ programmedChannelKeys: ["LAD-2"] }),
      province: "AB", at,
    });
    expect(refused.zones[0].transmit).toBe("not_authorized");
    const blockers = communicationBlockers(refused, { unknownPlanBlocks: false, requireTransmitAuthorization: true, toleratedNoCommunicationKm: 100 });
    const b = blockers.find(x => x.code === "radio_not_authorized")!;
    expect(b.severity).toBe("blocking");
    expect(b.overridable).toBe(false);
  });

  it("names the tolerated distance when a real gap exceeds it", () => {
    const dead: CoverageObservation[] = [
      { segmentId: "S-1", medium: "cellular", state: "unavailable", sourceKey: "crtc_coverage", authorityTier: "regulatory_authority", verificationStatus: "verified" },
      { segmentId: "S-1", medium: "satellite", state: "unavailable", sourceKey: "fleet", authorityTier: "company_entry", verificationStatus: "verified" },
    ];
    const plan = planCommunications({ path: [path[0]], assignments: [], channels: [], coverage: dead, at });
    const blockers = communicationBlockers(plan, { unknownPlanBlocks: false, requireTransmitAuthorization: false, toleratedNoCommunicationKm: 5 });
    expect(blockers.find(b => b.code === "communication_gap_exceeds_policy")!.label).toContain("tolerates 5 km");
  });
});

describe("the plan is a route dependency", () => {
  it("moves its fingerprint when the governing channel changes, and not when nothing does", () => {
    const channels = [channel({ channelKey: "RR-01" }), channel({ channelKey: "RR-20" })];
    const before = planCommunications({ path: [path[0]], assignments: [assignment({ segmentId: "S-1", channelKey: "RR-01", authorityTier: "operator_instruction" })], channels, at });
    const same = planCommunications({ path: [path[0]], assignments: [assignment({ segmentId: "S-1", channelKey: "RR-01", authorityTier: "operator_instruction" })], channels, at });
    const changed = planCommunications({ path: [path[0]], assignments: [assignment({ segmentId: "S-1", channelKey: "RR-20", authorityTier: "operator_instruction" })], channels, at });
    expect(JSON.stringify(communicationsFingerprintParts(before))).toBe(JSON.stringify(communicationsFingerprintParts(same)));
    expect(JSON.stringify(communicationsFingerprintParts(before))).not.toBe(JSON.stringify(communicationsFingerprintParts(changed)));
  });
});

/* ------------------------------------------------------------------ */

describe("the seeded banks are candidates, not regulatory truth", () => {
  it("seeds every row unverified, so no seed alone can authorize a transmission", () => {
    expect(ALL_CHANNEL_SEEDS.every(c => c.verificationStatus === "unverified")).toBe(true);
    const r = transmitAuthorization({ channel: seed("LAD-1"), channelKey: "LAD-1", companyAuthorization: licensed({ channelKey: "LAD-1" }), unit: capableUnit({ programmedChannelKeys: ["LAD-1"] }), province: "AB", position: [-118.8, 55.17], at });
    expect(r.status).toBe("unknown");
  });

  it("holds the bank sizes the publications define", () => {
    expect(BC_RESOURCE_ROAD_CHANNELS).toHaveLength(35);
    expect(BC_LOADING_CHANNELS).toHaveLength(14);
    expect(CB_GRS_CHANNELS).toHaveLength(40);
    expect(ISED_B1_WESTERN_CHANNELS).toHaveLength(10);
    expect(ALL_CHANNEL_SEEDS).toHaveLength(99);
    expect(new Set(ALL_CHANNEL_SEEDS.map(c => c.channelKey)).size).toBe(99);
  });

  it("keeps CB 23, 24 and 25 out of ascending order, because that is the allocation and 'fixing' it would be the defect", () => {
    const mhz = (n: number) => CB_GRS_CHANNELS.find(c => c.channelKey === `CB-${String(n).padStart(2, "0")}`)!.rxMHz;
    expect(mhz(23)).toBe(27.255);
    expect(mhz(24)).toBe(27.235);
    expect(mhz(25)).toBe(27.245);
    expect(mhz(23)).toBeGreaterThan(mhz(24)!);
  });

  it("does not treat CB 19 as a mandatory trucking channel — it is licence-exempt and described, not required", () => {
    const ch19 = CB_GRS_CHANNELS.find(c => c.channelKey === "CB-19")!;
    expect(ch19.licenceRequired).toBe(false);
    expect(ch19.alias).toContain("road information");
  });

  it("carries the Alberta exclusions that make a static LADD menu unsafe", () => {
    const lad1 = seed("LAD-1");
    expect(lad1.conditions.some(c => c.kind === "excluded_south_of_latitude" && c.latitude === 53.5)).toBe(true);
    expect(lad1.conditions.some(c => c.kind === "excluded_within_radius" && c.placeName === "Bonnyville")).toBe(true);

    // LAD-2 and LAD-3 are not listed for Alberta, so the bank refuses them there
    // even on a truck whose radio happens to have them programmed.
    for (const key of ["LAD-2", "LAD-3"]) {
      const provinces = seed(key).conditions.find(c => c.kind === "provinces_permitted");
      expect(provinces && provinces.kind === "provinces_permitted" && provinces.provinces.includes("AB")).toBe(false);
      expect(evaluateCondition(provinces!, [-113.5, 53.5], "AB").result).toBe("excluded");
    }
  });

  it("puts every BC resource-road and loading channel behind a posted-use condition", () => {
    for (const c of [...BC_RESOURCE_ROAD_CHANNELS, ...BC_LOADING_CHANNELS]) {
      expect(c.conditions.some(x => x.kind === "posted_use_only")).toBe(true);
      expect(c.licenceRequired).toBe(true);
    }
    expect(BC_RESOURCE_ROAD_CHANNELS[0]).toMatchObject({ channelKey: "RR-01", rxMHz: 150.08 });
    expect(BC_RESOURCE_ROAD_CHANNELS[34]).toMatchObject({ channelKey: "RR-35", rxMHz: 151.67 });
    expect(BC_LOADING_CHANNELS[0]).toMatchObject({ channelKey: "LD-01", rxMHz: 151.7 });
  });

  it("seeds no public-safety or amateur allocation at all", () => {
    expect(ALL_CHANNEL_SEEDS.some(c => c.serviceClass === "public_safety" || c.serviceClass === "amateur")).toBe(false);
  });

  it("gives every seed a citation to check it against", () => {
    expect(ALL_CHANNEL_SEEDS.every(c => c.sourceCitation.length > 10 && c.sourceKey.startsWith("ised_"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("regression — a dated window governs over a standing record at equal authority", () => {
  it("lets an operator's one-week change govern even when both records were observed in the same second", () => {
    // The defect: ordering on freshness alone let the standing assignment win
    // whenever the two shared a timestamp — which is the normal case when both
    // are entered from one road-use document. The driver would have been
    // briefed on the old channel for the entire week the change was in force.
    const sameInstant = d1("2026-09-08");
    const standing = assignment({ assignmentRef: "A-STANDING", channelKey: "RR-01", authorityTier: "operator_instruction", observedAt: sameInstant });
    const temporary = assignment({
      assignmentRef: "A-TEMP", channelKey: "RR-20", authorityTier: "operator_instruction",
      effectiveFrom: d1("2026-09-08"), effectiveTo: d1("2026-09-18"), observedAt: sameInstant,
    });

    const inside = resolveAssignment([standing, temporary], d1("2026-09-12"));
    expect(inside.chosen!.channelKey).toBe("RR-20");
    expect(inside.considered.find(c => c.assignmentRef === "A-STANDING")!.reason).toContain("dated assignment in force for this date");

    // Argument order must not decide it either.
    expect(resolveAssignment([temporary, standing], d1("2026-09-12")).chosen!.channelKey).toBe("RR-20");
    // And once the window closes the standing record is the answer again.
    expect(resolveAssignment([standing, temporary], d1("2026-09-25")).chosen!.channelKey).toBe("RR-01");
  });

  it("still lets a stronger authority beat a dated window — specificity breaks ties, it does not outrank the sign", () => {
    const temporary = assignment({ assignmentRef: "A-TEMP", channelKey: "RR-20", authorityTier: "planning_map", effectiveFrom: d1("2026-09-08"), effectiveTo: d1("2026-09-18") });
    const sign = assignment({ assignmentRef: "A-SIGN", channelKey: "RR-30", authorityTier: "posted_sign" });
    expect(resolveAssignment([temporary, sign], d1("2026-09-12")).chosen!.channelKey).toBe("RR-30");
  });
});

describe("regression — the kilometres on a dispatcher's screen add up", () => {
  it("keeps each medium's coverage summing to the route length on awkward segment lengths", () => {
    // Rounding every addition drifted: 13.7 km of route reported as 7.4 + 6.5 = 13.9.
    const awkward = [
      { segmentId: "S-1", label: "a", lengthKm: 1.0481883557672 },
      { segmentId: "S-2", label: "b", lengthKm: 2.3333333333333 },
      { segmentId: "S-3", label: "c", lengthKm: 4.4571428571428 },
      { segmentId: "S-4", label: "d", lengthKm: 5.9013972384501 },
    ];
    const coverage: CoverageObservation[] = [
      { segmentId: "S-1", medium: "cellular", state: "available", sourceKey: "crtc_coverage", authorityTier: "regulatory_authority", verificationStatus: "verified" },
      { segmentId: "S-2", medium: "cellular", state: "unavailable", sourceKey: "field", authorityTier: "driver_observation", verificationStatus: "unverified" },
      { segmentId: "S-3", medium: "cellular", state: "intermittent", sourceKey: "field", authorityTier: "driver_observation", verificationStatus: "unverified" },
    ];
    const plan = planCommunications({ path: awkward, assignments: [], channels: [], coverage, at });
    const cell = plan.coverage.find(c => c.medium === "cellular")!;
    const summed = Math.round((cell.availableKm + cell.intermittentKm + cell.unavailableKm + cell.unknownKm) * 10) / 10;
    expect(summed).toBe(plan.totalKm);
    expect(plan.coverage.find(c => c.medium === "satellite")!.unknownKm).toBe(plan.totalKm);
  });

  it("states unknown kilometres to one decimal in the explanation, not to fifteen", () => {
    const plan = planCommunications({ path: [{ segmentId: "S-1", label: "a", lengthKm: 13.740481883557672 }], assignments: [], channels: [], at });
    expect(plan.explanation).toContain("13.7 km has no channel on record");
    expect(plan.explanation).not.toContain("13.740481883557672");
  });
});

/* ------------------------------------------------------------------ */

describe("regression — a zone is one answer, not one channel", () => {
  const lad1 = channel({
    channelKey: "LAD-1", alias: "LADD 1 — 154.100 MHz",
    conditions: [{ kind: "provinces_permitted", provinces: ["AB", "BC", "YT", "NT", "NU"] }, { kind: "excluded_south_of_latitude", latitude: 53.5 }],
  });
  const licensedHere = licensed({ channelKey: "LAD-1" });
  const unit = capableUnit({ programmedChannelKeys: ["LAD-1"] });
  // Same channel, same operator instruction, one either side of 53°30′.
  const path = [
    { segmentId: "N-1", label: "Forestry Trunk Road", lengthKm: 20 },
    { segmentId: "S-1", label: "Forestry Trunk Road", lengthKm: 20 },
  ];
  const assignments = [
    assignment({ assignmentRef: "A-N", segmentId: "N-1", channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road" }),
    assignment({ assignmentRef: "A-S", segmentId: "S-1", channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road" }),
  ];
  // Established geography, because that is what production supplies now — a
  // caller-asserted province is only probable and would make both sides unknown,
  // which would hide the very split this pins.
  const geoN: SegmentGeography = { segmentId: "N-1", province: "AB", jurisdictionConfidence: "confirmed", path: [[-118.8, 55.15], [-118.8, 55.19]] };
  const geoS: SegmentGeography = { segmentId: "S-1", province: "AB", jurisdictionConfidence: "confirmed", path: [[-113.8, 52.25], [-113.8, 52.29]] };
  const geographyBySegment = { "N-1": geoN, "S-1": geoS };

  it("splits the zone where authorization ends, instead of reporting the first segment's answer for the whole stretch", () => {
    // The defect: both segments matched on channelKey and authorityTier, so they
    // merged, and the merged zone kept the northern segment's `authorized`.
    // A driver would have read the entire 40 km as authorized when authorization
    // ended at the halfway point.
    const plan = planCommunications({
      path, assignments, channels: [lad1], companyAuthorizations: [licensedHere],
      unit, province: "AB", geographyBySegment, at,
    });
    expect(plan.zones).toHaveLength(2);
    expect(plan.zones[0]).toMatchObject({ fromKm: 0, toKm: 20, channelKey: "LAD-1", transmit: "authorized" });
    expect(plan.zones[1]).toMatchObject({ fromKm: 20, toKm: 40, channelKey: "LAD-1", transmit: "not_authorized" });
    expect(plan.zones[1].transmitReasons.join(" ")).toContain("lies entirely south of it");
    expect(plan.verdict).not.toBe("covered");
  });

  it("still merges where the answer genuinely is the same for both segments", () => {
    const bothNorth = { "N-1": geoN, "S-1": { ...geoN, segmentId: "S-1" } };
    const plan = planCommunications({ path, assignments, channels: [lad1], companyAuthorizations: [licensedHere], unit, province: "AB", geographyBySegment: bothNorth, at });
    expect(plan.zones).toHaveLength(1);
    expect(plan.zones[0]).toMatchObject({ fromKm: 0, toKm: 40, transmit: "authorized" });
  });

  it("does not swallow a change of calling convention on the same channel", () => {
    // A new must-call interval or loaded direction is a change the driver has to
    // make; merging across it would hide the instruction entirely.
    const differentCalling = [
      assignment({ assignmentRef: "A-1", segmentId: "N-1", channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road", callIntervalKm: 5, callDirectionLoaded: "decreasing_km" }),
      assignment({ assignmentRef: "A-2", segmentId: "S-1", channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road", callIntervalKm: 2, callDirectionLoaded: "increasing_km" }),
    ];
    const bothNorth = { "N-1": geoN, "S-1": { ...geoN, segmentId: "S-1" } };
    const plan = planCommunications({ path, assignments: differentCalling, channels: [lad1], companyAuthorizations: [licensedHere], unit, province: "AB", geographyBySegment: bothNorth, at });
    expect(plan.zones).toHaveLength(2);
    expect(plan.zones.map(z => z.callIntervalKm)).toEqual([5, 2]);
    expect(plan.zones.map(z => z.callDirectionLoaded)).toEqual(["decreasing_km", "increasing_km"]);
  });
});

/* ------------------------------------------------------------------ */

describe("geography is decided over the road, not over one point on it", () => {
  const line = { kind: "excluded_south_of_latitude" as const, latitude: 53.5 };
  const bonnyville = { kind: "excluded_within_radius" as const, latitude: 54.2667, longitude: -110.7333, radiusKm: 100, placeName: "Bonnyville" };
  const geo = (path: [number, number][], province: string | null = "AB"): SegmentGeography => ({ segmentId: "S-1", province, path });

  it("refuses to authorize a single segment that crosses the boundary, however the endpoints are ordered", () => {
    // 53.60N → 53.40N. Take the start and it looks authorized; take the end and
    // it looks excluded; take the midpoint and you have classified a road by a
    // coin toss. The answer is that no single answer covers it.
    for (const path of [[[-113.8, 53.6], [-113.8, 53.4]], [[-113.8, 53.4], [-113.8, 53.6]]] as [number, number][][]) {
      const f = evaluateConditionOverGeography(line, geo(path));
      expect(f.result).toBe("crosses");
      expect(f.reason).toContain("authorization changes along it");
    }
  });

  it("still answers plainly when the road lies wholly on one side", () => {
    expect(evaluateConditionOverGeography(line, geo([[-118.8, 55.1], [-118.7, 55.3]])).result).toBe("permitted");
    expect(evaluateConditionOverGeography(line, geo([[-113.8, 52.2], [-113.7, 52.4]])).result).toBe("excluded");
  });

  it("catches a road that passes through an exclusion circle both of whose endpoints are outside it", () => {
    // Due west to due east across Bonnyville at its own latitude: both ends more
    // than 100 km away, the middle straight through the centre. A point sample
    // at either endpoint would have called this permitted.
    const through = geo([[-113.2, 54.2667], [-108.3, 54.2667]]);
    expect(evaluateCondition(bonnyville, through.path[0], "AB").result).toBe("permitted");
    expect(evaluateCondition(bonnyville, through.path[1], "AB").result).toBe("permitted");
    const f = evaluateConditionOverGeography(bonnyville, through);
    expect(f.result).toBe("crosses");
    expect(f.reason).toContain("closest approach");
  });

  it("calls a road wholly inside an exclusion excluded, and one that never approaches it permitted", () => {
    expect(evaluateConditionOverGeography(bonnyville, geo([[-110.75, 54.26], [-110.70, 54.28]])).result).toBe("excluded");
    expect(evaluateConditionOverGeography(bonnyville, geo([[-118.8, 55.1], [-118.7, 55.3]])).result).toBe("permitted");
  });

  it("answers UNKNOWN when the geometry is missing, and never substitutes a guess", () => {
    const f = evaluateConditionOverGeography(line, geo([]));
    expect(f.result).toBe("unknown");
    expect(f.reason).toContain("no point was guessed in its place");
    expect(evaluateConditionOverGeography(line, null).result).toBe("unknown");
  });

  it("withholds province-limited authorization when jurisdiction is only probable source metadata", () => {
    const abOnly = { kind: "provinces_permitted" as const, provinces: ["AB"] };
    const probable: SegmentGeography = {
      segmentId: "S-PROB", province: "AB", jurisdictionConfidence: "probable", jurisdictionCandidates: ["AB"],
      jurisdictionEvidenceRefs: ["externalDataSources:ats_road_allowance:CA-AB"], path: [[-119.9, 54.0], [-119.8, 54.1]],
    };
    const f = evaluateConditionOverGeography(abOnly, probable);
    expect(f.result).toBe("unknown");
    expect(f.reason).toContain("not coordinate-level boundary evidence");
  });

  it("also withholds a province-scoped company licence when road jurisdiction is only probable", () => {
    const probable: SegmentGeography = { segmentId: "S-PROB-LIC", province: "AB", jurisdictionConfidence: "probable", jurisdictionCandidates: ["AB"], path: [[-119.9, 54.0], [-119.8, 54.1]] };
    const r = transmitAuthorization({
      channel: channel({ conditions: [] }), channelKey: "TEST-1",
      companyAuthorization: licensed({ provinces: ["AB"] }), unit: capableUnit(), geography: probable, at,
    });
    expect(r.status).toBe("unknown");
    expect(r.gates.find(g => g.gate === "company_authorization")?.reason).toContain("probable rather than confirmed");
  });

  it("represents a provincial boundary crossing as ambiguous and never authorizes it", () => {
    const abOnly = { kind: "provinces_permitted" as const, provinces: ["AB"] };
    const crossing: SegmentGeography = {
      segmentId: "AB-BC", province: null, jurisdictionConfidence: "ambiguous", jurisdictionCandidates: ["AB", "BC"],
      jurisdictionEvidenceRefs: ["boundary:AB", "boundary:BC"], crossing: { fromProvince: "AB", toProvince: "BC", evidenceRefs: ["boundary:AB", "boundary:BC"] },
      path: [[-120.1, 54.0], [-119.9, 54.0]],
    };
    const f = evaluateConditionOverGeography(abOnly, crossing);
    expect(f.result).toBe("crosses");
    expect(f.reason).toContain("AB / BC");
    const r = transmitAuthorization({ channel: channel({ conditions: [abOnly] }), channelKey: "TEST-1", companyAuthorization: licensed(), unit: capableUnit(), geography: crossing, at });
    expect(r.status).toBe("unknown");
  });

  it("takes jurisdiction from the road, and a caller's assertion cannot override it", () => {
    const bcOnly = { kind: "provinces_permitted" as const, provinces: ["BC", "YT", "NT", "NU"] };
    // The caller says BC. The road says Alberta. The road wins.
    const onAlbertaRoad = geo([[-113.8, 53.6], [-113.7, 53.7]], "AB");
    expect(evaluateConditionOverGeography(bcOnly, onAlbertaRoad).result).toBe("excluded");
    const r = transmitAuthorization({
      channel: channel({ conditions: [bcOnly] }), channelKey: "TEST-1",
      companyAuthorization: licensed(), unit: capableUnit(),
      province: "BC", geography: onAlbertaRoad, at,
    });
    expect(r.status).toBe("not_authorized");
    // And a segment whose jurisdiction the road data does not establish is unknown.
    expect(evaluateConditionOverGeography(bcOnly, geo([[-113.8, 53.6]], null)).result).toBe("unknown");
  });

  it("never reports a boundary-crossing segment as authorized through the full gate", () => {
    const lad1 = channel({ channelKey: "LAD-1", conditions: [{ kind: "provinces_permitted", provinces: ["AB"] }, line] });
    const crossing = geo([[-113.8, 53.6], [-113.8, 53.4]]);
    const r = transmitAuthorization({ channel: lad1, channelKey: "LAD-1", companyAuthorization: licensed({ channelKey: "LAD-1" }), unit: capableUnit({ programmedChannelKeys: ["LAD-1"] }), geography: crossing, at });
    expect(r.status).toBe("unknown");
    expect(r.gates.find(g => g.gate === "geography")!.reason).toContain("crosses");
  });

  it("plans a route from per-segment geography, splitting where the answer changes", () => {
    const lad1 = channel({ channelKey: "LAD-1", conditions: [{ kind: "provinces_permitted", provinces: ["AB"] }, line] });
    const plan = planCommunications({
      path: [{ segmentId: "N", label: "Trunk", lengthKm: 10 }, { segmentId: "S", label: "Trunk", lengthKm: 10 }],
      assignments: [
        assignment({ assignmentRef: "A-N", segmentId: "N", channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Trunk" }),
        assignment({ assignmentRef: "A-S", segmentId: "S", channelKey: "LAD-1", authorityTier: "operator_instruction", roadName: "Trunk" }),
      ],
      channels: [lad1], companyAuthorizations: [licensed({ channelKey: "LAD-1" })],
      unit: capableUnit({ programmedChannelKeys: ["LAD-1"] }),
      geographyBySegment: {
        N: { segmentId: "N", province: "AB", path: [[-118.8, 55.1], [-118.7, 55.3]] },
        S: { segmentId: "S", province: "AB", path: [[-113.8, 52.2], [-113.7, 52.4]] },
      },
      at,
    });
    expect(plan.zones).toHaveLength(2);
    expect(plan.zones[0].transmit).toBe("authorized");
    expect(plan.zones[1].transmit).toBe("not_authorized");
  });
});

describe("a device's claim about where it is, is evidence and not proof", () => {
  const bcOnly = { kind: "provinces_permitted" as const, provinces: ["BC", "YT", "NT", "NU"] };
  const abOnly = { kind: "provinces_permitted" as const, provinces: ["AB"] };

  it("keeps the primitive's own meaning when the province is established", () => {
    expect(evaluateCondition(bcOnly, [-123.1, 49.3], "BC").result).toBe("permitted");
    expect(evaluateCondition(bcOnly, [-123.1, 49.3], "BC", "confirmed").result).toBe("permitted");
  });

  it("will not turn a merely asserted province into a permission", () => {
    const f = evaluateCondition(bcOnly, [-123.1, 49.3], "BC", "probable");
    expect(f.result).toBe("unknown");
    expect(f.reason).toContain("evidence, not proof");
  });

  it("still excludes on a mismatch however the province was established — fail-safe both ways", () => {
    for (const c of ["confirmed", "probable", "ambiguous", "unknown"] as const) {
      expect(evaluateCondition(bcOnly, [-113.5, 53.5], "AB", c).result).toBe("excluded");
    }
  });

  it("refuses to clear a province-limited licence from a province the device reported itself", async () => {
    // The transmitCheck path: GPS and province both come off the tablet. A unit
    // 5 km inside BC reporting "AB" must not clear an AB-only licence.
    const r = transmitAuthorization({
      channel: channel({ conditions: [abOnly] }), channelKey: "TEST-1",
      companyAuthorization: licensed({ provinces: ["AB"] }),
      unit: capableUnit(), position: [-118.8, 55.17], province: "AB", at,
    });
    expect(r.status).toBe("unknown");
    expect(r.gates.find(g => g.gate === "company_authorization")!.result).toBe("unknown");
    expect(r.gates.find(g => g.gate === "company_authorization")!.reason).toContain("probable rather than confirmed");
  });

  it("still clears a licence with no province limit, because nothing there depends on jurisdiction", async () => {
    const r = transmitAuthorization({
      channel: channel(), channelKey: "TEST-1", companyAuthorization: licensed(),
      unit: capableUnit(), position: [-118.8, 55.17], province: "AB", at,
    });
    expect(r.status).toBe("authorized");
  });
});
