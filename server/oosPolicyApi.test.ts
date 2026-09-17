/**
 * v22.20 — the release policy API, and the two refusals that make it worth having.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("approving a release policy is sensitive", () => {
  it("fails closed — it decides who may lift a government prohibition", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("oos.policy.approve");
    expect(SENSITIVE_PERMISSIONS).not.toContain("oos.policy.manage");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 8_200_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const ROLES = { repair_verification: ["mechanic"], reinspection: ["safety"], inspector_release: ["safety"], document_confirmation: ["office"], waiting_period_complete: ["safety"], other: ["management"] };

d("separate proposer and approver, finally enforced", () => {
  // No tenantId: the caller cannot choose one, which is the point of 1A.
  const base = (over: Record<string, unknown> = {}) => ({
    label: "release policy", allowedFindingRoles: ROLES,
    effectiveFrom: new Date("2026-01-01"), ...over,
  });

  it("decides nothing until approved, and the proposer may not approve their own", async () => {
    const proposer = await withRole("management");
    const approver = await withRole("management");
    const p = await caller(proposer).comms.oosPolicyPropose(base());
    expect(p.note).toContain("no out-of-service order can be released under it");

    await expect(caller(proposer).comms.oosPolicyApprove({ policyRef: p.policyRef, decision: "approve" }))
      .rejects.toThrow(/second person/i);

    const ok = await caller(approver).comms.oosPolicyApprove({ policyRef: p.policyRef, decision: "approve" });
    expect(ok.status).toBe("approved");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, proposedByUserId, approvedByUserId FROM oosReleasePolicies WHERE policyRef = ?", [p.policyRef]);
    expect(rows[0]).toMatchObject({ status: "approved", proposedByUserId: proposer, approvedByUserId: approver });
  });

  it("refuses to manufacture the ambiguity the release selector would then refuse", async () => {
    const proposer = await withRole("management");
    const approver = await withRole("management");
    // A branch of its own: company scope is now a single shared slot per tenant,
    // which is what single-tenant actually means.
    const scopeRef = `B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const at_branch = (over: Record<string, unknown> = {}) => base({ scopeType: "branch", scopeRef, ...over });
    const first = await caller(proposer).comms.oosPolicyPropose(at_branch());
    await caller(approver).comms.oosPolicyApprove({ policyRef: first.policyRef, decision: "approve" });

    // A second company policy for the same tenant, overlapping, superseding nothing.
    const second = await caller(proposer).comms.oosPolicyPropose(at_branch({ label: "another one" }));
    await expect(caller(approver).comms.oosPolicyApprove({ policyRef: second.policyRef, decision: "approve" }))
      .rejects.toThrow(/blocked as ambiguous/i);

    // Naming the predecessor is the way through, and it supersedes rather than overwrites.
    const third = await caller(proposer).comms.oosPolicyPropose(at_branch({ label: "the successor", supersedesPolicyRef: first.policyRef }));
    const done = await caller(approver).comms.oosPolicyApprove({ policyRef: third.policyRef, decision: "approve" });
    expect(done.superseded).toBe(first.policyRef);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM oosReleasePolicies WHERE policyRef = ?", [first.policyRef]);
    expect(rows[0].status).toBe("superseded");
  });

  it("lets two different branches each hold their own approved policy", async () => {
    const proposer = await withRole("management");
    const approver = await withRole("management");
    const a = `B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const b = `B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const pa = await caller(proposer).comms.oosPolicyPropose(base({ scopeType: "branch", scopeRef: a }));
    await caller(approver).comms.oosPolicyApprove({ policyRef: pa.policyRef, decision: "approve" });
    const pb = await caller(proposer).comms.oosPolicyPropose(base({ scopeType: "branch", scopeRef: b }));
    await expect(caller(approver).comms.oosPolicyApprove({ policyRef: pb.policyRef, decision: "approve" })).resolves.toMatchObject({ status: "approved" });
  });

  it("refuses a scoped policy that names no scope, and a window that ends before it begins", async () => {
    const proposer = await withRole("management");
    await expect(caller(proposer).comms.oosPolicyPropose(base({ scopeType: "branch" }))).rejects.toThrow(/names the branch it applies to/i);
    await expect(caller(proposer).comms.oosPolicyPropose(base({ effectiveTo: new Date("2025-01-01") }))).rejects.toThrow(/ends before it begins/i);
  });

  it("records a rejection without applying it, and will not reconsider", async () => {
    const proposer = await withRole("management");
    const approver = await withRole("management");
    const p = await caller(proposer).comms.oosPolicyPropose(base());
    const r = await caller(approver).comms.oosPolicyApprove({ policyRef: p.policyRef, decision: "reject", decisionNote: "too permissive for our operation" });
    expect(r.status).toBe("rejected");
    await expect(caller(approver).comms.oosPolicyApprove({ policyRef: p.policyRef, decision: "approve" })).rejects.toThrow(/is rejected/i);
  });

  it("is refused to a dispatcher, who may read policy and not decide it", async () => {
    const dispatcher = await withRole("dispatcher");
    await expect(caller(dispatcher).comms.oosPolicyPropose(base())).rejects.toThrow();
  });
});

d("1A — the caller cannot choose the organization", () => {
  it("rejects a tenantId in the request rather than honouring it", async () => {
    const manager = await withRole("management");
    // The schema has no tenantId. A caller that sends one is refused by
    // validation rather than quietly writing policy into another company.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (caller(manager).comms.oosPolicyPropose as any)({ label: "x", tenantId: "SOME-OTHER-COMPANY", allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") }),
    ).rejects.toThrow();
  });

  it("writes the server's own tenant, whatever the caller believes", async () => {
    const proposer = await withRole("management");
    const p = await caller(proposer).comms.oosPolicyPropose({ label: "server tenant", allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT tenantId FROM oosReleasePolicies WHERE policyRef = ?", [p.policyRef]);
    expect(rows[0].tenantId).toBe("default");
  });

  it("refuses a branch policy for a branch the caller holds no grant in", async () => {
    const id = seq++;
    await grantUserRole({ userId: id, role: "management", scopeType: "branch", scopeRef: "B-MINE", grantedByUserId: 1, grantedAt: new Date() });
    await expect(caller(id).comms.oosPolicyPropose({ label: "theirs", scopeType: "branch", scopeRef: "B-THEIRS", allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") }))
      .rejects.toThrow();   // refused — the role layer confines branch grants before the scope check is even reached
    // A branch-confined caller is refused at the role layer for policy writes at
    // all, which is stricter than mayScopePolicyTo alone would be. Recorded as
    // the actual behaviour rather than the behaviour I expected.
    await expect(caller(id).comms.oosPolicyPropose({ label: "mine", scopeType: "branch", scopeRef: "B-MINE", allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") }))
      .rejects.toThrow();
  });

  it("refuses a company-wide policy from a branch-confined caller", async () => {
    const id = seq++;
    await grantUserRole({ userId: id, role: "management", scopeType: "branch", scopeRef: "B-ONLY", grantedByUserId: 1, grantedAt: new Date() });
    await expect(caller(id).comms.oosPolicyPropose({ label: "company", allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") }))
      .rejects.toThrow();
  });
});

d("1B — two approvers cannot both approve into one scope", () => {
  it("lets exactly one win and leaves the database with one approved policy", async () => {
    const proposer = await withRole("management");
    const a1 = await withRole("management");
    const a2 = await withRole("management");
    const scopeRef = `B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const p1 = await caller(proposer).comms.oosPolicyPropose({ label: "one", scopeType: "branch", scopeRef, allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") });
    const p2 = await caller(proposer).comms.oosPolicyPropose({ label: "two", scopeType: "branch", scopeRef, allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") });

    const results = await Promise.allSettled([
      caller(a1).comms.oosPolicyApprove({ policyRef: p1.policyRef, decision: "approve" }),
      caller(a2).comms.oosPolicyApprove({ policyRef: p2.policyRef, decision: "approve" }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    // Regression (2026-09-17): the named lock used to be released inside the transaction,
    // before the commit, so the loser could read a snapshot without the winner's approval
    // and approve too. Several more concurrent pairs into fresh scopes widen the window a
    // regression would have to survive.
    for (let round = 0; round < 3; round++) {
      const ref = `B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const q1 = await caller(proposer).comms.oosPolicyPropose({ label: "r1", scopeType: "branch", scopeRef: ref, allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") });
      const q2 = await caller(proposer).comms.oosPolicyPropose({ label: "r2", scopeType: "branch", scopeRef: ref, allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") });
      const r = await Promise.allSettled([
        caller(a1).comms.oosPolicyApprove({ policyRef: q1.policyRef, decision: "approve" }),
        caller(a2).comms.oosPolicyApprove({ policyRef: q2.policyRef, decision: "approve" }),
      ]);
      expect(r.filter(x => x.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      const [n] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM oosReleasePolicies WHERE status='approved' AND scopeType='branch' AND scopeRef=?", [ref]);
      expect(Number(n[0].n)).toBe(1);
    }

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM oosReleasePolicies WHERE status='approved' AND scopeType='branch' AND scopeRef=?", [scopeRef]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("refuses a supersession that crosses scope", async () => {
    const proposer = await withRole("management");
    const approver = await withRole("management");
    // Two distinct branches, so neither collides with the shared company slot.
    const a = `B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const b = `B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const company = await caller(proposer).comms.oosPolicyPropose({ label: "branch a", scopeType: "branch", scopeRef: a, allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01") });
    await caller(approver).comms.oosPolicyApprove({ policyRef: company.policyRef, decision: "approve" });
    const branch = await caller(proposer).comms.oosPolicyPropose({ label: "branch b", scopeType: "branch", scopeRef: b, allowedFindingRoles: ROLES, effectiveFrom: new Date("2026-01-01"), supersedesPolicyRef: company.policyRef });
    await expect(caller(approver).comms.oosPolicyApprove({ policyRef: branch.policyRef, decision: "approve" }))
      .rejects.toThrow(/same scope/i);
  });
});
