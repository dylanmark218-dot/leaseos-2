/**
 * B28E — presenting an HOS clock without inventing a compliance answer.
 *
 * Pure. No rule tables, no profile selector, no arithmetic against a limit.
 *
 * `hos.status` returns sixteen elapsed clocks. Thirteen are measured from duty
 * records; three depend on where the shift began, and `hos.status` falls back
 * to eight hours of rest when no verified `core_rest_minutes` applies — saying
 * so in `shiftBasis`.
 *
 * The type has no `remainingMinutes` field. Not omitted by discipline —
 * absent, so no presentation code can populate one. Remaining is
 * `limit − elapsed`, the limit is a `hosRuleLimits` row that may be unverified,
 * and that subtraction is a compliance determination the domain owns.
 */

export type HosClockKey =
  | "continuousDriveMinutes" | "dailyDriveMinutes" | "dailyOnDutyMinutes"
  | "dailyOffDutyMinutes" | "dailySleeperMinutes" | "shiftDriveMinutes"
  | "shiftOnDutyMinutes" | "shiftElapsedMinutes" | "lastRestMinutes"
  | "longestRestInCycle1Minutes" | "longestRestInCycle2Minutes"
  | "cycle1OnDutyMinutes" | "cycle2OnDutyMinutes" | "sinceMandatoryRestHours"
  | "currentStatusMinutes";

/**
 * How far the value can be trusted.
 *
 * Maps onto the existing payload provenance rather than adding a global state:
 * CONFIRMED_ELAPSED → `verification: "verified"`, UNVERIFIED_ELAPSED →
 * `"unverified"`, UNKNOWN → the `unknown` payload state.
 */
export type ClockConfidence = "CONFIRMED_ELAPSED" | "UNVERIFIED_ELAPSED" | "UNKNOWN";

export type HosClockPresentation = {
  clockKey: HosClockKey;
  label: string;
  /** Null means the engine could not compute it — not zero. */
  elapsedMinutes: number | null;
  confidence: ClockConfidence;
  /** What the window rests on. Present whenever it is anything but measured. */
  basis: string;
  asOf: Date;
  /** Shown to the reader whenever confidence is not CONFIRMED_ELAPSED. */
  explanation: string;
};

/** Clocks whose window depends on the shift boundary. */
export const SHIFT_DERIVED: readonly HosClockKey[] = [
  "shiftElapsedMinutes", "shiftDriveMinutes", "shiftOnDutyMinutes",
];

const LABELS: Readonly<Record<HosClockKey, string>> = {
  continuousDriveMinutes: "Driving without a break",
  dailyDriveMinutes: "Driving today",
  dailyOnDutyMinutes: "On duty today",
  dailyOffDutyMinutes: "Off duty today",
  dailySleeperMinutes: "Sleeper today",
  shiftDriveMinutes: "Driving this shift",
  shiftOnDutyMinutes: "On duty this shift",
  shiftElapsedMinutes: "Shift elapsed",
  lastRestMinutes: "Last rest",
  longestRestInCycle1Minutes: "Longest rest, cycle 1",
  longestRestInCycle2Minutes: "Longest rest, cycle 2",
  cycle1OnDutyMinutes: "On duty, cycle 1",
  cycle2OnDutyMinutes: "On duty, cycle 2",
  sinceMandatoryRestHours: "Since mandatory rest",
  currentStatusMinutes: "Time in current status",
};

/**
 * Labels that assert a legal conclusion. Refused at construction.
 *
 * Every one of these was a plausible tile title at some point in B23–B27, and
 * none is supported by a source that returns elapsed time.
 */
export const FORBIDDEN_LABELS: readonly string[] = [
  "hours remaining", "legal hours left", "safe to drive", "compliant",
  "reset available", "time left", "remaining",
];

export type ClockInputs = {
  clockKey: HosClockKey;
  elapsedMinutes: number | null;
  asOf: Date;
  /** True when `shiftBasis` names a default rather than a verified figure. */
  shiftBasisIsDefault: boolean;
  /** The engine's own sentence, carried verbatim. */
  shiftBasis?: string;
};

/**
 * Build the presentation for one clock.
 *
 * A shift-derived clock can never be CONFIRMED_ELAPSED while its boundary is a
 * default — a verified badge over an assumed window is exactly the misleading
 * green tile this checkpoint exists to prevent.
 */
export function presentClock(input: ClockInputs): HosClockPresentation {
  const label = LABELS[input.clockKey];
  const shiftDerived = SHIFT_DERIVED.includes(input.clockKey);

  if (input.elapsedMinutes === null) {
    return {
      clockKey: input.clockKey, label, elapsedMinutes: null, confidence: "UNKNOWN",
      basis: "not computed", asOf: input.asOf,
      // Null is not zero. "Since mandatory rest: 0m" would claim a rest just
      // happened; the engine is saying it does not know.
      explanation: "the engine did not produce this clock",
    };
  }

  if (shiftDerived && input.shiftBasisIsDefault) {
    return {
      clockKey: input.clockKey, label, elapsedMinutes: input.elapsedMinutes,
      confidence: "UNVERIFIED_ELAPSED",
      basis: input.shiftBasis ?? "default shift boundary",
      asOf: input.asOf,
      explanation: input.shiftBasis
        ?? "the shift boundary is a default because no verified core-rest figure applies",
    };
  }

  return {
    clockKey: input.clockKey, label, elapsedMinutes: input.elapsedMinutes,
    confidence: "CONFIRMED_ELAPSED", basis: "measured from duty records",
    asOf: input.asOf, explanation: "",
  };
}

/** A label a tile may not carry. Used by a guard test and by the picker. */
export const labelAssertsCompliance = (label: string): boolean =>
  FORBIDDEN_LABELS.some((f) => label.toLowerCase().includes(f));
