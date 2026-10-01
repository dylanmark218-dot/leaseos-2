/**
 * G1 — the deterministic rules the governance kernel evaluates.
 *
 * Pure. Each rule reads the request and either has no opinion or returns one outcome. Rules never
 * read a database, a clock (the request carries `now`), or anything a model wrote: an enforceable rule
 * is code a person can read and a test can pin, not a judgement.
 *
 * Every rule here is `leaseos_mandatory_control` or `leaseos_terms` and `NEVER_OVERRIDABLE`: these are
 * the controls a customer organization's policy cannot relax. What an organization may add on top is
 * in `evaluate.ts` (organization policy rows), and it can only refuse or ask for review.
 *
 * Changing any rule here — its logic, its id, its version, or a word list it matches on — is a change to
 * what LeaseOS enforces, so it changes `RULESET_VERSION`. The conformance suite pins the manifest's hash
 * against the version.
 */
import type { OverrideClass } from "../complianceFinding";
import { NEVER_AUTONOMOUS } from "../actionGateway";
import { SINGLE_TENANT_ID } from "../actingScope";
import type { ReasonCode } from "@shared/_core/reasonCodes";
import type { NotEvaluatedReason } from "../interEngineStatus";
import {
  isHumanActor,
  type DecisionKind,
  type GovernanceRequest,
  type PolicyAuthority,
  type RequiredAction,
  type ResourceLifecycle,
} from "./decision";

export const RULESET_VERSION = "1.0.0";

export type RuleOutcome = {
  decision: Exclude<DecisionKind, "allow">;
  reasonCode: ReasonCode;
  requiredAction?: RequiredAction;
  /** A person should look: the human-review route. */
  review?: string;
  notEvaluatedReason?: NotEvaluatedReason;
  /** Specifics for the trace. Never shown in place of the catalog sentence. */
  note?: string;
};

export type PolicyRule = {
  ruleId: string;
  policyId: string;
  version: string;
  authority: PolicyAuthority;
  overrideClass: OverrideClass;
  decide: (req: GovernanceRequest) => RuleOutcome | null;
};

/* ------------------------------------------------------------------ */
/* Action names                                                         */
/* ------------------------------------------------------------------ */

/** "disposal_ticket.modify", "hos.attestHours": an object, a dot, a verb. Anything else is refused. */
export const ACTION_PATTERN = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** The words of the action's last segment: "attestHours" → ["attest", "hours"]; "void_line" → ["void", "line"]. */
export function verbWords(action: string): string[] {
  const last = action.split(".").pop() ?? "";
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

/**
 * Acts that only a person can perform, because the act IS a person standing behind something.
 * A signature, an attestation, an approval, a verification, an acknowledgement, a release.
 */
export const HUMAN_ONLY_WORDS: readonly string[] = [
  "sign", "countersign", "attest", "acknowledge", "accept", "decline", "approve", "verify", "certify",
  "confirm", "witness", "release", "decide",
];

/**
 * Procedures whose name contains one of those words but whose act is not a person standing behind
 * anything. Each is named with the reason, and the conformance suite fails if an entry stops matching
 * the word list or stops naming a real procedure, so the list cannot drift into a general escape hatch.
 */
export const NOT_HUMAN_ACTS: Readonly<Record<string, string>> = {
  "comms.signQueue": "Reads the queue of pending road-sign observations. The sign is a road sign, and reading a queue attests nothing.",
  "device.verifySeal": "Recomputes an evidence seal against the stored hash. A cryptographic check is a machine's job; no person vouches for anything.",
};

/** Acts that would change or erase what a record says. */
export const REWRITE_WORDS: readonly string[] = [
  "update", "modify", "edit", "delete", "remove", "erase", "purge", "overwrite", "rewrite", "replace", "patch",
];

/** Acts that would take a record out of existence or out of force. */
export const DESTROY_WORDS: readonly string[] = [
  "delete", "remove", "erase", "purge", "destroy", "dispose", "withdraw",
];

/** At or past issue, a record is evidence. A draft is not. */
export const ISSUED_LIFECYCLES: readonly ResourceLifecycle[] = ["issued", "sealed", "finalized", "completed", "signed", "voided"];

const has = (words: readonly string[], set: readonly string[]) => words.some(w => set.includes(w));

/* ------------------------------------------------------------------ */
/* The rules, in evaluation order                                       */
/* ------------------------------------------------------------------ */

const MANDATORY = { authority: "leaseos_mandatory_control" as const, overrideClass: "NEVER_OVERRIDABLE" as const, version: "1" };

export const RULES: readonly PolicyRule[] = [
  {
    ...MANDATORY,
    ruleId: "request.well_formed",
    policyId: "leaseos.integrity",
    decide: req => (ACTION_PATTERN.test(req.action) ? null : { decision: "deny", reasonCode: "INVALID_REQUEST", note: `Action "${req.action.slice(0, 120)}" is not object.verb` }),
  },
  {
    ...MANDATORY,
    ruleId: "permission.established",
    policyId: "leaseos.authorization",
    decide: req => {
      const p = req.context.permission;
      // The permission layer is mandatory input. A missing answer is not a yes.
      if (!p) return { decision: "deny", reasonCode: "PERMISSION_NOT_EVALUATED", note: "No permission result was supplied" };
      if (p.allowed && p.outcome === "allowed") return null;
      if (p.allowed !== (p.outcome === "allowed")) {
        return { decision: "deny", reasonCode: "PERMISSION_NOT_EVALUATED", note: `Inconsistent permission result: allowed=${p.allowed}, outcome=${p.outcome}` };
      }
      return { decision: "deny", reasonCode: p.outcome as Exclude<typeof p.outcome, "allowed">, note: p.detail };
    },
  },
  {
    ...MANDATORY,
    ruleId: "tenant.boundary",
    policyId: "leaseos.tenancy",
    decide: req => {
      const r = req.resource;
      if (!r) return null;
      if (r.orgRef === undefined) return { decision: "deny", reasonCode: "TENANT_UNRESOLVED", note: `${r.type} ${r.ref} carries no established owner` };
      // NULL is the historical single tenant's, the same rule as 0132.
      const owner = r.orgRef ?? SINGLE_TENANT_ID;
      if (owner === req.organization.tenantId) return null;
      return { decision: "deny", reasonCode: "TENANT_BOUNDARY", note: `${r.type} belongs to another organization` };
    },
  },
  {
    ...MANDATORY,
    ruleId: "control.never_overridable",
    policyId: "leaseos.safety",
    decide: req => {
      const o = req.context.override;
      if (!o || o.overrideClass !== "NEVER_OVERRIDABLE") return null;
      return { decision: "deny", reasonCode: "MANDATORY_CONTROL_NOT_OVERRIDABLE", note: `${o.findingCode} is NEVER_OVERRIDABLE` };
    },
  },
  {
    ...MANDATORY,
    ruleId: "agent.never_autonomous",
    policyId: "leaseos.ai",
    decide: req => {
      if (isHumanActor(req.actor)) return null;
      return NEVER_AUTONOMOUS.includes(req.action)
        ? { decision: "deny", reasonCode: "AGENT_NEVER_AUTONOMOUS", note: `${req.action} is on NEVER_AUTONOMOUS` }
        : null;
    },
  },
  {
    ...MANDATORY,
    ruleId: "human.only_signatures",
    policyId: "leaseos.accountability",
    decide: req => {
      if (isHumanActor(req.actor) || Object.prototype.hasOwnProperty.call(NOT_HUMAN_ACTS, req.action)) return null;
      return has(verbWords(req.action), HUMAN_ONLY_WORDS)
        ? { decision: "deny", reasonCode: "AGENT_CANNOT_SIGN", note: `${req.actor.type} actor on ${req.action}` }
        : null;
    },
  },
  {
    ...MANDATORY,
    ruleId: "compliance.authoritative",
    policyId: "leaseos.safety",
    decide: req => {
      const c = req.context.compliance;
      if (!c) return null;
      const note = c.reasonCodes.length ? c.reasonCodes.join(", ").slice(0, 400) : undefined;
      if (c.state === "blocked") return { decision: "deny", reasonCode: "COMPLIANCE_BLOCKED", note };
      // Unknown is not permission (actionGateway rule 4, unchanged).
      if (c.state === "unknown") return { decision: "deny", reasonCode: "COMPLIANCE_UNKNOWN", note };
      if (c.state === "review") return { decision: "require_review", reasonCode: "COMPLIANCE_REVIEW", review: "A compliance engine asked for review", note };
      return null;
    },
  },
  {
    ...MANDATORY,
    ruleId: "record.legal_hold",
    policyId: "leaseos.integrity",
    decide: req => {
      const r = req.resource;
      if (!r?.legalHold || !has(verbWords(req.action), DESTROY_WORDS)) return null;
      return { decision: "deny", reasonCode: "RECORD_UNDER_LEGAL_HOLD", note: `${r.type} ${r.ref}` };
    },
  },
  {
    ...MANDATORY,
    ruleId: "record.issued_immutable",
    policyId: "leaseos.integrity",
    decide: req => {
      const r = req.resource;
      if (!r?.lifecycle || !ISSUED_LIFECYCLES.includes(r.lifecycle)) return null;
      if (!has(verbWords(req.action), REWRITE_WORDS)) return null;
      return {
        decision: "deny", reasonCode: "ISSUED_DOCUMENT_IMMUTABLE",
        requiredAction: { kind: "amend", of: `${r.type}:${r.ref}` },
        note: `${r.type} ${r.ref} is ${r.lifecycle}`,
      };
    },
  },
  {
    authority: "leaseos_terms",
    overrideClass: "NEVER_OVERRIDABLE",
    version: "1",
    ruleId: "acceptance.required",
    policyId: "leaseos.terms",
    decide: req => {
      const required = req.context.requiredAcceptances ?? [];
      if (required.length === 0) return null;
      const on = req.context.acceptances;
      // Not consulted is not "none on file", and neither is consent.
      if (on === undefined) {
        return { decision: "not_evaluated", reasonCode: "ACCEPTANCE_NOT_EVALUATED", notEvaluatedReason: "no_data_source_loaded" };
      }
      const now = req.context.now.getTime();
      for (const need of required) {
        // A record dated after the decision is not evidence at the decision. The server writes
        // recordedAt, so this only ever excludes a row that should not exist.
        const mine = on
          .filter(a => a.policyKey === need.policyKey && a.recordedAt.getTime() <= now)
          .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
        const latest = mine[0];
        const accept: RuleOutcome = {
          decision: "require_action", reasonCode: "ACCEPTANCE_REQUIRED",
          requiredAction: { kind: "accept_policy", policyKey: need.policyKey, version: need.currentVersion },
        };
        if (!latest) return { ...accept, note: `${need.policyKey}: nothing on file` };
        if (latest.state !== "accepted") return { ...accept, note: `${need.policyKey}: latest is ${latest.state}` };
        const v = need.acceptableVersions.find(x => x.version === latest.version);
        if (v) {
          // Same version: the text accepted must be the text approved, and it cannot have been
          // accepted before it existed. Either failure means the record proves nothing.
          if (v.contentHash !== latest.contentHashAtAcceptance) return { ...accept, note: `${need.policyKey} ${latest.version}: accepted text does not match the approved text` };
          if (latest.recordedAt.getTime() < v.effectiveFrom.getTime()) return { ...accept, note: `${need.policyKey} ${latest.version}: acceptance predates the version` };
          continue;
        }
        return {
          decision: "require_action", reasonCode: "ACCEPTANCE_STALE",
          requiredAction: { kind: "accept_policy", policyKey: need.policyKey, version: need.currentVersion },
          note: `${need.policyKey}: accepted ${latest.version}, which a material change has superseded`,
        };
      }
      return null;
    },
  },
];

/**
 * The manifest the conformance suite pins: what this kernel enforces, by id and version, and the
 * vocabularies the rules match on. Changing a word list changes what is enforced as surely as editing
 * a rule, so the lists are inside the hash. A rule's function body is not — a change to one is caught
 * in review by its version, which is why every rule carries one.
 */
export const rulesetManifest = (): string => [
  `ruleset=${RULESET_VERSION}`,
  ...RULES.map(r => `${r.ruleId}@${r.version}:${r.authority}:${r.overrideClass}`),
  `human_only=${[...HUMAN_ONLY_WORDS].sort().join(",")}`,
  `not_human_acts=${Object.keys(NOT_HUMAN_ACTS).sort().join(",")}`,
  `rewrite=${[...REWRITE_WORDS].sort().join(",")}`,
  `destroy=${[...DESTROY_WORDS].sort().join(",")}`,
  `issued=${[...ISSUED_LIFECYCLES].sort().join(",")}`,
  `never_autonomous=${[...NEVER_AUTONOMOUS].sort().join(",")}`,
].join("\n");
