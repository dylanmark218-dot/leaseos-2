/**
 * v22.20 — The HOS rule profiles, seeded unverified.
 *
 * These are candidate rows carrying their citation, not regulatory truth. Every
 * profile and every limit lands `unverified`, which means `determine` returns
 * UNKNOWN for it — with the clocks still shown, because the hours a driver
 * worked are a fact even when the rule they are judged against is not.
 *
 * This is P9 applied to hours of service: nothing here determines anything
 * until a controller opens the cited regulation and verifies the row against
 * it. The figures below came from research with citations attached; they were
 * not verified against the regulations by the process that wrote this file, and
 * the unverified status is what keeps that honest rather than confidently
 * wrong.
 *
 * Two profiles are seeded deliberately EMPTY — BC oil-well service and the
 * territorial schedules. Their provisions are real and this file does not
 * capture them. A profile with no limits determines nothing and says so, which
 * is the correct answer while the numbers are unread, and better than filling
 * them in from the nearest similar regime.
 */

import type { HosLimit, HosRuleProfile, LimitKey } from "./hos";

export const HOS_SEED_RETRIEVAL_DATE = new Date("2026-09-11T00:00:00Z");

const FEDERAL_CITATION = "Commercial Vehicle Drivers Hours of Service Regulations (Canada)";
const h = (hours: number) => Math.round(hours * 60);

/** Every seeded limit is unverified; the section is the clause to check it against. */
const lim = (limitKey: LimitKey, value: number, sourceSection: string | null = null): HosLimit =>
  ({ limitKey, value, sourceSection, verificationStatus: "unverified" });

const profile = (o: Omit<HosRuleProfile, "verificationStatus">): HosRuleProfile => ({ ...o, verificationStatus: "unverified" });

/** The daily/shift figures common to the federal schedule and most provincial general regimes. */
const STANDARD_DAY: HosLimit[] = [
  lim("daily_drive_minutes", h(13)),
  lim("daily_on_duty_minutes", h(14)),
  lim("shift_drive_minutes", h(13)),
  lim("shift_on_duty_minutes", h(14)),
  lim("shift_elapsed_minutes", h(16)),
  lim("daily_off_duty_minutes", h(10)),
  lim("core_rest_minutes", h(8)),
];

const STANDARD_CYCLES: HosLimit[] = [
  lim("cycle_1_on_duty_minutes", h(70)),
  lim("cycle_1_days", 7),
  lim("cycle_2_on_duty_minutes", h(120)),
  lim("cycle_2_days", 14),
  lim("cycle_2_interim_on_duty_minutes", h(70)),
  lim("cycle_1_reset_minutes", h(36)),
  lim("cycle_2_reset_minutes", h(72)),
  lim("mandatory_rest_within_days", 14),
  lim("mandatory_rest_minutes", h(24)),
];

/* ------------------------------------------------------------------ */
/* Federal                                                              */
/* ------------------------------------------------------------------ */

export const FEDERAL_PROFILES: readonly HosRuleProfile[] = [
  profile({
    profileKey: "CA_FEDERAL_SOUTH60",
    label: "Federal — south of latitude 60°N",
    applicability: { authorityLevel: "federal", jurisdiction: null, latitudeRule: "south_of_60", minimumWeightKg: null, operationClass: null },
    // The daily driving candidate carries the section it came from, so a
    // verifier opening the console is told where to look instead of having to
    // find it. Seeded rather than applied by script: a script-applied citation
    // does not survive a database rebuild, which is how this was found.
    limits: [
      lim("daily_drive_minutes", h(13), "12(1)"),
      ...STANDARD_DAY.filter((l) => l.limitKey !== "daily_drive_minutes"),
      ...STANDARD_CYCLES,
    ],
    sourceAuthority: "Transport Canada",
    sourceCitation: FEDERAL_CITATION,
  }),
  profile({
    profileKey: "CA_FEDERAL_NORTH60",
    label: "Federal — north of latitude 60°N",
    applicability: { authorityLevel: "federal", jurisdiction: null, latitudeRule: "north_of_60", minimumWeightKg: null, operationClass: null },
    // North of 60 has a distinct daily driving regime. The candidate below is
    // derived from the northern division's own driving section and still
    // requires human verification before it determines anything.
    //
    // HISTORY — this seed previously reused the southern 13-hour value, with a
    // comment reading "the northern schedule differs at the cycle, not the
    // day". That was wrong: the southern figure sits at s. 12(1) inside the
    // division s. 11 opens, and the northern division opens at s. 37 with its
    // own driving section at s. 39(1). The adverse-driving provision at s. 76
    // corroborates the split by referring to the two permitted periods
    // separately.
    //
    // Kept rather than deleted, because "this once said 780" is the part a
    // reviewer most needs and the part a silent correction destroys.
    //
    // STILL CONTESTED — on duty. The same northern section states an on-duty
    // figure alongside the driving one, so `daily_on_duty_minutes` below is
    // very likely reused from the south in the same way this was. It has NOT
    // been changed here: 0093A was scoped to daily driving, and correcting a
    // second figure on the strength of the same reading, without being asked,
    // is how one good correction becomes three unexamined ones.
    limits: [
      lim("daily_drive_minutes", h(15), "39(1)"),
      ...STANDARD_DAY.filter((l) => l.limitKey !== "daily_drive_minutes"),
      lim("cycle_1_on_duty_minutes", h(80)),
      lim("cycle_1_days", 7),
      lim("cycle_2_on_duty_minutes", h(120)),
      lim("cycle_2_days", 14),
      lim("cycle_2_interim_on_duty_minutes", h(80)),
      lim("cycle_1_reset_minutes", h(36)),
      lim("cycle_2_reset_minutes", h(72)),
      lim("mandatory_rest_within_days", 14),
      lim("mandatory_rest_minutes", h(24)),
    ],
    sourceAuthority: "Transport Canada",
    sourceCitation: `${FEDERAL_CITATION} — provisions for north of latitude 60°N`,
  }),
];

/* ------------------------------------------------------------------ */
/* Provincial                                                           */
/* ------------------------------------------------------------------ */

export const PROVINCIAL_PROFILES: readonly HosRuleProfile[] = [
  /**
   * Alberta's provincial regime is not the federal schedule with a different
   * name. It is a 13-drive / 15-on-duty shift framework with an 8-hour rest,
   * and it carries a break rule the federal schedule does not — which is
   * exactly the sort of clause a paper log loses and a registry should not.
   */
  profile({
    profileKey: "AB_PROVINCIAL",
    label: "Alberta — carriers operating solely within Alberta",
    applicability: { authorityLevel: "provincial", jurisdiction: "AB", latitudeRule: null, minimumWeightKg: 11_794, operationClass: null },
    limits: [
      lim("daily_drive_minutes", h(13)),
      lim("daily_on_duty_minutes", h(15)),
      lim("shift_drive_minutes", h(13)),
      lim("shift_on_duty_minutes", h(15)),
      lim("core_rest_minutes", h(8)),
      lim("break_required_after_drive_minutes", h(4)),
      lim("break_minutes", 10),
      lim("reduced_rest_floor_minutes", h(4)),
    ],
    sourceAuthority: "Government of Alberta",
    sourceCitation: "Alberta provincial hours of service for carriers operating solely within Alberta",
  }),

  profile({
    profileKey: "BC_GENERAL",
    label: "British Columbia — general",
    applicability: { authorityLevel: "provincial", jurisdiction: "BC", latitudeRule: null, minimumWeightKg: null, operationClass: null },
    limits: [...STANDARD_DAY, ...STANDARD_CYCLES],
    sourceAuthority: "Province of British Columbia",
    sourceCitation: "British Columbia commercial vehicle hours of service",
  }),

  /** Logging is its own regime, not a variant — 15 on-duty, 9 off, and a cycle in driving hours. */
  profile({
    profileKey: "BC_LOGGING",
    label: "British Columbia — logging trucks",
    applicability: { authorityLevel: "provincial", jurisdiction: "BC", latitudeRule: null, minimumWeightKg: null, operationClass: "logging" },
    limits: [
      lim("daily_drive_minutes", h(13)),
      lim("daily_on_duty_minutes", h(15)),
      lim("shift_drive_minutes", h(13)),
      lim("shift_on_duty_minutes", h(15)),
      lim("core_rest_minutes", h(9)),
      lim("cycle_1_on_duty_minutes", h(80)),
      lim("cycle_1_days", 7),
    ],
    sourceAuthority: "Province of British Columbia",
    sourceCitation: "British Columbia logging truck hours of service provisions",
  }),

  /**
   * Seeded with no limits on purpose. BC's oil-well service provisions are
   * real and this file does not capture their figures. An empty profile
   * determines nothing and says so — which beats borrowing the general
   * schedule's numbers and presenting them as this regime's.
   */
  profile({
    profileKey: "BC_OIL_WELL_SERVICE",
    label: "British Columbia — oil well service (provisions not captured)",
    applicability: { authorityLevel: "provincial", jurisdiction: "BC", latitudeRule: null, minimumWeightKg: null, operationClass: "oil_well_service" },
    limits: [],
    sourceAuthority: "Province of British Columbia",
    sourceCitation: "British Columbia oil well service hours of service provisions — figures not loaded",
  }),

  profile({
    profileKey: "SK_PROVINCIAL",
    label: "Saskatchewan — carriers operating within Saskatchewan",
    applicability: { authorityLevel: "provincial", jurisdiction: "SK", latitudeRule: null, minimumWeightKg: null, operationClass: null },
    limits: [...STANDARD_DAY, ...STANDARD_CYCLES],
    sourceAuthority: "Saskatchewan Government Insurance",
    sourceCitation: "Saskatchewan provincial hours of service",
  }),
  profile({
    profileKey: "MB_PROVINCIAL",
    label: "Manitoba",
    applicability: { authorityLevel: "provincial", jurisdiction: "MB", latitudeRule: null, minimumWeightKg: null, operationClass: null },
    limits: [...STANDARD_DAY, ...STANDARD_CYCLES],
    sourceAuthority: "Province of Manitoba",
    sourceCitation: "Manitoba hours of service",
  }),
  profile({
    profileKey: "ON_GENERAL",
    label: "Ontario — general",
    applicability: { authorityLevel: "provincial", jurisdiction: "ON", latitudeRule: null, minimumWeightKg: null, operationClass: null },
    limits: [...STANDARD_DAY, ...STANDARD_CYCLES],
    sourceAuthority: "Province of Ontario",
    sourceCitation: "Ontario hours of service",
  }),
  profile({
    profileKey: "QC_GENERAL",
    label: "Québec — general",
    applicability: { authorityLevel: "provincial", jurisdiction: "QC", latitudeRule: null, minimumWeightKg: null, operationClass: null },
    limits: [...STANDARD_DAY, ...STANDARD_CYCLES],
    sourceAuthority: "Gouvernement du Québec",
    sourceCitation: "Québec hours of service — note jurisdiction-specific daily-rest deferral provisions not captured here",
  }),
  ...(["NB", "NS", "PE", "NL"] as const).map(j =>
    profile({
      profileKey: `${j}_GENERAL`,
      label: `${j} — general`,
      applicability: { authorityLevel: "provincial", jurisdiction: j, latitudeRule: null, minimumWeightKg: null, operationClass: null },
      limits: [...STANDARD_DAY, ...STANDARD_CYCLES],
      sourceAuthority: `Province of ${j}`,
      sourceCitation: `${j} commercial vehicle drivers hours of service regulations — versioned separately, not assumed identical to the federal text`,
    })
  ),
];

/* ------------------------------------------------------------------ */
/* Territorial                                                          */
/* ------------------------------------------------------------------ */

/**
 * Seeded with no limits. Northern operation produces a different permitted
 * schedule, and which figures apply depends on how each territory adopts the
 * federal framework. Empty profiles keep the selector able to find a
 * territorial answer while every determination stays UNKNOWN.
 */
export const TERRITORIAL_PROFILES: readonly HosRuleProfile[] = (["YT", "NT", "NU"] as const).map(j =>
  profile({
    profileKey: `${j}_NORTH60`,
    label: `${j} — north of 60°N (figures not loaded)`,
    applicability: { authorityLevel: "territorial", jurisdiction: j, latitudeRule: "north_of_60", minimumWeightKg: null, operationClass: null },
    limits: [],
    sourceAuthority: `Government of ${j}`,
    sourceCitation: `${j} hours of service — adoption of the federal framework; figures not loaded`,
  })
);

export const ALL_HOS_PROFILE_SEEDS: readonly HosRuleProfile[] = [
  ...FEDERAL_PROFILES,
  ...PROVINCIAL_PROFILES,
  ...TERRITORIAL_PROFILES,
];

export const HOS_SEED_CAVEAT =
  "Seeded from research with citations and unverified. No limit here determines anything until a controller verifies it against the cited regulation; until then every determination reads UNKNOWN and the clocks are shown without a compliance answer.";
