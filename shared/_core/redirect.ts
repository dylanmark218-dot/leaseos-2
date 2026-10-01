/**
 * v23.26 — where a login may land, and nowhere else.
 *
 * Pure. Shared by the server (which writes the post-login `Location`) and the
 * client (which decides where to navigate after the session resolves), because
 * two implementations of "is this destination safe" is two answers, and the
 * wrong one is an open redirect.
 *
 * The rule is a whitelist of shape, not a blacklist of tricks. A destination is
 * accepted only when it is a path on this origin:
 *
 *   - begins with exactly one `/`
 *   - carries no scheme (`https:`, `javascript:`, `data:`) and no `\`
 *   - carries no authority (`//evil.example`, `/\evil.example`, `/%2Fevil`)
 *   - stays inside the app (no `..` segment that could escape a mount point)
 *
 * Everything else — an absolute URL, a protocol-relative URL, a bare word, an
 * empty string — resolves to the fallback. Refusing rather than repairing is
 * deliberate: a "cleaned up" attacker URL is still an attacker URL, and the
 * only safe repair is to discard it.
 */

/** Where a caller lands when the requested destination is not safe. */
export const DEFAULT_LANDING = "/";

/** How much of a destination we will carry. Longer is a payload, not a route. */
export const MAX_REDIRECT_LENGTH = 512;

/**
 * The safe destination for a requested one, or the fallback.
 *
 * `fallback` is itself checked, so a caller cannot smuggle an unsafe default
 * past the guard by passing it in the second argument.
 */
export function safeRedirectPath(
  requested: string | null | undefined,
  fallback: string = DEFAULT_LANDING
): string {
  const safeFallback = isSafeRedirectPath(fallback) ? fallback : DEFAULT_LANDING;
  return isSafeRedirectPath(requested) ? requested : safeFallback;
}

/** Whether a destination is a path on this origin and nothing else. */
export function isSafeRedirectPath(
  value: string | null | undefined
): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_REDIRECT_LENGTH) return false;

  // One leading slash, and only one. `//host` and `/\host` are authorities in
  // every browser that matters, not paths.
  if (value[0] !== "/") return false;
  if (value[1] === "/" || value[1] === "\\") return false;

  // A backslash anywhere is refused rather than normalized: browsers disagree
  // about where it becomes a separator, and a guard that depends on which
  // browser is reading it is not a guard.
  if (value.includes("\\")) return false;

  // Control characters, including the tab/newline/CR that URL parsers strip
  // before resolving — `/\tjavascript:alert(1)` is not a path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;

  // A scheme before the first `/` cannot occur (we required `/` at index 0),
  // but `/x:y` is a valid path while `javascript:` smuggled through an encoded
  // slash is not. Reject percent-encoded slashes and backslashes outright: a
  // route never needs them and a bypass always does.
  if (/%2f|%5c/i.test(value)) return false;

  // No traversal. `/portal/../..` is the same class of surprise as an
  // authority: the destination is not the one the path appears to name.
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (path.split("/").some(segment => segment === "..")) return false;

  return true;
}
