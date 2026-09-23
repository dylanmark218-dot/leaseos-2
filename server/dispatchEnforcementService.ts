/**
 * The legacy `jobUnits.create`, under the enforcement setting.
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, jobScopeSubquery, type TenantScope } from "./db";
import { dispatchEligibilityChecks, dispatchEnforcementSettings, dispatchOverrides, jobUnits, type InsertJobUnit } from "../drizzle/schema";
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

export type GatedJobUnitInput = InsertJobUnit & { eligibilityCheckId?: number | null };

export type GatedJobUnitResult = { id: number; mode: EnforcementMode; checkId: number | null; exceptions: string[] };

/**
 * Off: as always. Advisory: assign and report findings. Enforced: assign only
 * on a valid check — facts recomputed here, never trusted from the caller.
 */
export async function createJobUnitGated(input: GatedJobUnitInput): Promise<GatedJobUnitResult> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const now = new Date();
  const { mode } = await loadEnforcementMode(null); // legacy jobs carry no entity — global scope
  const { eligibilityCheckId, ...row } = input;

  let check: StoredEligibilityCheck | null = null;
  let granted: GrantedOverride[] = [];
  if (eligibilityCheckId != null) {
    const c = (await db.select().from(dispatchEligibilityChecks).where(eq(dispatchEligibilityChecks.id, eligibilityCheckId)).limit(1))[0];
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Eligibility check not found" });
    if (c.jobId != null && c.jobId !== input.jobId) throw new TRPCError({ code: "BAD_REQUEST", message: `Check ${c.id} is for job ${c.jobId}, not job ${input.jobId}` });
    if (c.unitId != null && c.unitId !== input.unitId) throw new TRPCError({ code: "BAD_REQUEST", message: `Check ${c.id} is for a different unit` });
    check = { checkId: c.id, fingerprint: c.fingerprint ?? "MISSING", operatorId: c.operatorId, verdict: c.verdict as StoredEligibilityCheck["verdict"], blockers: JSON.parse(c.blockersJson ?? "[]") as DispatchBlocker[], evaluatedAt: c.evaluatedAt, explanation: "" };
    granted = (await db.select().from(dispatchOverrides).where(and(eq(dispatchOverrides.eligibilityCheckId, c.id), eq(dispatchOverrides.granted, true))))
      .map(g => ({ blockerCode: g.blockerCode, grantedByUserId: g.requestedByUserId, grantedByRole: g.requestedByRole, reason: g.reason ?? "", grantedAt: g.requestedAt }));
  }

  // Facts are recomputed only when there is something to compare them to and
  // enforcement cares. In advisory mode with no operator we still record.
  const currentFacts = mode !== "off" && check && input.operatorId
    ? (await composeReadiness({ operatorId: input.operatorId, unitId: input.unitId, trailerId: null, jobId: input.jobId }, now)).facts
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
export async function loadUngatedAssignments(limit = 200, scope?: TenantScope): Promise<{ jobUnitId: number; jobId: number; unitId: number; operatorId: number | null; createdAt: Date; finding: string }[]> {
  const db = await getDb();
  if (!db) return [];
  // 0174: scoped to the jobs the caller's organization owns, in the query and before the limit.
  const jobScope = scope ? inArray(jobUnits.jobId, jobScopeSubquery(db, scope)) : undefined;
  const rows = await db.select({ id: jobUnits.id, jobId: jobUnits.jobId, unitId: jobUnits.unitId, operatorId: jobUnits.operatorId, createdAt: jobUnits.createdAt, checkId: jobUnits.eligibilityCheckId, verdict: dispatchEligibilityChecks.verdict })
    .from(jobUnits).leftJoin(dispatchEligibilityChecks, eq(dispatchEligibilityChecks.id, jobUnits.eligibilityCheckId))
    .where(and(eq(jobUnits.enforcementModeAtCreate, "advisory"), jobScope)).orderBy(desc(jobUnits.createdAt)).limit(limit);
  return rows
    .filter(r => r.checkId == null || r.verdict === "blocked" || r.verdict === "unknown")
    .map(r => ({ jobUnitId: r.id, jobId: r.jobId, unitId: r.unitId, operatorId: r.operatorId, createdAt: r.createdAt, finding: r.checkId == null ? "Assignment made without a readiness check" : `Assignment made against a ${r.verdict} check` }));
}
