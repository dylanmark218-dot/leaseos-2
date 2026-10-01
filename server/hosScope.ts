/**
 * P0-A1 — the one boundary between a caller and another company's hours of service.
 *
 * The chain, read from the schema:
 *
 *   caller → organizationMemberships (live) → orgRef
 *          → coreRecordOwnership(recordType 'operator', recordId) → operators.id
 *          → dutyRecords.operatorId · hosAttestations.operatorId · complianceDocuments(ownerType 'operator')
 *
 * HOS rows carry no organization of their own (hosAttestations.orgRef is a denormalised copy of
 * the acting organization at write time, not the authority). The operator is the owned record, and
 * `coreRecordOwnership` is where ownership already lives for units and operators (P4.1). Nothing
 * here invents a second ownership column.
 *
 * Three rules every function below keeps:
 *
 *   1. A caller-supplied operator id is never authority. The database says whether that operator
 *      belongs to the caller's organization; the answer for one that does not is exactly the answer
 *      for one that does not exist — `NOT_FOUND`, "Operator N not found" — so ids cannot be probed.
 *   2. The organization comes from `resolveActingScopeStrict`: a live membership, or the
 *      single-tenant fallback ONLY for a person the membership table has never heard of. Two live
 *      memberships are refused (which company is meant has to be established, not guessed); an
 *      ended membership is refused (a fallback does not revive it).
 *   3. Lists filter in the query. There is no "fetch everything and drop the other company's rows
 *      in memory" path, and the unscoped list that used to exist (`listDutyRecords`) is gone.
 *
 * Routers consume what this returns — a scoped operator, scoped rows — rather than querying an id
 * and checking afterwards. `server/hosBoundaryGuard.test.ts` pins that the HOS router cannot reach
 * the duty or operator tables except through here.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte } from "drizzle-orm";
import { dutyRecords, operators } from "../drizzle/schema";
import { getDb, operatorForUserInScope, ownershipScopeWhere, type TenantScope } from "./db";
import { AmbiguousOrganization, RevivedFallbackRefused, resolveActingScopeStrict } from "./_core/actingScope";
import type { DutyEntry } from "./_core/hos";

export type HosScope = TenantScope & {
  userId: number;
  derivedFrom: "membership" | "single_tenant_fallback";
};

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** The same words a nonexistent id gets. Nothing about the company, the driver, or whether the row exists. */
export const operatorNotFound = (operatorId: number) => new TRPCError({ code: "NOT_FOUND", message: `Operator ${operatorId} not found` });

/**
 * Which organization this caller acts for, for HOS. Never read from input.
 *
 * Two live memberships → PRECONDITION_FAILED, the same mapping `financeScopeFor` uses.
 * A membership that ended → FORBIDDEN, with no organization named.
 */
export async function hosScopeFor(userId: number): Promise<HosScope> {
  const db = await dbOrThrow();
  try {
    const acting = await resolveActingScopeStrict(db, userId);
    return { tenantId: acting.tenantId, userId, derivedFrom: acting.derivedFrom };
  } catch (e) {
    if (e instanceof AmbiguousOrganization) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
    if (e instanceof RevivedFallbackRefused) throw new TRPCError({ code: "FORBIDDEN", message: "No active organization membership" });
    throw e;
  }
}

/** The predicate that keeps a duty-record query inside the caller's organization. Composable into any HOS read. */
export function dutyRecordsOwnedWhere(scope: TenantScope) {
  return ownershipScopeWhere("operator", dutyRecords.operatorId, scope);
}

/**
 * The operator, if the caller's organization owns it. Refused as not-found otherwise — the same
 * refusal a nonexistent id gets. This is the only way an HOS procedure turns an id into an operator.
 */
export async function requireHosOperatorInScope(scope: TenantScope, operatorId: number): Promise<{ id: number }> {
  const db = await dbOrThrow();
  const row = (await db.select({ id: operators.id }).from(operators)
    .where(and(eq(operators.id, operatorId), ownershipScopeWhere("operator", operators.id, scope))).limit(1))[0];
  if (!row) throw operatorNotFound(operatorId);
  return row;
}

/**
 * The duty entries the clocks are computed from, for an operator the caller's organization owns.
 * Ownership is proved before a single duty row is read; a foreign operator yields the not-found
 * refusal, never an empty (and therefore compliant-looking) record.
 */
export async function dutyEntriesInScope(scope: TenantScope, operatorId: number, since: Date): Promise<{ operatorId: number; entries: DutyEntry[]; rowsRead: number }> {
  const op = await requireHosOperatorInScope(scope, operatorId);
  const db = await dbOrThrow();
  const rows = await db.select({ dutyStatus: dutyRecords.dutyStatus, startedAt: dutyRecords.startedAt, endedAt: dutyRecords.endedAt })
    .from(dutyRecords)
    .where(and(eq(dutyRecords.operatorId, op.id), gte(dutyRecords.startedAt, since), dutyRecordsOwnedWhere(scope)));
  return { operatorId: op.id, entries: rows.map(r => ({ dutyStatus: r.dutyStatus, startedAt: r.startedAt, endedAt: r.endedAt })), rowsRead: rows.length };
}

/**
 * The duty-record list, filtered to the caller's organization in the query. With an operator id,
 * that operator must be the organization's (not-found otherwise); without one, every row returned
 * belongs to an operator the organization owns. Newest first, at most 500 — the limit the old
 * unscoped list had, now applied after the tenant predicate rather than instead of it.
 */
export async function listDutyRecordsInScope(scope: TenantScope, operatorId?: number) {
  if (operatorId != null) await requireHosOperatorInScope(scope, operatorId);
  const db = await dbOrThrow();
  return db.select().from(dutyRecords)
    .where(operatorId != null ? and(eq(dutyRecords.operatorId, operatorId), dutyRecordsOwnedWhere(scope)) : dutyRecordsOwnedWhere(scope))
    .orderBy(desc(dutyRecords.startedAt))
    .limit(500);
}

/**
 * The signed-in person's own operator record — but only if the caller's organization owns it. A
 * driver who left company B for company A does not keep writing B's duty records through their
 * old operator row; to A they have no operator record until A creates one.
 */
export async function selfOperatorInScope(scope: TenantScope, userId: number): Promise<{ id: number } | null> {
  const r = await operatorForUserInScope(userId, scope);
  return r.kind === "resolved" ? { id: r.operatorId } : null;
}
