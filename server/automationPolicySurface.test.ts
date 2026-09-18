/**
 * P8.2 — the resolver is the only normal source of an effective automation mode, and the policy
 * surface refuses escalation.
 *
 * The structural half exists because the behavioural tests cannot see the failure that matters
 * most: an engine quietly growing its own idea of precedence. Two orderings that agree today will
 * disagree the first time someone adds a scope, and by then every stored trace is a lie about how
 * the decision was actually made.
 */
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let nextId = 920_000 + Math.floor(Math.random() * 60_000);   // a fresh base per run: the gate rebuilds the database, but a developer running this twice should not collide
const nextUser = () => ++nextId;
const rnd = () => Math.random().toString(36).slice(2, 8);

beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = nextUser();
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}

/* ------------------------------------------------------------------ */

describe("only the resolver decides an effective mode", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() && e.name !== "node_modules" ? walk(`${dir}/${e.name}`)
        : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);

  /** The two files that are allowed to reason about mode precedence, and why. */
  const ALLOWED = new Set([
    "server/_core/automationPolicy.ts",        // the resolver itself
    "server/_core/automationPolicyStore.ts",   // reads the rows and hands them to it
    "server/automationPolicyRouter.ts",        // the surface; delegates every decision
  ]);

  it("keeps the mode ordering in exactly one place", () => {
    const offenders = [...walk("server"), ...walk("client/src")].filter(f => {
      if (ALLOWED.has(f)) return false;
      const src = readFileSync(f, "utf8").split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      // A second ordering of the three modes, anywhere else, is the drift this guard exists for.
      return /AUTOMATION_LEVEL\s*[:=]/.test(src)
        || /["']AUTO["']\s*:\s*\d[\s\S]{0,40}["']HYBRID["']\s*:\s*\d/.test(src)
        || /SCOPE_RANK\s*[:=]/.test(src);
    });
    expect(offenders, "an engine has started ordering automation modes itself").toEqual([]);
  });

  it("keeps the scope precedence in exactly one place, and in the owner's order", () => {
    const src = readFileSync("server/_core/automationPolicy.ts", "utf8");
    expect(src).toMatch(/SCOPE_ORDER = \["tenant", "role", "task", "customer"\]/);
    // Task beats role, and the customer is considered last of the normal business rows.
    expect(src).toMatch(/tenant: 1, role: 2, task: 3, customer: 4/);
  });

  it("leaves the P8.4 ceiling list empty rather than inferring it", () => {
    const store = readFileSync("server/_core/automationPolicyStore.ts", "utf8");
    expect(store).toMatch(/export const SAFETY_CEILINGS: Readonly<Record<string, SafetyCeiling>> = \{\}/);
    // Inferring a ceiling from a capability's name would decide P8.4 here, by guess.
    expect(store).toMatch(/P8\.4 decides the list/);
  });

  it("does not let NOT_EVALUATED into the P8.1 severity comparison, unchanged by this work", () => {
    const src = readFileSync("server/_core/interEngineStatus.ts", "utf8");
    const decl = src.slice(src.indexOf("const SEVERITY"));
    expect(decl.slice(decl.indexOf("{") + 1, decl.indexOf("}"))).not.toContain("NOT_EVALUATED");
  });
});

/* ------------------------------------------------------------------ */

d("the policy surface, against the database", () => {
  it("defaults an entitled capability with no policy to MANUAL, and reports an unentitled one as NOT_EVALUATED", async () => {
    const mgr = await withRole("management");
    const cap = `probe_${rnd()}`;
    await callerFor(mgr).automationPolicy.setEntitlement({ capability: cap, state: "entitled", reference: "ENT-TEST" });
    const resolved = await callerFor(mgr).automationPolicy.resolve({ capability: cap });
    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome === "resolved") {
      expect(resolved.mode).toBe("MANUAL");                     // a missing policy is not permission
      expect(resolved.winner).toBeNull();
    }
    await callerFor(mgr).automationPolicy.setEntitlement({ capability: cap, state: "not_entitled", reason: "unlicensed" });
    const after = await callerFor(mgr).automationPolicy.resolve({ capability: cap });
    expect(after.outcome).toBe("not_evaluated");
    if (after.outcome === "not_evaluated") expect(after.notEvaluatedReason).toBe("not_licensed");
  }, 60_000);

  it("treats a capability nobody has ruled on as unresolved, not as a refusal", async () => {
    const mgr = await withRole("management");
    const r = await callerFor(mgr).automationPolicy.resolve({ capability: `never_mentioned_${rnd()}` });
    expect(r.outcome).toBe("not_evaluated");
    if (r.outcome === "not_evaluated") {
      expect(r.notEvaluatedReason).toBe("no_data_source_loaded");
      expect(r.reason).toMatch(/unresolved entitlement is not an entitlement/);
    }
  }, 60_000);

  it("resolves through the scopes and shows which row won", async () => {
    const mgr = await withRole("management");
    const cap = `probe_${rnd()}`;
    await callerFor(mgr).automationPolicy.setEntitlement({ capability: cap, state: "entitled" });
    await callerFor(mgr).automationPolicy.set({ capability: cap, scope: "tenant", requestedMode: "AUTO", reason: "tenant default for the pilot" });
    await callerFor(mgr).automationPolicy.set({ capability: cap, scope: "customer", scopeId: "CUST-9", requestedMode: "MANUAL", reason: "this customer wants a person on it" });
    const withCustomer = await callerFor(mgr).automationPolicy.resolve({ capability: cap, customer: "CUST-9" });
    if (withCustomer.outcome !== "resolved") throw new Error("expected a resolution");
    expect(withCustomer.mode).toBe("MANUAL");
    expect(withCustomer.trace).toBe("tenant=AUTO → customer:CUST-9=MANUAL → resolved=MANUAL");
    // A different customer is not governed by that row.
    const other = await callerFor(mgr).automationPolicy.resolve({ capability: cap, customer: "CUST-OTHER" });
    if (other.outcome !== "resolved") throw new Error("expected a resolution");
    expect(other.mode).toBe("AUTO");
  }, 60_000);

  it("supersedes rather than rewrites, so an old version is still on the record", async () => {
    const mgr = await withRole("management");
    const cap = `probe_${rnd()}`;
    await callerFor(mgr).automationPolicy.setEntitlement({ capability: cap, state: "entitled" });
    const first = await callerFor(mgr).automationPolicy.set({ capability: cap, scope: "tenant", requestedMode: "AUTO", reason: "initial pilot setting" });
    const second = await callerFor(mgr).automationPolicy.set({ capability: cap, scope: "tenant", requestedMode: "HYBRID", reason: "pulled back after review" });
    expect(second.supersededVersionIds).toContain(first.policyVersionId);
    const history = await callerFor(mgr).automationPolicy.history({ capability: cap });
    expect(history.policies.length).toBe(2);                     // both versions survive
    const old = history.policies.find(p => p.policyVersionId === first.policyVersionId)!;
    expect(old.requestedMode).toBe("AUTO");                      // and the old one still says AUTO
    expect(old.supersededAt).not.toBeNull();
    expect(old.supersededByVersionId).toBe(second.policyVersionId);
  }, 60_000);

  it("refuses a policy change from someone without the permission", async () => {
    const dispatcher = await withRole("dispatcher");
    await expect(callerFor(dispatcher).automationPolicy.set({
      capability: `probe_${rnd()}`, scope: "tenant", requestedMode: "AUTO", reason: "trying it on",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("lets a dispatcher take one trip toward more human involvement, and refuses the other direction", async () => {
    const dispatcher = await withRole("dispatcher");
    const down = await callerFor(dispatcher).automationPolicy.operationalOverride({
      capability: "hos", from: "AUTO", to: "HYBRID", scope: "one_trip", reason: "new driver on this run",
    });
    expect(down.mode).toBe("HYBRID");
    expect(down.note).toMatch(/standing policy is unchanged/);
    await expect(callerFor(dispatcher).automationPolicy.operationalOverride({
      capability: "hos", from: "HYBRID", to: "AUTO", scope: "one_trip", reason: "would be quicker",
    })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/needs automation\.policy\.manage/) });
  }, 60_000);

  it("gives a decision a snapshot that names the winning version", async () => {
    const mgr = await withRole("management");
    const cap = `probe_${rnd()}`;
    await callerFor(mgr).automationPolicy.setEntitlement({ capability: cap, state: "entitled" });
    const w = await callerFor(mgr).automationPolicy.set({ capability: cap, scope: "tenant", requestedMode: "HYBRID", reason: "the pilot default for this capability" });
    const snap = await callerFor(mgr).automationPolicy.snapshotFor({ capability: cap });
    expect(snap.resolvedMode).toBe("HYBRID");
    expect(snap.winningPolicyVersionId).toBe(w.policyVersionId);
    expect(snap.entitled).toBe(true);
    expect(snap.trace).toMatch(/resolved=HYBRID/);
  }, 60_000);
});
