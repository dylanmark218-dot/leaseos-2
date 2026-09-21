/**
 * P6.7 — purchase orders have two limit sources and only one is consulted.
 *
 * `spendingLimits` governs, through `limitsFor()` in the purchasing router. The `purchase_order`
 * tiers in `commercialApprovalPolicies` are read by the commercial-office surfaces and never by the
 * path that approves a purchase order — including one tier a real person configured.
 *
 * This is not a bug to fix quietly: which source should govern is an owner decision
 * (`docs/P6_6_P6_7_DECISION_BRIEF.md`). What this file does is stop the divergence becoming
 * invisible, because the way it hurts somebody is specific — they edit the tier, the change saves,
 * and nothing happens.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const purchasing = readFileSync("server/purchasingRouter.ts", "utf8");

describe("the purchase-order path's limit source is exactly one thing", () => {
  it("consults spendingLimits, at request and at approval", () => {
    expect(purchasing).toMatch(/async function limitsFor\(/);
    expect(purchasing).toMatch(/from\(spendingLimits\)/);
    expect((purchasing.match(/await limitsFor\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("does not consult the approval ladder, which is the open decision and not an accident", () => {
    /*
     * If this ever starts passing by accident — somebody wires the ladder in without the decision
     * being made — the two sources are live at once with no stated precedence, and a purchase order
     * can satisfy one while violating the other.
     */
    expect(purchasing).not.toMatch(/commercialApprovalPolicies/);
  });

  it("keeps the decision visible in the register rather than in somebody's memory", () => {
    const register = readFileSync("docs/REMAINING_BUILD_REGISTER.md", "utf8");
    expect(register).toMatch(/\| P6\.7 \|/);
    const brief = readFileSync("docs/P6_6_P6_7_DECISION_BRIEF.md", "utf8");
    expect(brief).toMatch(/Never read on the purchase-order path/);
  });
});

describe("the seeded ladder does not claim to be approved", () => {
  it("carries `confirm mapping` on every row the migration seeded", () => {
    /*
     * The rows say what they are: a mapping from the owner's words onto roles that exist, with the
     * guess named. When P6.6 is confirmed, that phrase is what gets replaced — so while it is still
     * there, nothing in the system is pretending the ladder was approved.
     */
    const seed = readFileSync("drizzle/0133_commercial_office_configuration.sql", "utf8");
    const ladderBlock = seed.slice(seed.indexOf("commercialApprovalPolicies"));
    /*
     * Three tiers are defined once each and fanned across all six categories by a UNION, so the
     * assertion is per tier rather than per row: each of the three names the guess it is making.
     * The seed also says `supervisor up to $5,000 -> office` here while the live row reads
     * `controller` — a later migration moved it, which is itself worth knowing when confirming the
     * mapping, because the decision is being made against the current state and not this file.
     */
    const tiers = ladderBlock.split("\n").filter(l => /-> (office|controller|management)/.test(l));
    expect(tiers.length, "the three seeded tiers").toBe(3);
    for (const t of tiers) expect(t, "a seeded tier without its guess named").toMatch(/confirm mapping/);
  });
});
