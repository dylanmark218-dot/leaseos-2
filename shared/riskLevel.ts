/**
 * What a capability may cost the company if it is wrong.
 *
 * Moved here from `server/_core/actionGateway.ts` (SPINE item 3) so the offline policy that the field
 * client and the server both run can bind to the gateway's own ladder instead of restating it. The
 * gateway re-exports this type; there is still exactly one risk vocabulary.
 */
export type RiskLevel =
  | "read"                 // L0 — observes
  | "prepare"              // L1 — drafts, commits nothing
  | "low_risk_action"      // L2 — acts, cheaply reversible
  | "approval_required"    // L3 — a person says yes first
  | "restricted";          // L4 — more than one person, or nobody
