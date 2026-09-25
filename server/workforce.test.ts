import { vi, beforeAll, describe, expect, it } from "vitest";

// F1.1 — this suite exercises a deployment that is one ownership domain (no organization yet), where the
// ownerless serialized tools are provably the single tenant's. The predicate itself, and the refusal once organizations
// exist, are proved against the real database in tenantScopeFinance.db.test.ts.
vi.mock("./ownershipDomain", async importOriginal => ({ ...(await importOriginal<typeof import("./ownershipDomain")>()), singleOwnershipDomain: async () => true, requireProvableOwnership: async () => undefined }));
import mysql from "mysql2/promise";
import { COURSE_CREDENTIALS, competencyDecision, hireReadiness, offboardingClose, onboardingGaps, probationDecision, screeningRecordDecision, trainingVerification } from "./_core/workforce";
import { appRouter } from "./routers";
// Onboarding due dates are startDate + dueDays and the gaps are read against the
// real clock, so a start date fixed on the calendar goes overdue the day the
// calendar passes it (which is how this was found, at 01:25 UTC on the 17th).
const START = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 7 * 86_400_000);
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const at = (iso: string) => new Date(iso);

describe("a hire waits for its screenings, and a pass needs evidence", () => {
  it("names pending and failed screenings, and a pass recorded without evidence", () => {
    const r = hireReadiness([{ kind: "driver_abstract", required: true, result: "pass", evidenceRecordId: 9 }, { kind: "references", required: true, result: "pass", evidenceRecordId: null }, { kind: "road_test", required: true, result: "fail", evidenceRecordId: 3 }], ["driver_abstract", "references", "road_test", "right_to_work"]);
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(["references: passed without evidence on record", "road test: failed", "Pending required screening: right to work"]);
    expect(hireReadiness([{ kind: "references", required: true, result: "pass", evidenceRecordId: 1 }], ["references"])).toEqual({ ready: true, blockers: [], pending: [] });
    expect(screeningRecordDecision({ result: "pass", evidenceRecordId: null, required: true }).refusal).toContain("needs its evidence record");
    expect(screeningRecordDecision({ result: "not_required", evidenceRecordId: null, required: true }).refusal).toContain("not marked not-required");
  });
});

describe("onboarding gaps, training into the registry, competency and probation", () => {
  it("counts a credential task as open until verified, and names overdue ones", () => {
    const now = at("2026-09-10T00:00:00Z");
    const g = onboardingGaps([
      { taskCode: "orientation", title: "Orientation", required: true, dueBy: at("2026-09-01T00:00:00Z"), completedAt: at("2026-08-30T00:00:00Z"), credentialDocType: null, verifiedAt: null },
      { taskCode: "h2s", title: "H2S Alive", required: true, dueBy: at("2026-09-05T00:00:00Z"), completedAt: at("2026-09-04T00:00:00Z"), credentialDocType: "h2s_alive", verifiedAt: null },
      { taskCode: "ride", title: "Ride-along", required: true, dueBy: at("2026-09-05T00:00:00Z"), completedAt: null, credentialDocType: null, verifiedAt: null },
      { taskCode: "extra", title: "Optional", required: false, dueBy: null, completedAt: null, credentialDocType: null, verifiedAt: null },
    ], now);
    expect(g.complete).toBe(false);
    expect(g.missing).toEqual([{ taskCode: "h2s", title: "H2S Alive", overdue: false, awaitingVerification: true }, { taskCode: "ride", title: "Ride-along", overdue: true, awaitingVerification: false }]);
    expect(g.summary).toBe("2 required task(s) open, 1 overdue, 1 awaiting verification");
  });
  it("verifies training into a credential only with evidence and by a second person; an unmapped course is training only", () => {
    const ok = trainingVerification({ courseCode: "H2S_ALIVE", evidenceRecordId: 5, expiresAt: null, completedAt: at("2026-09-01T00:00:00Z"), recordedByUserId: 1, verifierUserId: 2 });
    expect(ok).toMatchObject({ permitted: true, refusals: [], credential: { docType: "h2s_alive" } });
    expect(ok.credential!.expiresAt!.toISOString().slice(0, 10)).toBe("2029-08-31");
    const bad = trainingVerification({ courseCode: "H2S_ALIVE", evidenceRecordId: null, expiresAt: null, completedAt: at("2026-09-01T00:00:00Z"), recordedByUserId: 1, verifierUserId: 1 });
    expect(bad.refusals).toEqual(["Verification needs the certificate in the evidence vault", "The person who recorded the training may not verify it"]);
    const unmapped = trainingVerification({ courseCode: "DEFENSIVE_DRIVING_X", evidenceRecordId: 5, expiresAt: null, completedAt: at("2026-09-01T00:00:00Z"), recordedByUserId: 1, verifierUserId: 2 });
    expect(unmapped).toMatchObject({ permitted: true, credential: null });
    expect(unmapped.refusals[0]).toContain("not mapped to a credential");
    expect(Object.values(COURSE_CREDENTIALS).every(c => typeof c.docType === "string")).toBe(true);
  });
  it("refuses self-declared competency and a jump to senior; refuses a self-decided or dateless probation extension", () => {
    expect(competencyDecision({ workerUserId: 7, signerUserId: 7, level: "competent", priorLevel: null }).refusals).toEqual(["Competency is not self-declared"]);
    expect(competencyDecision({ workerUserId: 7, signerUserId: 8, level: "senior", priorLevel: "trainee" }).refusals[0]).toContain("Senior follows competent");
    expect(competencyDecision({ workerUserId: 7, signerUserId: 8, level: "senior", priorLevel: "competent" }).permitted).toBe(true);
    expect(probationDecision({ recommendedByUserId: 1, deciderUserId: 1, recommendation: "confirm", decision: "confirm", extendedTo: null, probationEndsAt: at("2026-12-01T00:00:00Z") }).refusals).toEqual(["The person who recommended may not decide"]);
    expect(probationDecision({ recommendedByUserId: 1, deciderUserId: 2, recommendation: "extend", decision: "extend", extendedTo: at("2026-11-01T00:00:00Z"), probationEndsAt: at("2026-12-01T00:00:00Z") }).refusals[0]).toContain("ends after the current probation end");
  });
  it("closes an offboarding only when every door is shut and the last day has passed", () => {
    const c = offboardingClose({ activeRoles: 2, activeDevices: 1, activeIdentities: 0, toolsOut: 1, finalPayProposed: false, lastDay: at("2026-09-30T00:00:00Z"), now: at("2026-09-10T00:00:00Z") });
    expect(c.open).toEqual(["2 role grant(s) still active", "1 field device(s) not revoked", "1 tool(s) still checked out", "Final pay not proposed to payroll", "Last day 2026-09-30 has not passed"]);
    expect(offboardingClose({ activeRoles: 0, activeDevices: 0, activeIdentities: 0, toolsOut: 0, finalPayProposed: true, lastDay: at("2026-09-01T00:00:00Z"), now: at("2026-09-10T00:00:00Z") })).toEqual({ permitted: true, open: [] });
  });
});

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
describe("who hires, who verifies, who signs off, who decides, who revokes", () => {
  it("keeps applicants with HR, verification with HR and safety, competency with supervisors, probation decisions with HR, revocation with HR", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "hr.applicant.manage" }).allowed)).toEqual(["hr"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "hr.training.verify" }).allowed).sort()).toEqual(["hr", "safety"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "hr.competency.signoff" }).allowed).sort()).toEqual(["management", "safety", "shop_lead"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "hr.probation.decide" }).allowed)).toEqual(["hr"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "hr.access.revoke" }).allowed)).toEqual(["hr"]);
    expect(authorize({ userId: 1, roles: ["dispatcher"], permission: "hr.applicant.read" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 3_400_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a person, hired to offboarded", () => {
  it("is screened with evidence, refused a hire while a screening is pending, hired into a plan, credentialed into the registry by a second person, signed off, decided by two people on probation, and offboarded only when every door is shut", async () => {
    const hr = await withRole("hr");
    const safety = await withRole("safety");
    const supervisor = await withRole("shop_lead");
    const dispatcher = await withRole("dispatcher");
    const newUser = nextUser();

    // Applicant: a driver's five required screenings; a pass without evidence is refused; the hire is refused while road test is pending and named.
    const app = await callerFor(hr).workforce.applicantCreate({ fullName: "R. Cardinal", contact: { phone: "780-555-0199" }, roleApplied: "Vac truck operator", source: "referral" });
    expect(app.requiredScreenings).toEqual(["licence_verification", "driver_abstract", "references", "right_to_work", "road_test"]);
    await expect(callerFor(dispatcher).workforce.applicantList()).rejects.toBeTruthy();
    expect((await callerFor(hr).workforce.applicantList()).applicants.find(a => a.applicantRef === app.applicantRef)).toEqual({ applicantRef: app.applicantRef, fullName: "R. Cardinal", roleApplied: "Vac truck operator", status: "screening" }); // no contact in the list
    await expect(callerFor(hr).workforce.screeningRecord({ applicantRef: app.applicantRef, kind: "driver_abstract", result: "pass" })).rejects.toThrow(/needs its evidence record/);
    for (const k of ["licence_verification", "driver_abstract", "references", "right_to_work"] as const) await callerFor(hr).workforce.screeningRecord({ applicantRef: app.applicantRef, kind: k, result: "pass", evidenceRecordId: 1 });
    await expect(callerFor(hr).workforce.applicantDecide({ applicantRef: app.applicantRef, decision: "hired", reason: "Strong references", userId: newUser, startDate: START })).rejects.toThrow(/Pending required screening: road test/);
    const last = await callerFor(hr).workforce.screeningRecord({ applicantRef: app.applicantRef, kind: "road_test", result: "pass", evidenceRecordId: 2 });
    expect(last.readiness.ready).toBe(true);
    const hire = await callerFor(hr).workforce.applicantDecide({ applicantRef: app.applicantRef, decision: "hired", reason: "Strong references, clean abstract", userId: newUser, startDate: START, probationDays: 90 });
    expect(hire).toMatchObject({ status: "hired", tasks: 6 });
    const [op] = await pool.execute<mysql.RowDataPacket[]>("SELECT id, name FROM operators WHERE userId = ?", [newUser]);
    expect(op[0].name).toBe("R. Cardinal");                                   // a driver got an operator record
    await expect(callerFor(hr).workforce.applicantDecide({ applicantRef: app.applicantRef, decision: "declined", reason: "again" })).rejects.toThrow(/is hired/);

    // Onboarding: a credential task needs evidence to complete, and a second person to verify; verification writes the registry document dispatch reads.
    const s0 = await callerFor(hr).workforce.onboardingStatus({ planRef: hire.planRef! });
    expect(s0.summary).toBe("6 required task(s) open");
    await expect(callerFor(hr).workforce.taskComplete({ planRef: hire.planRef!, taskCode: "h2s_alive" })).rejects.toThrow(/evidence vault first/);
    await callerFor(hr).workforce.taskComplete({ planRef: hire.planRef!, taskCode: "h2s_alive", evidenceRecordId: 3 });
    await expect(callerFor(hr).workforce.taskVerify({ planRef: hire.planRef!, taskCode: "h2s_alive" })).rejects.toThrow(/may not verify/);
    const v = await callerFor(safety).workforce.taskVerify({ planRef: hire.planRef!, taskCode: "h2s_alive" });
    expect(v).toMatchObject({ docType: "h2s_alive" });
    const [doc] = await pool.execute<mysql.RowDataPacket[]>("SELECT ownerType, ownerId, docType, verificationStatus, evidenceRecordId, source FROM complianceDocuments WHERE id = ?", [v.complianceDocumentId]);
    expect(doc[0]).toMatchObject({ ownerType: "operator", ownerId: Number(op[0].id), docType: "h2s_alive", verificationStatus: "verified", evidenceRecordId: 3 });
    expect(doc[0].source).toContain(hire.planRef);
    expect((await callerFor(hr).workforce.onboardingStatus({ planRef: hire.planRef! })).summary).toBe("5 required task(s) open");

    // Training recorded by HR, verified by safety: a TDG credential with its expiry; an unmapped course is training only; the same record is not verified twice.
    const trn = await callerFor(hr).workforce.trainingRecord({ userId: newUser, courseCode: "TDG_GROUND", title: "TDG Ground", provider: "Danatec", completedAt: new Date("2026-09-15T00:00:00Z"), certificateNumber: "TDG-88192", evidenceRecordId: 4 });
    expect(trn).toMatchObject({ verificationStatus: "unverified", becomesCredential: "tdg_certificate" });
    await expect(callerFor(hr).workforce.trainingVerify({ trainingRef: trn.trainingRef, decision: "verified" })).rejects.toThrow(/may not verify/);
    const tv = await callerFor(safety).workforce.trainingVerify({ trainingRef: trn.trainingRef, decision: "verified" });
    expect(tv.complianceDocumentId).toBeGreaterThan(0);
    expect(tv.expiresAt?.toISOString().slice(0, 10)).toBe("2029-09-14");
    await expect(callerFor(safety).workforce.trainingVerify({ trainingRef: trn.trainingRef, decision: "verified" })).rejects.toThrow(/Already verified/);
    const other = await callerFor(hr).workforce.trainingRecord({ userId: newUser, courseCode: "WINTER_DRIVING", title: "Winter driving", completedAt: new Date("2026-09-15T00:00:00Z"), evidenceRecordId: 5 });
    expect(other.becomesCredential).toBeNull();
    expect((await callerFor(safety).workforce.trainingVerify({ trainingRef: other.trainingRef, decision: "verified" })).complianceDocumentId).toBeNull();
    const [docs] = await pool.execute<mysql.RowDataPacket[]>("SELECT docType FROM complianceDocuments WHERE ownerType = 'operator' AND ownerId = ? ORDER BY id", [Number(op[0].id)]);
    expect(docs.map(x => x.docType)).toEqual(["h2s_alive", "tdg_certificate"]);

    // Competency by a supervisor, not by the worker; trainee → competent → senior in order.
    await expect(callerFor(supervisor).workforce.competencySignoff({ userId: supervisor, competencyCode: "vac_truck_operation", level: "competent" })).rejects.toThrow(/not self-declared/);
    await expect(callerFor(supervisor).workforce.competencySignoff({ userId: newUser, competencyCode: "vac_truck_operation", level: "senior" })).rejects.toThrow(/Senior follows competent/);
    expect((await callerFor(supervisor).workforce.competencySignoff({ userId: newUser, competencyCode: "vac_truck_operation", level: "competent", note: "Two weeks observed on lease roads" })).level).toBe("competent");

    // Probation: recommended by the supervisor, decided by HR — who may differ; the supervisor cannot decide; the recommender is named on the difference.
    const rec = await callerFor(supervisor).workforce.probationRecommend({ planRef: hire.planRef!, recommendation: "confirm", note: "Reliable, safe, learns fast" });
    await expect(callerFor(supervisor).workforce.probationDecide({ reviewId: rec.reviewId, decision: "confirm", note: "agree" })).rejects.toBeTruthy();
    const dec = await callerFor(hr).workforce.probationDecide({ reviewId: rec.reviewId, decision: "extend", note: "TDG practical not yet observed", extendedTo: new Date("2027-01-15T00:00:00Z") });
    expect(dec).toMatchObject({ decision: "extend", differsFromRecommendation: true });
    expect((await callerFor(hr).workforce.onboardingStatus({ planRef: hire.planRef! })).probationEndsAt?.toISOString().slice(0, 10)).toBe("2027-01-15");

    // Offboarding: opened; the driver still holds a role, a device and a tool; close is refused with each door named; access revoked as one act; the tool returned; then closed.
    await grantUserRole({ userId: newUser, role: "driver", scopeType: "global", grantedByUserId: hr, grantedAt: new Date() });
    await pool.execute("INSERT INTO fieldDevices (deviceRef, userId, platform, keyFingerprint, keystoreAttestation, encryptedStorageAttested, status, enrolledAt, enrolledByUserId, createdAt) VALUES (?, ?, 'ios', ?, 'unknown', 0, 'active', NOW(), ?, NOW())", [`DEV-${newUser}`, newUser, `fp-${newUser}`, hr]);
    const mech = await withRole("mechanic");
    const toolSerial = `T-${newUser}`;
    await callerFor(mech).shop.toolRegister({ serial: toolSerial, description: "Torque wrench" });
    await callerFor(mech).shop.toolCheckout({ serial: toolSerial, workerUserId: newUser });
    const off = await callerFor(hr).workforce.offboardingOpen({ userId: newUser, reason: "resigned", lastDay: new Date("2026-09-01T00:00:00Z") });
    expect((await callerFor(hr).workforce.offboardingOpen({ userId: newUser, reason: "resigned", lastDay: new Date("2026-09-01T00:00:00Z") })).alreadyOpen).toBe(true);
    const st = await callerFor(hr).workforce.offboardingStatus({ offboardingRef: off.offboardingRef });
    expect(st.canClose).toBe(false);
    expect(st.open).toEqual(["1 role grant(s) still active", "1 field device(s) not revoked", "1 tool(s) still checked out", "Final pay not proposed to payroll"]);
    expect(st.toolsOut).toEqual([toolSerial]);
    await expect(callerFor(hr).workforce.offboardingClose({ offboardingRef: off.offboardingRef, finalPayProposed: true })).rejects.toThrow(/Cannot close: 1 role grant\(s\) still active/);
    const rev = await callerFor(hr).workforce.offboardingRevokeAccess({ offboardingRef: off.offboardingRef });
    expect(rev).toEqual({ offboardingRef: off.offboardingRef, rolesRevoked: 1, devicesRevoked: 1 });
    expect(authorize({ userId: newUser, roles: [], permission: "dispatch.read" }).allowed).toBe(false);
    const [rr] = await pool.execute<mysql.RowDataPacket[]>("SELECT revokeReason FROM userRoleAssignments WHERE userId = ? AND role = 'driver'", [newUser]);
    expect(rr[0].revokeReason).toContain(off.offboardingRef);
    await expect(callerFor(hr).workforce.offboardingClose({ offboardingRef: off.offboardingRef, finalPayProposed: true })).rejects.toThrow(/1 tool\(s\) still checked out/);
    await callerFor(mech).shop.toolReturn({ serial: toolSerial, condition: "good" });
    expect((await callerFor(hr).workforce.offboardingClose({ offboardingRef: off.offboardingRef, finalPayProposed: true })).status).toBe("complete");
  });
});
