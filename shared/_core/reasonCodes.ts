/**
 * G1 — the stable reason codes a governance decision may carry.
 *
 * Shared so the client renders the same words the server decided, instead of matching on prose. A
 * code is a contract: once a code has shipped it keeps its meaning, and a changed meaning is a new
 * code. Every code carries the sentence a person reads and what they can do about it, because "Not
 * allowed" tells an operator nothing they can act on.
 *
 * The four permission codes are spelled exactly as `authorizationDecisions.outcome` spells them, so a
 * permission denial and a governance denial are one vocabulary rather than two.
 */

export type ReasonCodeEntry = {
  /** What a person reads. A fact about the refusal, never a guess about intent. */
  humanReason: string;
  /** What can be done instead. Null only where nothing the reader does changes the answer. */
  remediation: string | null;
};

export const REASON_CODES = {
  /* ---- permission (the same strings as authorizationDecisions.outcome) ---- */
  denied_unauthenticated: {
    humanReason: "Nobody is signed in for this request.",
    remediation: "Sign in and try again.",
  },
  denied_no_role: {
    humanReason: "Your account holds no role that can do this.",
    remediation: "Ask an administrator in your organization for the role this work needs.",
  },
  denied_permission: {
    humanReason: "None of your roles grants this action.",
    remediation: "Ask an administrator in your organization for the permission this work needs.",
  },
  denied_scope: {
    humanReason: "Your roles do not reach the branch or organization this record belongs to.",
    remediation: "Ask somebody whose role covers that branch, or ask for a grant there.",
  },
  PERMISSION_NOT_EVALUATED: {
    humanReason: "Whether you may do this was not established, so it is refused.",
    remediation: null,
  },

  /* ---- the request itself ---- */
  INVALID_REQUEST: {
    humanReason: "The request does not name a recognisable action.",
    remediation: null,
  },

  /* ---- tenancy ---- */
  TENANT_BOUNDARY: {
    // Deliberately the same sentence as a record that does not exist: the existence of another
    // organization's record is not this caller's to learn.
    humanReason: "That record was not found.",
    remediation: null,
  },
  TENANT_UNRESOLVED: {
    humanReason: "Which organization owns that record could not be established, so it is refused.",
    remediation: null,
  },

  /* ---- mandatory controls ---- */
  MANDATORY_CONTROL_NOT_OVERRIDABLE: {
    humanReason: "This is a mandatory safety or legal control. No role, policy or approval can override it.",
    remediation: "Fix the condition behind it; the control lifts when the condition is gone.",
  },
  AGENT_NEVER_AUTONOMOUS: {
    humanReason: "This removes a safeguard, and an automated agent never does that.",
    remediation: "A person with the authority must do it themselves.",
  },
  COMPLIANCE_BLOCKED: {
    humanReason: "A compliance check blocked this.",
    remediation: "Resolve the findings the compliance check named.",
  },
  COMPLIANCE_REVIEW: {
    humanReason: "A compliance check needs a person to review this before it goes ahead.",
    remediation: "It has been sent for review.",
  },
  COMPLIANCE_UNKNOWN: {
    humanReason: "Whether this is compliant could not be established. Unknown is not permission.",
    remediation: "Supply or verify the missing information, then try again.",
  },

  /* ---- human accountability ---- */
  AGENT_CANNOT_SIGN: {
    humanReason: "Only a person can sign, attest, approve or acknowledge. An automated actor cannot do it for them.",
    remediation: "The person responsible must do this themselves.",
  },

  /* ---- record integrity ---- */
  ISSUED_DOCUMENT_IMMUTABLE: {
    humanReason: "This record has been issued. Its content is not edited or erased after that.",
    remediation: "Create an amendment, correction or void that refers to it.",
  },
  RECORD_UNDER_LEGAL_HOLD: {
    humanReason: "This record is under a legal hold and cannot be removed or withdrawn.",
    remediation: "The hold has to be released by the person who holds that authority first.",
  },

  /* ---- policy acceptance ---- */
  ACCEPTANCE_REQUIRED: {
    humanReason: "You have not accepted a policy this action requires.",
    remediation: "Read and accept the current version of the policy.",
  },
  ACCEPTANCE_STALE: {
    humanReason: "The policy you accepted has changed materially since you accepted it.",
    remediation: "Read and accept the current version of the policy.",
  },
  ACCEPTANCE_NOT_EVALUATED: {
    humanReason: "Whether you have accepted the required policies could not be established, so this is not allowed yet.",
    remediation: null,
  },

  /* ---- organization policy ---- */
  ORGANIZATION_POLICY_DENIED: {
    humanReason: "Your organization's policy does not allow this.",
    remediation: "Ask whoever manages that policy in your organization.",
  },
  ORGANIZATION_POLICY_REVIEW: {
    humanReason: "Your organization's policy requires a person to review this first.",
    remediation: "It has been sent for review.",
  },
  ORG_POLICY_EXCEEDS_CEILING: {
    humanReason: "An organization policy tried to relax a control it does not have the authority to relax, and was ignored.",
    remediation: null,
  },
  POLICY_CONFLICT: {
    humanReason: "Two policies in force disagree about this, so a person must decide.",
    remediation: "It has been sent for review; whoever manages the policies should resolve the conflict.",
  },

  /* ---- the default ---- */
  NO_RULE_OBJECTED: {
    humanReason: "Permitted.",
    remediation: null,
  },
} as const satisfies Record<string, ReasonCodeEntry>;

export type ReasonCode = keyof typeof REASON_CODES;

export const isReasonCode = (s: string): s is ReasonCode => Object.prototype.hasOwnProperty.call(REASON_CODES, s);
