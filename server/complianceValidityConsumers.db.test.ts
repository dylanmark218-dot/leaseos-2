/**
 * SPINE item 2 — the same records, read through every production consumer, give one verdict.
 *
 * `complianceValidityConsumers.test.ts` proves the equivalence on the pure entry points. This
 * drives the real paths against the gate database: the composer dispatch runs
 * (`composeReadiness`), `compliance.medicalEligibility`, `insurance.coverageForEntity`, and the
 * documentExpiry tile through the real reader and the real `documents.list` procedure.
 *
 * For each record shape, one operator is given the same rows as a driver licence, a medical and an
 * insurance proof, and one unit the same rows as its insurance proof. Every consumer must reach the
 * canonical state the pure verdict names. Presentation differs by consumer; the state does not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole, operatorForUserInScope } from "./db";
import { composeReadiness } from "./readinessComposer";
import { widgetReaderFor } from "./widgetSources";
import { loadExceptionSources } from "./surfacesService";
import { deriveExceptions } from "./_core/exceptionCentre";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { complianceRequirementValidity, type ComplianceDocumentRow } from "./_core/complianceDocumentValidity";
import type { ValidityState } from "./_core/documentValidity";
import type { ResolveTask } from "./_core/widgetDashboard";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
afterAll(async () => { await pool?.end(); });

const DAY = 86_400_000;
const at = (n: number | null | undefined) => (n == null ? null : new Date(Date.now() + n * DAY));
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
let userSeq = 380000 + Math.floor(Math.random() * 50000);
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

type Row = { status: "needs_review" | "verified" | "rejected"; expires: number | null; issued?: number | null; captured: number };

/** The record shapes, kept well away from any day boundary so the real clock cannot move them. */
const SHAPES: { name: string; rows: Row[] }[] = [
  { name: "verified and in force", rows: [{ status: "verified", expires: 200, captured: -30 }] },
  { name: "verified and expired", rows: [{ status: "verified", expires: -3, captured: -300 }] },
  { name: "verified, not yet effective", rows: [{ status: "verified", expires: 400, issued: 5, captured: -1 }] },
  { name: "verified, no expiry recorded", rows: [{ status: "verified", expires: null, captured: -30 }] },
  { name: "only uploaded", rows: [{ status: "needs_review", expires: 400, captured: -1 }] },
  { name: "only uploaded, its own date past", rows: [{ status: "needs_review", expires: -2, captured: -1 }] },
  { name: "only rejected", rows: [{ status: "rejected", expires: 400, captured: -1 }] },
  { name: "superseded by a newer verified correction that has expired", rows: [{ status: "verified", expires: 400, captured: -30 }, { status: "verified", expires: -5, captured: -1 }] },
  { name: "verified in force beside a newer upload with a later date", rows: [{ status: "verified", expires: 100, captured: -30 }, { status: "needs_review", expires: 800, captured: -1 }] },
];

async function file(ownerType: "operator" | "unit" | "trailer", ownerId: number, docType: string, rows: readonly Row[]) {
  for (const r of rows) {
    await pool.execute(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, issuedAt, expiresAt, verificationStatus) VALUES (?,?,?,?,?,?,?,?)",
      [ownerType, ownerId, docType, `${docType} ${rnd()}`, at(r.captured), at(r.issued), at(r.expires), r.status]);
  }
}

/** The canonical verdict for the rows, computed the pure way, at the moment of asking. */
const canonical = (rows: readonly Row[], docType: string) =>
  complianceRequirementValidity(rows.map((r, i): ComplianceDocumentRow => ({
    id: i + 1, docType, title: docType, issuedAt: at(r.issued), expiresAt: at(r.expires), verificationStatus: r.status, capturedAt: at(r.captured)!,
  })), [docType], new Date());

/** A single-tenant dispatcher with an operator record, a unit, and a commercial-auto policy covering both. */
async function world() {
  const userId = userSeq++;
  for (const role of ["dispatcher", "office"] as const) await grantUserRole({ userId, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name) VALUES (?, ?)", [userId, `Op ${rnd()}`]);
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [`U-${rnd()}`]);
  const financialEntityId = 700000 + Math.floor(Math.random() * 200000);
  const pol = await callerFor(userId).insurance.policyRecord({
    financialEntityId, policyType: "commercial_auto", insurerName: "XYZ", policyNumber: `PN-${rnd()}`,
    effectiveAt: at(-100)!, expiresAt: at(265)!, coverages: [{ coverageType: "commercial_auto", limitAmount: 5_000_000, additionalInsuredEndorsement: true }],
  });
  await callerFor(userId).insurance.coverageAssign({ policyRef: pol.policyRef, entities: [{ entityType: "unit", entityId: u.insertId }, { entityType: "operator", entityId: op.insertId }], coveredFrom: at(-100)! });
  await callerFor(userId).insurance.coverageVerify({ policyRef: pol.policyRef, outcome: "coverage_verified" });
  return { userId, operatorId: op.insertId, unitId: u.insertId, financialEntityId };
}

async function tile(userId: number) {
  const read = widgetReaderFor(
    { userId, tenantId: SINGLE_TENANT_ID, roleKey: "DISPATCHER", permissions: [] } as never,
    id => callerFor(id) as never,
    () => operatorForUserInScope(userId, { tenantId: SINGLE_TENANT_ID } as never),
  );
  const p = await read({
    order: 0, instanceRef: "docs", widgetKey: "documentExpiry", variant: "list", procedure: "documents.list", subjectRef: null,
    options: { warnDays: 30, limit: 30 }, deviceLocal: false, maxStaleMinutes: null, servedFromCache: false,
  } as ResolveTask);
  expect(p.state).toBe("ok");
  if (p.state !== "ok") throw new Error("unreachable");
  return (p.value as { documents: { docType: string; state: ValidityState; group: string }[] }).documents;
}

async function coverageProof(userId: number, financialEntityId: number, entityType: "unit" | "operator" | "trailer", entityId: number) {
  const r = await callerFor(userId).insurance.coverageForEntity({ financialEntityId, entityType, entityId, coverageTypes: ["commercial_auto"] });
  return r.assessments[0]!;
}

/** The dispatch mappings, written out once as a table — not re-derived from dates. */
const LICENCE_CODE: Record<ValidityState, string | null> = {
  in_force: null, expiring: null, expired: "operator_licence_expired", rejected: "operator_licence_missing", none: "operator_licence_missing",
  not_yet_effective: "operator_licence_missing", unverified: "operator_licence_unknown", incomplete: "operator_licence_unknown",
};
const MEDICAL: Record<ValidityState, "yes" | "no" | "unknown"> = {
  in_force: "yes", expiring: "yes", expired: "no", rejected: "no", not_yet_effective: "no", unverified: "unknown", incomplete: "unknown", none: "unknown",
};

d("same records, every production consumer, one verdict", () => {
  it.each(SHAPES)("$name", async ({ rows }) => {
    const w = await world();
    for (const docType of ["driver_licence", "medical_fitness", "insurance_proof"]) await file("operator", w.operatorId, docType, rows);
    await file("unit", w.unitId, "insurance_proof", rows);
    const v = canonical(rows, "driver_licence");
    const lapsed = v.claimLapsed;

    // The tile: one row per type, each the canonical state.
    const shown = await tile(w.userId);
    for (const docType of ["driver_licence", "medical_fitness", "insurance_proof"]) {
      expect(shown.find(r => r.docType === docType)?.state, `tile ${docType}`).toBe(v.state);
    }

    // Dispatch: the licence blocker and the medical finding map the same state.
    const readiness = await composeReadiness({ operatorId: w.operatorId, unitId: w.unitId, trailerId: null, jobId: null });
    const licence = readiness.eligibility.blockers.filter(b => b.code.startsWith("operator_licence")).map(b => b.code);
    expect(licence).toEqual(lapsed ? ["operator_licence_expired"] : LICENCE_CODE[v.state] ? [LICENCE_CODE[v.state]] : []);
    const medicalFinding = readiness.contributions.find(c => c.finding.startsWith("Medical fitness:"))?.finding;
    const eligible = lapsed ? "no" : MEDICAL[v.state];
    expect(medicalFinding).toBe(`Medical fitness: ${eligible}`);

    // compliance.medicalEligibility says what the composer said.
    expect((await callerFor(w.userId).compliance.medicalEligibility({ operatorId: w.operatorId })).eligible).toBe(eligible);

    // The insurance office, for the unit and for the operator, names the same proof state.
    for (const [type, id] of [["unit", w.unitId], ["operator", w.operatorId]] as const) {
      expect((await coverageProof(w.userId, w.financialEntityId, type, id)).proof, `${type} proof`).toMatchObject({ source: "compliance_document", state: v.state });
    }
  }, 30_000);
});

d("insurance proof selection is scoped to the entity's own records", () => {
  it("a trailer's proof with the unit's id is not the unit's proof, and neither is another unit's", async () => {
    const w = await world();
    const [other] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [`U-${rnd()}`]);
    await file("trailer", w.unitId, "insurance_proof", [{ status: "verified", expires: 300, captured: -5 }]);
    await file("unit", other.insertId, "insurance_proof", [{ status: "verified", expires: 300, captured: -5 }]);
    const a = await coverageProof(w.userId, w.financialEntityId, "unit", w.unitId);
    expect(a).toMatchObject({ status: "document_missing", proof: null });
  }, 30_000);

  it("an insurance card is accepted where a proof is, in both the insurance office and dispatch", async () => {
    const w = await world();
    await file("unit", w.unitId, "insurance_proof", [{ status: "verified", expires: -10, captured: -300 }]);
    await file("unit", w.unitId, "insurance_card", [{ status: "verified", expires: 300, captured: -5 }]);
    expect((await coverageProof(w.userId, w.financialEntityId, "unit", w.unitId))).toMatchObject({ status: "coverage_verified", proof: { state: "in_force" } });
  }, 30_000);

  it("medical eligibility reads only that operator's rows", async () => {
    const w = await world();
    const [someoneElse] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name) VALUES (?)", [`Op ${rnd()}`]);
    await file("operator", someoneElse.insertId, "medical_fitness", [{ status: "verified", expires: 300, captured: -5 }]);
    expect((await callerFor(w.userId).compliance.medicalEligibility({ operatorId: w.operatorId })).eligible).toBe("unknown");
  }, 30_000);
});

d("the exception centre raises expiry from the verdict, over the owner's whole history", () => {
  it("a superseded licence beside its renewal in force raises no expiry; a lone lapsed one does", async () => {
    const w = await world();
    await file("operator", w.operatorId, "driver_licence", [
      { status: "verified", expires: -20, captured: -400 },
      { status: "verified", expires: 300, captured: -25 },
    ]);
    const [lapsed] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name) VALUES (?)", [`Op ${rnd()}`]);
    await file("operator", lapsed.insertId, "driver_licence", [{ status: "verified", expires: -20, captured: -400 }]);

    const xs = deriveExceptions(await loadExceptionSources(new Date()));
    const about = (id: number) => xs.filter(x => x.subjectType === "operator" && x.subjectId === id && x.key.startsWith("cred:")).map(x => x.key.split(":").pop());
    expect(about(w.operatorId)).toEqual([]);
    expect(about(lapsed.insertId)).toEqual(["expired"]);
  }, 30_000);
});

d("foreign TDG recognition requires the named document in force", () => {
  it("refuses a verified certificate that has expired, or that has no expiry recorded", async () => {
    const roles: DomainRole[] = ["safety", "hr", "office", "management"];
    const role = roles.find(r => authorize({ userId: 1, roles: [r], permission: "compliance.credential.verify" }).allowed)!;
    const actor = userSeq++;
    await grantUserRole({ userId: actor, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
    const learner = userSeq++;
    for (const [expires, why] of [[-10, /in force/], [null, /in force/]] as const) {
      const [doc] = await pool.execute<mysql.ResultSetHeader>(
        "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('user', ?, 'tdg_certificate', 'US TDG', ?, ?, 'verified')",
        [learner, at(-30), at(expires)]);
      await expect(callerFor(actor).academy.foreignTdgRoadRecognize({
        userId: learner, complianceDocumentId: doc.insertId, issuingJurisdiction: "US", vehicleLicenceJurisdiction: "US",
        trainingStandard: "49 CFR 172.700 to 172.704 hazmat training", documentValidInIssuingJurisdiction: true, expiresAt: at(expires ?? 100)!,
      })).rejects.toThrow(why);
    }
  }, 30_000);
});
