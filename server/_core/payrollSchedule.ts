/**
 * Payroll P2 — pay schedules and the pay-period machine, pure.
 *
 * Periods are calendar facts. A schedule generates them on dates, half-open [start, end), the same contract as
 * compensation versions (0226): inclusive start, exclusive end. Nothing here reads a clock or a server timezone;
 * the schedule's own zone is applied only when a caller derives instants for the legacy columns.
 *
 * The machine runs over the existing `payPeriods.state` enum, with `voided` added by 0227:
 *
 *   draft ─► collecting (OPEN) ─► review (REVIEWING) ─► approved (APPROVED, locked) ─► processing ─► closed (FINALIZED) ─► amended (CORRECTED)
 *     │            │                  │                       │
 *     └► voided ◄──┘                  └► collecting           └► review   (reopen, with a reason)
 *
 * `paid` remains for rows older code wrote and reads as FINALIZED; it may only move to `amended`.
 */
import { PAY_FREQUENCIES } from "../../drizzle/schema";

export type PayFrequency = (typeof PAY_FREQUENCIES)[number];
export type DateText = string;
export const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* Calendar arithmetic on YYYY-MM-DD, in UTC so no host zone leaks in  */
/* ------------------------------------------------------------------ */

const toUtc = (d: DateText) => { const [y, m, day] = d.split("-").map(Number); return Date.UTC(y!, m! - 1, day!); };
const fromUtc = (ms: number): DateText => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: DateText, n: number): DateText => fromUtc(toUtc(d) + n * 86_400_000);
export const dayOfMonth = (d: DateText) => Number(d.slice(8, 10));
/** Same day-of-month, n months later. Only called with days 1–28, so it never overflows a short month. */
export function addMonths(d: DateText, n: number): DateText {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1 + n, day!));
  return t.toISOString().slice(0, 10);
}
export const isDateText = (d: unknown): d is DateText => typeof d === "string" && DATE_TEXT.test(d) && fromUtc(toUtc(d)) === d;

export function isValidTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(0); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

export type ScheduleSpec = {
  frequency: PayFrequency;
  anchorDate: DateText;
  periodLengthDays?: number | null;
  paymentLagDays: number;
  cutoffLagDays: number;
  timezone: string;
};

/** Refuse a schedule that cannot generate a well-formed calendar. Every refusal is by name. */
export function validateSchedule(s: ScheduleSpec): string[] {
  const e: string[] = [];
  if (!isDateText(s.anchorDate)) e.push("anchorDate must be a real calendar date, YYYY-MM-DD");
  if (!isValidTimeZone(s.timezone)) e.push(`timezone "${s.timezone}" is not a recognised IANA zone`);
  if (!Number.isInteger(s.paymentLagDays) || s.paymentLagDays < 0 || s.paymentLagDays > 60) e.push("paymentLagDays must be an integer from 0 to 60");
  if (!Number.isInteger(s.cutoffLagDays) || s.cutoffLagDays < -14 || s.cutoffLagDays > 60) e.push("cutoffLagDays must be an integer from -14 to 60");
  if (s.cutoffLagDays > s.paymentLagDays) e.push("the cutoff cannot fall after the payment date");
  if (s.frequency === "custom") {
    if (!Number.isInteger(s.periodLengthDays) || s.periodLengthDays! < 1 || s.periodLengthDays! > 62) e.push("a custom schedule needs periodLengthDays from 1 to 62");
  } else if (s.periodLengthDays != null) {
    e.push(`periodLengthDays applies only to a custom schedule, not ${s.frequency}`);
  }
  if (isDateText(s.anchorDate)) {
    if (s.frequency === "semi_monthly" && ![1, 16].includes(dayOfMonth(s.anchorDate))) e.push("a semi-monthly schedule is anchored on a 1st or a 16th");
    if (s.frequency === "monthly" && dayOfMonth(s.anchorDate) > 28) e.push("a monthly schedule is anchored on day 1–28, so every month has the day");
  }
  return e;
}

export type GeneratedPeriod = { start: DateText; end: DateText; lastDay: DateText; paymentDate: DateText; cutoffDate: DateText };

/** The k-th period of a schedule (k ≥ 0), [start, end). */
export function periodAt(s: ScheduleSpec, k: number): { start: DateText; end: DateText } {
  switch (s.frequency) {
    case "weekly": return { start: addDays(s.anchorDate, 7 * k), end: addDays(s.anchorDate, 7 * (k + 1)) };
    case "biweekly": return { start: addDays(s.anchorDate, 14 * k), end: addDays(s.anchorDate, 14 * (k + 1)) };
    case "custom": { const n = s.periodLengthDays!; return { start: addDays(s.anchorDate, n * k), end: addDays(s.anchorDate, n * (k + 1)) }; }
    case "monthly": return { start: addMonths(s.anchorDate, k), end: addMonths(s.anchorDate, k + 1) };
    case "semi_monthly": {
      // Half-month index from the anchor: anchored on the 1st, even halves are [1st,16th); on the 16th, they are [16th,1st).
      const firstHalf = dayOfMonth(s.anchorDate) === 1;
      const monthStart = addMonths(`${s.anchorDate.slice(0, 8)}01`, Math.floor((k + (firstHalf ? 0 : 1)) / 2));
      const isFirstHalf = (k + (firstHalf ? 0 : 1)) % 2 === 0;
      return isFirstHalf
        ? { start: monthStart, end: `${monthStart.slice(0, 8)}16` }
        : { start: `${monthStart.slice(0, 8)}16`, end: addMonths(monthStart, 1) };
    }
  }
}

/**
 * Every period of the schedule that has started by `through` and has not ended by `from` (default: the anchor),
 * oldest first, at most `max`. Deterministic: the same schedule and bounds give the same list, so generating twice
 * is a no-op once the rows exist.
 */
export function generatePeriods(s: ScheduleSpec, bounds: { from?: DateText; through: DateText; max: number }): GeneratedPeriod[] {
  const out: GeneratedPeriod[] = [];
  const from = bounds.from ?? s.anchorDate;
  for (let k = 0; k < 5000 && out.length < bounds.max; k++) {
    const { start, end } = periodAt(s, k);
    if (start > bounds.through) break;
    if (end <= from) continue;
    const lastDay = addDays(end, -1);
    out.push({ start, end, lastDay, paymentDate: addDays(lastDay, s.paymentLagDays), cutoffDate: addDays(lastDay, s.cutoffLagDays) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The pay-period machine                                              */
/* ------------------------------------------------------------------ */

export type PayPeriodState = "draft" | "collecting" | "review" | "approved" | "processing" | "paid" | "closed" | "amended" | "voided";

export const PERIOD_STATE_LABEL: Record<PayPeriodState, string> = {
  draft: "DRAFT", collecting: "OPEN", review: "REVIEWING", approved: "APPROVED", processing: "PROCESSING",
  paid: "FINALIZED", closed: "FINALIZED", amended: "CORRECTED", voided: "VOIDED",
};

const PERIOD_TRANSITIONS: Record<PayPeriodState, PayPeriodState[]> = {
  draft: ["collecting", "voided"],
  collecting: ["review", "voided"],
  review: ["approved", "collecting"],
  approved: ["processing", "review"],
  processing: ["closed"],
  closed: ["amended"],
  paid: ["amended"],
  amended: [],
  voided: [],
};

export function canTransitionPeriod(from: PayPeriodState, to: PayPeriodState): boolean {
  return PERIOD_TRANSITIONS[from].includes(to);
}

/** Earnings are proposed only into an OPEN period; the run may still collect while it is under review. */
export const periodAcceptsEarnings = (s: PayPeriodState) => s === "collecting";
export const periodAcceptsRuns = (s: PayPeriodState) => s === "collecting" || s === "review";
/** Locked: nothing new may be written against the period. */
export const periodIsLocked = (s: PayPeriodState) => !(s === "draft" || s === "collecting" || s === "review");

export type Readiness = { ready: boolean; reasons: string[] };

/** Approving the period freezes it: no run may still be gathering lines. */
export function approveReadiness(runStates: readonly string[]): Readiness {
  const open = runStates.filter(s => s === "draft" || s === "collecting");
  return open.length ? { ready: false, reasons: [`${open.length} pay run(s) on this period are still ${Array.from(new Set(open)).join("/")}; submit them for review first`] } : { ready: true, reasons: [] };
}

/** Finalizing the period means every run on it has been paid. */
export function finalizeReadiness(runStates: readonly string[]): Readiness {
  const unpaid = runStates.filter(s => !(s === "paid" || s === "closed" || s === "amended"));
  return unpaid.length ? { ready: false, reasons: [`${unpaid.length} pay run(s) on this period are not paid yet (${Array.from(new Set(unpaid)).join(", ")})`] } : { ready: true, reasons: [] };
}

/** A period may be voided only while nothing has been recorded against it. */
export function voidReadiness(args: { runCount: number; earningCount: number; timeEntryCount?: number }): Readiness {
  const reasons: string[] = [];
  if (args.runCount) reasons.push(`${args.runCount} pay run(s) reference this period`);
  if (args.earningCount) reasons.push(`${args.earningCount} earning(s) reference this period`);
  // P3 — submitted time is a worker's claim on the period; voiding it would orphan the claim.
  if (args.timeEntryCount) reasons.push(`${args.timeEntryCount} time entr${args.timeEntryCount === 1 ? "y" : "ies"} reference this period`);
  return { ready: reasons.length === 0, reasons };
}
