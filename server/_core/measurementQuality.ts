/**
 * Measurement quality — one ladder, one vocabulary.
 *
 * Two independent things in LeaseOS answer "how good is this number":
 * the `measurementMethod` enum on operational records, and the source
 * precedence the onboard-weight branch defines (certified > calibrated >
 * operator-entered > uncalibrated > estimated). Left as parallel vocabularies
 * they drift, and a drifted vocabulary in front of a billing gate does not
 * fail loudly — it fails open.
 *
 * That is not hypothetical. The disposal billability gate previously asked
 * only whether the method string was literally "unknown". Every other string
 * passed, including strings no one had defined yet. Any value arriving from a
 * second vocabulary would have been read as adequate evidence for a charge.
 *
 * So this module is deliberately CLOSED. A method that is not registered here
 * is not "probably fine" — it is `unknown`, and unknown holds the charge.
 * Adding a vocabulary means adding it here, which is the point: the compiler
 * and this ladder become the place the unification has to happen.
 */

/**
 * Every method currently declared in the schema.
 *
 * Note that the two schema enums are not identical today: `loads` omits
 * `system_timed`, `fieldTicketLines` includes it. This union is their superset
 * so one classifier serves both. Narrowing the two enums to a single shared
 * definition is a schema change and is tracked separately — this module makes
 * the divergence safe in the meantime rather than silently absorbing it.
 */
export type MeasurementMethod =
  | "meter"
  | "scale"
  | "gauge"
  | "estimate"
  | "customer_stated"
  | "system_timed"
  | "loadsense_calibrated"
  | "loadsense_uncalibrated"
  | "unknown";

/**
 * Authority tiers, strongest first. Ranks are spaced so a tier can be
 * inserted without renumbering the ladder.
 *
 * `authority_certified` remains intentionally distinct from a generic `scale`
 * method: a scale reading is not automatically a certified legal-for-trade
 * reading. The recovered LoadSense line now occupies the calibrated and
 * uncalibrated instrument tiers. `operator_stated` remains the authority slot
 * for a driver-entered weight source; the operational schema still refuses to
 * turn that source into a billable measurement method by name alone.
 */
export type MeasurementAuthority =
  | "authority_certified"
  | "instrument_calibrated"
  | "instrument_measured"
  | "system_derived"
  | "instrument_uncalibrated"
  | "operator_stated"
  | "counterparty_stated"
  | "estimated"
  | "unknown";

export const MEASUREMENT_AUTHORITY_RANK: Record<MeasurementAuthority, number> =
  {
    authority_certified: 10,
    instrument_calibrated: 20,
    instrument_measured: 25,
    system_derived: 30,
    operator_stated: 40,
    instrument_uncalibrated: 50,
    counterparty_stated: 60,
    estimated: 70,
    unknown: 99,
  };

type LadderEntry = {
  authority: MeasurementAuthority;
  label: string;
  /** Shown wherever the number is offered as evidence for money. */
  detail?: string;
};

const LADDER: Record<MeasurementMethod, LadderEntry> = {
  loadsense_calibrated: {
    authority: "instrument_calibrated",
    label: "Calibrated onboard weight",
    detail: "Calibrated onboard measurement — contract, stability and current-calibration gates still apply before billing",
  },
  loadsense_uncalibrated: {
    authority: "instrument_uncalibrated",
    label: "Uncalibrated onboard weight",
    detail: "Onboard sensor reading without a current accepted calibration — review only, not billable evidence",
  },
  scale: { authority: "instrument_measured", label: "Weighed on a scale" },
  meter: { authority: "instrument_measured", label: "Metered" },
  gauge: { authority: "instrument_measured", label: "Gauged" },
  system_timed: {
    authority: "system_derived",
    label: "Timed by the system",
    detail: "Derived from recorded times, not independently measured",
  },
  customer_stated: {
    authority: "counterparty_stated",
    label: "Stated by the customer",
    detail: "Stated by the customer, not independently measured",
  },
  estimate: {
    authority: "estimated",
    label: "Estimated",
    detail: "Estimated, not weighed — confirm before billing",
  },
  unknown: { authority: "unknown", label: "Not recorded" },
};

export function isRecognizedMeasurementMethod(
  raw: string | null | undefined
): raw is MeasurementMethod {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(LADDER, raw);
}

export type MeasurementClassification = {
  /** The recognized method, or `unknown` for null/absent/unregistered input. */
  method: MeasurementMethod;
  /** False when the input was absent or came from a vocabulary we do not know. */
  recognized: boolean;
  authority: MeasurementAuthority;
  rank: number;
  label: string;
  detail?: string;
  /**
   * Whether this number is adequate provenance to stand behind a charge on
   * its own. Unknown never is. This is not the same as "billable" — human
   * verification is a separate gate and is never inferred from this.
   */
  adequateForCharge: boolean;
  /** The unrecognized string, preserved so the gap is reportable, not lost. */
  unrecognizedValue?: string;
};

/**
 * Classify a method string. Fails closed: anything unregistered is `unknown`.
 */
export function classifyMeasurementMethod(
  raw: string | null | undefined
): MeasurementClassification {
  if (isRecognizedMeasurementMethod(raw)) {
    const entry = LADDER[raw];
    return {
      method: raw,
      recognized: true,
      authority: entry.authority,
      rank: MEASUREMENT_AUTHORITY_RANK[entry.authority],
      label: entry.label,
      detail: entry.detail,
      adequateForCharge: raw !== "unknown" && raw !== "loadsense_uncalibrated" && raw !== "loadsense_calibrated",
    };
  }

  const entry = LADDER.unknown;
  const unrecognizedValue =
    typeof raw === "string" && raw.length > 0 ? raw : undefined;

  return {
    method: "unknown",
    recognized: false,
    authority: entry.authority,
    rank: MEASUREMENT_AUTHORITY_RANK[entry.authority],
    label: entry.label,
    detail: unrecognizedValue
      ? `Unrecognized measurement method "${unrecognizedValue}" — held for review`
      : undefined,
    adequateForCharge: false,
    unrecognizedValue,
  };
}

/**
 * Compare two methods by authority. Negative when `a` is the stronger
 * evidence, positive when `b` is, zero when they sit in the same tier.
 *
 * This is the precedence resolver for the case where two sources describe the
 * same movement and disagree. It ranks the evidence; it does not discard the
 * loser. Both measurements survive — deciding which one bills is a separate,
 * human decision.
 */
export function compareMeasurementQuality(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  return classifyMeasurementMethod(a).rank - classifyMeasurementMethod(b).rank;
}

/** The stronger of two methods, for display alongside — never instead of — both. */
export function strongerMeasurementMethod(
  a: string | null | undefined,
  b: string | null | undefined
): MeasurementMethod {
  return compareMeasurementQuality(a, b) <= 0
    ? classifyMeasurementMethod(a).method
    : classifyMeasurementMethod(b).method;
}


export type WeightSource = "estimated" | "driver_entered" | "loadsense_uncalibrated" | "loadsense_calibrated" | "certified_scale";

export function authorityForWeightSource(source: WeightSource): MeasurementAuthority {
  switch (source) {
    case "certified_scale": return "authority_certified";
    case "loadsense_calibrated": return "instrument_calibrated";
    case "driver_entered": return "operator_stated";
    case "loadsense_uncalibrated": return "instrument_uncalibrated";
    case "estimated": return "estimated";
  }
}

export function measurementAuthorityRank(authority: MeasurementAuthority): number {
  return MEASUREMENT_AUTHORITY_RANK[authority];
}

export function methodForWeightSource(source: WeightSource): MeasurementMethod {
  switch (source) {
    case "certified_scale": return "scale";
    case "loadsense_calibrated": return "loadsense_calibrated";
    case "loadsense_uncalibrated": return "loadsense_uncalibrated";
    case "estimated": return "estimate";
    case "driver_entered": return "unknown";
  }
}
