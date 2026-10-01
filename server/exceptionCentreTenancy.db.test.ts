/**
 * TEN-EXC-1 — Exception Centre tenant isolation, against a real database.
 *
 * Organization A (people a1, a2) and organization B (b1). For every source that feeds the Exception
 * Centre: A's record reaches A and not B; B's reaches B and not A; a record whose owner is unresolved
 * (dangling link, unstamped device, unresolved proposal, person in two organizations, carrier with no
 * ownership model) reaches nobody, the single tenant included; and a record whose links name two
 * organizations reaches neither. Then the combined surfaces (exceptions, myDay, inbox) and the
 * adversarial cases: a forged organization in the request, a multi-organization caller, resolving
 * another organization's sync conflict.
 *
 * Rules per source: docs/register/TEN_EXC_1_EXCEPTION_CENTRE_TENANCY.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";
import { appRouter } from "./routers";
import { actingScopeFor, getDb } from "./db";
import { loadExceptionSources } from "./surfacesService";
import { ownerOf } from "./exceptionScope";
import type { ExceptionSources } from "./_core/exceptionCentre";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 352_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const MISSING = 1_999_000_000 + Math.floor(Math.random() * 100_000);   // an id no table holds
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const ins = async (q: string, p: unknown[]) => (await pool.execute<mysql.ResultSetHeader>(q, p as never[]))[0].insertId;
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const ROLES = ["management", "office", "dispatcher", "safety", "bookkeeper", "controller", "shop_lead"];

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
/** A real user, a member of each organization given (none = the single tenant), holding `roles`. */
async function person(orgRefs: string[], roles: string[] = ROLES) {
  const userId = seq++;
  await pool.execute("INSERT INTO users (id, openId, name) VALUES (?,?,?)", [userId, `tex-${userId}-${rnd()}`, `P ${userId}`]);
  for (const o of orgRefs) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, o, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
const own = (orgRef: string | null, recordType: string, id: number) => orgRef ? pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [orgRef, recordType, id]) : null;
async function unitOf(o: string | null) { const id = await ins("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]); await own(o, "unit", id); return id; }
async function operatorOf(o: string | null) { const id = await ins("INSERT INTO operators (name) VALUES (?)", [`Op ${rnd()}`]); await own(o, "operator", id); return id; }
const jobOf = (o: string | null) => ins("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture", "Here", o]);
const tripOf = (o: string | null) => ins("INSERT INTO trips (tripNumber, orgRef) VALUES (?,?)", [`TRP-${rnd()}`, o]);
const entityOf = (o: string | null) => ins("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?,?,'corporation','CA-AB',?)", [`FE-${rnd()}`, "Books Ltd", o]);
const vendorOf = (book: string | null) => ins("INSERT INTO vendors (name, category, bookOrgRef) VALUES (?,?,?)", [`Vendor ${rnd()}`, "parts", book]);
const deviceOf = (o: string | null, userId: number, status = "active") => ins("INSERT INTO fieldDevices (deviceRef, userId, orgRef, platform, keyFingerprint, enrolledAt, enrolledByUserId, status) VALUES (?,?,?,'android',?,NOW(),?,?)", [`DEV-${rnd()}`, userId, o, rnd(), userId, status]);
const packageOf = (fieldDeviceId: number | null, state = "hash_verified") => ins("INSERT INTO syncPackages (packageRef, deviceId, fieldDeviceId, queuedAt, state) VALUES (?,?,?,NOW(),?)", [`PKG-${rnd()}`, "dev", fieldDeviceId, state]);
async function proposalOf(tenantId: string | null) {
  const proposalId = `PRP-${rnd()}`;
  await pool.execute("INSERT INTO assistantProposals (tenantId, tenantDerivedFrom, proposalId, formKey, formVersion, title, targetRef, createdByUserId, readBack, readBackAcknowledged, commitState) VALUES (?,?,?,'defect_report',1,'Defect','UNIT',1,'rb',1,'awaiting_readback')",
    [tenantId, tenantId === null ? "legacy_unresolved" : "membership", proposalId]);
  return proposalId;
}
async function certificateOf(userId: number) {
  return ins(`INSERT INTO academyCertificates (certificateRef, userId, courseId, courseVersionId, assignmentId, qualificationCode, credentialBoundary, issuedByUserId, issuedAt, sourceSnapshotRef, policySnapshotHash, certificateHash)
    VALUES (?,?,1,1,1,'TDG_ROAD','employer_certificate',1,NOW(),'S','p','c')`, [`CERT-${rnd()}`, userId]);
}

/** Every source, keyed so a fixture can be found by the reference it carries. */
const KEYS: { [K in keyof ExceptionSources]?: (s: ExceptionSources) => string[] } = {
  criticalDefects: s => s.criticalDefects.map(x => `${x.id}`),
  roadsideOpen: s => s.roadsideOpen.map(x => x.eventRef),
  vendorBills: s => s.vendorBills.map(x => x.billRef),
  purchaseRequests: s => s.purchaseRequests.map(x => x.authorizationRef),
  credentials: s => s.credentials.map(x => `${x.id}`),
  aiProposals: s => s.aiProposals.map(x => x.proposalId),
  aiQuestions: s => s.aiQuestions.map(x => `${x.askedToUserId}`),
  syncConflicts: s => s.syncConflicts.map(x => x.conflictRef),
  revokedDevicesWithQueue: s => s.revokedDevicesWithQueue.map(x => x.deviceRef),
  measurementDevices: s => s.measurementDevices.map(x => x.deviceRef),
  openCalibrationSweeps: s => s.openCalibrationSweeps.map(x => x.sweepRef),
  insurancePolicies: s => s.insurancePolicies.map(x => x.policyRef),
  carrierProfileReviews: s => s.carrierProfileReviews.map(x => x.reviewRef),
  inspectorRequests: s => s.inspectorRequests.map(x => x.requestRef),
  securityIncidents: s => (s.securityIncidents ?? []).map(x => x.incidentRef),
  ungatedAssignments: s => s.ungatedAssignments.map(x => `${x.jobUnitId}`),
  statementsWithFindings: s => s.statementsWithFindings.map(x => x.statementRef),
  tanksOutOfTolerance: s => s.tanksOutOfTolerance.map(x => x.tankRef),
  periodsSoftClosed: s => s.periodsSoftClosed.map(x => `${x.financialEntityId}:${x.period}`),
};
type Source = keyof typeof KEYS;
/** For each source: A's record, B's record, and records that must reach nobody. */
type Case = { a: string; b: string; nobody: string[] };

let A: string, B: string, a1: number, a2: number, b1: number, multi: number;
const cases = {} as Record<Source, Case>;
let extraCreds: { credUserA: string; credTrailerA: string; credJobB: string };
const ref = (p: string) => `${p}-${rnd()}`;

/** One fixture per source per owner. Returns the reference the source reports it under. */
const make = {
  async defect(unitId: number) { return `${await ins("INSERT INTO maintenanceDefects (unitId, title, reportedAt, severity, status) VALUES (?,?,NOW(),'critical','open')", [unitId, `Brakes ${rnd()}`])}`; },
  async roadside(unitId: number, o: { jobId?: number; tripId?: number; operatorId?: number } = {}) {
    const r = ref("RSE"); await pool.execute("INSERT INTO roadsideServiceEvents (eventRef, eventType, unitId, jobId, tripId, operatorId, reportedByUserId, occurredAt, reportedAt, status) VALUES (?,'flat_tire',?,?,?,?,1,NOW(),NOW(),'open')", [r, unitId, o.jobId ?? null, o.tripId ?? null, o.operatorId ?? null]); return r;
  },
  async bill(entityId: number, vendorId: number, o: { unitId?: number; jobId?: number } = {}) {
    const r = ref("BILL"); await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, vendorInvoiceNumber, invoiceDate, receivedAt, totalCents, status, unitId, jobId) VALUES (?,?,?,?,NOW(),NOW(),12345,'needs_approval',?,?)", [r, entityId, vendorId, rnd(), o.unitId ?? null, o.jobId ?? null]); return r;
  },
  async purchase(entityId: number, requester: number, o: { vendorId?: number; unitId?: number; jobId?: number } = {}) {
    const r = ref("PA"); await pool.execute("INSERT INTO purchaseAuthorizations (authorizationRef, financialEntityId, vendorId, unitId, jobId, category, reason, estimatedAmount, requestedByUserId, requestedAt, status) VALUES (?,?,?,?,?,'parts','fixture',250,?,NOW(),'requested')", [r, entityId, o.vendorId ?? null, o.unitId ?? null, o.jobId ?? null, requester]); return r;
  },
  async credential(ownerType: string, ownerId: number) { return `${await ins("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, verificationStatus) VALUES (?,?,'h2s_alive',?,NOW(),'needs_review')", [ownerType, ownerId, `H2S ${rnd()}`])}`; },
  /** Grouped by addressee, so each question is addressed to its own fresh person. */
  async question(proposalId: string) {
    const to = seq++; await pool.execute("INSERT INTO assistantQuestions (questionRef, proposalId, fieldKey, question, reason, askedToUserId, status) VALUES (?,?,'odometer','What was the odometer?','missing_required',?,'pending')", [ref("Q"), proposalId, to]); return `${to}`;
  },
  async conflict(fieldDeviceId: number, syncPackageId: number | null = null) {
    const r = ref("CONF"); await pool.execute("INSERT INTO syncConflicts (conflictRef, fieldDeviceId, syncPackageId, recordType, recordRef, deviceBaseVersion, serverVersion, conflictingFieldsJson, deviceValuesJson, serverValuesJson, detectedAt) VALUES (?,?,?,'daily_log',?,1,2,'[]','{}','{}',NOW())", [r, fieldDeviceId, syncPackageId, `LOG-${rnd()}`]); return r;
  },
  async revokedDevice(o: string | null, userId: number) {
    const id = await deviceOf(o, userId, "revoked"); await packageOf(id, "queued");
    return (await pool.execute<mysql.RowDataPacket[]>("SELECT deviceRef FROM fieldDevices WHERE id = ?", [id]))[0][0]!.deviceRef as string;
  },
  async measurementDevice(entityId: number) { const r = ref("MD"); const id = await ins("INSERT INTO measurementDevices (deviceRef, financialEntityId, deviceType, measures, unitOfMeasure, status) VALUES (?,?,'truck_scale','mass','kg','active')", [r, entityId]); return { ref: r, id }; },
  async sweep(measurementDeviceId: number) { const r = ref("SWP"); await pool.execute("INSERT INTO calibrationSweeps (sweepRef, measurementDeviceId, calibrationEventId, suspectFrom, suspectTo, eventType, explanation, runByUserId, state) VALUES (?,?,1,NOW(),NOW(),'failed','fixture',1,'open')", [r, measurementDeviceId]); return r; },
  async policy(entityId: number) { const r = ref("POL"); await pool.execute("INSERT INTO insurancePolicies (policyRef, financialEntityId, policyType, insurerId, policyNumber, effectiveAt, expiresAt) VALUES (?,?,'cargo',1,?,NOW(),DATE_ADD(NOW(), INTERVAL 10 DAY))", [r, entityId, rnd()]); return r; },
  async review(entityId: number) { const r = ref("CPR"); await pool.execute("INSERT INTO carrierProfileReviews (reviewRef, financialEntityId, jurisdiction, profileObtainedAt) VALUES (?,?,'AB',DATE_ADD(NOW(), INTERVAL 1 DAY))", [r, entityId]); return r; },
  async inspector(subjectUserId: number, certificateId: number) {
    const r = ref("INSP"); await pool.execute("INSERT INTO academyInspectorRequests (requestRef, issuingAuthority, requestDatedAt, dueAt, subjectUserId, certificateId, state) VALUES (?,'Transport Canada',NOW(),DATE_ADD(NOW(), INTERVAL 3 DAY),?,?,'received')", [r, subjectUserId, certificateId]); return r;
  },
  async incident(o: string) { const r = ref("SEC"); await pool.execute("INSERT INTO securityIncidents (orgRef, incidentRef, incidentType, title, discoveredAt, discoveredByUserId) VALUES (?,?,'lost_device',?,NOW(),1)", [o, r, `Lost tablet ${r}`]); return r; },
  async assignment(jobId: number, unitId: number, o: { operatorId?: number; checkOrg?: string | null } = {}) {
    const checkId = o.checkOrg === undefined ? null : await ins("INSERT INTO dispatchEligibilityChecks (operatorId, verdict, fingerprint, evaluatedAt, orgRef) VALUES (1,'blocked',?,NOW(),?)", [rnd(), o.checkOrg]);
    return `${await ins("INSERT INTO jobUnits (jobId, unitId, operatorId, role, joinedAt, enforcementModeAtCreate, eligibilityCheckId) VALUES (?,?,?,'primary',NOW(),'advisory',?)", [jobId, unitId, o.operatorId ?? null, checkId])}`;
  },
  async statement(entityId: number) {
    const r = ref("STMT"); const id = await ins("INSERT INTO fuelStatements (statementRef, financialEntityId, fuelAccountId, provider, periodStart, periodEnd, contentHash, importedByUserId, importedAt) VALUES (?,?,1,'Cardlock',NOW(),NOW(),?,1,DATE_ADD(NOW(), INTERVAL 1 DAY))", [r, entityId, rnd()]);
    await pool.execute("INSERT INTO fuelStatementLines (fuelStatementId, lineNo, transactionAt, total, matchOutcome) VALUES (?,1,NOW(),80,'unmatched')", [id]); return r;
  },
  async tank(entityId: number) {
    const r = ref("TANK"); const id = await ins("INSERT INTO bulkFuelTanks (tankRef, financialEntityId, name, jurisdiction, fuelType, capacityLitres) VALUES (?,?,?,'CA-AB','diesel',5000)", [r, entityId, `Yard ${r}`]);
    await pool.execute("INSERT INTO bulkFuelReadings (bulkFuelTankId, readAt, litresOnHand, method, readByUserId) VALUES (?,DATE_SUB(NOW(), INTERVAL 2 DAY),3000,'stick',1),(?,NOW(),1000,'stick',1)", [id, id]); return r;
  },
  async softClose(entityId: number) { await pool.execute("INSERT INTO periodCloses (financialEntityId, period, action, reason, byUserId, at) VALUES (?,'2026-08','soft_close','fixture',1,NOW())", [entityId]); return `${entityId}:2026-08`; },
};

const sourcesFor = async (userId: number) => loadExceptionSources(new Date(), await actingScopeFor(userId));
const SINGLE = { tenantId: "default" };

d("TEN-EXC-1: every Exception Centre source is its organization's", () => {
  beforeAll(async () => {
    A = await org(); B = await org();
    a1 = await person([A]); a2 = await person([A]); b1 = await person([B]);
    multi = await person([A, B]);
    const [uA, uB, uLegacy] = [await unitOf(A), await unitOf(B), await unitOf(null)];
    const [jA, jB, tB, opB] = [await jobOf(A), await jobOf(B), await tripOf(B), await operatorOf(B)];
    const [opA] = [await operatorOf(A)];
    const [eA, eB] = [await entityOf(A), await entityOf(B)];
    const [vA, vB] = [await vendorOf(A), await vendorOf(B)];

    cases.criticalDefects = { a: await make.defect(uA), b: await make.defect(uB), nobody: [await make.defect(MISSING)] };
    cases.roadsideOpen = { a: await make.roadside(uA), b: await make.roadside(uB), nobody: [await make.roadside(uA, { jobId: jB }), await make.roadside(uA, { tripId: tB }), await make.roadside(uA, { operatorId: opB }), await make.roadside(MISSING)] };
    cases.vendorBills = { a: await make.bill(eA, vA), b: await make.bill(eB, vB), nobody: [await make.bill(eA, vB), await make.bill(eA, vA, { unitId: uB }), await make.bill(eA, vA, { jobId: jB }), await make.bill(MISSING, vA)] };
    cases.purchaseRequests = { a: await make.purchase(eA, a2), b: await make.purchase(eB, b1), nobody: [await make.purchase(eA, a2, { jobId: jB }), await make.purchase(eA, a2, { vendorId: vB }), await make.purchase(eA, a2, { unitId: uB }), await make.purchase(MISSING, a2)] };
    cases.credentials = {
      a: await make.credential("operator", opA), b: await make.credential("operator", opB),
      nobody: [await make.credential("unit", MISSING), await make.credential("carrier", 1), await make.credential("user", multi), await make.credential("user", MISSING), await make.credential("operator", MISSING)],
    };
    extraCreds = { credUserA: await make.credential("user", a2), credTrailerA: await make.credential("trailer", uA), credJobB: await make.credential("job", jB) };
    cases.aiProposals = { a: await proposalOf(A), b: await proposalOf(B), nobody: [await proposalOf(null)] };
    cases.aiQuestions = { a: await make.question(await proposalOf(A)), b: await make.question(await proposalOf(B)), nobody: [await make.question(await proposalOf(null)), await make.question(`PRP-MISSING-${rnd()}`)] };
    const [dA, dB, dLegacy] = [await deviceOf(A, a1), await deviceOf(B, b1), await deviceOf(null, a1)];
    cases.syncConflicts = { a: await make.conflict(dA, await packageOf(dA)), b: await make.conflict(dB), nobody: [await make.conflict(dLegacy), await make.conflict(dA, await packageOf(dB)), await make.conflict(dA, await packageOf(null)), await make.conflict(MISSING)] };
    cases.revokedDevicesWithQueue = { a: await make.revokedDevice(A, a1), b: await make.revokedDevice(B, b1), nobody: [await make.revokedDevice(null, a1)] };
    const [mA, mB, mMissing] = [await make.measurementDevice(eA), await make.measurementDevice(eB), await make.measurementDevice(MISSING)];
    cases.measurementDevices = { a: mA.ref, b: mB.ref, nobody: [mMissing.ref] };
    cases.openCalibrationSweeps = { a: await make.sweep(mA.id), b: await make.sweep(mB.id), nobody: [await make.sweep(mMissing.id), await make.sweep(MISSING)] };
    cases.insurancePolicies = { a: await make.policy(eA), b: await make.policy(eB), nobody: [await make.policy(MISSING)] };
    cases.carrierProfileReviews = { a: await make.review(eA), b: await make.review(eB), nobody: [await make.review(MISSING)] };
    cases.inspectorRequests = {
      a: await make.inspector(a2, await certificateOf(a2)), b: await make.inspector(b1, await certificateOf(b1)),
      nobody: [await make.inspector(multi, await certificateOf(multi)), await make.inspector(a2, await certificateOf(b1)), await make.inspector(MISSING, MISSING)],
    };
    cases.securityIncidents = { a: await make.incident(A), b: await make.incident(B), nobody: [] };
    cases.ungatedAssignments = {
      a: await make.assignment(jA, uA, { operatorId: opA, checkOrg: A }), b: await make.assignment(jB, uB),
      nobody: [await make.assignment(jA, uB), await make.assignment(jA, uA, { operatorId: opB }), await make.assignment(jA, uA, { checkOrg: B }), await make.assignment(jA, uA, { checkOrg: null }), await make.assignment(MISSING, uA)],
    };
    cases.statementsWithFindings = { a: await make.statement(eA), b: await make.statement(eB), nobody: [await make.statement(MISSING)] };
    cases.tanksOutOfTolerance = { a: await make.tank(eA), b: await make.tank(eB), nobody: [await make.tank(MISSING)] };
    cases.periodsSoftClosed = { a: await make.softClose(eA), b: await make.softClose(eB), nobody: [await make.softClose(MISSING)] };
    void uLegacy;
  }, 120_000);

  it("covers every source the Exception Centre reads (a new source must get a rule and a case)", async () => {
    const all = await loadExceptionSources(new Date(), SINGLE);
    const arrays = Object.keys(all).filter(k => Array.isArray((all as Record<string, unknown>)[k]));
    expect(arrays.sort()).toEqual(Object.keys(KEYS).sort());
  });

  for (const source of Object.keys(KEYS) as Source[]) {
    it(`${source}: A's to A, B's to B, unresolved or mixed-organization records to nobody`, async () => {
      const c = cases[source];
      const [sa, sa2, sb, sd] = await Promise.all([sourcesFor(a1), sourcesFor(a2), sourcesFor(b1), loadExceptionSources(new Date(), SINGLE)]);
      const [ka, ka2, kb, kd] = [sa, sa2, sb, sd].map(s => KEYS[source]!(s));
      expect(ka).toContain(c.a);
      expect(ka2).toContain(c.a);   // a colleague in the same organization sees the same record
      expect(ka).not.toContain(c.b);
      expect(kb).toContain(c.b);
      expect(kb).not.toContain(c.a);
      for (const x of c.nobody) {
        expect(ka, `${source} ${x} reached A`).not.toContain(x);
        expect(kb, `${source} ${x} reached B`).not.toContain(x);
        expect(kd, `${source} ${x} reached the single tenant`).not.toContain(x);
      }
      expect(kd).not.toContain(c.a);
      expect(kd).not.toContain(c.b);
    });
  }

  it("credentials: a person's own credential is their organization's; a trailer is its unit's; a job's is the job's", async () => {
    const { credUserA, credTrailerA, credJobB } = extraCreds;
    const [ka, kb] = await Promise.all([sourcesFor(a1), sourcesFor(b1)]).then(xs => xs.map(s => s.credentials.map(c => `${c.id}`)));
    expect(ka).toEqual(expect.arrayContaining([credUserA, credTrailerA]));
    expect(kb).not.toContain(credUserA);
    expect(kb).not.toContain(credTrailerA);
    expect(kb).toContain(credJobB);
    expect(ka).not.toContain(credJobB);
  });

  it("resolves owners deterministically: unowned → the single tenant, dangling → unresolved, two memberships → unresolved", async () => {
    const db = (await getDb())!;
    const one = async (expr: ReturnType<typeof ownerOf.unit>) => ((await db.execute(sql`SELECT ${expr} AS o`)) as unknown as [{ o: string | null }[]])[0][0]!.o;
    const legacyUnit = await unitOf(null), lone = await person([]);
    expect(await one(ownerOf.unit(sql`${legacyUnit}`))).toBe("default");
    expect(await one(ownerOf.unit(sql`${MISSING}`))).toBeNull();
    expect(await one(ownerOf.user(sql`${lone}`, new Date()))).toBe("default");
    expect(await one(ownerOf.user(sql`${a1}`, new Date()))).toBe(A);
    expect(await one(ownerOf.user(sql`${multi}`, new Date()))).toBeNull();
    expect(await one(ownerOf.user(sql`${MISSING}`, new Date()))).toBeNull();
    expect(await one(ownerOf.device(sql`${await deviceOf(null, a1)}`))).toBeNull();
    expect(await one(ownerOf.proposal(sql`${await proposalOf(null)}`))).toBeNull();
  });
});

d("TEN-EXC-1: the combined surfaces and the adversarial cases", () => {
  it("A's Exception Centre, My Day and inbox carry none of B's records, and do carry A's", async () => {
    const bRefs = Object.values(cases).map(c => c.b);
    const aRefs = Object.values(cases).map(c => c.a);
    const ex = JSON.stringify(await callerFor(a1).surfaces.exceptions({ limit: 500 }));
    const day = JSON.stringify(await callerFor(a1).surfaces.myDay());
    const inbox = JSON.stringify(await callerFor(a1).surfaces.inbox());
    for (const r of bRefs.filter(r => r.length > 8)) {   // ids are short numbers; refs are unique strings
      expect(ex, `B's ${r} in A's exceptions`).not.toContain(r);
      expect(day, `B's ${r} in A's My Day`).not.toContain(r);
      expect(inbox, `B's ${r} in A's inbox`).not.toContain(r);
    }
    expect(aRefs.filter(r => r.length > 8).some(r => ex.includes(r))).toBe(true);
    // The inbox's approval and conflict slices are the same sources, under the same rules.
    expect(inbox).toContain(cases.syncConflicts.a);
    expect(inbox).toContain(cases.purchaseRequests.a);
    expect(JSON.stringify(await callerFor(b1).surfaces.inbox())).not.toContain(cases.syncConflicts.a);
  });

  it("refuses an organization named in the request rather than honouring or ignoring it", async () => {
    for (const forged of [{ tenantId: B }, { orgRef: B }, { organizationId: B }, { scope: { tenantId: B } }]) {
      await expect(callerFor(a1).surfaces.exceptions({ limit: 50, ...forged } as never)).rejects.toThrow();
    }
  });

  it("gives a person in two organizations nothing until which one they act for is established", async () => {
    await expect(callerFor(multi).surfaces.exceptions({ limit: 50 })).rejects.toThrow(/organizations/);
    await expect(callerFor(multi).surfaces.myDay()).rejects.toThrow(/organizations/);
  });

  it("does not let A resolve B's sync conflict, or anyone resolve one whose device proves no organization", async () => {
    const res = (u: number, conflictRef: string) => callerFor(u).sync.resolveConflict({ conflictRef, resolution: "resolved_server", note: "fixture resolution" });
    await expect(res(a1, cases.syncConflicts.b)).rejects.toThrow(/not found/i);
    await expect(res(b1, cases.syncConflicts.nobody[0]!)).rejects.toThrow(/not found/i);
    await expect(res(a1, cases.syncConflicts.nobody[0]!)).rejects.toThrow(/not found/i);
    const fresh = await make.conflict(await deviceOf(B, b1));
    expect((await res(b1, fresh)).status).toBe("resolved_server");
  });
});
