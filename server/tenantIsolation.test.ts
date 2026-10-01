/**
 * v22.20 — the tenant surface, measured.
 *
 * Organization-wide isolation is not a property this system has. This test does
 * not pretend otherwise: it measures the surface so the gap cannot silently
 * widen, and fails when somebody adds a tenant-scoped writer that invents its
 * own organization instead of deriving one.
 *
 * The pins are deliberately the boring kind — a count and an allowlist. A
 * reader who changes them has to say why in the diff, which is the whole point.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync("drizzle/schema.ts", "utf8");

function tablesWithTenant(): { table: string; notNull: boolean }[] {
  const out: { table: string; notNull: boolean }[] = [];
  const re = /export const \w+ = mysqlTable\("(\w+)", \{([\s\S]*?)\n\}\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schema))) {
    const [, table, body] = m;
    if (!body.includes("tenantId:")) continue;
    // Read the declaration line, not the text after the first occurrence of the
    // word: `tenantId: varchar("tenantId", ...)` contains it twice, and
    // splitting on it lands inside the varchar call where no modifier lives.
    const line = body.split("\n").find(l => l.trim().startsWith("tenantId:")) ?? "";
    out.push({ table, notNull: line.includes(".notNull()") });
  }
  return out;
}

describe("the tenant surface is known", () => {
  it("is twenty tables, and the nullability split is deliberate", () => {
    const scoped = tablesWithTenant();
    // The organization is carried only where something consults it. This count
    // moving is a new scoped concept and has to be changed on purpose — which
    // is what happened when leaveRequests arrived and this test failed first,
    // and again when AIL-1A (0210) gave assistantProposals an owner.
    expect(scoped).toHaveLength(20);
    expect(scoped.map(t => t.table).sort()).toEqual([
      "agentRuns", "assistantProposals", "assistantQueries", "billingAuthorityBands", "crews", "domainEventOutbox", "enforcementEvents",
      "knowledgePassages", "leaveRequests", "messageChannels", "oosReleasePolicies", "operationalTasks", "outOfServiceOrders",
      "retrievalMeasurements", "retrievalProbes", "shiftPosts", "workerQualifications", "workflowInstances", "workflowNotifications",
      "workflowRules",
    ]);
    // Four require one and thirteen do not, which is a real split rather than the
    // uniform picture an earlier version of this test reported from a parsing
    // bug. The workflow tables have always demanded a tenant; the enforcement
    // ones are nullable because rows predating the column exist.
    // shiftInterests deliberately carries no tenant: it is reachable only
    // through its post, and every read resolves the post first. A duplicated
    // column would be a second place for the answer to disagree.
    expect(scoped.map(t => t.table)).not.toContain("shiftInterests");
    expect(scoped.filter(t => t.notNull).map(t => t.table).sort()).toEqual([
      "domainEventOutbox", "operationalTasks", "workflowInstances", "workflowNotifications",
    ]);
    // assistantProposals is nullable only together with `legacy_unresolved` (0210's CHECK): a legacy
    // row whose owner was never proved, which strict equality leaves visible to nobody.
    expect(scoped.filter(t => !t.notNull).map(t => t.table).sort()).toEqual([
      "agentRuns", "assistantProposals", "assistantQueries", "billingAuthorityBands", "crews", "enforcementEvents",
      "knowledgePassages", "leaveRequests",
      "messageChannels", "oosReleasePolicies", "outOfServiceOrders", "retrievalMeasurements", "retrievalProbes", "shiftPosts",
      "workerQualifications",
      "workflowRules",
    ]);
  });
});

describe("no production writer invents an organization", () => {
  /** Files that may name a tenant literal, and why. */
  const ALLOWED = new Map<string, string>([
    ["_core/actingScope.ts", "defines SINGLE_TENANT_ID — the one place the fallback is named"],
  ]);

  function serverFiles(): string[] {
    const out: string[] = [];
    for (const dir of ["server", "server/_core"]) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".ts") || f.includes(".test.")) continue;
        out.push(`${dir}/${f}`);
      }
    }
    return out;
  }

  it("passes no string literal as tenantId outside the one file allowed to name it", () => {
    const offenders: string[] = [];
    for (const path of serverFiles()) {
      const body = readFileSync(path, "utf8");
      // `tenantId: "something"` — a literal organization written into code.
      const literals = body.match(/tenantId:\s*"[^"]+"/g) ?? [];
      if (!literals.length) continue;
      const key = path.replace(/^server\//, "");
      if (ALLOWED.has(key)) continue;
      offenders.push(`${path}: ${literals.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("scopes the time-off reads to the caller's organization", () => {
    const timeOff = readFileSync("server/timeOffRouter.ts", "utf8");
    expect(timeOff).toContain("resolveActingScope");
    expect(timeOff).toContain("eq(leaveRequests.tenantId, acting.tenantId)");
    expect(timeOff).not.toMatch(/tenantId:\s*z\.string/);
  });

  it("never selects the private note in the scheduling read", () => {
    const timeOff = readFileSync("server/timeOffRouter.ts", "utf8");
    const schedulingRead = timeOff.slice(timeOff.indexOf("schedulingWindow:"));
    const selectBlock = schedulingRead.slice(schedulingRead.indexOf("d.select({"), schedulingRead.indexOf("}).from(leaveRequests)"));
    // The column list is the privacy boundary; a filter in code is one somebody
    // eventually forgets.
    expect(selectBlock).not.toContain("privateNote");
    expect(selectBlock).toContain("leaveRequests.category");
  });

  it("derives the organization from server-owned context where it derives one at all", () => {
    const enforcement = readFileSync("server/enforcementRouter.ts", "utf8");
    const comms = readFileSync("server/commsRouter.ts", "utf8");
    for (const body of [enforcement, comms]) {
      expect(body).toContain("resolveActingScope");
      expect(body).toContain("acting.tenantId");
    }
    // And neither accepts one from the request.
    expect(enforcement).not.toMatch(/tenantId:\s*z\.string/);
    expect(comms).not.toMatch(/tenantId:\s*z\.string/);
  });

  it("keeps the single-tenant fallback in exactly one place", () => {
    const declarations = serverFiles().filter(p => /export const SINGLE_TENANT_ID/.test(readFileSync(p, "utf8")));
    expect(declarations).toEqual(["server/_core/actingScope.ts"]);
  });
});

describe("what is still not true", () => {
  it("records that isolation is a property of two paths and not of the system", () => {
    // Reading a tenant is not the same as filtering by one. Only the paths that
    // select a release policy and evaluate an enforcement order consult the
    // organization at all; nothing else filters reads by it. When that changes,
    // this test is the thing that should be rewritten first.
    const enforcement = readFileSync("server/enforcementRouter.ts", "utf8");
    expect(enforcement).toContain("selectPolicyForScope");
    const doc = readFileSync("LEASEOS_CURRENT_STATE.md", "utf8");
    expect(doc).toMatch(/organization-wide isolation is NOT yet a\s*\n?property this system has/i);
  });
});

describe("the transaction handle is typed", () => {
  /**
   * `tx: any` switched off Drizzle's checking inside every transaction block.
   * Two schema mismatches shipped through it in one checkpoint — a defect
   * severity and an actorSource that do not exist — and typing the handle found
   * a third immediately: a number going into a varchar column.
   */
  it("uses no untyped transaction handle in the enforcement or comms paths", () => {
    const offenders: string[] = [];
    for (const path of [
      "server/_core/enforcementCommit.ts", "server/_core/enforcementOutbox.ts",
      "server/enforcementRouter.ts", "server/commsRouter.ts",
    ]) {
      const body = readFileSync(path, "utf8");
      if (/tx:\s*any/.test(body)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("uses no untyped database handle in any production server file", () => {
    // The same hole as `tx: any`, one level out. Typing these found a possible
    // undefined dereference in scope resolution and a fuel column that does not
    // exist — both silently compiling until the handles were named.
    const offenders: string[] = [];
    for (const dir of ["server", "server/_core"]) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".ts") || f.includes(".test.")) continue;
        const path = `${dir}/${f}`;
        const body = readFileSync(path, "utf8");
        if (/\b(db|tx|d):\s*any\b/.test(body) && !path.endsWith("dbTypes.ts")) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares the transaction type once", () => {
    const decl = readFileSync("server/_core/dbTypes.ts", "utf8");
    expect(decl).toContain("export type Tx");
    expect(decl).toContain("MySqlTransaction");
  });
});

describe("a typed handle is not cast back to any", () => {
  /**
   * Typing the handles is undone by one `as any` at a call site, and the file
   * that does it inherits the hole for everything it calls. This is the
   * regression that would otherwise reappear the next time a signature is
   * inconvenient.
   */
  it("passes no database or transaction handle through an any cast", () => {
    const offenders: string[] = [];
    for (const dir of ["server", "server/_core"]) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".ts") || f.includes(".test.")) continue;
        const path = `${dir}/${f}`;
        const body = readFileSync(path, "utf8");
        // `tx as any`, `db as any`, `d as any` — the handle laundered.
        if (/\b(tx|db|d)\s+as\s+any\b/.test(body)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("records how many any-casts remain, so the number only moves on purpose", () => {
    let total = 0;
    const byFile: Record<string, number> = {};
    for (const dir of ["server", "server/_core"]) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".ts") || f.includes(".test.")) continue;
        const n = (readFileSync(`${dir}/${f}`, "utf8").match(/as any/g) ?? []).length;
        if (n) { byFile[`${dir}/${f}`] = n; total += n; }
      }
    }
    // Eight, and none of them a database handle: six in the third-party SDK
    // shim where the upstream response shape is genuinely wider than its type,
    // one Blob construction, and one that is not a cast at all — the phrase
    // "was missing was any way to call them" in a doc comment. A substring
    // count cannot tell prose from code, so the number is what it is and the
    // files are named. Raising it is a decision somebody makes in a diff.
    expect(total).toBe(8);
    expect(Object.keys(byFile).sort()).toEqual([
      "server/_core/sdk.ts", "server/portalFundingRouter.ts", "server/storage.ts",
    ]);
  });
});

describe("the workflow runtime exists and is started through one production owner", () => {
  /**
   * An earlier version of this block concluded that no workflow runtime
   * existed. That was false, and the way it was false is worth keeping: it
   * searched production source for `insert(workflowRules)` — the Drizzle shape
   * — and `workflowRuntime.ts` writes those tables with raw SQL. A string
   * search found nothing and the absence was read as proof.
   *
   * The real state is narrower and more useful: the engine, runtime, seeds and
   * drain worker all exist and are exercised against the database. The production
   * lifecycle now starts one claim owner through `productionWorker.ts`, and that
   * owner dispatches specialised enforcement handling without starting a second
   * consumer for the same outbox.
   */
  const runtime = readFileSync("server/_core/workflowRuntime.ts", "utf8");
  const drain = readFileSync("server/_core/drainWorker.ts", "utf8");

  it("has a runtime that writes the workflow tables, by raw SQL rather than the query builder", () => {
    expect(runtime).toContain("INSERT INTO workflowRules");
    expect(runtime).toContain("INSERT INTO operationalTasks");
    expect(runtime).toContain("createWorkerPorts");
    expect(drain).toContain("startDrainWorker");
  });

  it("has a single-claim-owner dispatcher and a start-once lifecycle, so activating it is safe", () => {
    // The two things that had to exist before the worker could be turned on:
    // one claimer routing to handlers, and a refusal to run two loops in one
    // process. Neither is caught by the lease — both loops would be live.
    const lifecycle = readFileSync("server/_core/workerLifecycle.ts", "utf8");
    expect(lifecycle).toContain("export function withHandlers");
    expect(lifecycle).toContain("export function startOnce");
    expect(lifecycle).toContain("WorkerAlreadyStarted");
    expect(lifecycle).toContain("onShutdown");
  });

  it("is started by the production entry point through the single-owner lifecycle", () => {
    const production = readFileSync("server/_core/productionWorker.ts", "utf8");
    // P0-C: the production entry point composes `startServer` (server/_core/startup.ts), which
    // is where the embedded worker is started; the entry file itself only chooses the frontend.
    const entry = readFileSync("server/_core/startup.ts", "utf8");
    expect(readFileSync("server/_core/index.ts", "utf8")).toContain("startServer(");
    const standalone = readFileSync("server/_core/worker.ts", "utf8");

    expect(production).toContain("startProductionWorker");
    expect(production).toContain("startOnce");
    expect(production).toContain("startDrainWorker");
    expect(production).toContain("withHandlers");
    expect(production).toContain("handleClaimedEnforcementEvent");
    expect(entry).toContain("await startProductionWorker()");
    expect(standalone).toContain("await startProductionWorker()");

    // The legacy enforcement consumer remains available for direct tests/tools,
    // but the production owner must not start it alongside the shared claimer.
    expect(production).not.toContain("consumeEnforcementEvents");
  });
});

describe("test fixtures cannot collide on user ids", () => {
  /**
   * These suites share one database. A file that allocates users across a wide
   * range will eventually land on ids another file has already granted roles
   * to, and the symptom is a role assertion seeing one extra — intermittent,
   * and nothing to do with the code under test. One did: a 400,000-wide window
   * starting at 500,000 overlapped a file beginning at 880,000.
   */
  it("gives every role-granting suite a narrow window, so overlap is not left to chance", () => {
    const wide: string[] = [];
    for (const f of readdirSync("server")) {
      if (!f.endsWith(".test.ts")) continue;
      const body = readFileSync(`server/${f}`, "utf8");
      if (!body.includes("grantUserRole")) continue;
      const m = body.match(/Math\.random\(\) \* ([0-9_]+)\)/);
      if (m && Number(m[1].replace(/_/g, "")) > 100_000) wide.push(`${f}: window ${m[1]}`);
    }
    expect(wide).toEqual([]);
  });
});
