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

  it("numbers B23.1 above every slot in use in any lineage of this repository", () => {
    // 0169 — the slot the B23.0 report suggested — is occupied by two different
    // migrations in other lineages (`0169_defect_resolution` in three,
    // `0169_print_audit` in a fourth). 0170 was the first free everywhere.
    expect(files).toContain("0170_organization_scoped_role_grants.sql");
    expect(files.filter(f => f.startsWith("0169_"))).toEqual([]);
    expect(headSlot(files)).toBe("0170");
  });

  it("keeps the reserved slots empty", () => {
    for (const slot of RESERVED_SLOTS) {
      expect(files.filter(f => f.startsWith(`${slot}_`)), slot).toEqual([]);
    }
  });
});

describe("the guard catches what it exists to catch", () => {
  it("fails a NEW duplicate, even one next to the tolerated old one", () => {
    const withNewCollision = [...files, "0170_something_else_entirely.sql"];
    const findings = auditMigrationSlots(withNewCollision);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "duplicate_slot", slot: "0170" });
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
    expect(auditMigrationSlots([...files, "0171_the_next_one.sql"])).toEqual([]);
    expect(headSlot([...files, "0171_the_next_one.sql"])).toBe("0171");
  });

  it("gives every tolerated duplicate a reason that says something", () => {
    for (const [slot, reason] of Object.entries(KNOWN_DUPLICATE_SLOTS)) {
      expect(reason.length, slot).toBeGreaterThan(40);
    }
  });
});
