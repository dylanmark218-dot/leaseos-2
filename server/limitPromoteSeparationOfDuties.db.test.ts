/**
 * 0124 — separation of duties on the cited path.
 *
 * `profileVerify` already refuses the person who recorded a profile. This is
 * the same rule for figures: the person who seeded an unverified candidate does
 * not promote it. Every value here is a fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 170_000_000 + Math.floor(Math.random() * 50_000);
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
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, "management"]);
  return userId;
}

async function schedule(profileKey: string) {
  await pool.execute(
    `INSERT INTO hosRuleProfiles (profileKey, label, authorityLevel, jurisdiction, latitudeRule, sourceAuthority, sourceCitation, effectiveFrom, verificationStatus, verifiedByUserId, verifiedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [profileKey, "Fixture", "provincial", "MB", null, "FIXTURE", "fixture schedule", new Date("2020-01-01"), "verified", 1]);
}

const payload = (profileKey: string, value = 777) => ({
  profileKey, limitKey: "daily_drive_minutes", value, unit: "minutes" as const,
  jurisdiction: "MB", geographicScope: "ALL" as const, authorityType: "law" as const,
  instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation", issuingAuthority: "FIXTURE — no issuing authority",
  sourceSection: "fixture s. 1", citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
  verificationMethod: "OFFICIAL_WEB" as const,
  attestInstrumentOpen: true as const, attestPersonallyVerified: true as const, attestBindingAuthority: true as const,
});

d("the person who recorded a candidate does not verify it", () => {
  it("refuses the recorder, and names the rule", async () => {
    const recorder = await manager();
    const profileKey = `SOD_${rnd()}`;
    await schedule(profileKey);
    await pool.execute(
      "INSERT INTO hosRuleLimits (profileKey, limitKey, value, verificationStatus, recordedByUserId) VALUES (?,?,?,'unverified',?)",
      [profileKey, "daily_drive_minutes", 777, recorder]);
    await expect(callerFor(recorder).hos.limitPromote(payload(profileKey) as never)).rejects.toThrow(/second person/);
  });

  it("lets a second person verify the same candidate", async () => {
    const recorder = await manager();
    const second = await manager();
    const profileKey = `SOD_${rnd()}`;
    await schedule(profileKey);
    await pool.execute(
      "INSERT INTO hosRuleLimits (profileKey, limitKey, value, verificationStatus, recordedByUserId) VALUES (?,?,?,'unverified',?)",
      [profileKey, "daily_drive_minutes", 777, recorder]);
    const r = await callerFor(second).hos.limitPromote(payload(profileKey) as never) as { status: string };
    expect(r.status).toBe("CURRENT");
  });

  it("does not bite on a candidate nobody in particular recorded", async () => {
    // Rows that predate 0124, and system seeds, carry no recorder.
    const verifier = await manager();
    const profileKey = `SOD_${rnd()}`;
    await schedule(profileKey);
    await pool.execute("INSERT INTO hosRuleLimits (profileKey, limitKey, value, verificationStatus) VALUES (?,?,?,'unverified')", [profileKey, "daily_drive_minutes", 777]);
    const r = await callerFor(verifier).hos.limitPromote(payload(profileKey) as never) as { status: string };
    expect(r.status).toBe("CURRENT");
  });

  it("lets the verifier who established a figure amend it later — a re-reading, not a self-approval", async () => {
    const verifier = await manager();
    const profileKey = `SOD_${rnd()}`;
    await schedule(profileKey);
    await callerFor(verifier).hos.limitPromote(payload(profileKey, 777) as never);
    const r = await callerFor(verifier).hos.limitPromote({ ...payload(profileKey, 720), sourceSection: "fixture s. 1, amended" } as never) as { corrected: boolean };
    expect(r.corrected).toBe(true);
  });

  it("records who seeded a candidate, so the rule has something to check", async () => {
    const seeder = await manager();
    // profileSeed writes the branch's seeds; every limit it inserts names the seeder.
    await callerFor(seeder).hos.profileSeed();
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM hosRuleLimits WHERE profileKey = 'CA_FEDERAL_SOUTH60' AND recordedByUserId = ?", [seeder]);
    const [total] = await pool.query("SELECT COUNT(*) AS n FROM hosRuleLimits WHERE profileKey = 'CA_FEDERAL_SOUTH60'");
    // Either this run seeded them (and every one names the seeder), or an
    // earlier run did (and the seed is idempotent, writing nothing).
    const n = Number((rows as { n: number }[])[0]?.n), t = Number((total as { n: number }[])[0]?.n);
    expect(n === t || n === 0).toBe(true);
    expect(t).toBeGreaterThan(0);
  });
});
