/**
 * G1 — policy conformance: the company's principles, as tests that stay standing.
 *
 * `governance.test.ts` pins what each rule does. This file pins what must stay true whatever the rules
 * become, and it enumerates from the source wherever it can — the authority ladder from
 * `complianceFinding.ts`, every procedure name from the permission maps, every safeguard from
 * `NEVER_AUTONOMOUS` — so a new procedure, a new authority level or a new reason code without a case
 * fails here instead of quietly falling outside the suite (the `degradationSuite` pattern).
 *
 * Invariants:
 *   1. The ladder extends the existing one: every AuthorityClass is present, in its own order.
 *   2. Nothing outside the catalog is ever said: every decision's code is a catalog code, its sentence
 *      is the catalog's sentence, and every literal code in the kernel's source exists.
 *   3. No automated actor signs, attests, approves, verifies or acknowledges — for every procedure.
 *   4. No automated actor performs a NEVER_AUTONOMOUS act.
 *   5. A NEVER_OVERRIDABLE control is refused for every actor, under every organization policy.
 *   6. No cross-tenant answer differs from a missing record's.
 *   7. Missing consent is not consent, and an acceptance cannot be backdated.
 *   8. A lower authority never turns a refusal into permission.
 *   9. Every decision records the rule set it was made under, and that rule set is pinned to its version.
 *  10. The kernel is pure: no database, no network, no clock, no environment.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REASON_CODES, isReasonCode } from "@shared/_core/reasonCodes";
import { NEVER_AUTONOMOUS } from "./_core/actionGateway";
import {
  EXTERNAL_PROCEDURE_PERMISSIONS,
  INTEGRATION_PROCEDURE_PERMISSIONS,
  OPERATIONAL_PROCEDURE_PERMISSIONS,
  RECORDS_PROCEDURE_PERMISSIONS,
  SESSION_PROCEDURE_PERMISSIONS,
} from "./_core/recordsAuthorization";
import { evaluate, ruleSetHash } from "./_core/governance/evaluate";
import { HUMAN_ONLY_WORDS, NOT_HUMAN_ACTS, RULES, RULESET_VERSION, verbWords } from "./_core/governance/rules";
import {
  ORGANIZATION_AUTHORABLE,
  PRECEDENCE,
  type GovernanceActor,
  type GovernanceDecision,
  type GovernanceRequest,
  type OrganizationPolicyRow,
  type PolicyAuthority,
} from "./_core/governance/decision";

const NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 86_400_000;

const base = (over: Partial<Omit<GovernanceRequest, "context">> & { context?: Partial<GovernanceRequest["context"]> } = {}): GovernanceRequest => ({
  actor: { type: "user", userId: 1 },
  organization: { tenantId: "org-a", derivedFrom: "membership" },
  action: "record.read",
  resource: null,
  ...over,
  context: { permission: { allowed: true, outcome: "allowed" }, now: NOW, ...(over.context ?? {}) },
});

const ACTORS: readonly GovernanceActor[] = [
  { type: "user", userId: 1 },
  { type: "external", identityRef: "EXT-1", kind: "customer" },
  { type: "integration", clientRef: "IC-1" },
  { type: "agent", agentKey: "secretary", runRef: "RUN-1", delegatedByUserId: 1 },
  { type: "system", component: "worker" },
];
const AUTOMATED = ACTORS.filter(a => a.type !== "user" && a.type !== "external");

/** An organization row at every authority, saying "allow" — the strongest relaxation anyone could write. */
const allowRowsFor = (action: string): OrganizationPolicyRow[] =>
  PRECEDENCE.map(authority => ({
    policyRef: `OP-${authority}`, version: 1, authority, action, effect: "allow",
    effectiveFrom: new Date(NOW.getTime() - DAY), effectiveTo: null,
  } satisfies OrganizationPolicyRow));

/** Every procedure name the server maps to a permission, from every gate. */
const ALL_PROCEDURES: readonly string[] = Array.from(new Set([
  ...Object.keys(RECORDS_PROCEDURE_PERMISSIONS),
  ...Object.keys(OPERATIONAL_PROCEDURE_PERMISSIONS),
  ...Object.keys(SESSION_PROCEDURE_PERMISSIONS),
  ...Object.keys(EXTERNAL_PROCEDURE_PERMISSIONS),
  ...Object.keys(INTEGRATION_PROCEDURE_PERMISSIONS),
])).sort();

const GOVERNANCE_DIR = "server/_core/governance";
const kernelFiles = readdirSync(GOVERNANCE_DIR).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** The shape every decision must have, whatever it decided. */
function assertWellFormed(d: GovernanceDecision) {
  expect(isReasonCode(d.reasonCode), d.reasonCode).toBe(true);
  expect(d.humanReason).toBe(REASON_CODES[d.reasonCode].humanReason);
  expect(d.remediation).toBe(REASON_CODES[d.reasonCode].remediation);
  expect(d.policyId.length).toBeGreaterThan(0);
  expect(d.policyVersion.length).toBeGreaterThan(0);
  expect(d.ruleId.length).toBeGreaterThan(0);
  expect(PRECEDENCE).toContain(d.authority);
  expect(d.ruleSetHash).toBe(ruleSetHash());
  expect(d.evaluatedAt).toBe(NOW);
  expect(d.decision === "not_evaluated").toBe(d.notEvaluatedReason !== undefined);
  if (d.decision === "require_review") expect(d.review?.queue).toBe("governance_review");
  if (d.decision === "allow") expect(d.trace.every(t => t.outcome === "no_opinion" || t.outcome === "ignored")).toBe(true);
  for (const t of d.trace) if (t.reasonCode) expect(isReasonCode(t.reasonCode), t.reasonCode).toBe(true);
}

describe("1. the ladder extends complianceFinding.AuthorityClass", () => {
  const src = readFileSync("server/_core/complianceFinding.ts", "utf8");
  const union = /export type AuthorityClass =([\s\S]*?);/.exec(src)?.[1] ?? "";
  const classes = Array.from(union.matchAll(/"([a-z_]+)"/g)).map(m => m[1]!);

  it("finds the union it is checking against", () => {
    expect(classes.length).toBeGreaterThanOrEqual(8);
  });
  it("contains every AuthorityClass, in the order complianceFinding gives them", () => {
    for (const c of classes) expect(PRECEDENCE, c).toContain(c);
    const positions = classes.map(c => PRECEDENCE.indexOf(c as PolicyAuthority));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
  it("names each level once", () => {
    expect(new Set(PRECEDENCE).size).toBe(PRECEDENCE.length);
  });
  it("puts LeaseOS's mandatory controls under the law and over every organization's own policy", () => {
    const at = (a: PolicyAuthority) => PRECEDENCE.indexOf(a);
    expect(at("leaseos_mandatory_control")).toBeGreaterThan(at("government_permit_exemption"));
    for (const a of ORGANIZATION_AUTHORABLE) expect(at("leaseos_mandatory_control")).toBeLessThan(at(a));
  });
  it("never lets an organization author at a level above its own policy", () => {
    for (const a of ["statute_regulation", "regulator_order", "government_permit_exemption", "leaseos_mandatory_control", "leaseos_terms", "leaseos_privacy", "client_contract", "carrier_safety_policy"] as const) {
      expect(ORGANIZATION_AUTHORABLE).not.toContain(a);
    }
  });
});

describe("2. nothing outside the catalog is ever said", () => {
  it("every catalog entry has a sentence a person can read", () => {
    for (const [code, e] of Object.entries(REASON_CODES)) {
      expect(e.humanReason.trim().length, code).toBeGreaterThan(5);
      expect(e.humanReason, code).not.toMatch(/^not allowed\.?$/i);
    }
  });
  it("every reason code written in the kernel's source is in the catalog", () => {
    for (const f of kernelFiles) {
      const src = readFileSync(`${GOVERNANCE_DIR}/${f}`, "utf8");
      for (const m of src.matchAll(/reasonCode: "([A-Za-z_]+)"|ReasonCode = "([A-Za-z_]+)"/g)) {
        const code = m[1] ?? m[2]!;
        expect(isReasonCode(code), `${f}: ${code}`).toBe(true);
      }
    }
  });
  it("the permission codes are authorizationDecisions.outcome's own spelling", () => {
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    const enumSrc = /mysqlTable\("authorizationDecisions"[\s\S]*?outcome: mysqlEnum\("outcome", \[([\s\S]*?)\]\)/.exec(schema)?.[1] ?? "";
    const outcomes = Array.from(enumSrc.matchAll(/"([a-z_]+)"/g)).map(m => m[1]!).filter(o => o !== "allowed");
    expect(outcomes.length).toBeGreaterThanOrEqual(4);
    for (const o of outcomes) expect(isReasonCode(o), o).toBe(true);
  });
  it("a matrix of requests produces only well-formed decisions", () => {
    const resources = [
      null,
      { type: "manifest", ref: "M", orgRef: "org-a", lifecycle: "sealed" as const },
      { type: "manifest", ref: "M", orgRef: "org-b" },
      { type: "evidence", ref: "E", orgRef: "org-a", legalHold: true },
      { type: "evidence", ref: "E", orgRef: undefined },
    ];
    const actions = ["record.read", "manifest.update", "evidence.delete", "hos.attestHours", "audit.delete", "Bad Action"];
    const compliance = [null, { state: "pass" as const, reasonCodes: [] }, { state: "review" as const, reasonCodes: [] }, { state: "unknown" as const, reasonCodes: [] }];
    let n = 0;
    for (const actor of ACTORS) for (const resource of resources) for (const action of actions) for (const c of compliance) {
      assertWellFormed(evaluate(base({ actor, resource, action, context: { compliance: c } })));
      n++;
    }
    expect(n).toBe(ACTORS.length * resources.length * actions.length * compliance.length);
  });
});

describe("3. no automated actor signs, for any procedure", () => {
  const matches = (p: string) => verbWords(p).some(w => HUMAN_ONLY_WORDS.includes(w));
  const humanOnly = ALL_PROCEDURES.filter(p => matches(p) && !(p in NOT_HUMAN_ACTS));

  it("every exemption names a real procedure the word list would otherwise catch, with a reason", () => {
    for (const [p, why] of Object.entries(NOT_HUMAN_ACTS)) {
      expect(ALL_PROCEDURES, `${p} is not a procedure any more`).toContain(p);
      expect(matches(p), `${p} no longer matches the word list, so its exemption is dead`).toBe(true);
      expect(why.length, p).toBeGreaterThan(30);
    }
  });
  it("an exempt procedure stays subject to every other rule", () => {
    for (const p of Object.keys(NOT_HUMAN_ACTS)) {
      const d = evaluate(base({ actor: AUTOMATED[0]!, action: p, resource: { type: "evidence", ref: "E", orgRef: "org-b" } }));
      expect(d.reasonCode, p).toBe("TENANT_BOUNDARY");
    }
  });

  it("finds the procedures it protects", () => {
    // If this drops to zero the verb list or the maps changed shape, and the suite would be guarding nothing.
    expect(humanOnly.length).toBeGreaterThan(20);
  });
  it.each(humanOnly)("%s is refused to every automated actor and left to a person", procedure => {
    for (const actor of AUTOMATED) {
      const d = evaluate(base({ actor, action: procedure, context: { organizationPolicies: allowRowsFor(procedure) } }));
      expect(d.decision, `${actor.type}`).toBe("deny");
      expect(d.reasonCode).toBe("AGENT_CANNOT_SIGN");
    }
    expect(evaluate(base({ action: procedure })).decision).toBe("allow");
  });
});

describe("4. no automated actor removes a safeguard", () => {
  it.each([...NEVER_AUTONOMOUS])("%s is refused to every automated actor, whatever the organization allows", capability => {
    for (const actor of AUTOMATED) {
      const d = evaluate(base({ actor, action: capability, context: { organizationPolicies: allowRowsFor(capability) } }));
      expect(d.decision, actor.type).toBe("deny");
      expect(d.reasonCode).toBe("AGENT_NEVER_AUTONOMOUS");
    }
  });
});

describe("5. a NEVER_OVERRIDABLE control is never lifted", () => {
  it("for every actor, under an allow row at every authority", () => {
    for (const actor of ACTORS) {
      const d = evaluate(base({
        actor, action: "dispatch.override",
        context: { override: { findingCode: "oos_order_active", overrideClass: "NEVER_OVERRIDABLE" }, organizationPolicies: allowRowsFor("dispatch.override") },
      }));
      expect(d.decision, actor.type).toBe("deny");
      expect(d.reasonCode).toBe("MANDATORY_CONTROL_NOT_OVERRIDABLE");
    }
  });
  it("and every LeaseOS rule is itself NEVER_OVERRIDABLE", () => {
    for (const r of RULES) expect(r.overrideClass, r.ruleId).toBe("NEVER_OVERRIDABLE");
  });
});

describe("6. another organization's record answers as a missing one", () => {
  it("for every actor and every lifecycle", () => {
    for (const actor of ACTORS) for (const lifecycle of [undefined, "draft", "sealed"] as const) {
      const d = evaluate(base({ actor, action: "record.read", resource: { type: "job", ref: "J-1", orgRef: "org-b", lifecycle } }));
      expect(d.decision).toBe("deny");
      expect(d.humanReason).toBe(REASON_CODES.TENANT_BOUNDARY.humanReason);
    }
  });
  it("and that sentence is the not-found sentence, naming no organization", () => {
    expect(REASON_CODES.TENANT_BOUNDARY.humanReason).toBe("That record was not found.");
    expect(REASON_CODES.TENANT_BOUNDARY.remediation).toBeNull();
  });
});

describe("7. consent", () => {
  const need = [{ policyKey: "leaseos.terms", currentVersion: "1", acceptableVersions: [{ version: "1", contentHash: "h", effectiveFrom: new Date(NOW.getTime() - 10 * DAY) }] }];
  it("missing consent is never consent", () => {
    for (const acceptances of [undefined, []]) {
      expect(evaluate(base({ context: { requiredAcceptances: need, acceptances } })).decision).not.toBe("allow");
    }
  });
  it("an acceptance dated before the version, or after the decision, never counts", () => {
    for (const offset of [-11, +1]) {
      const d = evaluate(base({
        context: { requiredAcceptances: need, acceptances: [{ policyKey: "leaseos.terms", version: "1", contentHashAtAcceptance: "h", state: "accepted", recordedAt: new Date(NOW.getTime() + offset * DAY) }] },
      }));
      expect(d.decision, String(offset)).toBe("require_action");
    }
  });
  it("no organization row can stand in for an acceptance", () => {
    const d = evaluate(base({ action: "record.read", context: { requiredAcceptances: need, acceptances: [], organizationPolicies: allowRowsFor("record.read") } }));
    expect(d.reasonCode).toBe("ACCEPTANCE_REQUIRED");
  });
});

describe("8. a lower authority never turns a refusal into permission", () => {
  const refusals: [string, Partial<GovernanceRequest>][] = [
    ["permission", { context: { permission: { allowed: false, outcome: "denied_permission" }, now: NOW } }],
    ["tenant", { resource: { type: "job", ref: "J", orgRef: "org-b" } }],
    ["issued", { action: "manifest.update", resource: { type: "manifest", ref: "M", orgRef: "org-a", lifecycle: "sealed" } }],
    ["legal hold", { action: "evidence.delete", resource: { type: "evidence", ref: "E", orgRef: "org-a", legalHold: true } }],
    ["compliance unknown", { context: { compliance: { state: "unknown", reasonCodes: [] }, permission: { allowed: true, outcome: "allowed" }, now: NOW } }],
  ];
  it.each(refusals)("%s stays refused under allow rows at every authority", (_, over) => {
    const plain = evaluate(base(over));
    expect(plain.decision).toBe("deny");
    const action = over.action ?? "record.read";
    const relaxed = evaluate(base({ ...over, context: { ...(over.context ?? {}), organizationPolicies: allowRowsFor(action) } }));
    expect(relaxed.decision).toBe("deny");
    expect(relaxed.reasonCode).toBe(plain.reasonCode);
  });
});

describe("9. every decision names the rule set it was made under", () => {
  /**
   * One entry per released rule set. Changing a rule changes the hash: add a new version here and bump
   * RULESET_VERSION, never edit an existing line — a past decision's hash must keep meaning what it meant.
   */
  const PINNED: Record<string, string> = {
    "1.0.0": "85b394a1ecde37ce5b12c69541cead73219a9b7083d8beae3dce7ad8f0efe847",
  };
  it("the current rule set is the pinned one for its version", () => {
    expect(PINNED[RULESET_VERSION], `no pin for ${RULESET_VERSION}`).toBeDefined();
    expect(ruleSetHash()).toBe(PINNED[RULESET_VERSION]);
  });
  it("rule ids are unique", () => {
    expect(new Set(RULES.map(r => r.ruleId)).size).toBe(RULES.length);
  });
});

describe("10. the kernel is pure", () => {
  const FORBIDDEN: [RegExp, string][] = [
    [/from ["'](?:\.\.\/)+db["']/, "the database module"],
    [/\bgetDb\b/, "a database handle"],
    [/from ["']drizzle-orm/, "the query builder"],
    [/from ["']mysql2/, "the driver"],
    [/\bfetch\(/, "the network"],
    [/Date\.now\(\)|new Date\(\)/, "the clock (the request carries now)"],
    [/process\.env/, "the environment"],
    [/Math\.random/, "randomness"],
  ];
  it.each(kernelFiles)("%s reaches for nothing outside the request", f => {
    const src = readFileSync(`${GOVERNANCE_DIR}/${f}`, "utf8");
    for (const [re, what] of FORBIDDEN) expect(re.test(src), `${f} reaches ${what}`).toBe(false);
  });
});
