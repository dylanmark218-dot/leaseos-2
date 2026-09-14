/**
 * v22.20 — Hours of service as versioned rules, not code.
 *
 * Pure. No network, no database.
 *
 * Three refusals shape this module.
 *
 * IT REFUSES TO BE ONE FORMULA. There is no "Canadian HOS". A truck's
 * applicable schedule depends on the carrier's operating authority, the
 * jurisdiction, the vehicle's weight class, the kind of operation, whether the
 * trip crossed a border, and whether it is north of the sixtieth parallel.
 * Alberta alone needs two profiles that are not variants of each other: a
 * federally regulated carrier runs 13/14/16 with 70-and-7, and an
 * Alberta-only carrier runs a 13-drive / 15-on-duty shift framework. Writing
 * either into code makes the other wrong.
 *
 * IT REFUSES TO GUESS THE PROFILE. Selecting "Alberta" from a dropdown is not
 * a legal determination. The selector walks the same ladder an auditor would —
 * authority, jurisdiction, vehicle, operation, latitude — and when a rung is
 * not established it answers UNKNOWN and names the rung, rather than falling
 * through to whichever profile is most common.
 *
 * IT REFUSES TO COMPUTE A LIMIT NOBODY HAS VERIFIED. Every figure lives in the
 * registry with a citation and a verification status. An unverified limit
 * produces UNKNOWN, never a number, because a driver told "1h 42m remaining"
 * against a rule nobody checked has been told something worse than nothing.
 *
 * And one positive commitment: the clocks are separate. `hoursRemaining` as a
 * single value is the bug that this shape exists to prevent — driving, on-duty,
 * the elapsed window and two cycles run at different speeds and stop for
 * different reasons.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

/** The four legal statuses. Operational sub-statuses roll up to these and never replace them. */
export type DutyStatus = "driving" | "on_duty" | "sleeper_berth" | "off_duty";

export const ON_DUTY_STATUSES: readonly DutyStatus[] = ["driving", "on_duty"];
export const REST_STATUSES: readonly DutyStatus[] = ["off_duty", "sleeper_berth"];

/**
 * Every limit the registry can carry. A profile supplies the ones its
 * jurisdiction states and omits the rest; an omitted limit is not zero and not
 * unlimited — it is simply not stated, and reads UNKNOWN.
 */
export const LIMIT_KEYS = [
  "daily_drive_minutes",
  "daily_on_duty_minutes",
  "shift_drive_minutes",
  "shift_on_duty_minutes",
  "shift_elapsed_minutes",
  "daily_off_duty_minutes",
  "core_rest_minutes",
  "cycle_1_on_duty_minutes",
  "cycle_1_days",
  "cycle_2_on_duty_minutes",
  "cycle_2_days",
  "cycle_2_interim_on_duty_minutes",
  "cycle_1_reset_minutes",
  "cycle_2_reset_minutes",
  "mandatory_rest_within_days",
  "mandatory_rest_minutes",
  "break_required_after_drive_minutes",
  "break_minutes",
  "reduced_rest_floor_minutes",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LIMIT_LABELS: Record<LimitKey, string> = {
  daily_drive_minutes: "driving in a day",
  daily_on_duty_minutes: "on duty in a day",
  shift_drive_minutes: "driving in a work shift",
  shift_on_duty_minutes: "on duty in a work shift",
  shift_elapsed_minutes: "elapsed time in a work shift",
  daily_off_duty_minutes: "off duty in a day",
  core_rest_minutes: "consecutive core rest",
  cycle_1_on_duty_minutes: "on duty in cycle 1",
  cycle_1_days: "days in cycle 1",
  cycle_2_on_duty_minutes: "on duty in cycle 2",
  cycle_2_days: "days in cycle 2",
  cycle_2_interim_on_duty_minutes: "on duty before the cycle 2 interim rest",
  cycle_1_reset_minutes: "consecutive rest to reset cycle 1",
  cycle_2_reset_minutes: "consecutive rest to reset cycle 2",
  mandatory_rest_within_days: "days within which a mandatory rest falls",
  mandatory_rest_minutes: "consecutive mandatory rest",
  break_required_after_drive_minutes: "driving before a break is required",
  break_minutes: "that break",
  reduced_rest_floor_minutes: "the floor a reduced rest may not go below",
};

export type VerificationStatus = "unverified" | "verified" | "superseded";

/* ------------------------------------------------------------------ */
/* The registry                                                         */
/* ------------------------------------------------------------------ */

export type AuthorityLevel = "federal" | "provincial" | "territorial";

/** What a profile applies to. Every field is a condition the selector must satisfy. */
export type ProfileApplicability = {
  authorityLevel: AuthorityLevel;
  /** Null means the profile is not confined to one jurisdiction (the federal schedules). */
  jurisdiction: string | null;
  /** `north_of_60`, `south_of_60`, or null for profiles that do not turn on latitude. */
  latitudeRule: "north_of_60" | "south_of_60" | null;
  /** Registered or actual weight at or above which the profile applies, in kilograms. */
  minimumWeightKg: number | null;
  /** `general`, `logging`, `oil_well_service`, … — null means any operation. */
  operationClass: string | null;
};

export type HosLimit = {
  limitKey: LimitKey;
  value: number;
  /** The clause this number came from, so a determination can cite it. */
  sourceSection: string | null;
  verificationStatus: VerificationStatus;
};

export type HosRuleProfile = {
  profileKey: string;
  label: string;
  applicability: ProfileApplicability;
  limits: HosLimit[];
  sourceAuthority: string;
  sourceCitation: string;
  sourceUrl?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  verificationStatus: VerificationStatus;
  supersedesProfileKey?: string | null;
};

export const inForce = (p: { effectiveFrom?: Date | null; effectiveTo?: Date | null }, at: Date): boolean =>
  (!p.effectiveFrom || p.effectiveFrom.getTime() <= at.getTime()) && (!p.effectiveTo || p.effectiveTo.getTime() > at.getTime());

/* ------------------------------------------------------------------ */
/* Selecting the profile                                                */
/* ------------------------------------------------------------------ */

/**
 * What is known about the trip. Every field is optional because the point of
 * this type is to describe incomplete knowledge honestly — an absent field is
 * a rung of the ladder nobody has established, and the selector says so.
 */
export type OperatingContext = {
  /** Federal when the carrier operates across a provincial, territorial or international boundary. */
  carrierAuthority?: AuthorityLevel | null;
  jurisdiction?: string | null;
  crossedBoundary?: boolean | null;
  registeredWeightKg?: number | null;
  operationClass?: string | null;
  latitude?: number | null;
  at: Date;
};

export const NORTH_OF_60 = 60;

export type SelectionOutcome =
  | { outcome: "selected"; profile: HosRuleProfile; reasons: string[]; alsoApplicable: string[] }
  | { outcome: "unknown"; reasons: string[]; missing: string[]; candidates: string[] }
  | { outcome: "conflict"; reasons: string[]; candidates: string[] };

/**
 * Walk the ladder: authority, jurisdiction, vehicle, operation, latitude.
 *
 * A rung that is not established stops the walk. It does not fall through to
 * the federal schedule because the federal schedule is the most common, and it
 * does not fall through to the province the truck happens to be standing in —
 * a carrier's authority, not its position, decides which regime applies.
 */
export function selectProfile(context: OperatingContext, profiles: readonly HosRuleProfile[]): SelectionOutcome {
  const missing: string[] = [];
  if (context.carrierAuthority == null) missing.push("the carrier's operating authority (federal or provincial) is not established");
  if (context.jurisdiction == null) missing.push("the jurisdiction of operation is not established");
  if (context.latitude == null) missing.push("no position is established, so whether this is north of 60°N is unknown");
  if (missing.length) {
    return { outcome: "unknown", reasons: ["The applicable schedule cannot be determined from what is known"], missing, candidates: [] };
  }

  const authority = context.carrierAuthority!;
  const latitudeRule = context.latitude! >= NORTH_OF_60 ? "north_of_60" : "south_of_60";
  const live = profiles.filter(p => p.verificationStatus !== "superseded" && inForce(p, context.at));

  const candidates = live.filter(p => {
    const a = p.applicability;
    if (a.authorityLevel !== authority) return false;
    if (a.jurisdiction != null && a.jurisdiction !== context.jurisdiction) return false;
    if (a.latitudeRule != null && a.latitudeRule !== latitudeRule) return false;
    if (a.minimumWeightKg != null) {
      if (context.registeredWeightKg == null) return false;      // cannot be satisfied by an unknown weight
      if (context.registeredWeightKg < a.minimumWeightKg) return false;
    }
    if (a.operationClass != null && a.operationClass !== context.operationClass) return false;
    return true;
  });

  if (!candidates.length) {
    const weightUnknown = context.registeredWeightKg == null && live.some(p => p.applicability.minimumWeightKg != null);
    return {
      outcome: "unknown",
      reasons: [`No profile on record applies to a ${authority} carrier in ${context.jurisdiction} ${latitudeRule.replace(/_/g, " ")}`],
      missing: weightUnknown ? ["the vehicle's registered weight is not established, and profiles here turn on it"] : [],
      candidates: [],
    };
  }

  // Specificity: an operation-specific profile governs over a general one, and a
  // jurisdiction-specific one over a nationwide schedule. Equal specificity is a
  // conflict a person settles — never a coin toss resolved by insertion order.
  const specificity = (p: HosRuleProfile) =>
    (p.applicability.operationClass != null ? 4 : 0) + (p.applicability.jurisdiction != null ? 2 : 0) + (p.applicability.latitudeRule != null ? 1 : 0);
  const ranked = [...candidates].sort((a, b) => specificity(b) - specificity(a));
  const top = ranked.filter(p => specificity(p) === specificity(ranked[0]));
  if (top.length > 1) {
    return {
      outcome: "conflict",
      reasons: [`${top.length} profiles apply equally to this operation — a person decides which governs`],
      candidates: top.map(p => p.profileKey),
    };
  }

  const profile = ranked[0];
  const reasons = [
    `${authority} authority${context.crossedBoundary ? " (the trip crossed a boundary)" : ""}`,
    `jurisdiction ${context.jurisdiction}`,
    latitudeRule === "north_of_60" ? `latitude ${context.latitude!.toFixed(4)}N — north of 60°N` : `latitude ${context.latitude!.toFixed(4)}N — south of 60°N`,
    profile.applicability.operationClass ? `operation ${profile.applicability.operationClass}` : "general operation",
    profile.applicability.minimumWeightKg ? `registered weight ${context.registeredWeightKg} kg, at or above the ${profile.applicability.minimumWeightKg} kg threshold` : "no weight threshold on this profile",
  ];
  if (profile.verificationStatus !== "verified") {
    reasons.push(`${profile.profileKey} is unverified — its limits are candidates from ${profile.sourceCitation} and determine nothing until a person verifies them`);
  }
  return { outcome: "selected", profile, reasons, alsoApplicable: ranked.slice(1).map(p => p.profileKey) };
}

/* ------------------------------------------------------------------ */
/* The clocks                                                           */
/* ------------------------------------------------------------------ */

export type DutyEntry = { dutyStatus: DutyStatus; startedAt: Date; endedAt: Date | null };

/**
 * Every clock, separately. There is deliberately no `hoursRemaining` here:
 * driving, on duty, the elapsed window and the two cycles run at different
 * speeds and stop for different reasons, and collapsing them is the bug this
 * shape exists to prevent.
 */
export type Clocks = {
  continuousDriveMinutes: number;
  dailyDriveMinutes: number;
  dailyOnDutyMinutes: number;
  dailyOffDutyMinutes: number;
  dailySleeperMinutes: number;
  shiftDriveMinutes: number;
  shiftOnDutyMinutes: number;
  shiftElapsedMinutes: number;
  /** The rest that ended the last shift, which is what a core-rest rule reads. */
  lastRestMinutes: number;
  /** The longest single rest in the cycle-reset windows. */
  longestRestInCycle1Minutes: number;
  longestRestInCycle2Minutes: number;
  cycle1OnDutyMinutes: number;
  cycle2OnDutyMinutes: number;
  /** Hours since the last rest long enough to satisfy a mandatory periodic rest. */
  sinceMandatoryRestHours: number | null;
  currentStatus: DutyStatus | null;
  currentStatusMinutes: number;
};

const minutesBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 60_000);
const overlapMinutes = (e: DutyEntry, from: Date, to: Date) => {
  const start = Math.max(e.startedAt.getTime(), from.getTime());
  const end = Math.min((e.endedAt ?? to).getTime(), to.getTime());
  return Math.max(0, (end - start) / 60_000);
};

/**
 * Compute the clocks from the duty record. The work shift is taken to begin
 * after the most recent rest of at least `shiftResetMinutes` — supplied by the
 * profile rather than assumed, because "what ends a shift" is itself a rule
 * that differs between jurisdictions.
 */
export function computeClocks(
  entries: readonly DutyEntry[],
  at: Date,
  opts: { shiftResetMinutes?: number; cycle1Days?: number; cycle2Days?: number; mandatoryRestMinutes?: number } = {}
): Clocks {
  const shiftReset = opts.shiftResetMinutes ?? 480;   // the common core-rest figure; the caller passes the profile's
  const ordered = [...entries].filter(e => e.startedAt.getTime() <= at.getTime()).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const day = new Date(at.getTime() - 24 * 60 * 60_000);
  const c1From = new Date(at.getTime() - (opts.cycle1Days ?? 7) * 24 * 60 * 60_000);
  const c2From = new Date(at.getTime() - (opts.cycle2Days ?? 14) * 24 * 60 * 60_000);

  const durationOf = (e: DutyEntry) => minutesBetween(e.startedAt, e.endedAt ?? at);
  const rests = ordered.filter(e => REST_STATUSES.includes(e.dutyStatus));

  // The shift begins after the last rest long enough to end one.
  const shiftEnding = [...rests].reverse().find(e => durationOf(e) >= shiftReset);
  const shiftFrom = shiftEnding ? (shiftEnding.endedAt ?? at) : (ordered[0]?.startedAt ?? at);

  const sum = (pred: (e: DutyEntry) => boolean, from: Date) => ordered.filter(pred).reduce((a, e) => a + overlapMinutes(e, from, at), 0);

  const current = ordered.filter(e => e.endedAt == null || e.endedAt.getTime() > at.getTime()).slice(-1)[0] ?? null;

  // Continuous driving: back through the record until something that is not driving.
  let continuousDrive = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    if (e.dutyStatus !== "driving") break;
    continuousDrive += overlapMinutes(e, new Date(0), at);
  }

  const longestRestSince = (from: Date) => rests.reduce((m, e) => Math.max(m, overlapMinutes(e, from, at)), 0);
  const mandatory = opts.mandatoryRestMinutes ?? null;
  const lastMandatory = mandatory == null ? null : [...rests].reverse().find(e => durationOf(e) >= mandatory) ?? null;

  return {
    continuousDriveMinutes: Math.round(continuousDrive),
    dailyDriveMinutes: Math.round(sum(e => e.dutyStatus === "driving", day)),
    dailyOnDutyMinutes: Math.round(sum(e => ON_DUTY_STATUSES.includes(e.dutyStatus), day)),
    dailyOffDutyMinutes: Math.round(sum(e => e.dutyStatus === "off_duty", day)),
    dailySleeperMinutes: Math.round(sum(e => e.dutyStatus === "sleeper_berth", day)),
    shiftDriveMinutes: Math.round(sum(e => e.dutyStatus === "driving", shiftFrom)),
    shiftOnDutyMinutes: Math.round(sum(e => ON_DUTY_STATUSES.includes(e.dutyStatus), shiftFrom)),
    shiftElapsedMinutes: Math.round(minutesBetween(shiftFrom, at)),
    lastRestMinutes: shiftEnding ? Math.round(durationOf(shiftEnding)) : 0,
    longestRestInCycle1Minutes: Math.round(longestRestSince(c1From)),
    longestRestInCycle2Minutes: Math.round(longestRestSince(c2From)),
    cycle1OnDutyMinutes: Math.round(sum(e => ON_DUTY_STATUSES.includes(e.dutyStatus), c1From)),
    cycle2OnDutyMinutes: Math.round(sum(e => ON_DUTY_STATUSES.includes(e.dutyStatus), c2From)),
    sinceMandatoryRestHours: lastMandatory ? Math.round(minutesBetween(lastMandatory.endedAt ?? at, at) / 60) : null,
    currentStatus: current?.dutyStatus ?? null,
    currentStatusMinutes: current ? Math.round(minutesBetween(current.startedAt, at)) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Determination                                                        */
/* ------------------------------------------------------------------ */

export type LimitResult = "within" | "exceeded" | "unknown";

export type LimitDetermination = {
  limitKey: LimitKey;
  result: LimitResult;
  /** The clock, always. A driver is entitled to see what has been counted. */
  usedMinutes: number | null;
  /** The limit, only when a person has verified it. */
  limitMinutes: number | null;
  /** Remaining, only when both the clock and a verified limit exist. */
  remainingMinutes: number | null;
  sourceSection: string | null;
  reason: string;
};

export type HosDetermination = {
  profileKey: string | null;
  profileVerified: boolean;
  /** `unknown` whenever any limit is unknown. It never rounds to compliant. */
  verdict: "within" | "exceeded" | "unknown";
  determinations: LimitDetermination[];
  unknownCount: number;
  exceededCount: number;
  explanation: string;
};

const CLOCK_FOR: Partial<Record<LimitKey, keyof Clocks>> = {
  daily_drive_minutes: "dailyDriveMinutes",
  daily_on_duty_minutes: "dailyOnDutyMinutes",
  shift_drive_minutes: "shiftDriveMinutes",
  shift_on_duty_minutes: "shiftOnDutyMinutes",
  shift_elapsed_minutes: "shiftElapsedMinutes",
  cycle_1_on_duty_minutes: "cycle1OnDutyMinutes",
  cycle_2_on_duty_minutes: "cycle2OnDutyMinutes",
  cycle_2_interim_on_duty_minutes: "cycle2OnDutyMinutes",
  break_required_after_drive_minutes: "continuousDriveMinutes",
};

/**
 * Compare the clocks against the profile's limits.
 *
 * An unverified profile yields UNKNOWN on every limit — with the clock still
 * shown, because the hours worked are a fact even when the rule they are judged
 * against is not. Telling a driver "1h 42m remaining" against a rule nobody has
 * checked is worse than telling them nothing.
 */
export function determine(clocks: Clocks, profile: HosRuleProfile | null): HosDetermination {
  if (!profile) {
    return { profileKey: null, profileVerified: false, verdict: "unknown", determinations: [], unknownCount: 0, exceededCount: 0, explanation: "No applicable schedule has been determined, so no hours-of-service determination is made." };
  }
  const profileVerified = profile.verificationStatus === "verified";
  const determinations: LimitDetermination[] = [];

  for (const limit of profile.limits) {
    const clockKey = CLOCK_FOR[limit.limitKey];
    const used = clockKey ? (clocks[clockKey] as number) : null;
    const limitVerified = profileVerified && limit.verificationStatus === "verified";

    if (!limitVerified) {
      determinations.push({
        limitKey: limit.limitKey, result: "unknown", usedMinutes: used, limitMinutes: null, remainingMinutes: null,
        sourceSection: limit.sourceSection,
        reason: used == null
          ? `${LIMIT_LABELS[limit.limitKey]}: the limit is unverified, and no clock is computed for it`
          : `${LIMIT_LABELS[limit.limitKey]}: ${Math.round(used)} min counted, but the limit is unverified — nothing is determined from it`,
      });
      continue;
    }
    if (used == null) {
      determinations.push({
        limitKey: limit.limitKey, result: "unknown", usedMinutes: null, limitMinutes: limit.value, remainingMinutes: null,
        sourceSection: limit.sourceSection,
        reason: `${LIMIT_LABELS[limit.limitKey]}: the limit is ${limit.value} min, and this engine computes no clock for it yet`,
      });
      continue;
    }
    const exceeded = used > limit.value;
    determinations.push({
      limitKey: limit.limitKey,
      result: exceeded ? "exceeded" : "within",
      usedMinutes: Math.round(used), limitMinutes: limit.value,
      remainingMinutes: exceeded ? 0 : Math.round(limit.value - used),
      sourceSection: limit.sourceSection,
      reason: exceeded
        ? `${LIMIT_LABELS[limit.limitKey]}: ${Math.round(used)} min against a ${limit.value} min limit — exceeded by ${Math.round(used - limit.value)} min`
        : `${LIMIT_LABELS[limit.limitKey]}: ${Math.round(used)} min of ${limit.value} min, ${Math.round(limit.value - used)} min remaining`,
    });
  }

  const unknownCount = determinations.filter(d => d.result === "unknown").length;
  const exceededCount = determinations.filter(d => d.result === "exceeded").length;
  // A profile carrying no figures is not a profile nothing violates. Zero
  // limits broken out of zero limits loaded is UNKNOWN, and saying otherwise
  // would make an unloaded regime the most compliant one in the registry.
  if (!profile.limits.length) {
    return {
      profileKey: profile.profileKey, profileVerified, verdict: "unknown", determinations: [], unknownCount: 0, exceededCount: 0,
      explanation: `${profile.profileKey} carries no figures — its provisions are not loaded, so nothing is determined under it. This is not compliance.`,
    };
  }
  const verdict = exceededCount > 0 ? "exceeded" : unknownCount > 0 ? "unknown" : "within";
  const explanation =
    exceededCount > 0
      ? `${exceededCount} limit(s) exceeded under ${profile.profileKey}: ${determinations.filter(d => d.result === "exceeded").map(d => d.reason).join("; ")}`
      : unknownCount > 0
        ? `${profile.profileKey} is ${profile.verificationStatus}. ${unknownCount} limit(s) determine nothing until a person verifies them against ${profile.sourceCitation}. The clocks are shown; the compliance answer is UNKNOWN.`
        : `Within every limit of ${profile.profileKey}.`;
  return { profileKey: profile.profileKey, profileVerified, verdict, determinations, unknownCount, exceededCount, explanation };
}

/* ------------------------------------------------------------------ */
/* Can this trip be finished legally?                                   */
/* ------------------------------------------------------------------ */

export type TripFeasibility =
  | { feasible: "yes"; marginMinutes: number; reasons: string[] }
  | { feasible: "no"; shortfallMinutes: number; reasons: string[] }
  | { feasible: "unknown"; reasons: string[] };

/**
 * The predictive question — "can this driver legally reach the destination?" —
 * asked against the driving clock only, and answered UNKNOWN whenever the
 * limit behind it is unverified. A dispatcher would rather hear "we cannot say"
 * than a number computed from a rule nobody checked.
 */
export function tripFeasibility(determination: HosDetermination, estimatedDriveMinutes: number): TripFeasibility {
  const drive = determination.determinations.find(d => d.limitKey === "daily_drive_minutes" || d.limitKey === "shift_drive_minutes");
  if (!drive || drive.result === "unknown" || drive.remainingMinutes == null) {
    return { feasible: "unknown", reasons: ["The driving limit that governs here is not verified, so no legal driving time remaining can be stated"] };
  }
  const margin = drive.remainingMinutes - estimatedDriveMinutes;
  return margin >= 0
    ? { feasible: "yes", marginMinutes: Math.round(margin), reasons: [`${drive.remainingMinutes} min of driving remaining against an estimated ${Math.round(estimatedDriveMinutes)} min — ${Math.round(margin)} min of margin`] }
    : { feasible: "no", shortfallMinutes: Math.round(-margin), reasons: [`${drive.remainingMinutes} min of driving remaining against an estimated ${Math.round(estimatedDriveMinutes)} min — the trip cannot be completed legally without rest, short by ${Math.round(-margin)} min`] };
}
