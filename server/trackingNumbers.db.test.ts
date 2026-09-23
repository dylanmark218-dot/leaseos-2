/**
 * Tracking numbers: configured format, transactional sequence, tested under
 * contention (project rule §18). Every sequence type here is a fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { formatTrackingNumber, nextTrackingNumber, periodKeyFor, DEFAULT_FORMAT } from "./_core/trackingNumbers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 6 }); });
afterAll(async () => { await pool?.end(); });
const rnd = () => Math.random().toString(36).slice(2, 6).toUpperCase();

describe("format is configuration", () => {
  const at = new Date("2026-09-17T03:00:00Z");
  it("renders year, month and width from the format, not from code", () => {
    expect(formatTrackingNumber({ prefix: "FT", ...DEFAULT_FORMAT }, at, 42)).toBe("FT-2026-000042");
    expect(formatTrackingNumber({ prefix: "INV", separator: "/", yearDigits: 2, includeMonth: true, sequenceDigits: 4, resetPeriod: "monthly" }, at, 7)).toBe("INV/2609/0007");
    expect(formatTrackingNumber({ prefix: "WO", separator: "-", yearDigits: 0, includeMonth: false, sequenceDigits: 5, resetPeriod: "never" }, at, 99)).toBe("WO-00099");
    expect(formatTrackingNumber({ prefix: "FT", ...DEFAULT_FORMAT }, at, 1, "EDM")).toBe("FT-EDM-2026-000001");
  });
  it("keys the counter by its reset period", () => {
    expect(periodKeyFor("yearly", at)).toBe("2026");
    expect(periodKeyFor("monthly", at)).toBe("2026-09");
    expect(periodKeyFor("never", at)).toBe("ALL");
  });
});

d("the sequence under contention", () => {
  it("mints 150 distinct, contiguous numbers across six concurrent callers", async () => {
    const db = drizzle(pool);
    const sequenceType = `TF${rnd()}`;
    const runs = await Promise.all(Array.from({ length: 6 }, () => Promise.all(Array.from({ length: 25 }, () => nextTrackingNumber(db, { sequenceType, orgRef: null, orgRef: null })))));
    const all = runs.flat();
    expect(new Set(all.map(a => a.trackingNumber)).size).toBe(150);
    const seqs = all.map(a => a.sequence).sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    expect(seqs[149]).toBe(150);
    expect(all[0]!.trackingNumber).toMatch(new RegExp(`^${sequenceType}-\\d{4}-\\d{6}$`));
  }, 30_000);

  it("restarts at 1 in a new period and keeps branches apart", async () => {
    const db = drizzle(pool);
    const sequenceType = `TP${rnd()}`;
    const a = await nextTrackingNumber(db, { sequenceType, orgRef: null, at: new Date("2025-12-31T23:59:00Z") });
    const b = await nextTrackingNumber(db, { sequenceType, orgRef: null, at: new Date("2026-01-01T00:01:00Z") });
    expect(a.sequence).toBe(1); expect(a.periodKey).toBe("2025");
    expect(b.sequence).toBe(1); expect(b.periodKey).toBe("2026");
    const edm = await nextTrackingNumber(db, { sequenceType, orgRef: null, branch: "EDM", at: new Date("2026-01-01T00:01:00Z") });
    expect(edm.sequence).toBe(1);
    expect(edm.trackingNumber).toBe(`${sequenceType}-EDM-2026-000001`);
  });

  it("uses the stored format once one exists — a later caller cannot change it in passing", async () => {
    const db = drizzle(pool);
    const sequenceType = `TS${rnd()}`;
    const first = await nextTrackingNumber(db, { sequenceType, orgRef: null, format: { separator: "/", sequenceDigits: 3 }, at: new Date("2026-09-17T00:00:00Z") });
    expect(first.trackingNumber).toBe(`${sequenceType}/2026/001`);
    const second = await nextTrackingNumber(db, { sequenceType, orgRef: null, format: { separator: "-", sequenceDigits: 8 }, at: new Date("2026-09-17T00:00:00Z") });
    expect(second.trackingNumber).toBe(`${sequenceType}/2026/002`);
  });
});
