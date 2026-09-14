/**
 * v22.20 — the engine's vocabulary, rendered without translating it.
 *
 * Pure, and separate from the components so it can be tested with real server
 * shapes rather than by grepping JSX.
 *
 * All three communications screens shipped with locally invented response
 * types. They compiled, the tests passed, and every one of them rendered
 * wrongly: the pages looked for `prohibited` and `conditional` where the engine
 * says `not_authorized` and `requires_posted_channel`, for `met` and `unmet`
 * where it says `permitted` and `excluded`, and for `reason` where it says
 * `note`. A driver carrying a superseded package would have been shown the
 * neutral grey reserved for "unknown".
 *
 * The lesson is not "check the field names". It is that a hand-written type
 * describing somebody else's response is a second copy of a contract, and the
 * copy is what the screen obeys. These functions take the engine's own types,
 * so a vocabulary change breaks the build instead of the screen.
 */
import type { ConditionFinding, Gate, TransmitStatus } from "../../../server/_core/commRoute";
import type { CarriedState } from "../../../server/_core/commPackage";

export type Tone = "good" | "bad" | "warn" | "muted";

export const TONE_CLASS: Record<Tone, string> = {
  good: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  bad: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  muted: "bg-muted text-muted-foreground",
};

/** Exhaustive on the engine's status vocabulary. */
export function transmitTone(status: TransmitStatus): Tone {
  switch (status) {
    case "authorized": return "good";
    case "not_authorized": return "bad";
    case "requires_posted_channel": return "warn";
    case "unknown": return "muted";
  }
}

/**
 * A gate's mark.
 *
 * `requires_posting` is its own outcome rather than a failure: the channel is
 * usable where a sign says which one, and showing it as a red cross would send
 * a driver to the office over a road they may lawfully drive.
 */
export function gateTone(result: Gate["result"]): Tone {
  switch (result) {
    case "yes": return "good";
    case "no": return "bad";
    case "requires_posting": return "warn";
    case "unknown": return "muted";
  }
}

/** Readable names for the five gates, in the engine's own order. */
export const GATE_LABEL: Record<Gate["gate"], string> = {
  channel_record: "Channel on record",
  service_class: "Service class",
  geography: "Geography",
  company_authorization: "Company authorization",
  unit_capability: "Unit capability",
};

export type GateView = { key: Gate["gate"]; label: string; tone: Tone; reason: string };

/** The engine's reason, unedited. A paraphrase here is a second opinion. */
export const gateView = (gate: Gate): GateView => ({
  key: gate.gate, label: GATE_LABEL[gate.gate], tone: gateTone(gate.result), reason: gate.reason,
});

export function conditionTone(result: ConditionFinding["result"]): Tone {
  switch (result) {
    case "permitted": return "good";
    case "excluded": return "bad";
    // Crossing a boundary is a fact to look at, not a refusal.
    case "crosses": return "warn";
    case "requires_posting": return "warn";
    case "unknown": return "muted";
  }
}

/**
 * A carrier's state.
 *
 * `behind` and `stale` are both wrong to depart on and are kept apart, because
 * the fixes differ: one device needs to re-download, and everybody needs a
 * rebuild. `none` is not a problem — nobody has taken it yet.
 */
export function carrierTone(state: CarriedState): Tone {
  switch (state) {
    case "current": return "good";
    case "behind": return "bad";
    case "stale": return "bad";
    case "none": return "muted";
  }
}

export const carrierNeedsAction = (state: CarriedState): boolean =>
  state === "behind" || state === "stale";
