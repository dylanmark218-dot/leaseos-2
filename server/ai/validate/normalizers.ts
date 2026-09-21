/**
 * The reasoning that does not live in the model.
 *
 * Every rule here is one the prompt tells the model never to apply: do not
 * convert units, do not pick an AM/PM, do not complete a ticket number, do not
 * resolve a land description. The model records what was said; these functions
 * decide what it means, and they are testable, auditable and identical on every
 * run. A rule in code is a rule. A rule in a prompt is a preference.
 *
 * All four are pure, and all four return a verdict rather than a value where
 * the honest answer is "ask". "Dumped sixteen" is not sixteen cubic metres
 * because sixteen cubic metres is the common case; it is a number with no unit,
 * and the driver is the only one who knows which.
 */

import { approximateFromLegalLocation } from "../../_core/legalLocation";

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

/**
 * The five answers, matching `ComplianceVerdict` in
 * `server/_core/actionGateway.ts` rather than inventing a parallel vocabulary,
 * plus the one that file does not need:
 *
 *   PASS           — checked, and it holds.
 *   REVIEW         — checked, and a person should look.
 *   BLOCKED        — checked, and it breaks a hard rule.
 *   UNKNOWN        — asked, and could not be established.
 *   NOT_EVALUATED  — never asked, because the input to ask with is absent.
 *
 * The last two are separate for the reason `server/_core/automationPolicy.ts`
 * separates a missing policy from a missing entitlement: "we looked and could
 * not tell" and "we had nothing to look at" have different remedies, and
 * collapsing them makes a forgotten data source indistinguishable from a
 * genuine ambiguity. Neither ever rounds up to PASS.
 */
export type Verdict = "PASS" | "REVIEW" | "BLOCKED" | "UNKNOWN" | "NOT_EVALUATED";

export type NormalizerResult<T> = {
  verdict: Verdict;
  value: T | null;
  /** A stable code, so a question template and a test can both key on it. */
  reasonCode: string;
  /** What to say to a person, in words. */
  detail: string;
};

/* ------------------------------------------------------------------ */
/* Volume                                                              */
/* ------------------------------------------------------------------ */

/**
 * Units a driver says out loud, mapped to nothing.
 *
 * Deliberately: the spoken unit is kept as spoken. Converting barrels to litres
 * here would put a conversion between the driver's words and the stored value,
 * and the first time a conversion factor is wrong every record made under it is
 * wrong and nothing says so. The form's declared unit and the spoken unit are
 * compared; a mismatch is a question, not a multiplication.
 */
export const SPOKEN_VOLUME_UNITS: Readonly<Record<string, string>> = {
  litre: "L", litres: "L", liter: "L", liters: "L", l: "L",
  "cubic metre": "m3", "cubic metres": "m3", "cubic meter": "m3", "cubic meters": "m3",
  m3: "m3", cube: "m3", cubes: "m3",
  barrel: "bbl", barrels: "bbl", bbl: "bbl", bbls: "bbl",
  gallon: "gal", gallons: "gal", gal: "gal",
};

const UNIT_PATTERN = new RegExp(
  `\\b(${Object.keys(SPOKEN_VOLUME_UNITS)
    .sort((a, b) => b.length - a.length)
    .map(u => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "i"
);

export type VolumeReading = { amount: number; unit: string | null };

/**
 * Read a volume out of the driver's own words.
 *
 * `capacityLitres` is the unit's tank capacity when the fleet records one. The
 * survey found `units` has no such column — `capacityLitres` in the schema
 * belongs to `bulkFuelTanks`, a depot tank — so `null` is the common case and
 * it produces NOT_EVALUATED, never a pass. A ceiling nobody configured must not
 * read as a ceiling nobody exceeded.
 */
export function normalizeVolume(args: {
  amount: number | null;
  /** The driver's words for this field, used to find a spoken unit. */
  quote: string | null;
  /** The unit the form stores in, e.g. "L". */
  formUnit: string | null;
  capacityLitres: number | null;
}): NormalizerResult<VolumeReading> {
  const { amount, quote, formUnit, capacityLitres } = args;

  if (amount === null) {
    return { verdict: "NOT_EVALUATED", value: null, reasonCode: "volume_absent", detail: "No volume was stated." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { verdict: "BLOCKED", value: null, reasonCode: "volume_not_positive", detail: `A volume of ${amount} is not a quantity that can be hauled.` };
  }

  const match = quote ? UNIT_PATTERN.exec(quote) : null;
  const spoken = match ? SPOKEN_VOLUME_UNITS[match[1].toLowerCase()] : null;

  if (!spoken) {
    return {
      verdict: "REVIEW",
      value: { amount, unit: null },
      reasonCode: "volume_unit_missing",
      detail: `"${amount}" was said with no unit.`,
    };
  }

  const reading: VolumeReading = { amount, unit: spoken };

  if (formUnit && spoken !== formUnit) {
    // Not converted. The driver is asked, and whatever they confirm is what is
    // recorded, in the unit they confirm it in.
    return {
      verdict: "REVIEW",
      value: reading,
      reasonCode: "volume_unit_mismatch",
      detail: `The driver said ${spoken} and the form records ${formUnit}.`,
    };
  }

  if (capacityLitres === null) {
    return {
      verdict: "NOT_EVALUATED",
      value: reading,
      reasonCode: "capacity_unknown",
      detail: "No tank capacity is recorded for this unit, so the volume was not checked against one.",
    };
  }

  // Only a volume already in the form's own unit can be compared to a capacity
  // in that unit. Anything else went to REVIEW above.
  if (spoken === "L" && amount > capacityLitres) {
    return {
      verdict: "BLOCKED",
      value: reading,
      reasonCode: "volume_over_capacity",
      detail: `${amount} L is more than the unit's ${capacityLitres} L tank holds.`,
    };
  }

  return { verdict: "PASS", value: reading, reasonCode: "volume_ok", detail: "" };
}

/* ------------------------------------------------------------------ */
/* Times                                                               */
/* ------------------------------------------------------------------ */

const HH_MM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const BARE_HOUR = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;

/**
 * Hours a driver says as words.
 *
 * A model told not to convert anything returns "seven" for "around seven", and
 * the hour is the only part of a time that is routinely spoken rather than
 * read. Minutes are not in this map on purpose: "quarter after" and "twenty to"
 * are arithmetic, and arithmetic on a hedged time is how 10:40 becomes a
 * measurement. Those reach the driver as a question instead.
 */
const SPOKEN_HOURS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const SPOKEN_HOUR_PATTERN = new RegExp(
  `\\b(${Object.keys(SPOKEN_HOURS).join("|")})\\b\\s*(a\\.?m\\.?|p\\.?m\\.?)?`,
  "i"
);

type HourReading = { hour: number; minute: string; meridiem: string | null };

/** Read an hour out of one string, digits or words. Null when there is none. */
function readHour(text: string): HourReading | null {
  const digits = BARE_HOUR.exec(text);
  if (digits) {
    return {
      hour: Number(digits[1]),
      minute: digits[2] ?? "00",
      meridiem: digits[3]?.toLowerCase().replace(/\./g, "") ?? null,
    };
  }

  const words = SPOKEN_HOUR_PATTERN.exec(text);
  if (words) {
    return {
      hour: SPOKEN_HOURS[words[1].toLowerCase()],
      minute: "00",
      meridiem: words[2]?.toLowerCase().replace(/\./g, "") ?? null,
    };
  }

  return null;
}

export type TimeReading = {
  /** 24-hour HH:MM. */
  local: string;
  /** How this value was arrived at, which becomes the field's provenance. */
  basis: "stated" | "gps_detected";
};

/**
 * Resolve a spoken time, and never guess a meridiem.
 *
 * "Got there around seven" is 07:00 or 19:00 and a coin flip between them is a
 * record that is wrong half the time and says nothing about it. So a bare hour
 * with no AM/PM is UNKNOWN unless telematics saw an arrival, in which case the
 * geofence time is *proposed* — tagged `gps_detected` for the driver to
 * confirm, never applied silently. That is the one case where the system knows
 * something the driver did not say, and it still asks.
 */
export function normalizeTime(args: {
  /** The value the model returned, which may be words or HH:MM. */
  raw: string | null;
  quote: string | null;
  /** A geofence arrival in local HH:MM, if telematics saw one. */
  geofenceArrivalLocal: string | null;
}): NormalizerResult<TimeReading> {
  const { raw, quote, geofenceArrivalLocal } = args;

  if (raw === null || raw.trim() === "") {
    return { verdict: "NOT_EVALUATED", value: null, reasonCode: "time_absent", detail: "No time was stated." };
  }

  const trimmed = raw.trim();
  if (HH_MM.test(trimmed)) {
    const [h, m] = trimmed.split(":");
    return {
      verdict: "PASS",
      value: { local: `${h.padStart(2, "0")}:${m}`, basis: "stated" },
      reasonCode: "time_ok",
      detail: "",
    };
  }

  // The model's own value first, the driver's words second. The value is what
  // the model was asked to produce; the quote is context that may carry a
  // meridiem the value dropped, and it is consulted only when the value has
  // nothing readable in it.
  const reading = readHour(trimmed) ?? (quote ? readHour(quote) : null);
  if (!reading) {
    return { verdict: "UNKNOWN", value: null, reasonCode: "time_unreadable", detail: `"${trimmed}" could not be read as a time.` };
  }

  const { hour, minute } = reading;
  // A meridiem stated anywhere counts, including in the words when the value
  // lost it. It is never inferred from either.
  const meridiem =
    reading.meridiem ?? (quote ? readHour(quote)?.meridiem ?? null : null);

  if (meridiem) {
    const h24 = meridiem === "pm" ? (hour % 12) + 12 : hour % 12;
    return {
      verdict: "PASS",
      value: { local: `${String(h24).padStart(2, "0")}:${minute}`, basis: "stated" },
      reasonCode: "time_ok",
      detail: "",
    };
  }

  // A 24-hour reading is unambiguous on its own.
  if (hour >= 13 && hour <= 23) {
    return {
      verdict: "PASS",
      value: { local: `${String(hour).padStart(2, "0")}:${minute}`, basis: "stated" },
      reasonCode: "time_ok",
      detail: "",
    };
  }

  if (geofenceArrivalLocal && HH_MM.test(geofenceArrivalLocal)) {
    return {
      verdict: "REVIEW",
      value: { local: geofenceArrivalLocal, basis: "gps_detected" },
      reasonCode: "time_from_geofence",
      detail: `The driver said "${trimmed}"; the geofence recorded ${geofenceArrivalLocal}.`,
    };
  }

  return {
    verdict: "UNKNOWN",
    value: null,
    reasonCode: "time_meridiem_unknown",
    detail: `"${trimmed}" could be morning or evening and nothing here says which.`,
  };
}

/* ------------------------------------------------------------------ */
/* Legal land descriptions                                             */
/* ------------------------------------------------------------------ */

export type LandReading = {
  latitude: number;
  longitude: number;
  precision: "approximate_site";
  note: string;
};

/**
 * Resolve an Alberta legal land description to a coordinate.
 *
 * The checkpoint allowed for this data being absent. It is not: the repository
 * already carries the Dominion Land Survey module (`server/_core/dls.ts`) and
 * the quarter/section wrapper over it (`server/_core/legalLocation.ts`), so the
 * LSD path is real rather than a reported gap.
 *
 * What comes back is the theoretical centre of a survey cell — roughly ±2 km,
 * never an entrance and never routable — so this is always REVIEW, never PASS.
 * A coordinate that good is worth proposing and is not worth committing without
 * somebody looking at it beside the GPS track.
 */
export function normalizeLandLocation(raw: string | null): NormalizerResult<LandReading> {
  if (raw === null || raw.trim() === "") {
    return { verdict: "NOT_EVALUATED", value: null, reasonCode: "land_absent", detail: "No land location was stated." };
  }

  const resolved = approximateFromLegalLocation(raw);
  if (!resolved) {
    return {
      verdict: "UNKNOWN",
      value: null,
      reasonCode: "land_unparsed",
      detail: `"${raw.trim()}" is not a legal land description this survey module reads.`,
    };
  }

  return {
    verdict: "REVIEW",
    value: resolved,
    reasonCode: "land_approximate",
    detail: resolved.note,
  };
}

/* ------------------------------------------------------------------ */
/* Ticket numbers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Check a ticket number against what is actually open.
 *
 * The model is forbidden from completing a partial number, so "ticket
 * forty-four seventy-one" arrives as `4471` and this decides whether that is a
 * ticket. Membership in the open set is the check; a prefix that matches an
 * open ticket's prefix but no open ticket is REVIEW, because it is the shape of
 * a real number and might be a transcription slip worth asking about.
 */
export function normalizeTicketNumber(args: {
  raw: string | number | null;
  openTickets: readonly string[];
}): NormalizerResult<string> {
  const { raw, openTickets } = args;

  if (raw === null || String(raw).trim() === "") {
    return { verdict: "NOT_EVALUATED", value: null, reasonCode: "ticket_absent", detail: "No ticket number was stated." };
  }

  const spoken = String(raw).trim().toUpperCase();

  if (openTickets.length === 0) {
    return {
      verdict: "NOT_EVALUATED",
      value: spoken,
      reasonCode: "open_tickets_unknown",
      detail: "No open tickets were supplied, so the number was not checked against any.",
    };
  }

  const open = openTickets.map(t => t.trim().toUpperCase());
  if (open.includes(spoken)) {
    return { verdict: "PASS", value: spoken, reasonCode: "ticket_open", detail: "" };
  }

  // A bare number against prefixed open tickets: the driver said the digits and
  // left the prefix implied. Completing it is exactly what the prompt forbids,
  // so it is asked rather than assumed — even when there is only one candidate.
  const suffixMatches = open.filter(t => t.endsWith(spoken));
  if (suffixMatches.length > 0) {
    return {
      verdict: "REVIEW",
      value: spoken,
      reasonCode: "ticket_prefix_missing",
      detail: `"${spoken}" matches the end of ${suffixMatches.join(", ")}.`,
    };
  }

  return {
    verdict: "REVIEW",
    value: spoken,
    reasonCode: "ticket_not_open",
    detail: `"${spoken}" is not among the open tickets (${open.join(", ")}).`,
  };
}
