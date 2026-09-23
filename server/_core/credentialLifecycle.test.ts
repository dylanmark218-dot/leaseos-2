/**
 * 0172 — the wallet/renewal/handoff/study rules, pure. The numbers in the
 * test names are the checkpoint's required-test list.
 */
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_POLICIES, crewCoverage, crossedThreshold, heldForWork, lifecycleFacts, operationalView, planRenewalReminders, policyFor,
  serverProfileExpiry, studiedButNotHeld, supersedePlan, suppressDelivered, walletRecordDecision, walletVerificationDecision, type WalletHolding,
} from "./credentialLifecycle";
import { countsAsHeld, countsAsHeldUnder } from "./qualificationValidity";
import { handoffTransition, openDuplicate, providerOptions, requestAuthority, workerFacingStatus } from "./externalTrainingHandoff";
import { CAREER_PATHWAYS, evaluatePathway } from "./careerPathway";
import { tutorAnswer, type TutorPassage } from "./studyTutor";
import { attemptConsequences, buildAssessment, certificateDecision, gradeAssessment, trainingDispatchDecision, weakAreas } from "./trainingAcademy";
import { ACADEMY_COURSES } from "./trainingAcademyCatalog";
import { STUDY_CENTRE_COURSES, STUDY_LIBRARY_SOURCES, offlineCopyDecision } from "./studyCentreCatalog";
import { certificateTerms, ACADEMY_REGULATORY_PROFILES } from "./trainingAcademyRegulatory";

const NOW = new Date("2026-10-01T12:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00Z`);
let n = 0;
const h = (code: string, o: Partial<WalletHolding> = {}): WalletHolding => ({
  holdingRef: `H-${++n}`, code, verificationState: "verified", issuedAt: d("2025-01-01"), expiresAt: d("2027-06-01"), recordedAt: new Date(d("2025-01-02").getTime() + n * 1000), userId: 7, restrictions: [], supersededByHoldingRef: null, ...o,
});

describe("the five questions stay separate (1, 14)", () => {
  it("1. no Study Centre or external track can manufacture H2S, First Aid, a licence or Q", () => {
    for (const c of ACADEMY_COURSES.filter(c => ["H2S_ALIVE", "FIRST_AID", "AIR_BRAKE_Q"].includes(c.qualificationCode ?? "") || (c.qualificationCode ?? "").startsWith("DRIVER_LICENCE"))) {
      expect(c.credentialBoundary, c.code).toBe("external_track_only");
      const decision = certificateDecision({ credentialBoundary: c.credentialBoundary, courseVersionId: 1, assignmentCourseVersionId: 1, assessmentPassed: true, practicalReady: true, sourceSnapshotRef: "SRC", sourceReviewStatus: "reviewed", sourceTier: "authority" });
      expect(decision.permitted, c.code).toBe(false);
    }
  });
  it("14. an Academy completion or practice result cannot be recorded into the wallet as a credential", () => {
    expect(walletRecordDecision({ boundary: "external_provider", evidenceKind: "academy_completion" }).permitted).toBe(false);
    expect(walletRecordDecision({ boundary: "regulator_issued", evidenceKind: "practice_result" }).permitted).toBe(false);
    expect(walletRecordDecision({ boundary: "study_only", evidenceKind: "uploaded_document" }).permitted).toBe(false);
    expect(walletRecordDecision({ boundary: "external_provider", evidenceKind: "uploaded_document" }).permitted).toBe(true);
  });
  it("practice, mock and competency-knowledge attempts never advance anything or touch readiness", () => {
    for (const k of ["PRACTICE", "MOCK_EXAM", "COMPETENCY_KNOWLEDGE"] as const) {
      expect(attemptConsequences(k)).toMatchObject({ advancesAssignment: false, canLeadToCertificate: false, affectsReadiness: false });
    }
    expect(attemptConsequences("FINAL_INTERNAL").canLeadToCertificate).toBe(true);
    expect(attemptConsequences("FINAL_INTERNAL").affectsReadiness).toBe(false);
  });
  it("the dashboard names 'studied H2S, holds no verified H2S Alive'", () => {
    const out = studiedButNotHeld({ studied: [{ userId: 9, qualificationCode: "H2S_ALIVE", courseCode: "H2S-TRACK", completedAt: NOW }], holdingsByUser: new Map(), at: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toContain("Completed H2S-TRACK study material but holds no verified H2S_ALIVE");
  });
});

describe("verification (3, 15)", () => {
  const base = { subjectUserId: 1, verifierUserId: 2, recordedByUserId: 1, policy: policyFor("H2S_ALIVE"), boundary: "external_provider" as const, method: "document_inspection" as const, documentRefs: ["DOC-1"], expiresAt: d("2029-01-01"), issuedAt: d("2026-01-01") };
  it("3. an uploaded certificate is unverified until an authorized, different person verifies it — and OCR is not verification", () => {
    expect(countsAsHeld([h("H2S_ALIVE", { verificationState: "unverified" })], "H2S_ALIVE", NOW)).toMatchObject({ held: false, code: "unverified" });
    expect(countsAsHeld([h("H2S_ALIVE", { verificationState: "extracted" })], "H2S_ALIVE", NOW)).toMatchObject({ held: false, code: "unverified" });
    expect(walletVerificationDecision(base).permitted).toBe(true);
    expect(walletVerificationDecision({ ...base, method: "ocr_extraction" }).blockers.join()).toContain("OCR extraction is not verification");
    expect(walletVerificationDecision({ ...base, verifierUserId: 1 }).blockers.join()).toContain("verify their own");
    expect(walletVerificationDecision({ ...base, recordedByUserId: 2 }).blockers.join()).toContain("recorded this credential may not also verify");
    expect(walletVerificationDecision({ ...base, documentRefs: [] }).blockers.join()).toContain("source document");
    expect(walletVerificationDecision({ ...base, expiresAt: null }).blockers.join()).toContain("actual expiry");
  });
  it("12. H2S and First Aid use the verified certificate's own dates — never issue date + typical validity", () => {
    for (const code of ["H2S_ALIVE", "FIRST_AID"]) {
      const p = policyFor(code)!;
      expect(p.lifecycle).toBe("actual_expiry");
      expect(p.typicalValidityMonths).toBe(36); // context only
      const f = lifecycleFacts({ code, holdings: [h(code, { issuedAt: d("2025-02-01"), expiresAt: d("2026-11-15") })], policy: p, now: NOW });
      expect(f.legalExpiry?.toISOString().slice(0, 10)).toBe("2026-11-15");
      const noExpiry = lifecycleFacts({ code, holdings: [h(code, { expiresAt: null })], policy: p, now: NOW });
      expect(noExpiry.basis).toBe("unknown_no_expiry");
      expect(noExpiry.legalExpiry).toBeNull();
    }
  });
  it("H2S blended renewal is offered only while the verified certificate is current, and the provider decides", () => {
    const p = policyFor("H2S_ALIVE")!;
    expect(lifecycleFacts({ code: "H2S_ALIVE", holdings: [h("H2S_ALIVE", { expiresAt: d("2027-01-01") })], policy: p, now: NOW }).renewalWindow?.availableNow).toBe("UNKNOWN_VERIFY_WITH_PROVIDER");
    expect(lifecycleFacts({ code: "H2S_ALIVE", holdings: [h("H2S_ALIVE", { expiresAt: d("2026-09-01") })], policy: p, now: NOW }).renewalWindow?.availableNow).toBe("no");
  });
});

describe("renewal supersedes; validity stays canonical (4, 5)", () => {
  it("4. a renewal supersedes the previous verified holding without deleting it", () => {
    const old = h("FIRST_AID", { expiresAt: d("2026-10-20") });
    const renewal = h("FIRST_AID", { expiresAt: d("2029-10-10") });
    const plan = supersedePlan([old, renewal], renewal);
    expect(plan).toEqual([{ holdingRef: old.holdingRef, supersededByHoldingRef: renewal.holdingRef }]);
    const after = [{ ...old, verificationState: "superseded" as const, supersededByHoldingRef: renewal.holdingRef }, renewal];
    expect(after).toHaveLength(2);
    expect(heldForWork(after, "FIRST_AID", NOW)).toMatchObject({ held: true });
  });
  it("5. with no policy and no scope, the wallet's answer IS countsAsHeld", () => {
    const hs = [h("TDG"), h("X", { expiresAt: null }), h("Y", { verificationState: "unverified" }), h("Z", { expiresAt: d("2026-01-01") })];
    for (const code of ["TDG", "X", "Y", "Z", "MISSING"]) {
      const a = countsAsHeld(hs, code, NOW), b = countsAsHeldUnder(hs, code, NOW, null, null);
      expect(b).toEqual(a);
    }
  });
});

describe("expiry blocks the dependency, not the person (6, 7)", () => {
  const reqs = [
    { code: "REQ-H2S", title: "H2S Alive", qualificationCode: "H2S_ALIVE", enforcement: "block" as const },
    { code: "REQ-FA", title: "First Aid", qualificationCode: "FIRST_AID", enforcement: "block" as const },
  ];
  const holdings = [h("H2S_ALIVE", { expiresAt: d("2026-09-01") }), h("FIRST_AID", { expiresAt: d("2028-01-01") })];
  const canonical = (codes: typeof reqs) => new Map(codes.map(r => [r.code, { ...heldForWork(holdings, r.qualificationCode, NOW), recoveryLabel: null }]));
  it("6. an expired required credential blocks the work that requires it", () => {
    const decision = trainingDispatchDecision([reqs[0]!], [], NOW, canonical([reqs[0]!]));
    expect(decision.status).toBe("blocked");
    expect(decision.blocking[0]).toMatchObject({ code: "REQ-H2S", state: "expired" });
  });
  it("7. the same expired credential does not ground work that does not require it", () => {
    const decision = trainingDispatchDecision([reqs[1]!], [], NOW, canonical([reqs[1]!]));
    expect(decision.status).toBe("ready");
    expect(operationalView({ holdings, codes: ["FIRST_AID"], at: NOW })[0]!.state).toBe("held");
  });
});

describe("credential-specific rules (8, 9, 10, 11)", () => {
  it("8. WHMIS gets no fabricated statutory expiry", () => {
    const p = policyFor("WHMIS_EMPLOYER")!;
    expect(p.lifecycle).toBe("employer_review");
    expect(p.typicalValidityMonths).toBeNull();
    expect(ACADEMY_REGULATORY_PROFILES.find(x => x.qualificationCode === "WHMIS_EMPLOYER")!.validityMonths).toBeNull();
    const f = lifecycleFacts({ code: "WHMIS_EMPLOYER", holdings: [h("WHMIS_EMPLOYER", { expiresAt: null, walletBoundary: undefined } as Partial<WalletHolding>)], policy: p, now: NOW });
    expect(f.legalExpiry).toBeNull();
    expect(f.reminderTarget).toBeNull();
    expect(planRenewalReminders({ userId: 7, code: "WHMIS_EMPLOYER", holdings: [h("WHMIS_EMPLOYER", { expiresAt: null })], policy: p, now: NOW })).toEqual([]);
  });
  it("9. a company WHMIS review date is labelled company policy and is not a legal expiry", () => {
    const p = policyFor("WHMIS_EMPLOYER")!;
    const f = lifecycleFacts({ code: "WHMIS_EMPLOYER", holdings: [h("WHMIS_EMPLOYER", { issuedAt: d("2025-10-15"), expiresAt: null })], policy: p, settings: { employerReviewMonths: 12 }, now: NOW });
    expect(f.basis).toBe("employer_review");
    expect(f.legalExpiry).toBeNull();
    expect(f.employerReviewAt?.toISOString().slice(0, 10)).toBe("2026-10-15");
    expect(f.reminderTarget).toMatchObject({ kind: "employer_review" });
    expect(f.labels.join(" ")).toContain("not a legal expiry");
    const r = planRenewalReminders({ userId: 7, code: "WHMIS_EMPLOYER", holdings: [h("WHMIS_EMPLOYER", { issuedAt: d("2025-10-15"), expiresAt: null })], policy: p, settings: { employerReviewMonths: 12 }, now: NOW });
    expect(r[0]!.title).toContain("Company policy review");
    expect(r[0]!.body).toContain("not a legal expiry");
  });
  it("10. TDG road expiry is computed server-side from the versioned profile and refuses a caller's date", () => {
    const p = policyFor("TDG_ROAD")!;
    expect(p.lifecycle).toBe("server_profile_expiry");
    expect(serverProfileExpiry(p, d("2026-01-31"))?.toISOString().slice(0, 10)).toBe("2029-01-31");
    const profile = ACADEMY_REGULATORY_PROFILES.find(x => x.profileRef === p.regulatoryProfileRef)!;
    expect(certificateTerms({ issuedAt: NOW, credentialBoundary: "employer_certificate", profile, callerSuppliedExpiry: d("2035-01-01") }).permitted).toBe(false);
    // Road only — there is no air profile to borrow the road duration from.
    expect(ACADEMY_REGULATORY_PROFILES.some(x => x.qualificationCode === "TDG_AIR")).toBe(false);
    expect(policyFor("TDG_AIR")).toBeNull();
    // The wallet cannot verify a TDG employer certificate into existence.
    expect(walletVerificationDecision({ subjectUserId: 1, verifierUserId: 2, recordedByUserId: 1, policy: p, boundary: "employer_issued", method: "document_inspection", documentRefs: ["D"], expiresAt: d("2029-01-01"), issuedAt: d("2026-01-01") }).permitted).toBe(false);
  });
  it("11. Q gets no recurring renewal expiry, and is held only while a licence carrying it is held", () => {
    const p = policyFor("AIR_BRAKE_Q")!;
    expect(p.lifecycle).toBe("no_expiry_endorsement");
    const q = h("AIR_BRAKE_Q", { expiresAt: null });
    expect(planRenewalReminders({ userId: 7, code: "AIR_BRAKE_Q", holdings: [q], policy: p, now: NOW })).toEqual([]);
    expect(lifecycleFacts({ code: "AIR_BRAKE_Q", holdings: [q], policy: p, now: NOW }).reminderTarget).toBeNull();
    expect(heldForWork([q], "AIR_BRAKE_Q", NOW)).toMatchObject({ held: false, code: "unknown" });
    expect(heldForWork([q, h("DRIVER_LICENCE_CLASS_3")], "AIR_BRAKE_Q", NOW)).toMatchObject({ held: true });
    expect(heldForWork([q, h("DRIVER_LICENCE_CLASS_3", { expiresAt: d("2026-01-01") })], "AIR_BRAKE_Q", NOW).held).toBe(false);
    expect(walletVerificationDecision({ subjectUserId: 1, verifierUserId: 2, recordedByUserId: 1, policy: p, boundary: "regulator_issued", method: "original_sighted", documentRefs: ["L"], expiresAt: d("2030-01-01"), issuedAt: null }).blockers.join()).toContain("fabricated expiry");
    // The plain rule still says "unknown" for a verified holding without expiry — Q is the policy's exception, not a loosening.
    expect(countsAsHeld([q, h("DRIVER_LICENCE_CLASS_3")], "AIR_BRAKE_Q", NOW).held).toBe(false);
  });
});

describe("idempotent warnings (13)", () => {
  it("13. the same 30-day warning has one key however often the sweep runs; delivered keys are suppressed", () => {
    const p = policyFor("H2S_ALIVE")!;
    const holdings = [h("H2S_ALIVE", { holdingRef: "H-H2S", expiresAt: d("2026-10-25") })];
    const a = planRenewalReminders({ userId: 7, code: "H2S_ALIVE", holdings, policy: p, now: NOW });
    const b = planRenewalReminders({ userId: 7, code: "H2S_ALIVE", holdings, policy: p, now: new Date(NOW.getTime() + 3600_000) });
    expect(a.map(x => x.notificationKey)).toEqual(b.map(x => x.notificationKey));
    expect(a[0]!.notificationKey).toBe("cred-renew:H-H2S:legal_expiry:30:u7");
    expect(a.map(x => x.escalation)).toEqual(["employee", "supervisor_safety_admin", "supervisor_safety_admin"]);
    expect(a[0]!.body).toBe("Renewal required. Current H2S Alive certificate expires 2026-10-25.");
    const first = suppressDelivered(a, new Set());
    expect(first.send).toHaveLength(3);
    const second = suppressDelivered(b, new Set(first.send.map(s => s.notificationKey)));
    expect(second.send).toHaveLength(0);
    expect(second.suppressed).toHaveLength(3);
    // A tighter threshold is a new key; the earlier ones are not re-sent.
    const later = planRenewalReminders({ userId: 7, code: "H2S_ALIVE", holdings, policy: p, now: d("2026-10-20") });
    expect(later[0]!.notificationKey).toBe("cred-renew:H-H2S:legal_expiry:7:u7");
  });
  it("thresholds are notification thresholds: nothing before the widest, 'expired' after the date", () => {
    expect(crossedThreshold(d("2027-06-01"), NOW, [120, 90, 60, 30, 14, 7, 1])).toBeNull();
    expect(crossedThreshold(d("2026-12-15"), NOW, [120, 90, 60, 30, 14, 7, 1])?.threshold).toBe(90);
    expect(crossedThreshold(d("2026-09-15"), NOW, [120, 90])?.threshold).toBe("expired");
    // An employee-only warning outside the escalation window.
    expect(planRenewalReminders({ userId: 7, code: "FIRST_AID", holdings: [h("FIRST_AID", { expiresAt: d("2026-12-20") })], policy: policyFor("FIRST_AID"), now: NOW }).map(r => r.escalation)).toEqual(["employee"]);
  });
});

describe("restricted Class 1 (17)", () => {
  it("17. a provincially restricted Class 1 does not satisfy an explicitly interprovincial requirement, and still satisfies Alberta-only work", () => {
    const restricted = [h("DRIVER_LICENCE_CLASS_1", { restrictions: ["PROVINCIAL_RESTRICTION"] })];
    expect(heldForWork(restricted, "DRIVER_LICENCE_CLASS_1", NOW, { interprovincial: true })).toMatchObject({ held: false, code: "restricted" });
    expect(heldForWork(restricted, "DRIVER_LICENCE_CLASS_1", NOW, { interprovincial: false }).held).toBe(true);
    const req = { code: "REQ-C1-IP", title: "Interprovincial Class 1", qualificationCode: "DRIVER_LICENCE_CLASS_1", enforcement: "block" as const, requiresInterprovincial: true };
    const v = heldForWork(restricted, "DRIVER_LICENCE_CLASS_1", NOW, { interprovincial: true });
    const op = operationalView({ holdings: restricted, codes: ["DRIVER_LICENCE_CLASS_1"], at: NOW, scope: { interprovincial: true } })[0]!;
    expect(op.recovery[0]!.action).toBe("full_licence_required");
    const decision = trainingDispatchDecision([req], [{ code: "DRIVER_LICENCE_CLASS_1", status: "current", expiresAt: null }], NOW, new Map([[req.code, { ...v, recoveryLabel: op.recovery[0]!.label }]]));
    expect(decision.status).toBe("blocked");
    expect(decision.blocking[0]!.state).toBe("restricted");
    // An Academy row with no restriction data cannot vouch for interprovincial authority on its own.
    expect(trainingDispatchDecision([req], [{ code: "DRIVER_LICENCE_CLASS_1", status: "current", expiresAt: null }], NOW).status).toBe("blocked");
    expect(crewCoverage({ people: [{ userId: 1, holdings: restricted }, { userId: 2, holdings: [h("DRIVER_LICENCE_CLASS_1")] }], requiredCodes: ["DRIVER_LICENCE_CLASS_1"], at: NOW, scope: { interprovincial: true } }).headline).toContain("Only 1 of 2");
  });
});

describe("handoffs never touch readiness (2, 21, 22)", () => {
  it("2/21. no handoff status — requested, booked, completed, uploaded — produces a held credential", () => {
    // The readiness path reads holdings only; a handoff is not a holding in any state.
    for (const status of ["REQUESTED", "BOOKED", "TRAINING_COMPLETED", "DOCUMENT_UPLOADED_UNVERIFIED"]) {
      expect(workerFacingStatus(status as never).step).toBeLessThan(5);
      expect(heldForWork([], "H2S_ALIVE", NOW).held, status).toBe(false);
    }
    expect(handoffTransition({ from: "DOCUMENT_UPLOADED_UNVERIFIED", to: "VERIFIED", actor: "admin", linkedHolding: null, qualificationCode: "H2S_ALIVE" }).permitted).toBe(false);
    expect(handoffTransition({ from: "DOCUMENT_UPLOADED_UNVERIFIED", to: "VERIFIED", actor: "admin", linkedHolding: { verificationState: "unverified", code: "H2S_ALIVE" }, qualificationCode: "H2S_ALIVE" }).permitted).toBe(false);
    expect(handoffTransition({ from: "DOCUMENT_UPLOADED_UNVERIFIED", to: "VERIFIED", actor: "admin", linkedHolding: { verificationState: "verified", code: "H2S_ALIVE" }, qualificationCode: "H2S_ALIVE" }).permitted).toBe(true);
    expect(handoffTransition({ from: "VERIFIED", to: "ACTIVE", actor: "admin", linkedHolding: { verificationState: "verified", code: "H2S_ALIVE" }, qualificationCode: "H2S_ALIVE", heldNow: false }).permitted).toBe(false);
    expect(handoffTransition({ from: "REQUESTED", to: "BOOKED", actor: "employee", qualificationCode: "H2S_ALIVE" }).permitted).toBe(false);
    expect(handoffTransition({ from: "BOOKED", to: "TRAINING_COMPLETED", actor: "employee", qualificationCode: "H2S_ALIVE" }).permitted).toBe(true);
    expect(handoffTransition({ from: "CANCELLED", to: "REQUESTED", actor: "employee", qualificationCode: "H2S_ALIVE" }).permitted).toBe(false);
  });
  it("22. an employee requests only for themself unless they hold workforce authority; a second tap returns the open request", () => {
    expect(requestAuthority({ callerUserId: 1, subjectUserId: 1, callerHasWorkforceAuthority: false }).permitted).toBe(true);
    expect(requestAuthority({ callerUserId: 1, subjectUserId: 2, callerHasWorkforceAuthority: false }).permitted).toBe(false);
    expect(requestAuthority({ callerUserId: 1, subjectUserId: 2, callerHasWorkforceAuthority: true }).permitted).toBe(true);
    expect(openDuplicate([{ userId: 1, qualificationCode: "H2S_ALIVE", status: "BOOKED" as const }], 1, "H2S_ALIVE")).not.toBeNull();
    expect(openDuplicate([{ userId: 1, qualificationCode: "H2S_ALIVE", status: "CANCELLED" as const }], 1, "H2S_ALIVE")).toBeNull();
  });
  it("authoritative directories and company providers are kept apart; preferred providers first", () => {
    const o = providerOptions({
      capabilities: ["FIRST_AID_BASIC"],
      authoritativeSources: [{ sourceRef: "SRC-AB-FIRST-AID-AGENCIES", title: "Approved agencies", sourceUrl: "https://www.alberta.ca/first-aid-training", capabilityCodes: ["FIRST_AID_BASIC"], reviewStatus: "unreviewed" }],
      companyProviders: [{ vendorRef: "V2", name: "Zed", phone: null, email: null, capabilityCode: "FIRST_AID_BASIC", preferred: false, bookingUrl: null, active: true }, { vendorRef: "V1", name: "ABC Safety", phone: null, email: null, capabilityCode: "FIRST_AID_BASIC", preferred: true, bookingUrl: null, active: true }],
    });
    expect(o.official[0]!.kind).toBe("authoritative_directory");
    expect(o.company.map(c => c.name)).toEqual(["ABC Safety", "Zed"]);
  });
});

describe("dispatch sees the answer, not the file (24)", () => {
  it("24. the operational view carries no certificate number, document reference or private note", () => {
    const row = { ...h("H2S_ALIVE"), certificateNumber: "SECRET-123", documentRef: "DOC-9", privateNotes: "HR note" } as WalletHolding & Record<string, unknown>;
    const out = operationalView({ holdings: [row], codes: ["H2S_ALIVE", "FIRST_AID"], at: NOW });
    const text = JSON.stringify(out);
    expect(text).not.toContain("SECRET-123");
    expect(text).not.toContain("DOC-9");
    expect(text).not.toContain("HR note");
    expect(Object.keys(out[0]!).sort()).toEqual(["code", "expiresAt", "reason", "recovery", "state"]);
    expect(out[1]).toMatchObject({ state: "unknown" });
    expect(out[1]!.recovery.map(r => r.action)).toEqual(["request_renewal", "view_provider_options"]);
    const upload = operationalView({ holdings: [h("FIRST_AID", { verificationState: "unverified" })], codes: ["FIRST_AID"], at: NOW })[0]!;
    expect(upload).toMatchObject({ state: "unverified" });
    expect(upload.recovery[0]!.label).toBe("Safety/Admin verification required");
  });
});

describe("study banks are version-locked (18)", () => {
  it("18. a new bank version does not rewrite an attempt graded against the old one", () => {
    const v1 = [{ code: "Q1", domain: "a", prompt: "old?", options: ["yes", "no"], correctIndex: 0, explanation: "" }];
    const built = buildAssessment({ attemptSeed: "ATT-1", questions: v1, policy: { questionCount: 1, passingScorePercent: 100 } });
    const responses = { Q1: built.items[0]!.answerOrder.indexOf(0) };
    const before = gradeAssessment({ bank: v1, presented: built.items, responses, policy: built.policySnapshot });
    // Version 2 changes the answer. The v1 attempt is graded against its own snapshotted bank.
    const v2 = [{ ...v1[0]!, prompt: "new?", correctIndex: 1 }];
    expect(gradeAssessment({ bank: v1, presented: built.items, responses, policy: built.policySnapshot })).toEqual(before);
    expect(before.passed).toBe(true);
    expect(gradeAssessment({ bank: v2, presented: built.items, responses, policy: built.policySnapshot }).passed).toBe(false);
    // The re-published tracks carry an explicit new version; their old version 1 stays where it was.
    for (const code of ["CLASS1", "CLASS2", "CLASS3", "AIRBRAKE-Q"]) expect(STUDY_CENTRE_COURSES.find(c => c.code === code)!.version).toBe(2);
  });
  it("mock exams draw across every domain and report weak areas", () => {
    const course = STUDY_CENTRE_COURSES.find(c => c.code === "AIRBRAKE-Q")!;
    const built = buildAssessment({ attemptSeed: "MOCK-1", questions: course.questions, policy: { questionCount: 12, passingScorePercent: 83, stratifyByDomain: true } });
    const domains = new Set(course.questions.map(q => q.domain));
    expect(new Set(built.items.map(i => i.domain)).size).toBe(Math.min(12, domains.size));
    expect(weakAreas({ supply: 50, warning: 100, leakage: 70 }, 80)).toEqual([{ domain: "supply", scorePercent: 50 }, { domain: "leakage", scorePercent: 70 }]);
  });
  it("every Study Centre question names its source and section, and every course carries the boundary notice", () => {
    for (const c of STUDY_CENTRE_COURSES) {
      expect(c.studyCentre?.boundaryNotice.length, c.code).toBeGreaterThan(40);
      for (const q of c.questions) {
        expect(q.sourceRef, q.code).toBeTruthy();
        expect(q.sourceSection, q.code).toBeTruthy();
        expect(q.options).toHaveLength(4);
        expect(new Set(q.options).size).toBe(4);
      }
      expect(new Set(c.questions.map(q => q.code)).size).toBe(c.questions.length);
    }
  });
});

describe("sources are not silently authoritative (19)", () => {
  it("19. an unreviewed source is never quoted as the answer, and never kept offline", () => {
    const passages: TutorPassage[] = [{ passageRef: "P1", sourceRef: "SRC-X", sourceTitle: "Commercial Driver's Guide", sourceUrl: "https://example.org", sourceEdition: "Spring 2025", sourceReviewStatus: "unreviewed", section: "Trip air brake inspection", jurisdiction: "CA-AB", text: "The governor controls the compressor cut-in and cut-out pressure. Reservoirs store compressed air." }];
    const q = "What does the governor control on the compressor?";
    const unreviewed = tutorAnswer({ mode: "explain", question: q, passages, at: NOW });
    expect(unreviewed.status).toBe("UNKNOWN_REFER_TO_AUTHORITY");
    expect(unreviewed.referTo[0]!.sourceRef).toBe("SRC-X");
    const reviewed = tutorAnswer({ mode: "explain", question: q, passages: [{ ...passages[0]!, sourceReviewStatus: "reviewed" }], at: NOW });
    expect(reviewed.status).toBe("GROUNDED");
    expect(reviewed.citations[0]).toMatchObject({ sourceRef: "SRC-X", edition: "Spring 2025" });
    expect(tutorAnswer({ mode: "explain", question: "What is the maximum speed on the moon?", passages: [{ ...passages[0]!, sourceReviewStatus: "reviewed" }], at: NOW }).status).toBe("UNKNOWN_REFER_TO_AUTHORITY");
    expect(offlineCopyDecision({ reviewStatus: "unreviewed", licenceStatus: "open_licence_stated", redistributionConfirmedByUserId: null }).permitted).toBe(false);
    expect(offlineCopyDecision({ reviewStatus: "reviewed", licenceStatus: "open_licence_stated", redistributionConfirmedByUserId: null }).permitted).toBe(false);
    expect(offlineCopyDecision({ reviewStatus: "reviewed", licenceStatus: "open_licence_stated", redistributionConfirmedByUserId: 5 }).permitted).toBe(true);
    expect(offlineCopyDecision({ reviewStatus: "reviewed", licenceStatus: "link_only", redistributionConfirmedByUserId: 5 }).permitted).toBe(false);
  });
  it("the tutor refuses to say a learner passed an official test, to issue a credential, or to call study text law", () => {
    for (const q of ["Did I pass the official knowledge test?", "Can you issue my Q endorsement now?", "Is this the law?"]) {
      expect(tutorAnswer({ mode: "explain", question: q, passages: [], at: NOW }).status, q).toBe("REFUSED");
    }
  });
  it("every seeded library source states how the learner reaches it", () => {
    for (const s of STUDY_LIBRARY_SOURCES) {
      expect(s.sourceUrl, s.sourceRef).toMatch(/^(https:\/\/|internal:\/\/)/);
      expect(s.licenceStatus, s.sourceRef).toBeDefined();
    }
  });
});

describe("career pathway is a view, not an eligibility decision", () => {
  it("government eligibility steps read UNKNOWN / VERIFY WITH AUTHORITY; a restricted Class 1 does not complete the full step", () => {
    const pw = CAREER_PATHWAYS.find(p => p.code === "CLASS3-TO-CLASS1")!;
    const out = evaluatePathway({ pathway: pw, roles: ["driver"], studied: [{ courseCode: "CLASS1", status: "completed" }], holdings: [h("DRIVER_LICENCE_CLASS_3"), h("DRIVER_LICENCE_CLASS_1", { restrictions: ["PROVINCIAL_RESTRICTION"] })], competentCodes: [], at: NOW });
    const byCode = Object.fromEntries(out.steps.map(s => [s.code, s.state]));
    expect(byCode).toMatchObject({ C3: "complete", "C1-STUDY": "complete", C1LP: "UNKNOWN_VERIFY_WITH_AUTHORITY", "C1-RESTRICTED": "complete", EXPERIENCE: "UNKNOWN_VERIFY_WITH_AUTHORITY", "C1-FULL": "in_progress" });
    expect(out.disclaimer).toContain("does not decide regulatory eligibility");
    const sw = evaluatePathway({ pathway: CAREER_PATHWAYS.find(p => p.code === "SWAMPER-TO-DRIVER")!, roles: [], studied: [{ courseCode: "CLASS3", status: "completed" }], holdings: [], competentCodes: [], at: NOW });
    expect(sw.steps.find(s => s.code === "C3-STUDY")!.detail).toContain("not a licence");
    expect(sw.steps.find(s => s.code === "C3-LICENCE")!.state).toBe("not_started");
  });
  it("every seeded policy has a source and a lifecycle, and no policy invents an expiry for a no-expiry rule", () => {
    for (const p of CREDENTIAL_POLICIES) {
      expect(p.sourceRefs.length, p.policyRef).toBeGreaterThan(0);
      if (p.lifecycle === "no_expiry_endorsement") expect(p.reminderTemplate).toBe("");
    }
  });
});

describe("same-second renewal", () => {
  it("a renewal recorded in the same second as the holding it supersedes is the current one, whatever order the rows arrive in", () => {
    const at = d("2026-06-01");
    const old = h("H2S_ALIVE", { recordedAt: at, verificationState: "superseded", supersededByHoldingRef: "NEW", expiresAt: d("2026-10-10") });
    const renewal = h("H2S_ALIVE", { holdingRef: "NEW", recordedAt: at, expiresAt: d("2029-10-01") });
    for (const rows of [[old, renewal], [renewal, old]]) {
      const v = countsAsHeld(rows, "H2S_ALIVE", NOW);
      expect(v.held).toBe(true);
      expect(operationalView({ holdings: rows, codes: ["H2S_ALIVE"], at: d("2026-11-01") })[0]!.state).toBe("held");
    }
  });
});
