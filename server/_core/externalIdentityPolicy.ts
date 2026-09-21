/**
 * External identity policy — pure decisions about invitations, tokens,
 * lockout and MFA. The router stores and the gate enforces; this decides.
 *
 * Secrets: a bearer token is stored only as its SHA-256; a TOTP secret is
 * stored encrypted under a server key (AES-256-GCM) and decrypted only to
 * verify a code. Nothing here logs a secret.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export const INVITATION_TTL_MS = 7 * 86_400_000;
export const TOKEN_TTL_MS = 90 * 86_400_000;
export const ROTATION_GRACE_MS = 10 * 60_000;
export const LOCKOUT_AFTER = 5;
export const LOCKOUT_MS = 15 * 60_000;

export type IdentityRow = { status: "invited" | "active" | "suspended" | "revoked"; acceptedAt: Date | null; tokenExpiresAt: Date | null; lockedUntil: Date | null; failedAttempts: number; mfaEnabled: boolean };

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

/** May this identity use a bearer token now? Every "no" is a named reason. */
export function credentialCheck(id: IdentityRow, now: Date): { allowed: boolean; reason: string | null } {
  if (id.status === "revoked") return { allowed: false, reason: "Portal identity is revoked" };
  if (id.status === "suspended") return { allowed: false, reason: "Portal identity is suspended" };
  if (id.status === "invited" || !id.acceptedAt) return { allowed: false, reason: "Invitation not yet accepted" };
  if (id.lockedUntil && now < id.lockedUntil) return { allowed: false, reason: `Locked after ${LOCKOUT_AFTER} failed attempts until ${id.lockedUntil.toISOString()}` };
  if (id.tokenExpiresAt && now >= id.tokenExpiresAt) return { allowed: false, reason: "Token expired — rotate it or accept a new invitation" };
  return { allowed: true, reason: null };
}

export function invitationCheck(id: { status: IdentityRow["status"]; invitationExpiresAt: Date | null; acceptedAt: Date | null }, now: Date): { allowed: boolean; reason: string | null } {
  if (id.status !== "invited") return { allowed: false, reason: `Invitation is ${id.acceptedAt ? "already accepted" : id.status}` };
  if (!id.invitationExpiresAt || now >= id.invitationExpiresAt) return { allowed: false, reason: "Invitation expired — ask for a new one" };
  return { allowed: true, reason: null };
}

export function failureUpdate(failedAttempts: number, now: Date): { failedAttempts: number; lockedUntil: Date | null } {
  const n = failedAttempts + 1;
  return { failedAttempts: n, lockedUntil: n >= LOCKOUT_AFTER ? new Date(now.getTime() + LOCKOUT_MS) : null };
}

/* ---- TOTP, RFC 6238: SHA-1, 30-second step, 6 digits, ±1 step ---- */
export function totpCode(secretBase32: string, at: Date, step = 0): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(at.getTime() / 30_000) + step;
  const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0); msg.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const code = ((h[off]! & 0x7f) << 24 | h[off + 1]! << 16 | h[off + 2]! << 8 | h[off + 3]!) % 1_000_000;
  return String(code).padStart(6, "0");
}
export function totpVerify(secretBase32: string, code: string, at: Date): boolean {
  return [-1, 0, 1].some(s => totpCode(secretBase32, at, s) === code.trim());
}
export function newTotpSecret(): string { return base32Encode(randomBytes(20)); }

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string { let bits = 0, val = 0, out = ""; for (let i = 0; i < buf.length; i++) { const b = buf[i]!; val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
export function base32Decode(s: string): Buffer { let bits = 0, val = 0; const out: number[] = []; for (const c of s.replace(/=+$/, "").toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }

/* ---- MFA secret at rest: AES-256-GCM under the server key ---- */
export function mfaKey(): Buffer | null { const hex = process.env.LEASEOS_PORTAL_MFA_KEY; return hex && /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : null; }
export function encryptSecret(secret: string, key: Buffer): string { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv); const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]); return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`; }
export function decryptSecret(enc: string, key: Buffer): string { const [iv, tag, ct] = enc.split("."); const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64")); d.setAuthTag(Buffer.from(tag!, "base64")); return Buffer.concat([d.update(Buffer.from(ct!, "base64")), d.final()]).toString("utf8"); }
