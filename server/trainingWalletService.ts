/**
 * 0172 — database side of the training wallet.
 *
 * Shared by the wallet router, the Academy dispatch check, the readiness
 * composer, the Exception Centre loader and the calendar, so each of them
 * reads a holding the same way. The decisions themselves stay in the pure
 * modules (`qualificationValidity`, `credentialLifecycle`); this file only
 * loads rows and writes the few things that must be written once.
 */
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { stableHash } from "./_core/trainingAcademy";
import { academyAuditEvents, academyQualifications, organizationMemberships, credentialCompanySettings, credentialRenewalPolicies, workerQualifications, workflowNotifications } from "../drizzle/schema";
import {
  CREDENTIAL_POLICIES, heldForWork, policyFor, policyHash, recoveryFor, suppressDelivered,
  type CompanyCredentialSettings, type PlannedReminder, type WalletHolding,
} from "./_core/credentialLifecycle";
import type { HeldVerdict, RequirementScope } from "./_core/qualificationValidity";
import { validateEscalation, type CredentialCategory, type EscalationPolicy } from "./_core/complianceOperations";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Row = typeof workerQualifications.$inferSelect;

export function parseList(text: string | null | undefined): string[] {
  if (!text) return [];
  try { const v = JSON.parse(text); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export const asHolding = (r: Row): WalletHolding => ({
  holdingRef: r.holdingRef, code: r.code, verificationState: r.verificationState,
  issuedAt: r.issuedAt, expiresAt: r.expiresAt, recordedAt: r.recordedAt,
  userId: r.userId, restrictions: parseList(r.restrictionsJson), supersededByHoldingRef: r.supersededByHoldingRef,
});

/** Every holding a person has, as the canonical rule reads it. */
export async function holdingRowsFor(db: Db, userIds: readonly number[]): Promise<Row[]> {
  if (!userIds.length) return [];
  return db.select().from(workerQualifications).where(inArray(workerQualifications.userId, Array.from(new Set(userIds)))).limit(5000);
}
export async function holdingsFor(db: Db, userId: number): Promise<WalletHolding[]> {
  return (await holdingRowsFor(db, [userId])).map(asHolding);
}

/** A requirement's scope, read from its own conditions. Only facts we can evaluate are read. */
export function scopeOf(conditionsJson: string | null | undefined): RequirementScope {
  if (!conditionsJson) return {};
  try { const c = JSON.parse(conditionsJson) as Record<string, unknown>; return { interprovincial: c.interprovincial === true }; } catch { return {}; }
}

/**
 * The canonical answer for each requirement, plus its way out. Used by
 * dispatch/readiness; nothing in here reads a handoff, a booking or a
 * practice score.
 */
export function canonicalVerdicts(
  holdings: readonly WalletHolding[],
  requirements: readonly { requirementCode: string; qualificationCode: string; conditionsJson?: string | null }[],
  at: Date,
): Map<string, HeldVerdict & { recoveryLabel: string | null; scope: RequirementScope }> {
  const out = new Map<string, HeldVerdict & { recoveryLabel: string | null; scope: RequirementScope }>();
  for (const r of requirements) {
    const scope = scopeOf(r.conditionsJson);
    const v = heldForWork(holdings, r.qualificationCode, at, scope);
    const upload = holdings.some(h => h.code === r.qualificationCode && (h.verificationState === "unverified" || h.verificationState === "extracted"));
    const recovery = recoveryFor(v, r.qualificationCode, policyFor(r.qualificationCode), upload && !v.held);
    out.set(r.requirementCode, { ...v, scope, recoveryLabel: recovery.length ? recovery.map(x => x.label).join(" → ") : null });
  }
  return out;
}

/** Install seeded renewal policies; refuse a row whose hash no longer matches its seed. */
export async function syncCredentialPolicies(db: Db): Promise<{ created: number; mismatched: string[] }> {
  let created = 0;
  const mismatched: string[] = [];
  for (const p of CREDENTIAL_POLICIES) {
    const existing = (await db.select().from(credentialRenewalPolicies).where(eq(credentialRenewalPolicies.policyRef, p.policyRef)).limit(1))[0];
    if (existing) { if (existing.policyHash !== policyHash(p)) mismatched.push(p.policyRef); continue; }
    await db.insert(credentialRenewalPolicies).values({
      policyRef: p.policyRef, qualificationCode: p.qualificationCode, displayName: p.displayName, jurisdiction: p.jurisdiction,
      policyVersion: p.policyVersion, boundary: p.boundary, lifecycle: p.lifecycle, typicalValidityMonths: p.typicalValidityMonths,
      regulatoryProfileRef: p.regulatoryProfileRef, parentAnyOfJson: p.parentAnyOf ? JSON.stringify(p.parentAnyOf) : null,
      handoffCapabilitiesJson: p.handoffCapabilities ? JSON.stringify(p.handoffCapabilities) : null,
      sourceRefsJson: JSON.stringify(p.sourceRefs), renewalPathwayJson: p.renewalPathway ? JSON.stringify(p.renewalPathway) : null,
      reminderTemplate: p.reminderTemplate, notes: p.notes, policyHash: policyHash(p), effectiveAt: new Date(p.effectiveAt),
    });
    created++;
  }
  return { created, mismatched };
}

export type TenantSettings = {
  thresholds: number[] | null;
  perCode: Record<string, Partial<CompanyCredentialSettings>>;
  /** 0174 — the company's escalation ladders by credential category (company policy). */
  escalation: Partial<Record<CredentialCategory | "default", EscalationPolicy>> | null;
  /** 0174 — settings that could not be read. Reported as a system failure, never silently defaulted away. */
  malformed: string[];
};
export async function tenantSettings(db: Db, tenantId: string): Promise<TenantSettings> {
  const row = (await db.select().from(credentialCompanySettings).where(eq(credentialCompanySettings.tenantId, tenantId)).limit(1))[0];
  if (!row) return { thresholds: null, perCode: {}, escalation: null, malformed: [] };
  const malformed: string[] = [];
  let thresholds: number[] | null = null, perCode: Record<string, Partial<CompanyCredentialSettings>> = {};
  let escalation: TenantSettings["escalation"] = null;
  try { thresholds = (JSON.parse(row.warningThresholdsJson) as unknown[]).map(Number); if (thresholds.some(n => !Number.isFinite(n))) throw new Error("non-numeric"); } catch { thresholds = null; malformed.push("warningThresholdsJson"); }
  try { perCode = row.perCodeJson ? JSON.parse(row.perCodeJson) : {}; } catch { perCode = {}; malformed.push("perCodeJson"); }
  try {
    escalation = row.escalationPolicyJson ? JSON.parse(row.escalationPolicyJson) : null;
    for (const [k, p] of Object.entries(escalation ?? {})) if (!p || validateEscalation(p as EscalationPolicy).length) { malformed.push(`escalationPolicyJson.${k}`); delete (escalation as Record<string, unknown>)[k]; }
  } catch { escalation = null; malformed.push("escalationPolicyJson"); }
  return { thresholds, perCode, escalation, malformed };
}
export function settingsFor(s: TenantSettings, code: string): Partial<CompanyCredentialSettings> {
  // With an escalation ladder configured, the ladder's own thresholds govern; the flat list is the older setting.
  return { warningThresholdDays: s.escalation ? undefined : s.thresholds ?? undefined, ...(s.perCode[code] ?? {}) };
}

/**
 * Deliver planned reminders exactly once each. The unique notificationKey is
 * the guard: a key already on file is suppressed, and a concurrent duplicate
 * insert is caught and counted as suppressed rather than sent twice.
 */
export async function deliverReminders(db: Db, tenantId: string, planned: readonly PlannedReminder[], now: Date): Promise<{ sent: PlannedReminder[]; suppressed: PlannedReminder[] }> {
  if (!planned.length) return { sent: [], suppressed: [] };
  const keys = planned.map(p => p.notificationKey);
  const existing = await db.select({ k: workflowNotifications.notificationKey }).from(workflowNotifications).where(inArray(workflowNotifications.notificationKey, keys));
  const { send, suppressed } = suppressDelivered(planned, new Set(existing.map(e => e.k)));
  const sent: PlannedReminder[] = [];
  for (const p of send) {
    try {
      await db.insert(workflowNotifications).values({
        notificationKey: p.notificationKey, tenantId,
        recipientUserId: p.recipient.kind === "user" ? p.recipient.userId : null,
        recipientRole: p.recipient.kind === "role" ? p.recipient.role : null,
        title: p.title.slice(0, 220), body: p.body, deepLink: `/training/wallet?code=${encodeURIComponent(p.code)}`,
        channel: "in_app", status: "queued", queuedAt: now,
      });
      sent.push(p);
    } catch {
      suppressed.push(p);
    }
  }
  return { sent, suppressed };
}

/**
 * Academy-issued qualifications (TDG employer certificates, company sign-offs) live in
 * `academyQualifications`, not the wallet table. For reminders and exceptions they are read as
 * holdings — current = verified — so a TDG road certificate is reminded on from its server-computed
 * expiry exactly like a wallet credential. They are never written back to the wallet.
 */
export async function academyHoldingsFor(db: Db, userIds?: readonly number[]): Promise<WalletHolding[]> {
  const base = db.select().from(academyQualifications);
  const rows = userIds ? (userIds.length ? await base.where(inArray(academyQualifications.userId, Array.from(new Set(userIds)))).limit(5000) : []) : await base.where(eq(academyQualifications.status, "current")).limit(5000);
  return rows.filter(r => r.status === "current").map(r => ({
    holdingRef: r.qualificationRef, code: r.qualificationCode, verificationState: "verified" as const, issuedAt: r.validFrom, expiresAt: r.expiresAt,
    recordedAt: r.createdAt, userId: r.userId, restrictions: [], supersededByHoldingRef: null,
  }));
}

/** The organization a person belongs to, as the acting-scope rule would resolve it (no memberships = the single tenant). */
export async function tenantsForUsers(db: Db, userIds: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!userIds.length) return out;
  const m = await db.select({ userId: organizationMemberships.userId, orgRef: organizationMemberships.orgRef }).from(organizationMemberships).where(and(inArray(organizationMemberships.userId, Array.from(new Set(userIds))), eq(organizationMemberships.status, "active")));
  for (const u of userIds) { const orgs = Array.from(new Set(m.filter(x => x.userId === u).map(x => x.orgRef))); out.set(u, orgs.length === 1 ? orgs[0]! : orgs.length === 0 ? SINGLE_TENANT_ID : "ambiguous"); }
  return out;
}

/** Whether a verified holding is the current one (not superseded). */
export const isCurrentVerified = (r: Pick<Row, "verificationState" | "supersededByHoldingRef">) => r.verificationState === "verified" && !r.supersededByHoldingRef;

/**
 * Append to the Academy's hash-chained audit log — the same chain and format
 * `trainingAcademyRouter` writes, so wallet and handoff history sit beside
 * certificate history rather than in a second log.
 */
export async function academyAudit(db: Db, actorUserId: number | null, subjectType: string, subjectRef: string, eventType: string, payload: unknown) {
  const previous = (await db.select({ eventHash: academyAuditEvents.eventHash }).from(academyAuditEvents).orderBy(desc(academyAuditEvents.id)).limit(1))[0]?.eventHash ?? null;
  const eventRef = `ACAD-EVT-${randomUUID().toUpperCase()}`;
  const body = JSON.stringify(payload ?? {});
  const eventHash = stableHash({ eventRef, actorUserId, subjectType, subjectRef, eventType, body, previous });
  await db.insert(academyAuditEvents).values({ eventRef, actorUserId, subjectType, subjectRef, eventType, eventJson: body, previousHash: previous, eventHash });
  return eventHash;
}
