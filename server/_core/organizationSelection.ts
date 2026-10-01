/**
 * v23.26 — the organization a request says it is working in.
 *
 * This module carries a CLAIM, never an authority. Nothing here checks
 * anything; `resolveActingScope` does the checking, against the membership
 * table, on every single request. A forged cookie therefore names either an
 * organization the caller has already been proved to belong to, or nothing.
 *
 * ## Why a request-scoped store rather than a parameter
 *
 * `resolveActingScope(db, userId)` is called from roughly a hundred places —
 * every tenant-scoped reader and writer in the system. Threading a selection
 * through all of them would be a hundred-file diff whose reviewability is worse
 * than its safety, and every site that forgot would silently keep resolving the
 * wrong company. `actingScope.ts` says in its own comment that it is "the one
 * function that changes, and every caller inherits the fix"; this is what lets
 * that stay true.
 *
 * The store is set in exactly one place — the express middleware in front of
 * the tRPC handler — and read in exactly one place. A caller that wants to be
 * explicit still can: `resolveActingScope(db, id, { preferredOrgRef })` takes
 * precedence over the store, which is how the tests drive it.
 *
 * Outside a request (the background worker, a direct `createCaller`, a unit
 * test) there is no store and the value is null, so behaviour is exactly what
 * it was before this file existed.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { parse as parseCookieHeader } from "cookie";

/**
 * The cookie the organization chooser writes.
 *
 * Deliberately NOT `__Host-` prefixed: it is set alongside the session cookie
 * and must share its attributes, and the session cookie is not host-only. It
 * carries no authority to protect — see the header comment — so the prefix
 * would be reassurance rather than a control.
 */
export const ORG_SELECTION_COOKIE = "leaseos_org";

/** Organization references are short, opaque and machine-issued. Anything else is not one. */
const ORG_REF = /^[A-Za-z0-9_-]{1,40}$/;

const store = new AsyncLocalStorage<{ orgRef: string | null }>();

/** The organization this request asked for, or null. Never an authority. */
export function requestedOrganization(): string | null {
  return store.getStore()?.orgRef ?? null;
}

/** Run `fn` with a request's claimed organization in scope. */
export function runWithOrganizationSelection<T>(orgRef: string | null, fn: () => T): T {
  return store.run({ orgRef: normalizeOrgRef(orgRef) }, fn);
}

/**
 * The claim carried by a cookie header, in the shape a scope resolver can use.
 *
 * Shape is checked here so a malformed value never reaches a query. A value
 * that is not an organization reference is dropped rather than repaired.
 */
export function organizationClaimFromCookies(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  try {
    return normalizeOrgRef(parseCookieHeader(cookieHeader)[ORG_SELECTION_COOKIE] ?? null);
  } catch {
    return null;
  }
}

function normalizeOrgRef(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ORG_REF.test(trimmed) ? trimmed : null;
}

/**
 * Express middleware: put the request's claim in scope for the whole handler.
 *
 * Mounted in front of the tRPC adapter rather than inside `createContext`,
 * because a context factory returns before any procedure runs and an
 * AsyncLocalStorage set there would already be out of scope by the time
 * `resolveActingScope` asked for it.
 */
export function organizationSelectionMiddleware(
  req: { headers: { cookie?: string | undefined } },
  _res: unknown,
  next: () => void
): void {
  runWithOrganizationSelection(organizationClaimFromCookies(req.headers.cookie), next);
}
