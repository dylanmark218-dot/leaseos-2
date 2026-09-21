/**
 * Site-specific baselines for setup, load, unload and wait time.
 *
 * The rule this file exists to enforce: a site with too little history has no
 * baseline, and "no baseline" must never render as "normal". A stop that took
 * four hours at a site nobody has measured is reported as unmeasured, not as
 * acceptable — the office decides, the statistics only describe.
 *
 * Two further rules follow from the same principle:
 *
 *   - Unconfirmed timings never establish a baseline. GPS-detected arrival and
 *     departure are proposals until a driver or the office confirms them, and a
 *     baseline built from proposals would launder inference into a standard.
 *   - An alert names the observation and the comparison. It never names a cause.
 *     "Setup took 3.1× the site median" is a fact; "the customer held the truck"
 *     is an accusation the data cannot support.
 *
 * Robust statistics throughout (median, MAD) rather than mean and standard
 * deviation: oilfield stop durations are small-n and heavily right-skewed, and
 * one six-hour freeze-off would drag a mean baseline permanently upward.
 *
 * ## Confirmation is per phase, not per stop
 *
 * The unit of confirmation is a timestamp, not a stop. `tripStops` carries five
 * boundaries and they are confirmed independently — an arrival lands as a
 * confirmed zone event while a departure never does, or the reverse. A phase is
 * sound exactly when both of ITS bounding timestamps are sound, so `setup` can
 * be usable on a stop whose departure nobody ever confirmed.
 *
 * An earlier revision carried one boolean per stop. That discarded a perfectly
 * good setup sample over an unrelated unconfirmed departure, which at a site
 * visited twice a year keeps it below `MINIMUM_SAMPLES` longer than the facts
 * require — and the sparse sites are exactly the ones the floor was written to
 * protect.
 *
 * ## Three verdicts, not two
 *
 * `unconfirmed` and `unknown` both exclude a sample, but they are different
 * facts with different remedies. `unconfirmed` means a proposal is sitting there
 * waiting for a person — someone can confirm it this afternoon. `unknown` means
 * provenance is not recorded at all, which today is the state of every timestamp
 * written through `tripStops.create` / `.update`: those procedures hold
 * `ctx.user.id` and discard it, so nothing distinguishes a time a person typed
 * from one an importer wrote. No amount of confirming fixes that; a migration
 * does. Collapsing the two would leave the office reading "excluded" with no way
 * to tell which queue the work belongs in, so they are counted separately.
 *
 * ## Precision is a second axis, and approximate values fail toward silence
 *
 * `proposalFields` keeps `precision` in its own column beside `source` and
 * `status`, and this file keeps it separate too — an approximate duration is not
 * an unconfirmed one. "About twenty minutes" is a person being honest; it is
 * simply not a measurement.
 *
 * The reason it cannot feed a baseline was measured rather than assumed, and it
 * runs opposite to the obvious guess. Rounded values do not manufacture false
 * alarms; they suppress real ones. Twelve real setups of
 * [18,19,20,20,21,22,20,19,23,20,21,18] give MAD 1, and a 26-minute setup reads
 * `elevated`. The same reality reported as "about twenty" gives MAD 0, which
 * switches this file onto the multiple-of-median fallback, and 26 minutes reads
 * `within_baseline`. So does 30. It takes 35 to get back to `elevated`.
 *
 * Worse, a majority is enough. [18,20,20,20,19,20,20,20,20,20,20,21] carries
 * genuine spread and still yields MAD 0, because the median of the absolute
 * deviations is 0 once most values sit on the round number. The engine changes
 * rules silently — the `math` string says which rule ran, but never that rounding
 * is why.
 *
 * A tripwire that goes quiet is the failure this whole file is written against,
 * so a phase is baseline-eligible only when it is **confirmed AND exact**, and
 * `excludedApproximate` is counted beside the other two.
 *
 * Two consequences of that rule, both deliberate:
 *
 *   - At a site where drivers habitually SPEAK durations rather than letting the
 *     timestamps derive them, the baseline may never establish at all. That is
 *     permanent, not merely slow, and it is correct — a standard assembled from
 *     round numbers is worse than no standard. It does mean the assistant
 *     capturing exact boundary timestamps where it can, rather than a free-text
 *     duration, is what keeps such a site measurable; `aiProposal.ts` currently
 *     collects "Wait" as a duration and marks it `precisionSensitive`, which is
 *     honest about the value and does not make it usable here. Worth weighing
 *     when the field-paperwork flow is designed.
 *   - MAD collapses to zero on ordinary data, not only on rounded data — see the
 *     note on the `med === 0` branch below. Excluding approximations reduces how
 *     often the loose rule engages; it does not stop it.
 *
 * `BoundaryConfirmation` is a VERDICT, derived from `proposalFields`' own
 * `source` and `status` columns. It is deliberately not a parallel provenance
 * vocabulary — the derivation reads that enum directly and keeps `corrected`
 * alive, which is the case that matters: a `gps` field at `rejected` sitting
 * beside a `human_corrected` field must not poison the corrected value.
 */

/** Minimum confirmed samples before a phase has a baseline at all. */
export const MINIMUM_SAMPLES = 8;

/** 0.6745 = the 75th percentile of the standard normal; scales MAD to a z-like number. */
const MAD_SCALE = 0.6745;

/** Robust-z thresholds, used when MAD > 0. */
const ELEVATED_Z = 3.5;
const EXTREME_Z = 7;

/** Fallback thresholds as a multiple of the median, used when MAD === 0. */
const ELEVATED_MULTIPLE = 1.75;
const EXTREME_MULTIPLE = 3;

export type StopPhase = "setup" | "operation" | "wait" | "total";

export const STOP_PHASES: readonly StopPhase[] = ["setup", "operation", "wait", "total"] as const;

/* ------------------------------------------------------------------ */
/* Confirmation                                                        */
/* ------------------------------------------------------------------ */

export type BoundaryKey =
  | "arrivedAt"
  | "setupStartedAt"
  | "operationStartedAt"
  | "operationCompletedAt"
  | "departedAt";

/**
 * What is known about one timestamp.
 *
 *   confirmed   — a person stands behind it: a confirmed zone event supplies or
 *                 corroborates it, or somebody entered it and that is recorded.
 *   unconfirmed — a proposal nobody has acted on yet (a pending detection).
 *   unknown     — provenance is not recorded, so neither of the above can be said.
 */
export type BoundaryConfirmation = "confirmed" | "unconfirmed" | "unknown";

/** A phase inherits the three verdicts of its bounding timestamps. */
export type PhaseConfirmation = BoundaryConfirmation;

/**
 * How exactly the duration is known — `proposalFields.precision`, plus the
 * honest third state for a row that does not record it.
 *
 * Separate from confirmation on purpose: a confirmed approximation is still an
 * approximation, and folding the two would let "about twenty minutes" establish
 * a standard the moment somebody agreed it was about twenty minutes.
 */
export type PhasePrecision = "exact" | "approximate" | "unknown";

/**
 * Which timestamps bound each phase.
 *
 * `wait` was flagged as an assumption; it is confirmed for the derived case. The
 * only derivation of `waitMinutes` in the tree is `server/routers.ts:592`:
 *
 *     waitMinutes: input.waitMinutes ?? minutes(input.arrivedAt, input.setupStartedAt)
 *
 * — arrival to the start of setup, exactly the pair below.
 *
 * Two caveats the router that calls this has to carry:
 *
 *   1. That derivation is a FALLBACK, and a stated duration has no bounding
 *      timestamps at all. A caller supplying `waitMinutes` directly bypasses it,
 *      and the assistant path does: `aiProposal.ts` collects "Wait" as a free
 *      voice duration. So a phase verdict has two possible sources and which one
 *      applies is a fact about the row, not something to guess:
 *
 *        derived from timestamps → `combineBoundaries` over its two bounds
 *        stated outright         → that field's own `source` and `status`
 *        no way to tell which    → `unknown`
 *
 *      The third branch is today's answer for every wait sample: `waitMinutes`
 *      is a bare `double` and nothing on the row says whether it was computed or
 *      spoken. `UNKNOWN_CONFIRMATION` is therefore correct for it now, for this
 *      reason rather than only the general one. Same for any supplied
 *      `setupMinutes`.
 *   2. `operation` and `total` have no stored column at all. `tripStops` carries
 *      `durationMinutes`, `setupMinutes` and `waitMinutes` — no `operationMinutes`,
 *      no `totalMinutes`. `totalMinutes` corresponds to `durationMinutes`
 *      (`routers.ts:598` derives it from arrival to departure, matching `total`
 *      below); `operationMinutes` has to be derived from `operationStartedAt` and
 *      `operationCompletedAt` by whoever assembles the sample.
 *
 * If wait time is instead dead time inside the operation, change it here and
 * nowhere else.
 */
export const PHASE_BOUNDARIES: Record<StopPhase, readonly [BoundaryKey, BoundaryKey]> = {
  setup: ["setupStartedAt", "operationStartedAt"],
  operation: ["operationStartedAt", "operationCompletedAt"],
  wait: ["arrivedAt", "setupStartedAt"],
  total: ["arrivedAt", "departedAt"],
};

/**
 * Combine two boundary verdicts into a phase verdict.
 *
 * `unknown` dominates. A phase with one known-unconfirmed bound and one
 * unrecorded bound is reported `unknown`, not `unconfirmed`, because claiming
 * "merely unconfirmed" would overstate what is known about the half nobody can
 * speak for — and confirming the pending bound would not make the phase usable.
 */
export function combineBoundaries(
  a: BoundaryConfirmation,
  b: BoundaryConfirmation,
): PhaseConfirmation {
  if (a === "unknown" || b === "unknown") return "unknown";
  if (a === "unconfirmed" || b === "unconfirmed") return "unconfirmed";
  return "confirmed";
}

/**
 * Derive the four phase verdicts from the five boundary verdicts.
 *
 * This is the one answer both engines read. It lives here because it currently
 * has exactly one caller; when the billing path is adapted onto
 * `priceLineAndRecord` it should move to a module neither engine owns, so the
 * question is not answered twice differently.
 */
export function phaseConfirmation(
  boundaries: Record<BoundaryKey, BoundaryConfirmation>,
): Record<StopPhase, PhaseConfirmation> {
  const out = {} as Record<StopPhase, PhaseConfirmation>;
  for (const phase of STOP_PHASES) {
    const pair = PHASE_BOUNDARIES[phase];
    out[phase] = combineBoundaries(boundaries[pair[0]], boundaries[pair[1]]);
  }
  return out;
}

/**
 * Every phase unknown.
 *
 * What an honest caller passes today, before provenance is recorded on the
 * `tripStops` write path. Every site will read unmeasured while this is what
 * gets supplied, which is the truth rather than a regression — and it is
 * greppable, so the call sites are findable when the migration lands.
 */
export const UNKNOWN_CONFIRMATION: Record<StopPhase, PhaseConfirmation> = {
  setup: "unknown",
  operation: "unknown",
  wait: "unknown",
  total: "unknown",
};

/** Every phase of unknown precision. The same honesty, on the other axis. */
export const UNKNOWN_PRECISION: Record<StopPhase, PhasePrecision> = {
  setup: "unknown",
  operation: "unknown",
  wait: "unknown",
  total: "unknown",
};

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/**
 * One historical stop at this site.
 *
 * `confirmation` is total, not partial: a sample that feeds a baseline has to
 * state what is known about each phase, because an absent key would be an
 * implicit default and this file exists to keep defaults from standing in for
 * facts.
 */
export type StopSample = {
  tripStopId: number;
  observedAt: Date;
  setupMinutes: number | null;
  operationMinutes: number | null;
  waitMinutes: number | null;
  totalMinutes: number | null;
  confirmation: Record<StopPhase, PhaseConfirmation>;
  /** Total for the same reason `confirmation` is: an absent key would be a default. */
  precision: Record<StopPhase, PhasePrecision>;
};

/** Which site, and which kind of stop. A load baseline never speaks for an unload. */
export type SiteKey = {
  facilityId: number | null;
  locationId: number | null;
  stopType: "load" | "unload";
};

export type BaselineState = "established" | "insufficient_history";

export type PhaseBaseline = {
  phase: StopPhase;
  state: BaselineState;
  /** Confirmed samples that carried a value for this phase. */
  sampleCount: number;
  /** Had a value, provenance recorded, nobody has confirmed it. Someone can. */
  excludedUnconfirmed: number;
  /** Had a value, provenance not recorded on one axis or the other. Confirming will not help; a migration will. */
  excludedUnknownProvenance: number;
  /** Had a value, confirmed, and approximate. Nothing fixes this one — the stop is over. */
  excludedApproximate: number;
  medianMinutes: number | null;
  /** Median absolute deviation. Zero is legitimate and handled explicitly. */
  madMinutes: number | null;
  p90Minutes: number | null;
  oldestSampleAt: Date | null;
  newestSampleAt: Date | null;
};

export type SiteBaseline = {
  site: SiteKey;
  phases: Record<StopPhase, PhaseBaseline>;
  /** True when every phase is insufficient — the site is effectively unmeasured. */
  unmeasured: boolean;
};

export type PhaseVerdict =
  | "no_observation"
  | "insufficient_history"
  | "within_baseline"
  | "elevated"
  | "extreme";

export type PhaseAssessment = {
  phase: StopPhase;
  observedMinutes: number | null;
  verdict: PhaseVerdict;
  /** What is known about the observation itself. An alert off a proposal is weaker evidence. */
  observationConfirmation: PhaseConfirmation;
  medianMinutes: number | null;
  multipleOfMedian: number | null;
  /** The arithmetic, so an office reader can check the comparison rather than trust it. */
  math: string;
};

export type SiteAlert = {
  phase: StopPhase;
  severity: "elevated" | "extreme";
  /** Observation only. Never a cause. */
  headline: string;
  observedMinutes: number;
  medianMinutes: number;
  sampleCount: number;
  observationConfirmation: PhaseConfirmation;
};

export type StopAssessment = {
  site: SiteKey;
  tripStopId: number | null;
  phases: PhaseAssessment[];
  alerts: SiteAlert[];
  /**
   * Phases where a comparison was impossible. Named individually so the office
   * reads "no baseline for wait time at this site" rather than a bare silence.
   */
  unmeasuredPhases: StopPhase[];
};

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function phaseValue(sample: StopSample, phase: StopPhase): number | null {
  const raw =
    phase === "setup" ? sample.setupMinutes
      : phase === "operation" ? sample.operationMinutes
        : phase === "wait" ? sample.waitMinutes
          : sample.totalMinutes;
  // A negative duration is a data fault, not a fast stop. Excluded, never clamped.
  return raw === null || !Number.isFinite(raw) || raw < 0 ? null : raw;
}

/* ------------------------------------------------------------------ */
/* Baseline                                                            */
/* ------------------------------------------------------------------ */

/**
 * Why one sample does or does not feed one phase — exactly one answer per sample,
 * so the counters partition rather than overlap.
 *
 * Precedence is by how far away the remedy is, furthest first. Unrecorded
 * provenance needs a migration and hides both other answers, so it is checked
 * first: a row that does not say what it is cannot be said to be unconfirmed or
 * approximate either. Then unconfirmed, which a person can clear this afternoon.
 * Then approximate, which nothing clears — the stop is over and nobody can go
 * back and measure it.
 */
type Eligibility = "counted" | "unknown_provenance" | "unconfirmed" | "approximate";

function eligibility(sample: StopSample, phase: StopPhase): Eligibility {
  const confirmation = sample.confirmation[phase];
  const precision = sample.precision[phase];
  if (confirmation === "unknown" || precision === "unknown") return "unknown_provenance";
  if (confirmation === "unconfirmed") return "unconfirmed";
  if (precision === "approximate") return "approximate";
  return "counted";
}

/**
 * Build a baseline for one site from its confirmed history.
 *
 * Filtering is per phase: a sample contributes to `setup` if its setup bounds
 * were confirmed and its setup duration is exact, whatever happened to its
 * departure.
 *
 * Samples are not filtered by age here. A caller that wants a trailing window
 * passes a trailing window — this function does not silently decide that
 * eighteen-month-old measurements are irrelevant, because at a site visited
 * twice a year they are all there is.
 */
export function buildSiteBaseline(site: SiteKey, samples: StopSample[]): SiteBaseline {
  const phases = {} as Record<StopPhase, PhaseBaseline>;

  for (const phase of STOP_PHASES) {
    const withValue: { sample: StopSample; value: number }[] = [];
    for (const s of samples) {
      const value = phaseValue(s, phase);
      if (value !== null) withValue.push({ sample: s, value });
    }

    const usable = withValue.filter(x => eligibility(x.sample, phase) === "counted");
    const values = usable.map(x => x.value).sort((a, b) => a - b);
    const med = median(values);

    const mad =
      med === null
        ? null
        : median(values.map(v => Math.abs(v - med)).sort((a, b) => a - b));

    const times = usable.map(x => x.sample.observedAt.getTime());

    phases[phase] = {
      phase,
      state: values.length >= MINIMUM_SAMPLES ? "established" : "insufficient_history",
      sampleCount: values.length,
      excludedUnconfirmed: withValue.filter(x => eligibility(x.sample, phase) === "unconfirmed").length,
      excludedUnknownProvenance: withValue.filter(x => eligibility(x.sample, phase) === "unknown_provenance").length,
      excludedApproximate: withValue.filter(x => eligibility(x.sample, phase) === "approximate").length,
      medianMinutes: med === null ? null : round2(med),
      madMinutes: mad === null ? null : round2(mad),
      p90Minutes: percentile(values, 90),
      oldestSampleAt: times.length ? new Date(Math.min.apply(null, times)) : null,
      newestSampleAt: times.length ? new Date(Math.max.apply(null, times)) : null,
    };
  }

  return {
    site,
    phases,
    unmeasured: STOP_PHASES.every(p => phases[p].state === "insufficient_history"),
  };
}

/* ------------------------------------------------------------------ */
/* Assessment                                                          */
/* ------------------------------------------------------------------ */

function assessPhase(
  phase: StopPhase,
  observed: number | null,
  confirmation: PhaseConfirmation,
  baseline: PhaseBaseline,
): PhaseAssessment {
  const common = {
    phase,
    observationConfirmation: confirmation,
    medianMinutes: baseline.medianMinutes,
  };

  if (observed === null || !Number.isFinite(observed) || observed < 0) {
    return {
      ...common,
      observedMinutes: null,
      verdict: "no_observation",
      multipleOfMedian: null,
      math: `no ${phase} duration recorded for this stop`,
    };
  }

  if (baseline.state === "insufficient_history" || baseline.medianMinutes === null) {
    const excluded =
      baseline.excludedUnconfirmed + baseline.excludedUnknownProvenance + baseline.excludedApproximate;
    return {
      ...common,
      observedMinutes: round2(observed),
      verdict: "insufficient_history",
      multipleOfMedian: null,
      math:
        `${round2(observed)} min observed; ` +
        `${baseline.sampleCount} confirmed sample(s) at this site, ` +
        `${MINIMUM_SAMPLES} needed` +
        (excluded > 0
          ? ` (${baseline.excludedUnconfirmed} unconfirmed, ` +
          `${baseline.excludedUnknownProvenance} without recorded provenance, ` +
          `${baseline.excludedApproximate} approximate)`
          : "") +
        ` — no baseline, so no comparison is made`,
    };
  }

  const med = baseline.medianMinutes;
  const mad = baseline.madMinutes;
  const multiple = med === 0 ? null : round2(observed / med);

  // MAD > 0: robust z-score, the preferred rule.
  if (mad !== null && mad > 0) {
    const z = round2((MAD_SCALE * (observed - med)) / mad);
    const verdict: PhaseVerdict =
      z >= EXTREME_Z ? "extreme" : z >= ELEVATED_Z ? "elevated" : "within_baseline";
    return {
      ...common,
      observedMinutes: round2(observed),
      verdict,
      multipleOfMedian: multiple,
      math:
        `${round2(observed)} min vs median ${med} min (MAD ${mad}); ` +
        `robust z = 0.6745 × (${round2(observed)} − ${med}) ÷ ${mad} = ${z} ` +
        `[elevated ≥ ${ELEVATED_Z}, extreme ≥ ${EXTREME_Z}] over ${baseline.sampleCount} samples`,
    };
  }

  /*
   * MAD === 0. NOT "every sample landed on the same value" — that was the claim
   * here and it is false in the dangerous direction, because it reads as
   * degenerate input a reviewer can skim past.
   *
   * The median absolute deviation is zero as soon as MORE THAN HALF the samples
   * share the median value. Spread on either side does nothing to stop it: seven
   * 20s among [17,18,19,20×7,21,22] gives MAD 0, and six gives MAD 0.5. At n = 8,
   * the MINIMUM_SAMPLES floor and therefore the first baseline any site ever gets,
   * five of eight is enough.
   *
   * So this branch is not the degenerate case. It is the ORDINARY case for a
   * consistent site — a setup that takes twenty minutes most days — and the
   * fallback below is deliberately much looser than the z-rule: a 26-minute setup
   * that reads `elevated` against MAD 1 reads `within_baseline` here. A z-score
   * would divide by zero and call a one-minute difference infinitely abnormal, so
   * the looseness is right; being quiet about how often it applies was not.
   */
  if (med === 0) {
    return {
      ...common,
      observedMinutes: round2(observed),
      verdict: observed > 0 ? "elevated" : "within_baseline",
      multipleOfMedian: null,
      math:
        `${round2(observed)} min vs median 0 min across ${baseline.sampleCount} samples; ` +
        `the median absolute deviation is zero, so there is nothing to scale against ` +
        `and any non-zero duration is flagged for review`,
    };
  }

  const verdict: PhaseVerdict =
    multiple !== null && multiple >= EXTREME_MULTIPLE ? "extreme"
      : multiple !== null && multiple >= ELEVATED_MULTIPLE ? "elevated"
        : "within_baseline";

  return {
    ...common,
    observedMinutes: round2(observed),
    verdict,
    multipleOfMedian: multiple,
    math:
      `${round2(observed)} min vs median ${med} min; ` +
      `MAD 0 over ${baseline.sampleCount} samples — more than half share the median, ` +
      `so the looser multiple rule applies rather than the z-score: ` +
      `${multiple}× median [elevated ≥ ${ELEVATED_MULTIPLE}×, extreme ≥ ${EXTREME_MULTIPLE}×]`,
  };
}

/**
 * Compare one stop against its site baseline.
 *
 * The candidate stop is deliberately NOT required to be confirmed: the point of
 * the alert is to reach the office while the truck is still on site. What the
 * candidate may not do is feed the baseline — that is `buildSiteBaseline`'s job,
 * and it takes only confirmed phases.
 *
 * `confirmation` is partial here, unlike on a sample, and an absent phase reads
 * `unknown`. A live stop being screened may legitimately not know yet; the
 * default is the honest one rather than the convenient one, and it travels onto
 * the alert so a reader sees what the number rests on.
 */
export function assessStop(args: {
  baseline: SiteBaseline;
  tripStopId?: number | null;
  setupMinutes?: number | null;
  operationMinutes?: number | null;
  waitMinutes?: number | null;
  totalMinutes?: number | null;
  confirmation?: Partial<Record<StopPhase, PhaseConfirmation>>;
}): StopAssessment {
  const observedFor = (phase: StopPhase): number | null =>
    phase === "setup" ? args.setupMinutes ?? null
      : phase === "operation" ? args.operationMinutes ?? null
        : phase === "wait" ? args.waitMinutes ?? null
          : args.totalMinutes ?? null;

  const confirmationFor = (phase: StopPhase): PhaseConfirmation =>
    (args.confirmation && args.confirmation[phase]) ?? "unknown";

  const phases = STOP_PHASES.map(phase =>
    assessPhase(phase, observedFor(phase), confirmationFor(phase), args.baseline.phases[phase]),
  );

  const alerts: SiteAlert[] = phases
    .filter(p => p.verdict === "elevated" || p.verdict === "extreme")
    .map(p => ({
      phase: p.phase,
      severity: p.verdict as "elevated" | "extreme",
      headline:
        `${p.phase} time ${p.multipleOfMedian !== null ? `${p.multipleOfMedian}× ` : "above "}` +
        `the site median (${p.observedMinutes} min vs ${p.medianMinutes} min)` +
        (p.observationConfirmation === "confirmed" ? "" : ` — timing ${p.observationConfirmation}`),
      observedMinutes: p.observedMinutes as number,
      medianMinutes: p.medianMinutes as number,
      sampleCount: args.baseline.phases[p.phase].sampleCount,
      observationConfirmation: p.observationConfirmation,
    }));

  return {
    site: args.baseline.site,
    tripStopId: args.tripStopId ?? null,
    phases,
    alerts,
    unmeasuredPhases: phases.filter(p => p.verdict === "insufficient_history").map(p => p.phase),
  };
}

/**
 * One line an office queue can display for a site with no baseline yet.
 * Returns null when the site is measured, so callers can render nothing.
 */
export function unmeasuredSiteNotice(baseline: SiteBaseline): string | null {
  if (!baseline.unmeasured) return null;
  const total = baseline.phases.total;
  const ref =
    baseline.site.facilityId !== null ? `facility ${baseline.site.facilityId}`
      : baseline.site.locationId !== null ? `location ${baseline.site.locationId}`
        : "this site";

  const parts: string[] = [];
  if (total.excludedUnconfirmed > 0) parts.push(`${total.excludedUnconfirmed} awaiting confirmation`);
  if (total.excludedUnknownProvenance > 0) {
    parts.push(`${total.excludedUnknownProvenance} with no recorded provenance`);
  }
  if (total.excludedApproximate > 0) parts.push(`${total.excludedApproximate} approximate`);

  return (
    `No ${baseline.site.stopType} baseline for ${ref}: ` +
    `${total.sampleCount} confirmed stop(s) on file, ${MINIMUM_SAMPLES} needed` +
    (parts.length > 0 ? `; excluded — ${parts.join(", ")}` : "")
  );
}
