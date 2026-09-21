/**
 * B23.1 — migration slot hygiene.
 *
 * `scripts/apply-migrations.sh` applies `drizzle/*.sql` in `sort` order, and
 * `drizzle/meta/_journal.json` has been abandoned since 0018, so the FILENAME
 * is the whole registry. That makes the slot number load-bearing, and it has
 * already failed: slot 0157 carries two unrelated migrations on this branch
 * (`0157_seal_verification_unavailable.sql` and
 * `0157_signature_device_attestation.sql`), and across the repository's other
 * lineages 0168 and 0169 each carry two different migrations again
 * (`0168_retire_storage_capability_urls` vs `0168_movement_permits`;
 * `0169_defect_resolution` vs `0169_print_audit`).
 *
 * Two files sharing a slot is not cosmetic. Their relative order is decided by
 * the rest of the filename, so a merge can silently reorder DDL that depends
 * on the previous statement — and nothing in the gate notices, because the
 * count still adds up.
 *
 * This test does not try to repair history. It pins the one duplicate that
 * exists here, so a NEW one fails the gate and has to be resolved on purpose.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = readdirSync("drizzle")
  .filter(f => /^\d{4}_.*\.sql$/.test(f))
  .sort();

const slotOf = (f: string) => f.slice(0, 4);

/**
 * The duplicate this branch inherited, and why it is tolerated rather than
 * fixed: renaming an applied migration changes nothing in a database that has
 * already run it, and would only make the deployed state and the tree disagree.
 */
const KNOWN_DUPLICATE_SLOTS: Record<string, string> = {
  "0157": "inherited from a divergent lineage; both are applied, and renaming an applied migration only makes the tree disagree with deployed databases",
};

describe("migration slots", () => {
  it("allocates each slot once, except the duplicate this branch inherited", () => {
    const bySlot = new Map<string, string[]>();
    for (const f of files) {
      const slot = slotOf(f);
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), f]);
    }
    const duplicates = [...bySlot.entries()].filter(([, fs]) => fs.length > 1);
    for (const [slot, fs] of duplicates) {
      expect(
        KNOWN_DUPLICATE_SLOTS[slot],
        `slot ${slot} is used by ${fs.join(" and ")} — allocate the next free slot instead of reusing one`
      ).toBeTruthy();
    }
    // The pin itself: a new duplicate raises this count and fails here.
    expect(duplicates.map(([slot]) => slot)).toEqual(Object.keys(KNOWN_DUPLICATE_SLOTS));
  });

  it("gives every tolerated duplicate a reason that says something", () => {
    for (const [slot, reason] of Object.entries(KNOWN_DUPLICATE_SLOTS)) {
      expect(reason.length, slot).toBeGreaterThan(40);
    }
  });

  it("numbers B23.1 above every slot in use anywhere in this repository", () => {
    // 0169 was the number the B23.0 report suggested and is NOT free: two
    // other lineages each carry a different migration under it. 0170 is the
    // first slot free in all of them.
    expect(files).toContain("0170_organization_scoped_role_grants.sql");
    expect(files.filter(f => slotOf(f) === "0169")).toEqual([]);
    expect(slotOf(files[files.length - 1]!)).toBe("0170");
  });

  it("keeps 0016 and 0017 reserved, as gate 0 requires", () => {
    expect(files.filter(f => ["0016", "0017"].includes(slotOf(f)))).toEqual([]);
  });
});
