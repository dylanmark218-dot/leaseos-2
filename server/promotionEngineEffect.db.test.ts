/**
 * What a promotion actually changes in the HOS engine.
 *
 * The claim worth proving: promoting **one** limit lifts **that** determination
 * out of UNKNOWN and leaves every other limit exactly where it was. A rule
 * store that unlocked a whole profile from a single verified figure would be
 * the quiet failure this architecture exists to prevent.
 *
 * Every figure here is a test fixture, not a verified Canadian value.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { promote, type PromotionEvidence } from "./_core/knowledge/promotionLedger";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 120_000_000 + Math.floor(Math.random() * 60_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const NOW = new Date("2026-09-13T18:00:00Z");

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });

afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) =>
  appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

/** A driver with a role, an operator record and some duty time. */
async function driver() {
  const orgRef = `ORG-${rnd()}`;
  const userId = seq++;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `org ${orgRef}`]);
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute(
    "INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())",
    [userId, "driver"]);
  // P0-A1 — the operator record this comment always promised. `hos.status` resolves the operator
  // through the tenant boundary now, so the organization has to own one; a bare user id is
  // "Operator N not found".
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId) VALUES (?, ?)", [`Driver ${rnd()}`, userId]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, op.insertId]);
  return { orgRef, userId, operatorId: op.insertId };
}

/**
 * A verified profile in a jurisdiction of its own.
 *
 * The first version of this test reused "AB" and piled up fixtures, so
 * `selectProfile` reported *"4 profiles apply equally to this operation — a
 * person decides which governs"* and determined nothing. That is the engine
 * working: it refuses to pick between equally applicable authorities. It also
 * meant `unknownCount` was 0 because there were **no determinations at all**,
 * not because everything was known — a different thing that reads the same in a
 * count. Each test now owns a jurisdiction.
 */
async function profile(profileKey: string, jurisdiction: string) {
  await pool.execute(
    `INSERT INTO hosRuleProfiles
     (profileKey, label, authorityLevel, jurisdiction, latitudeRule, sourceAuthority,
      sourceCitation, effectiveFrom, verificationStatus, verifiedByUserId, verifiedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [profileKey, "Fixture profile", "federal", jurisdiction, "south_of_60", "Fixture",
     "test fixture, not a real instrument", new Date("2020-01-01"), "verified", 1]);
}

const evidence = (profileKey: string, limitKey: string, value: number): PromotionEvidence => ({
  profileKey, limitKey, value, unit: "minutes",
  jurisdiction: "CA-FEDERAL", authorityType: "law",
  instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation",
  issuingAuthority: "FIXTURE — no issuing authority",
  sourceSection: "fixture s. 1",
  // A registered publisher domain, because the guard checks where a
  // citation points. The instrument title is what marks this as a fixture.
  citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
  verificationMethod: "OFFICIAL_WEB",
  verifiedByUserId: 7, verifiedAt: new Date(NOW.getTime() - 86_400_000),
});

d("a promotion moves exactly one determination", () => {
  it("leaves every limit unknown before anything is verified", async () => {
    const { userId, operatorId } = await driver();
    const jurisdiction = `Z${rnd().slice(0, 2)}`;
    const profileKey = `FIX-${rnd()}`;
    await profile(profileKey, jurisdiction);

    const status = await callerFor(userId).hos.status({
      operatorId, carrierAuthority: "federal", jurisdiction, latitude: 53.5, at: NOW,
    }) as { determination: { verdict: string; determinations: { limitKey: string; result: string }[] } };

    // P9: nothing verified, so nothing determined.
    expect(status.determination.verdict).toBe("unknown");
  });

  it("lifts only the promoted limit out of unknown", async () => {
    const { userId, operatorId } = await driver();
    const jurisdiction = `Z${rnd().slice(0, 2)}`;
    const profileKey = `FIX-${rnd()}`;
    await profile(profileKey, jurisdiction);

    const before = await callerFor(userId).hos.status({
      operatorId, carrierAuthority: "federal", jurisdiction, latitude: 53.5, at: NOW,
    }) as { determination: { determinations: { limitKey: string; result: string }[] } };
    const unknownBefore = before.determination.determinations.filter((x) => x.result === "unknown").length;

    const r = await promote(evidence(profileKey, "daily_drive_minutes", 780), NOW);
    expect(r.promoted).toBe(true);

    const after = await callerFor(userId).hos.status({
      operatorId, carrierAuthority: "federal", jurisdiction, latitude: 53.5, at: NOW,
    }) as { determination: { determinations: { limitKey: string; result: string }[] } };
    const unknownAfter = after.determination.determinations.filter((x) => x.result === "unknown").length;

    // One verified figure does not unlock a profile. If this ever shows a drop
    // greater than one, a single verification is authorizing limits nobody
    // checked.
    expect(unknownBefore - unknownAfter).toBeLessThanOrEqual(1);
  });

  it("determines the promoted limit and leaves its neighbour unknown", async () => {
    const { userId, operatorId } = await driver();
    const jurisdiction = `Z${rnd().slice(0, 2)}`;
    const profileKey = `FIX-${rnd()}`;
    await profile(profileKey, jurisdiction);

    // One limit verified through the promotion path, one sitting unverified
    // beside it. A profile does not arrive carrying limits — they exist as rows
    // — so the neighbour has to be seeded for the contrast to mean anything.
    // Without it the profile has exactly one limit, that limit is verified, and
    // the verdict is legitimately `within`.
    await promote(evidence(profileKey, "daily_drive_minutes", 780), NOW);
    await pool.execute(
      "INSERT INTO hosRuleLimits (profileKey, limitKey, value, sourceSection, verificationStatus) VALUES (?,?,?,?,'unverified')",
      [profileKey, "daily_on_duty_minutes", 840, "fixture s. 2"]);

    const status = await callerFor(userId).hos.status({
      operatorId, carrierAuthority: "federal", jurisdiction, latitude: 53.5, at: NOW,
    }) as { determination: { verdict: string; unknownCount: number; determinations: { limitKey: string; result: string }[] } };

    const byKey = new Map(status.determination.determinations.map((x) => [x.limitKey, x.result]));

    // The promoted one is decided.
    expect(byKey.get("daily_drive_minutes")).not.toBe("unknown");
    // Its neighbour is not. One verified figure is authority for itself alone.
    expect(byKey.get("daily_on_duty_minutes")).toBe("unknown");
    // And the profile as a whole stays unknown: the engine never rounds to
    // compliant while anything is undetermined.
    expect(status.determination.verdict).toBe("unknown");
    expect(status.determination.unknownCount).toBeGreaterThan(0);
  });

  it("does not apply a future amendment to today's determination", async () => {
    const { userId, operatorId } = await driver();
    const jurisdiction = `Z${rnd().slice(0, 2)}`;
    const profileKey = `FIX-${rnd()}`;
    await profile(profileKey, jurisdiction);
    await promote(evidence(profileKey, "daily_drive_minutes", 780), NOW);
    await promote({
      ...evidence(profileKey, "daily_drive_minutes", 600),
      effectiveFrom: new Date("2027-03-01"), sourceSection: "fixture s. 1, amended",
    }, NOW);

    const [rows] = await pool.query(
      "SELECT value FROM hosRuleLimits WHERE profileKey = ? AND limitKey = 'daily_drive_minutes'", [profileKey]);
    // Known, not applied. The driver is still measured against the rule in force.
    expect((rows as { value: number }[])[0]?.value).toBe(780);
  });
});
