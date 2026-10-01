import { beforeAll, describe, expect, it } from "vitest";
import { complianceRequirementValidity } from "./_core/complianceDocumentValidity";
import mysql from "mysql2/promise";
import {
  abstractRequestPermitted, buildPassport, composeJobPassport, evaluateRequirement, MEDICAL_FITNESS_DOC_TYPES, medicalFitnessForDispatch,
  nextRenewalDue, requirementApplies, tripInspectionValidity, PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED,
  type Credential, type Requirement, type Subject,
} from "./_core/compliancePassport";
import { COMPLIANCE_REQUIREMENT_SEEDS, APPLICABILITY_CLAIMS_UNVERIFIED } from "./_core/complianceRequirementSeeds";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const NOW = new Date("2026-09-10T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const req = (over: Partial<Requirement> = {}): Requirement => ({
  requirementKey: "test.req", version: 1, family: "test", title: "Test requirement", subjectType: "operator", jurisdiction: "CA-AB",
  satisfiedByDocTypes: ["test_doc"], warnDaysBeforeExpiry: 30, missingSeverity: "blocked", verificationStatus: "verified",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"), ...over,
});
const cred = (over: Partial<Credential> = {}): Credential => ({ docType: "test_doc", expiresAt: days(400), verificationStatus: "verified", privateDetail: false, ...over });
/** Medical rows judged the way production judges them: the canonical verdict, then the projection. */
const medical = (rows: { expiresAt: Date | null; verificationStatus?: "needs_review" | "verified" | "rejected"; issuedAt?: Date | null; capturedAt?: Date }[]) =>
  complianceRequirementValidity(rows.map((r, i) => ({
    id: i + 1, docType: "medical_fitness", title: "Medical", issuedAt: r.issuedAt ?? null, expiresAt: r.expiresAt,
    verificationStatus: r.verificationStatus ?? "verified", capturedAt: r.capturedAt ?? days(-10 + i),
  })), MEDICAL_FITNESS_DOC_TYPES, NOW);
const subject = (over: Partial<Subject> = {}): Subject => ({ subjectType: "operator", jurisdiction: "CA-AB", attributes: {}, ...over });

/* ------------------------------------------------------------------ */
/* Rule 1: an unverified requirement yields UNKNOWN                     */
/* ------------------------------------------------------------------ */

describe("an unverified requirement is unknown, never met", () => {
  it("returns requirement_unverified even with perfect evidence", () => {
    const item = evaluateRequirement({ requirement: req({ verificationStatus: "unverified" }), credentials: [cred()], now: NOW });
    expect(item.status).toBe("requirement_unverified");
    expect(item.effect).toBe("unknown");
  });

  it("makes the passport UNKNOWN — it does not round up to review or ready", () => {
    const p = buildPassport({ subject: subject(), requirements: [req({ verificationStatus: "unverified" })], credentials: [cred()], now: NOW });
    expect(p.verdict).toBe("unknown");
  });

  it("is outranked only by blocked", () => {
    const p = buildPassport({
      subject: subject(),
      requirements: [req({ requirementKey: "a", verificationStatus: "unverified" }), req({ requirementKey: "b", satisfiedByDocTypes: ["other"] })],
      credentials: [cred()], now: NOW,
    });
    expect(p.verdict).toBe("blocked");
  });

  it("holds every seeded requirement at unverified, and every applicability claim too", () => {
    expect(COMPLIANCE_REQUIREMENT_SEEDS.length).toBeGreaterThan(15);
    expect(COMPLIANCE_REQUIREMENT_SEEDS.every(r => r.verificationStatus === "unverified")).toBe(true);
    expect(APPLICABILITY_CLAIMS_UNVERIFIED.length).toBeGreaterThan(2);
    // With every seed unverified, a fully credentialed driver still gets UNKNOWN.
    const p = buildPassport({
      subject: subject({ attributes: { licenceClassRequired: "1", commercialDriver: true, ageAtMost: 44, age: 30 } }),
      requirements: COMPLIANCE_REQUIREMENT_SEEDS,
      credentials: [cred({ docType: "driver_licence" }), cred({ docType: "commercial_driver_abstract" }), cred({ docType: "medical_fitness" })],
      now: NOW,
    });
    expect(p.verdict).toBe("unknown");
    expect(p.items.every(i => i.status === "requirement_unverified")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Rule 2: missing document ≠ expired credential                        */
/* ------------------------------------------------------------------ */

describe("a missing document is not an expired credential", () => {
  it("blocks on an expired licence", () => {
    const item = evaluateRequirement({ requirement: req(), credentials: [cred({ expiresAt: days(-3) })], now: NOW });
    expect(item.status).toBe("expired");
    expect(item.effect).toBe("blocked");
    expect(item.reason).toContain("expired 3 day(s) ago");
  });

  it("reviews on a missing proof-of-insurance, because coverage may exist unproven", () => {
    const item = evaluateRequirement({ requirement: req({ missingSeverity: "review", title: "Proof of insurance" }), credentials: [], now: NOW });
    expect(item.status).toBe("missing");
    expect(item.effect).toBe("review");
    expect(item.reason).toContain("underlying credential may exist");
  });

  it("blocks on a missing licence, because a licence nobody has seen cannot be assumed", () => {
    const item = evaluateRequirement({ requirement: req({ missingSeverity: "blocked" }), credentials: [], now: NOW });
    expect(item.status).toBe("missing");
    expect(item.effect).toBe("blocked");
  });

  it("reviews on unverified evidence and on expiring evidence", () => {
    expect(evaluateRequirement({ requirement: req(), credentials: [cred({ verificationStatus: "needs_review" })], now: NOW }).status).toBe("evidence_unverified");
    const exp = evaluateRequirement({ requirement: req(), credentials: [cred({ expiresAt: days(14) })], now: NOW });
    expect(exp.status).toBe("expiring");
    expect(exp.daysToExpiry).toBe(14);
    expect(exp.effect).toBe("review");
  });

  it("does not call a daily item expiring with hours left when its warn window is zero", () => {
    // v20.22 found this: floor(0.5 days) = 0, and 0 <= 0 flagged every valid
    // pre-use inspection as expiring. Zero means never warn.
    const item = evaluateRequirement({ requirement: req({ warnDaysBeforeExpiry: 0, renewalIntervalDays: 1 }), credentials: [cred({ expiresAt: new Date(NOW.getTime() + 12 * 3_600_000) })], now: NOW });
    expect(item.status).toBe("satisfied");
    expect(evaluateRequirement({ requirement: req({ warnDaysBeforeExpiry: 0 }), credentials: [cred({ expiresAt: days(-0.5) })], now: NOW }).status).toBe("expired");
  });

  it("blocks when the only evidence was rejected", () => {
    expect(evaluateRequirement({ requirement: req(), credentials: [cred({ verificationStatus: "rejected" })], now: NOW }).status).toBe("evidence_rejected");
  });

  it("prefers a verified credential over an unverified one for the same requirement", () => {
    const item = evaluateRequirement({ requirement: req(), credentials: [cred({ verificationStatus: "needs_review", expiresAt: days(900) }), cred({ verificationStatus: "verified", expiresAt: days(200) })], now: NOW });
    expect(item.status).toBe("satisfied");
    expect(item.daysToExpiry).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Applicability                                                        */
/* ------------------------------------------------------------------ */

describe("a requirement applies where, when and to whom it says", () => {
  it("matches jurisdiction, subject type and predicates", () => {
    const r = req({ jurisdiction: "CA-AB", appliesWhen: { licenceClassRequired: "1", gvwKgAtLeast: 11794 } });
    expect(requirementApplies(r, subject({ attributes: { licenceClassRequired: "1", gvwKg: 15000 } }), NOW)).toBe(true);
    expect(requirementApplies(r, subject({ attributes: { licenceClassRequired: "1", gvwKg: 9000 } }), NOW)).toBe(false);
    expect(requirementApplies(r, subject({ jurisdiction: "CA-BC", attributes: { licenceClassRequired: "1", gvwKg: 15000 } }), NOW)).toBe(false);
    expect(requirementApplies(r, subject({ subjectType: "unit", attributes: { licenceClassRequired: "1", gvwKg: 15000 } }), NOW)).toBe(false);
  });

  it("selects the medical interval by age band from the seeds", () => {
    const meds = COMPLIANCE_REQUIREMENT_SEEDS.filter(r => r.family === "medical_fitness");
    const at = (age: number) => meds.filter(r => requirementApplies(r, subject({ attributes: { commercialDriver: true, age } }), NOW)).map(r => r.requirementKey);
    expect(at(30)).toEqual(["ab.driver.medical.under45"]);
    expect(at(50)).toEqual(["ab.driver.medical.45to65"]);
    expect(at(70)).toEqual(["ab.driver.medical.over65"]);
  });

  it("respects effective dates and skips superseded rules", () => {
    expect(requirementApplies(req({ effectiveFrom: days(1) }), subject(), NOW)).toBe(false);
    expect(requirementApplies(req({ effectiveUntil: days(-1) }), subject(), NOW)).toBe(false);
    expect(requirementApplies(req({ verificationStatus: "superseded" }), subject(), NOW)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Rule 3: privacy is a projection                                      */
/* ------------------------------------------------------------------ */

describe("dispatch learns eligible, never why", () => {
  it("projects medical fitness to yes / no / unknown only", () => {
    expect(medicalFitnessForDispatch(medical([{ expiresAt: days(400) }])).eligible).toBe("yes");
    expect(medicalFitnessForDispatch(medical([{ expiresAt: days(-1) }])).eligible).toBe("no");
    expect(medicalFitnessForDispatch(medical([{ expiresAt: days(400), verificationStatus: "needs_review" }])).eligible).toBe("unknown");
    expect(medicalFitnessForDispatch(medical([])).eligible).toBe("unknown");
  });

  it("names the fields that never leave HR", () => {
    expect(PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED).toContain("title");
    expect(PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED).toContain("storageKey");
    const projection = medicalFitnessForDispatch(medical([{ expiresAt: days(400) }]));
    for (const f of PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED) expect(projection).not.toHaveProperty(f);
  });
});

/* ------------------------------------------------------------------ */
/* Inspections, renewals, consent, composition                          */
/* ------------------------------------------------------------------ */

describe("trip inspection validity is computed, not assumed", () => {
  it("knows whether the previous driver's inspection still covers the truck", () => {
    const v = tripInspectionValidity({ completedAt: new Date("2026-09-10T05:42:00Z"), now: NOW, validityHours: 24 });
    expect(v.status).toBe("valid");
    expect(v.hoursRemaining).toBe(17.7);
    expect(tripInspectionValidity({ completedAt: new Date("2026-09-09T05:42:00Z"), now: NOW, validityHours: 24 }).status).toBe("expired");
    expect(tripInspectionValidity({ completedAt: null, now: NOW, validityHours: 24 }).status).toBe("none");
  });
});

describe("renewals and consent", () => {
  it("computes the next abstract from the last, and says due-now when never obtained", () => {
    expect(nextRenewalDue({ lastObtainedAt: new Date("2026-06-04T00:00:00Z"), intervalDays: 365 }).dueAt?.toISOString().slice(0, 10)).toBe("2027-06-04");
    expect(nextRenewalDue({ lastObtainedAt: null, intervalDays: 365 }).reason).toContain("due now");
    expect(nextRenewalDue({ lastObtainedAt: NOW, intervalDays: null }).dueAt).toBeNull();
  });

  it("permits an abstract request only under a live consent for that purpose", () => {
    expect(abstractRequestPermitted({ consent: null, now: NOW }).permitted).toBe(false);
    expect(abstractRequestPermitted({ consent: { signedAt: days(-10), consentType: "commercial_driver_abstract" }, now: NOW }).permitted).toBe(true);
    expect(abstractRequestPermitted({ consent: { signedAt: days(-10), consentType: "commercial_driver_abstract", withdrawnAt: days(-1) }, now: NOW }).permitted).toBe(false);
    expect(abstractRequestPermitted({ consent: { signedAt: days(-10), consentType: "background_check" }, now: NOW }).reason).toContain("different purpose");
  });
});

describe("a job is ready only when everything it depends on is", () => {
  const ready = buildPassport({ subject: subject(), requirements: [req()], credentials: [cred()], now: NOW });
  const review = buildPassport({ subject: subject(), requirements: [req({ missingSeverity: "review" })], credentials: [], now: NOW });
  const unknown = buildPassport({ subject: subject(), requirements: [req({ verificationStatus: "unverified" })], credentials: [cred()], now: NOW });
  const blocked = buildPassport({ subject: subject(), requirements: [req()], credentials: [cred({ expiresAt: days(-1) })], now: NOW });

  it("composes worst-wins with unknown above review", () => {
    expect(composeJobPassport({ carrier: ready, operator: ready, unit: ready }).verdict).toBe("ready");
    expect(composeJobPassport({ carrier: ready, operator: review, unit: ready }).verdict).toBe("review");
    expect(composeJobPassport({ carrier: ready, operator: review, unit: unknown }).verdict).toBe("unknown");
    expect(composeJobPassport({ carrier: blocked, operator: review, unit: unknown }).verdict).toBe("blocked");
  });

  it("treats an absent passport as unknown", () => {
    const j = composeJobPassport({ carrier: ready, operator: null, unit: ready });
    expect(j.verdict).toBe("unknown");
    expect(j.parts.operator).toBe("absent");
  });
});

/* ------------------------------------------------------------------ */
/* Permissions and the flow                                             */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("who may verify, who may load a requirement, who may read private detail", () => {
  it("reserves requirement loading to the controller and private detail to HR", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "compliance.requirement.manage" }).allowed)).toEqual(["controller"]);
    // C1b-2b: proposing, verifying and second approval are separate permissions.
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "compliance.requirement.propose" }).allowed).sort()).toEqual(["controller", "legal", "safety"]);
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "compliance.requirement.second_approve" }).allowed).sort()).toEqual(["controller", "legal", "management"]);
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "compliance.private.read" }).allowed)).toEqual(["hr"]);
  });
  it("lets dispatch read a passport but not verify a credential", () => {
    expect(authorize({ userId: 1, roles: ["dispatcher"], permission: "compliance.passport.read" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["dispatcher"], permission: "compliance.credential.verify" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 402_000_000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a driver, a unit and a carrier, through the registry", () => {
  it("stays UNKNOWN on seeds, becomes READY only when a proposed requirement is verified by two other people and evidence is verified", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const legal = await withRole("legal");
    const management = await withRole("management");
    const dispatcher = await withRole("dispatcher");
    const hr = await withRole("hr");
    // F1.2 — a real operator: a made-up operator id is "not found".
    const operatorId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES ('Passport Fixture', NOW())"))[0].insertId);

    // Office records a licence. It enters needs_review.
    const rec = await callerFor(office).compliance.credentialRecord({ ownerType: "operator", ownerId: operatorId, docType: "driver_licence", requirementKey: "ab.driver.licence.class1", title: "Class 1 licence", identifier: "•••1234", expiresAt: new Date("2028-04-21T00:00:00Z"), jurisdiction: "CA-AB" });
    expect(rec.verificationStatus).toBe("needs_review");

    // Passport against the seeds: unknown, because the requirement is unverified.
    const p1 = await callerFor(dispatcher).compliance.passport({ subjectType: "operator", subjectId: operatorId, jurisdiction: "CA-AB", attributes: { licenceClassRequired: "1" } });
    expect(p1.verdict).toBe("unknown");

    // C1b-2b: the controller proposes (asking for "verified" changes nothing); the proposal replaces
    // the seed and is still unverified, so the passport stays UNKNOWN.
    const load = await callerFor(controller).compliance.requirementLoad({
      requirementKey: "ab.driver.licence.class1", family: "driver_licensing", title: "Class 1 driver licence", subjectType: "operator", jurisdiction: "CA-AB",
      appliesWhen: { licenceClassRequired: "1" }, satisfiedByDocTypes: ["driver_licence"], missingSeverity: "blocked",
      // FIXTURE citation — not a verified reading of the instrument.
      instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation", sourceAuthority: "FIXTURE AUTHORITY", sourceReference: "s. 1(1)",
      sourceUrl: "https://www.alberta.ca/fixture-not-a-real-page", authorityType: "law",
      sourceVerified: true, requestedStatus: "verified", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    });
    expect(load.storedStatus).toBe("unverified");
    expect((await callerFor(dispatcher).compliance.passport({ subjectType: "operator", subjectId: operatorId, jurisdiction: "CA-AB", attributes: { licenceClassRequired: "1" } })).verdict).toBe("unknown");

    // A blocking requirement: two verifiers, neither the proposer.
    const verify = { requirementKey: "ab.driver.licence.class1", version: load.version, target: "CITATION_VERIFIED" as const, decision: "approve" as const, reason: "Checked against the cited section" };
    await callerFor(legal).compliance.requirementVerify(verify);
    await callerFor(management).compliance.requirementSecondApprove(verify);

    // Still not ready: the evidence itself is unverified.
    const p2 = await callerFor(dispatcher).compliance.passport({ subjectType: "operator", subjectId: operatorId, jurisdiction: "CA-AB", attributes: { licenceClassRequired: "1" } });
    expect(p2.verdict).toBe("review");
    expect(p2.items.find(i => i.requirementKey === "ab.driver.licence.class1")?.status).toBe("evidence_unverified");

    // Dispatch cannot verify it; office can.
    await expect(callerFor(dispatcher).compliance.credentialVerify({ credentialId: rec.credentialId, outcome: "verified" })).rejects.toBeTruthy();
    await callerFor(office).compliance.credentialVerify({ credentialId: rec.credentialId, outcome: "verified" });
    const p3 = await callerFor(dispatcher).compliance.passport({ subjectType: "operator", subjectId: operatorId, jurisdiction: "CA-AB", attributes: { licenceClassRequired: "1" } });
    expect(p3.verdict).toBe("ready");
    expect(p3.satisfied).toBe(1);

    // A requirement load that asks for verified is stored as a proposal, whatever it claims.
    const weak = await callerFor(controller).compliance.requirementLoad({
      requirementKey: "ab.unit.registration", family: "vehicle_credentials", title: "Registration", subjectType: "unit", jurisdiction: "CA-AB",
      satisfiedByDocTypes: ["vehicle_registration"], sourceAuthority: "someone said", sourceVerified: false, requestedStatus: "verified", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    });
    expect(weak.storedStatus).toBe("unverified");
    expect(weak.note).toContain("never by the proposer's own flag");

    // Medical: HR records it private; dispatch sees only eligibility.
    await callerFor(hr).compliance.credentialRecord({ ownerType: "operator", ownerId: operatorId, docType: "medical_fitness", title: "Medical report — see HR", expiresAt: new Date("2028-04-21T00:00:00Z"), privateDetail: true });
    const med = await callerFor(dispatcher).compliance.medicalEligibility({ operatorId });
    expect(med.eligible).toBe("unknown"); // needs_review until HR verifies
    expect(med).not.toHaveProperty("title");
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT privateDetail FROM complianceDocuments WHERE ownerId = ? AND docType = 'medical_fitness'", [operatorId]);
    expect(Number(row[0].privateDetail)).toBe(1);
  });

  it("versions a written program without overwriting, and flags unmatched profile events", async () => {
    const safety = await withRole("safety");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1.1 — a real book: a made-up entity id is "not found"
    const pk = `safety-${entityId}`;
    const v1 = await callerFor(safety).compliance.programPublish({ programKey: pk, title: "Safety Program", programType: "safety", financialEntityId: entityId, effectiveFrom: new Date("2026-01-01T00:00:00Z") });
    const v2 = await callerFor(safety).compliance.programPublish({ programKey: pk, title: "Safety Program", programType: "safety", financialEntityId: entityId, effectiveFrom: new Date("2026-09-01T00:00:00Z") });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.supersededVersion).toBe(1);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT version, supersededAt, supersededByVersion FROM writtenProgramVersions WHERE programKey = ? ORDER BY version", [pk]);
    expect(rows).toHaveLength(2);
    expect(rows[0].supersededAt).not.toBeNull();
    expect(Number(rows[0].supersededByVersion)).toBe(2);
    expect(rows[1].supersededAt).toBeNull();

    const review = await callerFor(safety).compliance.profileReviewRecord({
      financialEntityId: entityId, jurisdiction: "CA-AB", profileObtainedAt: new Date("2026-09-01T00:00:00Z"),
      inspectionsOnProfile: 5, convictionsOnProfile: 1, collisionsOnProfile: 0, knownInspections: 3, knownConvictions: 1, knownCollisions: 0,
    });
    expect(review.unmatchedExternalEvents).toBe(2);
    expect(review.exception).toContain("2 external compliance event(s) unmatched");
    expect(review.nextReviewDueAt?.toISOString().slice(0, 10)).toBe("2026-12-01");
  });
});

/* ------------------------------------------------------------------ */
/* Private evidence says whether, never why                            */
/* ------------------------------------------------------------------ */

describe("private evidence does not explain itself on a passport", () => {
  /*
   * `Credential.privateDetail` was declared and read nowhere — a field shaped
   * like a filter that filtered nothing. The module's own header swears dispatch
   * "never learns why not", and `medicalFitnessForDispatch` keeps that promise by
   * flattening rejection and expiry alike to eligible:"no". The passport did not:
   * it returned `evidence_rejected` with the prose "evidence was rejected on
   * review" against a requirement titled "Commercial medical (45–65: every 3
   * years)", for any operator id a caller named, to any of the ten roles holding
   * compliance.passport.read — drivers and dispatchers among them.
   *
   * That single bit is a medical judgement about a named person. The effect
   * (blocked / review) is not private and is preserved, because dispatch has to
   * act on it.
   */
  it("withholds the reason when private evidence was rejected", () => {
    const item = evaluateRequirement({
      requirement: req({ title: "Commercial medical (45–65: every 3 years)" }),
      credentials: [cred({ verificationStatus: "rejected", privateDetail: true })],
      now: NOW,
    });
    expect(item.status).toBe("evidence_withheld");
    expect(item.effect, "the consequence is not private — dispatch still has to act").toBe("blocked");
    expect(item.reason).not.toMatch(/rejected/i);
  });

  it("withholds the reason when private evidence is unverified", () => {
    const item = evaluateRequirement({
      requirement: req(),
      credentials: [cred({ verificationStatus: "needs_review", privateDetail: true })],
      now: NOW,
    });
    expect(item.status).toBe("evidence_withheld");
    expect(item.effect).toBe("review");
    expect(item.reason).not.toMatch(/not been verified/i);
  });

  it("still explains itself when the evidence is not private", () => {
    // The withholding must be caused by privateDetail, not by the status —
    // otherwise every rejection everywhere goes silent and the passport stops
    // being useful for the ordinary case.
    const item = evaluateRequirement({
      requirement: req(),
      credentials: [cred({ verificationStatus: "rejected", privateDetail: false })],
      now: NOW,
    });
    expect(item.status).toBe("evidence_rejected");
    expect(item.reason).toMatch(/rejected/i);
  });

  it("keeps an expiry date on private evidence, because that date is already released", () => {
    // Deliberately NOT withheld: compliance.medicalEligibility returns the same
    // expiry as `reviewDue` under the same permission, so hiding it here would
    // remove a renewal reminder without closing anything. Expiry is administrative;
    // rejection is a judgement about the person.
    const item = evaluateRequirement({
      requirement: req(),
      credentials: [cred({ expiresAt: days(-1), privateDetail: true })],
      now: NOW,
    });
    expect(item.status).toBe("expired");
    expect(item.expiresAt).not.toBeNull();
  });

  it("does not disturb a satisfied private credential", () => {
    const item = evaluateRequirement({
      requirement: req(),
      credentials: [cred({ privateDetail: true })],
      now: NOW,
    });
    expect(item.status).toBe("satisfied");
  });
});
