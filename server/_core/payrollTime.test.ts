/**
 * Payroll P3 — the pure rules: candidate identity and provenance, overlap, period resolution, D10 routing, source
 * authority, exception policy, the time → earning boundary, integer pay, and the offline state guard.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_GATE_KINDS,
  CANDIDATE_SOURCES,
  EARNING_STAGE_KINDS,
  EXCEPTION_POLICY,
  PAYROLL_EXCEPTION_KINDS,
  SOURCE_AUTHORITY,
  candidateKey,
  candidatesFromSources,
  canTransitionTime,
  exceptionConditionKey,
  hourlyAmountCents,
  intervalsOverlap,
  isBlocking,
  isEffective,
  isPayable,
  localDate,
  overlappingPairs,
  overlapsFor,
  periodAcceptsNewTime,
  periodAcceptsTimeApproval,
  periodForDate,
  resolvePayrollTimeApprovers,
  resolveTimeEarning,
  scheduleForProfile,
  serverStateForCapture,
  sourceFingerprint,
  type SourceFact,
  type TimeEarningInput,
} from "./payrollTime";
import { PAYROLL_EXCEPTION_KIND_VALUES } from "../../drizzle/schema";

const at = (s: string) => new Date(s);
const hos = (over: Partial<SourceFact> = {}): SourceFact => ({
  sourceType: "hos_duty", sourceRef: "dutyRecords:41", segment: null, sourceVersion: null,
  material: { operatorId: 7, dutyStatus: "on_duty" }, startedAt: at("2026-03-02T15:00:00Z"), endedAt: at("2026-03-02T23:00:00Z"),
  measurementAuthority: "regulatory_duty_record", activity: "on_location", ...over,
});

describe("P3 — candidate identity and provenance (1, 2, 3, 19)", () => {
  it("names a source segment deterministically, whatever order or object its facts arrive in", () => {
    expect(candidateKey({ sourceType: "hos_duty", sourceRef: "dutyRecords:41" })).toBe(candidateKey({ sourceRef: "dutyRecords:41", sourceType: "hos_duty", segment: null } as never));
    expect(candidateKey(hos())).toMatch(/^[0-9a-f]{64}$/);
    expect(candidateKey(hos({ segment: "a" }))).not.toBe(candidateKey(hos({ segment: "b" })));
    expect(candidateKey(hos())).not.toBe(candidateKey(hos({ sourceType: "dispatch_booking" })));
  });

  it("keeps the identity when the source changes, and changes the fingerprint", () => {
    const a = hos();
    const edited = hos({ endedAt: at("2026-03-02T23:30:00Z") });
    const revised = hos({ sourceVersion: "rev2:abc" });
    expect(candidateKey(edited)).toBe(candidateKey(a));
    expect(sourceFingerprint(edited)).not.toBe(sourceFingerprint(a));
    expect(sourceFingerprint(revised)).not.toBe(sourceFingerprint(a));
    expect(sourceFingerprint(hos())).toBe(sourceFingerprint(a));
  });

  it("projects candidates — never anything else — and says why one cannot be submitted", () => {
    const facts: SourceFact[] = [
      hos(),
      hos({ sourceRef: "dutyRecords:42", endedAt: null, blockedReason: "The duty interval is still open" }),
      { sourceType: "trip", sourceRef: "T-1", material: {}, startedAt: at("2026-03-02T16:00:00Z"), endedAt: at("2026-03-02T18:00:00Z"), quantity: { value: 120, unit: "km" }, measurementAuthority: "trip_record" },
      { sourceType: "dispatch_booking", sourceRef: "resourceBookings:9", material: { bookingState: "cancelled" }, startedAt: at("2026-03-03T14:00:00Z"), endedAt: at("2026-03-03T22:00:00Z"), measurementAuthority: "planned", blockedReason: "The booking is cancelled, not confirmed" },
    ];
    const cs = candidatesFromSources({ employeePayrollProfileId: 3, timezone: "America/Edmonton", facts, submitted: new Map() });
    expect(cs.every(c => c.status === "candidate")).toBe(true);
    const first = cs.find(c => c.sourceRef === "dutyRecords:41")!;
    expect(first).toMatchObject({ eligible: true, minutes: 480, workDate: "2026-03-02", authority: "regulatory_duty" });
    expect(first.warnings[0]).toMatch(/not paid time/);
    expect(cs.find(c => c.sourceRef === "dutyRecords:42")).toMatchObject({ eligible: false, ineligibleReason: "The duty interval is still open" });
    expect(cs.find(c => c.sourceType === "trip")).toMatchObject({ eligible: false, quantity: { value: 120, unit: "km" } });
    expect(cs.find(c => c.sourceType === "dispatch_booking")!.ineligibleReason).toMatch(/cancelled/);
    // Already submitted: still a candidate, no longer submittable.
    const again = candidatesFromSources({ employeePayrollProfileId: 3, timezone: "America/Edmonton", facts: [hos()], submitted: new Map([[first.candidateKey, "PT-1"]]) });
    expect(again[0]).toMatchObject({ status: "candidate", eligible: false, submittedAsEntryRef: "PT-1" });
    // Repeated reads are identical.
    expect(candidatesFromSources({ employeePayrollProfileId: 3, timezone: "America/Edmonton", facts, submitted: new Map() })).toEqual(cs);
  });

  it("reads the work date in the schedule's zone, not the server's", () => {
    expect(localDate(at("2026-03-03T05:30:00Z"), "America/Edmonton")).toBe("2026-03-02");
    expect(localDate(at("2026-03-03T05:30:00Z"), "UTC")).toBe("2026-03-03");
  });
});

describe("P3 — source authority (13)", () => {
  it("classifies every source, and lets only time-window sources be submitted as time", () => {
    expect(Object.keys(SOURCE_AUTHORITY).sort()).toEqual([...CANDIDATE_SOURCES].sort());
    expect(SOURCE_AUTHORITY.hos_duty).toMatchObject({ authority: "regulatory_duty", timeEligible: true });
    expect(SOURCE_AUTHORITY.dispatch_booking).toMatchObject({ authority: "planned_assignment", timeMeaning: "planned_window" });
    expect(SOURCE_AUTHORITY.field_ticket).toMatchObject({ authority: "actual_operational", timeMeaning: "actual_window" });
    expect(SOURCE_AUTHORITY.trip).toMatchObject({ provesQuantity: true, timeEligible: false });
    expect(SOURCE_AUTHORITY.load).toMatchObject({ authority: "measured_quantity", timeEligible: false });
    expect(CANDIDATE_SOURCES).not.toContain("work_order_labour");
  });
});

describe("P3 — overlap, effectiveness and the entry machine (4, 5, 6, 18)", () => {
  const e = (start: string, end: string | null, status: "open" | "submitted" | "approved" | "void" = "submitted", supersededByEntryId: number | null = null) => ({ entryRef: start, status, supersededByEntryId, startedAt: at(start), endedAt: end ? at(end) : null });

  it("treats touching intervals as adjacent and nested or crossing ones as overlapping", () => {
    expect(intervalsOverlap({ startedAt: at("2026-03-02T08:00:00Z"), endedAt: at("2026-03-02T12:00:00Z") }, { startedAt: at("2026-03-02T12:00:00Z"), endedAt: at("2026-03-02T16:00:00Z") })).toBe(false);
    expect(intervalsOverlap({ startedAt: at("2026-03-02T08:00:00Z"), endedAt: at("2026-03-02T18:00:00Z") }, { startedAt: at("2026-03-02T10:00:00Z"), endedAt: at("2026-03-02T11:00:00Z") })).toBe(true);
    expect(intervalsOverlap({ startedAt: at("2026-03-02T08:00:00Z"), endedAt: at("2026-03-02T12:00:00Z") }, { startedAt: at("2026-03-02T11:59:00Z"), endedAt: at("2026-03-02T16:00:00Z") })).toBe(true);
  });

  it("ignores drafts, void and superseded entries, and pairs every live overlap", () => {
    const rows = [
      e("2026-03-02T08:00:00Z", "2026-03-02T12:00:00Z"),
      e("2026-03-02T10:00:00Z", "2026-03-02T11:00:00Z"),
      e("2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z", "void"),
      e("2026-03-02T09:00:00Z", "2026-03-02T10:30:00Z", "submitted", 99),
      e("2026-03-02T09:00:00Z", "2026-03-02T10:30:00Z", "open"),
      e("2026-03-02T12:00:00Z", "2026-03-02T13:00:00Z", "approved"),
    ];
    expect(overlapsFor({ startedAt: at("2026-03-02T09:30:00Z"), endedAt: at("2026-03-02T10:15:00Z") }, rows).map(r => r.entryRef)).toEqual(["2026-03-02T08:00:00Z", "2026-03-02T10:00:00Z"]);
    expect(overlappingPairs(rows).map(([a, b]) => [a.entryRef, b.entryRef])).toEqual([["2026-03-02T08:00:00Z", "2026-03-02T10:00:00Z"]]);
  });

  it("never counts a superseded or void row as payable", () => {
    expect(isPayable({ status: "approved", supersededByEntryId: null })).toBe(true);
    expect(isPayable({ status: "approved", supersededByEntryId: 4 })).toBe(false);
    expect(isPayable({ status: "submitted", supersededByEntryId: null })).toBe(false);
    expect(isEffective({ status: "void", supersededByEntryId: null })).toBe(false);
    expect(isEffective({ status: "submitted", supersededByEntryId: 4 })).toBe(false);
  });

  it("moves time only along its machine: rejected is void, approved is never re-opened", () => {
    expect(canTransitionTime("open", "submitted")).toBe(true);
    expect(canTransitionTime("submitted", "approved")).toBe(true);
    expect(canTransitionTime("submitted", "void")).toBe(true);
    expect(canTransitionTime("approved", "submitted")).toBe(false);
    expect(canTransitionTime("approved", "void")).toBe(false);
    expect(canTransitionTime("void", "submitted")).toBe(false);
    expect(canTransitionTime("open", "approved")).toBe(false);
  });
});

describe("P3 — profile → schedule → period (7, 8, 9)", () => {
  const periods = [
    { id: 1, periodRef: "P-1", state: "collecting", periodStartDate: "2026-03-02", periodEndDate: "2026-03-09" },
    { id: 2, periodRef: "P-2", state: "collecting", periodStartDate: "2026-03-09", periodEndDate: "2026-03-16" },
    { id: 3, periodRef: "P-V", state: "voided", periodStartDate: "2026-03-16", periodEndDate: "2026-03-23" },
  ];
  it("finds the one period containing a date, half-open", () => {
    expect(periodForDate(periods, "2026-03-08")).toMatchObject({ kind: "period", period: { id: 1 } });
    expect(periodForDate(periods, "2026-03-09")).toMatchObject({ kind: "period", period: { id: 2 } });
  });
  it("names no matching period, and never uses a voided one", () => {
    expect(periodForDate(periods, "2026-03-20")).toMatchObject({ kind: "none", exception: "no_matching_pay_period" });
    expect(periodForDate(periods, "2026-02-01")).toMatchObject({ kind: "none" });
  });
  it("refuses to choose between two periods", () => {
    const dup = [...periods, { id: 9, periodRef: "P-X", state: "collecting", periodStartDate: "2026-03-05", periodEndDate: "2026-03-12" }];
    expect(periodForDate(dup, "2026-03-06")).toMatchObject({ kind: "integrity_error" });
  });
  it("walks profile → pay group → schedule inside one book, and refuses every gap by name", () => {
    const profile = { financialEntityId: 5, payGroupId: 8 };
    const group = { id: 8, financialEntityId: 5, active: true, payScheduleId: 2 };
    const schedule = { id: 2, financialEntityId: 5, status: "active", timezone: "America/Edmonton" };
    expect(scheduleForProfile({ profile, payGroup: group, schedule })).toEqual({ ok: true, scheduleId: 2, timezone: "America/Edmonton" });
    expect(scheduleForProfile({ profile: { financialEntityId: 5, payGroupId: null }, payGroup: null, schedule: null })).toMatchObject({ ok: false });
    expect(scheduleForProfile({ profile, payGroup: { ...group, financialEntityId: 6 }, schedule })).toMatchObject({ ok: false, reason: /not in the profile's book/ });
    expect(scheduleForProfile({ profile, payGroup: { ...group, payScheduleId: null }, schedule: null })).toMatchObject({ ok: false, reason: /no pay schedule/ });
    expect(scheduleForProfile({ profile, payGroup: group, schedule: { ...schedule, status: "retired" } })).toMatchObject({ ok: false, reason: /retired/ });
    expect(scheduleForProfile({ profile, payGroup: { ...group, active: false }, schedule })).toMatchObject({ ok: false, reason: /inactive/ });
  });
  it("takes new time only while OPEN, and approvals through REVIEWING", () => {
    expect(periodAcceptsNewTime("collecting")).toBe(true);
    expect(periodAcceptsNewTime("review")).toBe(false);
    expect(periodAcceptsTimeApproval("review")).toBe(true);
    expect(periodAcceptsTimeApproval("approved")).toBe(false);
  });
});

describe("P3 — D10 approvers (10, 11, 12)", () => {
  const m = (crewId: number, userId: number, crewRole: string, active = true) => ({ crewId, userId, crewRole, active });
  it("routes to the supervisors of the worker's own active crews", () => {
    const r = resolvePayrollTimeApprovers({ workerUserId: 10, memberships: [m(1, 10, "driver"), m(1, 20, "supervisor"), m(2, 30, "supervisor"), m(2, 11, "driver")], payrollAdminUserIds: [90] });
    expect(r).toEqual({ route: "crew_supervisor", approverUserIds: [20], crewIds: [1] });
  });
  it("gives a dispatcher, or a member of the same crew who is not its supervisor, nothing", () => {
    const r = resolvePayrollTimeApprovers({ workerUserId: 10, memberships: [m(1, 10, "driver"), m(1, 40, "dispatch"), m(1, 41, "safety"), m(1, 20, "supervisor", false)], payrollAdminUserIds: [90] });
    expect(r.route).toBe("payroll_admin");
    expect(r.approverUserIds).toEqual([90]);
  });
  it("falls back to payroll administrators when there is no crew supervisor, and never to the worker", () => {
    expect(resolvePayrollTimeApprovers({ workerUserId: 10, memberships: [], payrollAdminUserIds: [10, 90, 91] })).toMatchObject({ route: "payroll_admin", approverUserIds: [90, 91] });
    expect(resolvePayrollTimeApprovers({ workerUserId: 20, memberships: [m(1, 20, "supervisor")], payrollAdminUserIds: [90] })).toMatchObject({ route: "payroll_admin", approverUserIds: [90] });
    expect(resolvePayrollTimeApprovers({ workerUserId: 10, memberships: [m(1, 10, "driver")], payrollAdminUserIds: [10] })).toMatchObject({ route: "none", approverUserIds: [] });
  });
});

describe("P3 — exception policy (14)", () => {
  it("covers every kind the table stores, and says which are blocking and what clears them", () => {
    expect([...PAYROLL_EXCEPTION_KINDS].sort()).toEqual([...PAYROLL_EXCEPTION_KIND_VALUES].sort());
    for (const k of ["cross_tenant_reference", "duplicate_entry", "no_active_agreement", "missing_earning_code", "no_matching_pay_period", "locked_pay_period", "self_approval_blocked", "no_valid_approver", "source_changed_after_preparation"] as const) expect(isBlocking(k), k).toBe(true);
    for (const k of ["clock_variance", "long_shift", "missing_approval"] as const) expect(isBlocking(k), k).toBe(false);
    expect(APPROVAL_GATE_KINDS).toEqual(["overlapping_entries", "outside_employment", "source_changed_after_preparation"]);
    expect(EARNING_STAGE_KINDS).toEqual(["no_active_agreement", "missing_earning_code", "earning_rule_mismatch", "job_reference_missing"]);
    expect(EXCEPTION_POLICY.clock_variance.blocks).toBeNull();
  });
  it("gives one condition one key", () => {
    expect(exceptionConditionKey("overlapping_entries", "time_entry", "PT-1", "PT-2")).toBe(exceptionConditionKey("overlapping_entries", "time_entry", "PT-1", "PT-2"));
    expect(exceptionConditionKey("overlapping_entries", "time_entry", "PT-1", "PT-2")).not.toBe(exceptionConditionKey("overlapping_entries", "time_entry", "PT-1", "PT-3"));
  });
});

describe("P3 — integer pay (17)", () => {
  it("prices minutes × rateMillis to the cent, rounding half-up, with no floating point", () => {
    expect(hourlyAmountCents(1, 30_000)).toBe(50);          // $30/h × 1 min = $0.50
    expect(hourlyAmountCents(15, 30_000)).toBe(750);
    expect(hourlyAmountCents(30, 33_333)).toBe(1667);       // 1666.65 → 1667
    expect(hourlyAmountCents(457, 28_750)).toBe(21898);     // 7h37m at $28.75 = 218.979… → 21898
    expect(hourlyAmountCents(1, 1)).toBe(0);                // 0.0016… cents
    expect(hourlyAmountCents(300, 1)).toBe(1);              // exactly half a cent rounds up
    expect(hourlyAmountCents(0, 30_000)).toBe(0);
    expect(() => hourlyAmountCents(1.5, 30_000)).toThrow(RangeError);
    expect(() => hourlyAmountCents(-1, 30_000)).toThrow(RangeError);
  });
});

describe("P3 — time → earning (15, 16)", () => {
  const ok: TimeEarningInput = {
    entry: { workDate: "2026-03-02", minutes: 480, earningCode: "REG", jobId: null, unitId: null },
    code: { code: "REG", calculationType: "hourly", requiresJob: false, requiresUnit: false },
    inForce: { kind: "version", versionRef: "CAV-1", rulesHash: "h".repeat(64) },
    rule: { id: 3, earningCode: "REG", calculation: "hourly", unit: "hour", rateMillis: 30_000, requiresJob: false, requiresUnit: false },
  };
  it("prices approved time from the approved version's rule", () => {
    expect(resolveTimeEarning(ok)).toEqual({ ok: true, amountCents: 24000, rateMillis: 30_000, minutes: 480, earningCode: "REG", versionRef: "CAV-1", rulesHash: "h".repeat(64), ruleId: 3 });
  });
  it("blocks — never falls back to a legacy rate — on every gap", () => {
    expect(resolveTimeEarning({ ...ok, entry: { ...ok.entry, earningCode: null } })).toMatchObject({ ok: false, exception: "missing_earning_code" });
    expect(resolveTimeEarning({ ...ok, code: null })).toMatchObject({ ok: false, exception: "missing_earning_code" });
    expect(resolveTimeEarning({ ...ok, inForce: null })).toMatchObject({ ok: false, exception: "no_active_agreement" });
    expect(resolveTimeEarning({ ...ok, inForce: { kind: "integrity_error", reason: "two" } })).toMatchObject({ ok: false, exception: "no_active_agreement", reason: "two" });
    expect(resolveTimeEarning({ ...ok, rule: null })).toMatchObject({ ok: false, exception: "earning_rule_mismatch" });
    expect(resolveTimeEarning({ ...ok, rule: { ...ok.rule!, unit: "km" } })).toMatchObject({ ok: false, exception: "earning_rule_mismatch" });
    expect(resolveTimeEarning({ ...ok, rule: { ...ok.rule!, calculation: "flat" } })).toMatchObject({ ok: false, exception: "earning_rule_mismatch" });
    expect(resolveTimeEarning({ ...ok, code: { ...ok.code!, calculationType: "quantity_times_rate" } })).toMatchObject({ ok: false, exception: "earning_rule_mismatch" });
    expect(resolveTimeEarning({ ...ok, code: { ...ok.code!, requiresJob: true } })).toMatchObject({ ok: false, exception: "job_reference_missing" });
    expect(resolveTimeEarning({ ...ok, entry: { ...ok.entry, minutes: null } })).toMatchObject({ ok: false });
  });
});

describe("P3 — offline captures choose nothing (20)", () => {
  it("may ask to be a draft or submitted, and is refused for anything further", () => {
    expect(serverStateForCapture(undefined)).toEqual({ ok: true, state: "submitted" });
    expect(serverStateForCapture("open")).toEqual({ ok: true, state: "open" });
    for (const claim of ["approved", "verified", "paid", "rejected", "APPROVED"]) expect(serverStateForCapture(claim).ok, claim).toBe(false);
  });
});
