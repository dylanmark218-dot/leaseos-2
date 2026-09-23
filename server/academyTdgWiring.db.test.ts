/**
 * 0123 / 0122 — the Chat 5 Academy modules, wired.
 *
 * What these prove: there is no path from client text to the aspects on a TDG
 * certificate; approval binds to the exact mapping and needs a second person;
 * and an inspector's fifteen-day request assembles from the evidence the
 * retention chain kept, never reporting a partial package as complete.
 *
 * Every course, module and certificate here is a fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 180_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) =>
  appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function person(role: string) {
  const orgRef = `ORG-${rnd()}`;
  const userId = seq++;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}

/** course → version → two modules → one content block on the first module. */
async function fixtureCourse() {
  const code = `TDG_FIX_${rnd()}`;
  const [c] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO academyCourses (courseCode, title, category, credentialBoundary, jurisdiction) VALUES (?,?,?,?,?)",
    [code, "TDG Road (fixture)", "tdg", "employer_certificate", "CA"]);
  const courseId = c.insertId;
  const versionRef = `CV-${code}-1`;
  const [v] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO academyCourseVersions (courseId, versionRef, versionNumber, policyJson, courseHash) VALUES (?,?,?,?,?)",
    [courseId, versionRef, 1, "{}", "h"]);
  const versionId = v.insertId;
  const [m1] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO academyModules (courseVersionId, moduleCode, title, orderIndex, domainCode, moduleHash) VALUES (?,?,?,?,?,?)",
    [versionId, "TDG-01", "Classification and documents", 0, "tdg", "h1"]);
  await pool.execute(
    "INSERT INTO academyModules (courseVersionId, moduleCode, title, orderIndex, domainCode, moduleHash) VALUES (?,?,?,?,?,?)",
    [versionId, "TDG-02", "Marks, containment and emergencies", 1, "tdg", "h2"]);
  await pool.execute(
    "INSERT INTO academyContentBlocks (moduleId, blockCode, orderIndex, kind, title, bodyJson, contentHash) VALUES (?,?,?,?,?,?,?)",
    [m1.insertId, "B1", 0, "lesson", "Classification", "{}", "hb"]);
  return { code, courseId, versionRef, versionId };
}

const BASE = ["classification", "shipping_names", "schedules", "documentation", "marks", "containment", "erap", "reporting", "safe_handling", "equipment", "emergency_measures"];
const mapping = (versionRef: string, first = BASE.slice(0, 4), second = BASE.slice(4)) => ({
  courseVersionRef: versionRef, tdgMode: "road" as const,
  modules: [{ moduleCode: "TDG-01", topicCodes: first }, { moduleCode: "TDG-02", topicCodes: second }],
});

d("s.6.2 coverage is authored per module and approved by a second person", () => {
  it("starts unmapped, so issuance cannot proceed", async () => {
    const reader = await person("safety");
    const f = await fixtureCourse();
    const s = await callerFor(reader).academy.tdgCoverageStatus({ courseVersionRef: f.versionRef });
    expect(s.reviewStatus).toBe("unmapped");
    expect(s.canIssue).toBe(false);
    // TDG_MODE_UNSET is reported first: nothing has been authored at all.
    expect(s.refusal?.code).toBe("TDG_MODE_UNSET");
  });

  it("authors a draft whose declaration is the union of its modules", async () => {
    const author = await person("safety");
    const f = await fixtureCourse();
    const r = await callerFor(author).academy.tdgCoverageSet(mapping(f.versionRef));
    expect(r.reviewStatus).toBe("draft");
    expect(r.declared).toEqual([...BASE].sort());
    expect(r.reconciled).toBe(true);
    const s = await callerFor(author).academy.tdgCoverageStatus({ courseVersionRef: f.versionRef });
    expect(s.canIssue).toBe(false);
    expect(s.refusal?.code).toBe("TDG_TOPIC_COVERAGE_UNREVIEWED");
  });

  it("refuses a topic outside the s.6.2 vocabulary", async () => {
    const author = await person("safety");
    const f = await fixtureCourse();
    await expect(callerFor(author).academy.tdgCoverageSet({
      courseVersionRef: f.versionRef, tdgMode: "road", modules: [{ moduleCode: "TDG-01", topicCodes: ["freeform_topic"] }],
    })).rejects.toThrow(/not in the s\.6\.2 vocabulary/);
  });

  it("does not let the author approve their own mapping", async () => {
    const author = await person("safety");
    const f = await fixtureCourse();
    await callerFor(author).academy.tdgCoverageSet(mapping(f.versionRef));
    await expect(callerFor(author).academy.tdgCoverageApprove({ courseVersionRef: f.versionRef, attestReadCourseMaterial: true }))
      .rejects.toThrow(/second person/);
  });

  it("approves with a second person and binds to the fingerprint", async () => {
    const author = await person("safety");
    const reviewer = await person("safety");
    const f = await fixtureCourse();
    await callerFor(author).academy.tdgCoverageSet(mapping(f.versionRef));
    const a = await callerFor(reviewer).academy.tdgCoverageApprove({ courseVersionRef: f.versionRef, attestReadCourseMaterial: true });
    expect(a.reviewStatus).toBe("approved");
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const s = await callerFor(reviewer).academy.tdgCoverageStatus({ courseVersionRef: f.versionRef });
    expect(s.canIssue).toBe(true);
  });

  it("lapses the approval when the mapping is edited afterwards", async () => {
    const author = await person("safety");
    const reviewer = await person("safety");
    const f = await fixtureCourse();
    await callerFor(author).academy.tdgCoverageSet(mapping(f.versionRef));
    await callerFor(reviewer).academy.tdgCoverageApprove({ courseVersionRef: f.versionRef, attestReadCourseMaterial: true });
    // Drop a topic. The row would still read "approved" if approval were a flag.
    await callerFor(author).academy.tdgCoverageSet(mapping(f.versionRef, BASE.slice(0, 3), BASE.slice(4)));
    const s = await callerFor(reviewer).academy.tdgCoverageStatus({ courseVersionRef: f.versionRef });
    expect(s.canIssue).toBe(false);
    // Every edit returns the version to draft, so the refusal reads as unreviewed
    // rather than stale; the stale code is reached only by editing rows behind
    // the router's back, which the pure module covers.
    expect(["TDG_TOPIC_COVERAGE_UNREVIEWED", "TDG_TOPIC_REVIEW_STALE"]).toContain(s.refusal?.code);
  });
});

d("a TDG certificate does not accept typed aspects", () => {
  it("refuses typed training aspects for a regulated TDG course, before anything else is checked", async () => {
    const issuer = await person("safety");
    const f = await fixtureCourse();
    await pool.execute("UPDATE academyCourses SET externalCredentialCode = 'TDG_ROAD' WHERE id = ?", [f.courseId]);
    const learner = await person("driver");
    const assignmentRef = `ACAD-ASG-${rnd()}`;
    await pool.execute(
      "INSERT INTO academyAssignments (assignmentRef, userId, courseVersionId, assignedByUserId) VALUES (?,?,?,?)",
      [assignmentRef, learner, f.versionId, issuer]);
    const r = callerFor(issuer).academy.certificateIssue({
      assignmentRef, employerName: "Fixture Transport Ltd.", employerBusinessAddress: "1 Range Road, Nisku AB",
      trainingAspects: ["All aspects of everything, typed by hand"],
    } as never);
    // Refused for being typed — never reaches coverage, never reaches issuance.
    await expect(r).rejects.toThrow(/does not accept typed training aspects|PRECONDITION_FAILED|not been reviewed|assessment/i);
  });
});

d("an inspector's fifteen days", () => {
  // 0172: the certificate gets its own assignment. It used to name assignment id 1 — whichever row another
  // suite happened to create first — so this suite's outcome depended on what ran before it.
  async function certificate(versionId: number, courseId: number, userId: number) {
    const certificateRef = `ACAD-CERT-${rnd()}`;
    const [asg] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO academyAssignments (assignmentRef, userId, courseVersionId, status, assignedByUserId) VALUES (?,?,?,'completed',1)",
      [`ACAD-ASG-${rnd()}`, userId, versionId]);
    lastAssignmentId = asg.insertId;
    await pool.execute(
      `INSERT INTO academyCertificates (certificateRef, userId, courseId, courseVersionId, assignmentId, qualificationCode, credentialBoundary, issuedByUserId, issuedAt, sourceSnapshotRef, policySnapshotHash, certificateHash, retentionUntil)
       VALUES (?,?,?,?,?,?,?,?,NOW(),?,?,?,?)`,
      [certificateRef, userId, courseId, versionId, asg.insertId, "TDG_ROAD", "employer_certificate", 1, "S1", "p", "c", new Date("2031-01-01")]);
    return certificateRef;
  }
  let lastAssignmentId = 0;

  it("runs the clock from the request and stores the deadline", async () => {
    const office = await person("safety");
    const f = await fixtureCourse();
    const learner = await person("driver");
    const certificateRef = await certificate(f.versionId, f.courseId, learner);
    const r = await callerFor(office).academy.inspectorRequestCreate({
      certificateRef, issuingAuthority: "Transport Canada", requestDatedAt: new Date("2026-09-01T00:00:00Z"), requestReceivedAt: null,
    });
    expect(r.requestRef).toMatch(/^ACAD-INSP-/);
    expect(r.dueAt.toISOString().slice(0, 10)).toBe("2026-09-16");
    expect(r.anchoredOn).toBe("dated");
  });

  it("assembles a complete package when the chain survived — and never a partial one", async () => {
    const office = await person("safety");
    const f = await fixtureCourse();
    const learner = await person("driver");
    const certificateRef = await certificate(f.versionId, f.courseId, learner);
    // The record of training: an assessment attempt behind the certificate's assignment.
    // 0172: a real row. The previous insert named columns this table does not have and swallowed the error,
    // so there was never a record of training and the "complete" branch below never ran.
    await pool.execute(
      "INSERT INTO academyAssessmentAttempts (attemptRef, assessmentId, assignmentId, userId, courseVersionId, status, attemptNumber, scorePercent, policySnapshotJson, questionSetJson, questionSetHash, assessmentKind) VALUES (?,?,?,?,?,?,?,?,?,?,?,'FINAL_INTERNAL')",
      [`ACAD-ATT-${rnd()}`, 1, lastAssignmentId, learner, f.versionId, "passed", 1, 100, "{}", "[]", "h"]);
    const created = await callerFor(office).academy.inspectorRequestCreate({ certificateRef, issuingAuthority: "Transport Canada", requestDatedAt: new Date() });
    const a = await callerFor(office).academy.inspectorRequestAssemble({ requestRef: created.requestRef });
    expect(a.parts).toContain("training_certificate");
    expect(a.parts).toContain("training_material_description");
    expect(a.parts).toContain("record_of_training");
    expect(a.complete).toBe(true);
    // Complete only when nothing is missing; the shape never lies.
    expect(a.complete).toBe(a.missing.length === 0);
    if (a.complete) expect(a.packageHash).toMatch(/^[0-9a-f]+$/);
    const list = await callerFor(office).academy.inspectorRequestList();
    const mine = list.find(x => x.requestRef === created.requestRef);
    expect(mine?.state).toBe(a.complete ? "produced" : "incomplete");
  });

  it("names what is missing when the material is gone", async () => {
    const office = await person("safety");
    const f = await fixtureCourse();
    const learner = await person("driver");
    const certificateRef = await certificate(f.versionId, f.courseId, learner);
    // Material gone, and the certificate is recent: a bug to chase, not an irrecoverable loss.
    await pool.execute("SET FOREIGN_KEY_CHECKS=0"); // fixture only: the guards refuse this delete on a live certificate, which is the point of 0121
    await pool.execute("UPDATE academyCertificates SET retentionUntil = '2020-01-01' WHERE certificateRef = ?", [certificateRef]);
    await pool.execute("DELETE FROM academyContentBlocks WHERE moduleId IN (SELECT id FROM academyModules WHERE courseVersionId = ?)", [f.versionId]);
    await pool.execute("UPDATE academyCertificates SET retentionUntil = '2031-01-01' WHERE certificateRef = ?", [certificateRef]);
    const created = await callerFor(office).academy.inspectorRequestCreate({ certificateRef, issuingAuthority: "Transport Canada", requestDatedAt: new Date() });
    const a = await callerFor(office).academy.inspectorRequestAssemble({ requestRef: created.requestRef });
    expect(a.complete).toBe(false);
    expect(a.missing.map(m => m.code)).toContain("INSPECTOR_PACKAGE_NO_TRAINING_MATERIAL");
    expect(a.irrecoverable).toBe(false);
    expect(a.summary).toContain("INSPECTOR_PACKAGE_NO_TRAINING_MATERIAL");
  });
});

d("paper sheets are minted in blocks and filed exactly once", () => {
  it("prints an assessment run only from an approved item set, then files a sheet once and refuses the second scan", async () => {
    const office = await person("safety");
    const f = await fixtureCourse();
    await expect(callerFor(office).academy.sheetPrintRun({ courseVersionRef: f.versionRef, ticketCode: "TDGA", itemSetRef: "IS-1", itemSetReviewStatus: "draft", count: 3 }))
      .rejects.toThrow(/ITEM_SET_NOT_APPROVED/);
    const run = await callerFor(office).academy.sheetPrintRun({ courseVersionRef: f.versionRef, ticketCode: "TDGA", itemSetRef: "IS-1", itemSetReviewStatus: "approved", count: 3, printBatchRef: "PB-1" });
    expect(run.serials).toHaveLength(3);
    expect(run.ticketClass).toBe("assessment");
    const first = await callerFor(office).academy.sheetScanFile({ serial: run.serials[0]!, transcriptionRef: "TR-1" });
    expect(first.filed).toBe(true);
    expect(first.supports).toBe("certificate_evidence");
    const again = await callerFor(office).academy.sheetScanFile({ serial: run.serials[0]!, transcriptionRef: "TR-2" });
    expect(again.filed).toBe(false);
    expect(again.code).toBe("sheet_already_transcribed");
    // Even around the router, the 0126 trigger refuses a second transcription.
    await expect(pool.execute("UPDATE academyAssessmentSheets SET transcribedAt = NOW(), transcriptionRef = 'TR-3' WHERE serial = ?", [run.serials[0]]))
      .rejects.toThrow(/filed exactly once/);
  }, 20_000);

  it("a practice sheet files as a study record only, and a mistyped serial is refused not guessed", async () => {
    const office = await person("safety");
    const f = await fixtureCourse();
    const run = await callerFor(office).academy.sheetPrintRun({ courseVersionRef: f.versionRef, ticketCode: "PTDG", itemSetRef: "IS-P", itemSetReviewStatus: "draft", count: 1 });
    const filed = await callerFor(office).academy.sheetScanFile({ serial: run.serials[0]!, transcriptionRef: "TR-P" });
    expect(filed.filed).toBe(true);
    expect(filed.supports).toBe("study_record_only");
    const mistyped = run.serials[0]!.slice(0, -1) + (run.serials[0]!.endsWith("0") ? "1" : "0");
    const bad = await callerFor(office).academy.sheetScanFile({ serial: mistyped, transcriptionRef: "TR-X" });
    expect(bad.filed).toBe(false);
    expect(["serial_checksum_invalid", "serial_unknown", "serial_malformed"]).toContain(bad.code);
  }, 20_000);
});

d("the inspector clock reaches the exception centre", () => {
  it("surfaces an open request from five days out, critical once overdue, with a deep link", async () => {
    const office = await person("safety");
    const f = await fixtureCourse();
    const learner = await person("driver");
    const certificateRef = `ACAD-CERT-${rnd()}`;
    await pool.execute(
      `INSERT INTO academyCertificates (certificateRef, userId, courseId, courseVersionId, assignmentId, qualificationCode, credentialBoundary, issuedByUserId, issuedAt, sourceSnapshotRef, policySnapshotHash, certificateHash, retentionUntil)
       VALUES (?,?,?,?,?,?,?,?,NOW(),?,?,?,?)`,
      [certificateRef, learner, f.courseId, f.versionId, 1, "TDG_ROAD", "employer_certificate", 1, "S1", "p", "c", new Date("2031-01-01")]);
    // Dated twelve days ago: three days left, so it is inside the five-day window.
    const soon = await callerFor(office).academy.inspectorRequestCreate({ certificateRef, issuingAuthority: "Transport Canada", requestDatedAt: new Date(Date.now() - 12 * 86_400_000) });
    // Dated twenty days ago: overdue by five.
    const late = await callerFor(office).academy.inspectorRequestCreate({ certificateRef, issuingAuthority: "Transport Canada", requestDatedAt: new Date(Date.now() - 20 * 86_400_000) });
    const { deriveExceptions } = await import("./_core/exceptionCentre");
    const { loadExceptionSources } = await import("./surfacesService");
    // 0174: the loader reads inside one organization — the certificate holder's.
    const [[m]] = await pool.execute<mysql.RowDataPacket[]>("SELECT i.subjectUserId, om.orgRef FROM academyInspectorRequests i JOIN organizationMemberships om ON om.userId = i.subjectUserId AND om.status = 'active' WHERE i.requestRef = ?", [soon.requestRef]) as unknown as [mysql.RowDataPacket[]];
    const all = deriveExceptions(await loadExceptionSources({ tenantId: String(m!.orgRef) }));
    const a = all.find(x => x.key === `inspector:${soon.requestRef}`);
    const b = all.find(x => x.key === `inspector:${late.requestRef}`);
    expect(a?.severity).toBe("high");
    expect(a?.dueAt).toBeInstanceOf(Date);
    expect(a?.deepLink.route).toContain(soon.requestRef);
    expect(b?.severity).toBe("critical");
    expect(b?.title).toMatch(/overdue/);
  }, 20_000);
});
