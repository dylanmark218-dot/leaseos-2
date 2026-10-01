/**
 * C1b-2 — the requirement registry, read one way.
 *
 * Every requirement below is a **test fixture** in a made-up jurisdiction, not a verified rule.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { complianceRequirements } from "../drizzle/schema";
import { COMPLIANCE_REQUIREMENT_SEEDS } from "./_core/complianceRequirementSeeds";
import type { DomainRole } from "./_core/recordsAuthorization";
import { grantUserRole } from "./db";
import { governingRevisions, loadRequirementRegistry } from "./requirementRegistry";
import { appRouter } from "./routers";

/**
 * F1.1 refuses to evaluate equipment credentials while any organization exists: equipment rows carry no
 * owner, so nothing proves whose they are (`requireProvableOwnership`). The pack cases below are about the
 * registry reaching work authorization, which only has a meaning where that ownership is provable — one
 * ownership domain. They switch it on for themselves alone, and each first asserts the refusal while an
 * organization exists, so the gate is pinned rather than bypassed.
 */
const ownership = vi.hoisted(() => ({ singleDomain: false }));
vi.mock("./ownershipDomain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ownershipDomain")>();
  return {
    ...actual,
    singleOwnershipDomain: async () => ownership.singleDomain || actual.singleOwnershipDomain(),
    requireProvableOwnership: async (what: string, until: string) => (ownership.singleDomain ? undefined : actual.requireProvableOwnership(what, until)),
  };
});
async function asOneOwnershipDomain<T>(body: () => Promise<T>): Promise<T> {
  ownership.singleDomain = true;
  try { return await body(); } finally { ownership.singleDomain = false; }
}

type Row = typeof complianceRequirements.$inferSelect;
const T = (s: string) => new Date(`${s}T00:00:00Z`);

const row = (o: Partial<Row>): Row => ({
  id: 1, requirementKey: "k", version: 1, family: "f", packKey: null, title: "t", subjectType: "operator",
  jurisdiction: "CA-ZZ", appliesWhenJson: null, satisfiedByDocTypes: "[\"d\"]", renewalIntervalDays: null,
  warnDaysBeforeExpiry: 30, missingSeverity: "blocked", sourceAuthority: null, sourceUrl: null, sourceReference: null,
  effectiveFrom: T("2026-01-01"), effectiveUntil: null, verificationStatus: "verified", verifiedByUserId: 5,
  verifiedAt: T("2026-01-01"), notes: null, createdAt: T("2026-01-01"),
  // Written before 0198: no proposer, no organization, no verification events.
  orgRef: null, proposedByUserId: null, instrumentTitle: null, authorityType: null, effectiveDateUnknown: false, citationHash: null,
  ...o,
});
const NONE = new Map();

// C1b-2a's selection rules, on rows written before C1b-2b. Since C1b-2b those rows are not evidence
// of anything: a one-step controller verification is UNVERIFIED (requirementVerification.db.test.ts
// covers the verified paths). Which revision stands for a key is unchanged.
describe("which revision stands for a key (rows written before C1b-2b)", () => {
  it("takes the highest version in force, and keeps the earlier one until a later one's date", () => {
    const rows = [
      row({ version: 1 }),
      row({ id: 2, version: 2, effectiveFrom: T("2026-06-01"), createdAt: T("2026-03-01") }),
    ];
    expect(governingRevisions(rows, NONE, T("2026-04-01")).map((g) => g.row.version)).toEqual([1]);
    expect(governingRevisions(rows, NONE, T("2026-07-01")).map((g) => g.row.version)).toEqual([2]);
  });

  it("never applies a revision recorded after the date asked about", () => {
    const rows = [row({ version: 1 }), row({ id: 2, version: 2, createdAt: T("2026-05-01") })];
    expect(governingRevisions(rows, NONE, T("2026-04-01")).map((g) => g.row.version)).toEqual([1]);
    expect(governingRevisions(rows, NONE, T("2025-06-01"))).toEqual([]);
  });

  it("reads a one-step controller verification, and the old in-place supersession, as UNVERIFIED", () => {
    const rows = [
      row({ version: 1, verificationStatus: "superseded", effectiveUntil: T("2026-06-01") }),
      row({ id: 2, version: 2, verificationStatus: "verified", effectiveFrom: T("2026-06-01"), createdAt: T("2026-03-01") }),
    ];
    const before = governingRevisions(rows, NONE, T("2026-04-01"));
    expect(before.map((g) => [g.row.version, g.level, g.status])).toEqual([[1, "UNVERIFIED", "unverified"]]);
    const after = governingRevisions(rows, NONE, T("2026-07-01"));
    expect(after.map((g) => [g.row.version, g.level, g.status])).toEqual([[2, "UNVERIFIED", "unverified"]]);
  });

  it("drops a key whose governing revision is withdrawn", () => {
    expect(governingRevisions([row({ verificationStatus: "withdrawn" })], NONE, T("2026-04-01"))).toEqual([]);
  });

  it("keeps a key whose only revision is not yet effective, so its seed does not return", () => {
    const g = governingRevisions([row({ effectiveFrom: T("2027-01-01") })], NONE, T("2026-04-01"));
    expect(g).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Through the API                                                     */
/* ------------------------------------------------------------------ */

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 414_000_000 + Math.floor(Math.random() * 50_000);
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
    // Both are proposals (C1b-2b: asking for "verified" is ignored), so both are unverified.
    const now = await loadRequirementRegistry([], new Date(), "default");
    expect(now.find((r) => r.requirementKey === key)).toMatchObject({ version: 1, verificationStatus: "unverified", origin: "registry" });
    const later = await loadRequirementRegistry([], new Date(Date.now() + 31 * 86_400_000), "default");
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
    // F1.2 — a real operator in the dispatcher's scope: a made-up subject is "not found".
    const subjectId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES ('Registry fixture', NOW())"))[0].insertId);
    const p = await callerFor(dispatcher).compliance.passport({ subjectType: "operator", subjectId, jurisdiction, attributes: {} });
    const mine = p.items.filter((i) => i.requirementKey === key);
    // One item, from the governing revision — not one per stored version, as before.
    expect(mine).toHaveLength(1);
    expect(mine[0].requirementRef).toMatchObject({ key, version: 2, origin: "registry", provenance: { level: "UNVERIFIED", sourceMonitoringAvailable: false } });
  });

  it("marks a seed as a seed, and lets a stored revision of the same key replace it", async () => {
    const seedKey = `test.c1b2.seed.${rnd()}`;
    const seed = { ...COMPLIANCE_REQUIREMENT_SEEDS[0], requirementKey: seedKey };
    const [fromSeed] = (await loadRequirementRegistry([seed], new Date(), "default")).filter((r) => r.requirementKey === seedKey);
    expect(fromSeed).toMatchObject({ origin: "seed", version: seed.version });

    const controller = await withRole("controller");
    await callerFor(controller).compliance.requirementLoad({
      requirementKey: seedKey, family: "test", title: "Stored over the seed", subjectType: "operator", jurisdiction: "CA-ZZ",
      satisfiedByDocTypes: ["fixture_doc"], effectiveFrom: new Date(Date.now() + 60 * 86_400_000),
    });
    // Not yet effective, and still the seed does not come back.
    const mine = (await loadRequirementRegistry([seed], new Date(), "default")).filter((r) => r.requirementKey === seedKey);
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
    // F1.1 — a real book: a made-up financial entity is "not found".
    const entity = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${rnd()}${rnd()}`]))[0].insertId);
    const ask = () => callerFor(dispatcher).requirement.workAuthorization({
      financialEntityId: entity, jurisdiction, companyAttributes: {}, worker: null,
      equipment: { id: 999_999_999, equipmentType: "fixture", attributes: {} }, work: { workType: "fixture", attributes: {} },
    });
    // Work authorization reports a requirement by its title in `reasons`.
    const seen = (r: Awaited<ReturnType<typeof ask>>) => r.reasons.some((x) => x.includes(title));

    // With an organization present, unowned equipment credentials are refused (F1.1), not evaluated.
    const orgRef = `ORG-${rnd()}`;
    await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
    await expect(ask()).rejects.toThrow(/OWNERSHIP_UNRESOLVED/);

    await asOneOwnershipDomain(async () => {
      // Pack not active: the requirement is not in force for this company.
      expect(seen(await ask())).toBe(false);

      // A stored pack can be activated (it was refused before: only seed packs were known).
      const act = await callerFor(controller).requirement.packActivate({ financialEntityId: entity, packKey });
      expect(act.requirementsInPack).toBe(1);
      const r = await ask();
      expect(seen(r)).toBe(true);
      // A proposal, so UNKNOWN — the verified path is requirementVerification.db.test.ts.
      expect(r.parts.equipment).toBe("unknown");
    });

    await expect(callerFor(controller).requirement.packActivate({ financialEntityId: entity, packKey: "no.such.pack" })).rejects.toThrow(/Unknown pack/);
  });
});
