/**
 * Rule promotion — the only path from a person reading a regulation to a
 * figure the HOS engine will act on.
 *
 * Real database, real hosRuleLimits rows. The figures below are **test
 * fixtures**, not verified Canadian regulatory values: this proves the
 * mechanism, and only a person with the instrument open can establish a real
 * one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { checkPlausible, figuresWithoutCitation, promoteVerifiedLimit } from "./_core/knowledge/rulePromotion";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => `TEST-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
const NOW = new Date("2026-09-13T12:00:00Z");

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });

afterAll(async () => { await pool?.end(); });

const verification = (o: Partial<Parameters<typeof promoteVerifiedLimit>[0]> = {}) => ({
  profileKey: rnd(), limitKey: "daily_drive_minutes", value: 780,
  authorityLevel: "law" as const, sourceSection: "s. 12(1)",
  citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
  verifiedByUserId: 7, verifiedAt: NOW, ...o,
});

describe("plausibility catches the unit error, not the wrong figure", () => {
  it("accepts a figure inside the range", () => {
    expect(checkPlausible("daily_drive_minutes", 780).ok).toBe(true);
  });

  it("catches hours typed where minutes were meant", () => {
    // 13 hours entered as 13. The mistake a careful person makes late in a day.
    const r = checkPlausible("daily_drive_minutes", 13);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("check the units");
  });

  it("catches a transposition", () => {
    expect(checkPlausible("daily_drive_minutes", 7800).ok).toBe(false);
  });

  it("does not pretend to catch a wrong figure inside the range", () => {
    // 700 instead of 780 passes. Only a person reading the instrument catches
    // that, which is why a verifier is required and this is only a guard.
    expect(checkPlausible("daily_drive_minutes", 700).ok).toBe(true);
  });

  it("does not reject a limit it has no bounds for", () => {
    // LeaseOS does not get to decide a jurisdiction's limit does not exist.
    expect(checkPlausible("some_provincial_limit_we_have_not_seen", 42).ok).toBe(true);
  });

  it("rejects a value that is not a number", () => {
    expect(checkPlausible("daily_drive_minutes", Number.NaN).ok).toBe(false);
  });
});

d("the superseded path is closed", () => {
  it("refuses and names the ledger", async () => {
    await expect(promoteVerifiedLimit(verification())).rejects.toThrow(/promotionLedger|promote\(\)/);
  });

  it("says why, so a caller is not left guessing", async () => {
    // It wrote a verified figure with no promotion behind it. Six such rows
    // existed in the test database, all written from here.
    await expect(promoteVerifiedLimit(verification())).rejects.toThrow(/no promotion behind it/);
  });

  it("writes nothing", async () => {
    const profileKey = rnd();
    await promoteVerifiedLimit(verification({ profileKey })).catch(() => {});
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM hosRuleLimits WHERE profileKey = ?", [profileKey]);
    expect(Number((rows as { n: number }[])[0]?.n)).toBe(0);
  });

  it("still reports figures that carry no citation", async () => {
    const missing = await figuresWithoutCitation();
    for (const m of missing) expect(typeof m.profileKey).toBe("string");
  });
});
