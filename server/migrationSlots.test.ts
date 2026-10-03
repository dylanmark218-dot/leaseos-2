/**
 * B23.1A — the migration slot guard, and proof that it catches a NEW collision.
 *
 * B23.1 added a guard that read the real tree. That checks today's state but
 * says nothing about whether the guard would notice tomorrow's mistake — and a
 * guard nobody can test is a guard nobody trusts. The logic now lives in
 * `_core/migrationSlots.ts` as a pure function, so this file can hand it a
 * synthetic tree containing exactly the mistake we are trying to prevent.
 *
 * Why this matters at all: `apply-migrations.sh` applies `drizzle/*.sql` in
 * `sort` order and `_journal.json` has been dead since 0018, so the filename is
 * the whole registry. Two files in one slot let a merge reorder dependent DDL
 * with every other gate still passing.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditMigrationSlots,
  describeFinding,
  headSlot,
  KNOWN_DUPLICATE_SLOTS,
  RESERVED_SLOTS,
} from "./_core/migrationSlots";

const files = readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort();

describe("the real tree", () => {
  it("has no collision, malformed name or reserved-slot occupant beyond the one inherited", () => {
    const findings = auditMigrationSlots(files);
    expect(findings.map(describeFinding)).toEqual([]);
  });

  it("still carries the inherited 0157 duplicate, so the allowlist is not stale", () => {
    // If somebody ever does reconcile 0157, this fails and the allowlist entry
    // should be deleted with it. An allowlist that outlives its debt is how the
    // next collision gets waved through.
    const dupes = files.filter(f => f.startsWith("0157_"));
    expect(dupes).toHaveLength(2);
    expect(Object.keys(KNOWN_DUPLICATE_SLOTS)).toEqual(["0157"]);
  });

  it("numbers each checkpoint above every slot in use in any lineage of this repository", () => {
    // 0169 — the slot the B23.0 report suggested — is occupied by two different
    // migrations in other lineages (`0169_defect_resolution` in three,
    // `0169_print_audit` in a fourth). 0170 was the first free everywhere.
    expect(files).toContain("0207_organization_scoped_role_grants.sql");   // renumbered from 0170 on merging main, which took 0170
    // Since then main has carried one 0169 of its own (the reconciled defect-resolution migration);
    // what this checkpoint promised is that it added none.
    expect(files.filter(f => f.startsWith("0169_"))).toEqual(["0169_defect_resolution.sql"]);
    // B23.2: 0175. By the time this checkpoint allocated, `origin/main` had
    // reached 0174 and 0170 itself had become a three-way collision across
    // lineages (dispatch_role_types and driver_portfolio_events took it too).
    // head+1 on this branch would have collided three times over.
    expect(files).toContain("0208_organization_invitations.sql");   // renumbered from 0175 on merging main, which took 0175
    // Main has since taken 0209 (0209_operating_zone_scope, P0-A2.1), above this checkpoint's two; the
    // ledger applies by name, so 0207/0208 still run on a database that already has 0209.
    // SA1 (Sign & Attest) holds 0214–0216 on this branch, below v23.31's 0217–0219, which were renumbered
    // around them; both lineages apply by name.
    // v23.31 took 0217–0219 (Customer, Contract and Rate Management): 0210–0216 are claimed by open
    // branches, so head+1 would have collided; the register records the scan.
    expect(files).toContain("0219_job_commercial_context.sql");
    // Mechanic Portal CP2 took 0221–0222 (defect lifecycle and its guards): 0220 is claimed by
    // `claude/eld-compliance-intelligence-ramlrd`, so head+1 would have collided; the register records the scan.
    expect(files).toContain("0222_defect_lifecycle_guards.sql");
    // Payroll P1 took 0226 (compensation agreements): 0220–0225 are claimed by open branches (ELD, integration
    // hub, CI stabilization), so head+1 would have collided twice; drafted as 0224 and moved before it was applied.
    expect(files).toContain("0226_payroll_compensation_agreements.sql");
    // Payroll P2 took 0227 (pay schedules): 0223–0225 are still claimed by open branches, below main's 0226.
    expect(files).toContain("0227_payroll_pay_schedules.sql");
    // Payroll P3 took 0228 (payroll time, candidates, exceptions): scanned immediately before it was written; nothing
    // in any lineage held 0228 or above.
    expect(files).toContain("0228_payroll_time_candidates_exceptions.sql");
    expect(headSlot(files)).toBe("0228");
  });

  it("keeps the reserved slots empty", () => {
    for (const slot of RESERVED_SLOTS) {
      expect(files.filter(f => f.startsWith(`${slot}_`)), slot).toEqual([]);
    }
  });
});

describe("the guard catches what it exists to catch", () => {
  it("fails a NEW duplicate, even one next to the tolerated old one", () => {
    const withNewCollision = [...files, "0175_something_else_entirely.sql"];
    const findings = auditMigrationSlots(withNewCollision);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "duplicate_slot", slot: "0175" });
    expect(describeFinding(findings[0]!)).toContain("allocate the next free slot");
  });

  it("does not let the 0157 baseline mask a collision in another slot", () => {
    // The specific failure an allowlist invites: "duplicates are known about",
    // applied to a slot nobody reviewed.
    const findings = auditMigrationSlots([
      "0157_seal_verification_unavailable.sql",
      "0157_signature_device_attestation.sql",
      "0042_one.sql",
      "0042_two.sql",
    ]);
    expect(findings.map(f => (f.kind === "duplicate_slot" ? f.slot : f.kind))).toEqual(["0042"]);
  });

  it("fails a filename the runner cannot order", () => {
    const findings = auditMigrationSlots([
      "171_missing_a_digit.sql",
      "0172-dashes-not-underscores.sql",
      "0173_Capitals.sql",
      "whatever.sql",
    ]);
    expect(findings).toHaveLength(4);
    expect(findings.every(f => f.kind === "malformed_name")).toBe(true);
    expect(describeFinding(findings[0]!)).toContain("exactly four digits");
  });

  it("fails an occupied reserved slot", () => {
    const findings = auditMigrationSlots(["0016_spatial_something.sql"]);
    expect(findings).toEqual([
      { kind: "reserved_slot", slot: "0016", file: "0016_spatial_something.sql" },
    ]);
  });

  it("accepts a correctly allocated next migration", () => {
    // The slot after the real head, whatever it is today — so this case does not need moving each checkpoint.
    const next = String(Number(headSlot(files)) + 1).padStart(4, "0");
    expect(auditMigrationSlots([...files, `${next}_the_next_one.sql`])).toEqual([]);
    expect(headSlot([...files, `${next}_the_next_one.sql`])).toBe(next);
  });

  it("gives every tolerated duplicate a reason that says something", () => {
    for (const [slot, reason] of Object.entries(KNOWN_DUPLICATE_SLOTS)) {
      expect(reason.length, slot).toBeGreaterThan(40);
    }
  });
});
