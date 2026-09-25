/**
 * A session family: one login, and every credential it goes on to mint.
 *
 * What this replaces is a single JWT with `expiresInMs: ONE_YEAR_MS`, verified statelessly and
 * therefore impossible to revoke. Clearing the cookie at logout did nothing to a copy already taken
 * out of the browser, and that copy stayed valid for the rest of its year.
 *
 * The shape here is the standard one, and it is standard because each half fixes what the other
 * cannot:
 *
 *   an **access** credential short enough that stealing it buys almost nothing, still verified
 *   statelessly so the hot path keeps no database lookup and no global revocation list;
 *
 *   a **refresh** credential that is server-tracked, rotates on every single use, and dies when the
 *   family is revoked. Revocation therefore bites at the next refresh, which bounds a revoked
 *   session's remaining authority to one access lifetime — fifteen minutes, asserted in S1-D.
 *
 * Reuse detection is the part that earns the rotation. A verifier is valid exactly once; presenting
 * a retired one means two parties hold the same credential, which is the signature of a theft. The
 * family is killed rather than the request merely refused, because refusing one request would leave
 * the thief and the user racing for the next rotation.
 *
 * Nothing here touches a database, a request or a cookie. It is arithmetic and hashing, so the rules
 * that decide whether a stolen refresh token still works can be read in one file and tested without
 * any I/O to hide behind.
 */
import { randomBytes } from "node:crypto";
import { sha256 } from "./externalIdentityPolicy";

/**
 * Fifteen minutes. Long enough that an ordinary working session is not refreshing constantly, short
 * enough that a leaked access token is a nuisance rather than an incident.
 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Thirty days, measured from login and never extended. A family that is used every day still dies
 * on day thirty; "thirty days" that moved on each use would mean "thirty days after you stop".
 */
export const REFRESH_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The verifier is the secret the client holds; only its hash is stored. Same construction the
 * portal's bearer tokens already use — 32 random bytes, and `externalIdentityPolicy` records the
 * reason there: "a bearer token is stored only as its SHA-256".
 */
export const newVerifier = (): string => randomBytes(32).toString("base64url");

export const hashVerifier = (verifier: string): string => sha256(verifier);

export const absoluteExpiryFrom = (createdAt: Date): Date =>
  new Date(createdAt.getTime() + REFRESH_ABSOLUTE_TTL_MS);

/** The durable half of a family — what a row holds, independent of how it is stored. */
export type FamilyState = {
  refreshVerifierHash: string;
  rotationCounter: number;
  createdAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
};

export type RefreshOutcome =
  | { kind: "ok" }
  /** The family is already dead. Checked first, so a dead family cannot be probed. */
  | { kind: "revoked" }
  /** Past the absolute lifetime. Not a theft signal — just over. */
  | { kind: "expired" }
  /**
   * The presented verifier is not the current one. Either a retired verifier (the theft signal
   * rotation exists to catch) or a guess; neither is distinguishable from the other here, and both
   * must end the family, so they share an outcome.
   */
  | { kind: "reuse_detected" };

/**
 * Order matters and is deliberate: revoked, then expired, then the verifier.
 *
 * Checking the verifier last means a dead or expired family answers the same way whatever is
 * presented to it, so it cannot be used as an oracle for whether a guessed verifier was right.
 */
export function assessRefresh(
  family: FamilyState,
  presentedVerifier: string,
  now: Date,
): RefreshOutcome {
  if (family.revokedAt !== null) return { kind: "revoked" };
  if (now.getTime() > family.absoluteExpiresAt.getTime()) return { kind: "expired" };
  if (!presentedVerifier) return { kind: "reuse_detected" };
  if (hashVerifier(presentedVerifier) !== family.refreshVerifierHash) {
    return { kind: "reuse_detected" };
  }
  return { kind: "ok" };
}

/**
 * The next credential in the family.
 *
 * `absoluteExpiresAt` is carried through unchanged — see A6. `now` is taken so callers cannot
 * disagree about when a rotation happened, not because the expiry depends on it.
 */
export function rotated(
  family: FamilyState,
  now: Date,
): {
  verifier: string;
  refreshVerifierHash: string;
  rotationCounter: number;
  absoluteExpiresAt: Date;
  lastUsedAt: Date;
} {
  const verifier = newVerifier();
  return {
    verifier,
    refreshVerifierHash: hashVerifier(verifier),
    rotationCounter: family.rotationCounter + 1,
    absoluteExpiresAt: family.absoluteExpiresAt,
    lastUsedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* S1-G — retiring the year-long tokens                                */
/* ------------------------------------------------------------------ */

/**
 * How long a pre-S1 token keeps working after the cutover.
 *
 * Seven days, measured from the cutover and not from the token. Honouring these until they expired
 * would leave the defect live for a year; refusing them at deploy would sign out every driver at
 * once, including ones on a lease with no signal. A week is enough for a fleet to come back into
 * coverage, and it ends.
 */
export const LEGACY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tolerance before a far-future expiry is read as legacy. Covers clock skew between the signer and
 * this process; without it a token minted seconds ago could be misread as a year-long one.
 */
const LEGACY_SKEW_MS = 5 * 60 * 1000;

export type LegacyAssessment =
  | { kind: "current" }
  | { kind: "legacy"; withinGrace: boolean };

/**
 * Is this a token from before S1, and if so may it still be used?
 *
 * The discriminator needs **no new claim**. Nothing minted after S1-B can carry an expiry further
 * out than the access lifetime, so a far-future `exp` is itself the evidence that a token predates
 * the cutover. A missing `exp` is treated the same way — this build always sets one.
 *
 * This only ever sees payloads that already passed signature verification, so it cannot admit a
 * forgery. What it must not do is widen what is accepted, and it does not: a token inside the
 * access lifetime is reported `current` and never reaches the grace path.
 */
export function assessLegacyAccess(
  payload: { exp?: number },
  now: Date,
  cutoverAt: Date,
): LegacyAssessment {
  const exp = payload.exp;
  if (exp === undefined) return { kind: "legacy", withinGrace: withinGrace(now, cutoverAt) };

  const remaining = exp * 1000 - now.getTime();
  if (remaining <= ACCESS_TOKEN_TTL_MS + LEGACY_SKEW_MS) return { kind: "current" };

  return { kind: "legacy", withinGrace: withinGrace(now, cutoverAt) };
}

const withinGrace = (now: Date, cutoverAt: Date) =>
  now.getTime() - cutoverAt.getTime() <= LEGACY_GRACE_MS;
