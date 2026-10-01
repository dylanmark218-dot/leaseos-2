/**
 * v22.20 — Hours of service as versioned rules.
 *
 * What these assert is refusal: that the selector will not guess a schedule,
 * that an unverified figure determines nothing, and that "hours remaining" is
 * never one number.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  computeClocks, determine, inForce, selectProfile, tripFeasibility, LIMIT_KEYS,
  type DutyEntry, type HosRuleProfile, type OperatingContext,
} from "./_core/hos";
import { ALL_HOS_PROFILE_SEEDS } from "./_core/hosRuleSeeds";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

const at = new Date("2026-09-11T18:00:00Z");
const t = (iso: string) => new Date(iso);
const seed = (k: string) => ALL_HOS_PROFILE_SEEDS.find(p => p.profileKey === k)!;
const verified = (p: HosRuleProfile): HosRuleProfile => ({ ...p, verificationStatus: "verified", limits: p.limits.map(l => ({ ...l, verificationStatus: "verified" })) });

const ctx = (o: Partial<OperatingContext> = {}): OperatingContext =>
  ({ carrierAuthority: "federal", jurisdiction: "AB", latitude: 53.5, at, ...o });

describe("the selector refuses to guess", () => {
  it("answers UNKNOWN and names the rung when authority, jurisdiction or position is not established", () => {
    for (const [patch, phrase] of [
      [{ carrierAuthority: null }, "operating authority"],
      [{ jurisdiction: null }, "jurisdiction of operation"],
      [{ latitude: null }, "north of 60"],
    ] as const) {
      const r = selectProfile(ctx(patch), ALL_HOS_PROFILE_SEEDS);
      expect(r.outcome).toBe("unknown");
      expect(r.outcome === "unknown" && r.missing.join(" ")).toContain(phrase);
    }
  });

  it("does not fall through to the federal schedule because it is the most common", () => {
    // A provincial carrier in Alberta is not a federal carrier standing in Alberta.
    const provincial = selectProfile(ctx({ carrierAuthority: "provincial", registeredWeightKg: 14_000 }), ALL_HOS_PROFILE_SEEDS);
    expect(provincial.outcome === "selected" && provincial.profile.profileKey).toBe("AB_PROVINCIAL");
    const federal = selectProfile(ctx({ carrierAuthority: "federal" }), ALL_HOS_PROFILE_SEEDS);
    expect(federal.outcome === "selected" && federal.profile.profileKey).toBe("CA_FEDERAL_SOUTH60");
  });

  it("will not satisfy a weight threshold with an unknown weight", () => {
    const r = selectProfile(ctx({ carrierAuthority: "provincial", registeredWeightKg: null }), ALL_HOS_PROFILE_SEEDS);
    expect(r.outcome).toBe("unknown");
    expect(r.outcome === "unknown" && r.missing.join(" ")).toContain("registered weight");
    const under = selectProfile(ctx({ carrierAuthority: "provincial", registeredWeightKg: 8_000 }), ALL_HOS_PROFILE_SEEDS);
    expect(under.outcome).toBe("unknown");
  });

  // 0093A. This test previously asserted that the daily driving figure does not
  // change at the parallel, and it passed because the northern seed reused the
  // southern value. The assumption, not the code, was the defect: the southern
  // figure sits in the division opened by s. 11 and the northern division opens
  // at s. 37 with its own driving section, which s. 76 corroborates by naming
  // the two permitted periods separately.
  //
  // The assertion now tracks the corrected **candidate**. Neither figure is
  // verified, and this test says nothing about what the law is — only about
  // what the seed carries and that the two divisions are not the same.
  it("crosses the sixtieth parallel into a different schedule, and the day changes with it", () => {
    const south = selectProfile(ctx({ latitude: 59.9 }), ALL_HOS_PROFILE_SEEDS);
    const north = selectProfile(ctx({ latitude: 60.0 }), ALL_HOS_PROFILE_SEEDS);
    expect(south.outcome === "selected" && south.profile.profileKey).toBe("CA_FEDERAL_SOUTH60");
    expect(north.outcome === "selected" && north.profile.profileKey).toBe("CA_FEDERAL_NORTH60");
    const cycle = (p: HosRuleProfile) => p.limits.find(l => l.limitKey === "cycle_1_on_duty_minutes")!.value;
    const drive = (p: HosRuleProfile) => p.limits.find(l => l.limitKey === "daily_drive_minutes")!.value;
    expect(cycle(seed("CA_FEDERAL_NORTH60"))).toBeGreaterThan(cycle(seed("CA_FEDERAL_SOUTH60")));
    expect(drive(seed("CA_FEDERAL_NORTH60"))).toBeGreaterThan(drive(seed("CA_FEDERAL_SOUTH60")));   // the northern division sets its own day
  });

  it("lets an operation-specific profile govern, and names the alternative rather than hiding it", () => {
    const logging = selectProfile(ctx({ carrierAuthority: "provincial", jurisdiction: "BC", operationClass: "logging" }), ALL_HOS_PROFILE_SEEDS);
    expect(logging.outcome === "selected" && logging.profile.profileKey).toBe("BC_LOGGING");
    expect(logging.outcome === "selected" && logging.alsoApplicable).toContain("BC_GENERAL");
  });

  it("says an unverified profile determines nothing, in the selection reasons", () => {
    const r = selectProfile(ctx(), ALL_HOS_PROFILE_SEEDS);
    expect(r.outcome === "selected" && r.reasons.join(" ")).toContain("determine nothing until a person verifies");
  });

  it("reads an effective window like every other rule in the system", () => {
    expect(inForce({ effectiveFrom: t("2026-01-01T00:00:00Z") }, at)).toBe(true);
    expect(inForce({ effectiveTo: t("2026-01-01T00:00:00Z") }, at)).toBe(false);
    expect(inForce({}, at)).toBe(true);
  });
});

describe("the clocks are separate, because they stop for different reasons", () => {
  // 8 h rest, then 5 h driving, 1 h on duty, 4 h driving.
  const entries: DutyEntry[] = [
    { dutyStatus: "off_duty", startedAt: t("2026-09-11T00:00:00Z"), endedAt: t("2026-09-11T08:00:00Z") },
    { dutyStatus: "driving", startedAt: t("2026-09-11T08:00:00Z"), endedAt: t("2026-09-11T13:00:00Z") },
    { dutyStatus: "on_duty", startedAt: t("2026-09-11T13:00:00Z"), endedAt: t("2026-09-11T14:00:00Z") },
    { dutyStatus: "driving", startedAt: t("2026-09-11T14:00:00Z"), endedAt: null },
  ];

  it("counts driving, on duty and the elapsed window at different values from the same record", () => {
    const c = computeClocks(entries, at, { shiftResetMinutes: 480 });
    expect(c.shiftDriveMinutes).toBe(540);      // 9 h driving
    expect(c.shiftOnDutyMinutes).toBe(600);     // 10 h on duty
    expect(c.shiftElapsedMinutes).toBe(600);    // shift began when the 8 h rest ended
    expect(c.continuousDriveMinutes).toBe(240); // the current run only
    expect(c.currentStatus).toBe("driving");
  });

  it("begins the shift where the profile's rest figure says, not where a constant says", () => {
    const strict = computeClocks(entries, at, { shiftResetMinutes: 540 });   // 9 h: the 8 h rest no longer ends a shift
    expect(strict.shiftElapsedMinutes).toBeGreaterThan(600);
  });

  it("keeps sleeper berth out of off-duty and both out of on-duty", () => {
    const c = computeClocks([
      { dutyStatus: "sleeper_berth", startedAt: t("2026-09-11T00:00:00Z"), endedAt: t("2026-09-11T08:00:00Z") },
      { dutyStatus: "driving", startedAt: t("2026-09-11T08:00:00Z"), endedAt: t("2026-09-11T12:00:00Z") },
    ], at, { shiftResetMinutes: 480 });
    expect(c.dailySleeperMinutes).toBe(480);
    expect(c.dailyOffDutyMinutes).toBe(0);
    expect(c.dailyOnDutyMinutes).toBe(240);
  });

  it("has no single hoursRemaining to be wrong with", () => {
    const c = computeClocks(entries, at);
    expect(Object.keys(c)).not.toContain("hoursRemaining");
    expect(Object.keys(c)).not.toContain("remainingMinutes");
  });
});

describe("reality is recorded even when it is non-compliant", () => {
  it("keeps the observed DRIVING state and raises an exceeded finding instead of rewriting history", () => {
    const observed: DutyEntry[] = [
      { dutyStatus: "off_duty", startedAt: t("2026-09-11T08:00:00Z"), endedAt: t("2026-09-11T09:00:00Z") },
      { dutyStatus: "driving", startedAt: t("2026-09-11T09:00:00Z"), endedAt: null },
    ];
    const clocks = computeClocks(observed, at, { shiftResetMinutes: 60 });
    const synthetic: HosRuleProfile = {
      profileKey: "TEST_REALITY_NOT_REWRITE", label: "Synthetic test rule — not regulatory data",
      applicability: { authorityLevel: "provincial", jurisdiction: "ZZ", latitudeRule: null, minimumWeightKg: null, operationClass: null },
      sourceAuthority: "test fixture", sourceCitation: "synthetic invariant fixture", verificationStatus: "verified",
      limits: [{ limitKey: "daily_drive_minutes", value: 60, sourceSection: "test", verificationStatus: "verified" }],
    };
    const result = determine(clocks, synthetic);
    expect(clocks.currentStatus).toBe("driving");
    expect(result.verdict).toBe("exceeded");
    expect(result.determinations[0].result).toBe("exceeded");
    expect(observed[1].dutyStatus).toBe("driving");
  });
});

describe("an unverified figure determines nothing, and the clock still shows", () => {
  const entries: DutyEntry[] = [
    { dutyStatus: "off_duty", startedAt: t("2026-09-11T00:00:00Z"), endedAt: t("2026-09-11T08:00:00Z") },
    { dutyStatus: "driving", startedAt: t("2026-09-11T08:00:00Z"), endedAt: null },
  ];
  const clocks = computeClocks(entries, at, { shiftResetMinutes: 480 });

  it("returns UNKNOWN on every limit of a seeded profile, with the hours worked still counted", () => {
    const d = determine(clocks, seed("CA_FEDERAL_SOUTH60"));
    expect(d.verdict).toBe("unknown");
    expect(d.determinations.every(x => x.result === "unknown")).toBe(true);
    expect(d.determinations.every(x => x.limitMinutes === null)).toBe(true);
    const drive = d.determinations.find(x => x.limitKey === "daily_drive_minutes")!;
    expect(drive.usedMinutes).toBe(600);            // the hours are a fact
    expect(drive.remainingMinutes).toBeNull();      // the answer is not
    expect(d.explanation).toContain("The clocks are shown; the compliance answer is UNKNOWN");
  });

  it("states a remaining figure only once the rule behind it is verified", () => {
    const d = determine(clocks, verified(seed("CA_FEDERAL_SOUTH60")));
    const drive = d.determinations.find(x => x.limitKey === "daily_drive_minutes")!;
    expect(drive.result).toBe("within");
    expect(drive.remainingMinutes).toBe(180);       // 13 h limit, 10 h driven
    expect(drive.reason).toContain("180 min remaining");
    // The overall verdict is still UNKNOWN, and honestly so: this engine
    // computes no clock for core rest or the cycle-day counts, so it cannot
    // claim the driver is compliant — only that this limit is not exceeded.
    expect(d.verdict).toBe("unknown");
    expect(d.determinations.filter(x => x.result === "unknown").every(x => x.usedMinutes === null)).toBe(true);
  });

  it("reports exceeded rather than rounding it away, and exceeded beats unknown", () => {
    const long: DutyEntry[] = [
      { dutyStatus: "off_duty", startedAt: t("2026-09-10T14:00:00Z"), endedAt: t("2026-09-10T22:00:00Z") },
      { dutyStatus: "driving", startedAt: t("2026-09-10T22:00:00Z"), endedAt: null },
    ];
    const p = verified(seed("CA_FEDERAL_SOUTH60"));
    const partly: HosRuleProfile = { ...p, limits: p.limits.map(l => (l.limitKey === "daily_on_duty_minutes" ? { ...l, verificationStatus: "unverified" as const } : l)) };
    const d = determine(computeClocks(long, at, { shiftResetMinutes: 480 }), partly);
    expect(d.exceededCount).toBeGreaterThan(0);
    expect(d.unknownCount).toBeGreaterThan(0);
    expect(d.verdict).toBe("exceeded");
  });

  it("determines nothing at all when no profile was selected", () => {
    const d = determine(clocks, null);
    expect(d.verdict).toBe("unknown");
    expect(d.explanation).toContain("No applicable schedule has been determined");
  });

  it("returns UNKNOWN for a profile whose figures were never loaded, rather than borrowing a neighbour's", () => {
    const d = determine(clocks, seed("BC_OIL_WELL_SERVICE"));
    expect(d.verdict).toBe("unknown");
    expect(d.determinations).toHaveLength(0);
  });
});

describe("the predictive answer refuses to be a guess", () => {
  const entries: DutyEntry[] = [
    { dutyStatus: "off_duty", startedAt: t("2026-09-11T00:00:00Z"), endedAt: t("2026-09-11T08:00:00Z") },
    { dutyStatus: "driving", startedAt: t("2026-09-11T08:00:00Z"), endedAt: null },
  ];
  const clocks = computeClocks(entries, at, { shiftResetMinutes: 480 });

  it("says UNKNOWN rather than a number when the driving limit is unverified", () => {
    const f = tripFeasibility(determine(clocks, seed("CA_FEDERAL_SOUTH60")), 120);
    expect(f.feasible).toBe("unknown");
    expect(f.reasons.join(" ")).toContain("not verified");
  });

  it("names the shortfall in minutes once the rule is verified", () => {
    const d = determine(clocks, verified(seed("CA_FEDERAL_SOUTH60")));
    expect(tripFeasibility(d, 120)).toMatchObject({ feasible: "yes", marginMinutes: 60 });
    const short = tripFeasibility(d, 240);
    expect(short.feasible).toBe("no");
    expect(short.feasible === "no" && short.shortfallMinutes).toBe(60);
    expect(short.reasons.join(" ")).toContain("cannot be completed legally without rest");
  });
});

describe("the seeds are candidates, not regulation", () => {
  it("seeds every profile and every figure unverified", () => {
    expect(ALL_HOS_PROFILE_SEEDS.every(p => p.verificationStatus === "unverified")).toBe(true);
    expect(ALL_HOS_PROFILE_SEEDS.every(p => p.limits.every(l => l.verificationStatus === "unverified"))).toBe(true);
  });

  it("keeps Alberta's provincial regime distinct from the federal schedule rather than a variant of it", () => {
    const ab = seed("AB_PROVINCIAL"), fed = seed("CA_FEDERAL_SOUTH60");
    const v = (p: HosRuleProfile, k: string) => p.limits.find(l => l.limitKey === k)?.value ?? null;
    expect(v(ab, "daily_on_duty_minutes")).not.toBe(v(fed, "daily_on_duty_minutes"));
    expect(v(ab, "break_required_after_drive_minutes")).not.toBeNull();   // a clause the federal schedule does not carry
    expect(v(fed, "break_required_after_drive_minutes")).toBeNull();
    expect(v(ab, "cycle_1_on_duty_minutes")).toBeNull();                  // and it is not a 70-and-7 regime
  });

  it("uses only limit keys the engine knows", () => {
    for (const p of ALL_HOS_PROFILE_SEEDS) for (const l of p.limits) expect(LIMIT_KEYS).toContain(l.limitKey);
  });

  it("leaves the regimes it did not capture empty rather than filled in from a neighbour", () => {
    for (const k of ["BC_OIL_WELL_SERVICE", "YT_NORTH60", "NT_NORTH60", "NU_NORTH60"]) expect(seed(k).limits).toHaveLength(0);
  });

  it("gives every profile a citation to check it against", () => {
    expect(ALL_HOS_PROFILE_SEEDS.every(p => p.sourceCitation.length > 10 && p.sourceAuthority.length > 3)).toBe(true);
  });
});

describe("verifying an HOS figure is a sensitive act", () => {
  it("fails closed, because a verified figure becomes a legal determination about a person", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("hos.rule.verify");
    expect(SENSITIVE_PERMISSIONS).not.toContain("hos.read");
  });
});

/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 413_000_000 + Math.floor(Math.random() * 50_000);
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = userSeq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("the registry through the database", () => {
  it("seeds unverified, is idempotent, and refuses to verify a profile while any figure under it is unverified", async () => {
    const controller = await withRole("controller");
    const verifier = await withRole("management");
    const first = await callerFor(controller).hos.profileSeed();
    const second = await callerFor(controller).hos.profileSeed();
    expect(second.inserted).toBe(0);
    expect(first.inserted + first.existing).toBeGreaterThanOrEqual(ALL_HOS_PROFILE_SEEDS.length);

    const listed = await callerFor(controller).hos.profileList();
    expect(listed.caveat).toContain("determines anything until a controller verifies");
    expect(listed.profiles.find(p => p.profileKey === "BC_OIL_WELL_SERVICE")!.note).toContain("every determination under it is UNKNOWN");

    await expect(callerFor(verifier).hos.profileVerify({ profileKey: "CA_FEDERAL_SOUTH60" })).rejects.toThrow(/figure\(s\) in this profile are unverified/i);
    await expect(callerFor(verifier).hos.profileVerify({ profileKey: "YT_NORTH60" })).rejects.toThrow(/carries no figures/i);
  });

  // 0093B. These moved from `hos.limitVerify`, which is closed: it reached
  // "verified" from a section string and a number, with no citation and no
  // ledger row. `limitPromote` reports the same correction and leaves a
  // promotion an audit can follow.
  it("records a correction when the verifier reads a different number than was seeded", async () => {
    const controller = await withRole("controller");
    const verifier = await withRole("management");
    await callerFor(controller).hos.profileSeed();
    await pool.execute("UPDATE hosRuleLimits SET verificationStatus = 'unverified' WHERE profileKey = 'MB_PROVINCIAL' AND limitKey = 'daily_drive_minutes'");
    const same = await callerFor(verifier).hos.limitPromote({ profileKey: "MB_PROVINCIAL", limitKey: "daily_drive_minutes", sourceSection: "s.12", value: 780,
      jurisdiction: "MB", geographicScope: "ALL", authorityType: "law",
      instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
      issuingAuthority: "FIXTURE — no issuing authority",
      citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
      verificationMethod: "OFFICIAL_WEB", unit: "minutes",
      attestInstrumentOpen: true, attestPersonallyVerified: true, attestBindingAuthority: true } as never) as { corrected: boolean; value: number };
    expect(same).toMatchObject({ corrected: false, value: 780 });

    await pool.execute("UPDATE hosRuleLimits SET verificationStatus = 'unverified' WHERE profileKey = 'MB_PROVINCIAL' AND limitKey = 'core_rest_minutes'");
    const changed = await callerFor(verifier).hos.limitPromote({ profileKey: "MB_PROVINCIAL", limitKey: "core_rest_minutes", sourceSection: "s.14", value: 500,
      jurisdiction: "MB", geographicScope: "ALL", authorityType: "law",
      instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
      issuingAuthority: "FIXTURE — no issuing authority",
      citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
      verificationMethod: "OFFICIAL_WEB", unit: "minutes",
      attestInstrumentOpen: true, attestPersonallyVerified: true, attestBindingAuthority: true } as never) as { corrected: boolean; previousValue: number | null; value: number };
    expect(changed).toMatchObject({ corrected: true, previousValue: 480, value: 500 });
  });

  it("answers a driver's status with the clocks counted and the compliance answer UNKNOWN", async () => {
    const controller = await withRole("controller");
    const dispatcher = await withRole("dispatcher");
    await callerFor(controller).hos.profileSeed();
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [key("Op").slice(0, 40)]);
    const operatorId = Number(op.insertId);
    await pool.execute("INSERT INTO dutyRecords (operatorId, dutyStatus, startedAt, endedAt, createdAt) VALUES (?, 'off_duty', '2026-09-11 00:00:00', '2026-09-11 08:00:00', NOW())", [operatorId]);
    await pool.execute("INSERT INTO dutyRecords (operatorId, dutyStatus, startedAt, endedAt, createdAt) VALUES (?, 'driving', '2026-09-11 08:00:00', NULL, NOW())", [operatorId]);

    const status = await callerFor(dispatcher).hos.status({ operatorId, carrierAuthority: "federal", jurisdiction: "AB", latitude: 53.5, at: new Date("2026-09-11T18:00:00Z") });
    expect(status.dutyRecordsRead).toBe(2);
    expect(status.selection.outcome).toBe("selected");
    expect(status.determination.verdict).toBe("unknown");
    expect(status.clocks.shiftDriveMinutes).toBeGreaterThan(0);
    expect(status.shiftBasis).toContain("a default, because no verified core-rest figure applies");

    const feas = await callerFor(dispatcher).hos.tripFeasibility({ operatorId, carrierAuthority: "federal", jurisdiction: "AB", latitude: 53.5, estimatedDriveMinutes: 120, at: new Date("2026-09-11T18:00:00Z") });
    expect(feas.feasibility.feasible).toBe("unknown");
  });

  it("refuses the whole determination when the ladder is incomplete, rather than picking a schedule", async () => {
    const dispatcher = await withRole("dispatcher");
    const r = await callerFor(dispatcher).hos.profileFor({ carrierAuthority: null, jurisdiction: "AB", latitude: 53.5 });
    expect(r.outcome).toBe("unknown");
  });

  it("does not let a dispatcher verify a rule", async () => {
    const dispatcher = await withRole("dispatcher");
    await expect(callerFor(dispatcher).hos.limitPromote({ profileKey: "MB_PROVINCIAL", limitKey: "daily_drive_minutes", sourceSection: "s.12", value: 780,
      jurisdiction: "MB", geographicScope: "ALL", authorityType: "law",
      instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
      issuingAuthority: "FIXTURE — no issuing authority",
      citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
      verificationMethod: "OFFICIAL_WEB", unit: "minutes",
      attestInstrumentOpen: true, attestPersonallyVerified: true, attestBindingAuthority: true } as never)).rejects.toThrow();
  });
});
