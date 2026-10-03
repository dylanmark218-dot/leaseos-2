/**
 * The legacy `jobUnits.create`, under the enforcement setting.
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { actingScopeFor, getDb, jobInScope, jobScopeSubquery, ownershipScopeWhere, unitInScope, type TenantScope } from "./db";
import { dispatchEligibilityChecks, dispatchEnforcementSettings, dispatchOverrides, jobUnits, operators, type InsertJobUnit } from "../drizzle/schema";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { currentMode, decideLegacyAssignment, type EnforcementMode } from "./_core/dispatchEnforcement";
import { composeReadiness } from "./readinessComposer";
import type { DispatchBlocker } from "./_core/dispatchReadiness";
import type { GrantedOverride, StoredEligibilityCheck } from "./_core/dispatchAward";

export async function loadEnforcementMode(financialEntityId: number | null): Promise<{ mode: EnforcementMode; source: "entity" | "global" | "default" }> {
  const db = await getDb();
  if (!db) return { mode: "off", source: "default" };
  const rows = await db.select({ id: dispatchEnforcementSettings.id, financialEntityId: dispatchEnforcementSettings.financialEntityId, mode: dispatchEnforcementSettings.mode, setAt: dispatchEnforcementSettings.setAt })
    .from(dispatchEnforcementSettings).orderBy(desc(dispatchEnforcementSettings.setAt), desc(dispatchEnforcementSettings.id)).limit(200);
  return currentMode(rows, financialEntityId);
}

export type GatedJobUnitInput = InsertJobUnit & {
  eligibilityCheckId?: number | null;
  /** C1a — the caller's organization, required: a check taken by another organization is "not found". */
  actingScope: TenantScope;
};

export type GatedJobUnitResult = { id: number; mode: EnforcementMode; checkId: number | null; exceptions: string[] };

/* ------------------------------------------------------------------ */
/* C1a — grants and tenant scope, shared by the award and the legacy path */
/* ------------------------------------------------------------------ */

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * The granted overrides on a check, as the award reads them: the GRANTOR's identity, never the
 * requester's. A granted row with no recorded grantor (every row written before 0174) is not a
 * grant — it cannot show that anyone other than the requester approved it.
 */
export async function loadGrantedOverrides(db: Db, checkId: number): Promise<GrantedOverride[]> {
  const rows = await db.select().from(dispatchOverrides).where(and(eq(dispatchOverrides.eligibilityCheckId, checkId), eq(dispatchOverrides.granted, true)));
  return rows
    .filter(g => g.grantedByUserId != null && g.grantedAt != null)
    .map(g => ({
      blockerCode: g.blockerCode,
      requestedByUserId: g.requestedByUserId,
      grantedByUserId: g.grantedByUserId!,
      grantedByRole: g.grantedByRole ?? "",
      reason: g.grantReason ?? "",
      grantedAt: g.grantedAt!,
      policyRef: g.policyRef ?? null,
      expiresAt: g.expiresAt ?? null,
    }));
}

/** The caller's organization, from membership — never from input. */
export async function dispatchScopeFor(userId: number): Promise<TenantScope> {
  return actingScopeFor(userId);
}

const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

/**
 * Every identity a readiness names must be visible to the caller's organization. Refused as "not
 * found" — never "forbidden" — so another tenant's ids cannot even be confirmed to exist.
 */
export async function assertReadinessSubjectInScope(
  db: Db,
  scope: TenantScope,
  subject: { operatorId: number; unitId: number | null; trailerId?: number | null; jobId?: number | null },
): Promise<void> {
  const op = await db.select({ id: operators.id }).from(operators)
    .where(and(eq(operators.id, subject.operatorId), ownershipScopeWhere("operator", operators.id, scope))).limit(1);
  if (!op.length) throw notFound("Operator");
  if (subject.unitId != null && !(await unitInScope(subject.unitId, scope))) throw notFound("Unit");
  if (subject.trailerId != null && !(await unitInScope(subject.trailerId, scope))) throw notFound("Trailer");
  if (subject.jobId != null && !(await jobInScope(subject.jobId, scope))) throw notFound("Job");
}

/** A stored check belongs to the organization that took it (NULL = the historical single tenant). */
export function checkInScope(check: { orgRef: string | null }, scope: TenantScope): boolean {
  return (check.orgRef ?? SINGLE_TENANT_ID) === scope.tenantId;
}

/**
 * Off: as always. Advisory: assign and report findings. Enforced: assign only
 * on a valid check — facts recomputed here, never trusted from the caller.
 */
export async function createJobUnitGated(input: GatedJobUnitInput): Promise<GatedJobUnitResult> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const now = new Date();
  const { mode } = await loadEnforcementMode(null); // legacy jobs carry no entity — global scope
  const { eligibilityCheckId, actingScope: _scope, ...row } = input;

  let check: StoredEligibilityCheck | null = null;
  let granted: GrantedOverride[] = [];
  let checkRouteApprovalRef: string | null = null;
  let checkTrailerId: number | null = null;
  if (eligibilityCheckId != null) {
    const c = (await db.select().from(dispatchEligibilityChecks).where(eq(dispatchEligibilityChecks.id, eligibilityCheckId)).limit(1))[0];
    // C1a — scope first: another organization's check is "not found", before anything about it is compared.
    if (!c || !checkInScope(c, input.actingScope)) throw new TRPCError({ code: "NOT_FOUND", message: "Eligibility check not found" });
    if (c.jobId != null && c.jobId !== input.jobId) throw new TRPCError({ code: "BAD_REQUEST", message: `Check ${c.id} is for job ${c.jobId}, not job ${input.jobId}` });
    if (c.unitId != null && c.unitId !== input.unitId) throw new TRPCError({ code: "BAD_REQUEST", message: `Check ${c.id} is for a different unit` });
    check = { checkId: c.id, fingerprint: c.fingerprint ?? "MISSING", operatorId: c.operatorId, verdict: c.verdict as StoredEligibilityCheck["verdict"], blockers: JSON.parse(c.blockersJson ?? "[]") as DispatchBlocker[], evaluatedAt: c.evaluatedAt, explanation: "" };
    // C1a-3 — the grantor, from the grant columns. This used to copy the requester into the grantor.
    granted = await loadGrantedOverrides(db, c.id);
    checkRouteApprovalRef = c.routeApprovalRef ?? null;
    checkTrailerId = c.trailerId ?? null;
  }

  // Facts are recomputed only when there is something to compare them to and
  // enforcement cares. In advisory mode with no operator we still record.
  const currentFacts = mode !== "off" && check && input.operatorId
    // R-8 — the recompute asks the same question the check asked, route included; without it every
    // route-bound check fingerprint-mismatched in enforced mode.
    ? (await composeReadiness({ operatorId: input.operatorId, unitId: input.unitId, trailerId: checkTrailerId, jobId: input.jobId, routeApprovalRef: checkRouteApprovalRef }, now)).facts
    : null;

  const decision = decideLegacyAssignment({
    mode, check, currentFacts, grantedOverrides: granted,
    subject: { operatorId: input.operatorId ?? check?.operatorId ?? -1, unitId: input.unitId, jobId: input.jobId }, now,
  });
  if (!decision.allowed) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Dispatch enforced — ${decision.refusals.join("; ")}` });

  const ins = await db.insert(jobUnits).values({ ...row, eligibilityCheckId: decision.checkId, enforcementModeAtCreate: mode });
  if (decision.checkId != null) await db.update(dispatchEligibilityChecks).set({ usedForAward: true }).where(eq(dispatchEligibilityChecks.id, decision.checkId));
  return { id: Number(ins[0]?.insertId ?? 0), mode, checkId: decision.checkId, exceptions: decision.exceptions };
}

/** Advisory-mode assignments made without a check, or against a blocked/unknown one — for the exception centre. */
/** SEC-1: the caller's organization only — an assignment belongs to its job. */
export async function loadUngatedAssignments(fs: TenantScope, limit = 200): Promise<{ jobUnitId: number; jobId: number; unitId: number; operatorId: number | null; createdAt: Date; finding: string }[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: jobUnits.id, jobId: jobUnits.jobId, unitId: jobUnits.unitId, operatorId: jobUnits.operatorId, createdAt: jobUnits.createdAt, checkId: jobUnits.eligibilityCheckId, verdict: dispatchEligibilityChecks.verdict })
    .from(jobUnits).leftJoin(dispatchEligibilityChecks, eq(dispatchEligibilityChecks.id, jobUnits.eligibilityCheckId))
    .where(and(eq(jobUnits.enforcementModeAtCreate, "advisory"), inArray(jobUnits.jobId, jobScopeSubquery(db, fs)))).orderBy(desc(jobUnits.createdAt)).limit(limit);
  return rows
    .filter(r => r.checkId == null || r.verdict === "blocked" || r.verdict === "unknown")
    .map(r => ({ jobUnitId: r.id, jobId: r.jobId, unitId: r.unitId, operatorId: r.operatorId, createdAt: r.createdAt, finding: r.checkId == null ? "Assignment made without a readiness check" : `Assignment made against a ${r.verdict} check` }));
}
