import { describe, expect, it } from "vitest";
import {
  acknowledgementDecision, approvalDecision, assembleProgram, catalogIntegrity, contentHash, corReadiness, correctiveActionView, editDecision,
  eventHash, matrixSummary, nextReviewDue, parsePolicyCode, policyCode, programObligations, recommendedModules, recommendedPacks,
  reviewCompletionDecision, trainingMatrixFor, vendorPackageManifest, verificationDecision, verifyEventChain, versionHash,
  type CorEvidence, type LedgerEvent, type MatrixRequirement, type MatrixWorker, type OperationsProfile,
} from "./safetyProgram";
import { POLICY_TEMPLATE_SEEDS, REGULATORY_REFERENCE_SEEDS, SAFETY_PACKS, SAFETY_PROGRAM_MODULES } from "./safetyProgramCatalog";

const NOW = new Date("2026-09-24T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe("the library is a catalog, not a claim", () => {
  it("has fourteen modules with unique keys and unique code prefixes, in the order the library is organized", () => {
    expect(SAFETY_PROGRAM_MODULES.map(m => m.ordinal)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(new Set(SAFETY_PROGRAM_MODULES.map(m => m.codePrefix)).size).toBe(14);
    expect(SAFETY_PROGRAM_MODULES.map(m => m.moduleKey)).toEqual([
      "company_foundation", "ohs", "nsc_trucking", "oilfield_industrial", "ground_disturbance", "whmis_chemicals_tdg", "emergency_management",
      "incident_management", "workplace_conduct", "working_alone_remote", "environmental", "training_competency", "contractor_management", "vendor_prequalification",
    ]);
  });

  it("every template names a real module and a real pack, and no key repeats", () => {
    const r = catalogIntegrity();
    expect(r.problems).toEqual([]);
    expect(POLICY_TEMPLATE_SEEDS.length).toBeGreaterThan(250);
  });

  it("every regulatory reference a template cites exists in the seed, and every seed is unverified by construction", () => {
    const keys = new Set(REGULATORY_REFERENCE_SEEDS.map(r => r.referenceKey));
    for (const t of POLICY_TEMPLATE_SEEDS) for (const k of t.regulatoryReferenceKeys) expect(keys.has(k), `${t.templateKey} cites unknown ${k}`).toBe(true);
    // The seed type has no verification field at all: a seed cannot arrive verified.
    expect(Object.keys(REGULATORY_REFERENCE_SEEDS[0]!)).not.toContain("verificationStatus");
  });

  it("keeps the Alberta-specific items in the Alberta packs and the NSC transportation items apart from OHS", () => {
    const by = (k: string) => POLICY_TEMPLATE_SEEDS.find(t => t.templateKey === k)!;
    expect(by("ohs.health_and_safety_program_20_or_more_workers").packKey).toBe("ab_ohs");
    expect(by("ohs.working_alone").packKey).toBe("ab_ohs");
    expect(by("company_foundation.transportation_safety_policy").packKey).toBe("ab_nsc");
    expect(by("company_foundation.maintenance_policy").packKey).toBe("ab_nsc");
    expect(by("nsc_trucking.eld_and_logbook_policy").packKey).toBe("federal_carrier");
    expect(by("nsc_trucking.hours_of_service_policy").packKey).toBe("core");
    expect(by("oilfield_industrial.hydrovac_procedures").packKey).toBe("hydrovac");
    expect(by("whmis_chemicals_tdg.tdg_training_and_certification_records").regulatoryReferenceKeys).toContain("ca.tdg.regulations.part6_training");
  });

  it("forms are the only kind that does not require acknowledgement by default", () => {
    for (const t of POLICY_TEMPLATE_SEEDS) {
      if (t.documentKind === "form") expect(t.acknowledgementRequired).toBe(false);
      else if (t.templateKey !== "vendor_prequalification.vendor_compliance_package_assembly") expect(t.acknowledgementRequired).toBe(true);
    }
  });
});

describe("an operations profile says what applies", () => {
  const ab: OperationsProfile = { jurisdictions: ["CA-AB"], workforceSize: 24, nscCarrier: true, federalCarrier: false, oilfield: true, hydrovac: true, groundDisturbance: false, dangerousGoods: true, workingAlone: true };

  it("a 24-worker Alberta NSC hydrovac carrier owes a health and safety program, a committee, both NSC programs, and ground disturbance through hydrovac", () => {
    const o = Object.fromEntries(programObligations(ab).map(x => [x.key, x.applies]));
    expect(o).toMatchObject({ hs_program: true, hs_committee: true, hs_representative: false, nsc_programs: true, federal_hos_eld: false, violence_harassment: true, working_alone: true, tdg: true, ground_disturbance: true, oilfield: true });
  });

  it("a 12-worker company owes a representative rather than a committee, and no NSC programs when it is not a carrier", () => {
    const o = Object.fromEntries(programObligations({ ...ab, workforceSize: 12, nscCarrier: false, hydrovac: false, oilfield: false }).map(x => [x.key, x.applies]));
    expect(o).toMatchObject({ hs_program: false, hs_committee: false, hs_representative: true, nsc_programs: false, ground_disturbance: false, oilfield: false });
  });

  it("every obligation names the reference it rests on, so a person can verify it", () => {
    for (const o of programObligations(ab)) if (o.key !== "oilfield") expect(o.referenceKey, o.key).toBeTruthy();
  });

  it("recommends Alberta + Alberta NSC + oilfield + hydrovac + ground disturbance for that carrier, core always, and never a client or company overlay on its own", () => {
    const packs = recommendedPacks(ab).map(p => p.packKey);
    expect(packs).toEqual(expect.arrayContaining(["core", "ab_ohs", "ab_nsc", "oilfield", "hydrovac", "ground_disturbance"]));
    expect(packs).not.toContain("federal_carrier"); expect(packs).not.toContain("client"); expect(packs).not.toContain("sk_ohs");
    expect(recommendedModules(ab)).toContain("working_alone_remote");
    expect(recommendedModules({ ...ab, workingAlone: false, nscCarrier: false })).not.toContain("nsc_trucking");
  });
});

describe("assembly is a selection over the library", () => {
  it("core is always included; a selected pack pulls its templates; an unselected module drops its templates", () => {
    const a = assembleProgram({ packKeys: ["ab_ohs", "hydrovac"] });
    expect(a.packKeys[0]).toBe("core");
    expect(a.included.some(t => t.templateKey === "oilfield_industrial.hydrovac_procedures")).toBe(true);
    expect(a.included.some(t => t.templateKey === "oilfield_industrial.h2s_procedure")).toBe(false);   // oilfield pack not selected
    expect(a.included.some(t => t.templateKey === "ohs.working_alone")).toBe(true);
    const b = assembleProgram({ packKeys: ["ab_ohs", "hydrovac"], moduleKeys: ["ohs"] });
    expect(b.included.every(t => t.moduleKey === "ohs")).toBe(true);
    expect(b.excludedCount).toBe(POLICY_TEMPLATE_SEEDS.length - b.included.length);
  });

  it("the assembly hash changes with the selection and with a template version, and not otherwise", () => {
    const a1 = assembleProgram({ packKeys: ["ab_ohs"] }), a2 = assembleProgram({ packKeys: ["ab_ohs"] }), a3 = assembleProgram({ packKeys: ["ab_nsc"] });
    expect(a1.assemblyHash).toBe(a2.assemblyHash); expect(a1.assemblyHash).not.toBe(a3.assemblyHash);
    const bumped = POLICY_TEMPLATE_SEEDS.map(t => t.templateKey === "ohs.ppe_policy" ? { ...t, templateVersion: 2 } : t);
    expect(assembleProgram({ packKeys: ["ab_ohs"] }, bumped).assemblyHash).not.toBe(a1.assemblyHash);
  });

  it("ignores pack and module keys the library does not know rather than inventing them", () => {
    const a = assembleProgram({ packKeys: ["not_a_pack"], moduleKeys: ["not_a_module", "ohs"] });
    expect(a.packKeys).toEqual(["core"]); expect(a.moduleKeys).toEqual(["ohs"]);
  });
});

describe("policy codes and versions are controlled", () => {
  it("mints HSE-POL-001 style codes and parses them back", () => {
    expect(policyCode("HSE", "policy", 1)).toBe("HSE-POL-001");
    expect(policyCode("GD", "form", 12)).toBe("GD-FRM-012");
    expect(policyCode("NSC", "safe_work_practice", 1000)).toBe("NSC-SWP-1000");
    expect(parsePolicyCode("ERP-PLN-003")).toEqual({ codePrefix: "ERP", kindCode: "PLN", sequence: 3 });
    expect(parsePolicyCode("nonsense")).toBeNull();
    expect(() => policyCode("HSE", "policy", 0)).toThrow();
  });

  it("chains version hashes so a rewritten earlier version is visible from the next", () => {
    const c1 = contentHash("T", [{ heading: "Purpose", body: "a" }], "");
    const v1 = versionHash({ policyRef: "P", versionNumber: 1, contentHash: c1, previousVersionHash: null });
    const v2 = versionHash({ policyRef: "P", versionNumber: 2, contentHash: contentHash("T", [{ heading: "Purpose", body: "b" }], ""), previousVersionHash: v1 });
    const v1Rewritten = versionHash({ policyRef: "P", versionNumber: 1, contentHash: contentHash("T", [{ heading: "Purpose", body: "a (edited)" }], ""), previousVersionHash: null });
    expect(v1Rewritten).not.toBe(v1);
    expect(versionHash({ policyRef: "P", versionNumber: 2, contentHash: contentHash("T", [{ heading: "Purpose", body: "b" }], ""), previousVersionHash: v1Rewritten })).not.toBe(v2);
  });

  it("only a draft is editable; only a draft is approvable; never by its preparer; and the approver role is checked", () => {
    expect(editDecision("draft").allowed).toBe(true);
    expect(editDecision("approved")).toMatchObject({ allowed: false, reason: expect.stringMatching(/immutable/) });
    const base = { state: "draft", preparedByUserId: 7, approverUserId: 8, approverRoles: ["management"], requiredApproverRole: "management" };
    expect(approvalDecision(base).allowed).toBe(true);
    expect(approvalDecision({ ...base, approverUserId: 7 })).toMatchObject({ allowed: false, reason: expect.stringMatching(/prepared/) });
    expect(approvalDecision({ ...base, state: "approved" })).toMatchObject({ allowed: false });
    expect(approvalDecision({ ...base, approverRoles: ["safety"] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/management role/) });
    expect(approvalDecision({ ...base, approverRoles: ["safety"], requiredApproverRole: "safety" }).allowed).toBe(true);
    expect(approvalDecision({ ...base, approverRoles: ["management"], requiredApproverRole: "safety" }).allowed).toBe(true);   // management may always approve
  });

  it("schedules the next review from the effective date and the interval", () => {
    expect(nextReviewDue(new Date("2026-01-31T00:00:00Z"), 12).toISOString()).toBe("2027-01-31T00:00:00.000Z");
    expect(nextReviewDue(new Date("2026-01-15T00:00:00Z"), 0).toISOString()).toBe("2026-02-15T00:00:00.000Z");   // never zero
    expect(reviewCompletionDecision({ status: "scheduled" }, "no_change").allowed).toBe(true);
    expect(reviewCompletionDecision({ status: "completed" }, "no_change").allowed).toBe(false);
    expect(reviewCompletionDecision({ status: "scheduled" }, "shrug").allowed).toBe(false);
  });
});

describe("acknowledgement is read → understand → questions → sign, against the approved version", () => {
  const none = { readAt: null, understoodAt: null, questionsAnsweredAt: null, signedAt: null };
  it("refuses every step on anything but an approved version", () => {
    for (const s of ["draft", "superseded", "withdrawn"]) expect(acknowledgementDecision({ versionState: s, progress: none, step: "read" }).allowed).toBe(false);
  });
  it("requires each step before the next and all three before signing", () => {
    expect(acknowledgementDecision({ versionState: "approved", progress: none, step: "read" }).allowed).toBe(true);
    expect(acknowledgementDecision({ versionState: "approved", progress: none, step: "understood" }).allowed).toBe(false);
    expect(acknowledgementDecision({ versionState: "approved", progress: none, step: "sign" })).toMatchObject({ allowed: false, reason: expect.stringMatching(/Read, understood and questions/) });
    const read = { ...none, readAt: NOW };
    expect(acknowledgementDecision({ versionState: "approved", progress: read, step: "questions" }).allowed).toBe(false);
    const all = { readAt: NOW, understoodAt: NOW, questionsAnsweredAt: NOW, signedAt: null };
    expect(acknowledgementDecision({ versionState: "approved", progress: all, step: "sign" }).allowed).toBe(true);
    expect(acknowledgementDecision({ versionState: "approved", progress: { ...all, signedAt: NOW }, step: "read" })).toMatchObject({ allowed: false, reason: /Already signed/ });
  });
});

describe("the training matrix is a computation over requirements and evidence", () => {
  const reqs: MatrixRequirement[] = [
    { requirementRef: "R-H2S", positionCode: "EMPLOYEE_DRIVER", requirementKind: "external_certificate", qualificationCode: "H2S", policyRef: null, renewalMonths: 36, warnDaysBeforeExpiry: 60, enforcement: "block", title: "H2S Alive" },
    { requirementRef: "R-TDG", positionCode: "EMPLOYEE_DRIVER", requirementKind: "external_certificate", qualificationCode: "TDG", policyRef: null, renewalMonths: 36, warnDaysBeforeExpiry: 60, enforcement: "block", title: "TDG" },
    { requirementRef: "R-ACK", positionCode: "EMPLOYEE_DRIVER", requirementKind: "policy_acknowledgement", qualificationCode: null, policyRef: "POL-HS", renewalMonths: null, warnDaysBeforeExpiry: 0, enforcement: "block", title: "H&S policy" },
    { requirementRef: "R-MECH", positionCode: "MECHANIC", requirementKind: "company_training", qualificationCode: "LOTO", policyRef: null, renewalMonths: null, warnDaysBeforeExpiry: 30, enforcement: "review", title: "Lockout" },
  ];
  const driver: MatrixWorker = {
    userId: 1, positionCode: "EMPLOYEE_DRIVER",
    holdings: [
      { kind: "worker_qualification", ref: "WQ-1", code: "H2S", issuedAt: days(-1000), expiresAt: days(30), verified: true },
      { kind: "academy_qualification", ref: "AQ-1", code: "TDG", issuedAt: days(-10), expiresAt: null, verified: false },
    ],
    acknowledgements: [{ policyRef: "POL-HS", acknowledgementRef: "ACK-1", currentVersion: false, signedAt: days(-100) }],
  };

  it("reports expiring, pending verification, and a signature on a superseded version as missing", () => {
    const rows = trainingMatrixFor(reqs, [driver], NOW);
    const by = Object.fromEntries(rows.map(r => [r.requirementRef, r]));
    expect(by["R-H2S"]).toMatchObject({ status: "expiring", evidenceKind: "worker_qualification", evidenceRef: "WQ-1" });
    expect(by["R-TDG"]).toMatchObject({ status: "pending_verification", evidenceKind: "academy_qualification" });
    expect(by["R-ACK"]).toMatchObject({ status: "missing", evidenceKind: "none" });
    expect(rows.some(r => r.requirementRef === "R-MECH")).toBe(false);   // not the driver's position
    expect(matrixSummary(rows)).toEqual({ total: 3, compliant: 0, expiring: 1, expired: 0, missing: 1, pendingVerification: 1 });
  });

  it("derives an expiry from issue date and renewal interval when the record has none, prefers verified evidence, and counts a current-version signature", () => {
    const w: MatrixWorker = {
      ...driver,
      holdings: [
        { kind: "training_record", ref: "TR-1", code: "TDG", issuedAt: days(-40 * 30), expiresAt: null, verified: true },     // 40 months ago, 36-month renewal → expired
        { kind: "worker_qualification", ref: "WQ-9", code: "TDG", issuedAt: days(-5), expiresAt: null, verified: true },
        { kind: "worker_qualification", ref: "WQ-H", code: "H2S", issuedAt: days(-1), expiresAt: days(900), verified: true },
      ],
      acknowledgements: [{ policyRef: "POL-HS", acknowledgementRef: "ACK-2", currentVersion: true, signedAt: days(-1) }],
    };
    const by = Object.fromEntries(trainingMatrixFor(reqs, [w], NOW).map(r => [r.requirementRef, r]));
    expect(by["R-TDG"]).toMatchObject({ status: "compliant", evidenceRef: "WQ-9" });   // the later-expiring verified one wins
    expect(by["R-H2S"]).toMatchObject({ status: "compliant" });
    expect(by["R-ACK"]).toMatchObject({ status: "compliant", evidenceRef: "ACK-2" });
    const only = trainingMatrixFor(reqs, [{ ...w, holdings: [w.holdings[0]!] }], NOW).find(r => r.requirementRef === "R-TDG")!;
    expect(only.status).toBe("expired");
  });
});

describe("corrective actions close a loop with two people", () => {
  it("derives overdue from the due date and the open states only", () => {
    expect(correctiveActionView({ status: "open", dueAt: days(-3), completedByUserId: null, completedAt: null }, NOW)).toEqual({ overdue: true, daysOverdue: 3 });
    expect(correctiveActionView({ status: "in_progress", dueAt: days(1), completedByUserId: null, completedAt: null }, NOW).overdue).toBe(false);
    expect(correctiveActionView({ status: "completed", dueAt: days(-30), completedByUserId: 1, completedAt: days(-1) }, NOW).overdue).toBe(false);
  });
  it("verification needs a completed action and a different person", () => {
    expect(verificationDecision({ status: "completed", completedByUserId: 4 }, 5).allowed).toBe(true);
    expect(verificationDecision({ status: "completed", completedByUserId: 4 }, 4)).toMatchObject({ allowed: false, reason: /completed an action cannot verify/ });
    expect(verificationDecision({ status: "open", completedByUserId: null }, 5).allowed).toBe(false);
  });
});

describe("COR readiness scores operation, not paperwork", () => {
  const base: CorEvidence = {
    now: NOW,
    policies: [
      { moduleKey: "company_foundation", status: "active", acknowledgementRequired: true, nextReviewDueAt: days(200), hasApprovedVersion: true },
      { moduleKey: "ohs", status: "active", acknowledgementRequired: true, nextReviewDueAt: days(200), hasApprovedVersion: true },
      { moduleKey: "emergency_management", status: "active", acknowledgementRequired: true, nextReviewDueAt: days(200), hasApprovedVersion: true },
    ],
    acknowledgement: { required: 30, signed: 30 },
    matrix: { total: 20, compliant: 20, expiring: 0, expired: 0, missing: 0, pendingVerification: 0 },
    inspectionsLast90Days: 4, hazardAssessmentsLast90Days: 40, safetyMeetingsLast90Days: 6,
    incidents: { reported: 2, investigated: 2, openInvestigations: 0 },
    correctiveActions: { open: 1, overdue: 0, completedUnverified: 0 },
    reviews: { overdue: 0, completedLast12Months: 3 }, drillsLast12Months: 1, regulatoryReferences: { cited: 6, verified: 6 },
  };

  it("is ready when every element has operating evidence", () => {
    const r = corReadiness(base);
    expect(r.overall).toBe("ready");
    expect(r.elements.map(e => e.key)).toEqual(["management_commitment", "hazard_assessment", "safe_work_practices", "training", "inspections", "emergency_response", "incident_investigation", "worker_participation", "document_control", "corrective_actions"]);
  });

  it("an approved policy nobody acknowledged is attention, not ready; a plan with no drill is attention; no hazard assessments is a gap", () => {
    const r = corReadiness({ ...base, acknowledgement: { required: 30, signed: 0 }, drillsLast12Months: 0, hazardAssessmentsLast90Days: 0 });
    const by = Object.fromEntries(r.elements.map(e => [e.key, e]));
    expect(by.management_commitment!.status).toBe("attention");
    expect(by.emergency_response!.status).toBe("attention");
    expect(by.hazard_assessment!.status).toBe("gap");
    expect(r.overall).toBe("gap");
  });

  it("names the training and corrective-action counts the way the dashboard line reads them", () => {
    const r = corReadiness({ ...base, matrix: { ...base.matrix, expiring: 3, compliant: 17 }, correctiveActions: { open: 3, overdue: 2, completedUnverified: 1 } });
    const by = Object.fromEntries(r.elements.map(e => [e.key, e]));
    expect(by.training).toMatchObject({ status: "attention", reasons: ["3 expiring"] });
    expect(by.corrective_actions).toMatchObject({ status: "gap", reasons: ["2 overdue", "1 completed, not verified"] });
  });

  it("no evidence at all is no_evidence, and unverified cited references hold document control at attention", () => {
    const r = corReadiness({ ...base, policies: [], acknowledgement: { required: 0, signed: 0 }, matrix: { total: 0, compliant: 0, expiring: 0, expired: 0, missing: 0, pendingVerification: 0 }, regulatoryReferences: { cited: 4, verified: 1 } });
    const by = Object.fromEntries(r.elements.map(e => [e.key, e]));
    expect(by.management_commitment!.status).toBe("no_evidence");
    expect(by.training!.status).toBe("no_evidence");
    expect(by.document_control).toMatchObject({ status: "attention", reasons: expect.arrayContaining(["3 cited regulatory references not yet verified"]) });
  });
});

describe("the vendor package manifest names what is missing", () => {
  it("counts an expired COR as missing and lists every absent section by title", () => {
    const m = vendorPackageManifest({
      companyProfile: true, safetyManual: { activePolicies: 12, assembled: true }, corOrSecor: { present: true, expiresAt: days(-1) }, wcbClearance: { present: true, expiresAt: days(40) },
      insurance: { present: false, expiresAt: null }, safetyFitnessCertificate: { present: true, expiresAt: null }, trainingMatrix: { total: 10, compliant: 9, expiring: 1, expired: 0, missing: 0, pendingVerification: 0 },
      driverQualifications: 6, fleetList: 4, cvips: { units: 4, current: 3 }, incidentStatistics: true, emergencyPlan: true, environmentalProgram: false, references: 2, signedDeclarations: 1, now: NOW,
    });
    expect(m.complete).toBe(false);
    expect(m.missing).toEqual(["COR / SECOR", "Insurance", "CVIP inspections", "Environmental program"]);
    expect(m.sections.find(s => s.key === "cor_secor")!.detail).toMatch(/expired/);
    expect(m.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("the event ledger is a chain", () => {
  const mk = (i: number, prev: string | null): LedgerEvent => {
    const e = { eventRef: `E${i}`, actorUserId: 1, subjectType: "policy", subjectRef: "P", eventType: "t", eventJson: `{"i":${i}}`, previousHash: prev };
    return { ...e, eventHash: eventHash(e) };
  };
  it("verifies an intact chain and names the first broken link", () => {
    const e1 = mk(1, null), e2 = mk(2, e1.eventHash), e3 = mk(3, e2.eventHash);
    expect(verifyEventChain([e1, e2, e3])).toEqual({ intact: true, brokenAt: null, length: 3 });
    expect(verifyEventChain([e1, { ...e2, eventJson: `{"i":99}` }, e3])).toMatchObject({ intact: false, brokenAt: "E2" });
    expect(verifyEventChain([e1, e3])).toMatchObject({ intact: false, brokenAt: "E3" });   // a deleted row breaks the link
  });
});

describe("packs", () => {
  it("has one core pack, jurisdiction packs for AB (OHS and NSC), federal, SK and BC, operations packs, and the two overlays", () => {
    expect(SAFETY_PACKS.filter(p => p.kind === "core").map(p => p.packKey)).toEqual(["core"]);
    expect(SAFETY_PACKS.filter(p => p.kind === "jurisdiction").map(p => p.packKey)).toEqual(["ab_ohs", "ab_nsc", "federal_carrier", "sk_ohs", "bc_ohs"]);
    expect(SAFETY_PACKS.filter(p => p.kind === "overlay").map(p => p.packKey)).toEqual(["client", "company"]);
  });
});

/* ---------------- content packs (category 1: company foundation) ---------------- */
import { contentPackIntegrity, mergeFieldsIn, renderMergeFields, MERGE_FIELDS } from "./safetyProgram";
import { CONTENT_PACKS, contentForTemplate } from "./safetyProgramContentPacks";

describe("the company-foundation content pack is loadable and honest", () => {
  const pack = CONTENT_PACKS.find(p => p.moduleKey === "company_foundation")!;

  it("covers all nineteen foundation templates, every key in the catalog, every body written, only declared merge fields", () => {
    expect(pack.templates.length).toBe(19);
    expect(contentPackIntegrity(pack)).toEqual({ ok: true, problems: [] });
    const foundationKeys = POLICY_TEMPLATE_SEEDS.filter(t => t.moduleKey === "company_foundation").map(t => t.templateKey).sort();
    expect(pack.templates.map(t => t.templateKey).sort()).toEqual(foundationKeys);
  });

  it("keeps the Alberta NSC distinction in the text: the transportation policy says an OHS program alone does not satisfy it", () => {
    const t = contentForTemplate("company_foundation.transportation_safety_policy")!.template;
    expect(t.sections.map(s => s.body).join(" ")).toMatch(/OHS program alone does not satisfy/);
    const m = contentForTemplate("company_foundation.maintenance_policy")!.template;
    expect(m.sections.map(s => s.body).join(" ")).toMatch(/Commercial Vehicle Inspection Program/);
  });

  it("asserts no section number of any Act, Regulation or Code — those live in the verified reference register", () => {
    for (const t of pack.templates) for (const s of t.sections) expect(s.body, `${t.templateKey} / ${s.heading}`).not.toMatch(/\b(s\.|section|Part)\s*\d+/);
  });

  it("names the company and its officers only through merge fields, so a company's draft is its own", () => {
    for (const t of pack.templates) {
      const text = t.sections.map(s => s.body).join("\n");
      expect(mergeFieldsIn(text)).toContain("company.name");
      expect(text).not.toMatch(/ABC Vac|Acme/);
    }
  });

  it("rejects a pack with an unknown key, a wrong module, an empty body or an undeclared field", () => {
    const bad = { moduleKey: "company_foundation", templates: [
      { templateKey: "not.a.key", sections: [{ heading: "a", body: "b" }, { heading: "c", body: "d" }, { heading: "e", body: "f" }] },
      { templateKey: "ohs.ppe_policy", sections: [{ heading: "a", body: "b" }, { heading: "c", body: "" }, { heading: "e", body: "{{company.ceo}}" }] },
    ] };
    const r = contentPackIntegrity(bad);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([
      "not.a.key: not in the template catalog", "ohs.ppe_policy: belongs to ohs, pack is company_foundation",
      'ohs.ppe_policy: empty heading or body in "c"', "ohs.ppe_policy: unknown merge field company.ceo",
    ]));
  });
});

describe("merge fields", () => {
  it("fills what it is given, leaves the rest as written, and names them", () => {
    const r = renderMergeFields([{ heading: "Statement", body: "{{company.name}} is led by {{company.president}}; policy {{ policy.code }} v{{policy.version}}." }], { "company.name": "ABC Vac Ltd.", "policy.code": "HSE-POL-001", "company.president": "" });
    expect(r.sections[0]!.body).toBe("ABC Vac Ltd. is led by {{company.president}}; policy HSE-POL-001 v{{policy.version}}.");
    expect(r.unresolved).toEqual(["company.president", "policy.version"]);
    expect(MERGE_FIELDS).toContain("company.safetyManager");
  });
});

describe("every loaded content pack holds the pack rules", () => {
  it("each pack is loadable, with headings in the order of its template's skeleton", () => {
    for (const p of CONTENT_PACKS) expect(contentPackIntegrity(p), p.packRef).toEqual({ ok: true, problems: [] });
  });

  it("no pack cites a section number, and every template names the company only through the merge field", () => {
    for (const p of CONTENT_PACKS) for (const t of p.templates) {
      const text = t.sections.map(s => s.body).join("\n");
      expect(text, t.templateKey).not.toMatch(/\b(s\.|section|Part)\s*\d+/);
      expect(mergeFieldsIn(text), t.templateKey).toContain("company.name");
    }
  });

  it("refuses a pack whose headings drift from the skeleton", () => {
    const t = contentForTemplate("ohs.housekeeping")!.template;
    const swapped = { moduleKey: "ohs", templates: [{ ...t, sections: [t.sections[1]!, t.sections[0]!, ...t.sections.slice(2)] }] };
    expect(contentPackIntegrity(swapped).problems[0]).toMatch(/do not match the safe_work_practice skeleton/);
  });
});

describe("the OHS content pack", () => {
  const pack = CONTENT_PACKS.find(p => p.moduleKey === "ohs")!;
  const body = (key: string) => contentForTemplate(key)!.template.sections.map(s => s.body).join("\n");

  it("covers all thirty-nine OHS templates", () => {
    expect(pack.templates.map(t => t.templateKey).sort()).toEqual(POLICY_TEMPLATE_SEEDS.filter(t => t.moduleKey === "ohs").map(t => t.templateKey).sort());
    expect(pack.templates.length).toBe(39);
  });

  it("states the committee and representative thresholds the obligations engine uses, so the text and the engine cannot disagree", () => {
    const text = body("ohs.health_and_safety_committee_or_representative");
    expect(text).toMatch(/20 or more workers \(joint committee\)/); expect(text).toMatch(/5 to 19 workers \(representative\)/);
    const at = (n: number) => Object.fromEntries(programObligations({ jurisdictions: ["CA-AB"], workforceSize: n, nscCarrier: false, federalCarrier: false, oilfield: false, hydrovac: false, groundDisturbance: false, dangerousGoods: false, workingAlone: false }).map(o => [o.key, o.applies]));
    expect([at(4).hs_representative, at(5).hs_representative, at(19).hs_representative, at(20).hs_committee, at(19).hs_committee]).toEqual([false, true, true, true, false]);
  });

  it("maps every element of the 20-worker health and safety program to a document in the pack", () => {
    const text = body("ohs.health_and_safety_program_20_or_more_workers");
    for (const element of ["hazard assessment and control", "emergency response plan", "statement of the responsibilities", "inspections", "another employer or a self-employed person", "orientation and training", "investigating incidents, injuries and refusals", "worker participation", "reviewing and revising the program"]) expect(text, element).toContain(element);
  });

  it("carries the controls a reviewer will look for first", () => {
    expect(body("ohs.fall_protection")).toMatch(/3 metres or more/);
    expect(body("ohs.fall_protection")).toMatch(/rescue/);
    expect(body("ohs.hearing_conservation")).toMatch(/85 dBA/);
    expect(body("ohs.working_alone")).toMatch(/effective communication system/);
    expect(body("ohs.working_alone")).toMatch(/missed check-in starts escalation/);
    expect(body("ohs.hazardous_energy_control_lockout_tagout")).toMatch(/each worker removes only their own lock/);
    expect(body("ohs.right_to_refuse_dangerous_work")).toMatch(/told in writing of the refusal/);
    expect(body("ohs.respiratory_protection")).toMatch(/code of practice/);
    expect(body("ohs.corrective_action_system")).toMatch(/never the person who completed it/);
    expect(body("ohs.field_level_hazard_assessment_flha")).toMatch(/whenever the work, the crew, the equipment, the weather or the site conditions change/);
  });

  it("uses the hierarchy of controls in the order the Code sets it, wherever it appears", () => {
    for (const t of pack.templates) {
      const text = t.sections.map(s => s.body).join("\n");
      if (!text.includes("Controls are chosen in this order")) continue;
      const e = text.indexOf("eliminate the hazard"), g = text.indexOf("engineering controls"), a = text.indexOf("administrative controls"), p = text.indexOf("personal protective equipment", a);
      expect(e < g && g < a && a < p, t.templateKey).toBe(true);
    }
  });
});

describe("the NSC trucking content pack", () => {
  const pack = CONTENT_PACKS.find(p => p.moduleKey === "nsc_trucking")!;
  const body = (key: string) => contentForTemplate(key)!.template.sections.map(s => s.body).join("\n");

  it("covers all forty-one trucking templates, and no summary carries an unrendered merge field", () => {
    expect(pack.templates.map(t => t.templateKey).sort()).toEqual(POLICY_TEMPLATE_SEEDS.filter(t => t.moduleKey === "nsc_trucking").map(t => t.templateKey).sort());
    expect(pack.templates.length).toBe(41);
    for (const p of CONTENT_PACKS) for (const t of p.templates) expect(mergeFieldsIn(t.summary), t.templateKey).toEqual([]);
  });

  it("keeps hours-of-service figures in one place: the HOS policies point to the rule profile and state no hours", () => {
    for (const key of ["nsc_trucking.hours_of_service_policy", "nsc_trucking.sleeper_berth_policy", "nsc_trucking.no_coercion_to_violate_hours_of_service", "nsc_trucking.eld_and_logbook_policy", "nsc_trucking.fatigue_management_drivers"]) {
      expect(body(key), key).not.toMatch(/\b\d+(\.\d+)?\s*(hours?|hrs?|h)\b/i);
    }
    for (const key of ["nsc_trucking.hours_of_service_policy", "nsc_trucking.sleeper_berth_policy", "nsc_trucking.no_coercion_to_violate_hours_of_service"]) expect(body(key), key).toMatch(/hours-of-service rule profile/);
  });

  it("carries the NSC criteria a carrier audit checks", () => {
    expect(body("nsc_trucking.load_securement")).toMatch(/aggregate WLL of at least one-half the weight of the cargo/);
    expect(body("nsc_trucking.load_securement")).toMatch(/0\.8 g forward, 0\.5 g rearward and 0\.5 g sideways/);
    expect(body("nsc_trucking.pre_trip_inspection")).toMatch(/valid for 24 hours/);
    expect(body("nsc_trucking.pre_trip_inspection")).toMatch(/A major defect: do not drive/);
    expect(body("nsc_trucking.driver_abstract_review")).toMatch(/at least once every 12 months/);
    expect(body("nsc_trucking.dangerous_goods_transportation_road")).toMatch(/TDG training certificate issued by \{\{company\.name\}\}/);
    expect(body("nsc_trucking.dispatch_responsibility")).toMatch(/readiness check, which blocks or flags/);
    expect(body("nsc_trucking.defect_reporting")).toMatch(/The mechanic who performs the repair records it and releases it/);
  });
});
