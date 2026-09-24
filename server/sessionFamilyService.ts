/**
 * The persisted half of a session family.
 *
 * `_core/sessionFamily.ts` holds the rules; this holds the rows. The split matters because the
 * dangerous decisions — is this verifier current, is this family dead, has the ceiling passed —
 * are arithmetic, and arithmetic is easier to trust when it is not interleaved with I/O.
 *
 * REUSE IS HANDLED HERE, NOT BY THE CALLER. `redeemRefresh` revokes the family itself when it sees
 * a retired verifier, rather than reporting the fact and trusting every call site to act. A reuse
 * that is detected and not acted on is worth nothing, and "the caller will revoke it" is exactly
 * the kind of obligation that gets dropped when a second call site appears.
 */
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { sessionFamilies } from "../drizzle/schema";
import {
  absoluteExpiryFrom,
  assessRefresh,
  hashVerifier,
  newVerifier,
  rotated,
  type FamilyState,
} from "./_core/sessionFamily";
import { randomBytes } from "node:crypto";

export type RevokeReason =
  | "logout" | "revoked_all" | "device_revoked"
  | "reuse_detected" | "credential_change" | "admin" | "expired";

const mintRef = () => `SF-${randomBytes(12).toString("base64url")}`;

async function database() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

export type NewFamily = { familyRef: string; verifier: string; absoluteExpiresAt: Date };

/**
 * A login. The verifier is returned to the caller exactly once — it is never readable again,
 * because only its hash is stored.
 */
export async function createSessionFamily(args: {
  openId: string;
  appId: string | null;
  authAssurance?: "password" | "mfa";
  mfaCompletedAt?: Date | null;
  deviceRef?: string | null;
  userAgentHash?: string | null;
  ipHash?: string | null;
  now?: Date;
}): Promise<NewFamily> {
  const db = await database();
  const now = args.now ?? new Date();
  const verifier = newVerifier();
  const familyRef = mintRef();
  const absoluteExpiresAt = absoluteExpiryFrom(now);

  await db.insert(sessionFamilies).values({
    familyRef,
    openId: args.openId,
    appId: args.appId,
    refreshVerifierHash: hashVerifier(verifier),
    rotationCounter: 0,
    authAssurance: args.authAssurance ?? "password",
    mfaCompletedAt: args.mfaCompletedAt ?? null,
    deviceRef: args.deviceRef ?? null,
    createdAt: now,
    absoluteExpiresAt,
    userAgentHash: args.userAgentHash ?? null,
    ipHash: args.ipHash ?? null,
  } as never);

  return { familyRef, verifier, absoluteExpiresAt };
}

export type RedeemOutcome =
  | { kind: "ok"; verifier: string; openId: string; appId: string | null;
      authAssurance: "password" | "mfa"; mfaCompletedAt: Date | null }
  | { kind: "revoked" }
  | { kind: "expired" }
  | { kind: "reuse_detected" };

/**
 * Spend a refresh credential and issue the next one.
 *
 * An unknown `familyRef` answers `reuse_detected` rather than a distinct "no such family": a
 * caller holding a bad reference and a caller holding a retired verifier learn the same thing,
 * so the endpoint cannot be used to enumerate which families exist.
 *
 * `expected.appId` is checked because a family belongs to the surface it was minted for. The
 * access path has refused a mismatched `appId` since the shared-secret finding; a refresh able to
 * cross surfaces would reopen that hole one layer down.
 */
export async function redeemRefresh(
  familyRef: string,
  presentedVerifier: string,
  now: Date,
  expected?: { appId?: string | null },
): Promise<RedeemOutcome> {
  const db = await database();

  const row = (await db.select().from(sessionFamilies)
    .where(eq(sessionFamilies.familyRef, familyRef)).limit(1))[0];
  if (!row) return { kind: "reuse_detected" };

  if (expected?.appId !== undefined && (row.appId ?? null) !== (expected.appId ?? null)) {
    return { kind: "reuse_detected" };
  }

  const state: FamilyState = {
    refreshVerifierHash: row.refreshVerifierHash,
    rotationCounter: row.rotationCounter,
    createdAt: new Date(row.createdAt),
    absoluteExpiresAt: new Date(row.absoluteExpiresAt),
    revokedAt: row.revokedAt ? new Date(row.revokedAt) : null,
  };

  const verdict = assessRefresh(state, presentedVerifier, now);

  if (verdict.kind === "reuse_detected") {
    // Acted on here, not reported upward. Two parties hold one credential; the family ends.
    await revokeFamily(familyRef, "reuse_detected", now);
    return { kind: "reuse_detected" };
  }
  if (verdict.kind !== "ok") return { kind: verdict.kind };

  const next = rotated(state, now);
  await db.update(sessionFamilies).set({
    refreshVerifierHash: next.refreshVerifierHash,
    rotationCounter: next.rotationCounter,
    lastUsedAt: now,
  } as never).where(eq(sessionFamilies.familyRef, familyRef));

  return {
    kind: "ok",
    verifier: next.verifier,
    openId: row.openId,
    appId: row.appId ?? null,
    authAssurance: row.authAssurance,
    mfaCompletedAt: row.mfaCompletedAt ? new Date(row.mfaCompletedAt) : null,
  };
}

/** Idempotent: revoking an already-revoked family keeps the original reason and time. */
export async function revokeFamily(familyRef: string, reason: RevokeReason, now = new Date()) {
  const db = await database();
  await db.update(sessionFamilies)
    .set({ revokedAt: now, revokeReason: reason } as never)
    .where(and(eq(sessionFamilies.familyRef, familyRef), isNull(sessionFamilies.revokedAt)));
}

/** Every live family for one account — logout-everywhere, and the hook a credential change uses. */
export async function revokeAllForOpenId(openId: string, reason: RevokeReason, now = new Date()) {
  const db = await database();
  await db.update(sessionFamilies)
    .set({ revokedAt: now, revokeReason: reason } as never)
    .where(and(eq(sessionFamilies.openId, openId), isNull(sessionFamilies.revokedAt)));
}
