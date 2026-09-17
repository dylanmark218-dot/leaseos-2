import { beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { composeSiteSnapshot, postSiteSupplement, type TicketEvent } from "./_core/siteCloseout";
import { COMPLETENESS, REDACTION_POLICIES, assemble } from "./_core/auditPackage";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import type { PostSiteAuthorization } from "./_core/siteCloseout";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

const at = (hhmm: string, day = "2026-09-10") => new Date(`${day}T${hhmm}:00Z`);
const base = { id: 0, source: null, confidence: null, detail: null } as const;

describe("a minimum raises what is billed, never what was worked, and names the raise", () => {
  it("applies below the minimum, not above it, and not to a ticket with nothing billable", () => {
    const ev: TicketEvent[] = [{ ...base, id: 1, eventType: "site_work", occurredAt: at("07:00"), endedAt: at("09:30"), customerBillable: "yes" }];
    const raised = composeSiteSnapshot({ ticket: { ticketNumber: "FT-1", jobId: null, customer: "ABC", site: null, unitId: null, operatorId: null }, lines: [], events: ev, siteWorkCompleteAt: at("09:30"), minimum: { hours: 4, ruleRef: "TERMS-ABC-1 v1 §3.1" } });
    expect(raised.snapshot.siteBillableHours).toBe(4);
    expect(raised.snapshot.minimumApplied).toEqual({ minimumHours: 4, billableHoursBefore: 2.5, ruleRef: "TERMS-ABC-1 v1 §3.1" });
    expect(raised.findings).toContain("Minimum 4 h per TERMS-ABC-1 v1 §3.1: 2.5 h billable raised to 4 h");
    expect(raised.snapshot.events[0].hours).toBe(2.5);                                        // worked time untouched
    const above = composeSiteSnapshot({ ticket: { ticketNumber: "FT-1", jobId: null, customer: "ABC", site: null, unitId: null, operatorId: null }, lines: [], events: [{ ...ev[0], endedAt: at("14:00") }], siteWorkCompleteAt: at("14:00"), minimum: { hours: 4, ruleRef: "x" } });
    expect(above.snapshot).toMatchObject({ siteBillableHours: 7, minimumApplied: null });
    const nothing = composeSiteSnapshot({ ticket: { ticketNumber: "FT-1", jobId: null, customer: "ABC", site: null, unitId: null, operatorId: null }, lines: [], events: [], siteWorkCompleteAt: null, minimum: { hours: 4, ruleRef: "x" } });
    expect(nothing.snapshot).toMatchObject({ siteBillableHours: 0, minimumApplied: null });
  });
  it("lets the contract decide return travel where the signatory wrote per contract, and reviews it where no contract answers", () => {
    const auth: PostSiteAuthorization = { disposalRequired: true, travelToDisposal: true, disposalWait: true, disposalUnload: true, returnTravel: "per_contract", capRule: "none", restockingBillable: false, postTripBillable: false };
    const events: TicketEvent[] = [{ ...base, id: 2, eventType: "return_travel", occurredAt: at("18:00"), endedAt: at("19:00"), customerBillable: "review" }];
    const yes = postSiteSupplement({ authorization: auth, events, siteWorkCompleteAt: at("17:00"), disposalTicket: null, gpsFacilityArrivalAt: null, contractReturnTravel: "yes" });
    expect(yes.included.some(i => i.eventType === "return_travel" && i.basis.includes("per contract"))).toBe(true);
    const none = postSiteSupplement({ authorization: auth, events, siteWorkCompleteAt: at("17:00"), disposalTicket: null, gpsFacilityArrivalAt: null, contractReturnTravel: null });
    expect(none.excluded.find(e => e.eventType === "return_travel")?.reason).toContain("REVIEW");
  });
});

describe("the two new package kinds have policies and completeness like the rest", () => {
  it("withholds premiums and identities from an insurance package and names a COR package's gaps", () => {
    expect(Object.keys(REDACTION_POLICIES).sort()).toEqual(Object.keys(COMPLETENESS).sort());
    const ins = assemble("insurance", [{ itemKind: "policy", sourceTable: "insurancePolicies", sourceId: 1, sourceRef: "POL-1", title: "Auto", row: { policyNumber: "POL-1", annualPremium: 42_000, coverageVerifiedByUserId: 9, status: "active" } }]);
    expect(ins.manifest.items[0].redactions).toEqual(["annualPremium: withheld — premium, identities and medical detail withheld", "coverageVerifiedByUserId: withheld — premium, identities and medical detail withheld"]);
    expect(ins.manifest.missing.map(m => m.itemKind)).toEqual(["claim", "incident"]);
    const cor = assemble("cor", [{ itemKind: "tailgate", sourceTable: "tailgateMeetings", sourceId: 1, sourceRef: "TG-1", title: "Tailgate", row: { trackingNumber: "TG-1", voiceTranscript: "…", reviewStatus: "approved" } }]);
    expect(cor.manifest.items[0].redactions[0]).toContain("voiceTranscript: withheld");
    expect(cor.manifest.missing.map(m => m.itemKind)).toEqual(["written_program", "program_acknowledgement", "inspection", "training", "incident"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 4_000_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("terms complete the closeout", () => {
  it("raises a short day to the minimum with the clause named and lets the contract answer return travel on the supplement", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const entityId = 4_100_000 + Math.floor(Math.random() * 90_000);
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const jobId = Number(job.insertId);
    const terms = await callerFor(office).closeout.termsRecord({ customerAccountRef: acctRef, title: "MSA 2026", standbyBillable: "yes", standbyFreeMinutes: 0, customerHoldBillable: "yes", weatherHoldBillable: "no", travelToDisposalBillable: "yes", disposalQueueBillable: "yes", disposalBillable: "yes", returnTravelBillable: "yes", minimumHours: 4, clauses: { minimum: "§3.1", return_travel: "§6.1" }, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceDocumentEvidenceId: 1 });
    await callerFor(controller).closeout.termsApprove({ termsRef: terms.termsRef });
    const c = callerFor(driver).closeout;
    const [fixtureUnit] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await c.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: fixtureUnit.insertId, operatorId: 7, serviceDescription: "Short call-out", postSiteRequired: true });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:00"), endedAt: at("09:30"), source: "pto", confidence: "high" });
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("09:30") });
    expect(prep.snapshot).toMatchObject({ siteBillableHours: 4, minimumApplied: { minimumHours: 4, billableHoursBefore: 2.5, ruleRef: `${terms.termsRef} v1 §3.1` } });
    expect(prep.findings).toContain(`Minimum 4 h per ${terms.termsRef} v1 §3.1: 2.5 h billable raised to 4 h`);
    expect(prep.snapshot.events.find(e => e.eventType === "site_work")?.hours).toBe(2.5);
    // Signed with return travel "per contract"; the return travel event is decided by the terms at record time and included on the supplement per contract.
    await c.siteSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signer: { name: "M. Johnson", company: "ABC Energy" }, method: "drawn", authorities: ["work_confirmation", "time_confirmation"], postSiteAuthorization: { disposalRequired: true, travelToDisposal: true, disposalWait: true, disposalUnload: true, returnTravel: "per_contract", capRule: "none", restockingBillable: false, postTripBillable: false } });
    const rt = await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "return_travel", occurredAt: at("11:00"), endedAt: at("12:00"), source: "gps", confidence: "high" });
    expect(rt).toMatchObject({ customerBillable: "yes", billingRuleRef: `${terms.termsRef} v1 §6.1` });
    const sup = await callerFor(office).closeout.supplementPrepare({ ticketNumber: t.ticketNumber });
    expect(sup.included.some(i => i.eventType === "return_travel" && /per contract/i.test(i.basis))).toBe(true);
  });

  it("builds a COR package with a no-incidents statement and an insurance package over policies and claims, both naming their gaps", async () => {
    const safety = await withRole("safety");
    const entityId = 4_200_000 + Math.floor(Math.random() * 90_000);
    await pool.execute("INSERT INTO writtenProgramVersions (programKey, version, title, programType, financialEntityId, effectiveFrom, approvedByUserId, approvedAt, contentHash, createdAt) VALUES (?, 1, 'Hazard assessment program', 'safety', ?, '2026-01-01', 1, '2026-01-01', ?, NOW())", [key("HAZ").slice(0, 40), entityId, "b".repeat(64)]);
    const from = new Date("2026-08-01T00:00:00Z"), to = new Date("2026-08-31T23:59:59Z");
    const cor = await callerFor(safety).audit.packagePrepare({ kind: "cor", subjectRef: String(entityId), periodFrom: from, periodTo: to, recipient: "COR auditor — Energy Safety Canada", purpose: "Annual COR maintenance audit" });
    const corGet = await callerFor(safety).audit.packageGet({ packageRef: cor.packageRef });
    const kinds = corGet.items.map(i => i.itemKind);
    expect(kinds).toContain("incident");                                                       // the no-incidents statement is an item, not a blank
    expect(corGet.items.find(i => i.itemKind === "incident")!.title).toContain("No incidents recorded 2026-08-01 to 2026-08-31");
    expect(corGet.items.find(i => i.itemKind === "written_program")).toMatchObject({ contentHash: "b".repeat(64) });   // the program's own hash carried
    expect(corGet.items.find(i => i.itemKind === "written_program")!.redactions).toContain("approvedByUserId: withheld — worker identities appear by employee number where the audit requires; voice transcripts and medical detail withheld");
    // tailgates, inspections and training are company-wide records (a COR audit is company-wide), so other fixtures may satisfy them; the acknowledgement of this entity's program is what this fixture controls.
    expect(corGet.missing.map(m => m.itemKind)).toContain("program_acknowledgement");
    expect(corGet.missing.map(m => m.itemKind)).not.toContain("written_program");
    expect(corGet.missing.map(m => m.itemKind)).not.toContain("incident");
    const [prov] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insuranceProviders (providerRef, name, role, status, createdAt) VALUES (?, ?, 'insurer', 'active', NOW())", [key("PRV").slice(0, 40), key("Insurer").slice(0, 60)]);
    await pool.execute("INSERT INTO insurancePolicies (policyRef, financialEntityId, policyType, insurerId, policyNumber, effectiveAt, expiresAt, status, annualPremium, coverageVerificationStatus, createdAt) VALUES (?, ?, 'commercial_auto', ?, 'CA-2026-771', '2026-01-01', '2026-12-31', 'active', 42000, 'coverage_verified', NOW())", [key("POL").slice(0, 40), entityId, Number(prov.insertId)]);
    const ins = await callerFor(safety).audit.packagePrepare({ kind: "insurance", subjectRef: String(entityId), periodFrom: from, periodTo: to, recipient: "Broker — renewal", purpose: "Renewal submission" });
    const insGet = await callerFor(safety).audit.packageGet({ packageRef: ins.packageRef });
    const pol = insGet.items.find(i => i.itemKind === "policy")!;
    expect(pol.title).toContain("CA-2026-771");
    expect(pol.redactions.some(r => r.startsWith("annualPremium: withheld"))).toBe(true);
    // The premium must not appear in any item title (the manifest carries hashes, not rows). Checked on titles, not the
    // whole JSON: a random entity id such as 4200035 once matched the substring "42000" and failed this for the wrong reason.
    expect(insGet.items.every(i => !i.title.includes("42000"))).toBe(true);
    expect(insGet.missing.map(m => m.itemKind)).toEqual(["claim", "incident"]);
  });
});
