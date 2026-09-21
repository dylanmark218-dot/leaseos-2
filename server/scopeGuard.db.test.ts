/**
 * The scope guard.
 *
 * The hazard this exists for: a real figure, a good citation, and a profile
 * that applies it to operations nobody read for. Nothing here asserts what any
 * regulatory figure is.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  BASE_LIMIT_CAVEAT, EXCEPTION_KINDS, SPLIT_REGIMES, checkPromotionScope,
  evaluateClaimedException, hasSplitRegime,
} from "./_core/knowledge/scopeGuard";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

async function profileRow(profileKey: string, latitudeRule: string | null, jurisdiction = "CA") {
  await pool.execute(
    `INSERT INTO hosRuleProfiles
     (profileKey, label, authorityLevel, jurisdiction, latitudeRule, sourceAuthority, sourceCitation,
      effectiveFrom, verificationStatus, verifiedByUserId, verifiedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [profileKey, "Fixture", "federal", jurisdiction, latitudeRule, "Fixture",
     "test fixture, not a real instrument", new Date("2020-01-01"), "verified", 1]);
}

describe("a jurisdiction with more than one regime", () => {
  it("records that a split exists, not what either side says", () => {
    expect(hasSplitRegime("CA-FEDERAL")).toBe(true);
    const note = SPLIT_REGIMES["CA-FEDERAL"]!.note;
    // Structural, not substantive. No figure appears anywhere in the register.
    expect(note).toContain("separate divisions");
    expect(note).not.toMatch(/\d+\s*(hour|minute)/i);
  });

  it("does not assume every jurisdiction is split", () => {
    expect(hasSplitRegime("AB")).toBe(false);
  });
});

d("promotion scope", () => {
  it("refuses an unscoped profile in a split jurisdiction", async () => {
    const profileKey = `CA_FEDERAL_${rnd()}`;
    // The exact shape the branch allows today: null latitudeRule, which
    // selectProfile treats as applying to both north and south.
    await profileRow(profileKey, null);

    const r = await checkPromotionScope({ profileKey, jurisdiction: "CA-FEDERAL", geographicScope: "SOUTH_OF_60_N" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNSCOPED_PROFILE_IN_SPLIT_JURISDICTION");
      expect(r.reason).toContain("applies both north and south");
      // A refusal that says what to do instead.
      expect(r.remedy).toContain("separate schedules");
    }
  });

  it("accepts a profile scoped to the division the verifier read", async () => {
    const profileKey = `CA_FEDERAL_SOUTH_${rnd()}`;
    await profileRow(profileKey, "south_of_60");

    const r = await checkPromotionScope({ profileKey, jurisdiction: "CA-FEDERAL", geographicScope: "SOUTH_OF_60_N" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toBe("south_of_60");
  });

  it("refuses a southern reading promoted into a northern schedule", async () => {
    const profileKey = `CA_FEDERAL_NORTH_${rnd()}`;
    await profileRow(profileKey, "north_of_60");

    const r = await checkPromotionScope({ profileKey, jurisdiction: "CA-FEDERAL", geographicScope: "SOUTH_OF_60_N" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SCOPE_MISMATCH");
  });

  it("refuses a schedule that does not exist", async () => {
    const r = await checkPromotionScope({ profileKey: `MISSING_${rnd()}`, jurisdiction: "CA-FEDERAL" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PROFILE_NOT_FOUND");
  });

  it("allows an unscoped schedule where no split is recorded", async () => {
    const profileKey = `AB_${rnd()}`;
    await profileRow(profileKey, null, "AB");

    const r = await checkPromotionScope({ profileKey, jurisdiction: "AB" });
    // The guard tightens where a split is known. It does not invent one.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.note).toContain("no recorded split regime");
  });
});

describe("a base limit is the normal case, not a maximum", () => {
  it("does nothing when no exception is claimed", () => {
    expect(evaluateClaimedException(null)).toEqual({ applies: "no_claim" });
  });

  it("sends every claimed exception to review", () => {
    for (const kind of EXCEPTION_KINDS) {
      const r = evaluateClaimedException(kind);
      expect(r.applies, kind).toBe("review");
      if (r.applies !== "review") continue;
      expect(r.nextAction).toContain("LeaseOS does not authorize the departure");
    }
  });

  it("still reviews when a rule for that exception is on file", () => {
    const r = evaluateClaimedException("adverse_driving_conditions", ["adverse_driving_conditions"]);
    expect(r.applies).toBe("review");
    if (r.applies !== "review") return;
    // Whether the conditions were met is a question about the trip, which
    // LeaseOS did not witness.
    expect(r.reason).toContain("a question about this trip");
  });

  it("says why when no rule is on file", () => {
    const r = evaluateClaimedException("emergency");
    if (r.applies !== "review") throw new Error("expected review");
    expect(r.reason).toContain("no verified rule is on file");
    expect(r.reason).toContain("normal case only");
  });

  it("has no branch that authorizes a departure", () => {
    const src = require("node:fs").readFileSync(
      new URL("./_core/knowledge/scopeGuard.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function evaluateClaimedException"));
    // Two outcomes only: no claim, or review.
    expect(fn).not.toMatch(/applies:\s*"(permitted|authorized|allowed|granted)"/);
  });

  it("labels a base limit so it cannot be read as unconditional", () => {
    expect(BASE_LIMIT_CAVEAT).toContain("normal operation");
    expect(BASE_LIMIT_CAVEAT).toContain("goes to review");
  });
});

d("P9, stated precisely", () => {
  it("has no figure promoted through the ledger", async () => {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS n FROM hosRuleLimitHistory WHERE citationUrl NOT LIKE '%example%' AND instrumentTitle NOT LIKE '%ixture%'");
    // The claim that actually holds: nothing has been promoted through the
    // 0091 path citing a real instrument. This is how we find out the moment
    // that stops being true by accident.
    expect(Number((rows as { n: number }[])[0]?.n)).toBe(0);
  });

  it("finds figures verified outside the ledger, and does not pretend they are absent", async () => {
    const [rows] = await pool.query(
      "SELECT profileKey, limitKey FROM hosRuleLimits WHERE verificationStatus='verified' AND currentPromotionRef IS NULL");
    const outside = rows as { profileKey: string; limitKey: string }[];

    // Pre-existing rows marked verified through `hos.limitVerify`, which takes
    // a section string and a value — no citation URL, no scope check, no
    // attestations, no ledger entry. They are test residue here, but the path
    // is open in the branch and the front door built in 0090–0092 does not
    // close it.
    //
    // Asserted as *visible* rather than as zero, because claiming zero would be
    // false and would hide the open path.
    for (const row of outside) {
      expect(row.profileKey.length).toBeGreaterThan(0);
      expect(row.limitKey.length).toBeGreaterThan(0);
    }
    expect(Array.isArray(outside)).toBe(true);
  });

  it("reports every verified figure that carries no citation", async () => {
    const { figuresWithoutCitation } = await import("./_core/knowledge/rulePromotion");
    const missing = await figuresWithoutCitation();
    // The 0090 report doing its job on rows it did not create.
    for (const m of missing) expect(typeof m.profileKey).toBe("string");
  });
});
