/**
 * SPINE item 2 — the booking-conflict rule, as SQL and as a function, selects the same bookings.
 *
 * The award's final revalidation and open-shift eligibility both ask `conflictingBookingsWhere`; the
 * open-shift engine re-checks a window with `windowsOverlap`. If the query and the function ever
 * disagreed, the two paths would again answer "is this resource booked?" differently — the
 * duplication this module exists to end. So every combination below is written to the real table
 * and both forms must select exactly the same rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { inArray } from "drizzle-orm";
import { getDb } from "./db";
import { resourceBookings } from "../drizzle/schema";
import {
  ACTIVE_BOOKING_STATES, bookingConflicts, bookingHoldsResource, conflictingBookingsWhere, windowsOverlap,
} from "./_core/bookingConflict";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

const T0 = Date.UTC(2031, 2, 3, 12, 0, 0);
const h = (n: number) => new Date(T0 + n * 3_600_000);
const WINDOW = { startsAt: h(0), endsAt: h(4) };

describe("the rule", () => {
  it("is half-open: touching windows do not conflict", () => {
    expect(windowsOverlap({ startsAt: h(-2), endsAt: h(0) }, WINDOW)).toBe(false);
    expect(windowsOverlap({ startsAt: h(4), endsAt: h(6) }, WINDOW)).toBe(false);
    expect(windowsOverlap({ startsAt: h(-1), endsAt: h(1) }, WINDOW)).toBe(true);
    expect(windowsOverlap({ startsAt: h(1), endsAt: h(2) }, WINDOW)).toBe(true);
  });

  it("only tentative and confirmed bookings hold a resource", () => {
    expect([...ACTIVE_BOOKING_STATES]).toEqual(["tentative", "confirmed"]);
    expect(["tentative", "confirmed", "released", "cancelled"].map(bookingHoldsResource)).toEqual([true, true, false, false]);
  });

  it("identifies a resource by type and ref: operator 5 is not unit 5", () => {
    const b = { resourceType: "unit", resourceRef: "5", bookingState: "confirmed", startsAt: h(1), endsAt: h(2) };
    expect(bookingConflicts(b, { type: "unit", ref: "5" }, WINDOW)).toBe(true);
    expect(bookingConflicts(b, { type: "operator", ref: "5" }, WINDOW)).toBe(false);
  });
});

d("the query and the function select the same bookings", () => {
  it("over every state, window and resource combination", async () => {
    const ref = `R${Math.random().toString(36).slice(2, 10)}`;
    const windows = [[-3, -1], [-2, 0], [-1, 1], [0, 4], [1, 2], [3, 5], [4, 6], [-5, 9]] as const;
    const rows: { resourceType: "operator" | "unit"; resourceRef: string; bookingState: "tentative" | "confirmed" | "released" | "cancelled"; startsAt: Date; endsAt: Date }[] = [];
    for (const type of ["operator", "unit"] as const)
      for (const state of ["tentative", "confirmed", "released", "cancelled"] as const)
        for (const [a, b] of windows) rows.push({ resourceType: type, resourceRef: ref, bookingState: state, startsAt: h(a), endsAt: h(b) });
    const ids: number[] = [];
    for (const r of rows) {
      const [res] = await pool.execute<mysql.ResultSetHeader>(
        "INSERT INTO resourceBookings (resourceType, resourceRef, startsAt, endsAt, bookingState) VALUES (?,?,?,?,?)",
        [r.resourceType, r.resourceRef, r.startsAt, r.endsAt, r.bookingState]);
      ids.push(res.insertId);
    }
    const db = (await getDb())!;
    for (const type of ["operator", "unit"] as const) {
      const bySql = (await db.select({ id: resourceBookings.id }).from(resourceBookings)
        .where(conflictingBookingsWhere({ type, ref }, WINDOW))).map(r => r.id).sort((x, y) => x - y);
      const all = await db.select().from(resourceBookings).where(inArray(resourceBookings.id, ids));
      const byFunction = all.filter(b => bookingConflicts(b, { type, ref }, WINDOW)).map(b => b.id).sort((x, y) => x - y);
      expect(bySql).toEqual(byFunction);
      // 2 holding states × the 5 windows that overlap [0, 4): (-1,1), (0,4), (1,2), (3,5), (-5,9).
      expect(bySql).toHaveLength(10);
    }
  }, 30_000);
});
