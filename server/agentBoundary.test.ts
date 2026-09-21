/**
 * v22.20 — what the caller may assert about itself, which is very little.
 *
 * Two fields decided security questions and were supplied by the request:
 * `actorType`, which the never-autonomous check turns on, and `origin`, which
 * is the top of the instruction-authority ladder. Both are now derived or
 * capped. These are the regressions.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

describe("the request cannot claim what the server must decide", () => {
  const router = readFileSync("server/agentRouter.ts", "utf8");

  it("takes no actorType from the caller", () => {
    // The gateway refuses the never-autonomous capabilities to agents. If the
    // caller picks the actor type, that refusal is opt-out.
    expect(router).not.toMatch(/actorType:\s*z\./);
    expect(router).toContain('actor: { type: "agent"');
  });

  it("takes no origin from the caller at all", () => {
    const input = router.slice(router.indexOf("requestAction:"), router.indexOf(".mutation", router.indexOf("requestAction:")));
    // Capping the claim at authorized_user was not enough: company_policy
    // outranks it on the instruction ladder, so accepting it was a laundering
    // step waiting for future logic to honour the ranking.
    expect(input).not.toMatch(/origin:\s*z\./);
    expect(router).toContain('const origin = "authorized_user" as const');
  });

  it("takes no compliance verdict and no current revision from the caller", () => {
    const input = router.slice(router.indexOf("requestAction:"), router.indexOf(".mutation", router.indexOf("requestAction:")));
    // The gateway treats a compliance verdict as authoritative, so a caller
    // supplying one is a caller deciding compliance.
    expect(input).not.toMatch(/compliance:\s*z\./);
    // Only the server can say which revision is current; the stale check exists
    // to catch an edit the caller has not seen.
    expect(input).not.toMatch(/actualRevision:\s*z\./);
    expect(router).toContain("const compliance = null");
  });

  it("hashes the payload itself rather than trusting a hash of it", () => {
    const input = router.slice(router.indexOf("requestAction:"), router.indexOf(".mutation", router.indexOf("requestAction:")));
    expect(input).not.toMatch(/payloadHash:\s*z\./);
    expect(input).toContain("payload: z.record");
    // Otherwise approval proves the presented string matched, not that the
    // thing approved is the thing done.
    expect(router).toContain("const payloadHash = canonicalHash(input.payload)");
  });

  it("hashes two orderings of the same payload identically", async () => {
    const { createHash } = await import("crypto");
    const canon = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(canon)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map(k => [k, canon((v as Record<string, unknown>)[k])]))
          : v;
    const h = (v: unknown) => createHash("sha256").update(JSON.stringify(canon(v))).digest("hex");
    // A re-send that serialised its keys differently must still match its approval.
    expect(h({ a: 1, b: { c: 2, d: 3 } })).toBe(h({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("keeps both identities on the action", () => {
    expect(router).toContain("delegatedByUserId: String(ctx.user.id)");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 22_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

const target = { entityType: "invoice", entityId: "INV-1", revision: null };

d("an agent cannot buy its way past the safeguards", () => {
  async function run(user: number) {
    return (await caller(user).agent.start({ agentKey: "secretary", goal: "close the month" })).runRef;
  }

  it("refuses a never-autonomous capability, with no way to claim otherwise", async () => {
    const manager = await withRole("management");
    const runRef = await run(manager);
    const r = await caller(manager).agent.requestAction({
      runRef, capability: "compliance.override", target, payload: { invoice: "INV-1" },
    });
    expect(r.decision).toBe("deny");
    expect(r.reasons.join(" ")).toContain("cannot itself be automated");
  });

  it("records the refusal, because a log of successes cannot say why not", async () => {
    const manager = await withRole("management");
    const runRef = await run(manager);
    await caller(manager).agent.requestAction({ runRef, capability: "audit.delete", target, payload: { x: 1 } });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT decision, actorType, delegatedByUserId FROM agentActions WHERE runRef = ? AND capability = 'audit.delete'", [runRef]);
    expect(rows[0].decision).toBe("deny");
    expect(rows[0].actorType).toBe("agent");
    expect(Number(rows[0].delegatedByUserId)).toBe(manager);
  });

  it("cannot be told the request came from anywhere but an authorized user", async () => {
    const manager = await withRole("management");
    const runRef = await run(manager);
    // Sending an origin is now simply ignored — the field does not exist.
    const r = await caller(manager).agent.requestAction({
      runRef, capability: "jobs.read", target, payload: { note: "x" },
      // Two-step cast on purpose: the whole test is sending a field the input type forbids, so
      // there is no honest single-step conversion to write here.
      ...({ origin: "external_content" } as unknown as Record<string, never>),
    });
    expect(r.decision).toBe("allow");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT origin FROM agentActions WHERE runRef = ? AND capability = 'jobs.read'", [runRef]);
    expect(rows[0].origin).toBe("authorized_user");
  });

  it("does not do the same thing twice when a request is retried", async () => {
    const manager = await withRole("management");
    const runRef = await run(manager);
    const args = { runRef, capability: "jobs.read", target, payload: { x: 1 }, requestId: "REQ-FIXED" };
    const first = await caller(manager).agent.requestAction(args);
    const second = await caller(manager).agent.requestAction(args);
    expect(second.decision).toBe(first.decision);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM agentActions WHERE runRef = ? AND capability = 'jobs.read'", [runRef]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("does not reach another organization's run", async () => {
    const manager = await withRole("management");
    const runRef = await run(manager);
    await pool.execute("UPDATE agentRuns SET tenantId = 'ORG-ELSEWHERE' WHERE runRef = ?", [runRef]);
    await expect(caller(manager).agent.requestAction({ runRef, capability: "jobs.read", target, payload: { x: 1 } }))
      .rejects.toThrow(/No such run/);
  });
});

d("a retry replays; a changed payload does not", () => {
  it("replays the original answer for the same request id and payload", async () => {
    const manager = await withRole("management");
    const runRef = (await caller(manager).agent.start({ agentKey: "secretary", goal: "close the month" })).runRef;
    const args = { runRef, capability: "jobs.read", target, payload: { amount: 1000 }, requestId: "REQ-IDENT" };
    const first = await caller(manager).agent.requestAction(args);
    const second = await caller(manager).agent.requestAction(args);
    expect(second.replayed).toBe(true);
    expect(second.actionRef).toBe(first.actionRef);
  });

  it("refuses the same request id carrying a different payload", async () => {
    const manager = await withRole("management");
    const runRef = (await caller(manager).agent.start({ agentKey: "secretary", goal: "close the month" })).runRef;
    const base = { runRef, capability: "jobs.read", target, requestId: "REQ-SWAP" };
    await caller(manager).agent.requestAction({ ...base, payload: { amount: 1000 } });
    // Telling this caller "already decided" would be false, and false in the
    // direction they chose.
    await expect(caller(manager).agent.requestAction({ ...base, payload: { amount: 9000 } }))
      .rejects.toThrow(/a changed payload needs its own request id/);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM agentActions WHERE runRef = ? AND capability = 'jobs.read'", [runRef]);
    // And it is not silently recorded as a second action either.
    expect(Number(rows[0].n)).toBe(1);
  });

  it("treats a reordered but identical payload as the same request", async () => {
    const manager = await withRole("management");
    const runRef = (await caller(manager).agent.start({ agentKey: "secretary", goal: "close the month" })).runRef;
    const base = { runRef, capability: "jobs.read", target, requestId: "REQ-ORDER" };
    await caller(manager).agent.requestAction({ ...base, payload: { a: 1, b: { c: 2, d: 3 } } });
    const again = await caller(manager).agent.requestAction({ ...base, payload: { b: { d: 3, c: 2 }, a: 1 } });
    expect(again.replayed).toBe(true);
  });
});
