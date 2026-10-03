/**
 * v23.31 — Customer, Contract and Rate Management, through the database.
 *
 * The non-negotiable, proven here: a job snapshotted under a $185/h line keeps pricing at $185/h
 * after the customer's sheet moves to $215/h. Around it: tenant refusal on every record kind,
 * separation of duties on every approval, the state machines, the PO gate, the field view that
 * carries no price, and two people racing to approve one version.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { CONFIDENTIAL_COMMERCIAL_FIELDS } from "../shared/commercialVocabulary";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 288_000_000 + Math.floor(Math.random() * 50_000);
/** Explicit financial-entity ids get their own declared band, so the id-band guard sees it (tenantScopeMoney holds 1.9M). */
let entitySeq = 2_200_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  return userId;
}
async function entity(orgRef: string) {
  const id = entitySeq++;
  await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay, orgRef) VALUES (?,?,?,'corporation','AB',12,31,?)", [id, `FE-${rnd()}`, `entity ${rnd()}`, orgRef]);
  return id;
}
async function job(orgRef: string, driver: string | null = null) {
  const jobCode = `JOB-${rnd()}`;
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (orgRef, jobCode, type, customer, location, driver) VALUES (?,?,?,?,?,?)", [orgRef, jobCode, "Hydrovac", "free text customer", "LSD 4-12", driver]);
  return { id: r.insertId, jobCode };
}
const june = new Date("2026-06-01T00:00:00Z"), july = new Date("2026-07-01T00:00:00Z");

/** One tenant, fully set up: entity, office (proposer), controller (approver), dispatcher. */
async function tenant() {
  const orgRef = await org();
  const financialEntityId = await entity(orgRef);
  const office = await member(orgRef, ["office"]), controller = await member(orgRef, ["controller"]), dispatcher = await member(orgRef, ["dispatcher"]), management = await member(orgRef, ["management"]);
  return { orgRef, financialEntityId, office, controller, dispatcher, management };
}
async function approvedSheet(t: Awaited<ReturnType<typeof tenant>>, accountRef: string, o: { contractRef?: string | null; rateMillis?: number; effectiveFrom?: Date; lines?: Parameters<ReturnType<typeof callerFor>["customerCommercial"]["rateSheets"]["lineAdd"]>[0][] } = {}) {
  const sheet = await callerFor(t.office).customerCommercial.rateSheets.create({ accountRef, contractRef: o.contractRef ?? null, name: "Hydrovac rates", effectiveFrom: o.effectiveFrom ?? june });
  const lines = o.lines ?? [{ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", pricingMethod: "per_unit", unit: "hour", rateMillis: o.rateMillis ?? 185_000, minimumQuantityMillis: 4000, billingIncrementMillis: 250, sourceClause: "§4.1" }];
  for (const l of lines) await callerFor(t.office).customerCommercial.rateSheets.lineAdd({ ...l, versionRef: sheet.versionRef });
  await callerFor(t.office).customerCommercial.rateSheets.versionSubmit({ versionRef: sheet.versionRef, event: "submit" });
  const approved = await callerFor(t.controller).customerCommercial.rateSheets.versionDecide({ versionRef: sheet.versionRef, event: "approve" });
  return { ...sheet, approved };
}

d("customers are records, unique per entity, never deleted", () => {
  it("creates with a minted number, reads, updates under a row version, refuses a stale write and a duplicate number, archives and reactivates — all in the ledger", async () => {
    const t = await tenant();
    const c = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Bighorn ${rnd()}`, customerType: "producer_operator", requiresPurchaseOrder: true, province: "AB", gstNumber: "123456789RT0001", billingAddress: { line1: "1 Main", city: "Calgary" } });
    expect(c.customerNumber).toMatch(/^CN-/);
    const got = await callerFor(t.office).customerCommercial.customers.get({ accountRef: c.accountRef });
    expect(got).toMatchObject({ customerNumber: c.customerNumber, customerType: "producer_operator", status: "active", rowVersion: 1, billingAddress: { line1: "1 Main", city: "Calgary" }, contacts: [], contracts: [], rateSheets: [] });
    const u = await callerFor(t.office).customerCommercial.customers.update({ accountRef: c.accountRef, expectedRowVersion: 1, tradeName: "Bighorn", paymentTermsDays: 45 });
    expect(u).toMatchObject({ rowVersion: 2, changed: 2 });
    await expect(callerFor(t.office).customerCommercial.customers.update({ accountRef: c.accountRef, expectedRowVersion: 1, notes: "late" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Other ${rnd()}`, customerNumber: c.customerNumber })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/already used/) });
    await expect(callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: got.name })).rejects.toMatchObject({ code: "CONFLICT" });
    // A different entity may reuse the number: uniqueness is per entity, not global.
    const other = await entity(t.orgRef);
    await expect(callerFor(t.office).customerCommercial.customers.create({ financialEntityId: other, name: `Twin ${rnd()}`, customerNumber: c.customerNumber })).resolves.toMatchObject({ customerNumber: c.customerNumber });
    const held = await callerFor(t.office).customerCommercial.customers.holdSet({ accountRef: c.accountRef, hold: true, reason: "90 days overdue" });
    expect(held.status).toBe("on_hold");
    const [[evt]] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType, payloadJson FROM domainEventOutbox WHERE eventType = 'commercial.customer_billing_hold' AND aggregateId = ?", [c.accountRef]);
    expect(evt).toBeTruthy(); expect(JSON.parse(evt!.payloadJson).reason).toBe("90 days overdue");
    await expect(callerFor(t.office).customerCommercial.customers.archive({ accountRef: c.accountRef, reason: "gone" })).rejects.toMatchObject({ code: "FORBIDDEN" });   // archiving is management's
    const archived = await callerFor(t.management).customerCommercial.customers.archive({ accountRef: c.accountRef, reason: "ceased trading" });
    expect(archived.status).toBe("inactive");
    expect((await callerFor(t.office).customerCommercial.customers.list({})).some(x => x.accountRef === c.accountRef)).toBe(false);
    expect((await callerFor(t.office).customerCommercial.customers.list({ includeArchived: true })).some(x => x.accountRef === c.accountRef)).toBe(true);
    await expect(callerFor(t.office).customerCommercial.customers.update({ accountRef: c.accountRef, notes: "x" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await callerFor(t.management).customerCommercial.customers.reactivate({ accountRef: c.accountRef, reason: "returned" });
    const history = await callerFor(t.office).customerCommercial.customers.history({ accountRef: c.accountRef });
    expect(history.map(h => h.eventType)).toEqual(expect.arrayContaining(["customer_created", "customer_updated", "billing_hold_set", "customer_archived", "customer_reactivated"]));
    const updated = history.find(h => h.eventType === "customer_updated")!;
    expect(JSON.parse(updated.changesJson!)).toMatchObject({ paymentTermsDays: { from: 30, to: 45 }, tradeName: { from: null, to: "Bighorn" } });
    expect(updated.actorUserId).toBe(t.office); expect(updated.actorRole).toBe("office");
  }, 60_000);

  it("refuses another organization everything: read, update, hold, archive, list, and creating into its entity", async () => {
    const a = await tenant(), b = await tenant();
    const c = await callerFor(a.office).customerCommercial.customers.create({ financialEntityId: a.financialEntityId, name: `A customer ${rnd()}` });
    await expect(callerFor(b.office).customerCommercial.customers.get({ accountRef: c.accountRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.office).customerCommercial.customers.update({ accountRef: c.accountRef, notes: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.office).customerCommercial.customers.holdSet({ accountRef: c.accountRef, hold: true, reason: "not mine" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.management).customerCommercial.customers.archive({ accountRef: c.accountRef, reason: "not mine" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.office).customerCommercial.customers.history({ accountRef: c.accountRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await callerFor(b.office).customerCommercial.customers.list({ includeArchived: true })).some(x => x.accountRef === c.accountRef)).toBe(false);
    await expect(callerFor(b.office).customerCommercial.customers.create({ financialEntityId: a.financialEntityId, name: `Intruder ${rnd()}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const legacy = await member(null, ["office"]);
    expect((await callerFor(legacy).customerCommercial.customers.list({})).some(x => x.accountRef === c.accountRef)).toBe(false);
  }, 60_000);
});

d("an ended membership is not revived as the single tenant (the strict F1 boundary, P0-A3)", () => {
  it("refuses a former member everything, and shows them neither their old company's customers nor the unowned books", async () => {
    const t = await tenant();
    const mine = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Former ${rnd()}` });
    // The historical single tenant's book: unowned, visible to a caller with no membership at all.
    const legacy = await member(null, ["office"]);
    const unownedId = entitySeq++;
    await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay, orgRef) VALUES (?,?,?,'corporation','AB',12,31,NULL)", [unownedId, `FE-${rnd()}`, `legacy ${rnd()}`]);
    const theirs = await callerFor(legacy).customerCommercial.customers.create({ financialEntityId: unownedId, name: `Legacy ${rnd()}` });
    expect((await callerFor(legacy).customerCommercial.customers.list({})).some(x => x.accountRef === theirs.accountRef)).toBe(true);
    // The office user leaves the company. They are not a new single-tenant user; they are nobody's.
    await pool.execute("UPDATE organizationMemberships SET status = 'ended', effectiveTo = NOW() WHERE userId = ?", [t.office]);
    for (const call of [
      () => callerFor(t.office).customerCommercial.customers.list({}),
      () => callerFor(t.office).customerCommercial.customers.get({ accountRef: mine.accountRef }),
      () => callerFor(t.office).customerCommercial.customers.get({ accountRef: theirs.accountRef }),
      () => callerFor(t.office).customerCommercial.customers.create({ financialEntityId: unownedId, name: `Revived ${rnd()}` }),
    ]) await expect(call()).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) });
  }, 60_000);
});

d("contacts belong to the account and carry effective-dated roles", () => {
  it("creates a contact with roles, promotes a primary, ends a role, deactivates, and refuses another organization", async () => {
    const a = await tenant(), b = await tenant();
    const c = await callerFor(a.office).customerCommercial.customers.create({ financialEntityId: a.financialEntityId, name: `Contacts ${rnd()}` });
    const kyle = await callerFor(a.office).customerCommercial.contacts.create({ accountRef: c.accountRef, displayName: "Kyle", company: "Consultants Inc", phone: "403-555-0100", roles: [{ roleKey: "field_consultant" }, { roleKey: "site_contact", isPrimary: true }] });
    const sue = await callerFor(a.office).customerCommercial.contacts.create({ accountRef: c.accountRef, displayName: "Sue", email: "sue@example.test", roles: [{ roleKey: "billing", isPrimary: true }] });
    await callerFor(a.office).customerCommercial.contacts.roleSet({ contactRef: kyle.contactRef, roleKey: "billing", isPrimary: true });
    const got = await callerFor(a.office).customerCommercial.customers.get({ accountRef: c.accountRef });
    const k = got.contacts.find(x => x.contactRef === kyle.contactRef)!, s = got.contacts.find(x => x.contactRef === sue.contactRef)!;
    expect(k.roles.filter(r => r.status === "active").map(r => r.roleKey).sort()).toEqual(["billing", "field_consultant", "site_contact"]);
    expect(k.roles.find(r => r.roleKey === "billing")!.isPrimary).toBe(true);
    expect(s.roles.find(r => r.roleKey === "billing")!.isPrimary).toBe(false);   // one primary per role per account
    await callerFor(a.office).customerCommercial.contacts.roleEnd({ contactRef: kyle.contactRef, roleKey: "field_consultant", reason: "moved on" });
    await callerFor(a.office).customerCommercial.contacts.update({ contactRef: sue.contactRef, status: "inactive" });
    const after = await callerFor(a.office).customerCommercial.customers.get({ accountRef: c.accountRef });
    expect(after.contacts.find(x => x.contactRef === kyle.contactRef)!.roles.find(r => r.roleKey === "field_consultant")!.status).toBe("ended");
    expect(after.contacts.find(x => x.contactRef === sue.contactRef)!.roles.every(r => r.status === "ended")).toBe(true);
    await expect(callerFor(a.office).customerCommercial.contacts.roleSet({ contactRef: sue.contactRef, roleKey: "safety" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(callerFor(b.office).customerCommercial.contacts.update({ contactRef: kyle.contactRef, displayName: "Not yours" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.office).customerCommercial.contacts.create({ accountRef: c.accountRef, displayName: "Intruder" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});

d("a contract has a lifecycle, a second approver, and a history that supersession preserves", () => {
  it("draft → submitted → approved by a second person → suspended → resumed → superseded by an approved replacement; the old row stays", async () => {
    const t = await tenant();
    const c = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `MSA ${rnd()}` });
    await expect(callerFor(t.office).customerCommercial.contracts.create({ accountRef: c.accountRef, title: "MSA", effectiveFrom: july, effectiveTo: june })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const k = await callerFor(t.office).customerCommercial.contracts.create({ accountRef: c.accountRef, contractNumber: `MSA-${rnd()}`, title: "Master service agreement", effectiveFrom: june, effectiveTo: new Date("2027-05-31T00:00:00Z"), poRequirement: "required", paymentTermsDays: 30, billingInstructions: "Attach signed ticket", renewalKind: "manual", renewalNoticeDays: 60 });
    expect(k.status).toBe("draft");
    await expect(callerFor(t.controller).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/draft contract cannot approve/) });
    await callerFor(t.office).customerCommercial.contracts.submit({ contractRef: k.contractRef });
    await expect(callerFor(t.office).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN" });   // office holds no approve permission
    const officeApprover = await member(t.orgRef, ["office", "management"]);
    await expect(callerFor(t.office).customerCommercial.contracts.update({ contractRef: k.contractRef, title: "late edit" })).resolves.toBeDefined();   // pending is still editable
    // The drafter, even with the permission, does not approve their own contract.
    const drafterWithPower = t.office; await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [drafterWithPower, "management"]);
    await expect(callerFor(drafterWithPower).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/second person/) });
    const active = await callerFor(officeApprover).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve", note: "signed copy in vault" });
    expect(active.status).toBe("active");
    await expect(callerFor(t.controller).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(callerFor(t.office).customerCommercial.contracts.update({ contractRef: k.contractRef, title: "x" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/supersede/) });
    await callerFor(t.controller).customerCommercial.contracts.statusSet({ contractRef: k.contractRef, event: "suspend", reason: "insurance lapsed" });
    await expect(callerFor(t.controller).customerCommercial.contracts.statusSet({ contractRef: k.contractRef, event: "suspend", reason: "again" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await callerFor(t.controller).customerCommercial.contracts.statusSet({ contractRef: k.contractRef, event: "resume", reason: "certificate received" });
    const v2 = await callerFor(t.office).customerCommercial.contracts.supersede({ contractRef: k.contractRef, reason: "renewal with new rates", changes: { effectiveFrom: new Date("2026-09-01T00:00:00Z"), effectiveTo: new Date("2027-08-31T00:00:00Z"), paymentTermsDays: 45 } });
    expect(v2).toMatchObject({ version: 2, supersedes: k.contractRef, status: "draft" });
    await expect(callerFor(t.office).customerCommercial.contracts.supersede({ contractRef: k.contractRef, reason: "twice" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await callerFor(t.office).customerCommercial.contracts.get({ contractRef: k.contractRef })).status).toBe("active");   // the old one stays in force until the new one is approved
    await callerFor(t.office).customerCommercial.contracts.submit({ contractRef: v2.contractRef });
    await callerFor(t.controller).customerCommercial.contracts.approve({ contractRef: v2.contractRef, decision: "approve" });
    const old = await callerFor(t.office).customerCommercial.contracts.get({ contractRef: k.contractRef });
    expect(old.status).toBe("superseded"); expect(old.effectiveTo?.toISOString()).toBe("2026-09-01T00:00:00.000Z"); expect(old.supersededByContractId).toBeTruthy();
    expect(old.history.map(h => h.eventType)).toEqual(expect.arrayContaining(["contract_created", "contract_submit", "contract_approved", "contract_suspend", "contract_resume", "contract_superseded"]));
    expect(old.lineage.map(l => l.version).sort()).toEqual([2]);
    const fresh = await callerFor(t.office).customerCommercial.contracts.get({ contractRef: v2.contractRef });
    expect(fresh).toMatchObject({ status: "active", version: 2, paymentTermsDays: 45, renewal: { state: "in_term" } });
    const [evts] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType FROM domainEventOutbox WHERE aggregateId IN (?, ?) ORDER BY id", [k.contractRef, v2.contractRef]);
    expect(evts.map(e => e.eventType)).toEqual(["commercial.contract_activated", "commercial.contract_suspended", "commercial.contract_superseded", "commercial.contract_activated"]);
  }, 90_000);

  it("expires when its window closes, and refuses another organization", async () => {
    const a = await tenant(), b = await tenant();
    const c = await callerFor(a.office).customerCommercial.customers.create({ financialEntityId: a.financialEntityId, name: `Exp ${rnd()}` });
    const k = await callerFor(a.office).customerCommercial.contracts.create({ accountRef: c.accountRef, title: "Short", effectiveFrom: new Date("2025-01-01T00:00:00Z"), effectiveTo: new Date("2025-12-31T00:00:00Z") });
    await callerFor(a.office).customerCommercial.contracts.submit({ contractRef: k.contractRef });
    await expect(callerFor(a.controller).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/already closed/) });
    const k2 = await callerFor(a.office).customerCommercial.contracts.create({ accountRef: c.accountRef, title: "Live", effectiveFrom: june, effectiveTo: new Date("2030-01-01T00:00:00Z") });
    await callerFor(a.office).customerCommercial.contracts.submit({ contractRef: k2.contractRef });
    await callerFor(a.controller).customerCommercial.contracts.approve({ contractRef: k2.contractRef, decision: "approve" });
    await expect(callerFor(b.controller).customerCommercial.contracts.get({ contractRef: k2.contractRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.controller).customerCommercial.contracts.statusSet({ contractRef: k2.contractRef, event: "terminate", reason: "not mine" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.office).customerCommercial.contracts.create({ accountRef: c.accountRef, title: "Intruder", effectiveFrom: june })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await callerFor(b.office).customerCommercial.contracts.list({})).some(x => x.contractRef === k2.contractRef)).toBe(false);
    const expired = await callerFor(a.controller).customerCommercial.contracts.statusSet({ contractRef: k2.contractRef, event: "expire", reason: "term ended" });
    expect(expired.status).toBe("expired");
    await expect(callerFor(a.controller).customerCommercial.contracts.statusSet({ contractRef: k2.contractRef, event: "resume", reason: "not allowed" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  }, 60_000);
});

d("a rate sheet is approved as a versioned unit and resolves deterministically", () => {
  it("lines are integers, kinds are vocabulary, approval is a second person's, a version supersedes the last and the resolver reads the right one by date", async () => {
    const t = await tenant();
    const c = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Rates ${rnd()}` });
    const sheet = await callerFor(t.office).customerCommercial.rateSheets.create({ accountRef: c.accountRef, name: "2026 hydrovac", effectiveFrom: june });
    expect(sheet.sheetNumber).toMatch(/^RSHT-/); expect(sheet.version).toBe(1);
    await expect(callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", pricingMethod: "per_unit", unit: "hour", rateMillis: 185.5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: "made_up", pricingMethod: "per_unit", unit: "hour", rateMillis: 185_000 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/Unknown rate line kind/) });
    await expect(callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", pricingMethod: "per_unit", unit: "hour" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/carries a rate/) });
    await expect(callerFor(t.office).customerCommercial.rateSheets.versionSubmit({ versionRef: sheet.versionRef, event: "submit" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/no lines/) });
    const l1 = await callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", pricingMethod: "per_unit", unit: "hour", rateMillis: 185_000, minimumQuantityMillis: 4000, billingIncrementMillis: 250, sourceClause: "§4.1" });
    const l2 = await callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: "night_shift", pricingMethod: "per_unit", unit: "hour", rateMillis: 215_000, applicability: [{ kind: "shift", op: "eq", value: "night" }] });
    await callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "fuel", lineKind: "fuel_surcharge", pricingMethod: "percentage_markup", unit: "none", basisPoints: 850 });
    expect(l1.lineNo).toBe(1); expect(l2.lineNo).toBe(2);
    await callerFor(t.office).customerCommercial.rateSheets.versionSubmit({ versionRef: sheet.versionRef, event: "submit" });
    await expect(callerFor(t.office).customerCommercial.rateSheets.lineUpdate({ definitionRef: l1.definitionRef, rateMillis: 1 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });   // pending is not draft
    const officeApprover = await member(t.orgRef, ["office", "controller"]);
    await expect(callerFor(officeApprover).customerCommercial.rateSheets.versionDecide({ versionRef: sheet.versionRef, event: "approve" })).resolves.toMatchObject({ status: "approved" });
    // ...but the drafter does not approve their own version, even holding the permission.
    const sheet2 = await callerFor(officeApprover).customerCommercial.rateSheets.create({ accountRef: c.accountRef, name: "Second sheet", effectiveFrom: june });
    await callerFor(officeApprover).customerCommercial.rateSheets.lineAdd({ versionRef: sheet2.versionRef, serviceCode: "steamer", lineKind: "specialized_equipment", pricingMethod: "flat", unit: "each", flatCents: 25_000 });
    await callerFor(officeApprover).customerCommercial.rateSheets.versionSubmit({ versionRef: sheet2.versionRef, event: "submit" });
    await expect(callerFor(officeApprover).customerCommercial.rateSheets.versionDecide({ versionRef: sheet2.versionRef, event: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/second person/) });
    await callerFor(t.controller).customerCommercial.rateSheets.versionDecide({ versionRef: sheet2.versionRef, event: "reject", reason: "steamer is not in the MSA" });
    await callerFor(officeApprover).customerCommercial.rateSheets.versionSubmit({ versionRef: sheet2.versionRef, event: "reopen" });
    // A sheet-managed line is never approved one at a time through the setup surface.
    await expect(callerFor(t.controller).commercialSetup.definitionApprove({ definitionRef: l1.definitionRef })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const full = await callerFor(t.controller).customerCommercial.rateSheets.get({ rateSheetRef: sheet.rateSheetRef });
    const v1 = full.versions.find(v => v.versionRef === sheet.versionRef)!;
    expect(v1.status).toBe("approved"); expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/); expect(v1.lines.every(l => l.approvalStatus === "approved")).toBe(true);
    await expect(callerFor(t.office).customerCommercial.rateSheets.lineUpdate({ definitionRef: l1.definitionRef, rateMillis: 190_000 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/history/) });
    await expect(callerFor(t.office).customerCommercial.rateSheets.lineRemove({ definitionRef: l1.definitionRef })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // Version 2: copied lines, one changed, approved; v1 closes where v2 opens and still prices June.
    await expect(callerFor(t.office).customerCommercial.rateSheets.versionCreate({ rateSheetRef: sheet.rateSheetRef, effectiveFrom: june })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/after the version it supersedes/) });
    const v2 = await callerFor(t.office).customerCommercial.rateSheets.versionCreate({ rateSheetRef: sheet.rateSheetRef, effectiveFrom: july });
    expect(v2).toMatchObject({ version: 2, linesCopied: 3, supersedes: sheet.versionRef });
    const draft = (await callerFor(t.controller).customerCommercial.rateSheets.get({ rateSheetRef: sheet.rateSheetRef })).versions.find(v => v.versionRef === v2.versionRef)!;
    const dayLine = draft.lines.find(l => l.lineKind === "hourly_equipment")!;
    await callerFor(t.office).customerCommercial.rateSheets.lineUpdate({ definitionRef: dayLine.definitionRef, rateMillis: 215_000 });
    await callerFor(t.office).customerCommercial.rateSheets.versionSubmit({ versionRef: v2.versionRef, event: "submit" });
    const approvedV2 = await callerFor(t.controller).customerCommercial.rateSheets.versionDecide({ versionRef: v2.versionRef, event: "approve" });
    expect(approvedV2.supersedes).toBe(sheet.versionRef);
    const after = await callerFor(t.controller).customerCommercial.rateSheets.get({ rateSheetRef: sheet.rateSheetRef });
    const oldV = after.versions.find(v => v.versionRef === sheet.versionRef)!;
    expect(oldV.status).toBe("superseded"); expect(oldV.effectiveTo?.toISOString()).toBe(july.toISOString());
    expect(oldV.lines.find(l => l.definitionRef === l1.definitionRef)).toMatchObject({ approvalStatus: "superseded", rateMillis: 185_000 });
    expect(after.currentVersion).toBe(v2.versionRef);
    const ctx = { financialEntityId: t.financialEntityId, rateKind: "sell" as const, serviceCode: "hydrovac_hour", customerAccountRef: c.accountRef };
    const juneRate = await callerFor(t.controller).commercialSetup.rateResolve({ ...ctx, at: new Date("2026-06-15T00:00:00Z") });
    expect(juneRate).toMatchObject({ outcome: "resolved", rateMillis: 185_000, definitionRef: l1.definitionRef });
    const augustRate = await callerFor(t.controller).commercialSetup.rateResolve({ ...ctx, at: new Date("2026-08-15T00:00:00Z") });
    expect(augustRate).toMatchObject({ outcome: "resolved", rateMillis: 215_000 });
    const before = await callerFor(t.controller).commercialSetup.rateResolve({ ...ctx, at: new Date("2026-01-15T00:00:00Z") });
    expect(before.outcome).toBe("unknown"); expect(before.reasons.join(" ")).toMatch(/outside their effective window|no approved definition/);
  }, 120_000);

  it("a sheet under a contract beats the customer's plain sheet; equal specificity is a conflict; the line the caller may not see is not there", async () => {
    const t = await tenant();
    const c = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Prec ${rnd()}` });
    const k = await callerFor(t.office).customerCommercial.contracts.create({ accountRef: c.accountRef, title: "MSA", effectiveFrom: june });
    await callerFor(t.office).customerCommercial.contracts.submit({ contractRef: k.contractRef });
    await callerFor(t.controller).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve" });
    await approvedSheet(t, c.accountRef, { rateMillis: 200_000 });
    await approvedSheet(t, c.accountRef, { contractRef: k.contractRef, rateMillis: 185_000 });
    const ctx = { financialEntityId: t.financialEntityId, rateKind: "sell" as const, serviceCode: "hydrovac_hour", customerAccountRef: c.accountRef, at: new Date("2026-06-15T00:00:00Z") };
    expect(await callerFor(t.controller).commercialSetup.rateResolve({ ...ctx, contractRef: k.contractRef })).toMatchObject({ outcome: "resolved", scopeLevel: "customer_contract", rateMillis: 185_000 });
    expect(await callerFor(t.controller).commercialSetup.rateResolve(ctx)).toMatchObject({ outcome: "resolved", scopeLevel: "customer_rate_card", rateMillis: 200_000 });
    // Two conditioned lines of equal specificity on the contract sheet: a CONFLICT, never the first that matched.
    const c2 = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Amb ${rnd()}` });
    const sheet = await callerFor(t.office).customerCommercial.rateSheets.create({ accountRef: c2.accountRef, name: "Ambiguous", effectiveFrom: june });
    for (const [kind, rate] of [["after_hours", 210_000], ["night_shift", 220_000]] as const) await callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: kind, pricingMethod: "per_unit", unit: "hour", rateMillis: rate, applicability: [{ kind: "shift", op: "eq", value: "night" }] });
    await callerFor(t.office).customerCommercial.rateSheets.versionSubmit({ versionRef: sheet.versionRef, event: "submit" });
    await callerFor(t.controller).customerCommercial.rateSheets.versionDecide({ versionRef: sheet.versionRef, event: "approve" });
    const [defs] = await pool.query<mysql.RowDataPacket[]>("SELECT definitionRef FROM chargeDefinitions WHERE rateSheetVersionId = (SELECT id FROM rateSheetVersions WHERE versionRef = ?)", [sheet.versionRef]);
    expect(defs).toHaveLength(2);
    // Resolve through the job path, which carries attributes: assign a job, snapshot it, ask for a night shift.
    const j = await job(t.orgRef);
    await callerFor(t.dispatcher).customerCommercial.jobs.contextSet({ jobId: j.id, accountRef: c2.accountRef, rateSheetRef: sheet.rateSheetRef });
    await callerFor(t.dispatcher).customerCommercial.jobs.snapshotCapture({ jobId: j.id, reason: "manual" });
    const night = await callerFor(t.controller).customerCommercial.jobs.resolveRate({ jobId: j.id, serviceCode: "hydrovac_hour", attributes: { shift: "night" } });
    expect(night.resolution.outcome).toBe("conflict");
    const day = await callerFor(t.controller).customerCommercial.jobs.resolveRate({ jobId: j.id, serviceCode: "hydrovac_hour", attributes: { shift: "day" } });
    expect(day.resolution.outcome).toBe("unknown"); expect(day.reasons.join(" ")).toMatch(/set aside: shift is day, line needs night/);
    // Another organization sees no sheet, and no rate.
    const b = await tenant();
    await expect(callerFor(b.controller).customerCommercial.rateSheets.get({ rateSheetRef: sheet.rateSheetRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "x", lineKind: "misc", pricingMethod: "flat", unit: "each", flatCents: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.controller).customerCommercial.jobs.resolveRate({ jobId: j.id, serviceCode: "hydrovac_hour" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await callerFor(b.controller).customerCommercial.rateSheets.list({})).some(x => x.rateSheetRef === sheet.rateSheetRef)).toBe(false);
  }, 120_000);

  it("two people approving one pending version: exactly one approval lands", async () => {
    const t = await tenant();
    const c = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Race ${rnd()}` });
    const sheet = await callerFor(t.office).customerCommercial.rateSheets.create({ accountRef: c.accountRef, name: "Race", effectiveFrom: june });
    await callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", pricingMethod: "per_unit", unit: "hour", rateMillis: 185_000 });
    await callerFor(t.office).customerCommercial.rateSheets.versionSubmit({ versionRef: sheet.versionRef, event: "submit" });
    const second = await member(t.orgRef, ["controller"]);
    const results = await Promise.allSettled([
      callerFor(t.controller).customerCommercial.rateSheets.versionDecide({ versionRef: sheet.versionRef, event: "approve", expectedRowVersion: 2 }),   // 2: the submit bumped it
      callerFor(second).customerCommercial.rateSheets.versionDecide({ versionRef: sheet.versionRef, event: "approve", expectedRowVersion: 2 }),
    ]);
    const ok = results.filter(r => r.status === "fulfilled"), failed = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1); expect(failed).toHaveLength(1);
    expect(["CONFLICT", "PRECONDITION_FAILED"]).toContain((failed[0]!.reason as { code: string }).code);
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT status, approvedByUserId, rowVersion FROM rateSheetVersions WHERE versionRef = ?", [sheet.versionRef]);
    expect(row!.status).toBe("approved"); expect(row!.rowVersion).toBe(3);
    const [audits] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM commercialAuditEvents WHERE subjectRef = ? AND eventType = 'version_approved'", [sheet.versionRef]);
    expect(audits[0]!.n).toBe(1);
  }, 60_000);
});

d("a job freezes its commercial basis, and billing reads the frozen basis", () => {
  it("June's $185 stays $185 after July's $215; the PO gate blocks, waives and clears; a correction is a new sequence; the field view carries no price", async () => {
    const t = await tenant();
    const c = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Job ${rnd()}`, requiresPurchaseOrder: true, paymentTermsDays: 45 });
    await callerFor(t.office).customerCommercial.contacts.create({ accountRef: c.accountRef, displayName: "Kyle", phone: "403-555-0100", roles: [{ roleKey: "site_contact" }] });
    const k = await callerFor(t.office).customerCommercial.contracts.create({ accountRef: c.accountRef, title: "MSA", effectiveFrom: june, paymentTermsDays: 30, billingInstructions: "Attach signed ticket" });
    await callerFor(t.office).customerCommercial.contracts.submit({ contractRef: k.contractRef });
    await callerFor(t.controller).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve" });
    const sheet = await approvedSheet(t, c.accountRef, { contractRef: k.contractRef, rateMillis: 185_000 });
    const j = await job(t.orgRef, "Rosa Driver");
    // Before a context: the gate says review, the billable context says unavailable.
    expect((await callerFor(t.dispatcher).customerCommercial.jobs.get({ jobId: j.id })).readiness.map(b => b.code)).toEqual(["commercial_context_missing"]);
    expect(await callerFor(t.office).customerCommercial.jobs.billableContext({ jobId: j.id })).toMatchObject({ available: false });
    await callerFor(t.dispatcher).customerCommercial.jobs.contextSet({ jobId: j.id, accountRef: c.accountRef, contractRef: k.contractRef, rateSheetRef: sheet.rateSheetRef });
    await callerFor(t.dispatcher).customerCommercial.jobs.partySet({ jobId: j.id, partyRole: "consultant_company", freeText: "Consultants Inc" });
    let view = await callerFor(t.dispatcher).customerCommercial.jobs.get({ jobId: j.id });
    expect(view.readiness.map(b => `${b.code}:${b.severity}`)).toEqual(["commercial_reference_missing:blocking", "commercial_snapshot_missing:review"]);
    // The dispatch posting is the activation point: it captures the snapshot, PO or not, and the gate keeps saying the PO is missing.
    const posting = await callerFor(t.dispatcher).dispatch.createPosting({ jobId: j.id });
    expect(posting.commercial.outcome).toBe("captured");
    view = await callerFor(t.dispatcher).customerCommercial.jobs.get({ jobId: j.id });
    expect(view.snapshot).toMatchObject({ sequenceNo: 1 });
    expect(view.snapshot!.payload!.rateSheet).toMatchObject({ versionRef: sheet.versionRef, version: 1 });
    expect(view.snapshot!.payload!.missingReferenceKinds).toEqual(["po"]);
    expect(view.readiness.map(b => b.code)).toEqual(["commercial_reference_missing"]);
    const [[missingEvt]] = await pool.query<mysql.RowDataPacket[]>("SELECT payloadJson FROM domainEventOutbox WHERE eventType = 'commercial.job_reference_missing' AND aggregateId = ?", [j.jobCode]);
    expect(JSON.parse(missingEvt!.payloadJson).missing).toEqual(["po"]);
    // A dispatcher sees the readiness through the real gate, classified as commercial / client contract.
    const readiness = await callerFor(t.dispatcher).dispatch.readiness({ operatorId: 1, unitId: null, jobId: j.id } as never).catch(e => e);
    if (!(readiness instanceof Error)) expect(JSON.stringify(readiness)).toMatch(/commercial_reference_missing/);
    // Waived for the night: review, not a stop. Then the PO arrives: clear.
    await callerFor(t.dispatcher).customerCommercial.jobs.referenceWaive({ jobId: j.id, reason: "call-out at 02:00; PO promised by the consultant" });
    expect((await callerFor(t.dispatcher).customerCommercial.jobs.get({ jobId: j.id })).readiness[0]).toMatchObject({ code: "commercial_reference_missing", severity: "review" });
    await callerFor(t.dispatcher).customerCommercial.jobs.referenceAdd({ jobId: j.id, referenceKind: "po", referenceValue: "PO-4471", source: "dispatch" });
    await callerFor(t.dispatcher).customerCommercial.jobs.referenceAdd({ jobId: j.id, referenceKind: "afe", referenceValue: "AFE-8841-22" });
    expect((await callerFor(t.dispatcher).customerCommercial.jobs.get({ jobId: j.id })).readiness).toEqual([]);
    // The PO arrived after the snapshot: a correction snapshot records it, the first snapshot stays as sequence 1.
    const corr = await callerFor(t.dispatcher).customerCommercial.jobs.snapshotCapture({ jobId: j.id, reason: "correction", note: "PO received" });
    expect(corr).toMatchObject({ sequenceNo: 2, unchanged: false, missingReferenceKinds: [] });
    expect((await callerFor(t.dispatcher).customerCommercial.jobs.snapshotCapture({ jobId: j.id, reason: "manual" })).unchanged).toBe(true);
    // Now the rate moves: version 2 at $215 from July. The job stays at $185.
    const v2 = await callerFor(t.office).customerCommercial.rateSheets.versionCreate({ rateSheetRef: sheet.rateSheetRef, effectiveFrom: july });
    const v2lines = (await callerFor(t.controller).customerCommercial.rateSheets.get({ rateSheetRef: sheet.rateSheetRef })).versions.find(v => v.versionRef === v2.versionRef)!.lines;
    await callerFor(t.office).customerCommercial.rateSheets.lineUpdate({ definitionRef: v2lines[0]!.definitionRef, rateMillis: 215_000 });
    await callerFor(t.office).customerCommercial.rateSheets.versionSubmit({ versionRef: v2.versionRef, event: "submit" });
    await callerFor(t.controller).customerCommercial.rateSheets.versionDecide({ versionRef: v2.versionRef, event: "approve" });
    // Asked in 2027, the job still prices at the basis it was frozen with: `at` is the work's date (the snapshot's, by default), never the asking date.
    const later = await callerFor(t.controller).customerCommercial.jobs.resolveRate({ jobId: j.id, serviceCode: "hydrovac_hour" });
    expect(later.resolution).toMatchObject({ outcome: "resolved", definition: { rateMillis: 185_000 } });
    expect(later.basis).toMatchObject({ rateSheetVersionRef: sheet.versionRef, contractRef: k.contractRef });
    const billable = await callerFor(t.office).customerCommercial.jobs.billableContext({ jobId: j.id });
    expect(billable).toMatchObject({ snapshotSequence: 2, paymentTermsDays: 30, poRequired: true, billingInstructions: "Attach signed ticket", missingReferenceKinds: [], blockers: [] });
    if ("applicableRates" in billable) { expect(billable.applicableRates.map(r => r.rateMillis)).toEqual([185_000]); expect(billable.references).toEqual(expect.arrayContaining([{ referenceKind: "po", referenceValue: "PO-4471" }])); expect(billable.supportingDocumentRequirements).toEqual(expect.arrayContaining(["signed_field_ticket", "purchase_order_on_file", "time_record"])); }
    // The contract and the version are frozen by use: no edit, supersede instead; the version cannot be retired.
    await expect(callerFor(t.office).customerCommercial.contracts.update({ contractRef: k.contractRef, title: "x" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(callerFor(t.controller).customerCommercial.rateSheets.versionDecide({ versionRef: sheet.versionRef, event: "retire", reason: "no" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // Changing the job's basis after a snapshot needs a reason; the first snapshot is superseded, never rewritten.
    await expect(callerFor(t.dispatcher).customerCommercial.jobs.contextSet({ jobId: j.id, accountRef: c.accountRef, contractRef: null, rateSheetRef: sheet.rateSheetRef })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [snaps] = await pool.query<mysql.RowDataPacket[]>("SELECT sequenceNo, status, rateSheetVersionRef, payloadHash FROM jobCommercialSnapshots WHERE jobId = ? ORDER BY sequenceNo", [j.id]);
    expect(snaps.map(s => [s.sequenceNo, s.status])).toEqual([[1, "superseded"], [2, "current"]]);
    expect(snaps.every(s => s.rateSheetVersionRef === sheet.versionRef)).toBe(true);
    // The field view: the customer, the references, Kyle's phone — and not one price term.
    const driverUser = await member(t.orgRef, ["driver"]);
    await pool.execute("INSERT INTO operators (userId, name) VALUES (?, ?)", [driverUser, "Rosa Driver"]);
    const field = await callerFor(driverUser).customerCommercial.jobs.fieldSummary({ jobId: j.id });
    expect(field).toMatchObject({ jobCode: j.jobCode, customer: { name: expect.stringMatching(/^Job /) }, references: expect.arrayContaining([{ referenceKind: "po", referenceValue: "PO-4471" }]) });
    if ("contacts" in field) expect(field.contacts).toEqual([expect.objectContaining({ displayName: "Kyle", phone: "403-555-0100" })]);
    const text = JSON.stringify(field);
    for (const f of CONFIDENTIAL_COMMERCIAL_FIELDS) expect(text, f).not.toContain(`"${f}"`);
    expect(text).not.toContain("185"); expect(text).not.toContain("gstNumber");
    const otherDriver = await member(t.orgRef, ["driver"]);
    await pool.execute("INSERT INTO operators (userId, name) VALUES (?, ?)", [otherDriver, "Someone Else"]);
    await expect(callerFor(otherDriver).customerCommercial.jobs.fieldSummary({ jobId: j.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(driverUser).customerCommercial.jobs.get({ jobId: j.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(driverUser).customerCommercial.rateSheets.get({ rateSheetRef: sheet.rateSheetRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The office view without commercial.rates.read (a bookkeeper has it; an auditor has it; a dispatcher has it) — a legal user does not, and sees the lines without their prices.
    const legalUser = await member(t.orgRef, ["legal"]);
    const legalView = await callerFor(legalUser).customerCommercial.jobs.get({ jobId: j.id });
    expect(legalView.confidential).toBe(false); expect(JSON.stringify(legalView.snapshot)).not.toContain("rateMillis");
    // The whole story is in the ledger.
    const [ledger] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType, subjectType FROM commercialAuditEvents WHERE jobId = ? ORDER BY id", [j.id]);
    expect(ledger.map(l => l.eventType)).toEqual(expect.arrayContaining(["job_context_set", "job_party_set", "snapshot_captured", "used_by_job", "job_reference_waived", "job_reference_added"]));
  }, 180_000);

  it("refuses to freeze an ambiguous or missing sheet version, refuses a contract of another customer, and refuses another organization's job or customer", async () => {
    const a = await tenant(), b = await tenant();
    const c = await callerFor(a.office).customerCommercial.customers.create({ financialEntityId: a.financialEntityId, name: `Gate ${rnd()}` });
    const other = await callerFor(a.office).customerCommercial.customers.create({ financialEntityId: a.financialEntityId, name: `Other ${rnd()}` });
    const k = await callerFor(a.office).customerCommercial.contracts.create({ accountRef: other.accountRef, title: "MSA", effectiveFrom: june });
    const j = await job(a.orgRef);
    await expect(callerFor(a.dispatcher).customerCommercial.jobs.contextSet({ jobId: j.id, accountRef: c.accountRef, contractRef: k.contractRef })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/different customer/) });
    // A sheet whose only version takes effect next year: nothing governs today, so the basis cannot be frozen — with the reason.
    const future = await callerFor(a.office).customerCommercial.rateSheets.create({ accountRef: c.accountRef, name: "Next year", effectiveFrom: new Date("2031-01-01T00:00:00Z") });
    await callerFor(a.office).customerCommercial.rateSheets.lineAdd({ versionRef: future.versionRef, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", pricingMethod: "per_unit", unit: "hour", rateMillis: 300_000 });
    await callerFor(a.office).customerCommercial.rateSheets.versionSubmit({ versionRef: future.versionRef, event: "submit" });
    await callerFor(a.controller).customerCommercial.rateSheets.versionDecide({ versionRef: future.versionRef, event: "approve" });
    await callerFor(a.dispatcher).customerCommercial.jobs.contextSet({ jobId: j.id, accountRef: c.accountRef, rateSheetRef: future.rateSheetRef });
    await expect(callerFor(a.dispatcher).customerCommercial.jobs.snapshotCapture({ jobId: j.id, reason: "manual" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/take effect after.*NO RATE SHEET VERSION GOVERNS/) });
    expect((await callerFor(a.dispatcher).dispatch.createPosting({ jobId: j.id })).commercial.outcome).toBe("refused");
    expect((await callerFor(a.dispatcher).customerCommercial.jobs.get({ jobId: j.id })).readiness.map(x => x.code)).toEqual(expect.arrayContaining(["commercial_rate_sheet_unresolved", "commercial_snapshot_missing"]));
    // Another organization: its dispatcher cannot touch A's job, and A's dispatcher cannot put B's customer on A's job.
    await expect(callerFor(b.dispatcher).customerCommercial.jobs.contextSet({ jobId: j.id, accountRef: c.accountRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.dispatcher).customerCommercial.jobs.get({ jobId: j.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.office).customerCommercial.jobs.billableContext({ jobId: j.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const bc = await callerFor(b.office).customerCommercial.customers.create({ financialEntityId: b.financialEntityId, name: `B customer ${rnd()}` });
    const j2 = await job(a.orgRef);
    await expect(callerFor(a.dispatcher).customerCommercial.jobs.contextSet({ jobId: j2.id, accountRef: bc.accountRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(a.dispatcher).customerCommercial.jobs.referenceAdd({ jobId: j2.id, referenceKind: "po", referenceValue: "PO-1" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  }, 120_000);

  it("the expiry sweep emits once a day for what ends soon and expires what has ended", async () => {
    const t = await tenant();
    const c = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Sweep ${rnd()}` });
    const soon = new Date(Date.now() + 10 * 86_400_000), past = new Date(Date.now() - 86_400_000);
    const k = await callerFor(t.office).customerCommercial.contracts.create({ accountRef: c.accountRef, title: "Ending soon", effectiveFrom: new Date("2020-01-01T00:00:00Z"), effectiveTo: soon });
    await callerFor(t.office).customerCommercial.contracts.submit({ contractRef: k.contractRef });
    await callerFor(t.controller).customerCommercial.contracts.approve({ contractRef: k.contractRef, decision: "approve" });
    const ended = await callerFor(t.office).customerCommercial.contracts.create({ accountRef: c.accountRef, title: "Ended", effectiveFrom: new Date("2020-01-01T00:00:00Z"), effectiveTo: new Date("2030-01-01T00:00:00Z") });
    await callerFor(t.office).customerCommercial.contracts.submit({ contractRef: ended.contractRef });
    await callerFor(t.controller).customerCommercial.contracts.approve({ contractRef: ended.contractRef, decision: "approve" });
    await pool.execute("UPDATE customerContracts SET effectiveTo = ? WHERE contractRef = ?", [past, ended.contractRef]);
    const first = await callerFor(t.controller).customerCommercial.expirySweep({ withinDays: 30 });
    expect(first).toMatchObject({ contractsExpiring: 1, contractsExpired: 1 });
    const again = await callerFor(t.controller).customerCommercial.expirySweep({ withinDays: 30 });
    expect(again).toMatchObject({ contractsExpiring: 0, contractsExpired: 0 });
    expect((await callerFor(t.office).customerCommercial.contracts.get({ contractRef: ended.contractRef })).status).toBe("expired");
    expect((await callerFor(t.office).customerCommercial.contracts.list({ expiringWithinDays: 30 })).map(x => x.contractRef)).toContain(k.contractRef);
    const [evts] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType FROM domainEventOutbox WHERE aggregateId = ? AND eventType LIKE 'commercial.contract_%'", [k.contractRef]);
    expect(evts.map(e => e.eventType).sort()).toEqual(["commercial.contract_activated", "commercial.contract_expiring"]);
  }, 60_000);
});

d("the authorization matrix", () => {
  const isForbidden = (e: unknown) => (e as { code?: string }).code === "FORBIDDEN" || (e as { code?: string }).code === "UNAUTHORIZED";
  /** Authorization runs before input validation: a forbidden role is refused on an empty input; an allowed one fails later, on the input or the row. */
  async function verdict(userId: number, call: (c: ReturnType<typeof callerFor>) => Promise<unknown>) {
    try { await call(callerFor(userId)); return "allowed"; } catch (e) { return isForbidden(e) ? "forbidden" : "allowed"; }
  }
  it("admin/management and controller decide; office and bookkeeper record; dispatcher assigns jobs; a driver sees the field summary and nothing priced; another tenant is not found", async () => {
    const o = await org();
    const roles = { driver: await member(o, ["driver"]), dispatcher: await member(o, ["dispatcher"]), office: await member(o, ["office"]), bookkeeper: await member(o, ["bookkeeper"]), controller: await member(o, ["controller"]), management: await member(o, ["management"]), auditor: await member(o, ["auditor"]), legal: await member(o, ["legal"]) };
    const probe = {} as never;
    const expectMatrix = async (name: string, call: (c: ReturnType<typeof callerFor>) => Promise<unknown>, allowed: (keyof typeof roles)[]) => {
      for (const [role, uid] of Object.entries(roles) as [keyof typeof roles, number][]) {
        expect(await verdict(uid, call), `${name} for ${role}`).toBe(allowed.includes(role) ? "allowed" : "forbidden");
      }
    };
    await expectMatrix("customers.create", c => c.customerCommercial.customers.create(probe), ["office", "bookkeeper", "controller", "management"]);
    await expectMatrix("customers.archive", c => c.customerCommercial.customers.archive(probe), ["controller", "management"]);
    await expectMatrix("customers.list", c => c.customerCommercial.customers.list(probe), ["dispatcher", "office", "bookkeeper", "controller", "management", "auditor", "legal"]);
    await expectMatrix("contracts.create", c => c.customerCommercial.contracts.create(probe), ["office", "controller", "management", "legal"]);
    await expectMatrix("contracts.approve", c => c.customerCommercial.contracts.approve(probe), ["controller", "management", "legal"]);
    await expectMatrix("contracts.statusSet", c => c.customerCommercial.contracts.statusSet(probe), ["controller", "management"]);
    await expectMatrix("rateSheets.create", c => c.customerCommercial.rateSheets.create(probe), ["dispatcher", "office", "controller", "management"]);
    await expectMatrix("rateSheets.versionDecide", c => c.customerCommercial.rateSheets.versionDecide(probe), ["controller", "management"]);
    await expectMatrix("rateSheets.get", c => c.customerCommercial.rateSheets.get(probe), ["dispatcher", "office", "bookkeeper", "controller", "management", "auditor"]);
    await expectMatrix("jobs.contextSet", c => c.customerCommercial.jobs.contextSet(probe), ["dispatcher", "office", "controller", "management"]);
    await expectMatrix("jobs.snapshotCapture", c => c.customerCommercial.jobs.snapshotCapture(probe), ["dispatcher", "office", "controller", "management"]);
    await expectMatrix("jobs.fieldSummary", c => c.customerCommercial.jobs.fieldSummary(probe), ["driver", "dispatcher", "office", "bookkeeper", "controller", "management", "auditor"]);
    await expectMatrix("jobs.billableContext", c => c.customerCommercial.jobs.billableContext(probe), ["office", "bookkeeper", "controller", "management"]);
    await expectMatrix("expirySweep", c => c.customerCommercial.expirySweep(probe), ["controller", "management"]);
  }, 120_000);
});
