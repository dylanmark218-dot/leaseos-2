/**
 * The one door through which a compliance credential is verified or rejected.
 *
 * Every procedure that can decide a `complianceDocuments` row calls `decideComplianceCredential`:
 *   - compliance.credentialVerify               (complianceRouter)
 *   - fieldRoute.identity.documents.review       (routers.ts)
 *   - driverPortfolio.credentialVerify           (driverPortfolioRouter)
 * and workforce.trainingVerify, which mints an already-verified credential from a training record,
 * applies the same separation-of-duties rule through `assertMayDecide`.
 *
 * What it enforces, whatever the caller:
 *   1. the subject is in the verifier's organization (requireSubjectInScope — out of scope is
 *      "not found", the answer a missing credential gets);
 *   2. separation of duties (_core/credentialVerificationPolicy): not the credential's own subject,
 *      not whoever recorded or submitted it;
 *   3. state: only `needs_review` is decided — a rejected credential is resubmitted as a new version,
 *      never flipped back to verified;
 *   4. concurrency: the update is conditional on `needs_review` and must change exactly one row, so
 *      two reviewers holding the same stale read cannot both succeed;
 *   5. provenance: verifiedByUserId / verifiedAt on the row; for an operator's credential, the same
 *      append-only portfolio audit event whichever procedure decided it. The event names the
 *      decision, the path and any date the reviewer corrected — never the document's identifier,
 *      storage key or contents.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { complianceDocuments, operators } from "../drizzle/schema";
import { actingScopeFor } from "./db";
import { affectedRows } from "./_core/enforcementCommit";
import { verificationRefusal, type CredentialDecision } from "./_core/credentialVerificationPolicy";
import { credentialHistory, credentialType } from "./_core/driverPortfolio";
import { isMedicalDocType } from "./_core/compliancePassport";
import { requireSubjectInScope, type ComplianceOwnerType } from "./complianceSubjectScope";
import { dbOrThrow, loadPortfolios, orgRefFor, recordPortfolioEvent, submitterOf, type CredentialRow, type Db } from "./driverPortfolioService";

export type DecisionPath = "compliance.credentialVerify" | "documents.review" | "driverPortfolio.credentialVerify";

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The person a credential is about, when it is about a person: an operator's user, or the user. */
export async function credentialSubjectUserId(db: Db, doc: Pick<CredentialRow, "ownerType" | "ownerId">): Promise<number | null> {
  if (doc.ownerType === "user") return doc.ownerId;
  if (doc.ownerType !== "operator") return null;
  const op = (await db.select({ userId: operators.userId }).from(operators).where(eq(operators.id, doc.ownerId)).limit(1))[0];
  return op?.userId ?? null;
}

/** Whoever entered it: the 0236 column, plus the portfolio's own upload row for rows older than it. */
export async function credentialRecorders(db: Db, doc: Pick<CredentialRow, "id" | "recordedByUserId">): Promise<number[]> {
  const out = new Set<number>();
  if (doc.recordedByUserId != null) out.add(doc.recordedByUserId);
  const submitter = await submitterOf(db, doc.id);
  if (submitter != null) out.add(submitter);
  return Array.from(out);
}

export type EntryPath = "compliance.credentialRecord" | "documents.create";

/**
 * The portfolio's entry row for an operator's credential recorded outside the portfolio, so the
 * audit names who entered it whichever path did (driverPortfolio.submitCredential writes its own).
 * Private and medical rows get none: the portfolio audit never projects them, and the 0236
 * `recordedByUserId` column is their provenance. The detail names the type and path, never the
 * identifier, storage key or contents.
 */
export async function recordCredentialEntry(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], e: {
  credentialId: number; ownerType: string; ownerId: number; docType: string; privateDetail: boolean;
  actorUserId: number; path: EntryPath; at: Date;
}): Promise<void> {
  if (e.ownerType !== "operator" || e.privateDetail || isMedicalDocType(e.docType) || !e.credentialId) return;
  const label = credentialType(e.docType)?.label ?? e.docType;
  await recordPortfolioEvent(db, {
    orgRef: orgRefFor(await actingScopeFor(e.actorUserId)), operatorId: e.ownerId, credentialId: e.credentialId, actorUserId: e.actorUserId,
    eventType: "credential_uploaded", detail: `${label} recorded via ${e.path} for verification`, at: e.at,
  });
}

/** The separation-of-duties and state rule, raised as the procedure's error. */
export function assertMayDecide(facts: Parameters<typeof verificationRefusal>[0]): void {
  const refusal = verificationRefusal(facts);
  if (refusal) throw new TRPCError({ code: refusal.code, message: refusal.message });
}

export type DecisionInput = {
  credentialId: number;
  outcome: CredentialDecision;
  verifierUserId: number;
  path: DecisionPath;
  note?: string | null;
  /** The dates as read from the certificate, when the upload's differ or are missing. */
  expiresAt?: Date | null;
  issuedAt?: Date | null;
  /** A caller may narrow which credentials it decides (the portfolio: catalogue, non-private, operators). */
  accept?: (doc: CredentialRow) => boolean;
  notFoundMessage?: string;
};

export async function decideComplianceCredential(input: DecisionInput): Promise<{ credentialId: number; verificationStatus: CredentialDecision }> {
  const db = await dbOrThrow();
  const missing = () => new TRPCError({ code: "NOT_FOUND", message: input.notFoundMessage ?? "Credential not found" });
  const doc = (await db.select().from(complianceDocuments).where(eq(complianceDocuments.id, input.credentialId)).limit(1))[0];
  if (!doc) throw missing();
  // 1. Scope first: nothing about an out-of-scope credential — not even its state — is answered.
  await requireSubjectInScope(input.verifierUserId, doc.ownerType as ComplianceOwnerType, doc.ownerId, input.notFoundMessage ?? "Credential not found");
  if (input.accept && !input.accept(doc)) throw missing();
  // 2 and 3. Separation of duties, then state.
  assertMayDecide({
    verifierUserId: input.verifierUserId,
    subjectUserId: await credentialSubjectUserId(db, doc),
    recordedByUserIds: await credentialRecorders(db, doc),
    state: doc.verificationStatus,
  });

  const now = new Date();
  const orgRef = orgRefFor(await actingScopeFor(input.verifierUserId));
  const type = credentialType(doc.docType);
  await db.transaction(async tx => {
    // For an operator's catalogue credential: what was in force before, so a renewal can say what it replaced.
    let previous: { id: number; capturedAt: Date } | null = null;
    if (doc.ownerType === "operator" && type) {
      const op = (await tx.select().from(operators).where(eq(operators.id, doc.ownerId)).limit(1))[0];
      if (op) {
        const [{ portfolio: before }] = await loadPortfolios(tx, [op]);
        previous = credentialHistory(before.credentials, type.code, now).current
          ?? before.credentials.filter(c => c.id !== doc.id && c.verificationStatus === "verified" && credentialType(c.docType)?.code === type.code)
            .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime() || b.id - a.id)[0] ?? null;
      }
    }
    // 4. Conditional on the state that was judged; exactly one row, or another decision won.
    const decided = await tx.update(complianceDocuments).set({
      verificationStatus: input.outcome, verifiedByUserId: input.verifierUserId, verifiedAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
    }).where(and(eq(complianceDocuments.id, doc.id), eq(complianceDocuments.verificationStatus, "needs_review")));
    if (affectedRows(decided) !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Another decision on this credential completed first" });

    // 5. The same audit row whichever procedure decided an operator's credential.
    if (doc.ownerType === "operator") {
      const label = type?.label ?? doc.docType;
      const corrected = [
        input.expiresAt !== undefined && (input.expiresAt?.getTime() ?? null) !== (doc.expiresAt?.getTime() ?? null)
          ? `expiry ${doc.expiresAt ? day(doc.expiresAt) : "none"} → ${input.expiresAt ? day(input.expiresAt) : "none"}` : null,
        input.issuedAt !== undefined && (input.issuedAt?.getTime() ?? null) !== (doc.issuedAt?.getTime() ?? null)
          ? `issued ${doc.issuedAt ? day(doc.issuedAt) : "none"} → ${input.issuedAt ? day(input.issuedAt) : "none"}` : null,
      ].filter((x): x is string => x != null);
      await recordPortfolioEvent(tx, {
        orgRef, operatorId: doc.ownerId, credentialId: doc.id, actorUserId: input.verifierUserId,
        eventType: input.outcome === "verified" ? "credential_verified" : "credential_rejected",
        detail: `${label} ${input.outcome} via ${input.path}${corrected.length ? ` (${corrected.join("; ")})` : ""}${input.note ? `: ${input.note}` : ""}`,
        at: now,
      });
      if (input.outcome === "verified" && previous && previous.id !== doc.id && previous.capturedAt.getTime() < doc.capturedAt.getTime()) {
        await recordPortfolioEvent(tx, { orgRef, operatorId: doc.ownerId, credentialId: previous.id, actorUserId: input.verifierUserId, eventType: "credential_superseded", detail: `${label} superseded by credential ${doc.id}`, at: now });
      }
    }
  });
  return { credentialId: doc.id, verificationStatus: input.outcome };
}
