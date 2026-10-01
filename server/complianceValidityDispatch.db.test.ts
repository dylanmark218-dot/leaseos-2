/**
 * SPINE item 2 — dispatch reads a credential through the canonical document verdict.
 *
 * Each case here is one way the composer's own row-picking (verified first, then latest expiry)
 * let a credential clear dispatch that was not in force, or one the owner ruled on 2026-09-25:
 *
 *   D1  an unverified licence (needs_review) cleared dispatch
 *   D2  an older verified row outranked a newer verified correction that says it has expired
 *   D3  a verified licence whose effective date has not come counted as current
 *   D4  a verified licence with no expiry: unknown, and stays unknown (no type is never-expiring)
 *   L   the legacy operators.licenseExpiresAt date is unverified: it no longer clears dispatch
 *   U   the same rules for a unit's inspection
 *
 * The controls (a verified, current licence; an expired legacy date; an unverified licence whose
 * own date has passed) pin what must not move.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { composeReadiness } from "./readinessComposer";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

type Doc = { docType: string; status: "needs_review" | "verified" | "rejected"; expiresInDays: number | null; issuedInDays?: number | null; capturedDaysAgo?: number };

async function subject(opts: { legacyLicenceInDays?: number | null; operatorDocs?: Doc[]; unitDocs?: Doc[] }) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [`U-${rnd()}`]);
  const legacy = opts.legacyLicenceInDays == null ? null : new Date(Date.now() + opts.legacyLicenceInDays * 86_400_000);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, licenseExpiresAt) VALUES (?, ?)", [`Op ${rnd()}`, legacy]);
  const file = async (ownerType: "operator" | "unit", ownerId: number, doc: Doc) => {
    const at = (days: number | null | undefined) => days == null ? null : new Date(Date.now() + days * 86_400_000);
    await pool.execute(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, issuedAt, expiresAt, verificationStatus) VALUES (?,?,?,?,?,?,?,?)",
      [ownerType, ownerId, doc.docType, doc.docType, new Date(Date.now() - (doc.capturedDaysAgo ?? 0) * 86_400_000), at(doc.issuedInDays), at(doc.expiresInDays), doc.status]);
  };
  for (const doc of opts.operatorDocs ?? []) await file("operator", op.insertId, doc);
  // A unit that is otherwise in order, so only what a case disturbs shows up.
  const unitDocs = opts.unitDocs ?? [
    { docType: "cvip_certificate", status: "verified", expiresInDays: 300 },
    { docType: "vehicle_registration", status: "verified", expiresInDays: 300 },
  ] as Doc[];
  for (const doc of unitDocs) await file("unit", u.insertId, doc);
  const r = await composeReadiness({ operatorId: op.insertId, unitId: u.insertId, trailerId: null, jobId: null });
  return r.eligibility.blockers;
}
const only = <B extends { code: string }>(blockers: readonly B[], prefix: string) => blockers.filter(b => b.code.startsWith(prefix));
const VERIFIED_LICENCE: Doc = { docType: "driver_licence", status: "verified", expiresInDays: 400 };
/**
 * The same finding "expiry unknown" already produced: C1a classifies it UNKNOWN / BLOCK under
 * driver.licence.unknown, lifted only by an approved override policy (not a person's say-so).
 */
const LICENCE_UNKNOWN = { code: "operator_licence_unknown", severity: "unknown", result: "UNKNOWN", dispatchEffect: "BLOCK", ruleRef: expect.objectContaining({ key: "driver.licence.unknown" }) };

d("dispatch reads a credential through the canonical document verdict", () => {
  it("control: a verified, current licence raises no licence blocker", async () => {
    expect(only(await subject({ operatorDocs: [VERIFIED_LICENCE] }), "operator_licence")).toEqual([]);
  }, 20_000);

  it("D1: an unverified licence is an overridable unknown, not a clearance", async () => {
    const [b, ...rest] = only(await subject({ operatorDocs: [{ docType: "driver_licence", status: "needs_review", expiresInDays: 400 }] }), "operator_licence");
    expect(rest).toEqual([]);
    expect(b).toMatchObject(LICENCE_UNKNOWN);
    expect(b!.label).toContain("not verified");
  }, 20_000);

  it("D2: a newer verified correction that says expired wins over an older verified row with a later date", async () => {
    const blockers = await subject({ operatorDocs: [
      { docType: "driver_licence", status: "verified", expiresInDays: 400, capturedDaysAgo: 30 },
      { docType: "driver_licence", status: "verified", expiresInDays: -5, capturedDaysAgo: 0 },
    ] });
    expect(only(blockers, "operator_licence")).toEqual([expect.objectContaining({ code: "operator_licence_expired", severity: "blocking", overridable: false })]);
  }, 20_000);

  it("D3: a verified licence not yet in force blocks as nothing in force", async () => {
    const [b] = only(await subject({ operatorDocs: [{ docType: "driver_licence", status: "verified", expiresInDays: 400, issuedInDays: 2 }] }), "operator_licence");
    expect(b).toMatchObject({ code: "operator_licence_missing", severity: "blocking", overridable: false });
    expect(b!.label).toContain("not yet in force");
  }, 20_000);

  it("D4: a verified licence with no expiry is unknown — no type is never-expiring yet", async () => {
    const [b] = only(await subject({ operatorDocs: [{ docType: "driver_licence", status: "verified", expiresInDays: null }] }), "operator_licence");
    expect(b).toMatchObject(LICENCE_UNKNOWN);
    expect(b!.label).toContain("expiry unknown");
  }, 20_000);

  it("L: the legacy licence date alone is unverified — an overridable unknown, not a clearance", async () => {
    const [b] = only(await subject({ legacyLicenceInDays: 400 }), "operator_licence");
    expect(b).toMatchObject(LICENCE_UNKNOWN);
    expect(b!.label).toContain("legacy");
  }, 20_000);

  it("control: a legacy licence date already past is still a hard block", async () => {
    expect(only(await subject({ legacyLicenceInDays: -5 }), "operator_licence")).toEqual([expect.objectContaining({ code: "operator_licence_expired", severity: "blocking" })]);
  }, 20_000);

  it("control: an unverified licence whose own date has passed is still a hard block", async () => {
    expect(only(await subject({ operatorDocs: [{ docType: "driver_licence", status: "needs_review", expiresInDays: -3 }] }), "operator_licence"))
      .toEqual([expect.objectContaining({ code: "operator_licence_expired", severity: "blocking", overridable: false })]);
  }, 20_000);

  it("control: a verified licence beside an unverified newer upload stays in force", async () => {
    const blockers = await subject({ operatorDocs: [
      { docType: "driver_licence", status: "verified", expiresInDays: 400, capturedDaysAgo: 30 },
      { docType: "driver_licence", status: "needs_review", expiresInDays: 800, capturedDaysAgo: 0 },
    ] });
    expect(only(blockers, "operator_licence")).toEqual([]);
  }, 20_000);

  it("U: a unit inspection that is only uploaded is an overridable unknown", async () => {
    const blockers = await subject({ operatorDocs: [VERIFIED_LICENCE], unitDocs: [
      { docType: "cvip_certificate", status: "needs_review", expiresInDays: 300 },
      { docType: "vehicle_registration", status: "verified", expiresInDays: 300 },
    ] });
    expect(only(blockers, "truck_inspection")).toEqual([expect.objectContaining({ code: "truck_inspection_unknown", severity: "unknown", result: "UNKNOWN", dispatchEffect: "BLOCK", ruleRef: expect.objectContaining({ key: "vehicle.inspection.unknown" }) })]);
    expect(only(blockers, "truck_registration")).toEqual([]);
  }, 20_000);

  it("U: either accepted inspection type satisfies — a verified annual inspection beside an uploaded CVIP", async () => {
    const blockers = await subject({ operatorDocs: [VERIFIED_LICENCE], unitDocs: [
      { docType: "cvip_certificate", status: "needs_review", expiresInDays: 300 },
      { docType: "annual_inspection", status: "verified", expiresInDays: 300 },
      { docType: "vehicle_registration", status: "verified", expiresInDays: 300 },
    ] });
    expect(only(blockers, "truck_inspection")).toEqual([]);
  }, 20_000);
});
