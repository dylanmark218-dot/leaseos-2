/**
 * HOS phase 2a — the one canonical HOS calculation over the ELD ledger.
 *
 * Pure. No database, no clock of its own, no regulation. It composes three things that already
 * exist and adds only the discipline between them:
 *
 *   ledger rows ──projectDutyEntries──▶ DutyEntry[] ──computeClocks──▶ Clocks ──determine──▶ HosDetermination
 *                                                        ▲                          ▲
 *                                         mechanics (what bounds a day,     selectProfile + the verified
 *                                         a shift, a cycle)                 figures in the registry
 *
 * The discipline is one rule: A NUMBER IS STATED ONLY WHEN EVERYTHING BEHIND IT IS VERIFIED. A
 * verified figure is not enough on its own. "13 hours of driving in a day" means nothing until a
 * day is defined, and the only mechanics this codebase has today is the trailing-window default in
 * `computeClocks` — a rolling 24 hours, rolling 7 and 14 days, a shift after the last long rest.
 * That default is honest about elapsed time and makes no claim about a regime's day. So:
 *
 *   day-bound limits (daily_*)    under default mechanics → UNKNOWN, clock still shown
 *   cycle-bound limits (cycle_*)  under default mechanics → UNKNOWN, clock still shown
 *   shift-bound limits (shift_*)  determined only when the core rest that ends a shift is itself
 *                                 a verified figure; otherwise UNKNOWN
 *   break_required_after_drive    determined from continuous driving; it depends on no boundary
 *
 * A downgraded determination keeps `usedMinutes` and loses `limitMinutes`/`remainingMinutes`: the
 * driver sees what was counted, and nobody sees a remaining figure the engine cannot defend. When
 * a regime's mechanics module exists and is verified (a later checkpoint), it replaces the default
 * and these downgrades stop applying to the limits it governs.
 *
 * Checkpoint 2c adds the operator's DESIGNATED duty day (`dutyDay.ts`, recorded in 0224) and counts
 * the four duty statuses over it, exactly, through 23- and 25-hour days. That is arithmetic, not a
 * rule: nothing verified yet says that a regime's daily limits are counted over this day. So a
 * designation changes WHY a daily limit is unknown (HOS_DAY_RULE_UNVERIFIED instead of
 * HOS_DAY_BOUNDARY_UNKNOWN) and shows the day's clocks; it does not unlock a single verdict.
 */
import {
  computeClocks, determine, selectProfile, LIMIT_LABELS,
  type Clocks, type HosDetermination, type HosRuleProfile, type LimitDetermination, type LimitKey, type OperatingContext, type SelectionOutcome,
} from "../hos";
import { projectDutyEntries, type HosProjection, type LedgerEventLike } from "./hosProjection";
import type { HosReasonCode } from "./reasonCodes";
import { dutyDayClocks, type DutyDayClocks, type DutyDayDesignation } from "./dutyDay";

export const HOS_ENGINE_VERSION = "hos-engine/2c" as const;

/** The only mechanics this checkpoint implements. Named, so a result can say which one produced it. */
export const DEFAULT_MECHANICS = "trailing_window" as const;

export type HosEngineInput = {
  operatorId: number;
  /** One operator's ledger rows (other operators' rows are ignored and counted). */
  events: readonly LedgerEventLike[];
  /**
   * The operator's duty-day designation in force at `at` (0224), or null when none is on record.
   * The ref and effective time travel through to the result so a reader can find the row.
   */
  dutyDay: (DutyDayDesignation & { designationRef?: string | null; effectiveFrom?: Date | null }) | null;
  context: OperatingContext;
  profiles: readonly HosRuleProfile[];
  /** Sequence ranges the device chain is missing, from `assessDeviceChain`. Overlap with the window is flagged. */
  chainGaps?: readonly { fromAt: Date | null; toAt: Date | null }[];
  at: Date;
};

export type HosFinding = {
  code: HosReasonCode;
  limitKey: LimitKey | null;
  /** `profileKey:limitKey` — enough to find the figure and its promotion in the registry. */
  ruleId: string | null;
  usedMinutes: number | null;
  limitMinutes: number | null;
  explanation: string;
};

export type HosEngineResult = {
  engineVersion: typeof HOS_ENGINE_VERSION;
  at: Date;
  operatorId: number;
  mechanicsKey: string;
  selection: SelectionOutcome;
  projection: HosProjection;
  clocks: Clocks;
  /** `determine`'s answer AFTER the mechanics downgrade. The raw answer is never exposed. */
  determination: HosDetermination;
  currentStatus: Clocks["currentStatus"];
  timeInCurrentStatusMinutes: number;
  /**
   * The designated duty day containing `at` and the four statuses counted over it, up to `at`. Null
   * when no designation is on record, or when the runtime no longer knows its zone. Shown, never
   * compared against a limit: no verified rule yet says a regime counts a limit over this day.
   */
  dutyDay: (DutyDayClocks & {
    designationRef: string | null;
    designationEffectiveFrom: Date | null;
    /** The designation took effect after this day began: the day's start was computed by a designation not in force at that start. */
    designationChangedDuringDay: boolean;
  }) | null;
  /** Remaining, per clock, and only from a determination whose limit AND boundary are verified. */
  remaining: { drivingMinutes: number | null; onDutyMinutes: number | null; shiftWindowMinutes: number | null; cycleMinutes: number | null; basisRuleIds: string[] };
  violations: HosFinding[];
  unknowns: HosFinding[];
  verdict: "within" | "exceeded" | "unknown";
  reasonCodes: HosReasonCode[];
  explanation: string;
};

const DAY_BOUND: readonly LimitKey[] = ["daily_drive_minutes", "daily_on_duty_minutes"];
/**
 * Rest requirements: a figure that says how much rest is owed, not how much work is allowed. The
 * engine counts rest but implements no rule about what rest satisfies what, so these stay UNKNOWN
 * and are named as undetermined rest rather than as an unverified figure.
 */
const REST_RULES: readonly LimitKey[] = [
  "daily_off_duty_minutes", "core_rest_minutes", "cycle_1_reset_minutes", "cycle_2_reset_minutes",
  "mandatory_rest_within_days", "mandatory_rest_minutes", "break_minutes", "reduced_rest_floor_minutes",
];
/** Pure parameters: consumed by the clocks when verified, never compared against a clock. */
const PARAMETERS: readonly LimitKey[] = ["cycle_1_days", "cycle_2_days"];
const CYCLE_BOUND: readonly LimitKey[] = ["cycle_1_on_duty_minutes", "cycle_2_on_duty_minutes", "cycle_2_interim_on_duty_minutes"];
const SHIFT_BOUND: readonly LimitKey[] = ["shift_drive_minutes", "shift_on_duty_minutes", "shift_elapsed_minutes"];

const EXCEEDED_CODE: Partial<Record<LimitKey, HosReasonCode>> = {
  daily_drive_minutes: "HOS_DRIVING_LIMIT_EXCEEDED", shift_drive_minutes: "HOS_DRIVING_LIMIT_EXCEEDED",
  daily_on_duty_minutes: "HOS_ON_DUTY_LIMIT_EXCEEDED", shift_on_duty_minutes: "HOS_ON_DUTY_LIMIT_EXCEEDED",
  shift_elapsed_minutes: "HOS_SHIFT_WINDOW_EXCEEDED",
  cycle_1_on_duty_minutes: "HOS_CYCLE_LIMIT_EXCEEDED", cycle_2_on_duty_minutes: "HOS_CYCLE_LIMIT_EXCEEDED", cycle_2_interim_on_duty_minutes: "HOS_CYCLE_LIMIT_EXCEEDED",
  break_required_after_drive_minutes: "HOS_BREAK_REQUIRED",
};

const verifiedFigure = (p: HosRuleProfile | null, k: LimitKey): number | undefined =>
  p && p.verificationStatus === "verified" ? p.limits.find(l => l.limitKey === k && l.verificationStatus === "verified")?.value : undefined;

const uniq = <T>(xs: T[]) => Array.from(new Set(xs));

/** Downgrade one determination when its meaning depends on a boundary the mechanics cannot vouch for. */
function applyMechanics(d: LimitDetermination, shiftBoundaryVerified: boolean, dayDesignated: boolean): { d: LimitDetermination; code: HosReasonCode | null; why: string | null } {
  if (d.result === "unknown") return { d, code: null, why: null };
  const label = LIMIT_LABELS[d.limitKey];
  const downgrade = (code: HosReasonCode, why: string) => ({
    d: { ...d, result: "unknown" as const, limitMinutes: null, remainingMinutes: null, reason: `${label}: ${d.usedMinutes ?? "—"} min counted; ${why}` },
    code, why,
  });
  if (DAY_BOUND.includes(d.limitKey)) {
    return dayDesignated
      ? downgrade("HOS_DAY_RULE_UNVERIFIED", "the figure is verified and the operator's duty day is designated, but no verified rule says this regime counts the limit over that day — the counted figure is a rolling 24 hours, and the designated day's clocks are shown beside it")
      : downgrade("HOS_DAY_BOUNDARY_UNKNOWN", "the figure is verified but the duty day it is counted in is not defined — the clock is a rolling 24 hours, not a regime's day");
  }
  if (CYCLE_BOUND.includes(d.limitKey)) return downgrade("HOS_MECHANICS_DEFAULTED", "the figure is verified but the cycle is counted over rolling days, not the regime's cycle days");
  if (SHIFT_BOUND.includes(d.limitKey) && !shiftBoundaryVerified) return downgrade("HOS_MECHANICS_DEFAULTED", "the figure is verified but the rest that ends a shift is not, so where this shift began is a default");
  return { d, code: null, why: null };
}

export function evaluateHos(input: HosEngineInput): HosEngineResult {
  const projection = projectDutyEntries(input.operatorId, input.events);
  const selection = selectProfile(input.context, input.profiles);
  const profile = selection.outcome === "selected" ? selection.profile : null;

  const coreRest = verifiedFigure(profile, "core_rest_minutes");
  const clocks = computeClocks(projection.entries, input.at, {
    shiftResetMinutes: coreRest,
    cycle1Days: verifiedFigure(profile, "cycle_1_days"),
    cycle2Days: verifiedFigure(profile, "cycle_2_days"),
    mandatoryRestMinutes: verifiedFigure(profile, "mandatory_rest_minutes"),
  });
  const raw = determine(clocks, profile);

  const reasonCodes: HosReasonCode[] = [...projection.reasonCodes];
  const violations: HosFinding[] = [];
  const unknowns: HosFinding[] = [];
  const ruleId = (k: LimitKey) => (profile ? `${profile.profileKey}:${k}` : null);

  if (selection.outcome === "unknown") reasonCodes.push("HOS_PROFILE_UNKNOWN");
  if (selection.outcome === "conflict") reasonCodes.push("HOS_PROFILE_CONFLICT");
  if (profile && !profile.limits.length) reasonCodes.push("HOS_LIMIT_NOT_STATED");
  reasonCodes.push("HOS_MECHANICS_DEFAULTED");

  // The designated day, when there is one the runtime can still place. A zone the database no longer
  // knows is reported as an unknown zone, never replaced by UTC or by the server's own zone.
  let dutyDay: HosEngineResult["dutyDay"] = null;
  if (input.dutyDay) {
    try {
      const c = dutyDayClocks(projection.entries, input.at, input.dutyDay);
      const eff = input.dutyDay.effectiveFrom ?? null;
      dutyDay = { ...c, designationRef: input.dutyDay.designationRef ?? null, designationEffectiveFrom: eff, designationChangedDuringDay: eff != null && eff.getTime() > c.window.from.getTime() };
    } catch {
      dutyDay = null;
    }
  }
  if (!dutyDay) reasonCodes.push("HOS_TIMEZONE_UNKNOWN");

  // A verified parameter was consumed by the clocks; it is not a limit anyone can be within or over.
  const consumedParameters = raw.determinations.filter(d => PARAMETERS.includes(d.limitKey) && d.limitMinutes != null).map(d => d.limitKey);
  const determinations = raw.determinations.filter(d => !consumedParameters.includes(d.limitKey)).map(d0 => {
    const { d, code } = applyMechanics(d0, coreRest != null, dutyDay != null);
    if (code) reasonCodes.push(code);
    if (d.result === "exceeded") {
      violations.push({ code: EXCEEDED_CODE[d.limitKey] ?? "HOS_ON_DUTY_LIMIT_EXCEEDED", limitKey: d.limitKey, ruleId: ruleId(d.limitKey), usedMinutes: d.usedMinutes, limitMinutes: d.limitMinutes, explanation: d.reason });
    } else if (d.result === "unknown") {
      // Why, in the order a verifier would fix it: the figure first, then what the engine lacks.
      const why: HosReasonCode = code
        ?? (d0.limitMinutes == null ? "HOS_LIMIT_UNVERIFIED"
          : REST_RULES.includes(d.limitKey) ? "HOS_REQUIRED_REST_UNDETERMINED"
          : "HOS_CLOCK_NOT_COMPUTED");
      if (!code) reasonCodes.push(why);
      unknowns.push({ code: why, limitKey: d.limitKey, ruleId: ruleId(d.limitKey), usedMinutes: d.usedMinutes, limitMinutes: null, explanation: d.reason });
    }
    return d;
  });

  const exceededCount = determinations.filter(d => d.result === "exceeded").length;
  const unknownCount = determinations.filter(d => d.result === "unknown").length;
  // Exceeded beats unknown, and nothing rounds unknown to within — the same ladder `determine` uses.
  const verdict: HosEngineResult["verdict"] =
    exceededCount > 0 ? "exceeded" : !profile || !determinations.length || unknownCount > 0 || !projection.entries.length ? "unknown" : "within";
  if (verdict === "within") reasonCodes.push("HOS_WITHIN_LIMITS");

  const determination: HosDetermination = {
    ...raw, determinations, exceededCount, unknownCount,
    verdict: exceededCount > 0 ? "exceeded" : unknownCount > 0 || !determinations.length ? "unknown" : "within",
    explanation: raw.explanation,
  };

  // Remaining: the smallest verified remaining figure per clock family, never computed from a downgraded one.
  const remainingOf = (keys: LimitKey[]) => {
    const ds = determinations.filter(d => keys.includes(d.limitKey) && d.result !== "unknown" && d.remainingMinutes != null);
    return ds.length ? { minutes: Math.min(...ds.map(d => d.remainingMinutes!)), ids: ds.map(d => ruleId(d.limitKey)!).filter(Boolean) } : { minutes: null, ids: [] as string[] };
  };
  const drv = remainingOf(["daily_drive_minutes", "shift_drive_minutes"]);
  const onDuty = remainingOf(["daily_on_duty_minutes", "shift_on_duty_minutes"]);
  const shiftWin = remainingOf(["shift_elapsed_minutes"]);
  const cyc = remainingOf(["cycle_1_on_duty_minutes", "cycle_2_on_duty_minutes", "cycle_2_interim_on_duty_minutes"]);

  // Required rest is a regime mechanic (what rest, how long, what it resets). None is verified here.
  reasonCodes.push("HOS_REQUIRED_REST_UNDETERMINED");

  if (input.chainGaps?.length) {
    const from = projection.entries[0]?.startedAt ?? input.at;
    const overlaps = input.chainGaps.some(g => (g.toAt == null || g.toAt.getTime() >= from.getTime()) && (g.fromAt == null || g.fromAt.getTime() <= input.at.getTime()));
    if (overlaps) reasonCodes.push("HOS_DATA_GAP");
  }

  const codes = uniq(reasonCodes);
  const explanation =
    verdict === "exceeded" ? `${violations.length} verified limit(s) exceeded: ${violations.map(v => v.explanation).join("; ")}`
    : verdict === "within" ? `Within every limit that can be determined under ${profile!.profileKey}.`
    : !projection.entries.length ? "The ledger holds no duty status for this operator; no hours-of-service determination is made."
    : !profile ? `No schedule is selected (${selection.outcome}): ${selection.reasons.join("; ")}. The clocks are shown; the compliance answer is UNKNOWN.`
    : `${unknownCount} limit(s) under ${profile.profileKey} cannot be determined: ${uniq(unknowns.map(u => u.code)).join(", ")}. The clocks are shown; the compliance answer is UNKNOWN.`;

  return {
    engineVersion: HOS_ENGINE_VERSION, at: input.at, operatorId: input.operatorId, mechanicsKey: DEFAULT_MECHANICS,
    selection, projection, clocks, determination,
    currentStatus: clocks.currentStatus, timeInCurrentStatusMinutes: clocks.currentStatusMinutes, dutyDay,
    remaining: { drivingMinutes: drv.minutes, onDutyMinutes: onDuty.minutes, shiftWindowMinutes: shiftWin.minutes, cycleMinutes: cyc.minutes, basisRuleIds: uniq([...drv.ids, ...onDuty.ids, ...shiftWin.ids, ...cyc.ids]) },
    violations, unknowns, verdict, reasonCodes: codes, explanation,
  };
}
