/**
 * P8.5 — the vault's procedures against the database.
 *
 * The cases chosen are the ones where the subsystem could look built and not be: a restricted
 * matter appearing in an ordinary list, a read served without a log, a decline that leaves an
 * investigation behind, a revoked grant that a session keeps using.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let nextId = 960_000 + Math.floor(Math.random() * 30_000);
const rnd = () => Math.random().toString(36).slice(2, 8);
beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });

const callerFor = (u: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: u, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = ++nextId;
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}
async function incident(over: Record<string, unknown> = {}) {
  const cols = { incidentNumber: `INC-${rnd().toUpperCase()}`, incidentType: "incident", severity: "moderate", originalStatement: "Fixture statement for the vault tests.", originalStatementSource: "typed", occurredAt: new Date(), reportedAt: new Date(), injuryReported: 0, status: "open", ...over };
  const keys = Object.keys(cols);
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO incidentReports (${keys.map(k => `\`${k}\``).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    keys.map(k => (cols as Record<string, unknown>)[k]));
  return Number(r.insertId);
}

d("the vault, end to end", () => {
  it("keeps a restricted matter out of the ordinary list entirely", async () => {
    const mgr = await withRole("management");
    const id = await incident();
    await callerFor(mgr).restrictedVault.matterOpen({ incidentReportId: id, matterType: "WCB_CLAIM" });
    const inv = await callerFor(mgr).restrictedVault.matterOpen({ incidentReportId: id, matterType: "INTERNAL_INVESTIGATION" });
    expect(inv.restricted).toBe(true);

    const list = await callerFor(mgr).restrictedVault.mattersForIncident({ incidentReportId: id });
    expect(list.matters.map(m => m.matterType)).toEqual(["WCB_CLAIM"]);
    // Not redacted, not "1 restricted item hidden" — absent. A count still says one exists.
    // Assert on the tracking number: a bare id like "2" appears inside other numbers in the JSON,
    // so that form of the check would pass for the wrong reason.
    expect(JSON.stringify(list)).not.toContain(inv.trackingNumber);
    expect(list.note).toMatch(/would still say one exists/);
  }, 90_000);

  it("refuses the read without a grant, logs the refusal, then serves it after break-glass and logs that", async () => {
    const mgr = await withRole("management");
    const id = await incident();
    const inv = await callerFor(mgr).restrictedVault.matterOpen({ incidentReportId: id, matterType: "INTERNAL_INVESTIGATION" });

    const denied = await callerFor(mgr).restrictedVault.restrictedRead({ matterId: inv.matterId });
    expect(denied.served).toBe(false);
    if (denied.served) throw new Error("unreachable");
    expect(denied.code).toBe("BREAK_GLASS_REQUIRED");
    expect(denied.promptRequired).toBe(true);

    await expect(callerFor(mgr).restrictedVault.breakGlass({
      recordType: "incidentMatter", recordId: inv.matterId, purpose: "audit",
    })).rejects.toThrow(/category, not a purpose/);

    const grant = await callerFor(mgr).restrictedVault.breakGlass({
      recordType: "incidentMatter", recordId: inv.matterId,
      purpose: "Checking whether the September 12 near-miss names the same unit as this matter.",
    });
    const served = await callerFor(mgr).restrictedVault.restrictedRead({ matterId: inv.matterId });
    expect(served.served).toBe(true);

    const history = await callerFor(mgr).restrictedVault.accessHistory({ recordType: "incidentMatter", recordId: inv.matterId });
    const actions = history.events.map(e => e.action);
    expect(actions).toContain("DENIED");            // the refused attempt is on the record too
    expect(actions).toContain("GRANT_CREATED");
    expect(actions).toContain("READ");
    const read = history.events.find(e => e.action === "READ")!;
    expect(read.grantId).toBe(grant.grantId);
    expect(read.purpose).toMatch(/near-miss names the same unit/);   // stored verbatim
  }, 90_000);

  it("makes revocation immediate rather than trusting an open session", async () => {
    const mgr = await withRole("management");
    const id = await incident();
    const inv = await callerFor(mgr).restrictedVault.matterOpen({ incidentReportId: id, matterType: "INTERNAL_INVESTIGATION" });
    const grant = await callerFor(mgr).restrictedVault.breakGlass({
      recordType: "incidentMatter", recordId: inv.matterId,
      purpose: "Reviewing the matter before the quarterly safety meeting on the 30th.",
    });
    expect((await callerFor(mgr).restrictedVault.restrictedRead({ matterId: inv.matterId })).served).toBe(true);
    await callerFor(mgr).restrictedVault.grantRevoke({ grantId: grant.grantId });
    const after = await callerFor(mgr).restrictedVault.restrictedRead({ matterId: inv.matterId });
    expect(after.served).toBe(false);
    if (after.served) throw new Error("unreachable");
    expect(after.code).toBe("GRANT_REVOKED");       // named, not silently indistinguishable from expiry
  }, 90_000);

  it("proposes from a rule and creates nothing at all when the company declines", async () => {
    const mgr = await withRole("management");
    const id = await incident({ injuryReported: 1 });
    const p = await callerFor(mgr).restrictedVault.investigationPropose({ incidentReportId: id });
    expect(p.proposed).toBe(true);
    if (!p.proposed) throw new Error("unreachable");
    expect(p.triggerRule).toBe("injury_reported");

    const decided = await callerFor(mgr).restrictedVault.investigationDecide({
      proposalId: p.proposalId!, disposition: "HANDLED_INTERNALLY",
    });
    expect(decided.matterId).toBeNull();
    expect(decided.note).toMatch(/nothing about the matter's substance was stored/);

    // No investigation row exists for this incident, in any form.
    const [matters] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM incidentMatters WHERE incidentReportId = ? AND matterType = 'INTERNAL_INVESTIGATION'", [id]);
    expect(Number(matters[0]!.n)).toBe(0);
    // But the decision is on the record: who, when, which rule. A reason was not required.
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT disposition, decidedByUserId, decidedAt, triggerRule, decisionReason, matterId FROM investigationProposals WHERE id = ?", [p.proposalId]);
    expect(rows[0]).toMatchObject({ disposition: "HANDLED_INTERNALLY", decidedByUserId: mgr, triggerRule: "injury_reported", decisionReason: null, matterId: null });
    expect(rows[0]!.decidedAt).not.toBeNull();
  }, 90_000);

  it("proposes nothing when no rule fires, rather than inventing a reason to", async () => {
    const mgr = await withRole("management");
    const id = await incident({ severity: "minor" });
    const p = await callerFor(mgr).restrictedVault.investigationPropose({ incidentReportId: id });
    expect(p.proposed).toBe(false);
    expect(p.note).toMatch(/not a finding that nothing happened/);
  }, 90_000);

  it("gives every matter a tracking number that does not say what kind it is", async () => {
    const mgr = await withRole("management");
    const id = await incident();
    const wcb = await callerFor(mgr).restrictedVault.matterOpen({ incidentReportId: id, matterType: "WCB_CLAIM" });
    const inv = await callerFor(mgr).restrictedVault.matterOpen({ incidentReportId: id, matterType: "INTERNAL_INVESTIGATION" });
    for (const t of [wcb.trackingNumber, inv.trackingNumber]) {
      expect(t).toMatch(/^MTR-\d{4}-\d{6}$/);
      expect(t).not.toMatch(/INV|WCB/);
    }
  }, 90_000);
});
