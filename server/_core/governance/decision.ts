/**
 * G1 — the governance decision: what a policy evaluation is asked, and what it answers.
 *
 * Pure types and two pure functions. No database, no network. The evaluator that uses them is
 * `./evaluate.ts`; the rules are `./rules.ts`.
 *
 * **Extends, does not replace.** The authority ladder below is `complianceFinding.AuthorityClass` with
 * the four levels only LeaseOS itself can hold inserted where they belong. The rule ledger (`0189`)
 * and the compliance findings keep writing `AuthorityClass` values, and every one of them is a valid
 * `PolicyAuthority` with an unchanged relative order, so nothing that exists has to move.
 *
 * **Law is authored, never decided here.** `statute_regulation`, `regulator_order` and
 * `government_permit_exemption` appear in the ladder because a rule a person verified against its
 * source can carry them (the HOS ledger pattern). No rule in this kernel claims them for itself.
 */
import type { AuthorityClass, OverrideClass } from "../complianceFinding";
import type { ReasonCode } from "@shared/_core/reasonCodes";
import type { NotEvaluatedReason } from "../interEngineStatus";
import type { ComplianceVerdict } from "../actionGateway";

/* ------------------------------------------------------------------ */
/* Authority and precedence                                            */
/* ------------------------------------------------------------------ */

/** The levels LeaseOS adds to the existing ladder. */
export type LeaseosAuthority =
  | "leaseos_mandatory_control" // safety and security controls nobody may bypass
  | "leaseos_terms"             // Terms of Service / Acceptable Use
  | "leaseos_privacy"           // privacy commitments: may only narrow what a lower level does
  | "operational_preference";   // a dispatcher's or customer's preference: never a reason to relax anything

export type PolicyAuthority = AuthorityClass | LeaseosAuthority;

/**
 * Strongest first. A lower level may add a requirement; it may never turn a higher level's refusal
 * into permission.
 *
 * OWNER DECISION D2 (open): `client_contract` is placed above `leaseos_terms`, as the survey proposed.
 * Changing it is a one-line move here and a `RULESET_VERSION` bump.
 */
export const PRECEDENCE: readonly PolicyAuthority[] = [
  "statute_regulation",
  "regulator_order",
  "government_permit_exemption",
  "leaseos_mandatory_control",
  "carrier_safety_policy",
  "client_contract",
  "leaseos_terms",
  "leaseos_privacy",
  "work_site",
  "company_policy",
  "operational_preference",
  "best_practice",
];

export const authorityRank = (a: PolicyAuthority): number => {
  const i = PRECEDENCE.indexOf(a);
  // An authority this file does not know is weaker than everything it does: unknown never outranks.
  return i === -1 ? PRECEDENCE.length : i;
};

/** The levels an organization may author a policy row at. Everything above is not theirs to write. */
export const ORGANIZATION_AUTHORABLE: readonly PolicyAuthority[] = [
  "work_site", "company_policy", "operational_preference", "best_practice",
];

/* ------------------------------------------------------------------ */
/* The request                                                          */
/* ------------------------------------------------------------------ */

/**
 * Who is acting. A human is the only actor that can sign; an agent always names the person it acts
 * for, and its permission is that person's permission, never its own.
 */
export type GovernanceActor =
  | { type: "user"; userId: number }
  | { type: "external"; identityRef: string; kind: "customer" | "vendor" | "facility" }
  | { type: "integration"; clientRef: string }
  | { type: "agent"; agentKey: string; runRef: string; delegatedByUserId: number }
  | { type: "system"; component: string };

/** Human actors: a signed-in person, or a named person behind a portal identity. */
export const isHumanActor = (a: GovernanceActor): boolean => a.type === "user" || a.type === "external";

/** The acting organization, from `resolveActingScope` and never from input. */
export type GovernanceOrganization = { tenantId: string; derivedFrom: "membership" | "single_tenant_fallback" };

/** Where a record is in its life. Anything at or past `issued` is evidence, not a draft. */
export type ResourceLifecycle = "draft" | "issued" | "sealed" | "finalized" | "completed" | "signed" | "voided";

export type GovernanceResource = {
  type: string;
  ref: string;
  /**
   * The owning organization. `null` is the historical single tenant (the 0132 rule). `undefined` means
   * the caller did not establish it, which is refused rather than assumed.
   */
  orgRef: string | null | undefined;
  lifecycle?: ResourceLifecycle;
  legalHold?: boolean;
  revisionHash?: string;
};

/** What the permission layer (`authorize()`) already said. Governance reads it; it never re-decides roles. */
export type PermissionFact = {
  allowed: boolean;
  outcome: "allowed" | "denied_no_role" | "denied_permission" | "denied_scope" | "denied_unauthenticated";
  detail?: string;
};

/** What a deterministic compliance engine said — the action gateway's own verdict type. Governance does not re-decide it. */
export type ComplianceFact = ComplianceVerdict;

/** A request to lift or relax a control, with the class the control's producer gave it. */
export type OverrideFact = { findingCode: string; overrideClass: OverrideClass };

/** One approved version of a policy document: the text a person could have been shown. */
export type AcceptableVersion = { version: string; contentHash: string; effectiveFrom: Date };

/**
 * A policy a principal must have accepted for this action.
 *
 * `acceptableVersions` is every version an acceptance of which still counts: the version in force and
 * any earlier ones back to (and including) the last material change. A material change therefore
 * shows up as a short list, and an acceptance of anything older reads as stale. Comparing version
 * strings is avoided on purpose — "1.10" against "1.9" is exactly the kind of answer that is wrong
 * quietly.
 */
export type RequiredAcceptance = {
  policyKey: string;
  currentVersion: string;
  acceptableVersions: readonly AcceptableVersion[];
};

/** One acceptance on file. `recordedAt` is the server's clock at the time, never a client's claim. */
export type AcceptanceFact = {
  policyKey: string;
  version: string;
  contentHashAtAcceptance: string;
  state: "accepted" | "declined" | "withdrawn";
  recordedAt: Date;
};

/** A policy row an organization authored, already filtered to its own organization. */
export type OrganizationPolicyRow = {
  policyRef: string;
  version: number;
  authority: PolicyAuthority;
  /** The exact action this row speaks about. */
  action: string;
  /** An organization may refuse, or require review. It cannot grant: absence of refusal already is a grant. */
  effect: "deny" | "require_review" | "allow";
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type GovernanceRequest = {
  actor: GovernanceActor;
  organization: GovernanceOrganization;
  /** "disposal_ticket.modify": an object, a dot, a verb. */
  action: string;
  resource: GovernanceResource | null;
  context: {
    /** For an agent, the delegating person's result. Null means it was never evaluated. */
    permission: PermissionFact | null;
    compliance?: ComplianceFact | null;
    override?: OverrideFact | null;
    requiredAcceptances?: readonly RequiredAcceptance[];
    /** Undefined means the acceptance source was not consulted, which is not the same as none on file. */
    acceptances?: readonly AcceptanceFact[];
    organizationPolicies?: readonly OrganizationPolicyRow[];
    now: Date;
  };
};

/* ------------------------------------------------------------------ */
/* The decision                                                         */
/* ------------------------------------------------------------------ */

export type DecisionKind = "allow" | "deny" | "require_action" | "require_review" | "not_evaluated";

/** Worst first. The reported decision is the worst any rule returned; the trace keeps the rest. */
export const DECISION_SEVERITY: Readonly<Record<DecisionKind, number>> = {
  deny: 4, not_evaluated: 3, require_action: 2, require_review: 1, allow: 0,
};

export type RequiredAction =
  | { kind: "accept_policy"; policyKey: string; version: string }
  | { kind: "amend"; of: string };

export type TraceEntry = {
  ruleId: string;
  policyId: string;
  policyVersion: string;
  authority: PolicyAuthority;
  outcome: DecisionKind | "no_opinion" | "ignored";
  reasonCode?: ReasonCode;
  note?: string;
};

export type GovernanceDecision = {
  decision: DecisionKind;
  policyId: string;
  policyVersion: string;
  ruleId: string;
  authority: PolicyAuthority;
  reasonCode: ReasonCode;
  humanReason: string;
  remediation: string | null;
  requiredAction?: RequiredAction;
  /** Present when a person should look at this: the human-review route, never a silent penalty. */
  review?: { queue: "governance_review"; reason: string };
  /** Present exactly when `decision === "not_evaluated"`. There is no unexplained absence. */
  notEvaluatedReason?: NotEvaluatedReason;
  ruleSetHash: string;
  trace: readonly TraceEntry[];
  evaluatedAt: Date;
};
