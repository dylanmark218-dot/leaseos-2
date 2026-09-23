import { describe, expect, it } from "vitest";
import { authorize, permissionForProcedure, SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";
import { ACADEMY_COURSES, CATALOG_COUNTS } from "./_core/trainingAcademyCatalog";
import { buildAssessment, certificateDecision, directSupervisionDecision, gradeAssessment, moduleGate, practicalGate, stableHash, trainingDispatchDecision } from "./_core/trainingAcademy";

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("v22.21 Academy catalog", () => {
  it("locks the requested question-bank sizes", () => {
    // 0172: CLASS1/2/3/AIRBRAKE-Q became versioned Study Centre tracks with original practice banks, and
    // AB-COMMERCIAL-FOUNDATION, CLASS4 and COMPANY-FIELD were added — 14 courses, 269 questions.
    expect(CATALOG_COUNTS).toMatchObject({ whmisQuestions: 50, tdgQuestions: 75, ergQuestions: 25, courses: 14 });
    expect(CATALOG_COUNTS.totalQuestions).toBe(269);
  });
  it("keeps external credentials track-only", () => {
    for (const code of ["CLASS1", "CLASS2", "CLASS3", "AIRBRAKE-Q", "H2S-TRACK", "FIRSTAID-TRACK"]) {
      expect(ACADEMY_COURSES.find(c => c.code === code)?.credentialBoundary).toBe("external_track_only");
    }
    expect(ACADEMY_COURSES.find(c => c.code === "TDG-ROAD")?.credentialBoundary).toBe("employer_certificate");
    expect(ACADEMY_COURSES.find(c => c.code === "WHMIS-AB")?.credentialBoundary).toBe("employer_certificate");
  });
});

describe("version-locked learning and assessment", () => {
  const tdg = ACADEMY_COURSES.find(c => c.code === "TDG-ROAD")!;
  const requirements = tdg.modules.map((m, i) => ({ moduleId: i + 1, moduleCode: m.code, moduleHash: stableHash(m), required: true }));
  it("does not open a final until every current module version is complete", () => {
    expect(moduleGate(requirements, []).ready).toBe(false);
    const stale = requirements.map(r => ({ moduleCode: r.moduleCode, contentVersionHash: r.moduleHash, status: "completed" as const }));
    stale[0] = { ...stale[0], contentVersionHash: "old-hash" };
    expect(moduleGate(requirements, stale)).toMatchObject({ ready: false, stale: [requirements[0].moduleCode] });
    expect(moduleGate(requirements, requirements.map(r => ({ moduleCode: r.moduleCode, contentVersionHash: r.moduleHash, status: "completed" as const }))).ready).toBe(true);
  });
  it("snapshots deterministic randomized questions and answer order, then grades presented indexes", () => {
    const first = buildAssessment({ attemptSeed: "ATT-1", questions: tdg.questions, policy: tdg.policy });
    const replay = buildAssessment({ attemptSeed: "ATT-1", questions: tdg.questions, policy: tdg.policy });
    expect(first).toEqual(replay);
    expect(first.items).toHaveLength(30);
    const answers = Object.fromEntries(first.items.map(i => [i.questionCode, i.answerOrder.indexOf(0)]));
    expect(gradeAssessment({ bank: tdg.questions, presented: first.items, responses: answers, policy: tdg.policy })).toMatchObject({ passed: true, scorePercent: 100 });
  });
});

describe("credential and competency barriers", () => {
  it("requires a separate matching practical sign-off", () => {
    expect(practicalGate({ requiresPractical: true, courseVersionId: 4, evaluation: null }).ready).toBe(false);
    expect(practicalGate({ requiresPractical: true, courseVersionId: 4, evaluation: { status: "competent", courseVersionId: 3 } }).ready).toBe(false);
    expect(practicalGate({ requiresPractical: true, courseVersionId: 4, evaluation: { status: "competent", courseVersionId: 4 } }).ready).toBe(true);
  });
  it("never manufactures an external credential and never issues from an unreviewed source", () => {
    expect(certificateDecision({ credentialBoundary: "external_track_only", courseVersionId: 1, assignmentCourseVersionId: 1, assessmentPassed: true, practicalReady: true, sourceSnapshotRef: "SRC", sourceReviewStatus: "reviewed" }).permitted).toBe(false);
    expect(certificateDecision({ credentialBoundary: "employer_certificate", courseVersionId: 1, assignmentCourseVersionId: 1, assessmentPassed: true, practicalReady: true, sourceSnapshotRef: "SRC", sourceReviewStatus: "unreviewed", sourceTier: "authority" }).permitted).toBe(false);
    expect(certificateDecision({ credentialBoundary: "employer_certificate", courseVersionId: 1, assignmentCourseVersionId: 1, assessmentPassed: true, practicalReady: true, sourceSnapshotRef: "SRC", sourceReviewStatus: "reviewed", sourceTier: "authority" }).permitted).toBe(true);
  });
  it("does not call phone/GPS/app monitoring direct supervision", () => {
    const base = { traineeUserId: 1, supervisorUserId: 2, supervisorQualificationStatus: "current" as const, supervisorQualificationCode: "TDG_ROAD", requiredQualificationCode: "TDG_ROAD", startsAt: new Date("2026-09-11T10:00:00Z"), endsAt: new Date("2026-09-11T12:00:00Z"), jobId: 99, scope: "job-specific TDG road scope" };
    expect(directSupervisionDecision({ ...base, physicalPresenceAttested: false }).blockers.join(" ")).toMatch(/physical presence/i);
    expect(directSupervisionDecision({ ...base, physicalPresenceAttested: true }).permitted).toBe(true);
  });
});

describe("Academy authorization and dispatch", () => {
  it("lets every recognized role work only its own learner surface through universal grants", () => {
    for (const role of ALL) {
      expect(authorize({ userId: 1, roles: [role], permission: "academy.read_own" }).allowed).toBe(true);
      expect(authorize({ userId: 1, roles: [role], permission: "academy.progress_own" }).allowed).toBe(true);
    }
  });
  it("separates evaluator, source-review and certificate authorities", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "academy.evaluate" }).allowed).sort()).toEqual(["hr", "management", "safety", "shop_lead"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "academy.source.review" }).allowed).sort()).toEqual(["management", "safety"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "academy.certificate.issue" }).allowed).sort()).toEqual(["hr", "management", "safety"]);
    expect(permissionForProcedure("academy.directSupervisionAttest")).toBe("academy.direct_supervision_attest_own");
    expect(SENSITIVE_PERMISSIONS).toEqual(expect.arrayContaining(["academy.source.review", "academy.certificate.issue", "academy.direct_supervision_attest_own"]));
  });
  it("returns a specific recovery path instead of generic not-ready", () => {
    const result = trainingDispatchDecision([{ code: "REQ-TDG", title: "TDG", qualificationCode: "TDG_ROAD", enforcement: "block", recoveryPath: "Complete TDG or establish valid physical direct supervision." }], []);
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]).toContain("physical direct supervision");
  });
});
