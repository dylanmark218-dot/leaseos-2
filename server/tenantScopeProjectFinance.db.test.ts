/**
 * P0-A3 — project and finance records belong to the organization whose book they are in.
 *
 * The chain this suite defends, read from the schema rather than asserted:
 *
 *   caller → organizationMemberships (active, in its effective window) → orgRef
 *          → financialEntities.orgRef (the books) → quotes.financialEntityId · invoices.financialEntityId
 *          → customerAccounts.financialEntityId → projectBudgets · changeOrders · rfis · customerContractTerms
 *            · clientAdjustments (by customerAccountId)
 *          → jobs.orgRef (0132) → fieldTickets.jobId → fieldTicketRevisions · delayEvents
 *
 * A caller-supplied job id, quote reference, account reference, budget reference, ticket number,
 * document reference or book id is never authority. Reproduced on main `db6cea8` before this
 * change: company A read B's project forecast with its budget and billed totals, issued B's quote,
 * wrote a quote into B's book, approved B's budget, read B's receivables aging with the customer's
 * name and outstanding balance, read B's GL export state, found B's jobs with their customer names
 * through global search, and set signatory authority on B's customer account.
 *
 * Every case goes through `appRouter.createCaller`, the production boundary. FIN-T1..T20 are the
 * checkpoint's case numbers; several share one `it` where the fixture is the same.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
vi.mock("./storage", () => ({ storagePut: vi.fn(async (key: string) => ({ key })), storageGetSignedUrl: vi.fn(async (key: string) => `https://storage.test/${key}`) }));
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 276_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never });

/**
 * Together: project.*, closeout.*, commercial.read, billing.read, surface.search, job.read, invoicing.read, ar.read,
 * portal.identity.manage. (Not dispatcher: combined with these four, `authorize` denies billing.read.)
 */
const FIN_ROLES = ["office", "management", "controller", "bookkeeper"];

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
type Window = { status?: "active" | "suspended" | "ended"; from?: string; to?: string | null };
async function membership(userId: number, orgRef: string, w: Window = {}) {
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, effectiveTo, createdByUserId) VALUES (?,?,?,'employee',?,?,?,1)", [`MEM-${rnd()}`, orgRef, userId, w.status ?? "active", w.from ?? "2020-01-01", w.to ?? null]);
}
async function grant(userId: number, roles: string[]) {
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
}
async function member(orgRef: string | null, roles = FIN_ROLES, w: Window = {}) {
  const userId = seq++;
  if (orgRef) await membership(userId, orgRef, w);
  await grant(userId, roles);
  return userId;
}
const count = async (sql: string, args: (string | number)[]) => Number(((await pool.execute<mysql.RowDataPacket[]>(sql, args))[0][0] as { n: number }).n);
const one = async <T = Record<string, unknown>>(sql: string, args: (string | number)[]) => (await pool.execute<mysql.RowDataPacket[]>(sql, args))[0][0] as T;

/** One organization's books and project records, written the way the schema stores them. */
async function world(orgRef: string | null) {
  const tag = orgRef ?? "LEGACY";
  const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, ?, 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, `Books ${tag}`, orgRef]);
  const entityId = Number(ent.insertId);
  const jobCode = `JOB-${rnd()}`;
  const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef, createdAt) VALUES (?, 'hydrovac', ?, 'LSD 04-12', 'on_site', ?, NOW())", [jobCode, `Client of ${tag}`, orgRef]);
  const jobId = Number(job.insertId);
  const accountRef = `CUST-${rnd()}`;
  const [acct] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, ?)", [accountRef, entityId, `Secret client of ${tag}`]);
  const accountId = Number(acct.insertId);
  const quoteRef = `QT-${rnd()}`;
  const [q] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO quotes (quoteRef, customerAccountId, financialEntityId, jobId, title, subtotalCents, status, createdByUserId) VALUES (?, ?, ?, ?, ?, 777700, 'draft', 1)", [quoteRef, accountId, entityId, jobId, `Confidential quote ${tag}`]);
  await pool.execute("INSERT INTO quoteLines (quoteId, lineNo, serviceCode, description, quantity, unit, rateCents, amountCents, priceSource) VALUES (?, 1, 'VAC-HR', 'Vac truck', 42, 'hour', 18500, 777000, 'explicit')", [q.insertId]);
  const issuedQuoteRef = `QT-${rnd()}`;
  const issuedHash = "a".repeat(64);
  await pool.execute("INSERT INTO quotes (quoteRef, customerAccountId, financialEntityId, jobId, title, subtotalCents, status, snapshotJson, snapshotHash, issuedByUserId, issuedAt, createdByUserId) VALUES (?, ?, ?, ?, 'Issued quote', 100, 'issued', '{}', ?, 1, NOW(), 1)", [issuedQuoteRef, accountId, entityId, jobId, issuedHash]);
  const [bb] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, ?, 'x', 'invoiced', NOW(), NOW(), NOW())", [`BB-${rnd()}`, jobId]);
  const invoiceNumber = `INV-${rnd()}`;
  await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, customerAccountId, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, '2026-08-05 00:00:00', ?, ?, ?, ?, 555500, 27775, 583275, 'CAD', 'sent', '2026-09-04 00:00:00')", [invoiceNumber, entityId, bb.insertId, jobId, `Secret client of ${tag}`, accountId]);
  const budgetRef = `BUD-${rnd()}`;
  await pool.execute("INSERT INTO projectBudgets (budgetRef, customerAccountId, jobId, version, totalCents, status, createdByUserId) VALUES (?, ?, ?, 1, 999900, 'draft', 1)", [budgetRef, accountId, jobId]);
  const ticketNumber = `FT-${rnd()}`;
  const [ft] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO fieldTickets (ticketNumber, scope, jobId, customerAccountId, status, signatureStatus, updatedAt) VALUES (?, 'job', ?, ?, 'draft', 'unsigned', NOW())", [ticketNumber, jobId, accountId]);
  const ticketId = Number(ft.insertId);
  const documentRef = `${ticketNumber}-R1`;
  await pool.execute("INSERT INTO fieldTicketRevisions (documentRef, fieldTicketId, revision, kind, snapshotJson, snapshotHash, generatedAt) VALUES (?, ?, 1, 'site_signed', '{}', ?, NOW())", [documentRef, ticketId, "b".repeat(64)]);
  const adjustmentRef = `ADJ-${rnd()}`;
  await pool.execute("INSERT INTO clientAdjustments (adjustmentRef, fieldTicketId, customerAccountId, kind, basisJson, amountCents, reason, authorizedByName, authorizedAt, idempotencyHash, payrollTreatment) VALUES (?, ?, ?, 'tip', '{}', 5000, 'Great crew', 'M. Johnson', NOW(), ?, 'proposed')", [adjustmentRef, ticketId, accountId, rnd() + rnd() + rnd()]);
  const termsRef = `TERMS-${rnd()}`;
  await pool.execute("INSERT INTO customerContractTerms (termsRef, customerAccountId, version, title, standbyBillable, customerHoldBillable, weatherHoldBillable, travelToDisposalBillable, disposalQueueBillable, disposalBillable, returnTravelBillable, clausesJson, effectiveFrom, recordedByUserId) VALUES (?, ?, 1, 'MSA', 'yes', 'yes', 'no', 'yes', 'no', 'yes', 'yes', '{}', '2026-01-01 00:00:00', 1)", [termsRef, accountId]);
  const [tr] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (orgRef, tripNumber, jobId, status, createdAt) VALUES (?, ?, ?, 'in_transit', NOW())", [orgRef, `TR-${rnd()}`, jobId]);
  const [ld] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, billingBookId) VALUES (?, ?, ?)", [`LD-${rnd()}`, jobId, bb.insertId]);
  return { orgRef, entityId, jobId, jobCode, accountRef, accountId, quoteRef, issuedQuoteRef, issuedHash, invoiceNumber, budgetRef, ticketNumber, ticketId, documentRef, adjustmentRef, termsRef, tripId: Number(tr.insertId), loadId: Number(ld.insertId) };
}
type World = Awaited<ReturnType<typeof world>>;
const ghost = () => 900_000_000 + Math.floor(Math.random() * 1_000_000);
const notFound = (message: string) => ({ code: "NOT_FOUND", message });

d("project and finance reads are refused across the organization boundary", () => {
  it("FIN-T1/T2/T7/T8 — the project forecast by job id: a foreign job is refused exactly like a nonexistent one; the owner's is served with its own totals", async () => {
    const A = await world(await org()), B = await world(await org());
    const a = callerFor(await member(A.orgRef));
    // T1/T2 — B's project through B's job id: not found, not B's budget, quote or billed totals.
    await expect(a.project.forecast({ jobId: B.jobId })).rejects.toMatchObject(notFound("Job not found"));
    // T7 — a nonexistent id gets the identical answer.
    await expect(a.project.forecast({ jobId: ghost() })).rejects.toMatchObject(notFound("Job not found"));
    // T8 — the owner's own: A's budget, A's billed total, nothing of B's.
    const own = await a.project.forecast({ jobId: A.jobId });
    expect(own).toMatchObject({ jobId: A.jobId, jobCode: A.jobCode, budget: { budgetRef: A.budgetRef }, billedCents: 583275, budgetCents: 999900 });
  }, 60_000);

  it("FIN-T3/T19 — the invoice by number, the chain from a load and the timeline of a job: nothing of B's reaches A", async () => {
    const A = await world(await org()), B = await world(await org());
    const a = callerFor(await member(A.orgRef)), b = callerFor(await member(B.orgRef));
    await expect(a.invoicing.get({ invoiceNumber: B.invoiceNumber })).rejects.toMatchObject(notFound("No such invoice"));
    // The chain from B's load: A gets no node at all — not the job, not the customer, not the invoice.
    const chain = await a.surfaces.chain({ entityType: "load", entityId: B.loadId });
    const text = JSON.stringify(chain);
    for (const secret of [B.invoiceNumber, B.jobCode, `Client of ${B.orgRef}`]) expect(text).not.toContain(secret);
    expect(chain.nodes.filter(n => n.ref)).toEqual([]);
    // B's own dispatcher sees B's chain.
    expect(JSON.stringify(await b.surfaces.chain({ entityType: "load", entityId: B.loadId }))).toContain(B.jobCode);
    // The timeline of B's job is empty to A and has B's trip for B.
    expect((await a.surfaces.timeline({ entityType: "job", entityId: B.jobId })).total).toBe(0);
    expect((await b.surfaces.timeline({ entityType: "job", entityId: B.jobId })).total).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("FIN-T4/T6/T19 — search is filtered in the query, with the per-kind limit after the tenant predicate: no foreign invoice, job or customer name, and no page position reveals one", async () => {
    const A = await world(await org()), B = await world(await org());
    const a = callerFor(await member(A.orgRef));
    const prefix = `INVP-${rnd()}`;
    // B has twelve invoices with the prefix (more than the per-kind limit of 10); A has one.
    for (let i = 0; i < 12; i++) await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, billingBookId, customer, subtotalCents, taxCents, totalCents, currency, status) VALUES (?, ?, 1, 'x', 1, 0, 1, 'CAD', 'sent')", [`${prefix}-B${i}`, B.entityId]);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, billingBookId, customer, subtotalCents, taxCents, totalCents, currency, status) VALUES (?, ?, 1, 'x', 1, 0, 1, 'CAD', 'sent')", [`${prefix}-A`, A.entityId]);
    const byPrefix = await a.surfaces.search({ q: prefix });
    expect(byPrefix.hits.map(h => h.label)).toEqual([`${prefix}-A`]);
    expect((await a.surfaces.search({ q: B.invoiceNumber })).hits).toEqual([]);
    expect((await a.surfaces.search({ q: `Client of ${B.orgRef}` })).hits).toEqual([]);
    expect((await a.surfaces.search({ q: B.jobCode })).hits).toEqual([]);
    // The owner finds its own.
    expect((await a.surfaces.search({ q: A.invoiceNumber })).hits.map(h => h.entityType)).toEqual(["invoice"]);
    expect((await a.surfaces.search({ q: A.jobCode })).hits.some(h => h.entityType === "job")).toBe(true);
  }, 60_000);

  it("FIN-T5/T18/T20 — aggregates and exports by book id: a foreign book is refused like a nonexistent one; the owner's totals are the owner's rows only", async () => {
    const A = await world(await org()), B = await world(await org());
    const a = callerFor(await member(A.orgRef));
    const g = ghost();
    const refusedBook = (id: number) => notFound(`Financial entity ${id} not found`);
    await expect(a.commercialOffice.ar.agingByOrganization({ financialEntityId: B.entityId })).rejects.toMatchObject(refusedBook(B.entityId));
    await expect(a.commercialOffice.ar.agingByOrganization({ financialEntityId: g })).rejects.toMatchObject(refusedBook(g));
    await expect(a.commercialOffice.ap.agingByOrganization({ financialEntityId: B.entityId })).rejects.toMatchObject(refusedBook(B.entityId));
    await expect(a.commercialOffice.gl.exportReadiness({ financialEntityId: B.entityId, from: new Date("2026-01-01"), to: new Date("2026-12-31") })).rejects.toMatchObject(refusedBook(B.entityId));
    await expect(a.commercialOffice.profitability.byDimension({ financialEntityId: B.entityId, dimension: "job", from: new Date("2026-01-01"), to: new Date("2026-12-31") })).rejects.toMatchObject(refusedBook(B.entityId));
    await expect(a.ar.aging({ financialEntityId: B.entityId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // T20 — A's aging is A's one invoice; B's invoice, which names the same customer wording, is not in it.
    const aging = await a.commercialOffice.ar.agingByOrganization({ financialEntityId: A.entityId });
    const groups = [...aging.organizations, ...aging.unlinked];
    expect(groups.reduce((s, x) => s + x.invoiceCount, 0)).toBe(1);
    expect(groups.reduce((s, x) => s + x.totalOutstandingCents, 0)).toBe(583275);
    expect(JSON.stringify(aging)).not.toContain(B.orgRef);
  }, 60_000);
});

d("project and finance mutations prove ownership independently of the permission", () => {
  it("FIN-T9/T7/T11 — quotes, budgets, change orders and RFIs: a foreign reference is refused like a nonexistent one with nothing written; the owner's own succeed", async () => {
    const A = await world(await org()), B = await world(await org());
    const a = callerFor(await member(A.orgRef));
    const line = { serviceCode: "X", description: "x", quantity: 1, unit: "hour" as const, explicitRateCents: 100 };
    const quotesInB = await count("SELECT COUNT(*) n FROM quotes WHERE financialEntityId = ?", [B.entityId]);
    const budgetsOfB = await count("SELECT COUNT(*) n FROM projectBudgets WHERE customerAccountId = ?", [B.accountId]);
    // T9 — every write that names B's quote, account or budget.
    await expect(a.project.quoteIssue({ quoteRef: B.quoteRef })).rejects.toMatchObject(notFound("Quote not found"));
    await expect(a.project.quoteIssue({ quoteRef: `QT-${rnd()}` })).rejects.toMatchObject(notFound("Quote not found"));
    await expect(a.project.quoteRevise({ quoteRef: B.quoteRef, lines: [line] })).rejects.toMatchObject(notFound("Quote not found"));
    await expect(a.project.quoteCreate({ accountRef: B.accountRef, title: "planted", lines: [line] })).rejects.toMatchObject(notFound("Customer account not found"));
    await expect(a.project.quoteCreate({ accountRef: `CUST-${rnd()}`, title: "planted", lines: [line] })).rejects.toMatchObject(notFound("Customer account not found"));
    await expect(a.project.quoteCreate({ accountRef: A.accountRef, jobId: B.jobId, title: "A's account, B's job", lines: [line] })).rejects.toMatchObject(notFound("Job not found"));
    await expect(a.project.changeOrderPropose({ accountRef: B.accountRef, description: "planted change", reason: "planted reason", estimatedCents: 1 })).rejects.toMatchObject(notFound("Customer account not found"));
    await expect(a.project.changeOrderPropose({ accountRef: A.accountRef, quoteRef: B.quoteRef, description: "planted change", reason: "planted reason", estimatedCents: 1 })).rejects.toMatchObject(notFound("Quote not found"));
    await expect(a.project.rfiAsk({ accountRef: B.accountRef, question: "Is the road open after the washout?" })).rejects.toMatchObject(notFound("Customer account not found"));
    await expect(a.project.budgetCreate({ accountRef: B.accountRef, jobId: B.jobId, lines: [{ costCode: "10", description: "x", budgetedCents: 1 }] })).rejects.toMatchObject(notFound("Customer account not found"));
    await expect(a.project.budgetApprove({ budgetRef: B.budgetRef })).rejects.toMatchObject(notFound("Budget not found"));
    await expect(a.project.budgetApprove({ budgetRef: `BUD-${rnd()}` })).rejects.toMatchObject(notFound("Budget not found"));
    await expect(a.project.percentCompleteState({ budgetRef: B.budgetRef, percentComplete: 50 })).rejects.toMatchObject(notFound("Budget not found"));
    // Nothing of B's changed and nothing was written into B's book.
    expect(await one("SELECT status, snapshotHash FROM quotes WHERE quoteRef = ?", [B.quoteRef])).toEqual({ status: "draft", snapshotHash: null });
    expect(await one("SELECT status, percentComplete FROM projectBudgets WHERE budgetRef = ?", [B.budgetRef])).toEqual({ status: "draft", percentComplete: null });
    expect(await count("SELECT COUNT(*) n FROM quotes WHERE financialEntityId = ?", [B.entityId])).toBe(quotesInB);
    expect(await count("SELECT COUNT(*) n FROM projectBudgets WHERE customerAccountId = ?", [B.accountId])).toBe(budgetsOfB);
    expect(await count("SELECT COUNT(*) n FROM changeOrders WHERE customerAccountId = ?", [B.accountId])).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM rfis WHERE customerAccountId = ?", [B.accountId])).toBe(0);
    // T11 — the same calls on A's own records succeed, and land in A's book.
    await expect(a.project.quoteIssue({ quoteRef: A.quoteRef })).resolves.toMatchObject({ quoteRef: A.quoteRef, status: "issued" });
    await expect(a.project.budgetApprove({ budgetRef: A.budgetRef })).resolves.toMatchObject({ status: "approved" });
    const created = await a.project.quoteCreate({ accountRef: A.accountRef, jobId: A.jobId, title: "A's own", lines: [line] });
    expect(await one("SELECT financialEntityId FROM quotes WHERE quoteRef = ?", [created.quoteRef])).toEqual({ financialEntityId: A.entityId });
  }, 60_000);

  it("FIN-T10/T11 — invoices, tickets, terms, authority, documents and adjustments: a foreign one is refused with nothing written; the owner's succeed", async () => {
    const A = await world(await org()), B = await world(await org());
    const a = callerFor(await member(A.orgRef));
    const ticketRefused = notFound(`Ticket ${B.ticketNumber} not found`);
    await expect(a.invoicing.void({ invoiceNumber: B.invoiceNumber, reason: "attempted by another organization" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(a.closeout.lineDecide({ ticketNumber: B.ticketNumber, lineId: 1, disposition: "accepted" })).rejects.toMatchObject(ticketRefused);
    await expect(a.closeout.delayRecord({ ticketNumber: B.ticketNumber, kind: "weather", observedAt: new Date(), observation: "Planted delay on another company's ticket" })).rejects.toMatchObject(ticketRefused);
    await expect(a.closeout.delayRecord({ jobId: B.jobId, kind: "weather", observedAt: new Date(), observation: "Planted delay on another company's job" })).rejects.toMatchObject(notFound(`Job ${B.jobId} not found`));
    await expect(a.closeout.authoritySet({ customerAccountRef: B.accountRef, signatoryName: "Planted" })).rejects.toMatchObject(notFound("Customer account not found"));
    await expect(a.closeout.termsRecord({ customerAccountRef: B.accountRef, title: "Planted", standbyBillable: "yes", customerHoldBillable: "yes", weatherHoldBillable: "no", travelToDisposalBillable: "yes", disposalQueueBillable: "no", disposalBillable: "yes", returnTravelBillable: "yes", effectiveFrom: new Date("2026-01-01") })).rejects.toMatchObject(notFound("Customer account not found"));
    await expect(a.closeout.termsApprove({ termsRef: B.termsRef })).rejects.toMatchObject(notFound("Terms not found"));
    await expect(a.closeout.termsApprove({ termsRef: `TERMS-${rnd()}` })).rejects.toMatchObject(notFound("Terms not found"));
    await expect(a.closeout.documentRender({ documentRef: B.documentRef })).rejects.toMatchObject(notFound("Revision not found"));
    await expect(a.closeout.documentRender({ documentRef: `FT-${rnd()}-R1` })).rejects.toMatchObject(notFound("Revision not found"));
    await expect(a.closeout.adjustmentPayrollPropose({ adjustmentRef: B.adjustmentRef, employeePayrollProfileId: 1, amountCents: 100, note: "planted proposal" })).rejects.toMatchObject(notFound("Adjustment not found"));
    await expect(a.closeout.state({ ticketNumber: B.ticketNumber })).rejects.toMatchObject(ticketRefused);
    // A ticket on A's own job cannot bill to B's customer account (the portal would then show it to B's customer).
    await expect(a.closeout.ticketOpen({ jobId: A.jobId, customerAccountRef: B.accountRef, serviceDescription: "planted" })).rejects.toMatchObject(notFound("Customer account not found"));
    expect(await count("SELECT COUNT(*) n FROM fieldTickets WHERE customerAccountId = ?", [B.accountId])).toBe(1);
    // Nothing of B's changed.
    expect(await count("SELECT COUNT(*) n FROM delayEvents WHERE jobId = ? OR fieldTicketId = ?", [B.jobId, B.ticketId])).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM signatoryAuthorities WHERE customerAccountId = ?", [B.accountId])).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM customerContractTerms WHERE customerAccountId = ?", [B.accountId])).toBe(1);
    expect(await one("SELECT status FROM customerContractTerms WHERE termsRef = ?", [B.termsRef])).toEqual({ status: "draft" });
    expect(await count("SELECT COUNT(*) n FROM fieldTicketDocuments WHERE fieldTicketId = ?", [B.ticketId])).toBe(0);
    expect(await one("SELECT payrollTreatment FROM clientAdjustments WHERE adjustmentRef = ?", [B.adjustmentRef])).toEqual({ payrollTreatment: "proposed" });
    expect(await one("SELECT status FROM invoices WHERE invoiceNumber = ?", [B.invoiceNumber])).toEqual({ status: "sent" });
    // T11 — the owner's own.
    await expect(a.closeout.authoritySet({ customerAccountRef: A.accountRef, signatoryName: "M. Johnson" })).resolves.toMatchObject({ authorityRef: expect.any(String) });
    await expect(a.closeout.state({ ticketNumber: A.ticketNumber })).resolves.toBeTruthy();
    const delay = await a.closeout.delayRecord({ ticketNumber: A.ticketNumber, kind: "weather", observedAt: new Date(), observation: "Fog on the lease road this morning" });
    expect(await one("SELECT fieldTicketId FROM delayEvents WHERE delayRef = ?", [delay.delayRef])).toEqual({ fieldTicketId: A.ticketId });
  }, 60_000);

  it("FIN-T12 — a revoked finance permission still fails inside the right organization", async () => {
    const A = await world(await org());
    const u = await member(A.orgRef);
    await pool.execute("UPDATE userRoleAssignments SET revokedAt = NOW(), revokedByUserId = 1, revokeReason = 'fixture' WHERE userId = ?", [u]);
    await expect(callerFor(u).project.quoteIssue({ quoteRef: A.quoteRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(u).project.forecast({ jobId: A.jobId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await one("SELECT status FROM quotes WHERE quoteRef = ?", [A.quoteRef])).toEqual({ status: "draft" });
  }, 60_000);
});

d("membership is the only road into a book", () => {
  it("FIN-T13/T14 — an ex-member with every historical grant, a fresh grant, a lapsed window or a suspension reaches no money of the company", async () => {
    const A = await world(await org());
    const refused = { code: "FORBIDDEN", message: "No active organization membership" };
    const ex = await member(A.orgRef, FIN_ROLES, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    for (const attempt of [
      () => callerFor(ex).project.forecast({ jobId: A.jobId }),
      () => callerFor(ex).project.quoteIssue({ quoteRef: A.quoteRef }),
      () => callerFor(ex).invoicing.get({ invoiceNumber: A.invoiceNumber }),
      () => callerFor(ex).ar.aging({ financialEntityId: A.entityId }),
      () => callerFor(ex).commercialOffice.ar.agingByOrganization({ financialEntityId: A.entityId }),
      () => callerFor(ex).surfaces.search({ q: A.invoiceNumber }),
      () => callerFor(ex).closeout.state({ ticketNumber: A.ticketNumber }),
      () => callerFor(ex).closeout.termsApprove({ termsRef: A.termsRef }),
    ]) await expect(attempt()).rejects.toMatchObject(refused);
    // T14 — a new role grant after the membership ended changes nothing: roles are not tenancy.
    await grant(ex, ["auditor", "external_accountant"]);
    await expect(callerFor(ex).project.forecast({ jobId: A.jobId })).rejects.toMatchObject(refused);
    const lapsed = await member(A.orgRef, FIN_ROLES, { status: "active", from: "2020-01-01", to: "2021-01-01" });
    await expect(callerFor(lapsed).invoicing.get({ invoiceNumber: A.invoiceNumber })).rejects.toMatchObject(refused);
    const suspended = await member(A.orgRef, FIN_ROLES, { status: "suspended" });
    await expect(callerFor(suspended).project.forecast({ jobId: A.jobId })).rejects.toMatchObject(refused);
    expect(await one("SELECT status FROM quotes WHERE quoteRef = ?", [A.quoteRef])).toEqual({ status: "draft" });
  }, 60_000);

  it("FIN-T15 — acting as A reaches A's books only; two live memberships are refused, never unioned", async () => {
    const orgA = await org(), orgB = await org();
    const A = await world(orgA), B = await world(orgB);
    const person = seq++;
    await grant(person, FIN_ROLES);
    await membership(person, orgA, { from: "2020-01-01" });
    await membership(person, orgB, { status: "ended", from: "2019-01-01", to: "2019-12-31" });
    await expect(callerFor(person).project.forecast({ jobId: A.jobId })).resolves.toMatchObject({ jobId: A.jobId });
    await expect(callerFor(person).project.forecast({ jobId: B.jobId })).rejects.toMatchObject(notFound("Job not found"));
    await pool.execute("UPDATE organizationMemberships SET status = 'active', effectiveFrom = '2020-01-01', effectiveTo = NULL WHERE userId = ? AND orgRef = ?", [person, B.orgRef]);
    const ambiguous = { code: "PRECONDITION_FAILED" };
    await expect(callerFor(person).project.forecast({ jobId: A.jobId })).rejects.toMatchObject(ambiguous);
    await expect(callerFor(person).project.forecast({ jobId: B.jobId })).rejects.toMatchObject(ambiguous);
    await expect(callerFor(person).invoicing.get({ invoiceNumber: A.invoiceNumber })).rejects.toMatchObject(ambiguous);
    await expect(callerFor(person).surfaces.search({ q: A.invoiceNumber })).rejects.toMatchObject(ambiguous);
    await expect(callerFor(person).project.quoteIssue({ quoteRef: A.quoteRef })).rejects.toMatchObject(ambiguous);
    expect(await one("SELECT status FROM quotes WHERE quoteRef = ?", [A.quoteRef])).toEqual({ status: "draft" });
  }, 60_000);

  it("FIN-T16 — the legacy single-tenant fallback serves a person who never had a membership, reaches only books with no organization, and never revives an ended member", async () => {
    const legacy = await world(null), A = await world(await org());
    const never = await member(null);
    await expect(callerFor(never).project.forecast({ jobId: legacy.jobId })).resolves.toMatchObject({ jobId: legacy.jobId, billedCents: 583275 });
    await expect(callerFor(never).project.forecast({ jobId: A.jobId })).rejects.toMatchObject(notFound("Job not found"));
    await expect(callerFor(never).project.quoteIssue({ quoteRef: A.quoteRef })).rejects.toMatchObject(notFound("Quote not found"));
    await expect(callerFor(never).project.quoteIssue({ quoteRef: legacy.quoteRef })).resolves.toMatchObject({ status: "issued" });
    // A's member does not see the legacy books either.
    await expect(callerFor(await member(A.orgRef)).project.forecast({ jobId: legacy.jobId })).rejects.toMatchObject(notFound("Job not found"));
    // An ex-member of A is not the fallback.
    const ex = await member(A.orgRef, FIN_ROLES, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    await expect(callerFor(ex).project.forecast({ jobId: legacy.jobId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});

d("the customer portal cannot cross accounts", () => {
  it("FIN-T17 — an identity on A's customer account sees and accepts only quotes on that account; B's issued quote is not found and stays issued", async () => {
    const A = await world(await org()), B = await world(await org());
    const ctrlA = await member(A.orgRef);
    const inv = await callerFor(ctrlA).portalAdmin.identityInvite({ kind: "customer", accountRef: A.accountRef, email: `mj-${rnd()}@abc.example`, displayName: "M. Johnson" });
    const token = (await portalCaller(inv.invitationToken).portal.invitationAccept()).token;
    const seen = await portalCaller(token).portal.quotes();
    expect(seen.quotes.map(q => q.quoteRef)).toEqual([A.issuedQuoteRef]);
    await expect(portalCaller(token).portal.quoteAccept({ quoteRef: B.issuedQuoteRef, snapshotHash: B.issuedHash })).rejects.toMatchObject(notFound("No such quote on this account"));
    await expect(portalCaller(token).portal.quoteAccept({ quoteRef: `QT-${rnd()}`, snapshotHash: B.issuedHash })).rejects.toMatchObject(notFound("No such quote on this account"));
    expect(await one("SELECT status, acceptedByName FROM quotes WHERE quoteRef = ?", [B.issuedQuoteRef])).toEqual({ status: "issued", acceptedByName: null });
    // A's controller cannot invite an identity onto B's account either (F1).
    await expect(callerFor(ctrlA).portalAdmin.identityInvite({ kind: "customer", accountRef: B.accountRef, email: `x-${rnd()}@abc.example`, displayName: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});
