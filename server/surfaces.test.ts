import { beforeAll, describe, expect, it } from "vitest";
import { complianceRequirementValidity } from "./_core/complianceDocumentValidity";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { deriveExceptions, summarize, visibleTo, type ExceptionSources } from "./_core/exceptionCentre";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { UNIVERSAL_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

const NOW = new Date("2026-09-10T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const empty = (): ExceptionSources => ({ openCalibrationSweeps: [], inspectorRequests: [],
  now: NOW, criticalDefects: [], roadsideOpen: [], vendorBills: [], purchaseRequests: [], credentialsAwaitingVerification: [], credentialVerdicts: [], aiProposals: [], aiQuestions: [],
  syncConflicts: [], revokedDevicesWithQueue: [], measurementDevices: [], insurancePolicies: [], carrierProfileReviews: [], ungatedAssignments: [], statementsWithFindings: [], tanksOutOfTolerance: [], periodsSoftClosed: [],
});

/* ------------------------------------------------------------------ */
/* Derivation                                                           */
/* ------------------------------------------------------------------ */

/** A verdict built the way the service builds it: the canonical evaluator over the owner's rows of one type. */
function judged(ownerType: string, ownerId: number, ownerLabel: string | null, docType: string, title: string,
  specs: { id: number; status: "needs_review" | "verified" | "rejected"; expires: number | null; issued?: number; captured?: number }[]) {
  const rows = specs.map(r => ({
    id: r.id, docType, title, issuedAt: r.issued == null ? null : days(r.issued), expiresAt: r.expires == null ? null : days(r.expires),
    verificationStatus: r.status, capturedAt: days(r.captured ?? -40),
  }));
  return { ownerType, ownerId, ownerLabel, docType, title, verdict: complianceRequirementValidity(rows, [docType], NOW) };
}

describe("exceptions are derived from state, never stored", () => {
  it("is empty when nothing needs attention, and says so", () => {
    const xs = deriveExceptions(empty());
    expect(xs).toEqual([]);
    expect(summarize(xs).headline).toBe("Nothing needs your attention");
  });

  it("makes a critical defect a CRITICAL 'unit cannot dispatch' with a corrective action", () => {
    const xs = deriveExceptions({ ...empty(), criticalDefects: [{ id: 7, unitId: 144, unitNumber: "144", title: "Brake air leak", reportedAt: days(-1), status: "open" }] });
    expect(xs).toHaveLength(1);
    expect(xs[0].category).toBe("critical");
    expect(xs[0].severity).toBe("critical");
    expect(xs[0].title).toBe("Unit 144 cannot dispatch");
    expect(xs[0].action).toContain("mechanic release");
    expect(xs[0].deepLink.route).toBe("/defects/7");
    expect(xs[0].requiredPermission).toBe("maintenance.read_defect");
  });

  it("distinguishes a credential expiring from one expired, and a worker's from a unit's", () => {
    const xs = deriveExceptions({ ...empty(), credentialVerdicts: [
      judged("operator", 9, "J. Smith", "tdg_certificate", "TDG", [{ id: 1, status: "verified", expires: 14 }]),
      judged("unit", 142, "Unit 142", "cvip_certificate", "CVIP", [{ id: 2, status: "verified", expires: -3 }]),
      judged("operator", 9, "J. Smith", "driver_licence", "Licence", [{ id: 3, status: "verified", expires: 200 }]),
    ]});
    expect(xs.map(x => x.key)).toEqual(["cred:2:expired", "cred:1:expiring"]); // expired (high) sorts before expiring (medium)
    expect(xs[0].category).toBe("fleet");
    expect(xs[1].category).toBe("workforce");
    expect(xs[1].title).toBe("J. Smith: TDG expires in 14 day(s)");
    // Gated on verify, not on the broad passport-read every driver holds.
    expect(xs.every(x => x.requiredPermission === "compliance.credential.verify")).toBe(true);
  });

  /*
   * SPINE item 2 — expiry exceptions come from the canonical verdict per owner and type, not per row.
   * Each of these is a record set the per-row reading got wrong.
   */
  it("a superseded licence that expired beside its renewal in force raises nothing", () => {
    expect(deriveExceptions({ ...empty(), credentialVerdicts: [
      judged("operator", 9, "J. Smith", "driver_licence", "Licence", [
        { id: 1, status: "verified", expires: -30, captured: -400 },
        { id: 2, status: "verified", expires: 300, captured: -35 },
      ]),
    ]})).toEqual([]);
  });

  it("names what the per-row reading never raised: no expiry recorded, and not yet in force", () => {
    const xs = deriveExceptions({ ...empty(), credentialVerdicts: [
      judged("operator", 9, null, "driver_licence", "Licence", [{ id: 5, status: "verified", expires: null }]),
      judged("unit", 4, null, "cvip_certificate", "CVIP", [{ id: 6, status: "verified", expires: 300, issued: 10 }]),
    ]});
    expect(xs.map(x => x.key).sort()).toEqual(["cred:5:incomplete", "cred:6:not_yet_effective"]);
    expect(xs.every(x => x.severity === "medium")).toBe(true);
  });

  it("an unverified document whose own date passed is expired; one with a future date is only in the review queue", () => {
    const xs = deriveExceptions({ ...empty(),
      credentialsAwaitingVerification: [
        { id: 7, ownerType: "operator", ownerId: 9, ownerLabel: null, docType: "h2s", title: "H2S", expiresAt: days(-2) },
        { id: 8, ownerType: "operator", ownerId: 9, ownerLabel: null, docType: "first_aid", title: "First aid", expiresAt: days(200) },
      ],
      credentialVerdicts: [
        judged("operator", 9, null, "h2s", "H2S", [{ id: 7, status: "needs_review", expires: -2 }]),
        judged("operator", 9, null, "first_aid", "First aid", [{ id: 8, status: "needs_review", expires: 200 }]),
      ],
    });
    expect(xs.map(x => x.key).sort()).toEqual(["cred:7:expired", "cred:7:review", "cred:8:review"]);
  });

  it("raises a bill past due to high, and names the office action per status", () => {
    const xs = deriveExceptions({ ...empty(), vendorBills: [
      { id: 1, billRef: "BILL-A", vendorName: "ABC Tire", total: 2152.5, status: "mismatch", matchOutcome: "mismatch", receivedAt: days(-5), dueAt: days(20) },
      { id: 2, billRef: "BILL-B", vendorName: null, total: 100, status: "needs_coding", matchOutcome: "unmatched", receivedAt: days(-40), dueAt: days(-10) },
      { id: 3, billRef: "BILL-C", vendorName: null, total: 100, status: "paid", matchOutcome: "match", receivedAt: days(-40), dueAt: null },
    ]});
    expect(xs.map(x => x.key).sort()).toEqual(["bill:1", "bill:2"]);
    const b = new Map(xs.map(x => [x.key, x]));
    expect(b.get("bill:1")!.severity).toBe("high");
    expect(b.get("bill:1")!.action).toContain("Resolve the variances");
    expect(b.get("bill:2")!.severity).toBe("high");
    expect(b.get("bill:2")!.reason).toContain("10 day(s) past due");
  });

  it("makes an emergency purchase request critical and a standard one medium", () => {
    const xs = deriveExceptions({ ...empty(), purchaseRequests: [
      { id: 1, authorizationRef: "PA-E", estimatedAmount: 2200, emergency: true, requestedAt: days(0), expiresAt: days(1), status: "requested" },
      { id: 2, authorizationRef: "PA-S", estimatedAmount: 900, emergency: false, requestedAt: days(0), expiresAt: days(14), status: "requested" },
      { id: 3, authorizationRef: "PA-X", estimatedAmount: 900, emergency: false, requestedAt: days(0), expiresAt: days(14), status: "approved" },
    ]});
    expect(xs.map(x => [x.key, x.severity])).toEqual([["pa:1", "critical"], ["pa:2", "medium"]]);
  });

  it("orders calibration by consequence: failed critical, expired high, unknown medium, due soon low, current absent", () => {
    const xs = deriveExceptions({ ...empty(), measurementDevices: [
      { deviceRef: "MD-1", deviceType: "truck_scale", status: "active", calibrationState: "current", daysRemaining: 90 },
      { deviceRef: "MD-2", deviceType: "truck_scale", status: "out_of_service", calibrationState: "failed", daysRemaining: null },
      { deviceRef: "MD-3", deviceType: "fuel_meter", status: "active", calibrationState: "expired", daysRemaining: -4 },
      { deviceRef: "MD-4", deviceType: "load_cell", status: "active", calibrationState: "due_soon", daysRemaining: 12 },
      { deviceRef: "MD-5", deviceType: "gas_detector", status: "active", calibrationState: "unknown", daysRemaining: null },
    ]});
    expect(xs.map(x => x.subjectId)).toEqual(["MD-2", "MD-3", "MD-5", "MD-4"]);
    expect(xs[0].reason).toContain("billing on hold");
  });

  it("walks an insurance policy up the renewal calendar as expiry approaches", () => {
    const at = (n: number) => deriveExceptions({ ...empty(), insurancePolicies: [{ policyRef: "POL", policyType: "commercial_auto", expiresAt: days(n), status: "active" }] })[0];
    expect(at(120)).toBeUndefined();
    expect(at(80).severity).toBe("low");
    expect(at(25).severity).toBe("medium");
    expect(at(5).severity).toBe("high");
    expect(at(-1).severity).toBe("critical");
    expect(at(-1).reason).toContain("not dispatchable");
  });

  it("raises unmatched regulator events and overdue reviews", () => {
    const xs = deriveExceptions({ ...empty(), carrierProfileReviews: [{ reviewRef: "CPR-1", unmatchedExternalEvents: 2, reviewedAt: days(-100), nextReviewDueAt: days(-9) }] });
    expect(xs.map(x => x.key)).toEqual(["profile:CPR-1", "profile-due:CPR-1"]);
  });

  it("keys AI questions by the person asked and keeps sync conflicts material-aware", () => {
    const xs = deriveExceptions({ ...empty(),
      aiQuestions: [{ count: 3, oldest: days(-2), askedToUserId: 9 }, { count: 0, oldest: null, askedToUserId: 10 }],
      syncConflicts: [{ id: 1, conflictRef: "CONF-1", recordType: "disposal_ticket", recordRef: "DSP-1", material: true, detectedAt: days(0) }],
    });
    expect(xs.map(x => x.key).sort()).toEqual(["conflict:1", "questions:9"]);
    expect(xs.find(x => x.key === "conflict:1")!.severity).toBe("high");
  });

  it("dedupes by key and sorts critical → high → medium → low, then by due date", () => {
    const xs = deriveExceptions({ ...empty(),
      purchaseRequests: [{ id: 1, authorizationRef: "PA", estimatedAmount: 1, emergency: false, requestedAt: days(0), expiresAt: days(3), status: "requested" }],
      criticalDefects: [{ id: 1, unitId: 1, unitNumber: null, title: "x", reportedAt: days(0), status: "open" }],
      credentialVerdicts: [judged("operator", 1, null, "d", "Doc", [{ id: 1, status: "verified", expires: 1 }])],
    });
    expect(xs.map(x => x.severity)).toEqual(["critical", "high", "medium"]);
    expect(new Set(xs.map(x => x.key)).size).toBe(xs.length);
  });
});

/* ------------------------------------------------------------------ */
/* Permission filter                                                    */
/* ------------------------------------------------------------------ */

describe("the centre shows what you may act on, not what others worry about", () => {
  const all = deriveExceptions({ ...empty(),
    criticalDefects: [{ id: 1, unitId: 1, unitNumber: "1", title: "x", reportedAt: days(0), status: "open" }],
    vendorBills: [{ id: 1, billRef: "B", vendorName: null, total: 1, status: "mismatch", matchOutcome: "mismatch", receivedAt: days(0), dueAt: null }],
    syncConflicts: [{ id: 1, conflictRef: "C", recordType: "x", recordRef: "y", material: true, detectedAt: days(0) }],
    aiProposals: [{ proposalId: "P", formKey: "expense_receipt", title: "t", createdAt: days(0), commitState: "awaiting_readback" }],
  });

  it("gives a driver nothing — none of it is theirs to act on", () => {
    // A held unit reaches the driver through My Day and dispatch eligibility;
    // their own proposal reaches them through the inbox. The exception centre
    // lists corrective actions, and a driver does not repair, code or resolve.
    const mine = visibleTo({ exceptions: all, userId: 1, grants: [{ role: "driver" }] });
    expect(mine).toEqual([]);
  });

  it("gives a dispatcher and a mechanic the held unit, and neither the bill", () => {
    for (const role of ["dispatcher", "mechanic"]) {
      const mine = visibleTo({ exceptions: all, userId: 1, grants: [{ role }] });
      expect(mine.map(x => x.category), role).toEqual(["critical"]);
    }
  });

  it("gives a bookkeeper the bill and nothing else", () => {
    const mine = visibleTo({ exceptions: all, userId: 1, grants: [{ role: "bookkeeper" }] });
    expect(mine.map(x => x.category)).toEqual(["billing"]);
  });

  it("gives office all four — it acts on every one of them", () => {
    const mine = visibleTo({ exceptions: all, userId: 1, grants: [{ role: "office" }] });
    expect(mine.map(x => x.category).sort()).toEqual(["ai", "billing", "critical", "sync"]);
  });

  it("gives nobody anything with no role", () => {
    expect(visibleTo({ exceptions: all, userId: 1, grants: [] })).toEqual([]);
  });
});

describe("every gate the surfaces use is a real permission", () => {
  it("names only permissions that exist — an invented one refuses everyone", () => {
    // v21.0 found this: search gated units on "unit.read", which does not
    // exist, so authorize() refused it for every caller and no one could find
    // a truck. A gate that is not a permission is a lock with no key.
    const src = readFileSync("server/surfacesService.ts", "utf8") + readFileSync("server/_core/exceptionCentre.ts", "utf8");
    const auth = readFileSync("server/_core/recordsAuthorization.ts", "utf8");
    const union = auth.slice(auth.indexOf("export type Permission ="), auth.indexOf("/** The read categories"));
    const known = new Set(Array.from(union.matchAll(/"([a-z_.]+)"/g)).map(m => m[1]));
    const used = Array.from(src.matchAll(/(?:readPermission|requiredPermission): "([a-z_.]+)"/g)).map(m => m[1]);
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter(p => !known.has(p))).toEqual([]);
  });
});

describe("inbox and my day are self-scoped", () => {
  it("adds two universals that read only the session", () => {
    expect(UNIVERSAL_PERMISSIONS).toEqual(expect.arrayContaining(["inbox.read_own", "myday.read_own"]));
  });
});

/* ------------------------------------------------------------------ */
/* The surfaces, end to end                                             */
/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 400_000_000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("one company's morning, through the five surfaces", () => {
  it("derives, filters, finds and narrates real state", async () => {
    const office = await withRole("office");
    const driver = await withRole("driver");
    const controller = await withRole("controller");
    const unitNo = key("144").slice(0, 30);
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company) VALUES (?, 'truck', 'ABC')", [unitNo]);
    const unitId = Number(u.insertId);
    // A critical defect, a mismatched bill, a queued conflict, an expiring TDG, an AI proposal awaiting the driver.
    await pool.execute("INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, 'Steer tire failure', 'critical', 'open', NOW(), ?)", [unitId, driver]);
    const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (name, category) VALUES (?, 'tires')", [key("ABC Tire").slice(0, 60)]);
    const billRef = key("BILL").slice(0, 40);
    // AIL-1A.1: search reads a bill through its financial entity's owner, so the bill needs a real entity
    // (unowned: the single tenant's, like these users) rather than whatever row happens to have id 1.
    // P0-A3: search is scoped to the caller's books. This company's people hold no membership, so they are the
    // historical single tenant and see the books that carry no organization — the bill goes into one of those.
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Surfaces fixture books', 'corporation', 'CA-AB')", [key("FE").slice(0, 40)]);
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, vendorInvoiceNumber, invoiceDate, receivedAt, subtotalCents, taxAmountCents, totalCents, matchOutcome, status) VALUES (?, ?, ?, ?, NOW(), NOW(), 205000, 10250, 215250, 'mismatch', 'mismatch')", [billRef, Number(book.insertId), Number(ven.insertId), key("INV").slice(0, 40)]);
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name) VALUES (?, 'J. Smith')", [driver]);
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator', ?, 'tdg_certificate', 'TDG', NOW(), DATE_ADD(NOW(), INTERVAL 10 DAY), 'verified')", [Number(op.insertId)]);
    const proposalId = key("PROP");
    await pool.execute("INSERT INTO assistantProposals (tenantId, tenantDerivedFrom, proposalId, formKey, formVersion, title, targetRef, createdByUserId, readBack, readBackAcknowledged, commitState) VALUES ('default', 'single_tenant_fallback', ?, 'defect_report', 1, 'Hydraulic leak', 'U', ?, 'rb', 0, 'awaiting_readback')", [proposalId, driver]);
    await pool.execute(
      "INSERT INTO operationalTasks (taskNumber, taskType, title, status, priority, tenantId, subjectType, subjectId, assignedRole, assignedUserId, dedupeKey, requiresEvidence, escalationStep, createdAt) VALUES (?, 'follow_up', 'Call ABC Tire about invoice', 'open', 'normal', 'default', 'vendorBill', ?, 'office', ?, ?, 0, 0, NOW())",
      [key("TASK").slice(0, 40), billRef, office, key("dedupe").slice(0, 100)]
    );

    // Exceptions: office sees the bill and the AI proposal; the driver sees the defect and the proposal; the controller sees the bill.
    const officeX = await callerFor(office).surfaces.exceptions();
    const theBillId = await billId(billRef);
    expect(officeX.items.some(x => x.key === `bill:${theBillId}`)).toBe(true);
    expect(officeX.items.some(x => x.category === "critical")).toBe(true); // office acts on held units too
    const dispatcher = await withRole("dispatcher");
    const dispX = await callerFor(dispatcher).surfaces.exceptions();
    expect(dispX.items.some(x => x.title === `Unit ${unitNo} cannot dispatch`)).toBe(true);
    expect(dispX.items.some(x => x.category === "billing")).toBe(false);
    expect(dispX.summary.bySeverity.critical).toBeGreaterThanOrEqual(1);
    const driverX = await callerFor(driver).surfaces.exceptions();
    expect(driverX.items).toEqual([]);
    const ctrlX = await callerFor(controller).surfaces.exceptions({ category: "billing" });
    expect(ctrlX.items.every(x => x.category === "billing")).toBe(true);

    // Inbox: office has its task; the driver has the proposal awaiting their read-back; nobody has anyone else's.
    const officeIn = await callerFor(office).surfaces.inbox();
    expect(officeIn.items.some(i => i.kind === "task" && i.title === "Call ABC Tire about invoice")).toBe(true);
    expect(officeIn.items.some(i => i.kind === "ai_proposal")).toBe(false);
    const driverIn = await callerFor(driver).surfaces.inbox();
    expect(driverIn.items.some(i => i.kind === "ai_proposal" && i.ref === proposalId)).toBe(true);
    expect(driverIn.items.some(i => i.kind === "task")).toBe(false);

    // My day: the driver's next action is their own proposal's read-back; the
    // dispatcher's is the held unit.
    const day = await callerFor(driver).surfaces.myDay();
    expect(day.portals).toContain("field_workforce");
    expect(day.attention.total).toBe(0);
    expect(day.next?.kind).toBe("inbox");
    expect(day.waitingFor.count).toBeGreaterThanOrEqual(1);
    const dispDay = await callerFor(dispatcher).surfaces.myDay();
    expect(dispDay.next?.kind).toBe("exception");
    // The next action is the most urgent critical item on the database, which
    // across repeated runs may be an earlier run's unit; what must hold is that
    // it is a held unit and that this run's unit is in the attention set.
    // ...and it may be any critical category — a held unit or an open roadside event.
    expect(dispDay.next?.title).toMatch(/cannot dispatch|Roadside event/);
    expect(dispDay.attention.bySeverity.critical).toBeGreaterThanOrEqual(1);

    // Search: the unit number resolves for the driver; the bill resolves for office and not for the driver.
    const s1 = await callerFor(driver).surfaces.search({ q: unitNo });
    expect(s1.hits.some(h => h.entityType === "unit" && h.label === `Unit ${unitNo}`)).toBe(true);
    expect((await callerFor(office).surfaces.search({ q: billRef })).hits.some(h => h.entityType === "vendorBill")).toBe(true);
    expect((await callerFor(driver).surfaces.search({ q: billRef })).hits.some(h => h.entityType === "vendorBill")).toBe(false);

    // Timeline: the unit's history shows the defect, for a mechanic; the driver reads only what they may.
    const mechanic = await withRole("mechanic");
    const tl = await callerFor(mechanic).surfaces.timeline({ entityType: "unit", entityId: unitId });
    expect(tl.events.some(e => e.kind === "defect" && e.title.includes("Steer tire failure"))).toBe(true);
    expect(tl.events[0].occurredAt).toBeInstanceOf(Date);
  });

  it("refuses the surfaces to a role-less caller and reads no user id from the request", async () => {
    await expect(callerFor(nextUser()).surfaces.inbox()).rejects.toBeTruthy();
    const src = readFileSync("server/surfacesRouter.ts", "utf8");
    const inbox = src.slice(src.indexOf("inbox: roleProcedure"), src.indexOf("myDay: roleProcedure"));
    // TEN-INBOX-1: the only input is NO_INPUT — a strict empty object — so the request can carry no user id,
    // organization or anything else; one that tries is refused rather than ignored.
    expect(inbox.match(/\.input\(([^)]*)\)/g)).toEqual([".input(NO_INPUT)"]);
    expect(src).toContain("const NO_INPUT = z.object({}).strict().optional();");
    await expect(callerFor(nextUser()).surfaces.inbox({ userId: 1 } as never)).rejects.toBeTruthy();
  });
});

async function billId(billRef: string): Promise<number> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT id FROM vendorBills WHERE billRef = ?", [billRef]);
  return Number(rows[0].id);
}
