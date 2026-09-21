/**
 * v22.20 (0100) — the agent asks, LeaseOS decides, and the refusals are rows.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("approving an agent action is sensitive", () => {
  it("fails closed on approval, not on asking it to work", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("agent.approve");
    expect(SENSITIVE_PERMISSIONS).not.toContain("agent.use");
    expect(SENSITIVE_PERMISSIONS).not.toContain("agent.read");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 25_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

const target = { entityType: "invoice", entityId: "INV-1", revision: null };
const act = (runRef: string, o: Record<string, unknown> = {}) => ({
  runRef, capability: "billing.prepareInvoice", target, payloadHash: "hash-a",
  origin: "authorized_user" as const, ...o,
});

d("a run outlives the conversation", () => {
  it("stores the goal and the plan", async () => {
    const office = await withRole("office");
    const r = await caller(office).agent.start({
      goal: "Prepare Job J-48292 for invoicing",
      plan: [{ capability: "jobs.read" }, { capability: "billing.prepareInvoice" }],
    });
    const got = await caller(office).agent.get({ runRef: r.runRef });
    expect(got.goal).toBe("Prepare Job J-48292 for invoicing");
    expect(got.status).toBe("ready");
    expect(got.steps.map(s => s.capability)).toEqual(["jobs.read", "billing.prepareInvoice"]);
  });

  it("refuses a plan naming a capability that does not exist", async () => {
    const office = await withRole("office");
    await expect(caller(office).agent.start({ goal: "do things", plan: [{ capability: "database.query" }] }))
      .rejects.toThrow(/cannot name a capability that does not exist/);
  });

  it("parks on an event and says nothing polls", async () => {
    const office = await withRole("office");
    const r = await caller(office).agent.start({ goal: "await disposal", plan: [{ capability: "jobs.read" }] });
    await caller(office).agent.requestAction(act(r.runRef, { capability: "jobs.read", target: { entityType: "job", entityId: "1", revision: null } }));
    const parked = await caller(office).agent.awaitEvent({ runRef: r.runRef, event: "disposalTicket.verified", filter: { jobId: "J-48292" } });
    expect(parked.note).toContain("Nothing polls");
    expect((await caller(office).agent.get({ runRef: r.runRef })).awaitingEvent).toBe("disposalTicket.verified");
  });

  it("refuses a transition the state machine does not allow", async () => {
    const office = await withRole("office");
    const r = await caller(office).agent.start({ goal: "no plan" });   // status: created
    await expect(caller(office).agent.awaitEvent({ runRef: r.runRef, event: "x" }))
      .rejects.toThrow(/cannot go from created to waiting_for_event/);
  });
});

d("every decision is a row, including the refusals", () => {
  async function run() {
    const office = await withRole("office");
    const r = await caller(office).agent.start({ goal: "billing", plan: [{ capability: "billing.prepareInvoice" }] });
    return { office, runRef: r.runRef };
  }

  it("allows a prepare and records it", async () => {
    const { office, runRef } = await run();
    const a = await caller(office).agent.requestAction(act(runRef));
    expect(a.decision).toBe("allow");
    const got = await caller(office).agent.get({ runRef });
    expect(got.actions[0]).toMatchObject({ decision: "allow", capability: "billing.prepareInvoice" });
    expect(got.note).toContain("a refusal is something that happened");
  });

  it("records a refusal with its reason rather than staying silent", async () => {
    const { office, runRef } = await run();
    // Driven by a capability an agent may never perform, since origin can no
    // longer be supplied to force a refusal.
    await caller(office).agent.requestAction(act(runRef, { capability: "compliance.override" }));
    const got = await caller(office).agent.get({ runRef });
    expect(got.actions[0].decision).toBe("deny");
    expect(got.actions[0].reasons[0]).toContain("cannot itself be automated");
    expect(got.status).toBe("blocked");
    expect(got.blockedReason).toContain("cannot itself be automated");
  });

  it.skip("blocks on a compliance unknown and names the codes — not reachable from the API since the facts became server-owned", () => {
    // This drove the gateway by supplying compliance / actualRevision /
    // payloadHash from the request. Those are server-owned now, and the server
    // supplies none of them yet because no deterministic engine is called from
    // this path. The behaviour itself is covered in actionGateway.test.ts.
    //
    // Un-skip when the router calls a real compliance engine and reads the
    // target's current revision — that is the remaining half of this contract.
  });

  it.skip("reports stale rather than overwriting a human edit — not reachable from the API since the facts became server-owned", () => {
    // This drove the gateway by supplying compliance / actualRevision /
    // payloadHash from the request. Those are server-owned now, and the server
    // supplies none of them yet because no deterministic engine is called from
    // this path. The behaviour itself is covered in actionGateway.test.ts.
    //
    // Un-skip when the router calls a real compliance engine and reads the
    // target's current revision — that is the remaining half of this contract.
  });

  it("keeps both identities: the agent acted, the person asked", async () => {
    const { office, runRef } = await run();
    await caller(office).agent.requestAction(act(runRef));
    const got = await caller(office).agent.get({ runRef });
    expect(got.actions[0].actorType).toBe("agent");
    expect(got.actions[0].actorId).toContain("AGENT-");
    expect(got.actions[0].delegatedByUserId).toBe(office);
  });

  it("returns the original answer to a repeated request rather than deciding twice", async () => {
    const { office, runRef } = await run();
    const first = await caller(office).agent.requestAction(act(runRef, { requestId: "REQ-FIXED" }));
    const again = await caller(office).agent.requestAction(act(runRef, { requestId: "REQ-FIXED" }));
    expect(again.replayed).toBe(true);
    expect(again.actionRef).toBe(first.actionRef);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM agentActions WHERE runRef = ?", [runRef]);
    expect(Number(rows[0].n)).toBe(1);
  });
});

d("approval binds to the payload", () => {
  async function needsApproval() {
    const office = await withRole("office");
    const manager = await withRole("management");
    const r = await caller(office).agent.start({ goal: "issue", plan: [{ capability: "billing.issueInvoice" }] });
    const a = await caller(office).agent.requestAction(act(r.runRef, { capability: "billing.issueInvoice" }));
    return { office, manager, runRef: r.runRef, approvalRef: a.approvalRef!, decision: a.decision };
  }

  it("asks for a person and parks the run", async () => {
    const n = await needsApproval();
    expect(n.decision).toBe("require_approval");
    expect(n.approvalRef).toBeTruthy();
    expect((await caller(n.office).agent.get({ runRef: n.runRef })).status).toBe("waiting_for_approval");
  });

  it.skip("allows the same payload once approved, and not a changed one — not reachable from the API since the facts became server-owned", () => {
    // This drove the gateway by supplying compliance / actualRevision /
    // payloadHash from the request. Those are server-owned now, and the server
    // supplies none of them yet because no deterministic engine is called from
    // this path. The behaviour itself is covered in actionGateway.test.ts.
    //
    // Un-skip when the router calls a real compliance engine and reads the
    // target's current revision — that is the remaining half of this contract.
  });

  it("will not decide the same approval twice", async () => {
    const n = await needsApproval();
    await caller(n.manager).agent.decideApproval({ approvalRef: n.approvalRef, decision: "rejected" });
    await expect(caller(n.manager).agent.decideApproval({ approvalRef: n.approvalRef, decision: "approved" }))
      .rejects.toThrow(/already rejected/);
  });

  it("refuses an agent the acts that remove a safeguard", async () => {
    const office = await withRole("office");
    const r = await caller(office).agent.start({ goal: "override", plan: [{ capability: "compliance.override" }] });
    const a = await caller(office).agent.requestAction(act(r.runRef, { capability: "compliance.override" }));
    expect(a.decision).toBe("deny");
    expect(a.reasons[0]).toContain("cannot itself be automated");
  });

  it("does not reach another organization's run", async () => {
    const office = await withRole("office");
    const r = await caller(office).agent.start({ goal: "mine" });
    await pool.execute("UPDATE agentRuns SET tenantId = 'ORG-ELSEWHERE' WHERE runRef = ?", [r.runRef]);
    await expect(caller(office).agent.get({ runRef: r.runRef })).rejects.toThrow(/No such run/);
  });
});
