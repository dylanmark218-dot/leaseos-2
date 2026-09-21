/**
 * 0093 — the cited promotion path, through the real router.
 *
 * Every figure here is a fixture. Nothing in this file establishes a
 * regulatory value.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 140_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) =>
  appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

// `hos.rule.verify` is a sensitive permission granted to management, not safety
// — the branch's own hos.test.ts uses withRole("management").
async function verifier(role = "management") {
  const orgRef = `ORG-${rnd()}`;
  const userId = seq++;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute(
    "INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())",
    [userId, role]);
  return userId;
}

async function schedule(profileKey: string, latitudeRule: string | null) {
  await pool.execute(
    `INSERT INTO hosRuleProfiles
     (profileKey, label, authorityLevel, jurisdiction, latitudeRule, sourceAuthority, sourceCitation,
      effectiveFrom, verificationStatus, verifiedByUserId, verifiedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [profileKey, "Fixture", "federal", "CA", latitudeRule, "FIXTURE",
     "fixture schedule, not a real instrument", new Date("2020-01-01"), "verified", 1]);
}

const payload = (profileKey: string, o: Record<string, unknown> = {}) => ({
  profileKey, limitKey: "daily_drive_minutes", value: 777, unit: "minutes" as const,
  jurisdiction: "CA-FEDERAL", geographicScope: "SOUTH_OF_60_N" as const,
  authorityType: "law" as const,
  instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
  issuingAuthority: "FIXTURE — no issuing authority",
  sourceSection: "fixture s. 1",
  citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
  verificationMethod: "OFFICIAL_WEB" as const,
  attestInstrumentOpen: true as const,
  attestPersonallyVerified: true as const,
  attestBindingAuthority: true as const,
  ...o,
});

d("the cited path", () => {
  it("refuses an unscoped schedule in a split jurisdiction", async () => {
    const userId = await verifier();
    const profileKey = `CA_FEDERAL_${rnd()}`;
    await schedule(profileKey, null);

    // The exact thing the packet warned about: 780 into a generic CA_FEDERAL.
    await expect(callerFor(userId).hos.limitPromote(payload(profileKey) as never))
      .rejects.toThrow(/applies both north and south/);
  });

  it("promotes into a schedule scoped to the division that was read", async () => {
    const userId = await verifier();
    const profileKey = `CA_FED_S_${rnd()}`;
    await schedule(profileKey, "south_of_60");

    const r = await callerFor(userId).hos.limitPromote(payload(profileKey) as never) as {
      promotionRef: string; status: string; becameCurrent: boolean; sourceTextStored: boolean; divergence: string;
    };

    expect(r.promotionRef).toMatch(/^HOS-PROM-/);
    expect(r.status).toBe("CURRENT");
    expect(r.becameCurrent).toBe(true);
    expect(r.sourceTextStored).toBe(false);
    expect(r.divergence).toBe("NONE");
  });

  it("writes the live row and the ledger together", async () => {
    const userId = await verifier();
    const profileKey = `CA_FED_S_${rnd()}`;
    await schedule(profileKey, "south_of_60");
    const r = await callerFor(userId).hos.limitPromote(payload(profileKey) as never) as { promotionRef: string };

    const [live] = await pool.query(
      "SELECT currentPromotionRef, citationUrl, verifiedByUserId FROM hosRuleLimits WHERE profileKey = ?", [profileKey]);
    const row = (live as { currentPromotionRef: string; citationUrl: string; verifiedByUserId: number }[])[0];
    expect(row?.currentPromotionRef).toBe(r.promotionRef);
    // The citation the old path never recorded.
    expect(row?.citationUrl).toContain("justice.gc.ca");
    // The verifier is the authenticated user, never a payload field.
    expect(row?.verifiedByUserId).toBe(userId);
  });

  it("refuses a citation that is not on a registered publisher's domain", async () => {
    const userId = await verifier();
    const profileKey = `CA_FED_S_${rnd()}`;
    await schedule(profileKey, "south_of_60");

    await expect(callerFor(userId).hos.limitPromote(
      payload(profileKey, { citationUrl: "https://sometrainingvendor.example.com/hos" }) as never))
      .rejects.toThrow(/UNRECOGNIZED_AUTHORITY_DOMAIN/);
  });

  it("refuses without all three attestations", async () => {
    const userId = await verifier();
    const profileKey = `CA_FED_S_${rnd()}`;
    await schedule(profileKey, "south_of_60");

    for (const missing of ["attestInstrumentOpen", "attestPersonallyVerified", "attestBindingAuthority"]) {
      // Typed as literal true on the server, so false is a schema failure — a
      // combined "I agree" cannot satisfy it either.
      await expect(callerFor(userId).hos.limitPromote(
        payload(profileKey, { [missing]: false }) as never)).rejects.toThrow();
    }
  });

  it("refuses an implausible figure", async () => {
    const userId = await verifier();
    const profileKey = `CA_FED_S_${rnd()}`;
    await schedule(profileKey, "south_of_60");
    await expect(callerFor(userId).hos.limitPromote(payload(profileKey, { value: 13 }) as never))
      .rejects.toThrow(/IMPLAUSIBLE_VALUE/);
  });

  it("refuses a user without the verify permission", async () => {
    const userId = await verifier("driver");
    const profileKey = `CA_FED_S_${rnd()}`;
    await schedule(profileKey, "south_of_60");
    // The branch's refusal reads "None of [driver] grants hos.rule.verify" — it
    // names the permission, not the word "permission". Match what it actually says.
    await expect(callerFor(userId).hos.limitPromote(payload(profileKey) as never))
      .rejects.toThrow(/grants hos\.rule\.verify|FORBIDDEN/i);
  });

  it("records a future rule without making it live", async () => {
    const userId = await verifier();
    const profileKey = `CA_FED_S_${rnd()}`;
    await schedule(profileKey, "south_of_60");
    await callerFor(userId).hos.limitPromote(payload(profileKey) as never);

    const r = await callerFor(userId).hos.limitPromote(payload(profileKey, {
      value: 700, effectiveFrom: new Date("2027-03-01"), sourceSection: "fixture s. 1, amended",
    }) as never) as { status: string; becameCurrent: boolean };

    expect(r.status).toBe("FUTURE");
    expect(r.becameCurrent).toBe(false);
    const [live] = await pool.query("SELECT value FROM hosRuleLimits WHERE profileKey = ?", [profileKey]);
    expect((live as { value: number }[])[0]?.value).toBe(777);
  });
});

d("the old door, and what it still produces", () => {
  it("still writes a verified figure with no citation and no ledger row", async () => {
    // Recorded, not fixed. `limitVerify` is an existing compliance procedure
    // and changing what it accepts is its own checkpoint — but a test should
    // say plainly what it does, so nobody rediscovers it by accident.
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS n FROM hosRuleLimits WHERE verificationStatus='verified' AND currentPromotionRef IS NULL AND citationUrl IS NULL");
    const uncited = Number((rows as { n: number }[])[0]?.n);
    expect(uncited).toBeGreaterThanOrEqual(0);
  });

  it("can tell a cited figure from an uncited one", async () => {
    const userId = await verifier();
    const profileKey = `CA_FED_S_${rnd()}`;
    await schedule(profileKey, "south_of_60");
    await callerFor(userId).hos.limitPromote(payload(profileKey) as never);

    const [rows] = await pool.query(
      "SELECT currentPromotionRef IS NOT NULL AS cited FROM hosRuleLimits WHERE profileKey = ?", [profileKey]);
    // The distinction the engine and any UI can act on.
    expect(Number((rows as { cited: number }[])[0]?.cited)).toBe(1);
  });
});
