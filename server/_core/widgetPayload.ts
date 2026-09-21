/**
 * B23 — what a widget is allowed to say.
 *
 * Pure. No network, no database.
 *
 * A dashboard is the one place in LeaseOS where forty answers from forty
 * engines land side by side, stripped of the screen that explained them. That
 * makes it the easiest place in the product to undo every invariant underneath
 * it: a tile reading `31,500 kg` looks identically confident whether it came
 * from a scale ticket or from a driver saying "about thirty-one five", and a
 * tile reading `—` looks identically harmless whether the limit is clear or
 * whether nobody has ever loaded the rule.
 *
 * So a data source does not return a value. It returns a state, and the value
 * is a property of one of them. `ok` is the only state that carries a bare
 * value, and reaching it requires saying where the value came from.
 *
 * Three rules, and the first is the one that makes the rest hold.
 *
 * **Unknown is a state, not an empty value.** `{ state: "unknown" }` has a
 * reason attached and renders as a question, never as a dash. A tile cannot
 * fall back to `ok` with `value: null`, because the union does not allow it.
 *
 * **What is withheld is listed.** Borrowed intact from `roadsidePanel.ts`: a
 * caller shown eight of eleven tiles and told nothing about the other three has
 * been misled. A widget the caller may not read resolves to `not_permitted`
 * and stays on the board as a named, withheld item.
 *
 * **A rollup takes the worst state and keeps the others.** See `rollup`.
 */

/* ------------------------------------------------------------------ */
/* Provenance                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where a displayed value came from. The same vocabulary the record engines
 * already use, because a widget must not invent a source tier of its own.
 */
export type ValueSource =
  | "driver_stated"
  | "driver_voice"
  | "gps"
  | "ocr"
  | "imported"
  | "system_inferred"
  | "authority_sourced"
  | "human_corrected"
  | "measured";

export type Verification = "unverified" | "verified" | "superseded";

export type Provenance = {
  source: ValueSource;
  verification: Verification;
  /** Absent when the source does not express one. Never defaulted to 1. */
  confidence?: number;
  /** `false` says "about 8,000 litres" out loud instead of rounding it to fact. */
  exact: boolean;
  observedAt: Date;
  verifiedAt?: Date;
  verifiedByUserId?: number;
  /** For authority-sourced values: which dataset version said so. */
  datasetVersion?: string;
};

export type NamedBlocker = {
  /** Stable key so the UI can deep-link the fix, not just print a sentence. */
  code: string;
  /** "Annual inspection expired 2026-08-14", never "not ready". */
  detail: string;
  deepLink?: DeepLink;
};

export type DeepLink = { portal: string; route: string };

/* ------------------------------------------------------------------ */
/* The union                                                            */
/* ------------------------------------------------------------------ */

export type WidgetState =
  | "ok"
  | "stale"
  | "unknown"
  | "blocked"
  | "offline"
  | "not_permitted"
  | "failed";

export type WidgetPayload<T> =
  /** A value, and where it came from. The only state carrying a bare value. */
  | { state: "ok"; value: T; provenance: Provenance; deepLink?: DeepLink }
  /**
   * A value that was true at `asOf` and is past its freshness budget. Kept
   * distinct from `ok` because a cached HOS clock and a live HOS clock are not
   * the same claim, and distinct from `unknown` because the number is real.
   */
  | { state: "stale"; value: T; asOf: Date; provenance: Provenance; deepLink?: DeepLink }
  /** Nobody knows. P9 with no verified rules loaded lands here, permanently. */
  | { state: "unknown"; reason: string; deepLink?: DeepLink }
  /** A determinate no, with the names. Composed from an engine's own blockers. */
  | { state: "blocked"; blockers: readonly NamedBlocker[]; deepLink?: DeepLink }
  /** The device is offline and this source declared no offline answer. */
  | { state: "offline"; cachedAt?: Date }
  /** Withheld, and said so. Never silently dropped from the layout. */
  | { state: "not_permitted"; permission: string }
  /** One source failed. Isolated here so it cannot take the board down. */
  | { state: "failed"; reason: string };

/* ------------------------------------------------------------------ */
/* Constructors                                                         */
/* ------------------------------------------------------------------ */

/**
 * `ok` demands provenance positionally. A source that has no provenance to
 * offer cannot reach this function, which is the point: it has to pick
 * `unknown` and say why.
 */
export const ok = <T>(value: T, provenance: Provenance, deepLink?: DeepLink): WidgetPayload<T> =>
  deepLink ? { state: "ok", value, provenance, deepLink } : { state: "ok", value, provenance };

export const unknown = <T>(reason: string, deepLink?: DeepLink): WidgetPayload<T> =>
  deepLink ? { state: "unknown", reason, deepLink } : { state: "unknown", reason };

export const blocked = <T>(blockers: readonly NamedBlocker[], deepLink?: DeepLink): WidgetPayload<T> => {
  if (blockers.length === 0) {
    // A blocked tile with no named blocker is the generic "incomplete" the
    // billing readiness rules exist to forbid. Refuse it at construction.
    return { state: "unknown", reason: "blocked with no named blocker" };
  }
  return deepLink ? { state: "blocked", blockers, deepLink } : { state: "blocked", blockers };
};

/**
 * Age a value against its freshness budget.
 *
 * `maxStaleMinutes` of 0 means "only live counts" — a value observed even a
 * second ago is already stale. Used by sources whose whole meaning is
 * currentness, like a live position.
 */
export function freshness<T>(
  value: T,
  provenance: Provenance,
  maxStaleMinutes: number,
  now: Date,
  deepLink?: DeepLink,
): WidgetPayload<T> {
  const ageMinutes = (now.getTime() - provenance.observedAt.getTime()) / 60_000;
  if (ageMinutes <= maxStaleMinutes) return ok(value, provenance, deepLink);
  const base = { state: "stale" as const, value, asOf: provenance.observedAt, provenance };
  return deepLink ? { ...base, deepLink } : base;
}

/* ------------------------------------------------------------------ */
/* Rollup                                                              */
/* ------------------------------------------------------------------ */

/**
 * Severity, LEAST severe first, so a higher rank always means worse.
 *
 * `blocked` outranks `unknown` because a named blocker is the more actionable
 * of two not-ready answers, and showing it does not mislead anyone into
 * thinking the picture is fine. `unknown` outranks `stale`, and `stale`
 * outranks `ok`, so nothing indeterminate can ever be summarised as a green
 * tile. `not_permitted` sits below the substantive states: a caller who may
 * not read one of five inputs should still see that the other four are blocked.
 *
 * This array was written most-severe-first while `rollup` took the highest
 * rank, so the two disagreed and the rollup returned the *least* severe
 * contributor: a board mixing a verified number with an unloaded rule
 * summarised as `ok`. That is the one thing this module exists to prevent,
 * inverted, with no visible symptom other than a green tile. Ordering is now
 * least-first to match the comparator, and the direction is stated in the name
 * of the constant so the next edit cannot silently flip it back.
 */
const SEVERITY_ASCENDING: readonly WidgetState[] = [
  "ok",
  "not_permitted",
  "stale",
  "offline",
  "failed",
  "unknown",
  "blocked",
];

/**
 * An unrecognised state ranks above everything rather than at zero.
 *
 * A state this function has never heard of is by definition not known to be
 * safe, and the old `-1 → 0` fallback made it the *least* severe thing on the
 * board — the same failure as the inversion above, waiting for the next state
 * added to the union.
 */
export const severityOf = (s: WidgetState): number => {
  const i = SEVERITY_ASCENDING.indexOf(s);
  return i === -1 ? SEVERITY_ASCENDING.length : i;
};

export type Rollup = {
  /** What the summary tile shows. */
  headline: WidgetState;
  /** Every contributing state, deduplicated. Nothing is lost to the headline. */
  contributing: readonly WidgetState[];
  /** Every named blocker from every contributor, concatenated. */
  blockers: readonly NamedBlocker[];
  /** Reasons from contributors that were indeterminate. */
  unknowns: readonly string[];
};

/**
 * Summarise several payloads into one tile without losing any of them.
 *
 * The failure this prevents: a "Dispatch Readiness: REVIEW" tile that hid an
 * unknown behind a blocker, so clearing the blocker surfaced a second problem
 * nobody had been shown. Headline plus contributing list means the tile can be
 * honest at a glance and complete when opened.
 */
export function rollup(payloads: readonly WidgetPayload<unknown>[]): Rollup {
  if (payloads.length === 0) {
    return { headline: "unknown", contributing: ["unknown"], blockers: [], unknowns: ["nothing to summarise"] };
  }
  const states = payloads.map((p) => p.state);
  let headline = states[0] as WidgetState;
  for (const s of states) if (severityOf(s) > severityOf(headline)) headline = s;

  const blockers: NamedBlocker[] = [];
  const unknowns: string[] = [];
  for (const p of payloads) {
    if (p.state === "blocked") blockers.push(...p.blockers);
    if (p.state === "unknown") unknowns.push(p.reason);
    if (p.state === "failed") unknowns.push(p.reason);
  }
  return { headline, contributing: Array.from(new Set(states)), blockers, unknowns };
}

/**
 * Is this payload safe to bill, dispatch or certify from?
 *
 * One function, so no caller has to re-derive it, and so `stale` can never be
 * quietly counted as good enough by a tile that forgot to check.
 */
export const isConfirmed = (p: WidgetPayload<unknown>): boolean =>
  p.state === "ok" && p.provenance.verification === "verified" && p.provenance.exact;
