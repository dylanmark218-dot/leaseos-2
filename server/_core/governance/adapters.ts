/**
 * G1 — adapters between the governance kernel and the shapes that already exist.
 *
 * Nothing is rewritten onto the governance types. The permission result, the dispatch blocker and the
 * action gateway's decision each keep their own vocabulary, and these functions translate at the
 * boundary — the `interEngineStatus` approach, for the same reason: a fifth union with four engines
 * refactored onto it would be the parallel system this exists to avoid.
 */
import type { AuthorizationResult } from "../recordsAuthorization";
import type { DispatchBlocker } from "../dispatchReadiness";
import { asFinding } from "../complianceFinding";
import type { Decision as GatewayDecision } from "../actionGateway";
import type { CapabilityResult } from "../interEngineStatus";
import type { DecisionKind, GovernanceDecision, OverrideFact, PermissionFact } from "./decision";

/** What `authorize()` said, as the fact the kernel reads. The roles stay with the permission layer. */
export function permissionFactFrom(r: AuthorizationResult): PermissionFact {
  return r.detail === undefined ? { allowed: r.allowed, outcome: r.outcome } : { allowed: r.allowed, outcome: r.outcome, detail: r.detail };
}

/**
 * The override class of a dispatch blocker, decided by `complianceFinding`'s own classifier rather
 * than re-derived here — a second classifier would be a second answer to "can this be overridden".
 */
export function overrideFactFromBlocker(b: DispatchBlocker, evaluatedAt: Date): OverrideFact {
  const f = asFinding(b, evaluatedAt);
  return { findingCode: f.code, overrideClass: f.overrideClass };
}

/** The action gateway's decision, in the governance vocabulary. `stale` is a refusal: reload and re-plan. */
export function decisionKindFromGateway(d: GatewayDecision): DecisionKind {
  switch (d.decision) {
    case "allow": return "allow";
    case "require_approval": return "require_review";
    case "deny":
    case "compliance_block":
    case "stale": return "deny";
  }
}

/**
 * A governance decision as an inter-engine status, so readiness, billing and audit can read it without
 * translation. `not_evaluated` stays NOT_EVALUATED with its reason — it never rounds up — and both
 * kinds of "a person or an act is needed first" are REVIEW, because neither is an answer yet.
 */
export function toCapabilityResult(capability: string, d: GovernanceDecision): CapabilityResult {
  const detail = `${d.reasonCode}: ${d.humanReason}`;
  switch (d.decision) {
    case "allow": return { capability, status: "PASS", detail };
    case "deny": return { capability, status: "BLOCKED", detail };
    case "require_action":
    case "require_review": return { capability, status: "REVIEW", detail };
    case "not_evaluated": return { capability, status: "NOT_EVALUATED", reason: d.notEvaluatedReason ?? "no_data_source_loaded", detail };
  }
}
