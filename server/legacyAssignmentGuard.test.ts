/**
 * `jobUnits.create` is not the assignment API, and this is what stops it becoming one again.
 *
 * It reads as an assignment mutation and behaves as one under the default enforcement mode, which
 * is exactly why a UI developer reached for it. What it actually does, when handed an
 * `eligibilityCheckId`, is set `dispatchEligibilityChecks.usedForAward` — the same column the award
 * transaction sets — and its gate function is documented in the source as *"The award's rule,
 * without a posting or a bid"*. Under `enforced` it refuses outright without a valid check.
 *
 * A comment saying "do not use this" is not a guard: the next person will not read it, and nothing
 * fails if they do not. This is built like `clientTruth.test.ts`, which scans production client
 * source with a regex and asserts a list is empty, because that is a guard CI can actually enforce.
 *
 * The procedure stays mounted. Unmounting it costs four test files, two pinned counts and two
 * inventory invariants and buys nothing while it has no production callers — and its historical
 * rows, duplicates included, are evidence the exception centre still reports on.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Source with comments removed. The point matters: this file's own subject matter is a list of
 * things production code must not write, and the modules that avoid them explain WHY in prose. A
 * scan that cannot tell a warning from a use would fail on the warning.
 */
const codeOf = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(`${dir}/${e.name}`)
      : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);

describe("the legacy direct-award path is not the assignment API", () => {
  it("no production client file calls jobUnits.create", () => {
    const offenders = walk("client/src").filter(f => /trpc\.[\w.]*jobUnits\.create/.test(codeOf(f)));
    expect(
      offenders,
      "jobUnits.create carries award semantics — it sets usedForAward when given an eligibility " +
      "check. Ordinary assignment goes through dispatch.setRoleAssignment.",
    ).toEqual([]);
  });

  it("no production server module calls it either", () => {
    const mounting = ["dispatchEnforcementService.ts", "routers.ts", "recordsAuthorization.ts"];
    const offenders = walk("server").filter(f =>
      /\bcreateJobUnitGated\b|jobUnits\.create/.test(codeOf(f)) &&
      !mounting.some(m => f.endsWith(m)));
    expect(offenders, "the legacy path has no callers outside its own mounting").toEqual([]);
  });

  /*
   * The canonical path must not quietly grow the behaviour that made the legacy one unsafe. These
   * are the award's durable evidence; the assignment service must name none of them.
   */
  it("the canonical assignment service touches none of the award's evidence", () => {
    const src = codeOf("server/dispatchRoleService.ts");
    for (const forbidden of [
      "usedForAward",
      "resourceBookings",
      "dispatchAuditEvents",
      "assignment_approved",
      "dispatchBids",
      "dispatchInvitations",
      "eligibilityCheckId",
    ]) {
      expect(
        src.includes(forbidden),
        `dispatchRoleService must not mention ${forbidden} — that is the award's, and an ` +
        `assignment that writes it becomes indistinguishable from an award`,
      ).toBe(false);
    }
  });

  it("the assignment input schema has no award credential", () => {
    const router = codeOf("server/dispatchRouter.ts");
    const setBlock = router.slice(
      router.indexOf("setRoleAssignment: roleProcedure"),
      router.indexOf("clearRoleAssignment: roleProcedure"),
    );
    expect(setBlock.length, "the procedure must exist to be checked").toBeGreaterThan(100);
    expect(setBlock.includes("eligibilityCheckId")).toBe(false);
    expect(setBlock.includes(".strict()"), "unknown keys are refused, not silently stripped").toBe(true);
  });

  /* Historical rows are evidence. Nothing in this subsystem deletes, rewrites or deduplicates one. */
  it("nothing in the canonical subsystem writes, deletes or rewrites jobUnits", () => {
    for (const f of ["server/dispatchRoleService.ts", "server/dispatchRouter.ts"]) {
      const src = codeOf(f);
      expect(/insert\(jobUnits\)|update\(jobUnits\)|delete\(jobUnits\)/.test(src), f).toBe(false);
    }
  });
});

/*
 * ── Checkpoint I: the dispatcher's screen reads the canonical model ──────────────────────────
 *
 * The container is where the UI's half of this can regress, and it is the one piece of the screen
 * no DOM test reaches: this repository tests views, which take props, and containers, which call
 * tRPC, have no harness. What they do is still load-bearing, so it is asserted structurally —
 * the same trade `clientTruth.test.ts` makes for the same reason.
 */
describe("the dispatcher's detail screen is wired to the canonical model", () => {
  const detail = () => codeOf("client/src/dispatch/DispatchJobDetail.tsx");
  const readiness = () => codeOf("client/src/dispatch/DispatchReadiness.tsx");

  it("reads slots from dispatch.listRoles, not from the legacy worklog table", () => {
    expect(detail()).toContain("dispatch.listRoles");
    expect(
      /jobUnits/.test(detail()),
      "the detail container must not read jobUnits — two sources for 'who is on this job' is the " +
      "condition this subsystem exists to end",
    ).toBe(false);
  });

  /*
   * The readiness subject is the sharper case. A verdict computed from whoever last filed hours,
   * while assignments are written to slots, is not stale — it is about a different crew, and it
   * looks exactly like a current answer.
   */
  it("resolves the readiness subject from the slot binding, not from jobUnits", () => {
    expect(readiness()).toContain("dispatch.listRoles");
    expect(/jobUnits/.test(readiness()), "one canonical current-assignment source").toBe(false);
  });

  it("invalidates readiness after every slot write, through the one policy that says so", () => {
    const src = detail();
    /*
     * Matched as a call, not as a name. `toContain` alone is satisfied by the import line, so a
     * container that imported the policy and never invoked it passed this test — found by planting
     * exactly that and watching nothing fail.
     */
    expect(
      /invalidateAfterSlotMutation\s*\(/.test(src),
      "importing the policy is not applying it — this must be a call",
    ).toBe(true);
    // onSettled, not onSuccess: a conflict means somebody else moved the slot, which is precisely
    // when the readiness on screen is about the wrong crew.
    const settled = (src.match(/onSettled/g) ?? []).length;
    expect(settled, "both mutations must re-read on settle").toBeGreaterThanOrEqual(2);
  });

  it("does not hand the assignment mutation an award credential", () => {
    expect(/eligibilityCheckId/.test(detail())).toBe(false);
    expect(/usedForAward|awardPosting|dispatch\.award/.test(detail())).toBe(false);
  });

  it("offers no client path to the legacy mutation from the dispatch screens", () => {
    for (const f of ["client/src/dispatch/DispatchJobDetail.tsx", "client/src/dispatch/DispatchJobDetailView.tsx"]) {
      expect(/jobUnits\.create/.test(codeOf(f)), f).toBe(false);
    }
  });
});
