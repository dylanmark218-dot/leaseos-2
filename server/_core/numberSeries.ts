/**
 * Document Control — controlled numbering (DC-C, 0180).
 *
 * The counter is `trackingSequences` and the discipline is the sheet-serial
 * allocator's: the period row is seeded with INSERT IGNORE outside the
 * transaction (an INSERT IGNORE inside takes a shared lock the UPDATE must
 * upgrade, and two concurrent callers deadlock), and inside it one
 * `UPDATE … SET nextNumber = LAST_INSERT_ID(nextNumber) + n` reads and writes
 * under the row lock, with LAST_INSERT_ID() carried back on the same
 * connection. Measured: 0 collisions across 1200 concurrent allocations.
 *
 * What this module adds is the LEDGER. `mintNumberInTx` runs inside the
 * caller's transaction and writes the `numberAllocations` row beside the
 * record it numbers, so a failed record insert rolls the counter back and
 * leaves no gap; a number reserved and never used, voided, damaged or lost
 * keeps its row and its reason. The unique index on (scope, series, branch,
 * period, sequence) is the database's own refusal to issue a number twice.
 *
 * `trackingReferences` (unique per number) is written only for the default scope — the global
 * series such as DOC. A business-scoped series has the same shape in every book, so the ledger
 * row and the register's (book, controlNumber) index are its index.
 *
 * Offline: `allocateDeviceBlock` cuts a contiguous range from the same counter
 * for one enrolled device; `consumeFromBlock` turns one of its numbers into a
 * ledger row when the capture reaches the server, idempotent on the device's
 * own reference; `retireBlock` explains every unissued number of a lost or
 * retired device and never lets one be reassigned. MAX(number)+1 appears
 * nowhere.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { randomBytes } from "node:crypto";
import { commercialNumberingPolicies, fieldDevices, numberAllocations, numberBlocks, trackingReferences, trackingSequences } from "../../drizzle/schema";
import { numberingPolicyFor } from "./commercialPolicy";
import { affectedRowsFrom, assertExactlyOneRowUpdated, singleNumberFrom } from "./sheetSerialAllocator";
import { DEFAULT_FORMAT, formatTrackingNumber, periodKeyFor, type SequenceFormat } from "./trackingNumbers";

type Db = MySql2Database<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

export const DEFAULT_SCOPE = "default";
export const SERIES_TYPE_PATTERN = /^[A-Z][A-Z0-9]{1,23}$/;
export const MAX_DEVICE_BLOCK = 1000;

export type SeriesKey = { orgRef: string | null; sequenceType: string; branch?: string | null };
export type MintActor = { userId: number | null; deviceRef?: string | null };

export class NumberSeriesRefusal extends Error {
  constructor(public readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED", message: string) { super(message); }
}
const refuse = (code: NumberSeriesRefusal["code"], msg: string): never => { throw new NumberSeriesRefusal(code, msg); };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Fixed-width opaque ref, chronological then random — the sheet-serial shape. */
export function newAllocationRef(prefix: "NUM" | "BLK", now: number = Date.now()): string {
  let t = "", n = now;
  for (let i = 0; i < 10; i++) { t = CROCKFORD[n % 32] + t; n = Math.floor(n / 32); }
  const r = randomBytes(8);
  let rand = "";
  for (let i = 0; i < 8; i++) rand += CROCKFORD[r[i]! % 32];
  return `${prefix}-${t}${rand}`;
}

export const scopeKeyOf = (orgRef: string | null | undefined) => orgRef ?? DEFAULT_SCOPE;

/**
 * The format a series is minted in: the business's own numbering policy when
 * it wrote one (`commercialOffice.numbering.set`), else the platform's default
 * for that series type, else prefix = series type with the standard shape.
 * Resolved once when the counter row is seeded and stored on it; the stored
 * row wins thereafter, because a number's shape must not change mid-period.
 */
export async function resolveFormat(db: DbOrTx, key: SeriesKey): Promise<SequenceFormat> {
  if (!SERIES_TYPE_PATTERN.test(key.sequenceType)) refuse("BAD_REQUEST", `"${key.sequenceType}" is not a series type`);
  const rows = await db.select().from(commercialNumberingPolicies).where(eq(commercialNumberingPolicies.sequenceType, key.sequenceType));
  const p = numberingPolicyFor(rows, key.orgRef, key.sequenceType);
  if (p) return { prefix: p.prefix, separator: p.separator, yearDigits: p.yearDigits as 0 | 2 | 4, includeMonth: p.includeMonth, sequenceDigits: p.sequenceDigits, resetPeriod: p.resetPeriod };
  return { prefix: key.sequenceType, ...DEFAULT_FORMAT };
}

/** Seed the counter row. Outside any transaction, on purpose (see the header). Idempotent. */
export async function ensureSeriesRow(db: Db, key: SeriesKey, at: Date = new Date()): Promise<{ scopeKey: string; branch: string; periodKey: string; format: SequenceFormat }> {
  const format = await resolveFormat(db, key);
  const scopeKey = scopeKeyOf(key.orgRef);
  const branch = key.branch ?? "";
  const periodKey = periodKeyFor(format.resetPeriod, at);
  await db.execute(sql`
    INSERT IGNORE INTO trackingSequences (orgRef, scopeKey, sequenceType, branch, periodKey, nextNumber, prefix, \`separator\`, yearDigits, includeMonth, sequenceDigits, resetPeriod)
    VALUES (${key.orgRef}, ${scopeKey}, ${key.sequenceType}, ${branch}, ${periodKey}, 1, ${format.prefix}, ${format.separator}, ${format.yearDigits}, ${format.includeMonth}, ${format.sequenceDigits}, ${format.resetPeriod})`);
  return { scopeKey, branch, periodKey, format };
}

async function bump(tx: Tx, scopeKey: string, key: SeriesKey, periodKey: string, n: number): Promise<{ first: number; format: SequenceFormat }> {
  const branch = key.branch ?? "";
  const updated = await tx.execute(sql`
    UPDATE trackingSequences SET nextNumber = LAST_INSERT_ID(nextNumber) + ${n}
    WHERE scopeKey = ${scopeKey} AND sequenceType = ${key.sequenceType} AND branch = ${branch} AND periodKey = ${periodKey}`);
  assertExactlyOneRowUpdated(affectedRowsFrom(updated), `${scopeKey}/${key.sequenceType}/${branch || "-"}/${periodKey}`);
  const first = singleNumberFrom(await tx.execute(sql`SELECT LAST_INSERT_ID() AS firstSequence`), "firstSequence");
  const [fmtRows] = await tx.execute(sql`
    SELECT prefix, \`separator\`, yearDigits, includeMonth, sequenceDigits, resetPeriod FROM trackingSequences
    WHERE scopeKey = ${scopeKey} AND sequenceType = ${key.sequenceType} AND branch = ${branch} AND periodKey = ${periodKey}`);
  const row = (fmtRows as unknown as Record<string, unknown>[])[0]!;
  const format: SequenceFormat = { prefix: String(row.prefix), separator: String(row.separator), yearDigits: Number(row.yearDigits) as 0 | 2 | 4, includeMonth: Boolean(Number(row.includeMonth)), sequenceDigits: Number(row.sequenceDigits), resetPeriod: String(row.resetPeriod) as SequenceFormat["resetPeriod"] };
  return { first, format };
}

export type Minted = { allocationRef: string; number: string; sequence: number; periodKey: string; scopeKey: string; replayed: boolean };

/**
 * Mint one number INSIDE the caller's transaction and write its ledger row as
 * `issued` against the record. The counter row must already exist
 * (`ensureSeriesRow` before the transaction). With an `idempotencyKey`, a retry
 * returns the number it minted the first time and mints nothing.
 */
export async function mintNumberInTx(tx: Tx, key: SeriesKey, args: { recordType: string; recordId: number | null; actor: MintActor; idempotencyKey?: string | null; at?: Date; format?: SequenceFormat; periodKey?: string }): Promise<Minted> {
  const scopeKey = scopeKeyOf(key.orgRef);
  const at = args.at ?? new Date();
  const branch = key.branch ?? "";
  if (args.idempotencyKey) {
    const prior = (await tx.select().from(numberAllocations).where(and(eq(numberAllocations.scopeKey, scopeKey), eq(numberAllocations.sequenceType, key.sequenceType), eq(numberAllocations.idempotencyKey, args.idempotencyKey))).limit(1))[0];
    if (prior) return { allocationRef: prior.allocationRef, number: prior.formattedNumber, sequence: prior.sequence, periodKey: prior.periodKey, scopeKey, replayed: true };
  }
  const format = args.format ?? await resolveFormat(tx, key);
  const periodKey = args.periodKey ?? periodKeyFor(format.resetPeriod, at);
  const { first, format: stored } = await bump(tx, scopeKey, key, periodKey, 1);
  const number = formatTrackingNumber(stored, at, first, key.branch ?? null);
  const allocationRef = newAllocationRef("NUM");
  await tx.insert(numberAllocations).values({ allocationRef, orgRef: key.orgRef, scopeKey, sequenceType: key.sequenceType, branch, periodKey, sequence: first, formattedNumber: number, state: "issued", recordType: args.recordType, recordId: args.recordId, idempotencyKey: args.idempotencyKey ?? null, reservedByUserId: args.actor.userId, issuedAt: at, deviceRef: args.actor.deviceRef ?? null });
  if (args.recordId != null && scopeKey === DEFAULT_SCOPE) await tx.insert(trackingReferences).values({ trackingNumber: number, entityType: args.recordType, entityId: args.recordId, issuedAt: at, issuedByUserId: args.actor.userId, deviceId: args.actor.deviceRef ?? null });
  return { allocationRef, number, sequence: first, periodKey, scopeKey, replayed: false };
}

/** Reserve a number now (its own transaction) to issue later — a draft that must show its number before it is committed. */
export async function reserveNumber(db: Db, key: SeriesKey, args: { actor: MintActor; idempotencyKey?: string | null; at?: Date }): Promise<Minted> {
  const seeded = await ensureSeriesRow(db, key, args.at);
  return db.transaction(async tx => {
    if (args.idempotencyKey) {
      const prior = (await tx.select().from(numberAllocations).where(and(eq(numberAllocations.scopeKey, seeded.scopeKey), eq(numberAllocations.sequenceType, key.sequenceType), eq(numberAllocations.idempotencyKey, args.idempotencyKey))).limit(1))[0];
      if (prior) return { allocationRef: prior.allocationRef, number: prior.formattedNumber, sequence: prior.sequence, periodKey: prior.periodKey, scopeKey: seeded.scopeKey, replayed: true };
    }
    const at = args.at ?? new Date();
    const { first, format } = await bump(tx, seeded.scopeKey, key, seeded.periodKey, 1);
    const number = formatTrackingNumber(format, at, first, key.branch ?? null);
    const allocationRef = newAllocationRef("NUM");
    await tx.insert(numberAllocations).values({ allocationRef, orgRef: key.orgRef, scopeKey: seeded.scopeKey, sequenceType: key.sequenceType, branch: seeded.branch, periodKey: seeded.periodKey, sequence: first, formattedNumber: number, state: "reserved", idempotencyKey: args.idempotencyKey ?? null, reservedByUserId: args.actor.userId, deviceRef: args.actor.deviceRef ?? null });
    return { allocationRef, number, sequence: first, periodKey: seeded.periodKey, scopeKey: seeded.scopeKey, replayed: false };
  });
}

/** Turn a reserved number into an issued one, against the record, inside the caller's transaction. */
export async function issueReserved(tx: Tx, args: { allocationRef: string; scopeKey: string; recordType: string; recordId: number | null; actor: MintActor; at?: Date }): Promise<Minted> {
  const row = (await tx.select().from(numberAllocations).where(eq(numberAllocations.allocationRef, args.allocationRef)).limit(1))[0];
  if (!row || row.scopeKey !== args.scopeKey) refuse("NOT_FOUND", `Reservation ${args.allocationRef} is not in this business's ledger`);
  if (row.state === "issued" && row.recordType === args.recordType && row.recordId === args.recordId) return { allocationRef: row.allocationRef, number: row.formattedNumber, sequence: row.sequence, periodKey: row.periodKey, scopeKey: row.scopeKey, replayed: true };
  if (row.state !== "reserved") refuse("PRECONDITION_FAILED", `Number ${row.formattedNumber} is ${row.state}; it cannot be issued`);
  const at = args.at ?? new Date();
  await tx.update(numberAllocations).set({ state: "issued", recordType: args.recordType, recordId: args.recordId, issuedAt: at }).where(eq(numberAllocations.id, row.id));
  if (args.recordId != null && row.scopeKey === DEFAULT_SCOPE) await tx.insert(trackingReferences).values({ trackingNumber: row.formattedNumber, entityType: args.recordType, entityId: args.recordId, issuedAt: at, issuedByUserId: args.actor.userId, deviceId: args.actor.deviceRef ?? null });
  return { allocationRef: row.allocationRef, number: row.formattedNumber, sequence: row.sequence, periodKey: row.periodKey, scopeKey: row.scopeKey, replayed: false };
}

export type VoidReason = "record_insert_failed" | "cancelled_before_issue" | "duplicate_issue" | "printed_and_spoiled" | "damaged_in_field" | "other";

/** A number that will not be used, or was used and is now void, keeps its row: the state changes, the sequence never returns to the pool. */
export async function voidNumber(db: DbOrTx, args: { scopeKey: string; allocationRef?: string; formattedNumber?: string; sequenceType?: string; reasonCode: VoidReason; reasonText: string; actor: MintActor; at?: Date }): Promise<{ allocationRef: string; number: string; state: "voided" | "damaged" }> {
  const row = args.allocationRef
    ? (await db.select().from(numberAllocations).where(eq(numberAllocations.allocationRef, args.allocationRef)).limit(1))[0]
    : (await db.select().from(numberAllocations).where(and(eq(numberAllocations.scopeKey, args.scopeKey), eq(numberAllocations.formattedNumber, args.formattedNumber ?? ""), ...(args.sequenceType ? [eq(numberAllocations.sequenceType, args.sequenceType)] : []))).limit(1))[0];
  if (!row || row.scopeKey !== args.scopeKey) refuse("NOT_FOUND", "That number is not in this business's ledger");
  if (row.state !== "reserved" && row.state !== "issued") refuse("PRECONDITION_FAILED", `Number ${row.formattedNumber} is already ${row.state}`);
  const state = args.reasonCode === "damaged_in_field" || args.reasonCode === "printed_and_spoiled" ? "damaged" : "voided";
  await db.update(numberAllocations).set({ state, reasonCode: args.reasonCode, reasonText: args.reasonText, closedByUserId: args.actor.userId, closedAt: args.at ?? new Date() }).where(eq(numberAllocations.id, row.id));
  return { allocationRef: row.allocationRef, number: row.formattedNumber, state };
}

export type DeviceBlock = { allocationRef: string; scopeKey: string; sequenceType: string; periodKey: string; firstSequence: number; lastSequence: number; count: number; numbers: string[]; deviceRef: string };

/**
 * Cut a contiguous range for an enrolled, active device to issue offline. The
 * range comes from the same row-locked counter, so it cannot overlap another
 * block or a server-minted number; the block row is written in the same
 * transaction as the bump, so an allocation that dies here is still a row.
 */
export async function allocateDeviceBlock(db: Db, key: SeriesKey, args: { count: number; deviceRef: string; allocatedByUserId: number; at?: Date }): Promise<DeviceBlock> {
  if (!Number.isSafeInteger(args.count) || args.count < 1) refuse("BAD_REQUEST", "A block holds at least one number");
  if (args.count > MAX_DEVICE_BLOCK) refuse("BAD_REQUEST", `A block of more than ${MAX_DEVICE_BLOCK} numbers needs a reconciliation plan, not a bigger block`);
  const dev = (await db.select({ id: fieldDevices.id, status: fieldDevices.status, orgRef: fieldDevices.orgRef }).from(fieldDevices).where(eq(fieldDevices.deviceRef, args.deviceRef)).limit(1))[0];
  if (!dev) refuse("NOT_FOUND", `Device ${args.deviceRef} is not enrolled`);
  if (dev.status !== "active") refuse("PRECONDITION_FAILED", `Device ${args.deviceRef} is ${dev.status}; only an active device receives a block`);
  if ((dev.orgRef ?? null) !== (key.orgRef ?? null) && !(dev.orgRef === null && key.orgRef === null)) refuse("NOT_FOUND", `Device ${args.deviceRef} is not enrolled to this business`);
  const seeded = await ensureSeriesRow(db, key, args.at);
  return db.transaction(async tx => {
    const at = args.at ?? new Date();
    const { first, format } = await bump(tx, seeded.scopeKey, key, seeded.periodKey, args.count);
    const last = first + args.count - 1;
    const allocationRef = newAllocationRef("BLK");
    await tx.insert(numberBlocks).values({ allocationRef, orgRef: key.orgRef, scopeKey: seeded.scopeKey, sequenceType: key.sequenceType, branch: seeded.branch, periodKey: seeded.periodKey, firstSequence: first, lastSequence: last, count: args.count, deviceRef: args.deviceRef, allocatedByUserId: args.allocatedByUserId });
    const numbers: string[] = [];
    for (let s = first; s <= last; s++) numbers.push(formatTrackingNumber(format, at, s, key.branch ?? null));
    return { allocationRef, scopeKey: seeded.scopeKey, sequenceType: key.sequenceType, periodKey: seeded.periodKey, firstSequence: first, lastSequence: last, count: args.count, numbers, deviceRef: args.deviceRef };
  });
}

/**
 * A device used one of its numbers offline; the capture has reached the
 * server. The block must be the device's own and active, the sequence inside
 * its range, and the number not yet consumed — the unique index refuses a
 * second consumption whatever the caller believed. Idempotent on the device's
 * capture reference.
 */
export async function consumeFromBlock(tx: Tx, args: { scopeKey: string; blockRef: string; sequence: number; deviceRef: string; recordType: string; recordId: number | null; idempotencyKey: string; actor: MintActor; at?: Date }): Promise<Minted> {
  const block = (await tx.select().from(numberBlocks).where(eq(numberBlocks.allocationRef, args.blockRef)).limit(1))[0];
  if (!block || block.scopeKey !== args.scopeKey) refuse("NOT_FOUND", `Block ${args.blockRef} is not in this business's ledger`);
  if (block.deviceRef !== args.deviceRef) refuse("PRECONDITION_FAILED", `Block ${args.blockRef} belongs to ${block.deviceRef}, not ${args.deviceRef}`);
  const prior = (await tx.select().from(numberAllocations).where(and(eq(numberAllocations.scopeKey, args.scopeKey), eq(numberAllocations.sequenceType, block.sequenceType), eq(numberAllocations.idempotencyKey, args.idempotencyKey))).limit(1))[0];
  if (prior) return { allocationRef: prior.allocationRef, number: prior.formattedNumber, sequence: prior.sequence, periodKey: prior.periodKey, scopeKey: args.scopeKey, replayed: true };
  if (block.state !== "active") refuse("PRECONDITION_FAILED", `Block ${args.blockRef} is ${block.state}; its numbers cannot be consumed`);
  if (args.sequence < block.firstSequence || args.sequence > block.lastSequence) refuse("PRECONDITION_FAILED", `Sequence ${args.sequence} is outside block ${args.blockRef} (${block.firstSequence}–${block.lastSequence})`);
  const format = await resolveFormat(tx, { orgRef: block.orgRef, sequenceType: block.sequenceType, branch: block.branch });
  const at = args.at ?? new Date();
  const number = formatTrackingNumber(format, at, args.sequence, block.branch || null);
  const allocationRef = newAllocationRef("NUM");
  try {
    await tx.insert(numberAllocations).values({ allocationRef, orgRef: block.orgRef, scopeKey: args.scopeKey, sequenceType: block.sequenceType, branch: block.branch, periodKey: block.periodKey, sequence: args.sequence, formattedNumber: number, blockId: block.id, deviceRef: args.deviceRef, state: "issued", recordType: args.recordType, recordId: args.recordId, idempotencyKey: args.idempotencyKey, reservedByUserId: args.actor.userId, issuedAt: at });
  } catch (e) {
    const text = `${String((e as Error).message)} ${String((e as { cause?: { message?: string } }).cause?.message ?? "")}`;
    if (/Duplicate entry/.test(text)) refuse("CONFLICT", `Number ${number} was already consumed from block ${args.blockRef}; the database refused a second issue`);
    throw e;
  }
  if (args.recordId != null && args.scopeKey === DEFAULT_SCOPE) await tx.insert(trackingReferences).values({ trackingNumber: number, entityType: args.recordType, entityId: args.recordId, issuedAt: at, issuedByUserId: args.actor.userId, deviceId: args.deviceRef });
  const used = (await tx.select({ n: sql<number>`COUNT(*)` }).from(numberAllocations).where(eq(numberAllocations.blockId, block.id)))[0]?.n ?? 0;
  if (Number(used) >= block.count) await tx.update(numberBlocks).set({ state: "exhausted" }).where(eq(numberBlocks.id, block.id));
  return { allocationRef, number, sequence: args.sequence, periodKey: block.periodKey, scopeKey: args.scopeKey, replayed: false };
}

/**
 * Retire a block: a lost tablet, a device taken out of service, blanks
 * returned. Every number in the range with no ledger row gets one that says
 * why it will never be issued. The counter does not move; nothing is reused.
 */
export async function retireBlock(db: Db, args: { scopeKey: string; blockRef: string; reasonCode: "device_lost" | "device_retired" | "damaged_in_field" | "other"; reasonText: string; actor: MintActor; at?: Date }): Promise<{ allocationRef: string; state: "retired" | "device_lost"; explained: number; alreadyIssued: number }> {
  return db.transaction(async tx => {
    const block = (await tx.select().from(numberBlocks).where(eq(numberBlocks.allocationRef, args.blockRef)).limit(1))[0];
    if (!block || block.scopeKey !== args.scopeKey) refuse("NOT_FOUND", `Block ${args.blockRef} is not in this business's ledger`);
    if (block.state === "retired" || block.state === "device_lost") return { allocationRef: block.allocationRef, state: block.state, explained: 0, alreadyIssued: 0 };
    const used = new Set((await tx.select({ sequence: numberAllocations.sequence }).from(numberAllocations).where(and(eq(numberAllocations.scopeKey, args.scopeKey), eq(numberAllocations.sequenceType, block.sequenceType), eq(numberAllocations.branch, block.branch), eq(numberAllocations.periodKey, block.periodKey), sql`${numberAllocations.sequence} BETWEEN ${block.firstSequence} AND ${block.lastSequence}`))).map(r => r.sequence));
    const format = await resolveFormat(tx, { orgRef: block.orgRef, sequenceType: block.sequenceType, branch: block.branch });
    const at = args.at ?? new Date();
    const state = args.reasonCode === "device_lost" ? "lost" : args.reasonCode === "damaged_in_field" ? "damaged" : "unused_retired";
    let explained = 0;
    for (let s = block.firstSequence; s <= block.lastSequence; s++) {
      if (used.has(s)) continue;
      await tx.insert(numberAllocations).values({ allocationRef: newAllocationRef("NUM"), orgRef: block.orgRef, scopeKey: args.scopeKey, sequenceType: block.sequenceType, branch: block.branch, periodKey: block.periodKey, sequence: s, formattedNumber: formatTrackingNumber(format, at, s, block.branch || null), blockId: block.id, deviceRef: block.deviceRef, state, reasonCode: args.reasonCode, reasonText: args.reasonText, closedByUserId: args.actor.userId, closedAt: at });
      explained++;
    }
    const blockState = args.reasonCode === "device_lost" ? "device_lost" : "retired";
    await tx.update(numberBlocks).set({ state: blockState, retiredByUserId: args.actor.userId, retiredAt: at, retireReason: args.reasonText }).where(eq(numberBlocks.id, block.id));
    return { allocationRef: block.allocationRef, state: blockState, explained, alreadyIssued: used.size };
  });
}

export type GapRow = { sequence: number; formattedNumber: string | null; state: string; recordType: string | null; recordId: number | null; deviceRef: string | null; blockRef: string | null; reasonCode: string | null; reasonText: string | null };

/**
 * Every sequence the counter has handed out for a series and period, with its
 * ledger state. A sequence with no row is `unexplained` — which, for a series
 * minted through this module, means a defect, and for a legacy series (FT,
 * INV, DSP, DOC before 0180) means a number the old path burned outside any
 * ledger.
 */
export async function gapReport(db: DbOrTx, key: SeriesKey, periodKey: string): Promise<{ scopeKey: string; sequenceType: string; periodKey: string; issued: number; unexplained: number; explained: number; heldByDevice: number; rows: GapRow[] }> {
  const scopeKey = scopeKeyOf(key.orgRef);
  const branch = key.branch ?? "";
  const counter = (await db.select({ nextNumber: trackingSequences.nextNumber }).from(trackingSequences).where(and(eq(trackingSequences.scopeKey, scopeKey), eq(trackingSequences.sequenceType, key.sequenceType), eq(trackingSequences.branch, branch), eq(trackingSequences.periodKey, periodKey))).limit(1))[0];
  const issuedUpTo = (counter?.nextNumber ?? 1) - 1;
  const rows = await db.select().from(numberAllocations).where(and(eq(numberAllocations.scopeKey, scopeKey), eq(numberAllocations.sequenceType, key.sequenceType), eq(numberAllocations.branch, branch), eq(numberAllocations.periodKey, periodKey))).orderBy(asc(numberAllocations.sequence));
  // A number inside a live block with no row yet is in a device's hands, not unexplained; once the block is retired every one of them has a row.
  const blocks = await db.select().from(numberBlocks).where(and(eq(numberBlocks.scopeKey, scopeKey), eq(numberBlocks.sequenceType, key.sequenceType), eq(numberBlocks.branch, branch), eq(numberBlocks.periodKey, periodKey)));
  const holder = (s: number) => blocks.find(b => (b.state === "active" || b.state === "exhausted") && s >= b.firstSequence && s <= b.lastSequence) ?? null;
  const byS = new Map(rows.map(r => [r.sequence, r]));
  const out: GapRow[] = [];
  let unexplained = 0, issued = 0, explained = 0, heldByDevice = 0;
  for (let s = 1; s <= issuedUpTo; s++) {
    const r = byS.get(s);
    if (!r) {
      const b = holder(s);
      if (b) { heldByDevice++; out.push({ sequence: s, formattedNumber: null, state: "held_by_device", recordType: null, recordId: null, deviceRef: b.deviceRef, blockRef: b.allocationRef, reasonCode: null, reasonText: null }); continue; }
      unexplained++; out.push({ sequence: s, formattedNumber: null, state: "unexplained", recordType: null, recordId: null, deviceRef: null, blockRef: null, reasonCode: null, reasonText: null }); continue;
    }
    if (r.state === "issued") issued++; else if (r.state !== "reserved") explained++;
    out.push({ sequence: s, formattedNumber: r.formattedNumber, state: r.state, recordType: r.recordType, recordId: r.recordId, deviceRef: r.deviceRef, blockRef: r.blockId ? blocks.find(b => b.id === r.blockId)?.allocationRef ?? null : null, reasonCode: r.reasonCode, reasonText: r.reasonText });
  }
  return { scopeKey, sequenceType: key.sequenceType, periodKey, issued, unexplained, explained, heldByDevice, rows: out };
}

/** The series a business has counters for, with what each has handed out. */
export async function listSeries(db: DbOrTx, orgRef: string | null) {
  const scopeKey = scopeKeyOf(orgRef);
  const counters = await db.select().from(trackingSequences).where(eq(trackingSequences.scopeKey, scopeKey)).orderBy(asc(trackingSequences.sequenceType), asc(trackingSequences.periodKey));
  const blocks = await db.select().from(numberBlocks).where(eq(numberBlocks.scopeKey, scopeKey));
  return counters.map(c => ({ sequenceType: c.sequenceType, branch: c.branch, periodKey: c.periodKey, handedOut: c.nextNumber - 1, format: { prefix: c.prefix, separator: c.separator, yearDigits: c.yearDigits, includeMonth: c.includeMonth, sequenceDigits: c.sequenceDigits, resetPeriod: c.resetPeriod }, activeBlocks: blocks.filter(b => b.sequenceType === c.sequenceType && b.periodKey === c.periodKey && b.state === "active").length }));
}
