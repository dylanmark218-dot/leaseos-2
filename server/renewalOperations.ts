/**
 * 0174 — renewal operations: the sweep, run by hand or on a schedule.
 *
 * One engine call. The Compliance tab's button and the production worker's
 * scheduled run both go through `runRenewalSweepForTenant`, which asks the
 * existing lifecycle engine (`planRenewalReminders`) what is due and delivers
 * it through the existing notification table. The scheduler decides *when*
 * the sweep runs and *who owns the run*; it makes no regulatory decision.
 *
 * Multi-instance safety: `scheduledJobRuns.slotKey` is unique, so for each job
 * and time slot exactly one INSERT wins; a losing instance does nothing. An
 * owner that dies mid-run leaves a lease that expires, and one other instance
 * may take the slot over by a conditional UPDATE that only one can win.
 * Notifications keep their own unique keys underneath, so even a takeover that
 * repeats work sends nothing twice.
 *
 * Failures are recorded, not swallowed: each becomes a SYSTEM_FAILURE on the
 * run row, surfaced in the Exception Centre. A failure never changes a
 * credential — its state stays whatever the canonical rule says.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { crewMembers, crews, credentialCompanySettings, externalTrainingHandoffs, scheduledJobRuns, workerQualifications } from "../drizzle/schema";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { categoryOf, escalationFor, type SweepFailure } from "./_core/complianceOperations";
import { crossedThreshold, planRenewalReminders, policyFor, type PlannedReminder, type WalletHolding } from "./_core/credentialLifecycle";
import { TERMINAL } from "./_core/externalTrainingHandoff";
import { academyAudit, academyHoldingsFor, asHolding, deliverReminders, settingsFor, syncCredentialPolicies, tenantSettings, tenantsForUsers } from "./trainingWalletService";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const RENEWAL_SWEEP_JOB = "credential-renewal-sweep";
export type SweepCounts = { inspected: number; actionable: number; notificationsCreated: number; suppressed: number; failures: SweepFailure[]; sentKeys: string[]; planned: number };
const zero = (): SweepCounts => ({ inspected: 0, actionable: 0, notificationsCreated: 0, suppressed: 0, failures: [], sentKeys: [], planned: 0 });

/** Test seam: lets a test make one step fail, to prove the failure is visible and changes no credential. */
export type SweepFaults = { failTenant?: (tenantId: string) => boolean; failNotificationWrite?: boolean };

/** The organizations that have anything a renewal sweep could act on. */
export async function tenantsToSweep(db: Db): Promise<string[]> {
  const q = await db.select({ t: workerQualifications.tenantId }).from(workerQualifications).groupBy(workerQualifications.tenantId);
  const h = await db.select({ t: externalTrainingHandoffs.tenantId }).from(externalTrainingHandoffs).groupBy(externalTrainingHandoffs.tenantId);
  const c = await db.select({ t: credentialCompanySettings.tenantId }).from(credentialCompanySettings);
  const academy = await academyHoldingsFor(db);
  const at = await tenantsForUsers(db, academy.map(a => a.userId!));
  const all = new Set<string>([...q.map(r => r.t ?? SINGLE_TENANT_ID), ...h.map(r => r.t), ...c.map(r => r.t), ...Array.from(at.values()).filter(t => t !== "ambiguous")]);
  return Array.from(all).sort();
}

/** The worker's crew supervisor, if one is on record. */
async function supervisorsFor(db: Db, userIds: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!userIds.length) return out;
  const rows = await db.select({ userId: crewMembers.userId, supervisor: crews.supervisorUserId }).from(crewMembers)
    .innerJoin(crews, eq(crews.crewRef, crewMembers.crewRef))
    .where(and(inArray(crewMembers.userId, Array.from(new Set(userIds))), isNull(crewMembers.leftAt), eq(crews.state, "active")));
  for (const r of rows) if (r.supervisor != null && !out.has(r.userId)) out.set(r.userId, r.supervisor);
  return out;
}

/**
 * Sweep one organization: verified wallet credentials, Academy-issued certificates
 * (TDG road), company review dates, and external-training deadlines.
 */
export async function runRenewalSweepForTenant(db: Db, tenantId: string, now: Date, actorUserId: number | null, faults: SweepFaults = {}): Promise<SweepCounts> {
  const out = zero();
  if (faults.failTenant?.(tenantId)) {
    out.failures.push({ kind: "TENANT_RESOLUTION_FAILED", tenantId, subjectRef: null, detail: "injected: tenant could not be resolved" });
    return out;
  }
  const settings = await tenantSettings(db, tenantId);
  for (const m of settings.malformed) out.failures.push({ kind: "POLICY_MALFORMED", tenantId, subjectRef: m, detail: `Company credential setting ${m} could not be read; LeaseOS defaults were used for it` });

  const tenantWhere = tenantId === SINGLE_TENANT_ID ? or(isNull(workerQualifications.tenantId), eq(workerQualifications.tenantId, SINGLE_TENANT_ID)) : eq(workerQualifications.tenantId, tenantId);
  const rows = await db.select().from(workerQualifications).where(and(tenantWhere, eq(workerQualifications.verificationState, "verified"))).limit(5000);
  const byUser = new Map<number, WalletHolding[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), asHolding(r)]);
  const academy = await academyHoldingsFor(db);
  const academyTenants = await tenantsForUsers(db, academy.map(a => a.userId!));
  for (const a of academy) {
    const t = academyTenants.get(a.userId!);
    if (t === "ambiguous") { out.failures.push({ kind: "TENANT_RESOLUTION_FAILED", tenantId: null, subjectRef: a.holdingRef, detail: "Academy certificate holder belongs to more than one organization; not reminded until that is resolved" }); continue; }
    if (t === tenantId) byUser.set(a.userId!, [...(byUser.get(a.userId!) ?? []), a]);
  }
  const supervisors = await supervisorsFor(db, Array.from(byUser.keys()));

  const planned: PlannedReminder[] = [];
  for (const [userId, hs] of Array.from(byUser.entries())) {
    for (const code of Array.from(new Set(hs.map(h => h.code)))) {
      out.inspected++;
      try {
        const policy = policyFor(code);
        if (policy && !policy.sourceRefs.length) out.failures.push({ kind: "SOURCE_RESOLUTION_FAILED", tenantId, subjectRef: policy.policyRef, detail: "Renewal policy names no authoritative source" });
        const escalation = escalationFor(settings.escalation, categoryOf(code, policy?.lifecycle ?? null));
        const p = planRenewalReminders({ userId, code, holdings: hs, policy, settings: settingsFor(settings, code), now, escalation, supervisorUserId: supervisors.get(userId) ?? null });
        if (p.length) out.actionable++;
        planned.push(...p);
      } catch (e) {
        out.failures.push({ kind: "LIFECYCLE_EVALUATION_FAILED", tenantId, subjectRef: `${userId}:${code}`, detail: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // External-training deadlines: an open request whose required-by date is close tells the office, once per threshold.
  const handoffs = await db.select().from(externalTrainingHandoffs).where(eq(externalTrainingHandoffs.tenantId, tenantId)).limit(2000);
  for (const h of handoffs) {
    if (TERMINAL.has(h.status) || !h.dueAt) continue;
    out.inspected++;
    const hit = crossedThreshold(h.dueAt, now, [14, 7, 1]);
    if (!hit) continue;
    out.actionable++;
    for (const role of ["safety", "hr"] as const) {
      planned.push({
        notificationKey: `handoff-due:${h.handoffRef}:${hit.threshold}:r:${role}`.slice(0, 200), recipient: { kind: "role", role }, holdingRef: h.handoffRef, code: h.qualificationCode,
        threshold: hit.threshold, targetKind: "legal_expiry", escalation: "supervisor_safety_admin", urgency: hit.threshold === "expired" ? "exception" : hit.threshold <= 7 ? "critical" : "urgent",
        title: `${hit.threshold === "expired" ? "Overdue" : `Due in ${hit.daysRemaining} day(s)`}: external training ${h.qualificationCode} for employee ${h.userId} (${h.status.replaceAll("_", " ").toLowerCase()})`,
        body: "The request is not complete. A request or booking does not satisfy any work; only a verified certificate does.",
      });
    }
  }

  out.planned = planned.length;
  if (faults.failNotificationWrite) {
    out.failures.push({ kind: "NOTIFICATION_WRITE_FAILED", tenantId, subjectRef: null, detail: `injected: ${planned.length} notice(s) not written` });
    return out;
  }
  try {
    const { sent, suppressed } = await deliverReminders(db, tenantId, planned, now);
    out.notificationsCreated = sent.length; out.suppressed = suppressed.length; out.sentKeys = sent.map(s => s.notificationKey);
  } catch (e) {
    out.failures.push({ kind: "NOTIFICATION_WRITE_FAILED", tenantId, subjectRef: null, detail: e instanceof Error ? e.message : String(e) });
  }
  await academyAudit(db, actorUserId, "renewal_sweep", tenantId, actorUserId == null ? "sweep.scheduled_tenant" : "sweep.run", { at: now, inspected: out.inspected, actionable: out.actionable, planned: out.planned, sent: out.notificationsCreated, suppressed: out.suppressed, failures: out.failures.map(f => f.kind) });
  return out;
}

/** The slot this moment belongs to, e.g. `credential-renewal-sweep:2026-09-23T14` for an hourly job. */
export function slotKeyFor(jobKey: string, now: Date, slotMinutes: number): string {
  const slot = Math.floor(now.getTime() / (slotMinutes * 60_000)) * slotMinutes * 60_000;
  return `${jobKey}:${new Date(slot).toISOString().slice(0, 16)}`;
}

export type ScheduledRunResult =
  | { ran: false; reason: "slot_owned_elsewhere" | "slot_already_completed"; slotKey: string }
  | { ran: true; runRef: string; slotKey: string; status: "completed" | "partial" | "failed"; counts: Omit<SweepCounts, "sentKeys"> & { tenants: number } };

/**
 * One scheduled sweep for the current slot, if this instance can own it. Safe to
 * call from every instance on every heartbeat: the first INSERT for a slot wins,
 * and everything else returns without work.
 */
export async function runScheduledRenewalSweep(db: Db, args: { ownerId: string; now?: Date; slotMinutes?: number; leaseSeconds?: number; faults?: SweepFaults }): Promise<ScheduledRunResult> {
  const now = args.now ?? new Date();
  const slotKey = slotKeyFor(RENEWAL_SWEEP_JOB, now, args.slotMinutes ?? 60);
  const leaseUntil = new Date(now.getTime() + (args.leaseSeconds ?? 900) * 1000);
  const runRef = `RUN-${randomUUID().toUpperCase()}`;
  let owned = false;
  try {
    await db.insert(scheduledJobRuns).values({ runRef, jobKey: RENEWAL_SWEEP_JOB, slotKey, ownerId: args.ownerId, status: "running", startedAt: now, leaseUntil });
    owned = true;
  } catch {
    // Somebody holds this slot. Take it over only if their lease ran out while it was still running.
    const res = await db.update(scheduledJobRuns).set({ ownerId: args.ownerId, runRef, startedAt: now, leaseUntil })
      .where(and(eq(scheduledJobRuns.slotKey, slotKey), eq(scheduledJobRuns.status, "running"), lt(scheduledJobRuns.leaseUntil, now)));
    owned = Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0) === 1;
    if (!owned) {
      const existing = (await db.select({ status: scheduledJobRuns.status }).from(scheduledJobRuns).where(eq(scheduledJobRuns.slotKey, slotKey)).limit(1))[0];
      return { ran: false, reason: existing && existing.status !== "running" ? "slot_already_completed" : "slot_owned_elsewhere", slotKey };
    }
  }

  const total = zero();
  let tenants: string[] = [];
  try {
    await syncCredentialPolicies(db);
    tenants = await tenantsToSweep(db);
    for (const t of tenants) {
      try {
        const c = await runRenewalSweepForTenant(db, t, now, null, args.faults);
        total.inspected += c.inspected; total.actionable += c.actionable; total.notificationsCreated += c.notificationsCreated;
        total.suppressed += c.suppressed; total.planned += c.planned; total.failures.push(...c.failures);
      } catch (e) {
        total.failures.push({ kind: "SWEEP_ABORTED", tenantId: t, subjectRef: null, detail: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    total.failures.push({ kind: "SWEEP_ABORTED", tenantId: null, subjectRef: null, detail: e instanceof Error ? e.message : String(e) });
  }
  const status = total.failures.some(f => f.kind === "SWEEP_ABORTED" && f.tenantId == null) ? "failed" as const : total.failures.length ? "partial" as const : "completed" as const;
  await db.update(scheduledJobRuns).set({
    status, completedAt: new Date(), inspected: total.inspected, actionable: total.actionable, notificationsCreated: total.notificationsCreated,
    suppressed: total.suppressed, failureCount: total.failures.length, failuresJson: JSON.stringify(total.failures.slice(0, 200)),
    errorSummary: total.failures.length ? Array.from(new Set(total.failures.map(f => f.kind))).join(", ").slice(0, 1000) : null,
  }).where(and(eq(scheduledJobRuns.slotKey, slotKey), eq(scheduledJobRuns.runRef, runRef)));
  await academyAudit(db, null, "renewal_sweep", slotKey, `sweep.scheduled_${status}`, { runRef, ownerId: args.ownerId, tenants: tenants.length, inspected: total.inspected, actionable: total.actionable, created: total.notificationsCreated, suppressed: total.suppressed, failures: total.failures.length });
  const { sentKeys: _drop, ...counts } = total;
  return { ran: true, runRef, slotKey, status, counts: { ...counts, tenants: tenants.length } };
}

/**
 * The production worker's hook. Called from the drain worker's heartbeat on every
 * pass; checks the database only when the slot changes, and never throws into the
 * worker loop — a failure is recorded on the run row and in the audit chain.
 */
export function createRenewalSweepTicker(args: { db: Db; ownerId: string; slotMinutes?: number; log?: (msg: string) => void }) {
  let lastSlot: string | null = null;
  let inFlight = false;
  return async function tick(at: Date) {
    const slot = slotKeyFor(RENEWAL_SWEEP_JOB, at, args.slotMinutes ?? 60);
    if (slot === lastSlot || inFlight) return;
    inFlight = true;
    try {
      const r = await runScheduledRenewalSweep(args.db, { ownerId: args.ownerId, now: at, slotMinutes: args.slotMinutes });
      lastSlot = slot;
      if (r.ran && r.status !== "completed") args.log?.(`renewal sweep ${r.slotKey}: ${r.status} (${r.counts.failures.length} failure(s))`);
    } catch (e) {
      args.log?.(`renewal sweep tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
    }
  };
}

/** Failures of recent runs, for the Exception Centre and the Compliance tab. */
export async function recentSweepFailures(db: Db, since: Date) {
  const rows = await db.select().from(scheduledJobRuns).where(and(eq(scheduledJobRuns.jobKey, RENEWAL_SWEEP_JOB), sql`${scheduledJobRuns.startedAt} >= ${since}`, sql`${scheduledJobRuns.failureCount} > 0`)).limit(100);
  return rows.flatMap(r => {
    let fs: SweepFailure[] = [];
    try { fs = JSON.parse(r.failuresJson ?? "[]"); } catch { fs = [{ kind: "SWEEP_ABORTED", tenantId: null, subjectRef: null, detail: "failure record unreadable" }]; }
    return fs.map(f => ({ ...f, runRef: r.runRef, at: r.completedAt ?? r.startedAt }));
  });
}
