/**
 * Queue a customer alert on the existing workflow notification queue, once
 * per identity per kind per subject, only to identities bound to the ticket's
 * account and only if they want it.
 */
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { externalAlertPreferences, externalIdentities, workflowNotifications } from "../drizzle/schema";
import { alertText, wants, type AlertKind } from "./_core/customerAlerts";

/**
 * v22.20 — `tenantId` was the literal "default". Harmless while the system was
 * single-tenant in fact, and exactly the line that would put one company's
 * customer alerts in another's inbox the day it stopped being. The caller
 * supplies it from server-owned context; absent, it falls back to the same
 * single tenant everything else falls back to, from one named constant rather
 * than a string typed here.
 */
export async function queueCustomerAlert(args: { customerAccountId: number | null; kind: AlertKind; ticketNumber: string; jobCode?: string | null; detail?: string | null; subjectRef?: string; tenantId?: string }): Promise<{ queued: number }> {
  const db = await getDb();
  if (!db || args.customerAccountId == null) return { queued: 0 };
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
    await db.insert(workflowNotifications).values({ notificationKey, taskId: null, workflowNumber: args.ticketNumber, tenantId: args.tenantId ?? SINGLE_TENANT_ID, recipientRole: `external:${i.identityRef}`, recipientUserId: null, title: text.title, body: text.body, deepLink: text.deepLink, channel: "in_app", status: "queued", queuedAt: new Date() });
    queued++;
  }
  return { queued };
}
