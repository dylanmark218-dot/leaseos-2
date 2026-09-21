/**
 * B27 — projections.
 *
 * Pure. No engine calls.
 *
 * Five HOS cards on a board are not five questions. Hours remaining, driving
 * remaining, on-duty remaining, cycle remaining and the break countdown are one
 * calculation shown five ways, and calling the engine five times is both
 * wasteful and dangerous: five independent calls can disagree, and a driver
 * looking at two tiles that disagree about their clock has no way to know which
 * one to believe.
 *
 * So a source returns one canonical answer and projectors slice it.
 *
 * The rules a projector may not break, enforced by `project` rather than left
 * to each projector's conscience:
 *
 * **Confidence never rises.** A projection of an `unknown` is `unknown`. A
 * projection of a `stale` is `stale`. A projector that returned `ok` from a
 * parent that was not `ok` would be inventing certainty out of arithmetic.
 *
 * **Blockers never disappear.** A projection of a `blocked` parent stays
 * blocked, carrying the parent's blockers. "Driving remaining" cannot show a
 * cheerful number when the parent answer was that the log cannot be evaluated.
 *
 * **Provenance is inherited, not authored.** A projector may not claim a better
 * source or a fresher observation than the answer it is slicing.
 */

import type { NamedBlocker, Provenance, WidgetPayload } from "./widgetPayload";

/**
 * A projector turns the parent's value into this widget's value.
 *
 * It receives the value only. It never sees the state, so it cannot branch on
 * it, and it cannot return one.
 */
export type Projector<TParent, TChild> = {
  /** For diagnostics and the source matrix. */
  name: string;
  project: (parentValue: TParent) => TChild;
};

/**
 * Apply a projector to a resolved payload.
 *
 * Every non-value state passes through untouched — the projector is not even
 * called, so there is no path by which it could upgrade one. A projector that
 * throws degrades to `failed` for that tile alone; the parent answer and its
 * siblings are unaffected.
 */
export function project<TParent, TChild>(
  parent: WidgetPayload<TParent>,
  projector: Projector<TParent, TChild>,
): WidgetPayload<TChild> {
  if (parent.state === "ok") {
    try {
      return { state: "ok", value: projector.project(parent.value), provenance: parent.provenance,
        ...(parent.deepLink ? { deepLink: parent.deepLink } : {}) };
    } catch (e) {
      return { state: "failed", reason: `${projector.name}: ${e instanceof Error ? e.message : "projection failed"}` };
    }
  }

  if (parent.state === "stale") {
    try {
      return { state: "stale", value: projector.project(parent.value), asOf: parent.asOf,
        provenance: parent.provenance, ...(parent.deepLink ? { deepLink: parent.deepLink } : {}) };
    } catch (e) {
      return { state: "failed", reason: `${projector.name}: ${e instanceof Error ? e.message : "projection failed"}` };
    }
  }

  // unknown, blocked, offline, not_permitted, failed: passed through whole.
  // The projector is not consulted, which is what makes "may not upgrade
  // confidence" a property of this function rather than a convention.
  return parent as WidgetPayload<TChild>;
}

/** Apply several projectors to one answer. One engine call, many tiles. */
export function projectAll<TParent>(
  parent: WidgetPayload<TParent>,
  projectors: Readonly<Record<string, Projector<TParent, unknown>>>,
): Readonly<Record<string, WidgetPayload<unknown>>> {
  const out: Record<string, WidgetPayload<unknown>> = {};
  for (const [key, p] of Object.entries(projectors)) out[key] = project(parent, p);
  return out;
}

/* ------------------------------------------------------------------ */
/* The canonical HOS answer                                            */
/* ------------------------------------------------------------------ */

/**
 * What one HOS evaluation returns.
 *
 * Deliberately structured rather than a number: five widgets read different
 * fields of this, and none of them re-derives anything.
 */
export type HosSummary = {
  dutyStatus: "off_duty" | "sleeper" | "driving" | "on_duty";
  drivingRemainingMinutes: number;
  drivingLimitMinutes: number;
  onDutyRemainingMinutes: number;
  onDutyLimitMinutes: number;
  cycleRemainingMinutes: number;
  cycleLimitMinutes: number;
  /** Minutes until a break is required. Null when none is pending. */
  breakDueInMinutes: number | null;
  /** Violations already accrued, as named blockers. */
  violations: readonly NamedBlocker[];
  /** True when the log holds edits the driver has not certified. */
  hasUncertifiedEdits: boolean;
  /** Which rule profile produced this. Never absent in a valid summary. */
  ruleProfile: { jurisdiction: string; ruleFamily: string; version: string; contentHash: string };
  calculatedAt: Date;
};

const gauge = (current: number, max: number, unit = "min", label?: string) =>
  ({ current, max, unit, ...(label ? { label } : {}) });

const formatMinutes = (m: number): string => {
  const total = Math.max(0, Math.round(m));
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}h ${String(total % 60).padStart(2, "0")}m` : `${total}m`;
};

/**
 * The five HOS widgets, as projections of one summary.
 *
 * Each names the field it reads, so the source matrix can state exactly which
 * part of one engine answer a given tile shows.
 */
export const HOS_PROJECTORS = {
  hosRemaining: {
    name: "hos.drivingRemaining",
    project: (s: HosSummary) =>
      gauge(s.drivingRemainingMinutes, s.drivingLimitMinutes, "min", formatMinutes(s.drivingRemainingMinutes)),
  },
  drivingRemaining: {
    name: "hos.drivingRemaining",
    project: (s: HosSummary) =>
      gauge(s.drivingRemainingMinutes, s.drivingLimitMinutes, "min", formatMinutes(s.drivingRemainingMinutes)),
  },
  onDutyRemaining: {
    name: "hos.onDutyRemaining",
    project: (s: HosSummary) =>
      gauge(s.onDutyRemainingMinutes, s.onDutyLimitMinutes, "min", formatMinutes(s.onDutyRemainingMinutes)),
  },
  cycleRemaining: {
    name: "hos.cycleRemaining",
    project: (s: HosSummary) =>
      gauge(s.cycleRemainingMinutes, s.cycleLimitMinutes, "min", formatMinutes(s.cycleRemainingMinutes)),
  },
  breakCountdown: {
    name: "hos.breakDue",
    project: (s: HosSummary) =>
      s.breakDueInMinutes === null
        ? { current: 0, max: 0, unit: "min", label: "no break pending" }
        : gauge(s.breakDueInMinutes, 480, "min", formatMinutes(s.breakDueInMinutes)),
  },
  dutyStatus: {
    name: "hos.dutyStatus",
    project: (s: HosSummary) => ({
      rows: [
        { id: "status", primary: s.dutyStatus.replace("_", " ") },
        { id: "as-of", primary: `calculated ${s.calculatedAt.toISOString().slice(11, 16)}` },
        { id: "profile", primary: `${s.ruleProfile.jurisdiction} ${s.ruleProfile.ruleFamily} v${s.ruleProfile.version}` },
      ],
    }),
  },
} as const satisfies Record<string, Projector<HosSummary, unknown>>;

/**
 * Violations as a payload in their own right.
 *
 * Not a projector: a violation turns a value answer into a `blocked` one, which
 * `project` deliberately forbids a projector from doing. Raising severity is a
 * decision about truth, so it lives here in the open rather than hidden in a
 * slice function.
 */
export function hosViolationPayload(parent: WidgetPayload<HosSummary>): WidgetPayload<unknown> {
  if (parent.state !== "ok" && parent.state !== "stale") return parent as WidgetPayload<unknown>;
  const summary = parent.value;
  if (summary.violations.length > 0) {
    return { state: "blocked", blockers: summary.violations };
  }
  return project(parent, {
    name: "hos.violations",
    project: () => "no violations on this log",
  });
}

/* ------------------------------------------------------------------ */
/* Dispatch gate projections                                           */
/* ------------------------------------------------------------------ */

export type DispatchGateAnswer = {
  ready: boolean;
  blockers: readonly NamedBlocker[];
  checkedAt: Date;
};

export const DISPATCH_PROJECTORS = {
  blockerCount: {
    name: "dispatch.blockerCount",
    project: (a: DispatchGateAnswer) => String(a.blockers.length),
  },
  blockerList: {
    name: "dispatch.blockerList",
    project: (a: DispatchGateAnswer) => ({
      rows: a.blockers.map((b) => ({ id: b.code, primary: b.detail, emphasis: "attention" as const })),
    }),
  },
} as const satisfies Record<string, Projector<DispatchGateAnswer, unknown>>;

/**
 * The readiness tile itself.
 *
 * Same reasoning as HOS violations: a gate answer of "not ready" must become a
 * `blocked` payload with the names, and that is a severity decision rather than
 * a slice.
 */
export function dispatchReadinessPayload(parent: WidgetPayload<DispatchGateAnswer>): WidgetPayload<unknown> {
  if (parent.state !== "ok" && parent.state !== "stale") return parent as WidgetPayload<unknown>;
  if (!parent.value.ready) return { state: "blocked", blockers: parent.value.blockers };
  return project(parent, { name: "dispatch.ready", project: () => "ready to dispatch" });
}

/* ------------------------------------------------------------------ */
/* Provenance guard                                                    */
/* ------------------------------------------------------------------ */

/**
 * Assert a child payload did not gain anything its parent lacked.
 *
 * Used by the projector tests and available to a future registry check. The
 * comparison is on state and provenance identity, not on value: a projection is
 * allowed to change the number, and nothing else.
 */
export function preservesConfidence(
  parent: WidgetPayload<unknown>,
  child: WidgetPayload<unknown>,
): boolean {
  if (parent.state !== child.state) {
    // The single permitted exception is a projection that failed, which is a
    // downgrade.
    return child.state === "failed";
  }
  if (parent.state === "ok" && child.state === "ok") return parent.provenance === child.provenance;
  if (parent.state === "stale" && child.state === "stale") {
    return parent.provenance === child.provenance && parent.asOf === child.asOf;
  }
  return true;
}

export const projectorProvenance = (p: Provenance): Provenance => p;
