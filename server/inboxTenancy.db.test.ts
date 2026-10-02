/**
 * TEN-INBOX-1 — a role match does not create tenant ownership. Against a real database.
 *
 * Organization A (manager, driver, safety) and organization B (the same three roles), a person with no
 * membership (the historical single tenant) and a person in both A and B. Tasks and notifications are
 * delivered only inside their own organization, and only when every record they name agrees; customer
 * alerts belong to the book their account is kept in; another organization's person's calendar is not
 * found; a workflow consequence is never suppressed by another organization's open task.
 * Rules: docs/register/TEN_INBOX_1_INBOX_TENANCY.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { runWithOrganizationSelection } from "./_core/organizationSelection";
import { customerAlertOwner, queueCustomerAlert } from "./customerAlertService";
import { applyEventConsequences, type SqlRunner } from "./_core/workflowRuntime";
import { buildDedupeKey, type DomainEvent, type WorkflowRule } from "./_core/workflowEngine";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 386_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const MISSING = 1_998_000_000 + Math.floor(Math.random() * 100_000);
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const ins = async (q: string, p: unknown[]) => (await pool.execute<mysql.ResultSetHeader>(q, p as never[]))[0].insertId;
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function person(orgRefs: string[], roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO users (id, openId, name) VALUES (?,?,?)", [userId, `inb-${userId}-${rnd()}`, `P ${userId}`]);
  for (const o of orgRefs) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, o, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
const jobOf = (o: string | null) => ins("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture", "Here", o]);
async function unitOf(o: string | null) {
  const id = await ins("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (o) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [o, id]);
  return id;
}
const entityOf = (o: string | null) => ins("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?,?,'corporation','CA-AB',?)", [`FE-${rnd()}`, "Books Ltd", o]);

/** A task, by title so it can be found in any inbox. */
async function task(tenantId: string, o: { role?: string; userId?: number; jobId?: number; unitId?: number }) {
  const title = `Task ${rnd()}`;
  const id = await ins("INSERT INTO operationalTasks (taskNumber, taskType, title, status, priority, tenantId, subjectType, subjectId, assignedRole, assignedUserId, jobId, unitId, dedupeKey) VALUES (?,'follow_up',?,'open','normal',?,'fixture',?,?,?,?,?,?)",
    [`TASK-${rnd()}`, title, tenantId, rnd(), o.role ?? "__nobody__", o.userId ?? null, o.jobId != null ? String(o.jobId) : null, o.unitId != null ? String(o.unitId) : null, `dk-${rnd()}`]);
  return { id, title };
}
async function notification(tenantId: string, o: { role?: string; userId?: number; taskId?: number }) {
  const title = `Note ${rnd()}`;
  await pool.execute("INSERT INTO workflowNotifications (notificationKey, tenantId, recipientRole, recipientUserId, taskId, title, queuedAt) VALUES (?,?,?,?,?,?,NOW())",
    [`nk-${rnd()}`, tenantId, o.role ?? null, o.userId ?? null, o.taskId ?? null, title]);
  return title;
}
const titlesIn = async (userId: number) => (await callerFor(userId).surfaces.inbox()).items.map(i => i.title);

let A: string, B: string;
let mA: number, dA: number, sA: number, mB: number, dB: number, sB: number, sDefault: number, both: number;
d("TEN-INBOX-1: a role match does not create tenant ownership", () => {
  beforeAll(async () => {
    A = await org(); B = await org();
    mA = await person([A], ["management"]); dA = await person([A], ["driver"]); sA = await person([A], ["safety"]);
    mB = await person([B], ["management"]); dB = await person([B], ["driver"]); sB = await person([B], ["safety"]);
    sDefault = await person([], ["safety"]);
    both = await person([A, B], ["safety"]);
  });

  it("delivers a role-addressed task to that role in its own organization only", async () => {
    const t = await task(A, { role: "safety" });
    expect(await titlesIn(sA)).toContain(t.title);
    expect(await titlesIn(sB)).not.toContain(t.title);          // same role, other organization
    expect(await titlesIn(sDefault)).not.toContain(t.title);    // same role, the single tenant
    expect(await titlesIn(mA)).not.toContain(t.title);          // same organization, other role
    // The historical single tenant is an organization like any other, not a shared bucket: its role-addressed
    // work reaches its own people, and no organization's.
    const legacy = await task("default", { role: "safety" });
    expect(await titlesIn(sDefault)).toContain(legacy.title);
    expect(await titlesIn(sA)).not.toContain(legacy.title);
    expect(await titlesIn(sB)).not.toContain(legacy.title);
  });

  it("keeps B's counts and My Day free of A's work", async () => {
    const t = await task(A, { role: "safety" });
    const n = await notification(A, { role: "safety" });
    const inboxB = await callerFor(sB).surfaces.inbox();
    expect(inboxB.items.map(i => i.title)).not.toEqual(expect.arrayContaining([t.title]));
    expect(inboxB.items.map(i => i.title)).not.toContain(n);
    expect(inboxB.total).toBe(inboxB.items.length);
    expect(inboxB.counts.task ?? 0).toBe(inboxB.items.filter(i => i.kind === "task").length);
    const dayB = JSON.stringify(await callerFor(sB).surfaces.myDay());
    expect(dayB).not.toContain(t.title);
    expect(dayB).not.toContain(n);
    const dayA = JSON.stringify(await callerFor(sA).surfaces.myDay());
    expect(dayA).toContain(t.title);
  });

  it("does not let a user id carry a notification across organizations", async () => {
    const mine = await notification(A, { userId: dA });
    expect(await titlesIn(dA)).toContain(mine);
    expect(await titlesIn(dB)).not.toContain(mine);
    // Addressed to A's driver but stamped B: the person does not override the organization.
    const crossed = await notification(B, { userId: dA });
    expect(await titlesIn(dA)).not.toContain(crossed);
    expect(await titlesIn(dB)).not.toContain(crossed);
  });

  it("shows a task or notification whose links disagree to nobody", async () => {
    const jB = await jobOf(B), uB = await unitOf(B), uA = await unitOf(A), jA = await jobOf(A);
    const fine = await task(A, { role: "safety", jobId: jA, unitId: uA });
    const jobConflict = await task(A, { role: "safety", jobId: jB });
    const unitConflict = await task(A, { role: "safety", unitId: uB });
    const dangling = await task(A, { role: "safety", unitId: MISSING });
    const otherTask = await task(B, { role: "safety" });
    const noteOnB = await notification(A, { role: "safety", taskId: otherTask.id });
    const [inA, inB] = [await titlesIn(sA), await titlesIn(sB)];
    expect(inA).toContain(fine.title);
    for (const t of [jobConflict.title, unitConflict.title, dangling.title, noteOnB]) {
      expect(inA, t).not.toContain(t);
      expect(inB, t).not.toContain(t);
    }
  });

  it("refuses an organization or user named in the request", async () => {
    for (const forged of [{ tenantId: B }, { orgRef: B }, { organizationId: B }, { userId: sB }]) {
      await expect(callerFor(sA).surfaces.inbox(forged as never)).rejects.toThrow();
      await expect(callerFor(sA).surfaces.myDay(forged as never)).rejects.toThrow();
    }
  });

  it("gives a person in two organizations the inbox of the one they selected, and nothing before they choose", async () => {
    const tA = await task(A, { role: "safety" }), tB = await task(B, { role: "safety" });
    await expect(callerFor(both).surfaces.inbox()).rejects.toThrow(/organization/i);
    const asA = await runWithOrganizationSelection(A, () => titlesIn(both));
    expect(asA).toContain(tA.title);
    expect(asA).not.toContain(tB.title);
    const asB = await runWithOrganizationSelection(B, () => titlesIn(both));
    expect(asB).toContain(tB.title);
    expect(asB).not.toContain(tA.title);
    // A selection the person does not hold is not honoured.
    const C = await org();
    await expect(runWithOrganizationSelection(C, () => titlesIn(both))).rejects.toThrow(/organization/i);
  });

  it("files a customer alert under the book its account is kept in, never the shared single tenant", async () => {
    const eA = await entityOf(A);
    const acct = await ins("INSERT INTO customerAccounts (accountRef, financialEntityId, name, orgRef) VALUES (?,?,?,?)", [`CUST-${rnd()}`, eA, "ABC Energy", B]);   // orgRef names the CLIENT, not the owner
    expect(await customerAlertOwner(acct)).toBe(A);
    const identityRef = `XID-${rnd()}`;
    await pool.execute("INSERT INTO externalIdentities (identityRef, kind, customerAccountId, email, displayName, tokenHash, invitedByUserId, invitedAt, status) VALUES (?,'customer',?,?,?,?,1,NOW(),'active')", [identityRef, acct, `x${rnd()}@abc.example`, "X", rnd()]);
    const ticket = `FT-${rnd()}`;
    expect((await queueCustomerAlert({ customerAccountId: acct, kind: "signoff_ready", ticketNumber: ticket })).queued).toBe(1);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT tenantId FROM workflowNotifications WHERE recipientRole = ?", [`external:${identityRef}`]);
    expect(rows.map(r => r.tenantId)).toEqual([A]);
    // An account whose book does not exist has no owner: nothing is queued anywhere.
    const orphan = await ins("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?,?,?)", [`CUST-${rnd()}`, MISSING, "Nobody"]);
    expect(await customerAlertOwner(orphan)).toBeNull();
    expect((await queueCustomerAlert({ customerAccountId: orphan, kind: "signoff_ready", ticketNumber: ticket })).queued).toBe(0);
    // A historical single-tenant book still has its owner.
    expect(await customerAlertOwner(await ins("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?,?,?)", [`CUST-${rnd()}`, await entityOf(null), "Legacy"]))).toBe("default");
  });

  it("shows a portal identity only the alerts its account's owner filed, and lets it acknowledge only those", async () => {
    const { createHash } = await import("node:crypto");
    const eA = await entityOf(A);
    const acct = await ins("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?,?,?)", [`CUST-${rnd()}`, eA, "ABC Energy"]);
    const token = `tok-${rnd()}-${rnd()}`, identityRef = `XID-${rnd()}`;
    await pool.execute("INSERT INTO externalIdentities (identityRef, kind, customerAccountId, email, displayName, tokenHash, invitedByUserId, invitedAt, acceptedAt, tokenExpiresAt, status) VALUES (?,'customer',?,?,?,?,1,NOW(),NOW(),DATE_ADD(NOW(), INTERVAL 1 DAY),'active')",
      [identityRef, acct, `p${rnd()}@abc.example`, "P", createHash("sha256").update(token).digest("hex")]);
    const portal = appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never }).portal;
    expect((await queueCustomerAlert({ customerAccountId: acct, kind: "signoff_ready", ticketNumber: `FT-${rnd()}` })).queued).toBe(1);
    // The same person's role string, stamped by another organization: not this identity's alert.
    const strayTitle = `Stray ${rnd()}`;
    const stray = await ins("INSERT INTO workflowNotifications (notificationKey, tenantId, recipientRole, title, queuedAt, status) VALUES (?,?,?,?,NOW(),'queued')", [`nk-${rnd()}`, B, `external:${identityRef}`, strayTitle]);
    const alerts = (await portal.alerts()).alerts;
    expect(alerts.map(x => x.title)).toContain("Ticket ready to sign");
    expect(alerts.map(x => x.title)).not.toContain(strayTitle);
    expect((await portal.approvalQueue()).unreadAlerts).toBe(1);
    await expect(portal.alertAcknowledge({ id: stray })).rejects.toThrow(/No such alert/);
    await expect(portal.alertAcknowledge({ id: alerts[0]!.id })).resolves.toMatchObject({ status: "acknowledged" });
  });

  it("shows another organization's person's calendar to nobody, and the caller's own colleagues' as before", async () => {
    const dispA = await person([A], ["dispatcher"]);
    const from = new Date("2027-03-01T00:00:00Z");
    await pool.execute("INSERT INTO leaveRequests (requestRef, userId, category, fromDate, toDate, requestedAt, status, tenantId) VALUES (?,?,'vacation',?,?,NOW(),'approved',?)", [`LV-${rnd()}`, dB, new Date("2027-03-03T00:00:00Z"), new Date("2027-03-05T00:00:00Z"), B]);
    await expect(callerFor(dispA).calendar.forScheduling({ userId: dB, from, days: 14 })).rejects.toThrow(/not found/i);
    await expect(callerFor(dispA).calendar.exceptions({ userId: dB, from, days: 14 })).rejects.toThrow(/not found/i);
    await expect(callerFor(dispA).calendar.forScheduling({ userId: dA, from, days: 14 })).resolves.toMatchObject({ userId: dA });
  });

  it("never lets another organization's open task suppress this organization's workflow consequence", async () => {
    const rule = {
      ruleKey: `ten.inbox.${rnd()}`, version: 1, name: "fixture", eventType: "test.happened", enabled: true,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"), tenantId: null, branchId: null, conditions: [], dedupeOn: ["subject.entityId"],
      actions: [{ kind: "create_task", taskType: "review_affected_assignments", title: "Fixture consequence", assignedRole: "office", priority: "normal" }],
    } as WorkflowRule;
    const subject = { entityType: "unit", entityId: `U-${rnd()}` };
    const event = (tenantId: string): DomainEvent => ({ id: `evt-${rnd()}`, type: "test.happened", version: 1, occurredAt: new Date(), recordedAt: new Date(), tenantId, actor: { source: "system" }, subject, payload: {} });
    const eB = event(B);
    // B already has the open task this rule would create for the subject.
    await pool.execute("INSERT INTO operationalTasks (taskNumber, taskType, title, status, priority, tenantId, subjectType, subjectId, assignedRole, dedupeKey) VALUES (?,'review_affected_assignments','B open','open','normal',?,?,?,'office',?)",
      [`TASK-${rnd()}`, B, subject.entityType, subject.entityId, buildDedupeKey(rule, eB, rule.actions[0] as never)]);
    const runner = pool as unknown as SqlRunner;
    expect((await applyEventConsequences(runner, event(A), [rule], new Date())).tasksCreated).toBe(1);
    // Within one organization, dedupe still holds.
    expect((await applyEventConsequences(runner, event(A), [rule], new Date())).tasksCreated).toBe(0);
  });

  it("refuses to file a requirement-licence task under nobody's organization", async () => {
    const src = (await import("node:fs")).readFileSync("server/requirementVerification.ts", "utf8");
    expect(src).not.toMatch(/orgRef \?\? "default"/);
    expect(src).toMatch(/if \(!row\.orgRef\) throw new VerificationError/);
    const fin = (await import("node:fs")).readFileSync("server/financeLegacyOwnership.ts", "utf8");
    expect(fin).not.toMatch(/\?\? "default"/);
    expect(fin).toMatch(/if \(!ent\) \{ await conn\.rollback\(\); return \{ assigned: false/);
  });

  it("keeps merchantMemory unreachable while it has no owner (owner ruling B3)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const prod = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (["node_modules", "dist"].includes(e.name) ? [] : prod(`${dir}/${e.name}`)) : (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));
    const files = prod("server");
    // Nothing imports the service; nothing outside the two defining files calls the extractor entry point that
    // accepts a merchant hint, or the confidence it computes from merchant history.
    const importers = files.filter(f => /from "\.\.?\/(?:[\w/]*\/)?merchantMemoryService"/.test(readFileSync(f, "utf8")));
    const callers = files.filter(f => !["server/_core/documentExtraction.ts", "server/merchantMemoryService.ts"].includes(f)
      && /\b(classifyDocument|merchantMemoryConfidence|recallMerchant|noteMerchant\w+)\s*\(/.test(readFileSync(f, "utf8")));
    const users = [...importers, ...callers];
    expect(users).toEqual([]);
  });
});
