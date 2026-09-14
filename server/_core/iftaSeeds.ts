/**
 * IFTA fuel tax rate rule seeds — unverified, with NO rate.
 *
 * A rate is a number a regulator publishes for a quarter. Nobody here has
 * looked one up, so none is written. These rows exist so the loading path
 * has its shape and so the return names each jurisdiction's rate as
 * "unverified" rather than "missing" — a person knows what to verify.
 */

import type { TaxRule } from "./taxRuleEngine";

export const IFTA_RATE_RULE_TYPE = "ifta_fuel_tax_rate";

const FROM = new Date("2026-07-01T00:00:00Z");
const seed = (jurisdiction: string): TaxRule => ({
  ruleKey: `ifta.rate.${jurisdiction.toLowerCase().replace(/[^a-z]/g, "_")}.2026q3`,
  version: 1, jurisdiction, ruleType: IFTA_RATE_RULE_TYPE,
  parameters: { ratePerLitre: null, fuelType: "diesel", note: "Rate not loaded — verify against the IFTA rate matrix for the quarter" },
  effectiveFrom: FROM, effectiveUntil: new Date("2026-10-01T00:00:00Z"), status: "unverified",
});

export const IFTA_RATE_SEEDS: readonly TaxRule[] = ["CA-AB", "CA-BC", "CA-SK", "CA-MB", "US-MT", "US-ND"].map(seed);
