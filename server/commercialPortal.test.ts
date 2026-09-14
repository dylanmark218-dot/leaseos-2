import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { commercialBillingCheck, poAvailability, priceLines, type PurchaseOrder } from "./_core/commercial";
import { intakeDisposalTicket, intakeVendorBill, scopeOf, type ExternalIdentity } from "./_core/portalIntake";
import { EXTERNAL_KIND_PERMISSIONS, EXTERNAL_PROCEDURE_PERMISSIONS, EXTERNAL_SENSITIVE_PERMISSIONS, authorize, type DomainRole } from "./_core/recordsAuthorization";
import { externalProcedure } from "./_core/trpc";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";

const at = (iso: string) => new Date(iso);
const po = (over: Partial<PurchaseOrder> = {}): PurchaseOrder => ({ poRef: "PO-1", poNumber: "4500123", afeNumber: null, authorizedCents: 500_000, consumedCents: 0, validFrom: at("2026-01-01T00:00:00Z"), validTo: at("2026-12-31T00:00:00Z"), status: "open", ...over });
const terms = (over = {}) => ({ status: "active" as const, holdReason: null, paymentTermsDays: 30, creditLimitCents: null, requiresPurchaseOrder: false, requiresAfe: false, ...over });
const NOW = at("2026-09-15T00:00:00Z");

describe("a purchase order is an authorization with an amount and a life", () => {
  it("is available while live and funded; exhausted, expired and closed are named", () => {
    expect(poAvailability(po(), 100_000, NOW)).toMatchObject({ available: true, remainingCents: 400_000 });
    expect(poAvailability(po({ consumedCents: 450_000 }), 100_000, NOW).reason).toContain("$500.00 remaining of $5000.00");
    expect(poAvailability(po({ validTo: at("2026-06-30T00:00:00Z") }), 1, NOW).reason).toContain("expired 2026-06-30");
    expect(poAvailability(po({ validFrom: at("2027-01-01T00:00:00Z") }), 1, NOW).reason).toContain("not valid until 2027-01-01");
    expect(poAvailability(po({ status: "closed" }), 1, NOW).available).toBe(false);
  });
});

describe("may this invoice be issued?", () => {
  it("blocks a hold, a missing required PO, an unavailable PO and a missing AFE; reviews a credit-limit breach; derives the due date from terms", () => {
    const hold = commercialBillingCheck({ terms: terms({ status: "on_hold", holdReason: "90+ days outstanding" }), invoiceTotalCents: 10_000, outstandingCents: 0, po: null, afeSupplied: null, at: NOW });
    expect(hold.verdict).toBe("blocked");
    expect(hold.findings[0]).toMatchObject({ code: "account_on_hold", detail: "Account is on hold: 90+ days outstanding" });
    const noPo = commercialBillingCheck({ terms: terms({ requiresPurchaseOrder: true }), invoiceTotalCents: 10_000, outstandingCents: 0, po: null, afeSupplied: null, at: NOW });
    expect(noPo.findings.map(f => f.code)).toEqual(["po_required"]);
    const exhausted = commercialBillingCheck({ terms: terms({ requiresPurchaseOrder: true }), invoiceTotalCents: 10_000, outstandingCents: 0, po: po({ consumedCents: 495_000 }), afeSupplied: null, at: NOW });
    expect(exhausted.findings.map(f => f.code)).toEqual(["po_unavailable"]);
    const afe = commercialBillingCheck({ terms: terms({ requiresAfe: true }), invoiceTotalCents: 10_000, outstandingCents: 0, po: po(), afeSupplied: null, at: NOW });
    expect(afe.findings.map(f => f.code)).toEqual(["afe_required"]);
    expect(commercialBillingCheck({ terms: terms({ requiresAfe: true }), invoiceTotalCents: 10_000, outstandingCents: 0, po: po({ afeNumber: "AFE-77" }), afeSupplied: null, at: NOW }).verdict).toBe("ready"); // the PO carries the AFE
    const credit = commercialBillingCheck({ terms: terms({ creditLimitCents: 100_000, paymentTermsDays: 45 }), invoiceTotalCents: 30_000, outstandingCents: 80_000, po: null, afeSupplied: null, at: NOW });
    expect(credit.verdict).toBe("review");
    expect(credit.findings[0].detail).toBe("$800.00 outstanding plus $300.00 exceeds the $1000.00 limit");
    expect(credit.dueAt.toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });

  it("prices lines from the customer's card, applies minimums, and names what the card cannot price", () => {
    const card = [{ serviceCode: "VAC-HR", unit: "hour" as const, rateCents: 18_500, minimumCents: 74_000 }, { serviceCode: "DISP-M3", unit: "m3" as const, rateCents: 2_250, minimumCents: null }];
    const r = priceLines(card, [{ serviceCode: "VAC-HR", quantity: 2.5, unit: "hour" }, { serviceCode: "DISP-M3", quantity: 18, unit: "m3" }, { serviceCode: "HOSE-EXTRA", quantity: 1, unit: "each" }, { serviceCode: "VAC-HR", quantity: 40, unit: "km" }]);
    expect(r.priced).toEqual([
      { serviceCode: "VAC-HR", quantity: 2.5, unit: "hour", rateCents: 18_500, amountCents: 74_000, minimumApplied: true },
      { serviceCode: "DISP-M3", quantity: 18, unit: "m3", rateCents: 2_250, amountCents: 40_500, minimumApplied: false },
    ]);
    expect(r.unpriced.map(u => u.serviceCode)).toEqual(["HOSE-EXTRA", "VAC-HR"]);
    expect(r.unpriced[1].reason).toContain("per hour; the line is in km");
    expect(r.totalCents).toBe(114_500);
  });
});

const vendorId = (over: Partial<ExternalIdentity> = {}): ExternalIdentity => ({ id: 1, kind: "vendor", customerAccountId: null, vendorId: 9, facilityId: null, status: "active", ...over });
const facilityId = (over: Partial<ExternalIdentity> = {}): ExternalIdentity => ({ id: 2, kind: "facility", customerAccountId: null, vendorId: null, facilityId: 4, status: "active", ...over });
const bill = (over = {}) => ({ vendorInvoiceNumber: "T-1001", invoiceDate: NOW, subtotal: 400, taxAmount: 20, total: 420, lines: [{ description: "Tire", quantity: 2, unitPrice: 200 }], purchaseAuthorizationRef: null, ...over });

describe("what comes in from outside is checked, and scoped by the binding", () => {
  it("accepts a bill that adds up, refuses one that does not, refuses a repeat, and notes a missing purchase authorization", () => {
    expect(intakeVendorBill({ identity: vendorId(), payload: bill(), vendorRequiresPurchaseAuthorization: false, existingInvoiceNumbers: [] })).toEqual({ accepted: true, refusals: [], findings: [] });
    const bad = intakeVendorBill({ identity: vendorId(), payload: bill({ total: 430 }), vendorRequiresPurchaseAuthorization: false, existingInvoiceNumbers: [] });
    expect(bad.refusals[0]).toContain("is not total 430.00");
    expect(intakeVendorBill({ identity: vendorId(), payload: bill(), vendorRequiresPurchaseAuthorization: false, existingInvoiceNumbers: ["T-1001"] }).refusals[0]).toContain("already submitted");
    const pa = intakeVendorBill({ identity: vendorId(), payload: bill(), vendorRequiresPurchaseAuthorization: true, existingInvoiceNumbers: [] });
    expect(pa.accepted).toBe(true);
    expect(pa.findings[0]).toContain("four-way match will hold it");
    expect(intakeVendorBill({ identity: facilityId(), payload: bill(), vendorRequiresPurchaseAuthorization: false, existingInvoiceNumbers: [] }).refusals[0]).toContain("Only a vendor identity");
    expect(intakeVendorBill({ identity: vendorId({ status: "suspended" }), payload: bill(), vendorRequiresPurchaseAuthorization: false, existingInvoiceNumbers: [] }).refusals[0]).toContain("suspended");
  });

  it("grades a facility ticket: weights that reconcile and a scale hash are high; weights alone medium; a quantity alone low", () => {
    const base = { facilityTicketNumber: "F-88192", scaleInAt: NOW, grossKg: 41_200, tareKg: 18_900, netKg: 22_300, quantity: null, quantityUnit: null, carrierUnitNumber: "142", loadReference: null, scaleRecordHash: "a".repeat(64) };
    expect(intakeDisposalTicket({ identity: facilityId(), payload: base, existingTicketNumbers: [] })).toMatchObject({ accepted: true, confidence: "high", findings: [] });
    expect(intakeDisposalTicket({ identity: facilityId(), payload: { ...base, scaleRecordHash: null }, existingTicketNumbers: [] }).confidence).toBe("medium");
    expect(intakeDisposalTicket({ identity: facilityId(), payload: { ...base, grossKg: null, tareKg: null, netKg: null, quantity: 20, quantityUnit: "m3", carrierUnitNumber: null }, existingTicketNumbers: [] })).toMatchObject({ accepted: true, confidence: "low" });
    expect(intakeDisposalTicket({ identity: facilityId(), payload: { ...base, netKg: 21_000 }, existingTicketNumbers: [] }).refusals[0]).toContain("≠ net");
    expect(intakeDisposalTicket({ identity: facilityId(), payload: { ...base, scaleRecordHash: "nope" }, existingTicketNumbers: [] }).refusals[0]).toContain("SHA-256");
    expect(intakeDisposalTicket({ identity: facilityId(), payload: base, existingTicketNumbers: ["F-88192"] }).refusals[0]).toContain("already submitted");
  });

  it("scopes by the binding and only while active", () => {
    expect(scopeOf(vendorId())).toEqual({ kind: "vendor", accountId: 9 });
    expect(scopeOf(vendorId({ status: "revoked" }))).toBeNull();
    expect(scopeOf(vendorId({ vendorId: null }))).toBeNull();
  });
});

describe("the external gate is wired like the role gate", () => {
  it("refuses to mount an unmapped external procedure, holds every mapped permission in exactly the kinds that own it, and counts writes as sensitive", () => {
    expect(() => externalProcedure("portal.notAThing")).toThrow(/No external permission mapped/);
    for (const [proc, perm] of Object.entries(EXTERNAL_PROCEDURE_PERMISSIONS)) {
      const owners = (Object.keys(EXTERNAL_KIND_PERMISSIONS) as (keyof typeof EXTERNAL_KIND_PERMISSIONS)[]).filter(k => EXTERNAL_KIND_PERMISSIONS[k].includes(perm));
      expect(owners.length, proc).toBeGreaterThan(0);
      // Every kind holds its own identity lifecycle; everything else belongs to exactly one kind.
      if (!["portal.self", "portal.invitation.accept", "portal.credential.manage"].includes(perm)) expect(owners, proc).toHaveLength(1);
    }
    expect([...EXTERNAL_SENSITIVE_PERMISSIONS].sort()).toEqual(["portal.credential.manage", "portal.customer.adjust", "portal.customer.commit", "portal.customer.decide", "portal.customer.dispute", "portal.customer.documents", "portal.customer.sign", "portal.facility.submit", "portal.vendor.submit"]);
  });

  it("keeps the inside roles that touch the outside narrow", () => {
    const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "portal.identity.manage" }).allowed).sort()).toEqual(["controller", "management"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "commercial.ratecard.manage" }).allowed).sort()).toEqual(["controller", "management"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "portal.submission.review" }).allowed).sort()).toEqual(["bookkeeper", "controller", "office"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 1_700_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string | null) => appRouter.createCaller({ req: { headers: token ? { "x-portal-token": token } : {} } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("outside, in", () => {
  it("invites a customer, shows them only their account, refuses a dispute on another's invoice, and blocks an invoice the account requires a PO for", async () => {
    const controller = await withRole("controller");
    const bookkeeper = await withRole("bookkeeper");
    const entityId = 1_800_000 + Math.floor(Math.random() * 90_000);
    const acctRef = key("CUST").slice(0, 40), otherRef = key("CUST").slice(0, 40);
    const [a] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'Acme Energy')", [acctRef, entityId]);
    const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'Bravo Oil')", [otherRef, entityId]);
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, 1, 'Acme Energy', 'invoiced', NOW(), NOW(), NOW())", [key("BB").slice(0, 40)]);
    const mine = key("INV").slice(0, 40), theirs = key("INV").slice(0, 40);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, customerAccountId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, ?, '2026-08-05 00:00:00', ?, 1, 'Acme Energy', 100000, 5000, 105000, 'CAD', 'sent', '2026-09-04 00:00:00')", [mine, entityId, Number(a.insertId), Number(book.insertId)]);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, customerAccountId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, ?, '2026-08-05 00:00:00', ?, 1, 'Bravo Oil', 50000, 2500, 52500, 'CAD', 'sent', '2026-09-04 00:00:00')", [theirs, entityId, Number(o.insertId), Number(book.insertId)]);

    // Terms: PO required, 45 days. A PO with an AFE. The commercial check blocks an invoice without it and passes one with it.
    await callerFor(controller).commercial.termsSet({ accountRef: acctRef, requiresPurchaseOrder: true, paymentTermsDays: 45, creditLimitCents: 2_000_000 });
    await expect(callerFor(bookkeeper).commercial.termsSet({ accountRef: acctRef, status: "on_hold" })).rejects.toBeTruthy(); // not the bookkeeper's, and no reason anyway
    const poRec = await callerFor(bookkeeper).commercial.poRecord({ accountRef: acctRef, poNumber: "4500123", afeNumber: "AFE-77", authorizedCents: 300_000, validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2026-12-31T00:00:00Z") });
    expect(poRec.poNumber).toBe("4500123");
    await callerFor(controller).commercial.rateCardCreate({ accountRef: acctRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), lines: [{ serviceCode: "VAC-HR", description: "Vac truck, hourly", unit: "hour", rateCents: 18_500, minimumCents: 74_000 }] });
    const blocked = await callerFor(bookkeeper).commercial.billingCheck({ accountRef: acctRef, invoiceTotalCents: 74_000, at: new Date("2026-09-15T00:00:00Z") });
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.findings.map(f => f.code)).toEqual(["po_required"]);
    expect(blocked.outstandingCents).toBe(105_000);
    const ready = await callerFor(bookkeeper).commercial.billingCheck({ accountRef: acctRef, invoiceTotalCents: 74_000, poNumber: "4500123", at: new Date("2026-09-15T00:00:00Z"), serviceLines: [{ serviceCode: "VAC-HR", quantity: 3, unit: "hour" }] });
    expect(ready.verdict).toBe("ready");
    expect(ready.po).toMatchObject({ remainingCents: 300_000 });
    expect(ready.dueAt.toISOString()).toBe("2026-10-30T00:00:00.000Z");
    expect(ready.pricing?.priced[0]).toMatchObject({ amountCents: 74_000, minimumApplied: true });

    // Invite. The token comes back once; the row holds only its hash.
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: "ap@acme.example", displayName: "Acme AP" });
    const acc0 = await portalCaller(inv.invitationToken).portal.invitationAccept(); const invToken = acc0.token;
    expect(inv.invitationToken.length).toBeGreaterThan(30); expect(invToken.length).toBeGreaterThan(30);
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT tokenHash, status FROM externalIdentities WHERE identityRef = ?", [inv.identityRef]);
    expect(row[0].tokenHash).not.toContain(invToken); expect(row[0].tokenHash).not.toContain(inv.invitationToken);
    expect(row[0].status).toBe("active");

    // No token, wrong token: refused and audited. The right token sees exactly its own account.
    await expect(portalCaller(null).portal.me()).rejects.toThrow(/No portal token/);
    await expect(portalCaller("not-a-token").portal.me()).rejects.toThrow(/Unknown portal token/);
    const me = await portalCaller(invToken).portal.me();
    expect(me).toMatchObject({ kind: "customer", displayName: "Acme AP" });
    const st = await portalCaller(invToken).portal.customerStatement();
    expect(st.account).toMatchObject({ name: "Acme Energy", paymentTermsDays: 45 });
    expect(st.invoices.map(i => i.invoiceNumber)).toEqual([mine]);            // never Bravo's
    expect(st.outstandingCents).toBe(105_000);
    expect(st.purchaseOrders[0]).toMatchObject({ poNumber: "4500123", afeNumber: "AFE-77", consumedCents: 0 });
    // A customer identity does not hold vendor permissions.
    await expect(portalCaller(invToken).portal.vendorStatement()).rejects.toThrow(/does not hold portal.vendor.read/);

    // A dispute on Bravo's invoice is "no such invoice" — the binding decides, not the request. On its own, it is a submission.
    await expect(portalCaller(invToken).portal.invoiceDispute({ invoiceNumber: theirs, disputedAmountCents: 100, reason: "This is not our invoice at all" })).rejects.toThrow(/No such invoice on this account/);
    const disp = await portalCaller(invToken).portal.invoiceDispute({ invoiceNumber: mine, disputedAmountCents: 15_000, reason: "Standby hours were not on the field ticket" });
    expect(disp.status).toBe("submitted");
    const again = await portalCaller(invToken).portal.invoiceDispute({ invoiceNumber: mine, disputedAmountCents: 15_000, reason: "Standby hours were not on the field ticket" });
    expect(again).toMatchObject({ submissionRef: disp.submissionRef, duplicate: true });
    const rev = await callerFor(bookkeeper).portalAdmin.submissionReview({ submissionRef: disp.submissionRef, decision: "accepted", reason: "Dispute logged for review" });
    expect(rev.resultRef).toMatch(/^DISP-/);
    const [dc] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, disputedAmountCents FROM disputeCases WHERE caseNumber = ?", [rev.resultRef]);
    expect(dc[0]).toMatchObject({ status: "raised", disputedAmountCents: 15_000 });
    const [audits] = await pool.execute<mysql.RowDataPacket[]>("SELECT outcome, rolesHeld FROM authorizationDecisions WHERE procedureName = 'portal.me' AND subjectType = 'externalIdentity' ORDER BY id DESC LIMIT 3");
    expect(audits.map(x => x.outcome).sort()).toEqual(["allowed", "denied_unauthenticated", "denied_unauthenticated"]);
  });

  it("lets a vendor submit a bill once, lets the office accept it into the four-way match, and shows the vendor its stage", async () => {
    const controller = await withRole("controller");
    const office = await withRole("office");
    const entityId = 1_900_000 + Math.floor(Math.random() * 90_000);
    const [v] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (name, category, paymentTermsDays) VALUES (?, 'tires', 30)", [key("V").slice(0, 60)]);
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "vendor", vendorId: Number(v.insertId), email: "ar@tires.example", displayName: "Tire Co AR" });
    const acc0 = await portalCaller(inv.invitationToken).portal.invitationAccept(); const invToken = acc0.token;
    const sub = await portalCaller(invToken).portal.vendorBillSubmit({ vendorInvoiceNumber: "T-1001", invoiceDate: new Date("2026-09-10T00:00:00Z"), subtotal: 400, taxAmount: 20, total: 420, lines: [{ description: "11R22.5 drive tire", quantity: 2, unitPrice: 200 }] });
    expect(sub.status).toBe("submitted");
    await expect(portalCaller(invToken).portal.vendorBillSubmit({ vendorInvoiceNumber: "T-1002", invoiceDate: new Date("2026-09-10T00:00:00Z"), subtotal: 400, taxAmount: 20, total: 500, lines: [{ description: "x", quantity: 2, unitPrice: 200 }] })).rejects.toThrow(/is not total 500.00/);
    await expect(portalCaller(invToken).portal.vendorBillSubmit({ vendorInvoiceNumber: "T-1001", invoiceDate: new Date("2026-09-11T00:00:00Z"), subtotal: 400, taxAmount: 20, total: 420, lines: [{ description: "again", quantity: 2, unitPrice: 200 }] })).rejects.toThrow(/already submitted/);
    await expect(callerFor(office).portalAdmin.submissionReview({ submissionRef: sub.submissionRef, decision: "accepted", reason: "Looks right" })).rejects.toThrow(/needs the financial entity/);
    const acc = await callerFor(office).portalAdmin.submissionReview({ submissionRef: sub.submissionRef, decision: "accepted", reason: "Matches the tire work order", financialEntityId: entityId });
    expect(acc.resultRef).toMatch(/^BILL-/);
    const [bill] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, matchOutcome, totalCents FROM vendorBills WHERE billRef = ?", [acc.resultRef]);
    expect(bill[0]).toMatchObject({ status: "received", matchOutcome: "unmatched", totalCents: 42000 }); // into the match, not past it
    const st = await portalCaller(invToken).portal.vendorStatement();
    expect(st.submissions[0]).toMatchObject({ submissionRef: sub.submissionRef, status: "accepted", resultRef: acc.resultRef });
    expect(st.bills[0]).toMatchObject({ vendorInvoiceNumber: "T-1001", stage: "received", paidAt: null });
    await expect(portalCaller(invToken).portal.customerStatement()).rejects.toThrow(/does not hold portal.customer.read/);
  });

  it("lets a facility submit a ticket with its scale hash, which enters as needs_review from the facility portal", async () => {
    const controller = await withRole("controller");
    const office = await withRole("office");
    const [f] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, status) VALUES (?, 'open')", [key("F").slice(0, 60)]);
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "facility", facilityId: Number(f.insertId), email: "scale@facility.example", displayName: "Scale House" });
    const acc0 = await portalCaller(inv.invitationToken).portal.invitationAccept(); const invToken = acc0.token;
    const sub = await portalCaller(invToken).portal.disposalTicketSubmit({ facilityTicketNumber: "F-88192", scaleInAt: new Date("2026-09-10T11:15:00Z"), grossKg: 41_200, tareKg: 18_900, netKg: 22_300, carrierUnitNumber: "142", scaleRecordHash: "b".repeat(64) });
    expect(sub).toMatchObject({ status: "submitted", confidence: "high" });
    const acc = await callerFor(office).portalAdmin.submissionReview({ submissionRef: sub.submissionRef, decision: "accepted", reason: "Ticket matches Load 4 by unit and time" });
    const [t] = await pool.execute<mysql.RowDataPacket[]>("SELECT verificationStatus, source, confidence, netKg, evidenceRefs FROM disposalTickets WHERE ticketNumber = ?", [acc.resultRef]);
    expect(t[0]).toMatchObject({ verificationStatus: "needs_review", source: "facility_portal", confidence: "high", netKg: 22_300 });
    expect(JSON.parse(t[0].evidenceRefs).scaleRecordHash).toBe("b".repeat(64));
    const st = await portalCaller(invToken).portal.facilityStatement();
    expect(st.tickets[0]).toMatchObject({ facilityTicketNumber: "F-88192", verificationStatus: "needs_review" });
  });
});
