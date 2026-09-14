/**
 * v22.20 — the boundary the Secretary cannot reason its way past.
 */
import { describe, expect, it } from "vitest";
import {
  approvalCovers, buildRegistry, CapabilityUnknown, decide, detectNoProgress,
  idempotencyKey, isComplete, MAY_INSTRUCT, NEVER_AUTONOMOUS, outranks, shouldRetry,
  type ActionRequest, type CapabilityDefinition, type GatewayContext,
} from "./_core/actionGateway";

const AT = new Date("2026-12-01T09:00:00Z");
const cap = (o: Partial<CapabilityDefinition> = {}): CapabilityDefinition => ({
  key: "billing.prepareInvoice", description: "Draft an invoice", riskLevel: "prepare",
  requiredPermissions: ["invoice.prepare"], requiresOnline: true, idempotent: true, ...o,
});
const registry = buildRegistry([
  cap(),
  cap({ key: "jobs.read", riskLevel: "read", requiredPermissions: ["job.read"] }),
  cap({ key: "messaging.sendReminder", riskLevel: "low_risk_action", requiredPermissions: ["message.send"] }),
  cap({ key: "billing.issueInvoice", riskLevel: "approval_required", requiredPermissions: ["invoice.issue"] }),
  cap({ key: "payroll.adjust", riskLevel: "restricted", requiredPermissions: ["payroll.write"] }),
  cap({ key: "compliance.override", riskLevel: "restricted", requiredPermissions: ["compliance.override"] }),
]);

const request = (o: Partial<ActionRequest> = {}): ActionRequest => ({
  requestId: "REQ-1", runId: "AR-1", capability: "billing.prepareInvoice",
  actor: { type: "agent", id: "AGENT-SECRETARY" }, delegatedByUserId: "USER-203",
  target: { entityType: "invoice", entityId: "INV-1", revision: null },
  payloadHash: "abc123", origin: "authorized_user",
  reasoningSummary: "billing ready", evidenceRefs: ["EV-1"], ...o,
});
const ctx = (o: Partial<GatewayContext> = {}): GatewayContext => ({
  registry, heldPermissions: ["invoice.prepare", "job.read", "message.send", "invoice.issue", "payroll.write", "compliance.override"],
  online: true, compliance: null, actualRevision: null, autoExecute: [], approvalForPayloadHash: null, ...o,
});

describe("external text is content, never a command", () => {
  it("refuses an action originating from a document or a client message", () => {
    for (const origin of ["external_content", "workflow_data"] as const) {
      const d = decide(request({ origin }), ctx());
      expect(d.decision).toBe("deny");
      expect(d.reasons[0]).toContain("not a command");
    }
  });

  it("names who may instruct, and ranks the sources", () => {
    expect([...MAY_INSTRUCT]).toEqual(["system", "leaseos_policy", "company_policy", "authorized_user"]);
    expect(outranks("system", "company_policy")).toBe(true);
    expect(outranks("authorized_user", "external_content")).toBe(true);
    expect(outranks("external_content", "authorized_user")).toBe(false);
  });
});

describe("there is no default-allow path", () => {
  it("refuses a capability nobody registered", () => {
    const d = decide(request({ capability: "database.query" }), ctx());
    expect(d.decision).toBe("deny");
    expect(d.reasons[0]).toContain("not a registered capability");
  });

  it("refuses a second definition of the same key", () => {
    expect(() => buildRegistry([cap(), cap()])).toThrow(CapabilityUnknown);
  });

  it("refuses an agent the acts that remove a safeguard, at any risk level", () => {
    expect([...NEVER_AUTONOMOUS].sort()).toEqual([
      "audit.delete", "compliance.override", "hos.ignoreViolation",
      "inspection.bypassFailure", "maintenance.clearOutOfService", "safety.clearViolation",
    ]);
    const d = decide(request({ capability: "compliance.override" }), ctx());
    expect(d.decision).toBe("deny");
    expect(d.reasons[0]).toContain("cannot itself be automated");
  });

  it("still lets a person do the restricted thing, with approval", () => {
    const d = decide(request({ capability: "compliance.override", actor: { type: "user", id: "USER-1" } }), ctx());
    expect(d.decision).toBe("require_approval");
  });
});

describe("unknown is not permission", () => {
  it("blocks when a compliance engine says blocked, naming its codes", () => {
    const d = decide(request(), ctx({ compliance: { state: "blocked", reasonCodes: ["DAILY_DRIVING_LIMIT"] } }));
    expect(d.decision).toBe("compliance_block");
    if (d.decision !== "compliance_block") return;
    expect(d.reasonCodes).toEqual(["DAILY_DRIVING_LIMIT"]);
  });

  it("blocks when it could not be established at all", () => {
    // The point in the whole system where a model would most want to round up.
    const d = decide(request(), ctx({ compliance: { state: "unknown", reasonCodes: ["NO_VERIFIED_RULE_PROFILE"] } }));
    expect(d.decision).toBe("compliance_block");
    expect(d.reasons[0]).toContain("Unknown is not permission");
  });

  it("does not block on pass or review", () => {
    expect(decide(request(), ctx({ compliance: { state: "pass", reasonCodes: [] } })).decision).toBe("allow");
  });

  it("outranks permissions — a blocked action is not unblocked by holding more", () => {
    const d = decide(request(), ctx({ compliance: { state: "blocked", reasonCodes: ["X"] }, heldPermissions: ["invoice.prepare", "everything"] }));
    expect(d.decision).toBe("compliance_block");
  });
});

describe("risk decides who says yes", () => {
  it("allows a read and a prepare outright", () => {
    expect(decide(request({ capability: "jobs.read" }), ctx()).decision).toBe("allow");
    expect(decide(request(), ctx()).decision).toBe("allow");
  });

  it("asks for approval on a low-risk action until the company allows it unattended", () => {
    expect(decide(request({ capability: "messaging.sendReminder" }), ctx()).decision).toBe("require_approval");
    expect(decide(request({ capability: "messaging.sendReminder" }), ctx({ autoExecute: ["messaging.sendReminder"] })).decision).toBe("allow");
  });

  it("always asks on an approval-required capability", () => {
    const d = decide(request({ capability: "billing.issueInvoice" }), ctx());
    expect(d.decision).toBe("require_approval");
    if (d.decision !== "require_approval") return;
    expect(d.approvalOf).toBe("abc123");
  });

  it("never auto-executes a restricted capability even if policy lists it", () => {
    expect(decide(request({ capability: "payroll.adjust", actor: { type: "user", id: "U" } }), ctx({ autoExecute: ["payroll.adjust"] })).decision)
      .toBe("require_approval");
  });

  it("refuses missing permissions and offline execution", () => {
    expect(decide(request(), ctx({ heldPermissions: [] })).reasons[0]).toContain("Missing invoice.prepare");
    const offline = decide(request(), ctx({ online: false }));
    expect(offline.decision).toBe("deny");
    expect(offline.reasons[0]).toContain("prepared and not performed");
  });
});

describe("approval binds to the payload", () => {
  const approval = { approvalId: "APR-1", capability: "billing.issueInvoice", targetId: "INV-1", payloadHash: "abc123", approvedByUserId: "USER-221", approvedAt: AT };

  it("allows the exact payload that was approved", () => {
    const d = decide(request({ capability: "billing.issueInvoice" }), ctx({ approvalForPayloadHash: "abc123" }));
    expect(d.decision).toBe("allow");
  });

  it("stops covering once the amount changes", () => {
    const changed = request({ capability: "billing.issueInvoice", payloadHash: "different" });
    expect(approvalCovers(approval, changed)).toMatchObject({ covers: false });
    expect(approvalCovers(approval, changed).reason).toContain("What was approved is not what is being asked");
    // And the gateway agrees.
    const d = decide(changed, ctx({ approvalForPayloadHash: "abc123" }));
    expect(d.decision).toBe("require_approval");
    expect(d.reasons[0]).toContain("different payload");
  });

  it("does not cover a different capability or a different record", () => {
    expect(approvalCovers(approval, request({ capability: "payroll.adjust", payloadHash: "abc123" })).covers).toBe(false);
    expect(approvalCovers(approval, request({ target: { entityType: "invoice", entityId: "INV-2", revision: null } })).covers).toBe(false);
  });
});

describe("a human edit is not overwritten by an older plan", () => {
  it("reports stale with both revisions rather than proceeding", () => {
    const d = decide(request({ target: { entityType: "job", entityId: "JOB-55", revision: 918 } }), ctx({ actualRevision: 919 }));
    expect(d.decision).toBe("stale");
    if (d.decision !== "stale") return;
    expect(d).toMatchObject({ expectedRevision: 918, actualRevision: 919 });
    expect(d.reasons[0]).toContain("not overwritten by an older agent plan");
  });

  it("proceeds when the revision still matches", () => {
    expect(decide(request({ target: { entityType: "job", entityId: "JOB-55", revision: 919 } }), ctx({ actualRevision: 919 })).decision).toBe("allow");
  });
});

describe("requested is not completed", () => {
  it("counts a step done only once the result was verified", () => {
    expect(isComplete("executed")).toBe(false);
    expect(isComplete("verified")).toBe(true);
  });

  it("retries what may not have arrived and not what will answer the same", () => {
    expect(shouldRetry("temporary_network").retry).toBe(true);
    expect(shouldRetry("external_unavailable").retry).toBe(true);
    for (const kind of ["validation", "permission_denied", "compliance_block", "unknown"] as const) {
      expect(shouldRetry(kind).retry).toBe(false);
    }
    expect(shouldRetry("conflict").reason).toContain("rather than resolving it silently");
    expect(shouldRetry("stale_data").reason).toContain("re-evaluate");
  });

  it("derives an idempotency key so two retries cannot differ", () => {
    expect(idempotencyKey(request())).toBe("AR-1:REQ-1:billing.prepareInvoice:INV-1");
    expect(idempotencyKey(request())).toBe(idempotencyKey(request()));
  });
});

describe("no progress is a stop", () => {
  const step = (n: number) => ({ capability: "documents.find", targetId: "DT-8821", inputHash: "i", outputHash: `o${n}` });

  it("stops after the same thing produces the same nothing three times", () => {
    const same = { capability: "documents.find", targetId: "DT-8821", inputHash: "i", outputHash: "missing" };
    const r = detectNoProgress([same, same, same]);
    expect(r).toMatchObject({ stalled: true, capability: "documents.find", count: 3 });
  });

  it("does not stop while the answer keeps changing", () => {
    expect(detectNoProgress([step(1), step(2), step(3)]).stalled).toBe(false);
  });

  it("does not stop on an empty or short run", () => {
    expect(detectNoProgress([]).stalled).toBe(false);
  });
});

describe("a capability cannot require a permission that does not exist", () => {
  /**
   * The registry first shipped asking for `invoice.prepare` and
   * `invoice.issue`, neither of which is a permission in this system. Those
   * capabilities were therefore un-grantable to anybody — worse than absent,
   * because they looked configured and failed as though the caller lacked
   * authority.
   */
  it("declares only permissions the authorization model actually defines", async () => {
    const { AGENT_CAPABILITIES } = await import("./agentRouter");
    const { permissionsFor } = await import("./_core/recordsAuthorization");
    const everyPermission = new Set<string>();
    for (const role of ["driver", "mechanic", "dispatcher", "office", "safety", "shop_lead", "management"] as const) {
      for (const p of permissionsFor([role]) as string[]) everyPermission.add(p);
    }
    const invented = AGENT_CAPABILITIES
      .flatMap(c => c.requiredPermissions.map(p => `${c.key} needs ${p}`))
      .filter(x => !everyPermission.has(x.split(" needs ")[1]));
    expect(invented).toEqual([]);
  });
});
