/**
 * 0174 — the integrity hash with a defined format.
 *
 * `stableHash` (trainingAcademy.ts) is a legacy deterministic fingerprint: eight
 * FNV-style lanes stringified before `>>> 0`, so a lane can print as a negative
 * number and the output can contain `-` and vary in length. Persisted values were
 * made with it — the installed REG-TDG-ROAD-V1 profile hash, module/course/question
 * hashes, source snapshot hashes, the Academy audit chain — and some are compared
 * against a fresh computation (the regulatory profile check refuses issuance on a
 * mismatch). Correcting it in place would make every existing database refuse TDG
 * certificates. It is therefore frozen, byte for byte, and pinned by tests.
 *
 * New integrity and content hashes use this instead: SHA-256 over a canonical JSON
 * encoding (object keys sorted, recursively), always 64 lowercase hex characters.
 * The `V1` names the encoding; a change to the encoding is a new function, never
 * an edit to this one, for the same reason `stableHash` cannot be edited.
 *
 * Not a password hash, not a MAC — no secret is involved.
 */
import { createHash } from "node:crypto";

/** Canonical JSON: sorted keys at every depth, arrays in order, `undefined` members dropped as JSON does. */
export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** SHA-256 of the canonical JSON encoding (or of a string as-is), as 64 lowercase hex characters. */
export function sha256HexV1(value: unknown): string {
  const text = typeof value === "string" ? value : canonicalJsonV1(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const SHA256_HEX_V1 = /^[0-9a-f]{64}$/;
export const isSha256HexV1 = (s: string | null | undefined): s is string => typeof s === "string" && SHA256_HEX_V1.test(s);
