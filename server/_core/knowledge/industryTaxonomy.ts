/**
 * The industry intelligence taxonomy: what a source or a passage is *about*.
 *
 * Not to be confused with `_core/taxonomy.ts`, which classifies a haul (service,
 * truck, trailer, cargo) so routing and permits know what to check. This one
 * classifies knowledge, so retrieval can ask "everything binding on disposal
 * tickets in CA-AB" without a keyword search standing in for a category.
 *
 * Two rules:
 *
 *   1. Topics are a closed list. A category nobody defined is a typo that
 *      silently matches nothing, so `validateTopics` refuses it rather than
 *      storing it.
 *   2. Authority tiers A–E are a *view* of `admission.ts`'s levels, not a second
 *      vocabulary. The levels decide; the tiers are how people talk about them.
 *      Two authority scales in one subsystem would drift, and the drift would
 *      decide which rule an answer cites.
 */

import { AUTHORITY_LEVELS, type AuthorityLevel } from "./admission";

/* ------------------------------------------------------------------ */
/* Topics                                                              */
/* ------------------------------------------------------------------ */

export const TOPIC_GROUPS = [
  "driver_and_hours", "carrier_safety", "vehicle", "road_and_route", "dangerous_goods",
  "workplace_safety", "oilfield", "waste_and_disposal", "environment", "finance",
] as const;
export type TopicGroup = (typeof TOPIC_GROUPS)[number];

/** Every topic, with the group it rolls up to. Order is presentation order. */
export const INDUSTRY_TOPICS = {
  hos_eld: "driver_and_hours",
  driver_licensing: "driver_and_hours",
  nsc: "carrier_safety",
  cvip: "vehicle",
  inspections: "vehicle",
  vehicle_maintenance: "vehicle",
  weights_dimensions: "road_and_route",
  permits: "road_and_route",
  road_restrictions: "road_and_route",
  road_511: "road_and_route",
  tdg: "dangerous_goods",
  dangerous_goods: "dangerous_goods",
  emergency_response: "dangerous_goods",
  whmis: "workplace_safety",
  ohs: "workplace_safety",
  oilfield_operations: "oilfield",
  vacuum_hydrovac: "oilfield",
  water_hauling: "oilfield",
  wells_rigs_leases_lsd: "oilfield",
  aer_petrinex: "oilfield",
  waste_classification: "waste_and_disposal",
  disposal_facilities: "waste_and_disposal",
  disposal_tickets: "waste_and_disposal",
  environmental_compliance: "environment",
  accounting: "finance",
  gst_hst: "finance",
  payroll: "finance",
  expenses: "finance",
  fuel: "finance",
  invoicing: "finance",
  fleet_cost: "finance",
  job_costing: "finance",
} as const satisfies Record<string, TopicGroup>;

export type IndustryTopic = keyof typeof INDUSTRY_TOPICS;

export const isIndustryTopic = (t: string): t is IndustryTopic =>
  Object.prototype.hasOwnProperty.call(INDUSTRY_TOPICS, t);

export type TopicValidation =
  | { ok: true; topics: readonly IndustryTopic[] }
  | { ok: false; unknown: readonly string[]; reason: string };

/**
 * Refuse an unknown topic, and refuse an empty list.
 *
 * Empty is refused because a source with no topic is invisible to every
 * category filter — it would sit in the corpus and never be retrieved, which is
 * a gap nobody would notice. Duplicates are collapsed, not refused; they are
 * harmless and order is kept.
 */
export function validateTopics(topics: readonly string[]): TopicValidation {
  if (topics.length === 0) return { ok: false, unknown: [], reason: "at least one topic is required" };
  const unknown = topics.filter((t) => !isIndustryTopic(t));
  if (unknown.length) {
    return { ok: false, unknown, reason: `unknown topic(s): ${unknown.join(", ")}` };
  }
  return { ok: true, topics: Array.from(new Set(topics)) as IndustryTopic[] };
}

/* ------------------------------------------------------------------ */
/* Authority tiers                                                     */
/* ------------------------------------------------------------------ */

export const AUTHORITY_TIERS = ["A", "B", "C", "D", "E"] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

export const TIER_MEANING: Readonly<Record<AuthorityTier, string>> = {
  A: "legislation, regulation or regulator — the primary authority",
  B: "government guidance or official standard",
  C: "recognized industry body or manufacturer",
  D: "company, facility or operator source",
  E: "general web or community material",
};

/**
 * The tier of each level.
 *
 * `admission.ts` labels `operational` E and `unverified` F in its comments; the
 * five-tier scale folds operational records into D (they are the operator's
 * own facts) and leaves unverified material alone at E. Ranking still uses the
 * levels, so the fold changes a label and never an outcome.
 */
export const TIER_OF: Readonly<Record<AuthorityLevel, AuthorityTier>> = {
  law: "A",
  official_guidance: "B",
  recognized_standard: "C",
  manufacturer: "C",
  company_policy: "D",
  operational: "D",
  unverified: "E",
};

export const tierOf = (level: AuthorityLevel): AuthorityTier => TIER_OF[level];

/** The levels a tier covers, most binding first. */
export const levelsInTier = (tier: AuthorityTier): readonly AuthorityLevel[] =>
  AUTHORITY_LEVELS.filter((l) => TIER_OF[l] === tier);
