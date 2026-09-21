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
