/**
 * v22.20 — the inbox, across organizations.
 *
 * A role-addressed alert is the case that matters. Person-addressed rows were
 * always safe; matching on a role string alone was not, and enforcement writing
 * role-addressed out-of-service alerts made that live.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { loadInbox } from "./surfacesService";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 11_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

async function anOrgWithMember() {
  const orgRef = `ORG-${rnd()}`;
  const userId = seq++;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `org ${orgRef}`]);
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId]);
  return { orgRef, userId };
}
async function roleNotification(tenantId: string | null, role: string, title: string) {
  const key = `test:${rnd()}`;
  await pool.execute(
    "INSERT INTO workflowNotifications (notificationKey, tenantId, recipientRole, recipientUserId, title, body, channel, status, queuedAt) VALUES (?,?,?,NULL,?,?,'in_app','queued',NOW())",
    [key, tenantId, role, title, "body"]);
  return key;
}

d("a role-addressed alert stays inside its organization", () => {
  const inbox = (userId: number) => loadInbox({ userId, roles: ["dispatcher"], canApprovePurchases: false, canResolveConflicts: false, canReviewAssistant: false });

  it("does not deliver another organization's dispatcher alert", async () => {
    const a = await anOrgWithMember();
    const b = await anOrgWithMember();
    const mine = `mine ${rnd()}`;
    const theirs = `theirs ${rnd()}`;
    await roleNotification(a.orgRef, "dispatcher", mine);
    await roleNotification(b.orgRef, "dispatcher", theirs);

    const forA = await inbox(a.userId);
    const titles = forA.map(i => i.title ?? "");
    expect(titles.some(t => t.includes(mine))).toBe(true);
    expect(titles.some(t => t.includes(theirs))).toBe(false);
  });

  it("has no null-tenant branch: an unowned row is nobody's (TEN-INBOX-1, owner ruling B5)", async () => {
    // Both tables forbid a NULL tenant, so the old "a row with no organization is still shown" branch matched
    // nothing — but it read as the rule. It is gone, and every task and notification read is strict and
    // checks the records the row names (taskInScope / notificationInScope).
    const { readFileSync } = await import("node:fs");
    const svc = readFileSync("server/surfacesService.ts", "utf8");
    expect(svc).not.toContain("isNull(workflowNotifications.tenantId)");
    expect(svc).not.toContain("isNull(operationalTasks.tenantId)");
    expect(svc).toContain("taskInScope(scope)");
    expect(svc).toContain("notificationInScope(scope)");
  });

  it("delivers to a member with no organization on the single-tenant fallback", async () => {
    const userId = seq++;
    const onDefault = `default ${rnd()}`;
    await roleNotification("default", "dispatcher", onDefault);
    const got = await loadInbox({ userId, roles: ["dispatcher"], canApprovePurchases: false, canResolveConflicts: false, canReviewAssistant: false });
    expect(got.map(i => i.title ?? "").some(t => t.includes(onDefault))).toBe(true);
  });

  it("does not deliver an organization's alert to somebody on the fallback", async () => {
    const a = await anOrgWithMember();
    const scoped = `scoped ${rnd()}`;
    await roleNotification(a.orgRef, "dispatcher", scoped);
    const stranger = seq++;
    const got = await loadInbox({ userId: stranger, roles: ["dispatcher"], canApprovePurchases: false, canResolveConflicts: false, canReviewAssistant: false });
    expect(got.map(i => i.title ?? "").some(t => t.includes(scoped))).toBe(false);
  });
});
