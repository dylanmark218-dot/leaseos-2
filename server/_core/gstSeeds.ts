/**
 * GST/HST rate rule seeds — unverified, with NO rate.
 *
 * Everyone "knows" the federal rate. Nobody here has verified it against the
 * CRA for the period, so it is not written. The rows give the loading path
 * its shape and let the return say "unverified" rather than "missing".
 */

import type { TaxRule } from "./taxRuleEngine";

export const GST_RATE_RULE_TYPE = "gst_hst_rate";
const FROM = new Date("2026-01-01T00:00:00Z");
const seed = (jurisdiction: string, kind: "gst" | "hst"): TaxRule => ({
  ruleKey: `gst.rate.${jurisdiction.toLowerCase().replace(/[^a-z]/g, "_")}.2026`,
  version: 1, jurisdiction, ruleType: GST_RATE_RULE_TYPE,
  parameters: { ratePercent: null, kind, note: "Rate not loaded — verify against the CRA rate table for the period" },
  effectiveFrom: FROM, status: "unverified",
});
export const GST_RATE_SEEDS: readonly TaxRule[] = [seed("CA", "gst"), seed("CA-AB", "gst"), seed("CA-BC", "gst"), seed("CA-SK", "gst"), seed("CA-MB", "gst"), seed("CA-ON", "hst"), seed("CA-NS", "hst"), seed("CA-NB", "hst"), seed("CA-NL", "hst"), seed("CA-PE", "hst")];
