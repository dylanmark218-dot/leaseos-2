/**
 * Which portal a session enters, and where a post-login redirect may go.
 *
 * Pure, like the rest of `viewModels.ts`, and for the same reason: every
 * decision about what a person sees first should be a function of the server's
 * answers that can be argued with in a test rather than clicked through.
 *
 * **The rule this file exists to hold.** A portal is presentation; authority
 * lives in the permission engine. `portalComposition.ts` says it plainly — "A
 * portal never grants a permission … if it were somehow rendered, the API
 * behind it would still refuse." So `held` is the server's answer and nothing
 * here may widen it. Two inputs could try:
 *
 *   `savedDefault` — `organizationMemberships.defaultWorkspace`, a varchar
 *     nobody validates on write. It is a **preference, not a grant**. A role
 *     revoked yesterday leaves the row behind, and honouring it would put
 *     somebody in a portal their grants no longer compose.
 *
 *   `requested` — the `:portal` segment of `/portal/:portal`, which is whatever
 *     the person typed.
 *
 * Both are checked against `held` and against the canonical key list, and both
 * fail closed to the chooser. Neither is ever the reason a portal opens.
 *
 * Failing closed here is a convenience, not the boundary: `portals.panelsFor`
 * refuses an unheld portal server-side whatever this returns. The two exist
 * together because either alone is a single point of failure — this one stops a
 * confusing screen, that one stops an actual read.
 */

import { PORTAL_LABELS, type PortalKey } from "./viewModels";

/** The canonical keys, derived from the label map so the two cannot drift. */
export const PORTAL_KEYS = Object.keys(PORTAL_LABELS) as PortalKey[];

const CANONICAL = new Set<string>(PORTAL_KEYS);

/**
 * True only when the key is one LeaseOS defines **and** one this session holds.
 *
 * Both halves matter. Held-but-not-canonical would mean the server returned
 * something this build does not know, and treating that as a portal would make
 * this function the weakest link rather than a check.
 */
export function isHeldPortal(
  key: string | null | undefined,
  held: readonly string[]
): key is PortalKey {
  if (typeof key !== "string" || key.length === 0) return false;
  return CANONICAL.has(key) && held.includes(key);
}

export type PortalEntry =
  | { kind: "none"; notReached: readonly string[] }
  | { kind: "enter"; portal: PortalKey; because: "only_portal" | "saved_default" | "requested" }
  | {
      kind: "choose";
      options: readonly PortalKey[];
      /** Set when a stored preference was declined, so the UI can say why. */
      rejectedDefault: string | null;
      /** Set when a URL named a portal this session does not hold. */
      rejectedRequest?: string | null;
    };

/**
 * Decide what happens after `portals.mine` answers.
 *
 * Order: an explicit request the session holds, then the only portal it holds,
 * then a saved default it still holds, then the chooser.
 *
 * The single-portal case deliberately outranks the saved default. With one
 * portal there is nothing to choose, and a default naming anything else is
 * stale by definition.
 */
export function resolvePortalEntry(args: {
  held: readonly string[];
  savedDefault?: string | null;
  requested?: string | null;
  notReached?: readonly string[];
}): PortalEntry {
  const held = args.held.filter(h => CANONICAL.has(h)) as PortalKey[];

  if (held.length === 0) {
    return { kind: "none", notReached: args.notReached ?? [] };
  }

  const requested = args.requested ?? null;
  if (isHeldPortal(requested, held)) {
    return { kind: "enter", portal: requested, because: "requested" };
  }
  // A request that named something this session does not hold is reported
  // rather than silently dropped: the person typed it and deserves to know it
  // was declined, and a reviewer reading the chooser should see why it appeared.
  const rejectedRequest = requested !== null && requested !== "" ? requested : null;

  if (held.length === 1) {
    return { kind: "enter", portal: held[0], because: "only_portal" };
  }

  const savedDefault = args.savedDefault ?? null;
  if (isHeldPortal(savedDefault, held)) {
    return { kind: "enter", portal: savedDefault, because: "saved_default" };
  }
  const rejectedDefault =
    savedDefault !== null && savedDefault.trim() !== "" ? savedDefault : null;

  return {
    kind: "choose",
    options: held,
    rejectedDefault,
    ...(rejectedRequest ? { rejectedRequest } : {}),
  };
}

/**
 * The only place a post-login destination is decided.
 *
 * An open redirect is the classic way a login page becomes a phishing step:
 * the link looks like LeaseOS, the sign-in is genuine, and the landing is
 * somebody else's page asking for something. So this is an allowlist of one
 * shape — a rooted, same-document path — rather than a list of things to strip.
 * Anything it does not recognise becomes `/`.
 *
 * Rejected on purpose, each of which has been a real bypass somewhere:
 *
 *   `//evil.example`     protocol-relative; the browser reads it as an origin
 *   `/\evil.example`     the same trick with a backslash, which some parsers fold
 *   `https://…`          an absolute URL
 *   `javascript:`        a scheme that executes rather than navigates
 *   `\n` `\r` `\0`       control characters used to smuggle a second header
 *
 * The result is idempotent: what comes back always survives a second pass, so
 * a guard applied twice cannot change the answer.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "/";

  // Deliberately not trimmed first. Leading whitespace before a scheme is one
  // of the ways an absolute URL gets past a naive `startsWith("/")`, so a value
  // that needed trimming to look rooted is refused rather than repaired.
  if (!raw.startsWith("/")) return "/";

  // Control characters anywhere, not only at the ends.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";

  // A second slash or any backslash in position 1 makes the browser read what
  // follows as a host.
  if (raw.startsWith("//") || raw.startsWith("/\\") || raw.includes("\\")) return "/";

  // Belt and braces: nothing that parses as absolute may survive, whatever
  // shape got it here.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw.slice(1))) return "/";

  return raw;
}
