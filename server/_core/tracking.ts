/**
 * Tracking number engine.
 *
 * Two hard rules, both from the records-chain design:
 *   1. A human tracking number is NEVER the database primary key. Rows keep
 *      their autoincrement id; the tracking number is an issued label that
 *      happens to be unique. Renumbering a company must never require
 *      rewriting foreign keys.
 *   2. Format is configuration, not code. JOB-2026-001842 and CAL-JOB-26-01842
 *      are the same sequence under different company settings.
 *
 * Pure functions only — no DB, no clock. The caller supplies "now" so
 * rollover behaviour is testable without freezing time.
 */

export type ResetPeriod = "never" | "yearly" | "monthly";

export type SequenceFormat = {
  /** Record class, e.g. JOB, TR, LD, DT, MF, LOG, TG, WO, INV. */
  prefix: string;
  /** Optional branch/location code, e.g. CAL, EDM. Omit for single-yard. */
  branch?: string;
  separator: string;
  /** 4 → 2026, 2 → 26, 0 → omit the year entirely. */
  yearDigits: 0 | 2 | 4;
  /** Include a zero-padded month segment (for monthly-reset sequences). */
  includeMonth?: boolean;
  /** Zero-padding width of the counter, e.g. 6 → 001842. */
  sequenceDigits: number;
  resetPeriod: ResetPeriod;
};

export type PeriodKey = string;

/**
 * The bucket a counter lives in. Rolling over to a new bucket is what resets
 * the counter — so the bucket key is stored alongside nextNumber and compared
 * on every issue.
 */
export function periodKeyFor(resetPeriod: ResetPeriod, when: Date): PeriodKey {
  if (resetPeriod === "never") return "all";
  const year = when.getUTCFullYear();
  if (resetPeriod === "yearly") return String(year);
  const month = String(when.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function formatTrackingNumber(
  format: SequenceFormat,
  sequence: number,
  when: Date
): string {
  const sep = format.separator;
  const parts: string[] = [];

  if (format.branch) parts.push(format.branch);
  parts.push(format.prefix);

  if (format.yearDigits === 4) parts.push(String(when.getUTCFullYear()));
  else if (format.yearDigits === 2)
    parts.push(String(when.getUTCFullYear()).slice(-2));

  if (format.includeMonth)
    parts.push(String(when.getUTCMonth() + 1).padStart(2, "0"));

  parts.push(String(sequence).padStart(format.sequenceDigits, "0"));
  return parts.join(sep);
}

/**
 * Child numbers hang off a parent rather than a global counter — the third
 * load on trip 4821 is LD-2026-004821-03, not the 903rd load this year.
 * Keeps the sibling ordering readable on paper tickets.
 */
export function formatChildNumber(
  parentTrackingNumber: string,
  childPrefix: string,
  childSequence: number,
  separator = "-",
  digits = 2
): string {
  const parentTail = parentTrackingNumber
    .split(separator)
    .slice(1)
    .join(separator);
  return [
    childPrefix,
    parentTail,
    String(childSequence).padStart(digits, "0"),
  ].join(separator);
}

export type SequenceState = { periodKey: PeriodKey; nextNumber: number };

/**
 * Advance a counter, resetting it when the period bucket has rolled over.
 * Returns both the number to use and the state to persist — the caller writes
 * that back inside the same transaction it issues the number in.
 */
export function advanceSequence(
  current: SequenceState | null,
  format: SequenceFormat,
  when: Date,
  startAt = 1
): { issued: number; state: SequenceState } {
  const key = periodKeyFor(format.resetPeriod, when);
  if (!current || current.periodKey !== key) {
    return {
      issued: startAt,
      state: { periodKey: key, nextNumber: startAt + 1 },
    };
  }
  return {
    issued: current.nextNumber,
    state: { periodKey: key, nextNumber: current.nextNumber + 1 },
  };
}

export type ParsedTrackingNumber = {
  branch?: string;
  prefix: string;
  year?: number;
  month?: number;
  sequence: number;
};

/**
 * Reverse a tracking number into its parts. Used by the master search bar so
 * "DT-2026-004821-01" can be routed to the right table before any DB lookup.
 * Returns null rather than throwing — search input is user-typed and wrong
 * input is expected, not exceptional.
 */
export function parseTrackingNumber(
  value: string,
  format: SequenceFormat
): ParsedTrackingNumber | null {
  const raw = value.trim().toUpperCase();
  if (!raw) return null;
  const parts = raw.split(format.separator);
  if (parts.length < 2) return null;

  let i = 0;
  let branch: string | undefined;
  if (format.branch && parts[i] === format.branch.toUpperCase())
    branch = parts[i++];

  const prefix = parts[i++];
  if (!prefix) return null;

  let year: number | undefined;
  if (format.yearDigits === 4) {
    const y = Number(parts[i]);
    if (!Number.isInteger(y) || parts[i]?.length !== 4) return null;
    year = y;
    i++;
  } else if (format.yearDigits === 2) {
    const y = Number(parts[i]);
    if (!Number.isInteger(y) || parts[i]?.length !== 2) return null;
    year = 2000 + y;
    i++;
  }

  let month: number | undefined;
  if (format.includeMonth) {
    const m = Number(parts[i]);
    if (!Number.isInteger(m) || m < 1 || m > 12) return null;
    month = m;
    i++;
  }

  const sequence = Number(parts[i]);
  if (!Number.isInteger(sequence)) return null;

  return { branch, prefix, year, month, sequence };
}

/** Default formats. Overridable per company in admin settings. */
export const DEFAULT_FORMATS: Record<string, SequenceFormat> = {
  JOB: {
    prefix: "JOB",
    separator: "-",
    yearDigits: 4,
    sequenceDigits: 6,
    resetPeriod: "yearly",
  },
  BB: {
    prefix: "BB",
    separator: "-",
    yearDigits: 4,
    sequenceDigits: 6,
    resetPeriod: "yearly",
  },
  TR: {
    prefix: "TR",
    separator: "-",
    yearDigits: 4,
    sequenceDigits: 6,
    resetPeriod: "yearly",
  },
  MF: {
    prefix: "MF",
    separator: "-",
    yearDigits: 4,
    sequenceDigits: 6,
    resetPeriod: "yearly",
  },
  WO: {
    prefix: "WO",
    separator: "-",
    yearDigits: 4,
    sequenceDigits: 6,
    resetPeriod: "yearly",
  },
  INV: {
    prefix: "INV",
    separator: "-",
    yearDigits: 4,
    sequenceDigits: 6,
    resetPeriod: "yearly",
  },
  FT: {
    prefix: "FT",
    separator: "-",
    yearDigits: 4,
    sequenceDigits: 6,
    resetPeriod: "yearly",
  },
  TG: {
    prefix: "TG",
    separator: "-",
    yearDigits: 4,
    sequenceDigits: 6,
    resetPeriod: "yearly",
  },
  DL: {
    prefix: "DL",
    separator: "-",
    yearDigits: 4,
    includeMonth: true,
    sequenceDigits: 4,
    resetPeriod: "monthly",
  },
};
