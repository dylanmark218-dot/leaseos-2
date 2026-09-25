/**
 * C1b-2 — the requirement registry, read one way.
 *
 * Every requirement below is a **test fixture** in a made-up jurisdiction, not a verified rule.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { complianceRequirements } from "../drizzle/schema";
import { COMPLIANCE_REQUIREMENT_SEEDS } from "./_core/complianceRequirementSeeds";
import type { DomainRole } from "./_core/recordsAuthorization";
import { grantUserRole } from "./db";
import { governingRevisions, loadRequirementRegistry } from "./requirementRegistry";
import { appRouter } from "./routers";

type Row = typeof complianceRequirements.$inferSelect;
const T = (s: string) => new Date(`${s}T00:00:00Z`);

const row = (o: Partial<Row>): Row => ({
  id: 1, requirementKey: "k", version: 1, family: "f", packKey: null, title: "t", subjectType: "operator",
  jurisdiction: "CA-ZZ", appliesWhenJson: null, satisfiedByDocTypes: "[\"d\"]", renewalIntervalDays: null,
  warnDaysBeforeExpiry: 30, missingSeverity: "blocked", sourceAuthority: null, sourceUrl: null, sourceReference: null,
  effectiveFrom: T("2026-01-01"), effectiveUntil: null, verificationStatus: "verified", verifiedByUserId: 5,
  verifiedAt: T("2026-01-01"), notes: null, createdAt: T("2026-01-01"), ...o,
});

describe("which revision governs", () => {
  it("takes the highest version in force, and keeps the earlier one until a later one's date", () => {
    const rows = [
      row({ version: 1 }),
      row({ id: 2, version: 2, effectiveFrom: T("2026-06-01"), createdAt: T("2026-03-01") }),
    ];
    expect(governingRevisions(rows, T("2026-04-01")).map((g) => g.row.version)).toEqual([1]);
    expect(governingRevisions(rows, T("2026-07-01")).map((g) => g.row.version)).toEqual([2]);
  });

  it("never applies a revision recorded after the date asked about", () => {
    const rows = [row({ version: 1 }), row({ id: 2, version: 2, createdAt: T("2026-05-01") })];
    expect(governingRevisions(rows, T("2026-04-01")).map((g) => g.row.version)).toEqual([1]);
    expect(governingRevisions(rows, T("2025-06-01"))).toEqual([]);
  });

  it("undoes the old path's in-place supersession while the later revision is not yet in force", () => {
    // As the pre-C1b-2 requirementLoad left them: v1 overwritten to superseded, with effectiveUntil
    // set to v2's effectiveFrom, the moment v2 was loaded.
    const rows = [
      row({ version: 1, verificationStatus: "superseded", effectiveUntil: T("2026-06-01") }),
      row({ id: 2, version: 2, verificationStatus: "unverified", verifiedByUserId: null, effectiveFrom: T("2026-06-01"), createdAt: T("2026-03-01") }),
    ];
    const before = governingRevisions(rows, T("2026-04-01"));
    expect(before.map((g) => [g.row.version, g.status])).toEqual([[1, "verified"]]);
    const after = governingRevisions(rows, T("2026-07-01"));
    expect(after.map((g) => [g.row.version, g.status])).toEqual([[2, "unverified"]]);
  });

  it("recovers an overwritten unverified revision as unverified, never as verified", () => {
    const rows = [
      row({ version: 1, verificationStatus: "superseded", verifiedByUserId: null }),
      row({ id: 2, version: 2, effectiveFrom: T("2027-01-01") }),
    ];
    expect(governingRevisions(rows, T("2026-04-01"))[0].status).toBe("unverified");
  });

  it("drops a key whose governing revision is withdrawn", () => {
    expect(governingRevisions([row({ verificationStatus: "withdrawn" })], T("2026-04-01"))).toEqual([]);
  });

  it("keeps a key whose only revision is not yet effective, so its seed does not return", () => {
    const g = governingRevisions([row({ effectiveFrom: T("2027-01-01") })], T("2026-04-01"));
    expect(g).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Through the API                                                     */
/* ------------------------------------------------------------------ */

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 884_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
beforeAll(async () => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = userSeq++;
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}

d("requirementLoad writes revisions and never rewrites one", () => {
  it("leaves the earlier revision exactly as it was", async () => {
    const controller = await withRole("controller");
    const key = `test.c1b2.${rnd()}`;
    const base = {
      requirementKey: key, family: "test", title: "Fixture requirement", subjectType: "operator" as const, jurisdiction: `CA-ZZ-${rnd()}`,
      satisfiedByDocTypes: ["fixture_doc"], missingSeverity: "blocked" as const, sourceAuthority: "FIXTURE", sourceVerified: true,
      requestedStatus: "verified" as const, effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    };
    await callerFor(controller).compliance.requirementLoad(base);
    const [before] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM complianceRequirements WHERE requirementKey = ? AND version = 1", [key]);
    await callerFor(controller).compliance.requirementLoad({ ...base, title: "Fixture requirement, amended", effectiveFrom: new Date(Date.now() + 30 * 86_400_000) });
    const [after] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM complianceRequirements WHERE requirementKey = ? AND version = 1", [key]);
    expect(after[0]).toEqual(before[0]);

    // v1 governs until v2's date — not "neither", as the in-place supersession made it.
    const now = await loadRequirementRegistry([], new Date());
    expect(now.find((r) => r.requirementKey === key)).toMatchObject({ version: 1, verificationStatus: "verified", origin: "registry" });
    const later = await loadRequirementRegistry([], new Date(Date.now() + 31 * 86_400_000));
    expect(later.find((r) => r.requirementKey === key)).toMatchObject({ version: 2, title: "Fixture requirement, amended" });
  });

  it("accepts every subject the column holds, and a pack only if it exists", async () => {
    const controller = await withRole("controller");
    const common = {
      family: "test", title: "Fixture", jurisdiction: `CA-ZZ-${rnd()}`, satisfiedByDocTypes: ["fixture_doc"],
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    };
    for (const subjectType of ["equipment", "attachment", "work_context"] as const) {
      const r = await callerFor(controller).compliance.requirementLoad({ ...common, requirementKey: `test.c1b2.${subjectType}.${rnd()}`, subjectType });
      expect(r.version).toBe(1);
    }
    await expect(callerFor(controller).compliance.requirementLoad({ ...common, requirementKey: `test.c1b2.${rnd()}`, subjectType: "equipment", packKey: "no.such.pack" }))
      .rejects.toThrow(/Unknown pack/);
  });
});

d("the registry reaches every reader", () => {
  it("gives passport items the exact revision they used", async () => {
    const controller = await withRole("controller");
    const dispatcher = await withRole("dispatcher");
    const jurisdiction = `CA-ZZ-${rnd()}`;
    const key = `test.c1b2.ref.${rnd()}`;
    await callerFor(controller).compliance.requirementLoad({
      requirementKey: key, family: "test", title: "Fixture", subjectType: "operator", jurisdiction,
      satisfiedByDocTypes: ["fixture_doc"], effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    });
    await callerFor(controller).compliance.requirementLoad({
      requirementKey: key, family: "test", title: "Fixture v2", subjectType: "operator", jurisdiction,
      satisfiedByDocTypes: ["fixture_doc"], effectiveFrom: new Date("2026-02-01T00:00:00Z"),
    });
    const p = await callerFor(dispatcher).compliance.passport({ subjectType: "operator", subjectId: 1, jurisdiction, attributes: {} });
    const mine = p.items.filter((i) => i.requirementKey === key);
    // One item, from the governing revision — not one per stored version, as before.
    expect(mine).toHaveLength(1);
    expect(mine[0].requirementRef).toEqual({ key, version: 2, origin: "registry" });
  });

  it("marks a seed as a seed, and lets a stored revision of the same key replace it", async () => {
    const seedKey = `test.c1b2.seed.${rnd()}`;
    const seed = { ...COMPLIANCE_REQUIREMENT_SEEDS[0], requirementKey: seedKey };
    const [fromSeed] = (await loadRequirementRegistry([seed])).filter((r) => r.requirementKey === seedKey);
    expect(fromSeed).toMatchObject({ origin: "seed", version: seed.version });

    const controller = await withRole("controller");
    await callerFor(controller).compliance.requirementLoad({
      requirementKey: seedKey, family: "test", title: "Stored over the seed", subjectType: "operator", jurisdiction: "CA-ZZ",
      satisfiedByDocTypes: ["fixture_doc"], effectiveFrom: new Date(Date.now() + 60 * 86_400_000),
    });
    // Not yet effective, and still the seed does not come back.
    const mine = (await loadRequirementRegistry([seed])).filter((r) => r.requirementKey === seedKey);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ origin: "registry", title: "Stored over the seed" });
  });

  it("reaches work authorization, and honours the requirement's pack", async () => {
    const controller = await withRole("controller");
    const dispatcher = await withRole("dispatcher");
    const jurisdiction = `CA-ZZ-${rnd()}`;
    const packKey = `test.pack.${rnd()}`;
    // A predicate this company does not meet, so the pack is active only when activated explicitly.
    await pool.query("INSERT INTO compliancePacks (packKey, title, jurisdiction, core, activatesWhenJson) VALUES (?, 'Fixture pack', ?, false, ?)",
      [packKey, jurisdiction, JSON.stringify({ activitiesAny: ["fixture_activity"] })]);
    const key = `test.c1b2.wa.${rnd()}`;
    const title = `Fixture equipment rule ${rnd()}`;
    await callerFor(controller).compliance.requirementLoad({
      requirementKey: key, family: "test", title, subjectType: "equipment", jurisdiction, packKey,
      satisfiedByDocTypes: ["fixture_doc"], missingSeverity: "blocked", sourceAuthority: "FIXTURE", sourceVerified: true,
      requestedStatus: "verified", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    });
    const entity = 700_000_000 + Math.floor(Math.random() * 1_000_000);
    const ask = () => callerFor(dispatcher).requirement.workAuthorization({
      financialEntityId: entity, jurisdiction, companyAttributes: {}, worker: null,
      equipment: { id: 999_999_999, equipmentType: "fixture", attributes: {} }, work: { workType: "fixture", attributes: {} },
    });
    // Work authorization reports a requirement by its title in `reasons`.
    const seen = (r: Awaited<ReturnType<typeof ask>>) => r.reasons.some((x) => x.includes(title));

    // Pack not active: the requirement is not in force for this company.
    expect(seen(await ask())).toBe(false);

    // A stored pack can be activated (it was refused before: only seed packs were known).
    const act = await callerFor(controller).requirement.packActivate({ financialEntityId: entity, packKey });
    expect(act.requirementsInPack).toBe(1);
    const r = await ask();
    expect(seen(r)).toBe(true);
    expect(r.verdict).toBe("blocked");
    expect(r.parts.equipment).toBe("blocked");

    await expect(callerFor(controller).requirement.packActivate({ financialEntityId: entity, packKey: "no.such.pack" })).rejects.toThrow(/Unknown pack/);
  });
});
