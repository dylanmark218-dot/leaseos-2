/**
 * G1 — the governance kernel, rule by rule and branch by branch.
 *
 * Pure: no database, no network, an injected clock. The standing, enumerate-from-source invariants
 * live in `server/governanceConformance.test.ts`; this file pins each rule's own behaviour.
 */
import { describe, expect, it } from "vitest";
import { REASON_CODES } from "@shared/_core/reasonCodes";
import { evaluate, ruleSetHash } from "./evaluate";
import { HUMAN_ONLY_WORDS, RULES, verbWords } from "./rules";
import { decisionKindFromGateway, overrideFactFromBlocker, permissionFactFrom, toCapabilityResult } from "./adapters";
import type { AcceptanceFact, GovernanceRequest, OrganizationPolicyRow, RequiredAcceptance } from "./decision";

const NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const req = (over: Partial<Omit<GovernanceRequest, "context">> & { context?: Partial<GovernanceRequest["context"]> } = {}): GovernanceRequest => ({
  actor: { type: "user", userId: 7 },
  organization: { tenantId: "org-a", derivedFrom: "membership" },
  action: "disposal_ticket.read",
  resource: null,
  ...over,
  context: { permission: { allowed: true, outcome: "allowed" }, now: NOW, ...(over.context ?? {}) },
});

const agent = { type: "agent" as const, agentKey: "secretary", runRef: "RUN-1", delegatedByUserId: 7 };

describe("the default", () => {
  it("allows when no rule objects, and says which rules it asked", () => {
    const d = evaluate(req());
    expect(d.decision).toBe("allow");
    expect(d.reasonCode).toBe("NO_RULE_OBJECTED");
    expect(d.trace.map(t => t.ruleId)).toEqual(RULES.map(r => r.ruleId));
    expect(d.trace.every(t => t.outcome === "no_opinion")).toBe(true);
    expect(d.ruleSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.ruleSetHash).toBe(ruleSetHash());
    expect(d.evaluatedAt).toBe(NOW);
  });
});

describe("request.well_formed", () => {
  it.each(["", "disposal_ticket", "DisposalTicket.read", "a..b", "a.b c", "a.1b"])("refuses %j", action => {
    const d = evaluate(req({ action }));
    expect(d.decision).toBe("deny");
    expect(d.reasonCode).toBe("INVALID_REQUEST");
  });
});

describe("permission.established", () => {
  it("refuses when no permission result was supplied — missing is not yes", () => {
    const d = evaluate(req({ context: { permission: null } }));
    expect(d).toMatchObject({ decision: "deny", reasonCode: "PERMISSION_NOT_EVALUATED", ruleId: "permission.established" });
  });
  it.each(["denied_no_role", "denied_permission", "denied_scope", "denied_unauthenticated"] as const)("carries %s through as the reason code", outcome => {
    const d = evaluate(req({ context: { permission: { allowed: false, outcome } } }));
    expect(d.decision).toBe("deny");
    expect(d.reasonCode).toBe(outcome);
    expect(d.humanReason).toBe(REASON_CODES[outcome].humanReason);
  });
  it("refuses an inconsistent result rather than believing either half", () => {
    expect(evaluate(req({ context: { permission: { allowed: true, outcome: "denied_scope" } } })).reasonCode).toBe("PERMISSION_NOT_EVALUATED");
    expect(evaluate(req({ context: { permission: { allowed: false, outcome: "allowed" } } })).reasonCode).toBe("PERMISSION_NOT_EVALUATED");
  });
});

describe("tenant.boundary", () => {
  const res = (orgRef: string | null | undefined) => ({ type: "disposal_ticket", ref: "DSP-1", orgRef });
  it("allows the caller's own organization", () => {
    expect(evaluate(req({ resource: res("org-a") })).decision).toBe("allow");
  });
  it("refuses another organization's record in the words used for a missing one", () => {
    const d = evaluate(req({ resource: res("org-b") }));
    expect(d).toMatchObject({ decision: "deny", reasonCode: "TENANT_BOUNDARY" });
    expect(d.humanReason).toBe("That record was not found.");
  });
  it("reads NULL as the historical single tenant's, and only theirs", () => {
    expect(evaluate(req({ resource: res(null), organization: { tenantId: "default", derivedFrom: "single_tenant_fallback" } })).decision).toBe("allow");
    expect(evaluate(req({ resource: res(null) })).reasonCode).toBe("TENANT_BOUNDARY");
  });
  it("refuses a resource whose owner nobody established", () => {
    expect(evaluate(req({ resource: res(undefined) })).reasonCode).toBe("TENANT_UNRESOLVED");
  });
});

describe("control.never_overridable", () => {
  it("refuses to lift a NEVER_OVERRIDABLE control, for a person too", () => {
    const d = evaluate(req({ action: "dispatch.override", context: { override: { findingCode: "oos_order_active", overrideClass: "NEVER_OVERRIDABLE" } } }));
    expect(d).toMatchObject({ decision: "deny", reasonCode: "MANDATORY_CONTROL_NOT_OVERRIDABLE", authority: "leaseos_mandatory_control" });
  });
  it("leaves APPROVED_POLICY_ONLY to the override policy path, which decides it", () => {
    expect(evaluate(req({ action: "dispatch.override", context: { override: { findingCode: "x", overrideClass: "APPROVED_POLICY_ONLY" } } })).decision).toBe("allow");
  });
});

describe("agent.never_autonomous", () => {
  it("refuses an agent removing a safeguard, and leaves a person to do it", () => {
    expect(evaluate(req({ actor: agent, action: "audit.delete" })).reasonCode).toBe("AGENT_NEVER_AUTONOMOUS");
    expect(evaluate(req({ action: "audit.delete" })).decision).toBe("allow");
  });
});

describe("human.only_signatures", () => {
  it("splits the verb out of the action", () => {
    expect(verbWords("hos.attestHours")).toEqual(["attest", "hours"]);
    expect(verbWords("comms.packageAcknowledge")).toEqual(["package", "acknowledge"]);
    expect(verbWords("invoicing.void_line")).toEqual(["void", "line"]);
  });
  it.each(["hos.attestHours", "portal.customer.sign", "agent.decideApproval", "hos.limitVerify", "policy.accept"])("refuses an agent on %s", action => {
    const d = evaluate(req({ actor: agent, action }));
    expect(d).toMatchObject({ decision: "deny", reasonCode: "AGENT_CANNOT_SIGN" });
  });
  it("refuses a system or integration actor too: only a person stands behind a signature", () => {
    expect(evaluate(req({ actor: { type: "system", component: "worker" }, action: "fieldTicket.sign" })).reasonCode).toBe("AGENT_CANNOT_SIGN");
    expect(evaluate(req({ actor: { type: "integration", clientRef: "IC-1" }, action: "ticket.confirm" })).reasonCode).toBe("AGENT_CANNOT_SIGN");
  });
  it("lets a person sign, including a person behind a portal identity", () => {
    expect(evaluate(req({ action: "portal.customer.sign" })).decision).toBe("allow");
    expect(evaluate(req({ actor: { type: "external", identityRef: "EXT-1", kind: "customer" }, action: "portal.customer.sign" })).decision).toBe("allow");
  });
  it("does not catch words that merely start like one", () => {
    expect(evaluate(req({ actor: agent, action: "assistant.draft" })).decision).toBe("allow");
    expect(evaluate(req({ actor: agent, action: "records.signatureList" })).decision).toBe("allow");
    expect(HUMAN_ONLY_WORDS).not.toContain("signature");
  });
});

describe("compliance.authoritative", () => {
  it("blocked is a refusal and unknown is not permission", () => {
    expect(evaluate(req({ context: { compliance: { state: "blocked", reasonCodes: ["hos_insufficient"] } } }))).toMatchObject({ decision: "deny", reasonCode: "COMPLIANCE_BLOCKED" });
    expect(evaluate(req({ context: { compliance: { state: "unknown", reasonCodes: [] } } }))).toMatchObject({ decision: "deny", reasonCode: "COMPLIANCE_UNKNOWN" });
  });
  it("review goes to a person; pass and absent say nothing", () => {
    const d = evaluate(req({ context: { compliance: { state: "review", reasonCodes: [] } } }));
    expect(d).toMatchObject({ decision: "require_review", reasonCode: "COMPLIANCE_REVIEW" });
    expect(d.review?.queue).toBe("governance_review");
    expect(evaluate(req({ context: { compliance: { state: "pass", reasonCodes: [] } } })).decision).toBe("allow");
  });
  it("names the engine's own codes in the trace", () => {
    const d = evaluate(req({ context: { compliance: { state: "blocked", reasonCodes: ["critical_defect"] } } }));
    expect(d.trace.find(t => t.ruleId === "compliance.authoritative")?.note).toBe("critical_defect");
  });
});

describe("record integrity", () => {
  const issued = { type: "manifest", ref: "MAN-1", orgRef: "org-a", lifecycle: "sealed" as const };
  it("refuses rewriting an issued record and points at an amendment", () => {
    const d = evaluate(req({ action: "manifest.update", resource: issued }));
    expect(d).toMatchObject({ decision: "deny", reasonCode: "ISSUED_DOCUMENT_IMMUTABLE", requiredAction: { kind: "amend", of: "manifest:MAN-1" } });
    expect(d.remediation).toMatch(/amendment/);
  });
  it("lets a draft be edited, and lets an issued record be voided or amended", () => {
    expect(evaluate(req({ action: "manifest.update", resource: { ...issued, lifecycle: "draft" } })).decision).toBe("allow");
    expect(evaluate(req({ action: "invoicing.void", resource: { ...issued, lifecycle: "finalized" } })).decision).toBe("allow");
    expect(evaluate(req({ action: "manifest.amend", resource: issued })).decision).toBe("allow");
  });
  it("refuses removing a record under legal hold, whatever its stage", () => {
    const held = { ...issued, lifecycle: "draft" as const, legalHold: true };
    expect(evaluate(req({ action: "evidence.delete", resource: held })).reasonCode).toBe("RECORD_UNDER_LEGAL_HOLD");
    expect(evaluate(req({ action: "commercialDocument.withdraw", resource: held })).reasonCode).toBe("RECORD_UNDER_LEGAL_HOLD");
    expect(evaluate(req({ action: "evidence.read", resource: held })).decision).toBe("allow");
  });
});

describe("acceptance.required", () => {
  const terms: RequiredAcceptance = {
    policyKey: "leaseos.terms", currentVersion: "2.0",
    acceptableVersions: [{ version: "2.0", contentHash: "h2", effectiveFrom: ago(10) }],
  };
  const ok: AcceptanceFact = { policyKey: "leaseos.terms", version: "2.0", contentHashAtAcceptance: "h2", state: "accepted", recordedAt: ago(5) };
  const withAcc = (acceptances: AcceptanceFact[] | undefined, required = [terms]) => req({ context: { requiredAcceptances: required, acceptances } });

  it("says nothing when no acceptance is required", () => {
    expect(evaluate(req({ context: { acceptances: [] } })).decision).toBe("allow");
  });
  it("allows the current version, accepted after it took effect, over the approved text", () => {
    expect(evaluate(withAcc([ok])).decision).toBe("allow");
  });
  it("treats an unconsulted acceptance source as not evaluated, never as consent", () => {
    const d = evaluate(withAcc(undefined));
    expect(d).toMatchObject({ decision: "not_evaluated", reasonCode: "ACCEPTANCE_NOT_EVALUATED", notEvaluatedReason: "no_data_source_loaded" });
  });
  it("asks for acceptance when nothing is on file, naming the version", () => {
    const d = evaluate(withAcc([]));
    expect(d).toMatchObject({ decision: "require_action", reasonCode: "ACCEPTANCE_REQUIRED", requiredAction: { kind: "accept_policy", policyKey: "leaseos.terms", version: "2.0" } });
  });
  it("reads the latest record: a decline or withdrawal after acceptance is not acceptance", () => {
    expect(evaluate(withAcc([ok, { ...ok, state: "withdrawn", recordedAt: ago(1) }])).reasonCode).toBe("ACCEPTANCE_REQUIRED");
    expect(evaluate(withAcc([{ ...ok, state: "declined" }])).reasonCode).toBe("ACCEPTANCE_REQUIRED");
    expect(evaluate(withAcc([{ ...ok, state: "declined", recordedAt: ago(8) }, ok])).decision).toBe("allow");
  });
  it("does not count text other than the approved text", () => {
    expect(evaluate(withAcc([{ ...ok, contentHashAtAcceptance: "tampered" }])).reasonCode).toBe("ACCEPTANCE_REQUIRED");
  });
  it("does not count an acceptance dated before the version existed, or after the decision", () => {
    expect(evaluate(withAcc([{ ...ok, recordedAt: ago(11) }])).reasonCode).toBe("ACCEPTANCE_REQUIRED");
    expect(evaluate(withAcc([{ ...ok, recordedAt: new Date(NOW.getTime() + DAY) }])).reasonCode).toBe("ACCEPTANCE_REQUIRED");
  });
  it("calls an acceptance of a materially superseded version stale", () => {
    const d = evaluate(withAcc([{ ...ok, version: "1.0", contentHashAtAcceptance: "h1" }]));
    expect(d).toMatchObject({ decision: "require_action", reasonCode: "ACCEPTANCE_STALE" });
  });
  it("carries an earlier acceptance forward across a non-material change", () => {
    const nonMaterial: RequiredAcceptance = {
      ...terms, currentVersion: "2.1",
      acceptableVersions: [{ version: "2.1", contentHash: "h21", effectiveFrom: ago(2) }, terms.acceptableVersions[0]!],
    };
    expect(evaluate(withAcc([ok], [nonMaterial])).decision).toBe("allow");
  });
  it("checks every required policy, not only the first", () => {
    const privacy: RequiredAcceptance = { policyKey: "leaseos.privacy", currentVersion: "1.0", acceptableVersions: [{ version: "1.0", contentHash: "p1", effectiveFrom: ago(10) }] };
    const d = evaluate(withAcc([ok], [terms, privacy]));
    expect(d.requiredAction).toEqual({ kind: "accept_policy", policyKey: "leaseos.privacy", version: "1.0" });
  });
});

describe("organization policy rows", () => {
  const row = (over: Partial<OrganizationPolicyRow> = {}): OrganizationPolicyRow => ({
    policyRef: "OP-1", version: 1, authority: "company_policy", action: "disposal_ticket.read", effect: "deny",
    effectiveFrom: ago(30), effectiveTo: null, ...over,
  });
  const withRows = (rows: OrganizationPolicyRow[], over = {}) => req({ ...over, context: { organizationPolicies: rows } });

  it("can refuse, and the refusal has a review route", () => {
    const d = evaluate(withRows([row()]));
    expect(d).toMatchObject({ decision: "deny", reasonCode: "ORGANIZATION_POLICY_DENIED", policyId: "OP-1", policyVersion: "1", authority: "company_policy" });
    expect(d.review?.queue).toBe("governance_review");
  });
  it("can require review", () => {
    expect(evaluate(withRows([row({ effect: "require_review" })])).reasonCode).toBe("ORGANIZATION_POLICY_REVIEW");
  });
  it("cannot grant: an allow row is ignored and says so", () => {
    const d = evaluate(req({ context: { permission: { allowed: false, outcome: "denied_permission" }, organizationPolicies: [row({ effect: "allow" })] } }));
    expect(d.reasonCode).toBe("denied_permission");
    expect(d.trace.find(t => t.policyId === "OP-1")?.outcome).toBe("ignored");
    // And on an otherwise-allowed request it changes nothing either.
    expect(evaluate(withRows([row({ effect: "allow" })])).reasonCode).toBe("NO_RULE_OBJECTED");
  });
  it("ignores a row claiming an authority an organization does not hold", () => {
    const d = evaluate(withRows([row({ authority: "statute_regulation" })]));
    expect(d.decision).toBe("allow");
    expect(d.trace.find(t => t.policyId === "OP-1")).toMatchObject({ outcome: "ignored", reasonCode: "ORG_POLICY_EXCEEDS_CEILING" });
  });
  it("only reads rows in force, for this exact action", () => {
    expect(evaluate(withRows([row({ effectiveTo: ago(1) })])).decision).toBe("allow");
    expect(evaluate(withRows([row({ effectiveFrom: new Date(NOW.getTime() + DAY) })])).decision).toBe("allow");
    expect(evaluate(withRows([row({ action: "disposal_ticket.list" })])).decision).toBe("allow");
  });
  it("sends two versions in force under one reference to a person rather than picking", () => {
    const d = evaluate(withRows([row({ version: 1, effect: "deny" }), row({ version: 2, effect: "require_review" })]));
    expect(d).toMatchObject({ decision: "require_review", reasonCode: "POLICY_CONFLICT", policyVersion: "1, 2" });
  });
});

describe("precedence", () => {
  it("reports the worst outcome and keeps the rest in the trace", () => {
    const d = evaluate(req({
      resource: { type: "t", ref: "1", orgRef: "org-b" },
      context: { organizationPolicies: [{ policyRef: "OP-R", version: 1, authority: "company_policy", action: "disposal_ticket.read", effect: "require_review", effectiveFrom: ago(1), effectiveTo: null }] },
    }));
    expect(d.reasonCode).toBe("TENANT_BOUNDARY");
    expect(d.trace.map(t => t.outcome)).toContain("require_review");
  });
  it("prefers the stronger authority between two refusals", () => {
    const d = evaluate(req({
      action: "manifest.update",
      resource: { type: "manifest", ref: "M", orgRef: "org-a", lifecycle: "sealed" },
      context: { organizationPolicies: [{ policyRef: "OP-D", version: 1, authority: "company_policy", action: "manifest.update", effect: "deny", effectiveFrom: ago(1), effectiveTo: null }] },
    }));
    expect(d).toMatchObject({ reasonCode: "ISSUED_DOCUMENT_IMMUTABLE", authority: "leaseos_mandatory_control" });
  });
  it("breaks a tie at one authority by rule order: permission before tenancy", () => {
    const d = evaluate(req({ resource: { type: "t", ref: "1", orgRef: "org-b" }, context: { permission: { allowed: false, outcome: "denied_scope" } } }));
    expect(d.reasonCode).toBe("denied_scope");
  });
  it("puts a missing input ahead of an action the person could take", () => {
    const d = evaluate(req({
      context: {
        requiredAcceptances: [{ policyKey: "k", currentVersion: "1", acceptableVersions: [{ version: "1", contentHash: "h", effectiveFrom: ago(1) }] }],
        acceptances: undefined,
        organizationPolicies: [{ policyRef: "OP-R", version: 1, authority: "company_policy", action: "disposal_ticket.read", effect: "require_review", effectiveFrom: ago(1), effectiveTo: null }],
      },
    }));
    expect(d.decision).toBe("not_evaluated");
  });
});

describe("adapters", () => {
  it("carries authorize()'s answer without its roles", () => {
    expect(permissionFactFrom({ allowed: false, outcome: "denied_scope", effectiveRoles: [], detail: "x" })).toEqual({ allowed: false, outcome: "denied_scope", detail: "x" });
    expect(permissionFactFrom({ allowed: true, outcome: "allowed", effectiveRoles: ["driver"] })).toEqual({ allowed: true, outcome: "allowed" });
  });
  it("takes a blocker's override class from complianceFinding's own classifier", () => {
    const f = overrideFactFromBlocker({ code: "critical_defect", label: "Critical defect", severity: "blocking", subject: "truck", overridable: false }, NOW);
    expect(f).toEqual({ findingCode: "critical_defect", overrideClass: "NEVER_OVERRIDABLE" });
    expect(evaluate(req({ action: "dispatch.override", context: { override: f } })).reasonCode).toBe("MANDATORY_CONTROL_NOT_OVERRIDABLE");
  });
  it("reads the action gateway's stale and compliance blocks as refusals", () => {
    expect(decisionKindFromGateway({ decision: "allow", reasons: [] })).toBe("allow");
    expect(decisionKindFromGateway({ decision: "require_approval", reasons: [], approvalOf: "h" })).toBe("require_review");
    expect(decisionKindFromGateway({ decision: "compliance_block", reasons: [], reasonCodes: [] })).toBe("deny");
    expect(decisionKindFromGateway({ decision: "stale", reasons: [], expectedRevision: 1, actualRevision: 2 })).toBe("deny");
  });
  it("maps onto the inter-engine contract without rounding NOT_EVALUATED up", () => {
    expect(toCapabilityResult("governance", evaluate(req())).status).toBe("PASS");
    expect(toCapabilityResult("governance", evaluate(req({ context: { permission: null } }))).status).toBe("BLOCKED");
    const ne = toCapabilityResult("governance", evaluate(req({ context: { requiredAcceptances: [{ policyKey: "k", currentVersion: "1", acceptableVersions: [] }], acceptances: undefined } })));
    expect(ne).toMatchObject({ status: "NOT_EVALUATED", reason: "no_data_source_loaded" });
    expect(toCapabilityResult("governance", evaluate(req({ context: { compliance: { state: "review", reasonCodes: [] } } }))).status).toBe("REVIEW");
  });
});
