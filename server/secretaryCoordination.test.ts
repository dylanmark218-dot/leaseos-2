/**
 * v22.20 — the Secretary proposes, and the floor it cannot be configured under.
 */
import { describe, expect, it } from "vitest";
import {
  accept, briefing, NEVER_AUTOMATIC, PolicyExceedsFloor, propose, validatePolicy,
  WrongAuthority, floorDisagreements, PROPOSAL_RISK, RISKS_REQUIRING_A_PERSON,
  type AutomationPolicy, type Observation, type ProposalAction,
} from "./_core/secretaryCoordination";

const AT = new Date("2026-10-20T05:30:00Z");
const src = (t: string, r: string) => ({ sourceType: t, sourceRef: r, generatedBy: "engine" });
const policy = (automatic: AutomationPolicy["automatic"] = ["send_reminder"]): AutomationPolicy => ({ policyRef: "POL-AUTO-1", automatic });
const obs = (finding: string, urgency: Observation["urgency"] = "routine", ref = "X-1"): Observation =>
  ({ finding, urgency, source: src("engine", ref) });

const make = (action: Parameters<typeof propose>[0]["action"], p = policy()) =>
  propose({ proposalRef: `P-${action}`, action, title: `do ${action}`, targetRef: "J-8274", rationale: [obs("because")], policy: p });

describe("the floor is not configurable", () => {
  it("names the actions that always need a person", () => {
    expect([...NEVER_AUTOMATIC].sort()).toEqual([
      "approve_leave", "assign_person", "change_payroll", "resolve_compliance", "schedule_payment",
    ]);
  });

  it("rejects a policy that tries to automate one, rather than quietly trimming it", () => {
    // Silently narrowing would leave an administrator believing they configured
    // something they had not.
    expect(() => validatePolicy(policy(["send_reminder", "assign_person"]))).toThrow(PolicyExceedsFloor);
    expect(() => validatePolicy(policy(["schedule_payment"]))).toThrow(/may narrow what is automatic and never widen it/);
  });

  it("accepts a policy that only narrows", () => {
    expect(() => validatePolicy(policy([]))).not.toThrow();
    expect(() => validatePolicy(policy(["send_reminder", "draft_message"]))).not.toThrow();
  });
});

describe("authority comes from the action, not from confidence", () => {
  it("routes each action to the authority that must decide it", () => {
    expect(make("assign_person").requiresAuthority).toBe("dispatch");
    expect(make("approve_leave").requiresAuthority).toBe("supervisor");
    expect(make("schedule_payment").requiresAuthority).toBe("finance");
    expect(make("change_payroll").requiresAuthority).toBe("payroll");
    expect(make("resolve_compliance").requiresAuthority).toBe("safety");
  });

  it("never marks a floor action automatic, even when the policy is permissive elsewhere", () => {
    const permissive = policy(["send_reminder", "draft_message", "create_review_task"]);
    for (const action of NEVER_AUTOMATIC) {
      expect(make(action, permissive).automatic).toBe(false);
    }
  });

  it("automates a reminder only where the policy actually says so", () => {
    expect(make("send_reminder", policy(["send_reminder"])).automatic).toBe(true);
    expect(make("send_reminder", policy([])).automatic).toBe(false);
    expect(make("draft_message", policy(["send_reminder"])).automatic).toBe(false);
  });

  it("says plainly that an automatic proposal decides nothing", () => {
    expect(make("send_reminder").note).toContain("It sends or drafts; it decides nothing");
  });

  it("produces a proposal that has not been performed, structurally", () => {
    expect(make("assign_person").performed).toBe(false);
  });

  it("carries the observations behind it, each with its source", () => {
    const p = make("assign_person");
    expect(p.rationale[0].source).toMatchObject({ sourceType: "engine", sourceRef: "X-1" });
  });
});

describe("the briefing states what the engines found", () => {
  const observations = [
    obs("Two field tickets unsigned and payroll closes at noon", "urgent", "PAY-1"),
    obs("AR-421 is 12 days overdue", "soon", "AR-421"),
    obs("Crew B has 9 people scheduled", "routine", "CREW-B"),
  ];

  it("orders by the urgency the engine reported, not by its own judgement", () => {
    const b = briefing({ at: AT, observations, proposals: [] });
    expect(b.observations.map(o => o.urgency)).toEqual(["urgent", "soon", "routine"]);
  });

  it("attributes every line to the record it came from", () => {
    const b = briefing({ at: AT, observations, proposals: [] });
    expect(b.lines[0]).toContain("[engine:PAY-1]");
    expect(b.lines.every(l => l === "" || l.includes("[") || l.includes("need a decision") || l.startsWith("  "))).toBe(true);
  });

  it("separates what will happen anyway from what needs somebody", () => {
    const b = briefing({
      at: AT, observations,
      proposals: [make("send_reminder"), make("assign_person"), make("schedule_payment")],
    });
    expect(b.automatic).toHaveLength(1);
    expect(b.awaitingDecision).toHaveLength(2);
    expect(b.lines.join("\n")).toContain("2 suggestion(s) need a decision:");
    expect(b.lines.join("\n")).toContain("do assign_person — dispatch");
  });

  it("says nothing about decisions when none are needed", () => {
    const b = briefing({ at: AT, observations: [], proposals: [make("send_reminder")] });
    expect(b.lines.join("\n")).not.toContain("need a decision");
  });
});

describe("accepting is not performing", () => {
  it("records an acceptance from somebody holding the right authority", () => {
    const r = accept({ proposal: make("assign_person"), byUserId: 7, heldAuthorities: ["dispatch"] });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    expect(r.authority).toBe("dispatch");
    expect(r.note).toContain("accepting a suggestion is not performing it");
  });

  it("refuses somebody without it, naming what they hold", () => {
    expect(() => accept({ proposal: make("schedule_payment"), byUserId: 7, heldAuthorities: ["dispatch"] }))
      .toThrow(WrongAuthority);
    expect(() => accept({ proposal: make("schedule_payment"), byUserId: 7, heldAuthorities: [] }))
      .toThrow(/holds no relevant authority/);
  });

  it("has nothing to accept on a proposal that runs on its own", () => {
    const r = accept({ proposal: make("send_reminder"), byUserId: 7, heldAuthorities: ["dispatch"] });
    expect(r.accepted).toBe(false);
    if (r.accepted) return;
    expect(r.reason).toContain("nothing to accept");
  });
});

describe("the briefing layer and the gateway cannot drift apart", () => {
  /**
   * Two independently maintained lists of "never automatic" is the shape that
   * produced two receipt vocabularies: each correct alone, silently diverging,
   * until one lets through what the other forbids.
   */
  it("maps every proposal action to a risk, with none left undeclared", () => {
    const actions: ProposalAction[] = [
      "send_reminder", "draft_message", "create_review_task", "assign_person",
      "approve_leave", "schedule_payment", "change_payroll", "resolve_compliance",
    ];
    for (const a of actions) expect(PROPOSAL_RISK[a]).toBeTruthy();
    expect(Object.keys(PROPOSAL_RISK).sort()).toEqual([...actions].sort());
  });

  it("agrees today, and says exactly where if it ever stops", () => {
    expect(floorDisagreements()).toEqual([]);
  });

  it("puts every never-automatic action at a risk the gateway will not run unattended", () => {
    for (const a of NEVER_AUTOMATIC) {
      expect(RISKS_REQUIRING_A_PERSON).toContain(PROPOSAL_RISK[a]);
    }
  });

  it("catches a floor weakened on one side only", () => {
    // Simulating the drift: if approve_leave were reclassified as a prepare,
    // the briefing would still refuse it while the gateway ran it.
    const drifted = { ...PROPOSAL_RISK, approve_leave: "prepare" as const };
    const broken = NEVER_AUTOMATIC.filter(a => !RISKS_REQUIRING_A_PERSON.includes(drifted[a]));
    expect(broken).toEqual(["approve_leave"]);
  });

  it("keeps the two layers distinct rather than merging them", () => {
    // A proposal is a suggestion in a briefing; a gateway request is an attempt
    // to change something. Collapsing them would remove the step where a person
    // sees the suggestion before anything is attempted.
    expect(PROPOSAL_RISK.draft_message).toBe("prepare");
    expect(RISKS_REQUIRING_A_PERSON).not.toContain("prepare");
  });
});
