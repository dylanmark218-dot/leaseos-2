/**
 * 0093B — one door to "verified".
 *
 * The defect this closes: `hos.limitVerify` reached
 * `verificationStatus: "verified"` from a section string and a number, with no
 * citation, no instrument, no scope check and no ledger row — and the engine
 * measures drivers against that column.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 160_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) =>
  appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function manager() {
  const orgRef = `ORG-${rnd()}`;
  const userId = seq++;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute(
    "INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())",
    [userId, "management"]);
  return userId;
}

d("the uncited door is closed", () => {
  it("refuses, and names its replacement rather than vanishing", async () => {
    const userId = await manager();
    await expect(callerFor(userId).hos.limitVerify({
      profileKey: "MB_PROVINCIAL", limitKey: "daily_drive_minutes", sourceSection: "s.12", confirmedValue: 780,
    })).rejects.toThrow(/hos\.limitPromote/);
  });

  it("says why it is closed, not merely that it is", async () => {
    const userId = await manager();
    // An existing caller gets an instruction, not a missing-procedure error.
    await expect(callerFor(userId).hos.limitVerify({
      profileKey: "MB_PROVINCIAL", limitKey: "daily_drive_minutes", sourceSection: "s.12", confirmedValue: 780,
    })).rejects.toThrow(/without a citation/);
  });

  it("writes nothing when called", async () => {
    const userId = await manager();
    const profileKey = `ONEDOOR_${rnd()}`;
    await pool.execute(
      `INSERT INTO hosRuleProfiles (profileKey, label, authorityLevel, jurisdiction, latitudeRule,
         sourceAuthority, sourceCitation, effectiveFrom, verificationStatus)
       VALUES (?,?,?,?,?,?,?,?, 'unverified')`,
      [profileKey, "Fixture", "provincial", "MB", null, "FIXTURE", "fixture", new Date("2020-01-01")]);
    await pool.execute(
      "INSERT INTO hosRuleLimits (profileKey, limitKey, value, verificationStatus) VALUES (?,?,?, 'unverified')",
      [profileKey, "daily_drive_minutes", 780]);

    await expect(callerFor(userId).hos.limitVerify({
      profileKey, limitKey: "daily_drive_minutes", sourceSection: "s.12", confirmedValue: 780,
    })).rejects.toThrow();

    const [rows] = await pool.query(
      "SELECT verificationStatus FROM hosRuleLimits WHERE profileKey = ?", [profileKey]);
    // Still a candidate. The refusal is not a partial write.
    expect((rows as { verificationStatus: string }[])[0]?.verificationStatus).toBe("unverified");
  });
});

d("the cited door reports what the old one did", () => {
  it("flags a verifier reading a different number than was seeded", async () => {
    const userId = await manager();
    const profileKey = `ONEDOOR_${rnd()}`;
    await pool.execute(
      `INSERT INTO hosRuleProfiles (profileKey, label, authorityLevel, jurisdiction, latitudeRule,
         sourceAuthority, sourceCitation, effectiveFrom, verificationStatus)
       VALUES (?,?,?,?,?,?,?,?, 'unverified')`,
      [profileKey, "Fixture", "provincial", "MB", null, "FIXTURE", "fixture", new Date("2020-01-01")]);
    await pool.execute(
      "INSERT INTO hosRuleLimits (profileKey, limitKey, value, verificationStatus) VALUES (?,?,?, 'unverified')",
      [profileKey, "core_rest_minutes", 480]);

    const r = await callerFor(userId).hos.limitPromote({
      profileKey, limitKey: "core_rest_minutes", value: 500, unit: "minutes",
      jurisdiction: "MB", geographicScope: "ALL", authorityType: "law",
      instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
      issuingAuthority: "FIXTURE — no issuing authority", sourceSection: "s.14",
      citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
      verificationMethod: "OFFICIAL_WEB",
      attestInstrumentOpen: true, attestPersonallyVerified: true, attestBindingAuthority: true,
    } as never) as { corrected: boolean; previousValue: number | null; value: number; promotionRef: string };

    // A correction is evidence. Silently accepting a changed figure loses it.
    expect(r.corrected).toBe(true);
    expect(r.previousValue).toBe(480);
    expect(r.value).toBe(500);
    expect(r.promotionRef).toMatch(/^HOS-PROM-/);
  });

  it("reports no correction when the figure matches", async () => {
    const userId = await manager();
    const profileKey = `ONEDOOR_${rnd()}`;
    await pool.execute(
      `INSERT INTO hosRuleProfiles (profileKey, label, authorityLevel, jurisdiction, latitudeRule,
         sourceAuthority, sourceCitation, effectiveFrom, verificationStatus)
       VALUES (?,?,?,?,?,?,?,?, 'unverified')`,
      [profileKey, "Fixture", "provincial", "MB", null, "FIXTURE", "fixture", new Date("2020-01-01")]);
    await pool.execute(
      "INSERT INTO hosRuleLimits (profileKey, limitKey, value, verificationStatus) VALUES (?,?,?, 'unverified')",
      [profileKey, "daily_drive_minutes", 780]);

    const r = await callerFor(userId).hos.limitPromote({
      profileKey, limitKey: "daily_drive_minutes", value: 780, unit: "minutes",
      jurisdiction: "MB", geographicScope: "ALL", authorityType: "law",
      instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
      issuingAuthority: "FIXTURE — no issuing authority", sourceSection: "s.12",
      citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
      verificationMethod: "OFFICIAL_WEB",
      attestInstrumentOpen: true, attestPersonallyVerified: true, attestBindingAuthority: true,
    } as never) as { corrected: boolean; previousValue: number | null };

    expect(r.corrected).toBe(false);
    expect(r.previousValue).toBeNull();
  });
});

d("every new verification is ledger-backed", () => {
  it("leaves a promotion behind for anything promoted in this run", async () => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM hosRuleLimits
        WHERE verificationStatus = 'verified' AND currentPromotionRef IS NULL
          AND citationUrl IS NOT NULL`);
    // A cited figure with no promotion would mean something wrote to the live
    // table outside the promotion path.
    expect(Number((rows as { n: number }[])[0]?.n)).toBe(0);
  });

  it("still reports figures verified before the door closed", async () => {
    const { figuresWithoutCitation } = await import("./_core/knowledge/rulePromotion");
    const legacy = await figuresWithoutCitation();
    // Grandfathered, not hidden. Re-verifying them is separate work, and not
    // work to do by script.
    for (const f of legacy) expect(typeof f.profileKey).toBe("string");
  });
});
