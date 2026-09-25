import { beforeAll, describe, expect, it, vi } from "vitest";

// F1.1 — this suite exercises a deployment that is one ownership domain (no organization yet), where the
// ownerless tire registry rows are provably the single tenant's. The predicate itself, and the refusal once organizations
// exist, are proved against the real database in tenantScopeFinance.db.test.ts.
vi.mock("./ownershipDomain", async importOriginal => ({ ...(await importOriginal<typeof import("./ownershipDomain")>()), singleOwnershipDomain: async () => true, requireProvableOwnership: async () => undefined }));
import mysql from "mysql2/promise";
import { COMPLETENESS, REDACTION_POLICIES, assemble, canonicalJson, redact, releaseDecision, sha256 } from "./_core/auditPackage";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";
import type { PostSiteAuthorization } from "./_core/siteCloseout";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

describe("a package asserts nothing new: redactions are listed, gaps are named, the manifest is its hash", () => {
  it("removes policy fields and lists each removal; withholds whole items by kind and says why", () => {
    const r = redact("customer", { itemKind: "ticket_event", sourceTable: "fieldTicketEvents", sourceId: 1, sourceRef: null, title: "x", row: { eventType: "site_work", clock: "site", byUserId: 7, occurredAt: "2026-09-10T07:31:00Z" } });
    expect(r.row).toEqual({ eventType: "site_work", occurredAt: "2026-09-10T07:31:00Z" });
    expect(r.redactions).toEqual(["clock: withheld — contractor-private activity, identities and clocks withheld", "byUserId: withheld — contractor-private activity, identities and clocks withheld"]);
    const w = redact("customer", { itemKind: "company_activity", sourceTable: "fieldTicketEvents", sourceId: 2, sourceRef: null, title: "restock", row: { eventType: "restock" } });
    expect(w.withheld).toBe(true);
    expect(w.redactions[0]).toContain("item withheld (company_activity)");
    expect(redact("driver", { itemKind: "medical_medical_fitness", sourceTable: "complianceDocuments", sourceId: 3, sourceRef: null, title: "m", row: { docType: "medical_fitness" } }).withheld).toBe(true);
    expect(Object.keys(REDACTION_POLICIES).sort()).toEqual(Object.keys(COMPLETENESS).sort());
  });
  it("assembles a manifest whose hash changes when any item changes, and names what is missing", () => {
    const items = [
      { itemKind: "field_ticket", sourceTable: "fieldTickets", sourceId: 1, sourceRef: "FT-1", title: "Ticket", row: { ticketNumber: "FT-1", status: "billing_ready" } },
      { itemKind: "ticket_revision", sourceTable: "fieldTicketRevisions", sourceId: 1, sourceRef: "FT-1-R1", title: "R1", row: { revision: 1 }, storedHash: "a".repeat(64) },
      { itemKind: "company_activity", sourceTable: "fieldTicketEvents", sourceId: 9, sourceRef: null, title: "restock", row: { eventType: "restock" } },
    ];
    const a = assemble("customer", items);
    expect(a.manifest.items.map(i => i.itemKind)).toEqual(["field_ticket", "ticket_revision"]);
    expect(a.manifest.items[1].contentHash).toBe("a".repeat(64));            // a stored document's own hash is carried, not recomputed
    expect(a.manifest.withheld).toHaveLength(1);
    expect(a.manifest.missing).toEqual([{ itemKind: "ticket_document", label: "Rendered ticket document" }]);
    expect(a.manifestHash).toBe(sha256(a.manifestJson));
    const b = assemble("customer", [{ ...items[0], row: { ticketNumber: "FT-1", status: "open" } }, items[1], items[2]]);
    expect(b.manifestHash).not.toBe(a.manifestHash);
    expect(canonicalJson({ b: 1, a: [new Date("2026-01-01T00:00:00Z")] })).toBe('{"a":["2026-01-01T00:00:00.000Z"],"b":1}');
  });
  it("releases only a prepared package, by a second person, with every gap named when acknowledged", () => {
    const missing = [{ label: "Disposal ticket for every load" }];
    expect(releaseDecision({ status: "prepared", preparedByUserId: 1, releaserUserId: 1, missing, acknowledgeGaps: false, note: "to the regulator" }).refusals).toEqual(["The preparer may not release their own package", "Package is incomplete — Disposal ticket for every load — release only with the gaps acknowledged"]);
    expect(releaseDecision({ status: "prepared", preparedByUserId: 1, releaserUserId: 2, missing, acknowledgeGaps: true, note: "Sent to ABC AP for the September invoice" }).refusals).toEqual(["Acknowledging gaps means naming each in the release note"]);
    expect(releaseDecision({ status: "prepared", preparedByUserId: 1, releaserUserId: 2, missing, acknowledgeGaps: true, note: "Sent to ABC AP; disposal ticket for load 2 still outstanding, to follow" }).permitted).toBe(true);
    expect(releaseDecision({ status: "released", preparedByUserId: 1, releaserUserId: 2, missing: [], acknowledgeGaps: false, note: "again please" }).refusals[0]).toContain("only a prepared package");
  });
});

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
describe("who prepares and who releases", () => {
  it("lets safety, office, controller and legal prepare; only controller, management and legal release", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "audit.package.prepare" }).allowed).sort()).toEqual(["controller", "legal", "office", "safety"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "audit.package.release" }).allowed).sort()).toEqual(["controller", "legal", "management"]);
    expect(authorize({ userId: 1, roles: ["auditor"], permission: "audit.package.read" }).allowed).toBe(true);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 3_500_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
const at = (hhmm: string, day = "2026-09-10") => new Date(`${day}T${hhmm}:00Z`);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const AUTH: PostSiteAuthorization = { disposalRequired: true, travelToDisposal: true, disposalWait: true, disposalUnload: true, returnTravel: "per_contract", capRule: "none", restockingBillable: false, postTripBillable: false };

d("packages over the chain", () => {
  it("builds a job package and a customer package of the same ticket that differ exactly by what the customer may not see, names the missing disposal ticket, is released by a second person with the gap acknowledged, superseded by a re-preparation, and downloaded under a logged purpose", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const entityId = 3_600_000 + Math.floor(Math.random() * 90_000);
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const jobId = Number(job.insertId);
    const c = callerFor(driver).closeout;
    const [fixtureUnit925] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await c.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: fixtureUnit925.insertId, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: true });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("17:06"), source: "pto", confidence: "high" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "restock", occurredAt: at("20:31"), endedAt: at("20:52") });
    await pool.execute("INSERT INTO loads (loadNumber, jobId, unitId, material, quantity, quantityUnit, measurementMethod, chainState, createdAt) VALUES (?, ?, 142, 'slurry', 11.8, 'm3', 'customer_stated', 'in_transit', ?)", [key("LD").slice(0, 40), jobId, at("16:40")]);
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("17:06") });
    await c.siteSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signer: { name: "M. Johnson", company: "ABC Energy" }, method: "drawn", authorities: ["work_confirmation", "time_confirmation"], postSiteAuthorization: AUTH });

    // Job package: everything, including the restock, with the internal ids redacted and listed; the missing disposal ticket is a gap.
    const jobPkg = await callerFor(office).audit.packagePrepare({ kind: "job", subjectRef: t.ticketNumber, recipient: "Insurer — file 7712", purpose: "Claim support" });
    expect(jobPkg.missing).toEqual([{ itemKind: "disposal_ticket", label: "Disposal ticket for every load" }]);
    const jobGet = await callerFor(office).audit.packageGet({ packageRef: jobPkg.packageRef });
    expect(jobGet.items.map(i => i.itemKind)).toEqual(["field_ticket", "ticket_event", "company_activity", "ticket_revision", "signature", "load", "gap_note"]);
    expect(jobGet.items.find(i => i.itemKind === "ticket_revision")!.contentHash).toBe(prep.snapshotHash); // the revision's own hash
    // Customer package of the same ticket: the restock is withheld and the clocks are redacted — and the manifest hash differs.
    const custPkg = await callerFor(office).audit.packagePrepare({ kind: "customer", subjectRef: t.ticketNumber, recipient: "ABC Energy AP", purpose: "Invoice support" });
    expect(custPkg.withheld).toEqual([{ itemKind: "company_activity", sourceRef: null, reason: "item withheld (company_activity): contractor-private activity, identities and clocks withheld" }]);
    const custGet = await callerFor(office).audit.packageGet({ packageRef: custPkg.packageRef });
    expect(custGet.items.map(i => i.itemKind)).not.toContain("company_activity");
    expect(custGet.items.find(i => i.itemKind === "ticket_event")!.redactions.some(r => r.startsWith("clock:"))).toBe(true);
    expect(custGet.manifestHash).not.toBe(jobGet.manifestHash);
    expect(custGet.missing.map(m => m.itemKind)).toEqual(["ticket_document"]);
    const [cover] = await pool.execute<mysql.RowDataPacket[]>("SELECT coverStorageKey, coverHash FROM auditPackages WHERE packageRef = ?", [custPkg.packageRef]);
    expect(objects.get(cover[0].coverStorageKey)!.toString("latin1")).toContain("WITHHELD");

    // Release: the preparer cannot; a second person cannot without acknowledging the gap; naming it in the note releases; a download of a prepared package is refused before, logged after.
    await expect(callerFor(office).audit.packageRelease({ packageRef: custPkg.packageRef, note: "Sending to ABC AP for invoice support" })).rejects.toBeTruthy();
    await expect(callerFor(controller).audit.packageRelease({ packageRef: custPkg.packageRef, note: "Sending to ABC AP for invoice support" })).rejects.toThrow(/release only with the gaps acknowledged/);
    await expect(callerFor(controller).audit.packageDownload({ packageRef: custPkg.packageRef, purpose: "checking" })).rejects.toThrow(/only a released package/);
    const rel = await callerFor(controller).audit.packageRelease({ packageRef: custPkg.packageRef, note: "Sending to ABC AP for invoice support; rendered ticket document to follow once R1 is rendered", acknowledgeGaps: true });
    expect(rel).toMatchObject({ status: "released", gapsAcknowledged: true, manifestHash: custGet.manifestHash });
    const dl = await callerFor(controller).audit.packageDownload({ packageRef: custPkg.packageRef, purpose: "Attach to the September invoice email" });
    expect(sha256(dl.manifestJson)).toBe(dl.manifestHash);
    expect(dl.coverUrl).toContain("mem://audit/");
    const [acc] = await pool.execute<mysql.RowDataPacket[]>("SELECT action FROM auditPackageAccess WHERE packageId = (SELECT id FROM auditPackages WHERE packageRef = ?) ORDER BY id", [custPkg.packageRef]);
    expect(acc.map(a => a.action)).toEqual(["view", "send", "download"]);

    // Re-prepared after R1 is rendered: the new package names the old one, and releasing it supersedes the old; the old manifest is untouched.
    await callerFor(office).closeout.documentRender({ documentRef: (await pool.execute<mysql.RowDataPacket[]>("SELECT documentRef FROM fieldTicketRevisions WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?) AND revision = 1", [t.ticketNumber]))[0][0].documentRef });
    const cust2 = await callerFor(office).audit.packagePrepare({ kind: "customer", subjectRef: t.ticketNumber, recipient: "ABC Energy AP", purpose: "Invoice support, with the rendered ticket" });
    expect(cust2).toMatchObject({ supersedes: true, missing: [] });
    await callerFor(controller).audit.packageRelease({ packageRef: cust2.packageRef, note: "Complete package to ABC AP, replacing the earlier one" });
    const [old] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, manifestHash FROM auditPackages WHERE packageRef = ?", [custPkg.packageRef]);
    expect(old[0]).toMatchObject({ status: "superseded", manifestHash: custGet.manifestHash });
    expect((await callerFor(controller).audit.packageList({ subjectRef: t.ticketNumber })).packages.map(p => [p.kind, p.status])).toEqual([["customer", "released"], ["customer", "superseded"], ["job", "prepared"]]);
  });

  it("builds a vehicle package over the shop's records and a driver package that withholds medical detail by name", async () => {
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const unitNo = key("U").slice(0, 20);
    const [un] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [unitNo]);
    const unitId = Number(un.insertId);
    const woNo = key("WO").slice(0, 40);
    await pool.execute("INSERT INTO workOrders (workOrderNumber, unitId, status, priority, openedAt, technician, createdAt, updatedAt) VALUES (?, ?, 'closed', 'routine', '2026-09-01 00:00:00', 'J. Reyes', NOW(), NOW())", [woNo, unitId]);
    await pool.execute("INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, 'Brake light out', 'advisory', 'resolved', '2026-09-01 00:00:00', ?)", [unitId, mechanic]);
    const serial = key("TS").slice(0, 40);
    await callerFor(mechanic).shop.tireRegister({ serial, size: "11R22.5", positionType: "drive", purchaseCostCents: 62_000 });
    await callerFor(mechanic).shop.tireInstall({ serial, unitId, axlePosition: "2LO", installedAt: new Date("2026-09-02T00:00:00Z"), installOdometerKm: 120_000 });
    const v = await callerFor(safety).audit.packagePrepare({ kind: "vehicle", subjectRef: unitNo, periodFrom: new Date("2026-08-01T00:00:00Z"), periodTo: new Date("2026-09-30T00:00:00Z"), recipient: "Alberta Transportation — facility audit", purpose: "Vehicle file" });
    const g = await callerFor(safety).audit.packageGet({ packageRef: v.packageRef });
    expect(g.items.map(i => i.itemKind)).toEqual(["work_order", "defect", "tire_installation"]);
    expect(g.items.find(i => i.itemKind === "defect")!.redactions).toEqual(["reportedBy: withheld — internal user ids withheld; identities appear by role and identifier"]);
    expect(g.missing.map(m => m.itemKind)).toEqual(["inspection_credential", "mechanic_release"]); // named, not glossed
    // Driver: a medical fitness document is withheld by name; the licence credential stays.
    const driverUser = await withRole("driver");
    const [opIns] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'T. Nguyen', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
    const opId = Number(opIns.insertId);
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, verificationStatus, privateDetail, confidence, createdAt) VALUES ('operator', ?, 'medical_fitness', 'Commercial medical', NOW(), 'verified', 1, 'high', NOW()), ('operator', ?, 'drivers_licence', 'Class 1 licence', NOW(), 'verified', 0, 'high', NOW())", [opId, opId]);
    const dp = await callerFor(safety).audit.packagePrepare({ kind: "driver", subjectRef: String(opId), recipient: "Customer prequalification — ISNetworld", purpose: "Driver qualification file" });
    expect(dp.withheld).toEqual([{ itemKind: "medical_medical_fitness", sourceRef: null, reason: "item withheld (medical_medical_fitness): medical and HR detail withheld — released separately by HR" }]);
    const dg = await callerFor(safety).audit.packageGet({ packageRef: dp.packageRef });
    expect(dg.items.map(i => i.itemKind)).toEqual(["licence_credential"]);
    expect(JSON.stringify(dg)).not.toContain("Commercial medical");
    expect(dg.missing.map(m => m.itemKind)).toEqual(["training", "duty_record"]);
  });
});

d("P8.1 — a package says what was not evaluated when the dispatch was decided", () => {
  it("carries the stored capability picture, with NOT_EVALUATED preserved rather than normalized away", async () => {
    const office = await withRole("office");
    const dispatcher = await withRole("dispatcher");
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [`Op ${Math.random().toString(36).slice(2, 8)}`]);
    const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, createdAt) VALUES (?, 'hydrovac', 'Audit fixture', 'LSD 04-12-055-20W4', 'dispatched', NOW())", [`JOB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`]);

    // A real dispatch decision. No route is named, so routing is genuinely not evaluated — the one
    // absence the composer can detect today without the entitlement source that P8.2 will provide.
    const check = await callerFor(dispatcher).dispatch.evaluate({
      jobId: Number(j.insertId), operatorId: Number(op.insertId), unitId: Number(u.insertId),
    });
    expect(check.checkId).toBeGreaterThan(0);

    const [stored] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT capabilitiesJson, capabilityVerdict FROM dispatchEligibilityChecks WHERE id = ?", [check.checkId]);
    expect(stored[0]!.capabilitiesJson, "the picture must be stored with the decision, not recomputed later").toBeTruthy();
    const capabilities = JSON.parse(stored[0]!.capabilityVerdict ? stored[0]!.capabilitiesJson as string : "[]") as { capability: string; status: string; reason?: string }[];
    const route = capabilities.find(c => c.capability === "route restrictions")!;
    expect(route.status).toBe("NOT_EVALUATED");
    expect(route.reason).toBe("not_applicable");

    // And it reaches the package for that unit, as itself.
    const pkg = await callerFor(office).audit.packagePrepare({
      kind: "vehicle", subjectRef: (await pool.query<mysql.RowDataPacket[]>("SELECT unitNumber FROM units WHERE id = ?", [u.insertId]))[0][0]!.unitNumber as string,
      recipient: "Auditor — capability picture", purpose: "P8.1 evidence of what was and was not evaluated",
    });
    const got = await callerFor(office).audit.packageGet({ packageRef: pkg.packageRef });
    const caps = got.items.filter(i => i.itemKind === "capability_evaluation");
    expect(caps.length, "the package carries the capability picture").toBeGreaterThan(0);
    const routeItem = caps.find(i => (i.sourceRef ?? "").endsWith("route restrictions"))!;
    expect(routeItem, "the unevaluated capability is in the package, not dropped").toBeTruthy();
    expect(routeItem.title).toMatch(/NOT_EVALUATED \(not_applicable\)/);
    // Not collapsed into a neighbouring state, and not summarised into a count.
    expect(JSON.stringify(got.items)).not.toMatch(/"interEngineStatus":"PASS","capability":"route restrictions"/);
  }, 60_000);
});
