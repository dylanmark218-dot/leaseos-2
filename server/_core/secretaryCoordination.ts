/**
 * v22.20 — the Secretary proposes; it does not run the company.
 *
 * Pure. No network, no database.
 *
 * Extends the proposal-and-approval model that already exists rather than
 * adding a second one: an assistant proposal is a record with a target, a
 * read-back and a human decision, and everything here produces that shape.
 * Nothing in this file writes anything.
 *
 * **The floor.** Some actions are never automatic, whatever a company's policy
 * says. Assigning a person to work, approving leave, moving money, changing
 * payroll, and anything that decides a compliance question all require a named
 * human authority. A company may make automation *narrower* than this and can
 * never make it wider — the same dominance rule the out-of-service release
 * follows, for the same reason: the party with the least at stake should not be
 * the one able to relax the rule.
 *
 * What is left for automation is genuinely small, and that is the point: a
 * reminder that somebody owes a ticket is worth sending without asking. A
 * decision about who drives tomorrow is not.
 *
 * **A briefing states what the engines found.** Every line carries the source
 * it came from. A Secretary that summarises and cannot be traced is a Secretary
 * whose mistakes look exactly like its successes.
 */

import type { EventSource } from "./calendarProjection";

export type ProposalAction =
  | "send_reminder"          // tell somebody they owe something
  | "draft_message"          // prepare words for a person to send
  | "create_review_task"     // put work in a queue for a human
  | "assign_person"          // who works what
  | "approve_leave"
  | "schedule_payment"
  | "change_payroll"
  | "resolve_compliance";    // anything that decides a regulatory question

/** Who must decide, when a human must. */
export type Authority = "none" | "supervisor" | "dispatch" | "payroll" | "finance" | "safety" | "management";

/**
 * The floor. Not configurable, and not a default — a policy that tries to
 * automate one of these is rejected rather than honoured.
 */
export const NEVER_AUTOMATIC: readonly ProposalAction[] = [
  "assign_person", "approve_leave", "schedule_payment", "change_payroll", "resolve_compliance",
];

const REQUIRES: Record<ProposalAction, Authority> = {
  send_reminder: "none",
  draft_message: "none",
  create_review_task: "none",
  assign_person: "dispatch",
  approve_leave: "supervisor",
  schedule_payment: "finance",
  change_payroll: "payroll",
  resolve_compliance: "safety",
};

export type AutomationPolicy = {
  policyRef: string;
  /** Actions this company is willing to have happen without asking. */
  automatic: readonly ProposalAction[];
};

export class PolicyExceedsFloor extends Error {}

/**
 * Validate a company's automation policy.
 *
 * Rejected rather than trimmed. Silently narrowing a policy would leave an
 * administrator believing they had configured something they had not, which is
 * worse than being told no.
 */
export function validatePolicy(policy: AutomationPolicy): void {
  const overreach = policy.automatic.filter(a => NEVER_AUTOMATIC.includes(a));
  if (overreach.length) {
    throw new PolicyExceedsFloor(
      `${policy.policyRef} tries to automate ${overreach.join(", ")}. Those need a named person every time; a policy may narrow what is automatic and never widen it.`,
    );
  }
}

export type Observation = {
  /** What an engine found. Not what the Secretary thinks about it. */
  finding: string;
  source: EventSource;
  urgency: "routine" | "soon" | "urgent";
};

export type Proposal = {
  proposalRef: string;
  action: ProposalAction;
  title: string;
  /** The record this would touch, in the existing proposal vocabulary. */
  targetRef: string;
  rationale: Observation[];
  requiresAuthority: Authority;
  /** True only for actions on the floor's safe side AND permitted by policy. */
  automatic: boolean;
  /** Structurally. Producing a proposal never performs it. */
  performed: false;
  note: string;
};

/**
 * Turn an observation into something a person can accept or reject.
 *
 * The authority comes from the action, never from the caller or from how
 * confident the Secretary is. Confidence is not authority.
 */
export function propose(args: {
  proposalRef: string;
  action: ProposalAction;
  title: string;
  targetRef: string;
  rationale: readonly Observation[];
  policy: AutomationPolicy;
}): Proposal {
  validatePolicy(args.policy);
  const requiresAuthority = REQUIRES[args.action];
  const automatic = requiresAuthority === "none" && args.policy.automatic.includes(args.action);
  return {
    proposalRef: args.proposalRef, action: args.action, title: args.title, targetRef: args.targetRef,
    rationale: [...args.rationale], requiresAuthority, automatic, performed: false,
    note: automatic
      ? `Runs under ${args.policy.policyRef} without asking. It sends or drafts; it decides nothing.`
      : `Needs ${requiresAuthority === "none" ? "somebody to accept it" : `a ${requiresAuthority} decision`}. Proposed, not done.`,
  };
}

export type Briefing = {
  at: Date;
  observations: Observation[];
  proposals: Proposal[];
  /** Split so a reader can see what will happen anyway from what needs them. */
  automatic: Proposal[];
  awaitingDecision: Proposal[];
  lines: string[];
};

/**
 * Assemble the morning briefing.
 *
 * Observations are stated as the engines reported them, each with its source.
 * The Secretary does not rank them by its own judgement of importance — urgency
 * comes from the engine that found the thing, which knows what it means.
 */
export function briefing(args: { at: Date; observations: readonly Observation[]; proposals: readonly Proposal[] }): Briefing {
  const order = { urgent: 0, soon: 1, routine: 2 } as const;
  const observations = [...args.observations].sort((a, b) => order[a.urgency] - order[b.urgency]);
  const automatic = args.proposals.filter(p => p.automatic);
  const awaitingDecision = args.proposals.filter(p => !p.automatic);
  return {
    at: args.at, observations, proposals: [...args.proposals], automatic, awaitingDecision,
    lines: [
      ...observations.map(o => `${o.urgency === "urgent" ? "!" : o.urgency === "soon" ? "·" : " "} ${o.finding}  [${o.source.sourceType}:${o.source.sourceRef}]`),
      ...(awaitingDecision.length ? ["", `${awaitingDecision.length} suggestion(s) need a decision:`] : []),
      ...awaitingDecision.map(p => `  ${p.title} — ${p.requiresAuthority}`),
    ],
  };
}

export type Acceptance =
  | { accepted: true; proposalRef: string; byUserId: number; authority: Authority; note: string }
  | { accepted: false; proposalRef: string; reason: string };

export class WrongAuthority extends Error {}

/**
 * A person accepts a proposal.
 *
 * Still does not perform it: this records that somebody with the right standing
 * said yes, and the real workflow runs afterwards with its own checks. A
 * dispatcher accepting an assignment proposal does not bypass the readiness
 * gate any more than tapping *Interested* did.
 */
export function accept(args: { proposal: Proposal; byUserId: number; heldAuthorities: readonly Authority[] }): Acceptance {
  if (args.proposal.automatic) {
    return { accepted: false, proposalRef: args.proposal.proposalRef, reason: "This one runs on its own; there is nothing to accept" };
  }
  if (args.proposal.requiresAuthority !== "none" && !args.heldAuthorities.includes(args.proposal.requiresAuthority)) {
    throw new WrongAuthority(
      `${args.proposal.proposalRef} needs a ${args.proposal.requiresAuthority} decision and this person holds ${args.heldAuthorities.join(", ") || "no relevant authority"}`,
    );
  }
  return {
    accepted: true, proposalRef: args.proposal.proposalRef, byUserId: args.byUserId,
    authority: args.proposal.requiresAuthority,
    note: "Accepted. The owning workflow runs next with its own checks — accepting a suggestion is not performing it.",
  };
}

/* ------------------------------------------------------------------ */
/* The briefing layer and the enforcement layer must not drift          */
/* ------------------------------------------------------------------ */

/**
 * This module and `actionGateway` both answer "may this happen without a
 * person", at different distances from the act.
 *
 * A proposal is a suggestion in a briefing. A gateway request is an attempt to
 * change something. They are genuinely different layers and merging them would
 * collapse a real distinction — the briefing exists precisely so a person sees
 * the suggestion before anything is attempted.
 *
 * What they must not do is disagree. Two independently maintained lists of
 * "never automatic" is the shape that produced two receipt vocabularies: each
 * correct on its own, silently diverging, until one of them lets through what
 * the other forbids. So every action this module refuses to automate is mapped
 * here to the risk the gateway would assign the corresponding capability, and a
 * test fails if one list moves without the other.
 */
export const PROPOSAL_RISK: Record<ProposalAction, "read" | "prepare" | "low_risk_action" | "approval_required" | "restricted"> = {
  send_reminder: "low_risk_action",
  draft_message: "prepare",
  create_review_task: "low_risk_action",
  // Each of these is on NEVER_AUTOMATIC above, and each must be a risk the
  // gateway will not let an agent run unattended.
  assign_person: "approval_required",
  approve_leave: "approval_required",
  schedule_payment: "approval_required",
  change_payroll: "restricted",
  resolve_compliance: "restricted",
};

/** Risks at which the gateway always involves a person. */
export const RISKS_REQUIRING_A_PERSON: readonly string[] = ["approval_required", "restricted"];

/**
 * Whether the two layers still agree.
 *
 * Returns the disagreements rather than a boolean, because "they diverged" is
 * not actionable and "approve_leave is marked prepare" is.
 */
export function floorDisagreements(): string[] {
  const out: string[] = [];
  for (const action of NEVER_AUTOMATIC) {
    const risk = PROPOSAL_RISK[action];
    if (!RISKS_REQUIRING_A_PERSON.includes(risk)) {
      out.push(`${action} is never automatic here but maps to ${risk}, which the gateway would run unattended`);
    }
  }
  for (const [action, risk] of Object.entries(PROPOSAL_RISK) as [ProposalAction, string][]) {
    if (RISKS_REQUIRING_A_PERSON.includes(risk) && !NEVER_AUTOMATIC.includes(action)) {
      out.push(`${action} needs a person at the gateway but is not on this module's floor`);
    }
  }
  return out;
}
