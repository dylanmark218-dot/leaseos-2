/**
 * B23.1A — migration slot hygiene, as a function rather than a habit.
 *
 * `scripts/apply-migrations.sh` applies `drizzle/*.sql` in `sort` order and
 * `drizzle/meta/_journal.json` has been abandoned since 0018, so the FILENAME
 * is the entire migration registry. That makes the four-digit slot load-bearing
 * in a way nothing in the tree says out loud, and it has already failed:
 *
 *   0157  two unrelated migrations on THIS branch
 *   0168  two different migrations across lineages
 *   0169  two different migrations across lineages
 *
 * Two files in one slot is not cosmetic. Their order is then decided by the
 * rest of the filename, so a merge can silently reorder DDL that depends on the
 * statement before it — and the table-parity gate still passes, because the
 * count is unchanged.
 *
 * Pure, so the guard can be tested against a synthetic tree rather than only
 * against the real one. A rule that can only be checked by breaking the
 * repository is a rule nobody checks.
 */

/** A migration filename that the runner will apply. */
export const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export type SlotFinding =
  | { kind: "duplicate_slot"; slot: string; files: string[] }
  | { kind: "malformed_name"; file: string; reason: string }
  | { kind: "reserved_slot"; slot: string; file: string };

/**
 * Slots that must stay empty.
 *
 * 0016 and 0017 are held for the Spatial and LoadSense branches; gate 0 of
 * `ci-gate.sh` checks the same thing from the shell, and this keeps the two
 * statements of it from drifting.
 */
export const RESERVED_SLOTS = ["0016", "0017"] as const;

/**
 * Duplicates this tree inherited and cannot fix.
 *
 * Renaming an applied migration changes nothing in a database that has already
 * run it — it only makes the tree disagree with every deployed database about
 * what has been applied. So the debt is recorded rather than repaired, and the
 * allowlist is the mechanism that keeps it from growing: a duplicate that is
 * not named here fails.
 */
export const KNOWN_DUPLICATE_SLOTS: Readonly<Record<string, string>> = {
  "0157":
    "inherited from a divergent lineage; both halves are applied in deployed databases, and renaming an applied migration only makes the tree disagree with them",
};

/**
 * Everything wrong with a set of migration filenames.
 *
 * Returns findings rather than throwing, so a caller can report all of them at
 * once — being told about one collision, fixing it, and then being told about
 * the next is how a guard becomes something people route around.
 */
export function auditMigrationSlots(files: readonly string[]): SlotFinding[] {
  const findings: SlotFinding[] = [];
  const bySlot = new Map<string, string[]>();

  for (const file of files) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) {
      findings.push({
        kind: "malformed_name",
        file,
        // Named precisely: the runner sorts lexicographically, so a name that
        // does not start with exactly four digits sorts somewhere nobody
        // intended and applies out of order.
        reason: /^\d{4}_/.test(file)
          ? "description must be lower-case letters, digits and underscores, ending .sql"
          : "must begin with exactly four digits and an underscore",
      });
      continue;
    }
    const slot = m[1]!;
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), file]);
  }

  // `Array.from` rather than iterating the Map directly: this tsconfig targets
  // a level where Map iteration needs downlevelIteration, and turning that on
  // for one loop is not the trade.
  for (const [slot, slotFiles] of Array.from(bySlot.entries())) {
    if ((RESERVED_SLOTS as readonly string[]).includes(slot)) {
      for (const file of slotFiles) findings.push({ kind: "reserved_slot", slot, file });
    }
    if (slotFiles.length > 1 && !KNOWN_DUPLICATE_SLOTS[slot]) {
      findings.push({ kind: "duplicate_slot", slot, files: [...slotFiles].sort() });
    }
  }

  return findings;
}

/** The highest slot in use, or null for an empty tree. */
export function headSlot(files: readonly string[]): string | null {
  const slots = files
    .map(f => MIGRATION_FILE.exec(f)?.[1])
    .filter((s): s is string => Boolean(s))
    .sort();
  return slots[slots.length - 1] ?? null;
}

/** A finding, in the words an operator reading a failed gate needs. */
export function describeFinding(f: SlotFinding): string {
  switch (f.kind) {
    case "duplicate_slot":
      return `slot ${f.slot} is used by ${f.files.join(" and ")} — allocate the next free slot instead of reusing one. See LEASEOS_MIGRATION_POLICY.md.`;
    case "malformed_name":
      return `"${f.file}" is not a migration filename the runner can order: ${f.reason}`;
    case "reserved_slot":
      return `slot ${f.slot} is reserved and must stay empty, but "${f.file}" occupies it`;
  }
}
