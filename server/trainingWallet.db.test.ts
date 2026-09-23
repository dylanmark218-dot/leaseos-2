/**
 * 0172 — the training wallet, renewal and handoff, through the real routers
 * on a migrated database. The numbers in the test names are the checkpoint's
 * required-test list; the pure rules are in _core/credentialLifecycle.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 270_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });
const as = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
const future = (days: number) => new Date(Date.now() + days * 86_400_000);
async function verifiedH2S(worker: number, recorder: number, verifier: number, expiresInDays: number) {
  const r = await as(recorder).trainingWallet[recorder === worker ? "recordOwn" : "recordFor"]({ ...(recorder === worker ? {} : { userId: worker }), code: "H2S_ALIVE", boundary: "external_provider", documentRef: `DOC-${rnd()}`, certificateNumber: `H2S-${rnd()}`, issuedAt: future(-900), expiresAt: future(expiresInDays) } as never) as { holdingRef: string };
  await as(verifier).trainingWallet.verify({ holdingRef: r.holdingRef, method: "document_inspection", verificationSource: "Certificate sighted against ESC wallet card", issuedAt: future(-900), expiresAt: future(expiresInDays) });
  return r.holdingRef;
}

d("training wallet — record, verify, renew", () => {
  it("3. an upload is UNVERIFIED and satisfies nothing; the owner and the recorder cannot verify it; another authorized person can", async () => {
    const A = await org();
    const worker = await member(A, ["driver"]), safety = await member(A, ["safety"]), safety2 = await member(A, ["safety"]), dispatcher = await member(A, ["dispatcher"]);
    const up = await as(worker).trainingWallet.recordOwn({ code: "FIRST_AID", boundary: "external_provider", documentRef: `DOC-${rnd()}`, issuedAt: future(-30), expiresAt: future(1000) });
    expect(up.verificationState).toBe("unverified");
    const view = await as(dispatcher).trainingWallet.operationalView({ userId: worker, codes: ["FIRST_AID"] });
    expect(view.results[0]).toMatchObject({ state: "unverified" });
    expect(view.results[0]!.recovery[0]!.label).toBe("Safety/Admin verification required");
    await expect(as(worker).trainingWallet.verify({ holdingRef: up.holdingRef, method: "document_inspection", verificationSource: "self", issuedAt: future(-30), expiresAt: future(1000) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(safety).trainingWallet.verify({ holdingRef: up.holdingRef, method: "ocr_extraction", verificationSource: "OCR said so", issuedAt: future(-30), expiresAt: future(1000) })).rejects.toThrow(/OCR extraction is not verification/);
    // The recorder may not verify what they recorded.
    const recorded = await as(safety).trainingWallet.recordFor({ userId: worker, code: "H2S_ALIVE", boundary: "external_provider", documentRef: `DOC-${rnd()}`, issuedAt: future(-10), expiresAt: future(1000) });
    await expect(as(safety).trainingWallet.verify({ holdingRef: recorded.holdingRef, method: "document_inspection", verificationSource: "card", issuedAt: future(-10), expiresAt: future(1000) })).rejects.toThrow(/recorded this credential may not also verify/);
    await as(safety2).trainingWallet.verify({ holdingRef: up.holdingRef, method: "document_inspection", verificationSource: "Card sighted", issuedAt: future(-30), expiresAt: future(1000) });
    expect((await as(dispatcher).trainingWallet.operationalView({ userId: worker, codes: ["FIRST_AID"] })).results[0]).toMatchObject({ state: "held" });
  }, 60_000);

  it("4. a renewal supersedes the previous verified credential; history is kept and cannot be deleted or edited", async () => {
    const A = await org();
    const worker = await member(A, ["driver"]), safety = await member(A, ["safety"]);
    const first = await verifiedH2S(worker, worker, safety, 20);
    const second = await verifiedH2S(worker, worker, safety, 1000);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT holdingRef, verificationState, supersededByHoldingRef, supersedesHoldingRef FROM workerQualifications WHERE userId = ? ORDER BY id", [worker]);
    expect(rows.map(r => [r.holdingRef, r.verificationState])).toEqual([[first, "superseded"], [second, "verified"]]);
    expect(rows[0]!.supersededByHoldingRef).toBe(second);
    expect(rows[1]!.supersedesHoldingRef).toBe(first);
    await expect(pool.execute("DELETE FROM workerQualifications WHERE holdingRef = ?", [first])).rejects.toThrow(/history and cannot be deleted/);
    await expect(pool.execute("UPDATE workerQualifications SET expiresAt = '2037-01-01' WHERE holdingRef = ?", [second])).rejects.toThrow(/immutable/);
    const wallet = await as(worker).trainingWallet.myWallet();
    expect(wallet.credentials.filter(c => c.code === "H2S_ALIVE").map(c => c.current)).toEqual([true, false]);
    // The owner's view never carries private notes.
    expect(wallet.credentials.every(c => c.privateNotes === undefined)).toBe(true);
  }, 60_000);

  it("14. no wallet endpoint accepts an Academy completion as evidence for an external credential", async () => {
    const A = await org();
    const worker = await member(A, ["driver"]);
    await expect(as(worker).trainingWallet.recordOwn({ code: "AIR_BRAKE_Q", boundary: "regulator_issued", evidenceKind: "academy_completion" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as(worker).trainingWallet.recordOwn({ code: "AIR_BRAKE_Q", boundary: "study_only" })).rejects.toThrow(/not wallet credentials|regulator issued/);
    await expect(as(worker).trainingWallet.recordOwn({ code: "AIR_BRAKE_Q", boundary: "regulator_issued", expiresAt: future(365) })).rejects.toThrow(/fabricated expiry/);
  }, 30_000);
});

d("renewal reminders and the admin queue", () => {
  it("13/23. the sweep sends each warning once; a second run is suppressed; the request reaches the office queue with what it needs", async () => {
    const A = await org();
    const worker = await member(A, ["driver"]), safety = await member(A, ["safety"]), other = await member(A, ["safety"]);
    await verifiedH2S(worker, worker, safety, 20);
    const first = await as(other).trainingWallet.renewalSweep();
    expect(first.sent).toBeGreaterThanOrEqual(3);
    expect(first.sentKeys.some(k => k.endsWith(`:30:u${worker}`))).toBe(true);
    const again = await as(other).trainingWallet.renewalSweep();
    expect(again.sent).toBe(0);
    expect(again.suppressed).toBe(first.planned);
    const [n] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) c FROM workflowNotifications WHERE recipientUserId = ? AND notificationKey LIKE 'cred-renew:%'", [worker]);
    expect(Number(n[0]!.c)).toBe(1);
    // 10. an Academy-issued TDG road certificate (server-computed expiry) is reminded on too, from academyQualifications.
    const qualRef = `ACAD-QUAL-${rnd()}`;
    await pool.execute("INSERT INTO academyQualifications (qualificationRef, userId, qualificationCode, sourceKind, status, validFrom, expiresAt) VALUES (?,?,'TDG_ROAD','academy_certificate','current',?,?)", [qualRef, worker, future(-1075), future(10)]);
    const tdg = await as(other).trainingWallet.renewalSweep();
    expect(tdg.sentKeys).toContain(`cred-renew:${qualRef}:legal_expiry:14:u${worker}`);
    const inbox = await as(worker).surfaces.inbox();
    expect(inbox.items.some(i => i.title.includes("H2S Alive"))).toBe(true);

    const req = await as(worker).trainingWallet.requestTraining({ qualificationCode: "H2S_ALIVE", reason: "Expiring" });
    expect(req.status).toBe("REQUESTED");
    expect((await as(worker).trainingWallet.requestTraining({ qualificationCode: "H2S_ALIVE" })).reused).toBe(true);
    const queue = await as(safety).trainingWallet.handoffQueue();
    const item = queue.find(q => q.handoffRef === req.handoffRef)!;
    expect(item).toMatchObject({ employee: { userId: worker }, credential: { code: "H2S_ALIVE" }, trigger: "expiring" });
    expect(item.currentExpiry).toBeTruthy();
    expect(item.latestVerified).toBeTruthy();
    expect(item.requestedAt).toBeTruthy();
    expect(item.providerOptions.official.some(o => o.sourceRef === "SRC-ESC-H2S-ALIVE") || item.providerOptions.official.length === 0).toBe(true);
    const mine = await as(worker).trainingWallet.myHandoffs();
    expect(mine.find(h => h.handoffRef === req.handoffRef)!.worker.label).toBe("Requested — with the office");
  }, 90_000);
});

d("handoff and booking never change readiness", () => {
  it("2/21. requested, booked, completed and uploaded all leave the requirement blocked; only verifying the certificate clears it", async () => {
    const A = await org();
    const worker = await member(A, ["driver"]), safety = await member(A, ["safety"]), safety2 = await member(A, ["safety"]), dispatcher = await member(A, ["dispatcher"]);
    const reqCode = `REQ-H2S-${rnd()}`;
    await as(safety).academy.requirementUpsert({ requirementCode: reqCode, title: "H2S Alive for sour sites", qualificationCode: "H2S_ALIVE", enforcement: "block" });
    const check = () => as(dispatcher).academy.dispatchCheck({ userId: worker, requirementCodes: [reqCode] });
    expect((await check()).status).toBe("blocked");
    const h = await as(worker).trainingWallet.requestTraining({ qualificationCode: "H2S_ALIVE" });
    expect((await check()).status).toBe("blocked");
    await as(safety).trainingWallet.handoffUpdate({ handoffRef: h.handoffRef, mark: "contacted", providerContact: "ESC authorized provider" });
    await as(safety).trainingWallet.handoffUpdate({ handoffRef: h.handoffRef, mark: "booked", bookingReference: "BK-1", appointmentAt: future(5), appointmentEndsAt: future(5.3) });
    expect((await check()).status).toBe("blocked");
    await as(worker).trainingWallet.handoffSelfUpdate({ handoffRef: h.handoffRef, to: "TRAINING_COMPLETED" });
    expect((await check()).status).toBe("blocked");
    // Admin cannot declare it complete without a verified credential.
    await expect(as(safety).trainingWallet.handoffUpdate({ handoffRef: h.handoffRef, to: "VERIFIED" })).rejects.toThrow(/not a valid step|verified/i);
    const up = await as(worker).trainingWallet.recordOwn({ code: "H2S_ALIVE", boundary: "external_provider", documentRef: `DOC-${rnd()}`, issuedAt: future(-1), expiresAt: future(1094), handoffRef: h.handoffRef });
    expect((await as(worker).trainingWallet.myHandoffs()).find(x => x.handoffRef === h.handoffRef)!.status).toBe("DOCUMENT_UPLOADED_UNVERIFIED");
    const blocked = await check();
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocking[0]!.state).toBe("unverified");
    await as(safety2).trainingWallet.verify({ holdingRef: up.holdingRef, method: "issuer_registry_check", verificationSource: "ESC registry", issuedAt: future(-1), expiresAt: future(1094) });
    expect((await check()).status).toBe("ready");
    expect((await as(worker).trainingWallet.myHandoffs()).find(x => x.handoffRef === h.handoffRef)!.status).toBe("ACTIVE");
    // 20. the appointment is a projection from the handoff, not a calendar row of its own.
    const cal = await as(worker).calendar.mine({ from: future(0), days: 14 });
    const ev = cal.events.find(e => e.source.sourceType === "externalTrainingHandoff" && e.source.sourceRef === h.handoffRef);
    expect(ev).toBeTruthy();
    expect(ev!.deepLink).toBe(`/externalTrainingHandoff/${encodeURIComponent(h.handoffRef)}`);
    expect(Object.keys(appRouter._def.procedures).filter(k => k.startsWith("calendar.") && /create|write|add|set|update/i.test(k))).toEqual([]);
  }, 120_000);

  it("17. a verified but provincially restricted Class 1 does not satisfy a requirement marked interprovincial", async () => {
    const A = await org();
    const worker = await member(A, ["driver"]), safety = await member(A, ["safety"]), safety2 = await member(A, ["safety"]), dispatcher = await member(A, ["dispatcher"]);
    const ip = `REQ-C1IP-${rnd()}`, ab = `REQ-C1AB-${rnd()}`;
    await as(safety).academy.requirementUpsert({ requirementCode: ip, title: "Class 1 — interprovincial", qualificationCode: "DRIVER_LICENCE_CLASS_1", enforcement: "block", conditions: { interprovincial: true } });
    await as(safety).academy.requirementUpsert({ requirementCode: ab, title: "Class 1 — Alberta", qualificationCode: "DRIVER_LICENCE_CLASS_1", enforcement: "block" });
    const lic = await as(worker).trainingWallet.recordOwn({ code: "DRIVER_LICENCE_CLASS_1", boundary: "regulator_issued", documentRef: `DOC-${rnd()}`, backDocumentRef: `DOC-${rnd()}`, restrictions: ["PROVINCIAL_RESTRICTION"], issuedAt: future(-10), expiresAt: future(1500) });
    await as(safety2).trainingWallet.verify({ holdingRef: lic.holdingRef, method: "original_sighted", verificationSource: "Licence sighted, restriction printed", issuedAt: future(-10), expiresAt: future(1500) });
    const r = await as(dispatcher).academy.dispatchCheck({ userId: worker, requirementCodes: [ip, ab] });
    expect(r.satisfied).toEqual([ab]);
    expect(r.blocking[0]).toMatchObject({ code: ip, state: "restricted" });
    expect(r.blocking[0]!.detail).toContain("Full (unrestricted) licence authority required");
  }, 60_000);
});

d("study never becomes a credential", () => {
  it("1/15. an Air Brake Q study track completes, but no certificate, Academy qualification or wallet credential can come from it; practical self sign-off is refused", async () => {
    const A = await org();
    // A shop lead holds academy.evaluate — so the refusal below is the self-sign-off rule, not a missing permission.
    const worker = await member(A, ["driver", "shop_lead"]), safety = await member(A, ["safety"]);
    const enrol = await as(worker).academy.studyEnroll({ courseCode: "AIRBRAKE-Q" });
    expect(enrol.notice).toContain("never creates a Q endorsement");
    const practice = await as(worker).academy.practiceOpen({ assignmentRef: enrol.assignmentRef, kind: "PRACTICE" });
    const q = practice.questions[0]!;
    const fb = await as(worker).academy.practiceAnswer({ attemptRef: practice.attemptRef, questionCode: q.questionCode, presentedIndex: 0 });
    expect(fb.source.sourceRef).toBeTruthy();
    expect(fb.explanation).toBeTruthy();
    const graded = await as(worker).academy.practiceSubmit({ attemptRef: practice.attemptRef, answers: {} });
    expect(graded.consequences).toMatchObject({ advancesAssignment: false, affectsReadiness: false });
    const detail = await as(worker).academy.assignmentDetail({ assignmentRef: enrol.assignmentRef });
    for (const m of detail.modules) await as(worker).academy.moduleComplete({ assignmentRef: enrol.assignmentRef, moduleCode: m.moduleCode });
    await expect(as(worker).academy.practicalSignoff({ assignmentRef: enrol.assignmentRef, competencyCode: "Q-PRETRIP", status: "competent", rubric: {}, observedAt: new Date() })).rejects.toThrow(/cannot sign their own/);
    await expect(as(safety).academy.certificateIssue({ assignmentRef: enrol.assignmentRef })).rejects.toThrow(/external\/track-only|track-only|cannot issue|not been passed/);
    const [aq] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) c FROM academyQualifications WHERE userId = ?", [worker]);
    const [wq] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) c FROM workerQualifications WHERE userId = ?", [worker]);
    expect(Number(aq[0]!.c)).toBe(0);
    expect(Number(wq[0]!.c)).toBe(0);
    // A passed practice/mock attempt is not the theory pass a practical or certificate needs.
    await pool.execute("UPDATE academyAssessmentAttempts SET status = 'passed' WHERE attemptRef = ?", [practice.attemptRef]);
    await expect(as(safety).academy.practicalSignoff({ assignmentRef: enrol.assignmentRef, competencyCode: "Q-PRETRIP", status: "competent", rubric: {}, observedAt: new Date() })).rejects.toThrow(/theory assessment must be passed/);
    const wallet = await as(worker).trainingWallet.myWallet();
    expect(wallet.studied.find(s => s.courseCode === "AIRBRAKE-Q")!.note).toContain("not a licence");
  }, 120_000);

  it("18/19. the re-published v2 track leaves v1 and its bank intact; an unreviewed source cannot be kept offline and the tutor will not quote it", async () => {
    const A = await org();
    const worker = await member(A, ["driver"]), safety = await member(A, ["safety"]);
    const enrol = await as(worker).academy.studyEnroll({ courseCode: "CLASS1" });
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT v.versionRef, v.status, (SELECT COUNT(*) FROM academyQuestions q WHERE q.courseVersionId = v.id) qs FROM academyCourseVersions v WHERE v.versionRef IN ('CLASS1:1','CLASS1:2') ORDER BY v.versionNumber");
    const byRef = Object.fromEntries(v.map(r => [r.versionRef, r]));
    expect(byRef["CLASS1:2"]).toMatchObject({ status: "published" });
    expect(Number(byRef["CLASS1:2"]!.qs)).toBeGreaterThan(10);
    if (byRef["CLASS1:1"]) { expect(byRef["CLASS1:1"].status).toBe("retired"); expect(Number(byRef["CLASS1:1"].qs)).toBe(1); }
    const lib = await as(worker).academy.studyLibrary();
    const cdg = lib.find(s => s.sourceRef === "SRC-AB-COMMERCIAL-GUIDE")!;
    expect(cdg).toMatchObject({ licenceStatus: "open_licence_stated", authoritative: false });
    expect(cdg.offline.permitted).toBe(false);
    await expect(as(safety).academy.sourceConfirmRedistribution({ sourceRef: "SRC-AB-COMMERCIAL-GUIDE", note: "Open Government Licence read" })).rejects.toThrow(/Review the source/);
    const t = await as(worker).academy.tutor({ assignmentRef: enrol.assignmentRef, mode: "explain", question: "What removes the provincial restriction from a Class 1 licence?" });
    // SRC-AB-C1LP is seeded unreviewed — UNLESS an earlier run of this database reviewed it.
    const c1lp = lib.find(s => s.sourceRef === "SRC-AB-C1LP")!;
    expect(t.status).toBe(c1lp.reviewStatus === "reviewed" ? "GROUNDED" : "UNKNOWN_REFER_TO_AUTHORITY");
  }, 120_000);
});

d("tenant isolation and dispatch view", () => {
  it("16/22/24. another organization's employee, handoff and provider are not found; a driver cannot request for someone else; dispatch sees no private notes", async () => {
    const A = await org(), B = await org();
    const workerA = await member(A, ["driver"]), safetyA = await member(A, ["safety"]), safetyA2 = await member(A, ["safety"]), dispatchA = await member(A, ["dispatcher"]);
    const safetyB = await member(B, ["safety"]), dispatchB = await member(B, ["dispatcher"]), workerA2 = await member(A, ["driver"]);
    const up = await as(workerA).trainingWallet.recordOwn({ code: "FIRST_AID", boundary: "external_provider", documentRef: `DOC-${rnd()}`, certificateNumber: "FA-SECRET-77", issuedAt: future(-5), expiresAt: future(1000) });
    await as(safetyA2).trainingWallet.verify({ holdingRef: up.holdingRef, method: "document_inspection", verificationSource: "Card", issuedAt: future(-5), expiresAt: future(1000), privateNote: "HR-PRIVATE: accommodation on file" });
    await expect(as(safetyB).trainingWallet.personWallet({ userId: workerA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(dispatchB).trainingWallet.operationalView({ userId: workerA, codes: ["FIRST_AID"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(safetyB).trainingWallet.verify({ holdingRef: up.holdingRef, method: "document_inspection", verificationSource: "xyz card", issuedAt: null, expiresAt: future(10) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const h = await as(workerA).trainingWallet.requestTraining({ qualificationCode: "H2S_ALIVE" });
    await expect(as(safetyB).trainingWallet.handoffUpdate({ handoffRef: h.handoffRef, mark: "contacted" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await as(safetyB).trainingWallet.handoffQueue()).some(x => x.handoffRef === h.handoffRef)).toBe(false);
    await pool.execute("INSERT INTO vendors (bookOrgRef, vendorRef, name, category, status) VALUES (?,?,?,?, 'active')", [A, `V-${rnd()}`, "ABC Safety", "training_provider"]);
    const [vr] = await pool.execute<mysql.RowDataPacket[]>("SELECT id FROM vendors WHERE bookOrgRef = ? ORDER BY id DESC LIMIT 1", [A]);
    const vendorA = Number(vr[0]!.id);
    await expect(as(safetyB).trainingWallet.providerCapabilitySet({ vendorId: vendorA, capabilityCode: "FIRST_AID_BASIC", preferred: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const cap = await as(safetyA).trainingWallet.providerCapabilitySet({ vendorId: vendorA, capabilityCode: "FIRST_AID_BASIC", preferred: true });
    expect(cap.preferred).toBe(true);
    // 22. a driver requests only for themself.
    await expect(as(workerA2).trainingWallet.requestTraining({ userId: workerA, qualificationCode: "FIRST_AID" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await as(safetyA).trainingWallet.requestTraining({ userId: workerA, qualificationCode: "FIRST_AID" })).status).toBe("REQUESTED");
    // 24. dispatch: the answer without the file; management: the file with its notes.
    const opView = JSON.stringify(await as(dispatchA).trainingWallet.operationalView({ userId: workerA, codes: ["FIRST_AID", "H2S_ALIVE"] }));
    expect(opView).not.toContain("FA-SECRET-77");
    expect(opView).not.toContain("HR-PRIVATE");
    await expect(as(dispatchA).trainingWallet.personWallet({ userId: workerA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const full = await as(safetyA).trainingWallet.personWallet({ userId: workerA });
    expect(full.credentials.find(c => c.holdingRef === up.holdingRef)!.privateNotes).toContain("HR-PRIVATE");
    // The Exception Centre shows A's open training request to A's safety, and not to B's.
    const exA = await as(safetyA).surfaces.exceptions({ category: "workforce", limit: 500 });
    const exB = await as(safetyB).surfaces.exceptions({ category: "workforce", limit: 500 });
    expect(exA.items.some(x => x.key === `handoff:${h.handoffRef}`)).toBe(true);
    expect(exB.items.some(x => x.key === `handoff:${h.handoffRef}`)).toBe(false);
    // The compliance dashboard for A names A's people only.
    const dash = await as(safetyA).trainingWallet.complianceDashboard({ qualificationCode: "H2S_ALIVE" });
    expect(dash.views.renewalRequested.some(x => x.handoffRef === h.handoffRef)).toBe(true);
    const dashB = await as(safetyB).trainingWallet.complianceDashboard();
    expect(dashB.views.renewalRequested.some(x => x.handoffRef === h.handoffRef)).toBe(false);
  }, 120_000);
});
