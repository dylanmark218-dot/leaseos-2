/**
 * 0125 — the serial allocator against the real database.
 *
 * The allocator's whole reason to exist is that two print runs can never mint
 * the same number. So this runs them concurrently and counts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { allocateSerialBlock, sequenceHighWater } from "./_core/sheetSerialAllocator";
import { parseSerial } from "./_core/sheetSerial";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 6 }); });
afterAll(async () => { await pool?.end(); });
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

d("serial blocks under contention", () => {
  it("mints distinct, checksum-valid, contiguous serials across six concurrent print runs", async () => {
    const db = drizzle(pool);
    const courseVersionRef = `CV-FIX-${rnd()}`;
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      allocateSerialBlock(db, { ticketCode: "TDGA", courseVersionRef, count: 25, allocatedByUserId: 1, printBatchRef: `PB-${i}` })));
    const serials = runs.flatMap(r => r.serials);
    expect(serials).toHaveLength(150);
    expect(new Set(serials).size).toBe(150);                       // no collisions
    for (const s of serials) expect(parseSerial(s).ok).toBe(true); // every one checks out
    const sequences = serials.map(s => (parseSerial(s) as { sequence: number }).sequence).sort((a, b) => a - b);
    expect(sequences[0]).toBe(1);
    expect(sequences[149]).toBe(150);                              // contiguous, nothing skipped
    const high = await sequenceHighWater(db, { ticketCode: "TDGA", courseVersionRef });
    expect(high).toBe(150);
  });

  it("keeps practice and assessment sheets in separate sequences", async () => {
    const db = drizzle(pool);
    const courseVersionRef = `CV-FIX-${rnd()}`;
    const a = await allocateSerialBlock(db, { ticketCode: "TDGA", courseVersionRef, count: 3, allocatedByUserId: 1 });
    const p = await allocateSerialBlock(db, { ticketCode: "TDGP", courseVersionRef, count: 3, allocatedByUserId: 1 });
    expect((parseSerial(a.serials[0]!) as { sequence: number }).sequence).toBe(1);
    expect((parseSerial(p.serials[0]!) as { sequence: number }).sequence).toBe(1);
    expect(a.serials[0]).not.toBe(p.serials[0]);
  });
});
