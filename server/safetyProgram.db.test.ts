/**
 * 0182 — the Safety & Compliance Program Builder, wired.
 *
 * What these prove against a real database: the library seeds idempotently and
 * unverified; a policy's code is minted by the server; a version cannot be
 * approved by its preparer or edited after approval; an acknowledgement walks
 * read → understood → questions → sign and binds to the version hash, and a
 * new version resets it; the training matrix sees that; a corrective action's
 * verifier is not its completer; a recorded reference is not verified by its
 * recorder; another organization sees nothing; the ledger chain verifies.
 *
 * Every organization, person and policy here is a fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 190_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function personIn(orgRef: string, role: string, workerType = "EMPLOYEE_DRIVER") {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  await pool.execute("INSERT INTO organizationWorkers (workerRef, orgRef, userId, workerType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,?,'active','2020-01-01',1)", [`WRK-${rnd()}`, orgRef, userId, workerType]);
  return userId;
}
const code = async (fn: () => Promise<unknown>) => { try { await fn(); return "ok"; } catch (e) { return (e as { code?: string }).code ?? "error"; } };
const message = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return (e as { message?: string }).message ?? ""; } };

d("0182 — Safety & Compliance Program Builder", () => {
  it("runs the program from library to ledger for one organization, and keeps another organization out", async () => {
    const orgRef = await org();
    const safety = await personIn(orgRef, "safety", "SAFETY_COMPLIANCE");
    const manager = await personIn(orgRef, "management", "OFFICE_ADMIN");
    const driver = await personIn(orgRef, "driver");
    const auditor = await personIn(orgRef, "auditor", "OFFICE_ADMIN");
    const outsider = await personIn(await org(), "management", "OFFICE_ADMIN");
    const S = callerFor(safety), M = callerFor(manager), D = callerFor(driver), A = callerFor(auditor), X = callerFor(outsider);

    // --- library: seeded from code, idempotent, unverified
    const first = await S.safetyProgram.syncCatalog();
    expect(first.modulesUpserted).toBe(14);
    expect(first.templateCount).toBeGreaterThan(250);
    const second = await S.safetyProgram.syncCatalog();
    expect(second.templatesInserted).toBe(0); expect(second.referencesInserted).toBe(0);
    const catalog = await A.safetyProgram.catalog();
    expect(catalog.seeded).toBe(true);
    expect(catalog.templates.length).toBe(first.templateCount);
    expect(catalog.references.every(r => r.verificationStatus !== "verified" || r.referenceKey.length > 0)).toBe(true);
    const tpl = await A.safetyProgram.templateDetail({ templateKey: "company_foundation.health_and_safety_policy" });
    expect(tpl.contentStatus).toBe("skeleton"); expect(tpl.regulatoryBasis).toBe("not_inferred_from_template");
    expect(tpl.references.map(r => r.referenceKey)).toContain("ab.ohs_act.health_safety_program");

    // --- the driver may not manage the library or write policy; the auditor may read and not write
    expect(await code(() => D.safetyProgram.syncCatalog())).toBe("FORBIDDEN");
    expect(await code(() => D.safetyProgram.policyCreate({ templateKey: "company_foundation.health_and_safety_policy" }))).toBe("FORBIDDEN");
    expect(await code(() => A.safetyProgram.policyCreate({ templateKey: "company_foundation.health_and_safety_policy" }))).toBe("FORBIDDEN");

    // --- program: obligations and assembly
    const profile = { jurisdictions: ["CA-AB"], workforceSize: 24, nscCarrier: true, federalCarrier: false, oilfield: true, hydrovac: true, groundDisturbance: false, dangerousGoods: true, workingAlone: true };
    const ob = await S.safetyProgram.obligations({ profile });
    expect(ob.obligations.find(o => o.key === "nsc_programs")!.applies).toBe(true);
    expect(ob.recommendedPacks.map(p => p.packKey)).toEqual(expect.arrayContaining(["core", "ab_ohs", "ab_nsc", "oilfield", "hydrovac", "ground_disturbance"]));
    expect(await code(() => S.safetyProgram.assemble())).toBe("BAD_REQUEST");   // nothing set up yet
    const prog = await S.safetyProgram.programSet({ name: "ABC Vac Ltd. safety management system", profile, packKeys: ["ab_ohs", "ab_nsc", "oilfield", "hydrovac", "ground_disturbance"], activate: true });
    expect(prog.packKeys[0]).toBe("core");
    expect(prog.templateCount).toBeGreaterThan(100);
    const asm = await A.safetyProgram.assemble();
    expect(asm.coverage).toEqual({ templates: prog.templateCount, policiesCreated: 0, policiesApproved: 0 });
    expect(asm.outline.some(m => m.moduleKey === "ground_disturbance")).toBe(true);
    expect((await X.safetyProgram.programGet()).program).toBeNull();

    // --- policy: code minted by the server, sequence per prefix and kind
    const p1 = await S.safetyProgram.policyCreate({ templateKey: "company_foundation.health_and_safety_policy" });
    expect(p1.policyCode).toBe("HSE-POL-001");
    expect(p1.sections.map(s => s.heading)).toContain("Policy statement");
    const p2 = await S.safetyProgram.policyCreate({ templateKey: "company_foundation.stop_work_authority" });
    expect(p2.policyCode).toBe("HSE-POL-002");
    const p3 = await S.safetyProgram.policyCreate({ templateKey: "ohs.field_level_hazard_assessment_flha" });
    expect(p3.policyCode).toBe("OHS-FRM-001");
    expect(await code(() => X.safetyProgram.policyDetail({ policyRef: p1.policyRef }))).toBe("NOT_FOUND");   // another organization: not found, never forbidden
    expect((await A.safetyProgram.assemble()).coverage.policiesCreated).toBe(3);

    // --- version: prepared by safety, approvable only by someone else, immutable after
    const sections = p1.sections.map(s => ({ heading: s.heading, body: s.heading === "Policy statement" ? "ABC Vac Ltd. is committed to the health and safety of every worker." : "" }));
    const v1 = await S.safetyProgram.versionDraft({ policyRef: p1.policyRef, sections, bodyMarkdown: "" });
    expect(v1.versionLabel).toBe("1.0");
    expect(await code(() => S.safetyProgram.versionDraft({ policyRef: p1.policyRef, sections, bodyMarkdown: "" }))).toBe("BAD_REQUEST");   // one open draft at a time
    expect(await message(() => S.safetyProgram.versionApprove({ versionRef: v1.versionRef }))).toMatch(/prepared a version cannot approve/);
    expect(await code(() => D.safetyProgram.versionApprove({ versionRef: v1.versionRef }))).toBe("FORBIDDEN");
    const approved = await M.safetyProgram.versionApprove({ versionRef: v1.versionRef, approvalNote: "Reviewed against the Alberta OHS Act" });
    expect(approved.supersededVersionId).toBeNull();
    expect(approved.nextReviewDueAt.getTime()).toBeGreaterThan(Date.now());
    expect(await message(() => S.safetyProgram.versionEdit({ versionRef: v1.versionRef, sections, bodyMarkdown: "changed" }))).toMatch(/immutable/);
    const detail = await A.safetyProgram.policyDetail({ policyRef: p1.policyRef });
    expect(detail.policy.status).toBe("active"); expect(detail.versions[0]!.state).toBe("approved");
    expect(detail.versions[0]!.approvedByUserId).toBe(manager); expect(detail.versions[0]!.preparedByUserId).toBe(safety);
    expect((await A.safetyProgram.assemble()).coverage.policiesApproved).toBe(1);

    // --- acknowledgement: self-scoped, stepwise, bound to the version hash
    const mine = await D.safetyProgram.myPolicies();
    expect(mine.map(m => m.policyCode)).toEqual(["HSE-POL-001"]);   // POL-002 has no approved version; the FLHA form needs no acknowledgement
    expect(mine[0]!.nextStep).toBe("read");
    expect(await message(() => D.safetyProgram.acknowledge({ policyRef: p1.policyRef, step: "sign" }))).toMatch(/Read, understood and questions/);
    await D.safetyProgram.acknowledge({ policyRef: p1.policyRef, step: "read" });
    expect(await code(() => D.safetyProgram.acknowledge({ policyRef: p1.policyRef, step: "questions" }))).toBe("FORBIDDEN");
    await D.safetyProgram.acknowledge({ policyRef: p1.policyRef, step: "understood" });
    await D.safetyProgram.acknowledge({ policyRef: p1.policyRef, step: "questions", questionsNote: "Asked about contractor coverage; answered by the safety manager" });
    const signed = await D.safetyProgram.acknowledge({ policyRef: p1.policyRef, step: "sign" });
    expect(signed.signatureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(signed.versionHash).toBe(detail.versions[0]!.versionHash);
    expect((await D.safetyProgram.myPolicies())[0]!.nextStep).toBe("done");
    const status = await S.safetyProgram.acknowledgementStatus({ policyRef: p1.policyRef });
    expect(status.workforce).toBe(4);
    expect(status.signed.map(s => s.userId)).toEqual([driver]);
    expect(status.outstanding.map(o => o.userId).sort()).toEqual([safety, manager, auditor].sort());
    expect(await code(() => S.safetyProgram.acknowledge({ policyRef: p2.policyRef, step: "read" }))).toBe("FORBIDDEN");   // no approved version

    // --- training matrix: the signature counts until the policy moves on
    const req = await S.safetyProgram.trainingRequirementUpsert({ positionCode: "EMPLOYEE_DRIVER", requirementKind: "policy_acknowledgement", policyRef: p1.policyRef, title: "Acknowledge the H&S policy" });
    await S.safetyProgram.trainingRequirementUpsert({ positionCode: "EMPLOYEE_DRIVER", requirementKind: "external_certificate", qualificationCode: "H2S", title: "H2S Alive", renewalMonths: 36 });
    expect(await code(() => S.safetyProgram.trainingRequirementUpsert({ positionCode: "EMPLOYEE_DRIVER", requirementKind: "external_certificate", title: "no code" }))).toBe("BAD_REQUEST");
    const run1 = await S.safetyProgram.trainingMatrixCompute();
    expect(run1.workers).toBe(4);
    expect(run1.summary).toMatchObject({ total: 2, compliant: 1, missing: 1 });   // only the driver holds EMPLOYEE_DRIVER; H2S is missing
    const m1 = await A.safetyProgram.trainingMatrix({ userId: driver });
    expect(m1.rows.find(r => r.requirementRef === req.requirementRef)).toMatchObject({ status: "compliant", evidenceKind: "policy_acknowledgement" });

    const v2 = await S.safetyProgram.versionDraft({ policyRef: p1.policyRef, sections, bodyMarkdown: "Revision: adds subcontractors.", changeSummary: "Extends scope to subcontractors" });
    await M.safetyProgram.versionApprove({ versionRef: v2.versionRef });
    const after = await A.safetyProgram.policyDetail({ policyRef: p1.policyRef });
    expect(after.versions.map(v => v.state)).toEqual(["superseded", "approved"]);
    expect(after.versions[1]!.previousVersionHash).toBe(after.versions[0]!.versionHash);
    expect((await D.safetyProgram.myPolicies())[0]!.nextStep).toBe("read");   // the new version needs its own signature
    const run2 = await S.safetyProgram.trainingMatrixCompute();
    expect(run2.summary.missing).toBe(2);
    expect((await A.safetyProgram.trainingMatrix()).computationRef).toBe(run2.computationRef);   // the earlier run is history, not current

    // --- reviews, overlays, corrective actions
    const rv = await S.safetyProgram.reviewSchedule({ policyRef: p1.policyRef, reviewType: "post_incident" });
    const done = await M.safetyProgram.reviewComplete({ reviewRef: rv.reviewRef, outcome: "revision_required", findings: "Add a section on client site rules" });
    expect(done.correctiveActionRef).toMatch(/^CA-/);
    await S.safetyProgram.overlaySet({ clientName: "Suncor", policyRef: p1.policyRef, title: "Suncor site rules overlay", requirements: [{ requirement: "Site-specific orientation before first entry" }] });
    expect((await A.safetyProgram.overlayList({ clientName: "Suncor" })).length).toBe(1);
    const ca = await S.safetyProgram.correctiveActionOpen({ sourceType: "cor_gap", title: "Record a drill", description: "No emergency drill in 12 months", assignedToUserId: safety, dueAt: new Date(Date.now() - 86_400_000) });
    const list = await A.safetyProgram.correctiveActionList({ overdueOnly: true });
    expect(list.map(a => a.actionRef)).toContain(ca.actionRef);
    expect(await code(() => S.safetyProgram.correctiveActionVerify({ actionRef: ca.actionRef, verificationNote: "not yet done" }))).toBe("FORBIDDEN");   // not completed
    expect(await code(() => S.safetyProgram.correctiveActionProgress({ actionRef: ca.actionRef, transition: "complete" }))).toBe("BAD_REQUEST");   // no note
    await S.safetyProgram.correctiveActionProgress({ actionRef: ca.actionRef, transition: "complete", note: "Drill held 2026-09-20 with muster count" });
    expect(await message(() => S.safetyProgram.correctiveActionVerify({ actionRef: ca.actionRef, verificationNote: "looks fine" }))).toMatch(/completed an action cannot verify/);
    await M.safetyProgram.correctiveActionVerify({ actionRef: ca.actionRef, verificationNote: "Muster sheet on file" });

    // --- references: recorder never verifies
    const rk = `ab.test_${rnd().toLowerCase()}`;
    await S.safetyProgram.referenceUpsert({ referenceKey: rk, jurisdiction: "CA-AB", authority: "Alberta", instrument: "Test instrument", title: "Test reference" });
    expect(await message(() => S.safetyProgram.referenceVerify({ referenceKey: rk, verificationNote: "checked" }))).toMatch(/recorded a reference cannot verify/);
    expect((await M.safetyProgram.referenceVerify({ referenceKey: rk, verificationNote: "Checked against the consolidated instrument" })).verificationStatus).toBe("verified");
    await S.safetyProgram.referenceUpsert({ referenceKey: rk, jurisdiction: "CA-AB", authority: "Alberta", instrument: "Test instrument (amended)", title: "Test reference" });
    expect((await A.safetyProgram.referenceList({ jurisdiction: "CA-AB" })).find(r => r.referenceKey === rk)!.verificationStatus).toBe("unverified");   // an edited citation is unverified again

    // --- readiness and package
    const cor = await A.safetyProgram.corReadiness();
    expect(cor.elements.map(e => e.key)).toContain("document_control");
    expect(cor.elements.find(e => e.key === "document_control")!.reasons.join(" ")).toMatch(/not yet verified/);
    expect(cor.elements.find(e => e.key === "training")!.status).toBe("gap");
    const pkg = await A.safetyProgram.vendorPackageManifest();
    expect(pkg.complete).toBe(false);
    expect(pkg.missing).toContain("COR / SECOR");
    expect(pkg.sections.find(s => s.key === "safety_manual")!.present).toBe(true);

    // --- the ledger
    const ev = await A.safetyProgram.events({ subjectType: "policy", subjectRef: p1.policyRef, verifyChain: true });
    expect(ev.events.map(e => e.eventType)).toContain("policy.created");
    expect(ev.chain).toMatchObject({ intact: true, brokenAt: null });
    expect((await X.safetyProgram.events({ subjectType: "policy", subjectRef: p1.policyRef })).events).toEqual([]);
  }, 120_000);
});
