/**
 * v22.20 — who will be short, and of what, before the morning of the job.
 *
 * Pure. No network, no database.
 *
 * Composes `Person`, `Assignment` and `RotationPattern` that already exist
 * rather than restating them. Nothing here decides whether an individual is fit
 * for a shift — `readyForShift` does that, and a second opinion in a forecast
 * screen is how two answers to one question appear.
 *
 * The reason this is worth having: a crew can be numerically full and still
 * unable to do the work. Fourteen people scheduled against fourteen seats reads
 * green everywhere, right up to the morning somebody notices that only two of
 * them hold the orientation the client requires. Counting heads answers the
 * wrong question, so this counts heads *and* qualifications, separately.
 *
 * **A person whose qualification nobody has established is not counted.** The
 * same rule as everywhere else: unknown is not covered. A forecast that assumes
 * the best is worse than no forecast, because somebody plans around it.
 */

import { isOnShift, type RotationPattern } from "./calendarProjection";
import type { Assignment, Person } from "./shiftReadiness";

export type CrewMember = Person & {
  /** The rotation they work. Absent means they are not on a pattern at all. */
  rotation: RotationPattern | null;
  /** Dates they are known to be away, whatever the rotation says. */
  awayOn: readonly Date[];
};

const sameDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/** Whether this person is expected to be working that day. */
export function isAvailable(member: CrewMember, day: Date): boolean {
  if (member.awayOn.some(d => sameDay(d, day))) return false;
  if (!member.rotation) return true;   // no pattern is not the same as not working
  return isOnShift(member.rotation, day);
}

export type DayCoverage = {
  day: Date;
  needed: number;
  available: number;
  shortfall: number;
  state: "covered" | "tight" | "short";
  availableNames: string[];
  line: string;
};

/**
 * Headcount for a run of days.
 *
 * `tight` exists because exactly enough is not the same as enough — one
 * sickness turns it into a shortage, and a planner deserves to see that coming
 * rather than only the day it breaks.
 */
export function headcountForecast(args: {
  crew: readonly CrewMember[];
  from: Date;
  days: number;
  neededPerDay: number;
}): DayCoverage[] {
  return Array.from({ length: args.days }, (_, i) => {
    const day = new Date(args.from.getTime() + i * 86_400_000);
    const on = args.crew.filter(m => isAvailable(m, day));
    const available = on.length;
    const shortfall = Math.max(0, args.neededPerDay - available);
    const state: DayCoverage["state"] = shortfall > 0 ? "short" : available === args.neededPerDay ? "tight" : "covered";
    return {
      day, needed: args.neededPerDay, available, shortfall, state,
      availableNames: on.map(m => m.name),
      line: `${day.toISOString().slice(0, 10)}   ${args.neededPerDay} needed / ${available} available   ${state.toUpperCase()}${shortfall ? ` — short ${shortfall}` : ""}`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Numerically full and still unable to do the work                     */
/* ------------------------------------------------------------------ */

export type QualificationGap = {
  qualification: string;
  needed: number;
  holders: number;
  shortfall: number;
  holderNames: string[];
};

export type QualifiedCoverage = {
  day: Date;
  headcount: DayCoverage;
  gaps: QualificationGap[];
  /** Covered on headcount and short on a qualification is the case this exists for. */
  state: "covered" | "tight" | "short_people" | "short_qualification";
  line: string;
};

/**
 * Coverage against what the work actually requires.
 *
 * `requiredQualifications` comes from the assignment, not from whoever usually
 * does it — the same rule the swap check follows. A crew that has always had
 * the ticket does not keep it by habit.
 */
export function qualifiedForecast(args: {
  crew: readonly CrewMember[];
  from: Date;
  days: number;
  neededPerDay: number;
  /** What each seat must hold. One entry per qualification, with how many seats need it. */
  requirements: readonly { qualification: string; neededHolders: number }[];
}): QualifiedCoverage[] {
  const headcounts = headcountForecast(args);
  return headcounts.map(headcount => {
    const on = args.crew.filter(m => isAvailable(m, headcount.day));
    const gaps: QualificationGap[] = args.requirements.map(req => {
      const holders = on.filter(m => m.currentQualifications.includes(req.qualification));
      return {
        qualification: req.qualification, needed: req.neededHolders, holders: holders.length,
        shortfall: Math.max(0, req.neededHolders - holders.length),
        holderNames: holders.map(m => m.name),
      };
    });
    const missing = gaps.filter(g => g.shortfall > 0);
    const state: QualifiedCoverage["state"] =
      headcount.state === "short" ? "short_people"
      : missing.length ? "short_qualification"
      : headcount.state === "tight" ? "tight"
      : "covered";

    const line =
      state === "short_qualification"
        ? `${headcount.day.toISOString().slice(0, 10)}   headcount met (${headcount.available}/${headcount.needed}) but short on ${missing.map(g => `${g.qualification} (${g.holders}/${g.needed})`).join(", ")}`
        : headcount.line;
    return { day: headcount.day, headcount, gaps, state, line };
  });
}

/** The days somebody has to do something about, and nothing else. */
export const problemDays = (forecast: readonly QualifiedCoverage[]): QualifiedCoverage[] =>
  forecast.filter(d => d.state === "short_people" || d.state === "short_qualification");

export type CoverageWarning = {
  qualification: string | null;
  from: Date;
  to: Date;
  holders: number;
  needed: number;
  shortfall: number;
  line: string;
};

/**
 * Every gap, worst first.
 *
 * The first version returned whichever gap the map happened to yield first,
 * which with two simultaneous shortages was an arbitrary choice presented as
 * the answer — and the one it dropped might have been the larger. Ranking by
 * shortfall and returning all of them removes the choice rather than making it
 * quietly.
 */
export function coverageWarnings(forecast: readonly QualifiedCoverage[]): CoverageWarning[] {
  const problems = problemDays(forecast);
  const byQualification = new Map<string, QualifiedCoverage[]>();
  for (const day of problems) {
    for (const gap of day.gaps.filter(g => g.shortfall > 0)) {
      byQualification.set(gap.qualification, [...(byQualification.get(gap.qualification) ?? []), day]);
    }
  }

  const warnings: CoverageWarning[] = [];
  byQualification.forEach((days, qualification) => {
    const worst = days
      .map(d => d.gaps.find((g: QualificationGap) => g.qualification === qualification)!)
      .reduce((a, b) => (b.shortfall > a.shortfall ? b : a));
    const from = days[0].day;
    const to = days[days.length - 1].day;
    warnings.push({
      qualification, from, to, holders: worst.holders, needed: worst.needed, shortfall: worst.shortfall,
      line: `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}: only ${worst.holders} of the ${worst.needed} people this work needs hold ${qualification}`,
    });
  });

  // A day that is simply short of people is its own warning, not a qualification one.
  const peopleShort = problems.filter(d => d.state === "short_people");
  if (peopleShort.length) {
    const worst = peopleShort.reduce((a, b) => (b.headcount.shortfall > a.headcount.shortfall ? b : a));
    warnings.push({
      qualification: null, from: peopleShort[0].day, to: peopleShort[peopleShort.length - 1].day,
      holders: worst.headcount.available, needed: worst.headcount.needed, shortfall: worst.headcount.shortfall,
      line: `${worst.day.toISOString().slice(0, 10)}: short ${worst.headcount.shortfall} of ${worst.headcount.needed}`,
    });
  }

  return warnings.sort((a, b) => b.shortfall - a.shortfall);
}

/**
 * The single worst gap, for a one-line surface. Built on the full list rather
 * than instead of it, so nothing is dropped without being available.
 */
export function coverageWarning(forecast: readonly QualifiedCoverage[]): string | null {
  return coverageWarnings(forecast)[0]?.line ?? null;
}

/** An assignment's own requirements, turned into what a forecast needs. */
export const requirementsOf = (assignment: Assignment, seats: number) =>
  assignment.requiredQualifications.map(qualification => ({ qualification, neededHolders: seats }));
