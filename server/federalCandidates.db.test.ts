/**
 * The federal schedules, seeded as cited candidates.
 *
 * What this proves: the figure is in the database, it is fully cited, it
 * determines nothing, and exactly one human action turns it into a real
 * determination.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { checkPromotionScope } from "./_core/knowledge/scopeGuard";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 150_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) =>
  appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function member(role: string) {
  const orgRef = `ORG-${rnd()}`;
  const userId = seq++;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute(
    "INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())",
    [userId, role]);
  orgOf.set(userId, orgRef);
  return userId;
}
const orgOf = new Map<number, string>();
/**
 * P0-A1 — an operator the member's organization owns. `hos.status` resolves the operator through
 * the tenant boundary now, so a bare user id is "Operator N not found"; the fixture has to make
 * the record it claims to ask about.
 */
async function operatorOf(userId: number): Promise<number> {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId) VALUES (?, ?)", [`Driver ${rnd()}`, userId]);
  const orgRef = orgOf.get(userId);
  if (!orgRef) throw new Error(`fixture: user ${userId} was not created by member()`);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, r.insertId]);
  return r.insertId;
}

d("the figure is in the database", () => {
  it("carries the candidate with its citation", async () => {
    const [rows] = await pool.query(
      "SELECT value, sourceSection, verificationStatus FROM hosRuleLimits WHERE profileKey = 'CA_FEDERAL_SOUTH60' AND limitKey = 'daily_drive_minutes'");
    const row = (rows as Record<string, string>[])[0];

    expect(Number(row?.value)).toBe(780);
    // The section now travels with the seed, so a verifier is told where to
    // look. It survives a database rebuild, which a script-applied citation
    // did not — that is how this was found.
    expect(row?.sourceSection).toBe("12(1)");
    // And it is still only a candidate.
    expect(row?.verificationStatus).toBe("unverified");

    const [prof] = await pool.query(
      "SELECT sourceAuthority, sourceCitation FROM hosRuleProfiles WHERE profileKey = 'CA_FEDERAL_SOUTH60'");
    const p0 = (prof as Record<string, string>[])[0];
    expect(p0?.sourceCitation).toContain("Hours of Service Regulations");
  });

  it("is scoped south of 60, not to the whole federal jurisdiction", async () => {
    const [rows] = await pool.query(
      "SELECT latitudeRule FROM hosRuleProfiles WHERE profileKey = 'CA_FEDERAL_SOUTH60'");
    expect((rows as { latitudeRule: string }[])[0]?.latitudeRule).toBe("south_of_60");

    // Counting unscoped federal profiles counts my own fixtures, which create
    // them on purpose to prove the guard refuses them. The hazard is narrower
    // and worth asserting directly: no unscoped schedule carries a live figure.
    const [generic] = await pool.query(
      `SELECT COUNT(*) AS n FROM hosRuleLimits l
         JOIN hosRuleProfiles p ON p.profileKey = l.profileKey
        WHERE p.authorityLevel = 'federal' AND p.latitudeRule IS NULL
          AND l.verificationStatus = 'verified'`);
    expect(Number((generic as { n: number }[])[0]?.n)).toBe(0);
  });

  it("keeps the northern schedule separate, with its own unverified figures", async () => {
    const [p] = await pool.query("SELECT latitudeRule FROM hosRuleProfiles WHERE profileKey = 'CA_FEDERAL_NORTH60'");
    expect((p as { latitudeRule: string }[])[0]?.latitudeRule).toBe("north_of_60");

    const [limits] = await pool.query(
      "SELECT COUNT(*) AS n FROM hosRuleLimits WHERE profileKey = 'CA_FEDERAL_NORTH60' AND verificationStatus = 'verified'");
    // The northern division carries its own candidates. None is verified, and
    // verifying the southern figure does nothing for them.
    expect(Number((limits as { n: number }[])[0]?.n)).toBe(0);
  });

  it("has promoted nothing and verified nothing", async () => {
    const [v] = await pool.query(
      "SELECT COUNT(*) AS n FROM hosRuleLimits WHERE profileKey LIKE 'CA_FEDERAL%' AND verificationStatus='verified'");
    const [l] = await pool.query(
      "SELECT COUNT(*) AS n FROM hosRuleLimitHistory WHERE profileKey LIKE 'CA_FEDERAL%'");
    expect(Number((v as { n: number }[])[0]?.n)).toBe(0);
    expect(Number((l as { n: number }[])[0]?.n)).toBe(0);
  });
});

d("a candidate determines nothing", () => {
  it("answers unknown for a driver under the southern schedule", async () => {
    const userId = await member("driver");
    const status = await callerFor(userId).hos.status({
      operatorId: await operatorOf(userId), carrierAuthority: "federal", jurisdiction: "CA",
      latitude: 53.5, at: new Date("2026-09-13T18:00:00Z"),
    }) as { determination: { verdict: string; determinations: { limitKey: string; result: string; limitMinutes: number | null }[] } };

    expect(status.determination.verdict).toBe("unknown");
    const drive = status.determination.determinations.find((x) => x.limitKey === "daily_drive_minutes");
    if (drive) {
      // The figure is in the row and the engine still will not use it.
      expect(drive.result).toBe("unknown");
      expect(drive.limitMinutes).toBeNull();
    }
  });

  it("passes the scope guard, so the human promotion will not be refused", async () => {
    const r = await checkPromotionScope({
      profileKey: "CA_FEDERAL_SOUTH60", jurisdiction: "CA-FEDERAL", geographicScope: "SOUTH_OF_60_N",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toBe("south_of_60");
  });

  it("would refuse the same promotion aimed north", async () => {
    const r = await checkPromotionScope({
      profileKey: "CA_FEDERAL_NORTH60", jurisdiction: "CA-FEDERAL", geographicScope: "SOUTH_OF_60_N",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SCOPE_MISMATCH");
  });
});

d("one human action changes exactly one thing", () => {
  it("moves the promoted limit and nothing else", async () => {
    const verifier = await member("management");
    const driver = await member("driver");
    const at = new Date("2026-09-13T18:00:00Z");
    const profileKey = `CA_FED_S_SIM_${rnd()}`;
    const jurisdiction = `Z${rnd().slice(0, 2)}`;

    // A copy of the seeded southern schedule, so the simulation does not
    // verify the real candidate — that promotion is the user's to make.
    await pool.execute(
      `INSERT INTO hosRuleProfiles (profileKey, label, authorityLevel, jurisdiction, latitudeRule,
        sourceAuthority, sourceCitation, effectiveFrom, verificationStatus, verifiedByUserId, verifiedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
      [profileKey, "Simulation of the southern schedule", "federal", jurisdiction, "south_of_60", "FIXTURE",
       "simulation, not a real instrument", new Date("2007-01-01"), "verified", 1]);
    await pool.execute(
      "INSERT INTO hosRuleLimits (profileKey, limitKey, value, sourceSection, verificationStatus) VALUES (?,?,?,?,'unverified')",
      [profileKey, "daily_on_duty_minutes", 840, "fixture"]);

    await callerFor(verifier).hos.limitPromote({
      profileKey, limitKey: "daily_drive_minutes", value: 777, unit: "minutes",
      jurisdiction: `${jurisdiction}-FEDERAL`, geographicScope: "SOUTH_OF_60_N", authorityType: "law",
      instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
      issuingAuthority: "FIXTURE — no issuing authority",
      sourceSection: "fixture s. 1",
      citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
      verificationMethod: "OFFICIAL_WEB",
      attestInstrumentOpen: true, attestPersonallyVerified: true, attestBindingAuthority: true,
    } as never);

    const after = await callerFor(driver).hos.status({
      operatorId: await operatorOf(driver), carrierAuthority: "federal", jurisdiction, latitude: 53.5, at,
    }) as { determination: { verdict: string; determinations: { limitKey: string; result: string }[] } };

    const byKey = new Map(after.determination.determinations.map((x) => [x.limitKey, x.result]));
    // The promoted limit decides; its neighbour does not gain authority by
    // association; the profile as a whole stays unknown.
    expect(byKey.get("daily_drive_minutes")).not.toBe("unknown");
    expect(byKey.get("daily_on_duty_minutes")).toBe("unknown");
    expect(after.determination.verdict).toBe("unknown");
  });
});

d("the northern division carries its own daily figure", () => {
  it("no longer reuses the southern daily driving candidate", async () => {
    const [rows] = await pool.query(
      `SELECT p.profileKey, l.value, IFNULL(l.sourceSection, '-') AS sec FROM hosRuleLimits l
         JOIN hosRuleProfiles p ON p.profileKey = l.profileKey
        WHERE p.profileKey IN ('CA_FEDERAL_SOUTH60','CA_FEDERAL_NORTH60')
          AND l.limitKey = 'daily_drive_minutes'`);
    const byKey = new Map((rows as { profileKey: string; value: number; sec: string }[])
      .map((r) => [r.profileKey, r]));

    // This test previously asserted the two were equal — it was recording the
    // defect. 0093A corrected the candidate, so it now records the correction.
    expect(byKey.get("CA_FEDERAL_SOUTH60")?.value).toBe(780);
    expect(byKey.get("CA_FEDERAL_SOUTH60")?.sec).toBe("12(1)");
    expect(byKey.get("CA_FEDERAL_NORTH60")?.value).toBe(900);
    expect(byKey.get("CA_FEDERAL_NORTH60")?.sec).toBe("39(1)");
  });

  it("verifies neither of them", async () => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM hosRuleLimits
        WHERE profileKey IN ('CA_FEDERAL_SOUTH60','CA_FEDERAL_NORTH60')
          AND verificationStatus = 'verified'`);
    // A corrected candidate is still a candidate.
    expect(Number((rows as { n: number }[])[0]?.n)).toBe(0);
  });
});
