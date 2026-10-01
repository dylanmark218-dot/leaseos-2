/**
 * B23.2 — Scheduling Intelligence: one answer for dispatch, composed and cited.
 *
 * Pure. No network, no database.
 *
 * The sentence this module exists to produce:
 *
 *   "Dylan and Unit 147 are available for this job from 06:00, but the driver's remaining
 *    hours of service mean the projected job cannot finish before the duty window ends."
 *
 * Every clause of it comes from an engine that already exists and already decides: the
 * availability read (calendarEvents), the HOS determination (hos), dispatch bookings, and the
 * readiness composer. This module decides none of those things again. It reads what they said,
 * puts the findings side by side, and states the composite verdict with each line naming the
 * engine it came from — so a dispatcher who disagrees knows which record to go and look at.
 *
 * Three rules, the same ones the rest of the tree runs on:
 *
 *   **UNKNOWN never rounds to feasible.** No HOS determination, an unverified rule, a person
 *   with no rotation and no booking — each is an unknown finding, and one unknown makes the
 *   composite UNKNOWN unless something else already blocks it. A dispatcher would rather hear
 *   "we cannot say" than a confident answer built on a rule nobody checked.
 *
 *   **A projection is labelled as one.** The end of a duty window is arithmetic on a clock the
 *   HOS engine read at a moment; it is stated with that moment and the word "projected".
 *
 *   **This is advice, not an award.** A FEASIBLE verdict is a reason to look, never an
 *   assignment: dispatch assigns, and the readiness gate runs then, on that moment's facts.
 */

import type { AvailabilityResult, AvailabilityStatus } from "./calendarEvents";
import { tripFeasibility, type HosDetermination } from "./hos";
import type { EligibilityVerdict } from "./dispatchReadiness";

export type FindingEngine = "calendar" | "hos" | "dispatch" | "readiness";
export type FindingState = "ok" | "review" | "block" | "unknown";

export type Finding = {
  engine: FindingEngine;
  state: FindingState;
  /** One sentence a dispatcher reads; it names what was found, never a score. */
  line: string;
  /** The reference to go and look at, when the engine supplied one. */
  ref: string | null;
  /** Where tapping the finding goes. Derived from the reference, never typed by hand; null when there is nowhere to go. */
  deepLink: string | null;
};

/**
 * The screen a reference opens. Derived the way calendarProjection derives its links: from the
 * reference's kind, so a wrong link traces to one rule. `hos.status:<op>@<at>` opens the HOS
 * console; `dispatch.readiness:<op>/<unit>` the readiness panel; a record type opens the work
 * calendar, where the window is shown and the record itself only to those who may read it.
 */
export function linkFor(ref: string | null): string | null {
  if (!ref) return null;
  if (ref.startsWith("hos.status:")) return "/hos-verification";
  if (ref.startsWith("dispatch.readiness:")) return null;   // the finding is already on that panel
  if (ref === "calendarEvent" || ref === "leaveRequest" || ref === "crewMember") return "/work";
  if (ref.startsWith("resourceBooking")) return "/work";
  return null;
}

export type ScheduleVerdict = "FEASIBLE" | "FEASIBLE_WITH_REVIEW" | "NOT_FEASIBLE" | "UNKNOWN";

export type ScheduleWindow = { from: Date; to: Date };

export type HosFacts = {
  determination: HosDetermination;
  /** When the clocks were read. The projection is only as current as this. */
  asOf: Date;
  ref: string;
};

export type ReadinessFacts = {
  verdict: EligibilityVerdict;
  blockers: readonly { code: string; label: string; severity: "blocking" | "review" | "unknown" }[];
  ref: string;
};

export type ScheduleInput = {
  candidate: { userId: number; label: string };
  unit: { unitId: number; label: string } | null;
  window: ScheduleWindow;
  /** How long the job is expected to take from its start, in minutes. Dispatch's estimate. */
  estimatedDurationMinutes: number;
  /** How much of it is driving. Null when dispatch has no estimate; the driving check then reads unknown. */
  estimatedDriveMinutes: number | null;
  availability: AvailabilityResult;
  /** Dispatch's bookings of the unit itself, from the dispatch context. Taken for the unit the way a person's booking is taken for them. */
  unitBookings?: readonly { from: Date; to: Date; ref: string }[];
  hos: HosFacts | null;
  readiness: ReadinessFacts | null;
  now: Date;
};

export type ScheduleAssessment = {
  candidate: ScheduleInput["candidate"];
  unit: ScheduleInput["unit"];
  window: ScheduleWindow;
  verdict: ScheduleVerdict;
  /** The earliest instant in the window nothing on the calendar takes, or null when the window is spoken for. */
  availableFrom: Date | null;
  /** The projected end of the duty window, from the HOS clocks, when a verified limit gave one. */
  dutyWindowEndsAt: Date | null;
  findings: Finding[];
  /** The composite sentence, built from the findings and citing nothing they do not. */
  summary: string;
  note: string;
};

const WINDOW_LIMITS = ["shift_elapsed_minutes", "daily_on_duty_minutes", "shift_on_duty_minutes"] as const;

const fmt = (d: Date) => d.toISOString().slice(11, 16) + "Z";
const finding = (f: Omit<Finding, "deepLink">): Finding => ({ ...f, deepLink: linkFor(f.ref) });

/* ------------------------------------------------------------------ */
/* The calendar                                                         */
/* ------------------------------------------------------------------ */

/** The first instant in the window not covered by an UNAVAILABLE or ASSIGNED span. */
export function earliestFree(window: ScheduleWindow, spans: readonly { from: Date; to: Date; status: AvailabilityStatus }[]): Date | null {
  const taken = spans.filter(s => s.status === "UNAVAILABLE" || s.status === "ASSIGNED").sort((a, b) => a.from.getTime() - b.from.getTime());
  let cursor = window.from.getTime();
  for (const s of taken) {
    if (s.to.getTime() <= cursor) continue;
    if (s.from.getTime() > cursor) break;
    cursor = s.to.getTime();
  }
  return cursor < window.to.getTime() ? new Date(cursor) : null;
}

function calendarFindings(input: ScheduleInput): { findings: Finding[]; availableFrom: Date | null } {
  const a = input.availability;
  const unitSpans = (input.unitBookings ?? [])
    .filter(b => b.from.getTime() < input.window.to.getTime() && b.to.getTime() > input.window.from.getTime())
    .map(b => ({ from: new Date(Math.max(b.from.getTime(), input.window.from.getTime())), to: new Date(Math.min(b.to.getTime(), input.window.to.getTime())), status: "ASSIGNED" as const, basis: `resourceBooking:unit:${b.ref}` }));
  const availableFrom = earliestFree(input.window, [...a.windows, ...unitSpans]);
  const findings: Finding[] = [];
  const taken = [...a.windows.filter(w => w.status === "UNAVAILABLE" || w.status === "ASSIGNED"), ...unitSpans].sort((x, y) => x.from.getTime() - y.from.getTime());
  // A taken span narrows the window; it blocks only when what is left cannot hold the job.
  for (const w of taken) {
    findings.push(finding({
      engine: w.status === "ASSIGNED" ? "dispatch" : "calendar",
      state: "review",
      line: w.basis.startsWith("resourceBooking:unit:")
        ? `${input.unit?.label ?? "The unit"} is already booked ${fmt(w.from)}–${fmt(w.to)} (${w.basis}).`
        : w.status === "ASSIGNED"
        ? `Already booked ${fmt(w.from)}–${fmt(w.to)} (${w.basis}).`
        : `Unavailable ${fmt(w.from)}–${fmt(w.to)} (${w.basis}); what for is not part of this answer.`,
      ref: w.basis,
    }));
  }
  if (availableFrom === null) {
    findings.push(finding({ engine: "calendar", state: "block", line: "The whole window is spoken for.", ref: null }));
    return { findings, availableFrom };
  }
  const projectedEnd = availableFrom.getTime() + input.estimatedDurationMinutes * 60_000;
  const nextTaken = taken.find(w => w.from.getTime() > availableFrom.getTime());
  const room = Math.min(input.window.to.getTime(), nextTaken?.from.getTime() ?? Infinity);
  if (projectedEnd > room) {
    findings.push(finding({ engine: nextTaken?.status === "ASSIGNED" && nextTaken.from.getTime() < input.window.to.getTime() ? "dispatch" : "calendar", state: "block", line: `Free from ${fmt(availableFrom)}, but a ${input.estimatedDurationMinutes} min job does not fit before ${fmt(new Date(room))}${nextTaken && nextTaken.from.getTime() <= input.window.to.getTime() ? ` (${nextTaken.basis})` : " (the end of the window)"}.`, ref: nextTaken?.basis ?? null }));
    return { findings, availableFrom };
  }
  switch (a.status) {
    case "UNKNOWN":
      findings.push(finding({ engine: "calendar", state: "unknown", line: "No rotation, duty record or booking covers this window; nobody has established that this person is working.", ref: null }));
      break;
    case "OFF_DUTY":
      findings.push(finding({ engine: "calendar", state: "review", line: "Rostered off for this window; asking them in is a decision, not a default.", ref: null }));
      break;
    case "AVAILABLE":
    case "ON_DUTY":
      findings.push(finding({ engine: "calendar", state: "ok", line: `Rostered and free from ${fmt(availableFrom)}.`, ref: null }));
      break;
    case "UNAVAILABLE":
    case "ASSIGNED":
      // Partly taken: the spans above say where; what is left is stated here.
      findings.push(finding({ engine: "calendar", state: "review", line: `Free from ${fmt(availableFrom)}; earlier in the window is taken.`, ref: null }));
      break;
  }
  return { findings, availableFrom };
}

/* ------------------------------------------------------------------ */
/* Hours of service                                                     */
/* ------------------------------------------------------------------ */

function hosFindings(input: ScheduleInput, startAt: Date | null): { findings: Finding[]; dutyWindowEndsAt: Date | null } {
  const findings: Finding[] = [];
  if (!input.hos) {
    findings.push(finding({ engine: "hos", state: "unknown", line: "No hours-of-service determination was read for this person.", ref: null }));
    return { findings, dutyWindowEndsAt: null };
  }
  const { determination: d, asOf, ref } = input.hos;
  if (d.verdict === "exceeded") {
    findings.push(finding({ engine: "hos", state: "block", line: `Hours of service: ${d.explanation}`, ref }));
    return { findings, dutyWindowEndsAt: null };
  }
  if (d.verdict === "unknown") {
    findings.push(finding({ engine: "hos", state: "unknown", line: `Hours of service: ${d.explanation}`, ref }));
    return { findings, dutyWindowEndsAt: null };
  }
  // Within every verified limit. Project the duty window's end from the tightest window clock.
  const windows = d.determinations.filter(x => (WINDOW_LIMITS as readonly string[]).includes(x.limitKey) && x.result === "within" && x.remainingMinutes != null);
  let dutyWindowEndsAt: Date | null = null;
  if (windows.length) {
    const tightest = windows.reduce((a, b) => (a.remainingMinutes! <= b.remainingMinutes! ? a : b));
    dutyWindowEndsAt = new Date(asOf.getTime() + tightest.remainingMinutes! * 60_000);
    const start = startAt ?? input.window.from;
    const projectedEnd = new Date(start.getTime() + input.estimatedDurationMinutes * 60_000);
    if (projectedEnd.getTime() > dutyWindowEndsAt.getTime()) {
      const short = Math.round((projectedEnd.getTime() - dutyWindowEndsAt.getTime()) / 60_000);
      findings.push(finding({ engine: "hos", state: "block", line: `The remaining hours of service (${tightest.limitKey.replace(/_/g, " ")}: ${Math.round(tightest.remainingMinutes!)} min as of ${fmt(asOf)}) mean the projected job cannot finish before the duty window ends at ${fmt(dutyWindowEndsAt)} — short by ${short} min. Projected from the clock, not a determination.`, ref }));
    } else {
      findings.push(finding({ engine: "hos", state: "ok", line: `Duty window projected to end ${fmt(dutyWindowEndsAt)} (${tightest.limitKey.replace(/_/g, " ")}, as of ${fmt(asOf)}); the job is projected to finish ${fmt(projectedEnd)}.`, ref }));
    }
  } else {
    findings.push(finding({ engine: "hos", state: "unknown", line: "Within every verified limit, but no verified window limit gives a duty-window end to project from.", ref }));
  }
  if (input.estimatedDriveMinutes != null) {
    const f = tripFeasibility(d, input.estimatedDriveMinutes);
    findings.push(finding({
      engine: "hos",
      state: f.feasible === "yes" ? "ok" : f.feasible === "no" ? "block" : "unknown",
      line: `Driving: ${f.reasons[0]}`,
      ref,
    }));
  } else {
    findings.push(finding({ engine: "hos", state: "unknown", line: "Driving: dispatch gave no driving estimate, so the driving limit was not compared.", ref }));
  }
  return { findings, dutyWindowEndsAt };
}

/* ------------------------------------------------------------------ */
/* Equipment and the person, from the readiness composer                */
/* ------------------------------------------------------------------ */

function readinessFindings(input: ScheduleInput): Finding[] {
  if (!input.unit) return [finding({ engine: "readiness", state: "unknown", line: "No unit named; equipment readiness was not evaluated.", ref: null })];
  if (!input.readiness) return [finding({ engine: "readiness", state: "unknown", line: `Readiness for ${input.unit.label} was not read.`, ref: null })];
  const r = input.readiness;
  const named = r.blockers.slice(0, 4).map(b => b.label).join("; ");
  switch (r.verdict) {
    case "blocked": return [finding({ engine: "readiness", state: "block", line: `${input.unit.label} with ${input.candidate.label}: blocked — ${named || "see the readiness panel"}.`, ref: r.ref })];
    case "eligible_review": return [finding({ engine: "readiness", state: "review", line: `${input.unit.label} with ${input.candidate.label}: needs review — ${named || "see the readiness panel"}.`, ref: r.ref })];
    case "unknown": return [finding({ engine: "readiness", state: "unknown", line: `${input.unit.label} with ${input.candidate.label}: not established — ${named || "an axis could not be evaluated"}.`, ref: r.ref })];
    case "eligible": return [finding({ engine: "readiness", state: "ok", line: `${input.unit.label} with ${input.candidate.label}: ready as of the last composition.`, ref: r.ref })];
  }
}

/* ------------------------------------------------------------------ */
/* The composite                                                        */
/* ------------------------------------------------------------------ */

const ORDER: Record<ScheduleVerdict, number> = { FEASIBLE: 0, FEASIBLE_WITH_REVIEW: 1, UNKNOWN: 2, NOT_FEASIBLE: 3 };

export function assessSchedule(input: ScheduleInput): ScheduleAssessment {
  if (input.window.to.getTime() <= input.window.from.getTime()) throw new Error("The window ends before it begins");
  const cal = calendarFindings(input);
  const hos = hosFindings(input, cal.availableFrom);
  const ready = readinessFindings(input);
  const findings = [...cal.findings, ...hos.findings, ...ready];
  const has = (s: FindingState) => findings.some(f => f.state === s);
  const verdict: ScheduleVerdict = has("block") ? "NOT_FEASIBLE" : has("unknown") ? "UNKNOWN" : has("review") ? "FEASIBLE_WITH_REVIEW" : "FEASIBLE";
  const who = input.unit ? `${input.candidate.label} and ${input.unit.label}` : input.candidate.label;
  const blocks = findings.filter(f => f.state === "block");
  const unknowns = findings.filter(f => f.state === "unknown");
  const summary =
    verdict === "NOT_FEASIBLE"
      ? (cal.availableFrom ? `${who} ${cal.availableFrom.getTime() > input.window.from.getTime() ? `are free from ${fmt(cal.availableFrom)}` : "are available"}, but ${blocks[0]!.line.replace(/^\w/, c => c.toLowerCase())}` : `${who}: ${blocks[0]!.line}`)
      : verdict === "UNKNOWN"
        ? `${who}: cannot say — ${unknowns.map(u => u.line).join(" ")}`
        : verdict === "FEASIBLE_WITH_REVIEW"
          ? `${who} could take this job from ${fmt(cal.availableFrom!)}, with review: ${findings.filter(f => f.state === "review").map(f => f.line).join(" ")}`
          : `${who} are available for this job from ${fmt(cal.availableFrom!)}${hos.dutyWindowEndsAt ? `, and the projected duty window ends ${fmt(hos.dutyWindowEndsAt)} after the projected finish` : ""}.`;
  return {
    candidate: input.candidate, unit: input.unit, window: input.window, verdict, availableFrom: cal.availableFrom, dutyWindowEndsAt: hos.dutyWindowEndsAt, findings, summary,
    note: "Advice, composed from engines that already decided. Dispatch assigns, and the readiness gate runs at award on that moment's facts. UNKNOWN is not feasible.",
  };
}

/** Feasible first, then review, then unknown, then not; earlier availability wins within a rank. */
export function rankAssessments(assessments: readonly ScheduleAssessment[]): ScheduleAssessment[] {
  return [...assessments].sort((a, b) =>
    ORDER[a.verdict] - ORDER[b.verdict]
    || (a.availableFrom?.getTime() ?? Infinity) - (b.availableFrom?.getTime() ?? Infinity)
    || a.candidate.userId - b.candidate.userId);
}
