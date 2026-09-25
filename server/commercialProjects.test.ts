import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { changeOrderAuthority, projectForecast, quoteAcceptanceDecision } from "./_core/commercialProjects";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const NOW = new Date("2026-09-10T12:00:00Z");
const auth = (over = {}) => ({ extraWorkLimitCents: 500_000, mayAcceptQuotes: true, mayAnswerRfis: true, status: "active" as const, validTo: null, ...over });

describe("a quote is accepted by hash, under authority, while it stands", () => {
  it("refuses a draft, an expired quote, a changed quote, and a signatory without the authority; unknown without any authority", () => {
    const ok = quoteAcceptanceDecision({ status: "issued", validUntil: new Date("2026-10-01T00:00:00Z"), snapshotHashOnFile: "a".repeat(64), snapshotHashSeen: "a".repeat(64), authority: auth(), at: NOW });
    expect(ok).toEqual({ permitted: true, refusals: [], withinAuthority: "yes" });
    const bad = quoteAcceptanceDecision({ status: "draft", validUntil: new Date("2026-09-01T00:00:00Z"), snapshotHashOnFile: "a".repeat(64), snapshotHashSeen: "b".repeat(64), authority: auth({ mayAcceptQuotes: false }), at: NOW });
    expect(bad.refusals).toEqual(["Quote is draft — only an issued quote is accepted", "Quote expired 2026-09-01", "The quote changed since it was presented — present it again", "This signatory does not hold the authority to accept quotes for the account"]);
    expect(quoteAcceptanceDecision({ status: "issued", validUntil: null, snapshotHashOnFile: "a".repeat(64), snapshotHashSeen: "a".repeat(64), authority: null, at: NOW })).toMatchObject({ permitted: true, withinAuthority: "unknown" });
  });
  it("records a change order as within, above, or unknown authority — and says which", () => {
    expect(changeOrderAuthority({ estimatedCents: 400_000, authority: auth(), at: NOW })).toEqual({ withinAuthority: "yes", detail: "Within the signatory's $5000.00 extra-work limit" });
    expect(changeOrderAuthority({ estimatedCents: 600_000, authority: auth(), at: NOW }).detail).toContain("exceeds the signatory's $5000.00 limit");
    expect(changeOrderAuthority({ estimatedCents: 1, authority: auth({ extraWorkLimitCents: null }), at: NOW })).toMatchObject({ withinAuthority: "no" });
    expect(changeOrderAuthority({ estimatedCents: 1, authority: auth({ validTo: new Date("2026-01-01T00:00:00Z") }), at: NOW }).detail).toContain("revoked or expired");
    expect(changeOrderAuthority({ estimatedCents: 1, authority: null, at: NOW })).toMatchObject({ withinAuthority: "unknown" });
  });
  it("forecasts from what was quoted, authorized, billed and collected, and refuses a completion forecast nobody stated", () => {
    const f = projectForecast({ budgetCents: 1_000_000, quotedCents: 900_000, authorizedChangesCents: 150_000, billedCents: 525_000, collectedCents: 300_000, percentComplete: 50 });
    expect(f).toMatchObject({ committedCents: 1_050_000, varianceToBudgetCents: 50_000, forecastAtCompletionCents: 1_050_000, determination: "computed", reasons: [] });
    const p = projectForecast({ budgetCents: 1_000_000, quotedCents: null, authorizedChangesCents: 150_000, billedCents: 200_000, collectedCents: 250_000, percentComplete: null });
    expect(p).toMatchObject({ committedCents: null, forecastAtCompletionCents: null, determination: "unknown" });
    expect(p.reasons).toEqual(["No accepted quote — the committed value is unknown; change orders alone do not make a commitment", "Percent complete not stated — forecast at completion is unknown", "Collected $2500.00 exceeds billed $2000.00 — REVIEW"]);
  });
});

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
describe("who issues a price, who approves a budget", () => {
  it("keeps issuing and approving above the office", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "project.quote.issue" }).allowed).sort()).toEqual(["controller", "management"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "project.budget.approve" }).allowed).sort()).toEqual(["controller", "management"]);
    expect(authorize({ userId: 1, roles: ["office"], permission: "project.quote.manage" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["office"], permission: "project.quote.issue" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 3_000_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a job, sold and changed", () => {
  it("prices a quote from the card, freezes it at issue, accepts it by hash under authority, supersedes it with a revision, authorizes a change order above authority and says so, answers an RFI, approves a budget by a second person, and forecasts honestly", async () => {
    const office = await withRole("office");
    const management = await withRole("management");
    const controller = await withRole("controller");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const jobId = Number(job.insertId);
    await callerFor(controller).commercial.rateCardCreate({ accountRef: acctRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), lines: [{ serviceCode: "VAC-HR", description: "Vac truck, hourly", unit: "hour", rateCents: 18_500 }, { serviceCode: "DISP-M3", description: "Disposal per m3", unit: "m3", rateCents: 2_250 }] });

    // The card prices what it knows; an unknown code needs an explicit rate, and the quote says which lines came from where.
    await expect(callerFor(office).project.quoteCreate({ accountRef: acctRef, jobId, title: "Hydrovac, 3 days", lines: [{ serviceCode: "HOSE-EXTRA", description: "Extra hose", quantity: 1, unit: "each" }] })).rejects.toThrow(/give an explicit rate or add the line to the card/);
    const q = await callerFor(office).project.quoteCreate({ accountRef: acctRef, jobId, title: "Hydrovac, 3 days", validUntil: new Date("2026-12-31T00:00:00Z"), lines: [{ serviceCode: "VAC-HR", description: "Vac truck", quantity: 30, unit: "hour", costCode: "10-VAC" }, { serviceCode: "DISP-M3", description: "Disposal", quantity: 60, unit: "m3", costCode: "20-DISP" }, { serviceCode: "HOSE-EXTRA", description: "Extra hose", quantity: 1, unit: "each", explicitRateCents: 25_000, costCode: "30-EXTRA" }] });
    expect(q).toMatchObject({ subtotalCents: 30 * 18_500 + 60 * 2_250 + 25_000, lines: 3, pricedFromCard: 2 });
    // Issued: frozen with a hash. Only management/controller issue.
    await expect(callerFor(office).project.quoteIssue({ quoteRef: q.quoteRef })).rejects.toBeTruthy();
    const issued = await callerFor(management).project.quoteIssue({ quoteRef: q.quoteRef });
    expect(issued.snapshotHash).toMatch(/^[a-f0-9]{64}$/);

    // The customer: a signatory without quote authority is refused; with it, accepted by the hash they saw; a stale hash is refused.
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: "mj@abc.example", displayName: "M. Johnson" });
    const token = (await portalCaller(inv.invitationToken).portal.invitationAccept()).token;
    const seen = (await portalCaller(token).portal.quotes()).quotes[0];
    expect(seen).toMatchObject({ quoteRef: q.quoteRef, status: "issued", snapshotHash: issued.snapshotHash });
    expect(seen.lines).toHaveLength(3);
    await callerFor(office).closeout.authoritySet({ customerAccountRef: acctRef, signatoryName: "M. Johnson", externalIdentityRef: inv.identityRef, mayConfirmWork: true, maySignTicket: true, mayApproveStandby: true, extraWorkLimitCents: 500_000, mayApproveInvoice: false, mayChangeRates: false, mayAcceptQuotes: false });
    await expect(portalCaller(token).portal.quoteAccept({ quoteRef: q.quoteRef, snapshotHash: issued.snapshotHash })).rejects.toThrow(/does not hold the authority to accept quotes/);
    await callerFor(office).closeout.authoritySet({ customerAccountRef: acctRef, signatoryName: "M. Johnson", externalIdentityRef: inv.identityRef, mayConfirmWork: true, maySignTicket: true, mayApproveStandby: true, extraWorkLimitCents: 500_000, mayApproveInvoice: false, mayChangeRates: false, mayAcceptQuotes: true });
    await expect(portalCaller(token).portal.quoteAccept({ quoteRef: q.quoteRef, snapshotHash: "0".repeat(64) })).rejects.toThrow(/changed since it was presented/);
    expect(await portalCaller(token).portal.quoteAccept({ quoteRef: q.quoteRef, snapshotHash: issued.snapshotHash })).toMatchObject({ status: "accepted", withinAuthority: "yes" });
    // An accepted quote is not revised — a change order is the path; a draft one is superseded by version 2 with the old hash standing.
    await expect(callerFor(office).project.quoteRevise({ quoteRef: q.quoteRef, lines: [{ serviceCode: "VAC-HR", description: "x", quantity: 1, unit: "hour" }] })).rejects.toThrow(/propose a change order/);
    const q2 = await callerFor(office).project.quoteCreate({ accountRef: acctRef, title: "Second job", lines: [{ serviceCode: "VAC-HR", description: "Vac truck", quantity: 10, unit: "hour" }] });
    const rev = await callerFor(office).project.quoteRevise({ quoteRef: q2.quoteRef, lines: [{ serviceCode: "VAC-HR", description: "Vac truck", quantity: 12, unit: "hour" }] });
    expect(rev).toMatchObject({ version: 2, supersedes: q2.quoteRef, subtotalCents: 12 * 18_500 });
    const [old] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM quotes WHERE quoteRef = ?", [q2.quoteRef]);
    expect(old[0].status).toBe("superseded");

    // A change order above the signatory's limit: authorized, recorded as above authority, the office alerted to confirm; the hash must match.
    const co = await callerFor(office).project.changeOrderPropose({ accountRef: acctRef, jobId, quoteRef: q.quoteRef, description: "Second unit for two extra days", reason: "Customer asked for faster completion", estimatedCents: 740_000, costCode: "10-VAC" });
    await expect(portalCaller(token).portal.changeOrderAuthorize({ changeOrderRef: co.changeOrderRef, snapshotHash: "0".repeat(64), decision: "authorized" })).rejects.toThrow(/differs from what was presented/);
    const coAuth = await portalCaller(token).portal.changeOrderAuthorize({ changeOrderRef: co.changeOrderRef, snapshotHash: co.snapshotHash, decision: "authorized" });
    expect(coAuth).toMatchObject({ status: "authorized", withinAuthority: "no" });
    expect(coAuth.detail).toContain("$7400.00 exceeds the signatory's $5000.00 limit");
    const alerts = (await portalCaller(token).portal.alerts()).alerts;
    expect(alerts.some(a => a.body!.includes("above the signatory's authority"))).toBe(true);

    // An RFI: asked inside, answered outside, the answer kept; a second answer is refused.
    const rfi = await callerFor(office).project.rfiAsk({ accountRef: acctRef, jobId, question: "Is the north access road open after the washout?" });
    expect((await portalCaller(token).portal.rfiAnswer({ rfiRef: rfi.rfiRef, answer: "Open from Thursday; use the south gate until then.", affectsScope: true })).status).toBe("answered");
    await expect(portalCaller(token).portal.rfiAnswer({ rfiRef: rfi.rfiRef, answer: "changed my mind" })).rejects.toThrow(/an answer on record is not replaced/);
    const [rrow] = await pool.execute<mysql.RowDataPacket[]>("SELECT answer, affectsScope FROM rfis WHERE rfiRef = ?", [rfi.rfiRef]);
    expect(rrow[0]).toMatchObject({ answer: "Open from Thursday; use the south gate until then.", affectsScope: 1 });

    // A budget by cost code, approved by someone other than its author; the forecast before and after completion is stated.
    const bud = await callerFor(office).project.budgetCreate({ accountRef: acctRef, jobId, quoteRef: q.quoteRef, lines: [{ costCode: "10-VAC", description: "Vac hours", budgetedCents: 600_000 }, { costCode: "20-DISP", description: "Disposal", budgetedCents: 150_000 }, { costCode: "30-EXTRA", description: "Extras", budgetedCents: 25_000 }] });
    await expect(callerFor(office).project.budgetApprove({ budgetRef: bud.budgetRef })).rejects.toBeTruthy();
    expect((await callerFor(management).project.budgetApprove({ budgetRef: bud.budgetRef })).status).toBe("approved");
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, ?, 'ABC Energy', 'invoiced', NOW(), NOW(), NOW())", [key("BB").slice(0, 40), jobId]);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status) VALUES (?, ?, NOW(), ?, ?, 'ABC Energy', 400000, 20000, 420000, 'CAD', 'sent')", [key("INV").slice(0, 40), entityId, Number(book.insertId), jobId]);
    const f1 = await callerFor(office).project.forecast({ jobId });
    expect(f1).toMatchObject({ budgetCents: 775_000, quotedCents: q.subtotalCents, authorizedChangesCents: 740_000, committedCents: q.subtotalCents + 740_000, billedCents: 420_000, collectedCents: 0, forecastAtCompletionCents: null, determination: "partial" });
    expect(f1.reasons).toEqual(["Percent complete not stated — forecast at completion is unknown"]);
    await callerFor(office).project.percentCompleteState({ budgetRef: bud.budgetRef, percentComplete: 40 });
    const f2 = await callerFor(office).project.forecast({ jobId });
    expect(f2).toMatchObject({ percentComplete: 40, forecastAtCompletionCents: 1_050_000, determination: "computed" });

    // Another account sees none of it.
    const otherRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'Bravo Oil')", [otherRef, entityId]);
    const other = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: otherRef, email: "x@bravo.example", displayName: "Bravo" });
    const otherToken = (await portalCaller(other.invitationToken).portal.invitationAccept()).token;
    expect((await portalCaller(otherToken).portal.quotes()).quotes).toEqual([]);
    await expect(portalCaller(otherToken).portal.quoteAccept({ quoteRef: q.quoteRef, snapshotHash: issued.snapshotHash })).rejects.toThrow(/No such quote on this account/);
    await expect(portalCaller(otherToken).portal.changeOrderAuthorize({ changeOrderRef: co.changeOrderRef, snapshotHash: co.snapshotHash, decision: "declined" })).rejects.toThrow(/No such change order on this account/);
  });
});
