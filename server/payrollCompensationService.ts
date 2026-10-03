/**
 * Payroll P1 — data access for compensation agreements, versions, rules and the earning-code catalogue.
 *
 * Nothing here decides who may act (the router's gate and `ctx.money` do) and nothing here invents a
 * rule: the pure engine (`_core/payrollCompensation.ts`) validates, canonicalizes, hashes and resolves;
 * this module reads and writes rows, in transactions where two rows must agree.
 *
 * D3: `payRates` is not touched by anything in this file. NEW configuration lives here; the legacy rate
 * path keeps serving historical earnings through `payrollService.listPayRates`.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  compensationAgreementVersions,
  compensationAgreements,
  compensationEarningRules,
  earningCodes,
  employeePayrollProfiles,
  financialEntities,
  operators,
  organizationWorkers,
  userRoleAssignments,
} from "../drizzle/schema";
import { grantsInOrganization, type RoleGrant } from "./_core/recordsAuthorization";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { decide } from "./_core/commercialApprovalService";
import {
  canonicalRuleSet,
  headlineAmountCents,
  supersessionPlan,
  rulesHash,
  type CanonicalRuleSet,
  type CompensationBasis,
  type DateText,
  type EarningRuleInput,
  type WorkerClassification,
} from "./_core/payrollCompensation";

/**
 * A `date` column comes back from mysql2 as a JS Date at LOCAL midnight (drizzle's string mode adds no
 * mapper), so it is read back with local getters — never toISOString, which would shift the day in any
 * timezone east or west of UTC. A string is trusted only in YYYY-MM-DD form.
 */
export function dateText(v: unknown): DateText | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const t = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`Not a calendar date: ${String(v)}`);
  return t;
}
const withDates = <T extends Record<string, unknown>>(row: T, keys: readonly (keyof T)[]): T => {
  const out = { ...row };
  for (const k of keys) (out as Record<string, unknown>)[k as string] = dateText(row[k]);
  return out;
};
const codeDates = ["activeFrom", "activeUntil"] as const;
const agreementDates = ["startsOn", "endsOn"] as const;
const versionDates = ["effectiveFrom", "effectiveUntil"] as const;

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/* ------------------------------------------------------------------ */
/* Earning codes                                                       */
/* ------------------------------------------------------------------ */

/** The catalogue a book sees: the shared seed plus the book's own rows. A book's row with a seed's code is its override. */
export async function listEarningCodesForBooks(entityIds: readonly number[]) {
  const db = await getDb();
  if (!db) return [];
  const where = entityIds.length ? or(isNull(earningCodes.financialEntityId), inArray(earningCodes.financialEntityId, [...entityIds])) : isNull(earningCodes.financialEntityId);
  const rows = await db.select().from(earningCodes).where(where).orderBy(asc(earningCodes.code), asc(earningCodes.financialEntityId)).limit(1000);
  return rows.map(r => withDates(r, codeDates));
}

/** Resolve one code for one book on a date: the book's own row first, else the shared seed. A retired code resolves only before its `activeUntil`. */
export async function resolveEarningCode(code: string, financialEntityId: number, onDate: DateText) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(earningCodes)
    .where(and(eq(earningCodes.code, code), or(isNull(earningCodes.financialEntityId), eq(earningCodes.financialEntityId, financialEntityId))))
    .then(rs => rs.map(r => withDates(r, codeDates)));
  // Retirement closes the window at `activeUntil`; a date before it still resolves the code (retire-from-date, not retire-everywhere).
  const usable = rows.filter(r => r.activeFrom! <= onDate && (r.activeUntil === null || onDate < r.activeUntil));
  return usable.find(r => r.financialEntityId === financialEntityId) ?? usable.find(r => r.financialEntityId === null) ?? null;
}

export async function loadEarningCodeByRef(codeRef: string) {
  const db = await getDb();
  if (!db) return null;
  const r = (await db.select().from(earningCodes).where(eq(earningCodes.codeRef, codeRef)).limit(1))[0];
  return r ? withDates(r, codeDates) : null;
}

/** Create a book's own code (an override when a seed shares the code). The shared seed is never written. */
export async function createBookEarningCode(values: Omit<typeof earningCodes.$inferInsert, "codeRef" | "codeKey"> & { financialEntityId: number }) {
  const db = await getDb();
  if (!db) return undefined;
  const codeRef = ref("EC");
  await db.insert(earningCodes).values({ ...values, codeRef });
  return codeRef;
}

/** Retire a book's own code. Historical versions keep the code text and id on their rules. */
export async function retireBookEarningCode(args: { id: number; retiredByUserId: number; activeUntil: DateText }) {
  const db = await getDb();
  if (!db) return;
  await db.update(earningCodes).set({ retiredByUserId: args.retiredByUserId, retiredAt: new Date(), activeUntil: args.activeUntil }).where(eq(earningCodes.id, args.id));
}

/* ------------------------------------------------------------------ */
/* Classification (D9) — evidence for the pure mapper                  */
/* ------------------------------------------------------------------ */

export async function loadProfile(employeePayrollProfileId: number) {
  const db = await getDb();
  if (!db) return null;
  return (await db.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, employeePayrollProfileId)).limit(1))[0] ?? null;
}

/**
 * The organizationWorkers row for a profile, in the organization that owns the profile's book: by user
 * first, then by operator. A worker row in another organization is not this profile's.
 */
export async function loadOrganizationWorkerForProfile(profile: { userId: number | null; operatorId: number | null; financialEntityId: number }) {
  const db = await getDb();
  if (!db) return null;
  const entity = (await db.select({ orgRef: financialEntities.orgRef }).from(financialEntities).where(eq(financialEntities.id, profile.financialEntityId)).limit(1))[0];
  if (!entity?.orgRef) return null;
  const conds = [];
  if (profile.userId != null) conds.push(eq(organizationWorkers.userId, profile.userId));
  if (profile.operatorId != null) conds.push(eq(organizationWorkers.operatorId, profile.operatorId));
  if (!conds.length) return null;
  const rows = await db
    .select({ workerRef: organizationWorkers.workerRef, workerType: organizationWorkers.workerType, userId: organizationWorkers.userId })
    .from(organizationWorkers)
    .where(and(eq(organizationWorkers.orgRef, entity.orgRef), eq(organizationWorkers.status, "active"), or(...conds)))
    .orderBy(asc(organizationWorkers.id));
  return rows.find(r => profile.userId != null && r.userId === profile.userId) ?? rows[0] ?? null;
}

/**
 * Legacy evidence for the D9 mapper: an operator record, and the live roles the person holds IN THE
 * ORGANIZATION THAT OWNS THE PROFILE'S BOOK (B23.1). A role another employer granted says nothing about
 * this employment.
 */
export async function legacyClassificationEvidence(profile: { userId: number | null; operatorId: number | null; financialEntityId: number }) {
  const db = await getDb();
  if (!db) return { hasOperator: false, roles: [] as string[] };
  const hasOperator = profile.operatorId != null && (await db.select({ id: operators.id }).from(operators).where(eq(operators.id, profile.operatorId)).limit(1)).length === 1;
  if (profile.userId == null) return { hasOperator, roles: [] as string[] };
  const entity = (await db.select({ orgRef: financialEntities.orgRef }).from(financialEntities).where(eq(financialEntities.id, profile.financialEntityId)).limit(1))[0];
  const grants = (await db
    .select({ role: userRoleAssignments.role, scopeType: userRoleAssignments.scopeType, orgRef: userRoleAssignments.orgRef, scopeRef: userRoleAssignments.scopeRef })
    .from(userRoleAssignments)
    .where(and(eq(userRoleAssignments.userId, profile.userId), isNull(userRoleAssignments.revokedAt))))
    .map(r => ({ role: r.role as string, scopeType: r.scopeType as RoleGrant["scopeType"], orgRef: r.orgRef ?? null, scopeRef: r.scopeRef ?? null }));
  const roles = grantsInOrganization(grants, entity?.orgRef ?? SINGLE_TENANT_ID).map(g => g.role);
  return { hasOperator, roles };
}

export async function recordProfileClassification(args: { employeePayrollProfileId: number; classification: WorkerClassification; source: "organization_worker" | "legacy_mapped"; workerRef: string | null }) {
  const db = await getDb();
  if (!db) return;
  await db.update(employeePayrollProfiles).set({ workerClassification: args.classification, classificationSource: args.source, organizationWorkerRef: args.workerRef }).where(eq(employeePayrollProfiles.id, args.employeePayrollProfileId));
}

/* ------------------------------------------------------------------ */
/* Agreements                                                          */
/* ------------------------------------------------------------------ */

export async function listAgreements(entityIds: readonly number[]) {
  const db = await getDb();
  if (!db || !entityIds.length) return [];
  const rows = await db.select().from(compensationAgreements).where(inArray(compensationAgreements.financialEntityId, [...entityIds])).orderBy(desc(compensationAgreements.id)).limit(500);
  return rows.map(r => withDates(r, agreementDates));
}

export async function loadAgreementById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const r = (await db.select().from(compensationAgreements).where(eq(compensationAgreements.id, id)).limit(1))[0];
  return r ? withDates(r, agreementDates) : null;
}

export async function loadAgreement(agreementRef: string) {
  const db = await getDb();
  if (!db) return null;
  const r = (await db.select().from(compensationAgreements).where(eq(compensationAgreements.agreementRef, agreementRef)).limit(1))[0];
  return r ? withDates(r, agreementDates) : null;
}

/** Agreements of a profile that are not ended and whose windows overlap the candidate's. */
export async function overlappingAgreements(args: { employeePayrollProfileId: number; startsOn: DateText; endsOn: DateText | null }) {
  const db = await getDb();
  if (!db) return [];
  const rows = (await db.select().from(compensationAgreements).where(and(eq(compensationAgreements.employeePayrollProfileId, args.employeePayrollProfileId), inArray(compensationAgreements.status, ["draft", "active"])))).map(r => withDates(r, agreementDates));
  const end = args.endsOn ?? "9999-12-31";
  return rows.filter(r => r.startsOn < end && args.startsOn < (r.endsOn ?? "9999-12-31"));
}

export async function createAgreement(values: Omit<typeof compensationAgreements.$inferInsert, "agreementRef">) {
  const db = await getDb();
  if (!db) return undefined;
  const agreementRef = ref("CA");
  await db.insert(compensationAgreements).values({ ...values, agreementRef });
  return agreementRef;
}

/* ------------------------------------------------------------------ */
/* Versions and rules                                                  */
/* ------------------------------------------------------------------ */

export async function listVersions(agreementId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(compensationAgreementVersions).where(eq(compensationAgreementVersions.agreementId, agreementId)).orderBy(asc(compensationAgreementVersions.version));
  return rows.map(r => withDates(r, versionDates));
}

export async function loadVersion(versionRef: string) {
  const db = await getDb();
  if (!db) return null;
  const r = (await db.select().from(compensationAgreementVersions).where(eq(compensationAgreementVersions.versionRef, versionRef)).limit(1))[0];
  return r ? withDates(r, versionDates) : null;
}

export async function listRules(versionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(compensationEarningRules).where(eq(compensationEarningRules.versionId, versionId)).orderBy(asc(compensationEarningRules.sortOrder), asc(compensationEarningRules.id));
}

export type ProposeVersionArgs = {
  agreement: { id: number; financialEntityId: number };
  effectiveFrom: DateText;
  effectiveUntil: DateText | null;
  basis: CompensationBasis;
  currency: string;
  rules: Array<EarningRuleInput & { earningCodeId: number }>;
  proposedByUserId: number;
  notes: string | null;
};

/**
 * Insert a version and its rules in one transaction. The version number is the next for the agreement,
 * read under the agreement row's lock so two proposals cannot share one. The canonical rule set and its
 * hash are computed here from the same inputs that are stored, so the stored hash is the hash of the
 * stored rules.
 */
export async function proposeVersion(args: ProposeVersionArgs): Promise<{ versionRef: string; version: number; rulesHash: string; canonical: CanonicalRuleSet } | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return db.transaction(async tx => {
    await tx.select({ id: compensationAgreements.id }).from(compensationAgreements).where(eq(compensationAgreements.id, args.agreement.id)).for("update").limit(1);
    const last = (await tx.select({ v: sql<number>`coalesce(max(${compensationAgreementVersions.version}), 0)` }).from(compensationAgreementVersions).where(eq(compensationAgreementVersions.agreementId, args.agreement.id)))[0];
    const version = Number(last?.v ?? 0) + 1;
    const canonical = canonicalRuleSet({ basis: args.basis, currency: args.currency }, args.rules);
    const hash = rulesHash(canonical);
    const versionRef = ref("CAV");
    const r = await tx.insert(compensationAgreementVersions).values({
      versionRef, agreementId: args.agreement.id, financialEntityId: args.agreement.financialEntityId, version,
      effectiveFrom: args.effectiveFrom, effectiveUntil: args.effectiveUntil, basis: args.basis, currency: canonical.currency,
      rulesHash: hash, rulesJson: canonical, status: "proposed", proposedByUserId: args.proposedByUserId, proposedAt: new Date(), notes: args.notes,
    });
    const versionId = Number(r[0]?.insertId);
    for (let i = 0; i < args.rules.length; i++) {
      const rule = args.rules[i]!;
      await tx.insert(compensationEarningRules).values({
        ruleRef: ref("CER"), versionId, earningCodeId: rule.earningCodeId, earningCode: rule.earningCode, calculation: rule.calculation, unit: rule.unit,
        rateMillis: rule.rateMillis ?? null, percentMillis: rule.percentMillis ?? null,
        overtimeRuleJson: rule.overtimeRule ?? null, eligibleRevenueBasisJson: rule.eligibleRevenueBasis ?? null,
        minimumMeasurementAuthority: rule.minimumMeasurementAuthority ?? null, requiresJob: rule.requiresJob ?? false, requiresUnit: rule.requiresUnit ?? false,
        sortOrder: rule.sortOrder ?? i,
      });
    }
    return { versionRef, version, rulesHash: hash, canonical };
  });
}

export type ApprovalOutcome =
  | { outcome: "approved"; approvalRef: string; superseded: string[] }
  | { outcome: "awaiting"; approvalRef: string; awaiting: string }
  | { outcome: "blocked"; reason: string }
  | { outcome: "not_proposed" }
  | { outcome: "overlap"; reason: string };

/**
 * D4 — approve a version through the commercial approval ladder (`decide`, 0136), and apply the result in
 * the SAME transaction: the version row is locked and must still be proposed; the approved versions of the
 * agreement are re-read under lock and the supersession plan recomputed from them (approved windows never
 * overlap); the ledger records the signature; only on `satisfied` does the version become approved and its
 * predecessor closed. A ledger that says "awaiting" (a second person is required by a book's tier) leaves
 * the version proposed. Nothing is written when the ladder refuses.
 */
export async function approveVersionThroughLedger(args: { versionRef: string; actorUserId: number; note?: string }): Promise<ApprovalOutcome> {
  const db = await getDb();
  if (!db) return { outcome: "not_proposed" };
  return db.transaction(async tx => {
    const v0 = (await tx.select().from(compensationAgreementVersions).where(eq(compensationAgreementVersions.versionRef, args.versionRef)).for("update").limit(1))[0];
    if (!v0 || v0.status !== "proposed") return { outcome: "not_proposed" as const };
    const v = withDates(v0, versionDates);
    const siblings = (await tx.select().from(compensationAgreementVersions).where(and(eq(compensationAgreementVersions.agreementId, v.agreementId), eq(compensationAgreementVersions.status, "approved"))).for("update"))
      .map(r => withDates(r, versionDates));
    const plan = supersessionPlan(siblings.map(s => ({ versionRef: s.versionRef, status: s.status, effectiveFrom: s.effectiveFrom!, effectiveUntil: s.effectiveUntil })), { versionRef: v.versionRef, effectiveFrom: v.effectiveFrom!, effectiveUntil: v.effectiveUntil });
    if (!plan.ok) return { outcome: "overlap" as const, reason: plan.reason };
    const rules = await tx.select({ rateMillis: compensationEarningRules.rateMillis }).from(compensationEarningRules).where(eq(compensationEarningRules.versionId, v.id));
    const d = await decide(tx as never, {
      actorUserId: args.actorUserId, category: "compensation_agreement", subjectType: "compensationVersion", subjectRef: v.versionRef,
      amountCents: headlineAmountCents(rules as never), preparedByUserId: v.proposedByUserId, decision: "approved", note: args.note,
    });
    if (d.outcome === "blocked") return { outcome: "blocked" as const, reason: d.reason };
    if (d.outcome === "refused") return { outcome: "blocked" as const, reason: "The approval ledger records a refusal for this version" };
    if (d.outcome === "awaiting") return { outcome: "awaiting" as const, approvalRef: d.approvalRef, awaiting: d.awaiting };
    let supersedesVersionId: number | null = null;
    for (const c of plan.close) {
      const prior = siblings.find(s => s.versionRef === c.versionRef)!;
      await tx.update(compensationAgreementVersions).set({ effectiveUntil: c.effectiveUntil, status: "superseded", supersededByVersionId: v.id }).where(eq(compensationAgreementVersions.id, prior.id));
      supersedesVersionId = prior.id;
    }
    await tx.update(compensationAgreementVersions).set({ status: "approved", approvedByUserId: args.actorUserId, approvedAt: new Date(), approvalRef: d.approvalRef, supersedesVersionId }).where(eq(compensationAgreementVersions.id, v.id));
    await tx.update(compensationAgreements).set({ status: "active" }).where(and(eq(compensationAgreements.id, v.agreementId), eq(compensationAgreements.status, "draft")));
    return { outcome: "approved" as const, approvalRef: d.approvalRef, superseded: plan.close.map(c => c.versionRef) };
  });
}

/** Reject through the same ladder: a refusal needs the same standing as an approval, never the proposer's. */
export async function rejectVersionThroughLedger(args: { versionRef: string; actorUserId: number; reason: string }): Promise<{ outcome: "rejected"; approvalRef: string } | { outcome: "blocked"; reason: string } | { outcome: "not_proposed" }> {
  const db = await getDb();
  if (!db) return { outcome: "not_proposed" };
  return db.transaction(async tx => {
    const v = (await tx.select().from(compensationAgreementVersions).where(eq(compensationAgreementVersions.versionRef, args.versionRef)).for("update").limit(1))[0];
    if (!v || v.status !== "proposed") return { outcome: "not_proposed" as const };
    const rules = await tx.select({ rateMillis: compensationEarningRules.rateMillis }).from(compensationEarningRules).where(eq(compensationEarningRules.versionId, v.id));
    const d = await decide(tx as never, {
      actorUserId: args.actorUserId, category: "compensation_agreement", subjectType: "compensationVersion", subjectRef: v.versionRef,
      amountCents: headlineAmountCents(rules as never), preparedByUserId: v.proposedByUserId, decision: "refused", note: args.reason,
    });
    if (d.outcome !== "refused") return { outcome: "blocked" as const, reason: d.outcome === "blocked" ? d.reason : `Ledger answered ${d.outcome}` };
    await tx.update(compensationAgreementVersions).set({ status: "rejected", rejectedByUserId: args.actorUserId, rejectedAt: new Date(), rejectionReason: args.reason, approvalRef: d.approvalRef }).where(eq(compensationAgreementVersions.id, v.id));
    return { outcome: "rejected" as const, approvalRef: d.approvalRef };
  });
}
