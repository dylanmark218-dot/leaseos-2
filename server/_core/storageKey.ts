/**
 * What a storage key may be.
 *
 * `server/storage.ts` states the design invariant in its own header — "The key is
 * what gets persisted; the signed URL is short-lived and minted per request" —
 * and that invariant assumes keys are server-authored. `normalizeKey` only ever
 * stripped leading slashes, so a `..` segment, an absolute path or a key naming
 * another tenant's object passed through untouched, and six procedures accept a
 * key from the client as a bare `z.string().max(512)`.
 *
 * Enforced at the input rather than cleaned up later, which is the same choice
 * the sibling `storageUrl` field already makes when it refuses `/manus-storage/`
 * paths — on three of the very objects whose `storageKey` was unchecked.
 *
 * Why this is its own module rather than part of `storage.ts`: nine suites mock
 * `./storage` with a literal object, so any new export from that file breaks them
 * at import with "No export is defined on the mock". A pure predicate that nothing
 * mocks keeps them working untouched.
 */
import { z } from "zod";

/** Conservative on purpose: every key the server itself mints is inside this. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export const MAX_STORAGE_KEY_LENGTH = 512;

/**
 * A key is valid when every slash-separated segment is an ordinary name and is
 * neither `.` nor `..`.
 *
 * Both halves are needed, and the second is easy to leave out: `.` is in the
 * allowed character set because real keys contain file extensions, so the
 * character allowlist alone admits `..` happily. The allowlist stops the
 * encodings — `%2e%2e` fails on `%` — and the two explicit names stop the
 * literal form the allowlist cannot see.
 */
export function isValidStorageKey(relKey: string): boolean {
  const key = relKey.replace(/^\/+/, "");
  if (key.length === 0 || key.length > MAX_STORAGE_KEY_LENGTH) return false;
  return key
    .split("/")
    .every(segment => segment !== "." && segment !== ".." && SEGMENT.test(segment));
}

/** The input shape for a procedure that lets a caller name a key. */
export const storageKeyInput = z
  .string()
  .max(MAX_STORAGE_KEY_LENGTH)
  .refine(isValidStorageKey, {
    message:
      "A storage key is a path of ordinary names — letters, digits, dot, dash, underscore, separated by /. " +
      "Relative segments and other characters are refused here rather than normalised away.",
  });
