/**
 * CCA class rule seeds — unverified, with NO rate, no half-year answer, no
 * incentive factor. The classes a trucking company commonly meets are named
 * so the loading path has its shape; every figure waits for a person.
 */
import type { TaxRule } from "./taxRuleEngine";

export const CCA_RULE_TYPE = "cca_class";
const FROM = new Date("2026-01-01T00:00:00Z");
const seed = (cls: string, note: string): TaxRule => ({ ruleKey: `cca.class.${cls.toLowerCase().replace(/[^a-z0-9]/g, "_")}.2026`, version: 1, jurisdiction: "CA", ruleType: CCA_RULE_TYPE, parameters: { ccaClass: cls, ratePercent: null, halfYearRule: null, firstYearFactor: null, note }, effectiveFrom: FROM, status: "unverified" });
export const CCA_CLASS_SEEDS: readonly TaxRule[] = [
  seed("Class 8", "General machinery and equipment — verify rate against the CRA class table"),
  seed("Class 10", "Automotive equipment, general — verify rate and half-year treatment"),
  seed("Class 10.1", "Passenger vehicles over the cost ceiling — separate class per vehicle; verify"),
  seed("Class 12", "Small tools and certain items — verify rate and first-year treatment"),
  seed("Class 16", "Heavy trucks for hauling freight (tractor trailers) — verify rate; verify which units qualify"),
  seed("Class 50", "Computer equipment — verify"),
  seed("Class 13", "Leasehold improvements — straight-line over the lease; verify"),
];
