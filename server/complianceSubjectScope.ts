/**
 * F1.2 — the one rule for whether a compliance subject is the caller's to act on. Moved here from
 * complianceRouter unchanged so the compliance procedures and the credential-verification service
 * (credentialVerificationService.ts) prove a subject the same way.
 */
import { TRPCError } from "@trpc/server";
import { actingScopeFor, getDb, jobInScope, operatorInScope, unitInScope, userInScope } from "./db";
import { assertCallerOwnsEntity } from "./_core/entityScope";
import { requireProvableOwnership } from "./ownershipDomain";

export type ComplianceOwnerType = "operator" | "unit" | "job" | "trailer" | "carrier" | "user" | "equipment";

/**
 * The subject of a credential or passport is one the caller's organization may see, through the
 * owner it already has: an operator or unit (trailers are units) through coreRecordOwnership, a job
 * through jobs.orgRef, a person through their membership, a carrier through the company's legal entity
 * (0146 — the id programPublish and profileReviewRecord record carrier compliance against). Anything
 * else answers `what`, the same answer a missing subject gets. Equipment has no owner yet: refused while
 * more than one company exists (UNKNOWN OWNERSHIP != GLOBAL ACCESS).
 */
export async function requireSubjectInScope(userId: number, ownerType: ComplianceOwnerType, ownerId: number, what: string): Promise<void> {
  if (ownerType === "equipment") return requireProvableOwnership("Equipment credentials", "equipment records carry an owner");
  if (ownerType === "carrier") {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    return assertCallerOwnsEntity(db as never, userId, ownerId, what);
  }
  const scope = await actingScopeFor(userId);
  const visible = ownerType === "operator" ? await operatorInScope(ownerId, scope)
    : ownerType === "unit" || ownerType === "trailer" ? await unitInScope(ownerId, scope)
    : ownerType === "job" ? await jobInScope(ownerId, scope)
    : await userInScope(ownerId, scope);
  if (!visible) throw new TRPCError({ code: "NOT_FOUND", message: what });
}
