/**
 * Queue a customer alert on the existing workflow notification queue, once
 * per identity per kind per subject, only to identities bound to the ticket's
 * account and only if they want it.
 */
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { customerAccounts, externalAlertPreferences, externalIdentities, financialEntities, workflowNotifications } from "../drizzle/schema";
import { alertText, wants, type AlertKind } from "./_core/customerAlerts";

/**
 * TEN-INBOX-1 — the organization a customer account's alerts belong to: the owner of the BOOK the account is
 * kept in (financialEntities.orgRef; NULL there is the historical single tenant, 0146). Not the account's own
 * `orgRef`, which names the client's organization, not the company serving it. An account, or a book, that
 * does not exist has no owner: null, and nothing is queued or shown.
 */
export async function customerAlertOwner(customerAccountId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const row = (await db.select({ orgRef: financialEntities.orgRef }).from(customerAccounts)
    .innerJoin(financialEntities, eq(financialEntities.id, customerAccounts.financialEntityId))
    .where(eq(customerAccounts.id, customerAccountId)).limit(1))[0];
  return row ? (row.orgRef ?? SINGLE_TENANT_ID) : null;
}

/**
 * v22.20 stamped the literal "default", then "the caller supplies it". No caller ever did, so every customer
 * alert went to the shared single-tenant bucket. TEN-INBOX-1: the owner is derived from the account's book,
 * never supplied, and an account whose owner cannot be established gets no alert.
 */
export async function queueCustomerAlert(args: { customerAccountId: number | null; kind: AlertKind; ticketNumber: string; jobCode?: string | null; detail?: string | null; subjectRef?: string }): Promise<{ queued: number }> {
  const db = await getDb();
  if (!db || args.customerAccountId == null) return { queued: 0 };
  const tenantId = await customerAlertOwner(args.customerAccountId);
  if (!tenantId) return { queued: 0 };
  const ids = await db.select({ id: externalIdentities.id, identityRef: externalIdentities.identityRef }).from(externalIdentities).where(and(eq(externalIdentities.customerAccountId, args.customerAccountId), eq(externalIdentities.status, "active")));
  if (!ids.length) return { queued: 0 };
  const prefs = await db.select().from(externalAlertPreferences).where(inArray(externalAlertPreferences.externalIdentityId, ids.map(i => i.id)));
  const text = alertText(args.kind, { ticketNumber: args.ticketNumber, jobCode: args.jobCode, detail: args.detail });
  let queued = 0;
  for (const i of ids) {
    if (!wants(prefs.filter(p => p.externalIdentityId === i.id).map(p => ({ eventKind: p.eventKind, enabled: p.enabled })), args.kind)) continue;
    const notificationKey = `customer:${args.kind}:${args.subjectRef ?? args.ticketNumber}:${i.identityRef}`.slice(0, 200);
    const dup = (await db.select({ id: workflowNotifications.id }).from(workflowNotifications).where(eq(workflowNotifications.notificationKey, notificationKey)).limit(1))[0];
    if (dup) continue;
    await db.insert(workflowNotifications).values({ notificationKey, taskId: null, workflowNumber: args.ticketNumber, tenantId, recipientRole: `external:${i.identityRef}`, recipientUserId: null, title: text.title, body: text.body, deepLink: text.deepLink, channel: "in_app", status: "queued", queuedAt: new Date() });
    queued++;
  }
  return { queued };
}
