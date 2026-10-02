/**
 * HOS phase 2 — the stable, machine-readable vocabulary every HOS result speaks.
 *
 * One union, one file. A code is added here when an engine first emits it — never ahead of the
 * behaviour, so the registry cannot claim what the engine does not do — and a code is never
 * renamed: dispatch, the job board, the driver's screen and an auditor's export all key on these
 * strings. Human sentences travel beside a code, never instead of one.
 */
export const HOS_REASON_CODES = [
  // What could not be established
  "HOS_PROFILE_UNKNOWN",             // the selector could not name a schedule
  "HOS_PROFILE_CONFLICT",            // two schedules apply equally; a person decides
  "HOS_LIMIT_UNVERIFIED",            // the figure exists but nobody has verified it (P9)
  "HOS_LIMIT_NOT_STATED",            // the profile carries no figure for this limit
  "HOS_MECHANICS_DEFAULTED",         // day/shift/cycle boundaries came from the trailing-window default, not a regime rule
  "HOS_DAY_BOUNDARY_UNKNOWN",        // the regime needs a designated duty day and none is established
  "HOS_DAY_RULE_UNVERIFIED",         // a duty day is designated, but no verified rule says this limit is counted over it
  "HOS_TIMEZONE_UNKNOWN",            // the operator's home-terminal zone is not on record
  "HOS_NO_DUTY_RECORD",              // the ledger holds no duty status for this operator in the window
  "HOS_REQUIRED_REST_UNDETERMINED",  // earliest legal driving time cannot be computed under what is verified
  "HOS_CLOCK_NOT_COMPUTED",          // the figure is verified and the engine computes no clock for it yet
  "HOS_SPECIAL_CATEGORY_UNMAPPED",   // personal conveyance / yard move present, and no verified rule says what they count as
  "HOS_DATA_GAP",                    // a device chain gap or unverifiable link overlaps the window
  // What was determined
  "HOS_WITHIN_LIMITS",
  "HOS_DRIVING_LIMIT_EXCEEDED",
  "HOS_ON_DUTY_LIMIT_EXCEEDED",
  "HOS_SHIFT_WINDOW_EXCEEDED",
  "HOS_CYCLE_LIMIT_EXCEEDED",
  "HOS_BREAK_REQUIRED",
  // Record integrity, carried from the ledger projection
  "HOS_CORRECTION_APPLIED",          // a superseding event retracted an original in the projection
  "HOS_CORRECTION_CYCLE",            // corrections name each other in a cycle; treated as active, left for a person
  "HOS_OPEN_STATUS",                 // the last duty status has no successor: it is still running
] as const;
export type HosReasonCode = (typeof HOS_REASON_CODES)[number];
