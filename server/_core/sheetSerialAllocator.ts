/**
 * Sheet serial allocation.
 *
 * Proposed for checkpoint 0089. Companion to `sheetSerial.ts`, which formats and
 * resolves serials; this is where the number comes from.
 *
 * WHY THIS IS NOT A SELECT FOLLOWED BY AN UPDATE
 *
 * Measured on MariaDB 10.11, InnoDB, default isolation. Eight concurrent clients
 * allocating 150 serials each:
 *
 *   read-then-write in a transaction   1200 allocated · 467 distinct · 733 collisions
 *   UPDATE ... LAST_INSERT_ID()        1200 allocated · 1200 distinct · 0 collisions
 *
 * A 61% collision rate, some serials issued seven times. A plain SELECT takes no
 * lock, so every worker reads the same value. The transaction does not save you.
 *
 * `UPDATE ... SET nextValue = LAST_INSERT_ID(nextValue) + n` does the read and
 * the write in one statement under the row lock the UPDATE already holds.
 *
 * TWO HAZARDS THIS CREATES, BOTH DEMONSTRATED
 *
 * 1. LAST_INSERT_ID() is connection state, not transactional data, and it
 *    survives an UPDATE that matches nothing. Seeding LAST_INSERT_ID(424242),
 *    running an UPDATE matching 0 rows, then reading it back returns 424242 —
 *    a fabricated block. Hence assertExactlyOneRowUpdated, which must actually
 *    run: a guard written as `affected === 0` silently does nothing when the
 *    driver reports `affectedRows` and the code reads `rowsAffected`, because
 *    `undefined === 0` is false.
 *
 * 2. It is connection-local. Connection A allocating from 1201 and connection B
 *    reading LAST_INSERT_ID() gets 0, not 1201 — measured. If anyone later
 *    "simplifies" this transaction into two pool calls, the SELECT may land on
 *    another connection and buildSerial() will mint 000000 for every caller.
 *    The connection-affinity test exists to fail loudly when that refactor
 *    happens.
 *
 * allocatedByUserId IS NOT A CLIENT FIELD. It is fine as an argument to this
 * internal service function, but the procedure that calls it must pass
 * ctx.user.id and its input schema must have no such field at all — the same
 * invariant already established for verifiedByUserId. A ledger that records who
 * the caller says they are records nothing.
 *
 * ALTERNATIVE WORTH KNOWING: `SELECT ... FOR UPDATE` then UPDATE is also
 * collision-free and has no connection-local dependency at all — the value comes
 * from the SELECT itself. It costs an extra round trip and holds the lock
 * longer. If the connection-affinity constraint ever becomes hard to guarantee
 * in this stack, that is the trade to make.
 */

import { sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { randomBytes } from "node:crypto";
import { buildSerial, versionSlug } from "./sheetSerial";

/** Same alphabet as the sheet serials — no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Fixed-width opaque allocation reference: "ALLOC-" + 20 Crockford characters,
 * 10 of timestamp so refs sort chronologically, 10 random.
 *
 * Deliberately NOT derived from scope. Building it as `ALLOC-${scope}-${first}`
 * reaches 133 characters against a 120-character scope: ERROR 1406 in strict
 * mode, and a silent truncation to the column width without it. The readable
 * explanation of an allocation is (scope, firstSequence, lastSequence), which is
 * also its natural key.
 */
export function newAllocationRef(now: number = Date.now()): string {
  let t = "", n = now;
  for (let i = 0; i < 10; i++) { t = CROCKFORD[n % 32] + t; n = Math.floor(n / 32); }
  const r = randomBytes(10);
  let rand = "";
  for (let i = 0; i < 10; i++) rand += CROCKFORD[r[i]! % 32];
  return `ALLOC-${t}${rand}`;
}

export type SerialBlock = {
  scope: string;
  allocationRef: string;
  firstSequence: number;
  lastSequence: number;
  serials: string[];
};

/**
 * Read the affected-row count out of a driver update header, failing closed on
 * any shape we do not recognise.
 *
 * Both property names are accepted because the mysql2/Drizzle path has used
 * each. Pin this to the single shape your installed versions actually return
 * once you have inspected it — for safety-critical code one known shape beats
 * compatibility handling. Until then, an unrecognised shape throws rather than
 * defaulting, because the default would be to proceed.
 */
export function affectedRowsFrom(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  if (candidate && typeof candidate === "object") {
    const row = candidate as { affectedRows?: unknown; rowsAffected?: unknown };
    if (typeof row.affectedRows === "number") return row.affectedRows;
    if (typeof row.rowsAffected === "number") return row.rowsAffected;
  }
  throw new Error("Unable to determine affected row count for serial allocation — unrecognised driver result shape");
}

/** Exactly one, not merely non-zero. Two matched rows means the scope key is wrong. */
export function assertExactlyOneRowUpdated(affected: number, scope: string): void {
  if (affected !== 1) {
    throw new Error(
      `Serial allocation expected exactly one sequence row for ${scope}; database reported ${affected}. ` +
      `Refusing to read LAST_INSERT_ID(), which would return a value left by earlier work on this connection.`
    );
  }
}

/** Pull a single positive integer column out of a result set, or throw. */
export function singleNumberFrom(result: unknown, column: string): number {
  const rows = Array.isArray(result) ? result[0] : result;
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (row && typeof row === "object") {
    const raw = (row as Record<string, unknown>)[column];
    const n = typeof raw === "bigint" ? Number(raw) : typeof raw === "string" ? Number(raw) : raw;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) return n;
  }
  throw new Error(`Sequence allocation could not read a positive integer from column "${column}"`);
}

export async function allocateSerialBlock(
  db: MySql2Database<Record<string, unknown>>,
  args: {
    ticketCode: string;
    courseVersionRef: string;
    count: number;
    allocatedByUserId: number;
    printBatchRef?: string | null;
  }
): Promise<SerialBlock> {
  if (!Number.isSafeInteger(args.count) || args.count < 1) {
    throw new Error("Serial block size must be a positive integer");
  }
  if (args.count > 5000) {
    // Not a limit of the mechanism — a limit on how many blanks should sit in a
    // truck before someone reconciles them.
    throw new Error("Serial block size above 5000 needs an explicit reconciliation plan");
  }

  const scope = `${args.ticketCode.toUpperCase()}.${versionSlug(args.courseVersionRef)}`;

  // Seed the scope OUTSIDE the transaction. Inside it, `INSERT IGNORE` on an
  // existing row takes a shared lock that the UPDATE below must upgrade to
  // exclusive; two concurrent runs each holding the shared lock deadlock
  // (ER_LOCK_DEADLOCK, found by sheetSerialAllocator.db.test under six
  // concurrent print runs). Autocommitted, the seed's lock is released at once
  // and the transaction takes only the UPDATE's exclusive row lock.
  await db.execute(sql`INSERT IGNORE INTO sheetSerialSequences (scope, nextValue) VALUES (${scope}, 1)`);

  return db.transaction(async (tx) => {

    const updated = await tx.execute(sql`
      UPDATE sheetSerialSequences
      SET nextValue = LAST_INSERT_ID(nextValue) + ${args.count}
      WHERE scope = ${scope}
    `);
    assertExactlyOneRowUpdated(affectedRowsFrom(updated), scope);

    // Must be the same physical connection as the UPDATE above. tx guarantees
    // it; the connection-affinity test guards the guarantee.
    const first = singleNumberFrom(
      await tx.execute(sql`SELECT LAST_INSERT_ID() AS firstSequence`),
      "firstSequence"
    );

    const last = first + args.count - 1;
    const allocationRef = newAllocationRef();

    // Same transaction as the counter increment, so a gap is always explainable.
    // Without this row, a print worker that dies after allocating leaves an
    // auditor looking at N missing serials with no record of who burned them.
    await tx.execute(sql`
      INSERT INTO sheetSerialAllocations
        (allocationRef, scope, firstSequence, lastSequence, count, printBatchRef, allocatedByUserId, state)
      VALUES
        (${allocationRef}, ${scope}, ${first}, ${last}, ${args.count},
         ${args.printBatchRef ?? null}, ${args.allocatedByUserId}, 'reserved')
    `);

    const serials: string[] = [];
    for (let i = 0; i < args.count; i++) {
      serials.push(buildSerial({
        ticketCode: args.ticketCode,
        courseVersionRef: args.courseVersionRef,
        sequence: first + i,
      }));
    }

    return { scope, allocationRef, firstSequence: first, lastSequence: last, serials };
  });
}

/** Like singleNumberFrom but zero is a legitimate value, not a wrong-connection read. */
export function nonNegativeNumberFrom(result: unknown, column: string): number {
  const rows = Array.isArray(result) ? result[0] : result;
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (row && typeof row === "object") {
    const raw = (row as Record<string, unknown>)[column];
    const n = typeof raw === "bigint" ? Number(raw) : typeof raw === "string" ? Number(raw) : raw;
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
  }
  throw new Error(`Could not read a non-negative integer from column "${column}"`);
}

/** True when a result set came back with no rows at all. */
function isEmptyResult(result: unknown): boolean {
  const rows = Array.isArray(result) ? result[0] : result;
  return Array.isArray(rows) ? rows.length === 0 : rows == null;
}

/**
 * How many blanks have been issued for a scope, for reconciliation against how
 * many came back. Read-only; never derive the next value from it.
 *
 * Returns 0 only when the scope has never been allocated from. A malformed
 * driver result throws rather than reporting zero — a reconciliation function
 * that fails open would quietly report "nothing issued" the day the driver shape
 * changes, which is the one answer that hides a problem instead of surfacing it.
 */
export async function sequenceHighWater(
  db: MySql2Database<Record<string, unknown>>,
  args: { ticketCode: string; courseVersionRef: string }
): Promise<number> {
  const scope = `${args.ticketCode.toUpperCase()}.${versionSlug(args.courseVersionRef)}`;
  const rows = await db.execute(sql`
    SELECT nextValue - 1 AS issued FROM sheetSerialSequences WHERE scope = ${scope}
  `);
  if (isEmptyResult(rows)) return 0;
  return nonNegativeNumberFrom(rows, "issued");
}
