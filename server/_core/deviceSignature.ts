import { createHash, createPublicKey, verify } from "node:crypto";

export const DEVICE_SIGNATURE_MAX_SKEW_MS = 10 * 60 * 1000;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function canonicalDevicePackage(input: {
  deviceRef: string; packageRef: string; queuedAt: Date; signedAt: Date; nonce: string;
  items: unknown[]; recordUpdates: unknown[];
}): Buffer {
  return Buffer.from(canonical({
    deviceRef: input.deviceRef,
    packageRef: input.packageRef,
    queuedAt: input.queuedAt.toISOString(),
    signedAt: input.signedAt.toISOString(),
    nonce: input.nonce,
    items: input.items,
    recordUpdates: input.recordUpdates,
  }), "utf8");
}

export function parseP256Spki(publicKeySpkiBase64: string) {
  const der = Buffer.from(publicKeySpkiBase64, "base64");
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec") throw new Error("Device key must be EC P-256");
  const details = key.asymmetricKeyDetails;
  if (details?.namedCurve !== "prime256v1") throw new Error("Device key must use P-256");
  return { key, der };
}

export function fingerprintP256Spki(publicKeySpkiBase64: string): string {
  const { der } = parseP256Spki(publicKeySpkiBase64);
  return createHash("sha256").update(der).digest("hex");
}

export function verifyP256PackageSignature(args: {
  publicKeySpkiBase64: string; payload: Buffer; signatureP1363Base64: string;
}): boolean {
  try {
    const { key } = parseP256Spki(args.publicKeySpkiBase64);
    const signature = Buffer.from(args.signatureP1363Base64, "base64");
    if (signature.length !== 64) return false;
    return verify("sha256", args.payload, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch { return false; }
}

export function signatureTimeIsFresh(signedAt: Date, now: Date): boolean {
  return Math.abs(now.getTime() - signedAt.getTime()) <= DEVICE_SIGNATURE_MAX_SKEW_MS;
}

/** A tablet whose clock is this far from the server's is wrong beyond any time-zone or drift explanation. */
export const DEVICE_CLOCK_MAX_ABS_SKEW_MS = 24 * 60 * 60 * 1000;
/** Skew beyond this is recorded as an exception for the office, though the package is still admitted. */
export const DEVICE_CLOCK_WARN_SKEW_MS = 5 * 60 * 1000;

export type FreshnessVerdict =
  | { fresh: true; mode: "device_clock"; skewMs: number; warn: boolean }
  | { fresh: true; mode: "server_clock"; skewMs: null; warn: false }
  | { fresh: false; reason: string; skewMs: number | null };

/**
 * Freshness with the tablet's clock taken into account. When the device reports
 * its own clock at send time, the signature is fresh if it was made within the
 * window *by the device's clock* (a tablet that is 15 minutes off is not
 * replaying), and the skew between the two clocks is returned so it can be
 * recorded; a skew beyond a day is a wrong clock and is refused. Without a device
 * clock the pre-0142 rule applies: ±10 minutes against the server.
 */
export function signatureFreshness(args: { signedAt: Date; now: Date; deviceClockAt?: Date | null }): FreshnessVerdict {
  if (!args.deviceClockAt) {
    return signatureTimeIsFresh(args.signedAt, args.now)
      ? { fresh: true, mode: "server_clock", skewMs: null, warn: false }
      : { fresh: false, reason: `signed ${args.signedAt.toISOString()}, server time ${args.now.toISOString()}; no device clock reported`, skewMs: null };
  }
  const skewMs = args.now.getTime() - args.deviceClockAt.getTime();
  if (Math.abs(skewMs) > DEVICE_CLOCK_MAX_ABS_SKEW_MS) return { fresh: false, reason: `device clock is ${Math.round(skewMs / 60_000)} minutes from the server's — beyond a day; set the tablet's clock`, skewMs };
  const byDevice = Math.abs(args.deviceClockAt.getTime() - args.signedAt.getTime());
  if (byDevice > DEVICE_SIGNATURE_MAX_SKEW_MS) return { fresh: false, reason: `signature is ${Math.round(byDevice / 60_000)} minutes old by the device's own clock`, skewMs };
  return { fresh: true, mode: "device_clock", skewMs, warn: Math.abs(skewMs) > DEVICE_CLOCK_WARN_SKEW_MS };
}

/* ------------------------------------------------------------------ */
/* P1.4 — a field-ticket signature that proves which device made it    */
/* ------------------------------------------------------------------ */

/**
 * The payload a device signs when a person signs a field ticket.
 *
 * It binds the signature to *this* ticket at *this* revision with *this* payload hash. Signing the
 * hash alone would let a signature be replayed onto another ticket that happened to hash the same
 * scope; signing the ticket alone would let it survive an amendment. Both, and the revision, so the
 * proof is of a specific act on a specific version.
 */
export function canonicalSignaturePayload(input: {
  ticketNumber: string; revision: number; payloadHash: string; signerName: string; signedAt: Date;
}): Buffer {
  return Buffer.from(canonical({
    ticketNumber: input.ticketNumber,
    revision: input.revision,
    payloadHash: input.payloadHash,
    signerName: input.signerName,
    signedAt: input.signedAt.toISOString(),
  }), "utf8");
}

export type DeviceAttestation = {
  deviceRef: string;
  keyFingerprint: string;
  signatureP1363Base64: string;
  signedAt: Date;
};

export type EnrolledDevice = {
  deviceRef: string;
  keyFingerprint: string;
  publicKeySpkiBase64: string;
  status: string;
  revokedAt: Date | null;
  suspendedAt: Date | null;
};

export type AttestationResult =
  | { ok: true }
  | { ok: false; code: "DEVICE_NOT_ENROLLED" | "DEVICE_NOT_ACTIVE" | "KEY_FINGERPRINT_MISMATCH" | "SIGNATURE_INVALID" | "SIGNATURE_STALE"; reason: string };

/**
 * Check a device attestation on a signature.
 *
 * Order matters, and it is cheapest-and-most-specific first so the refusal names the real problem:
 * a revoked device that also sends a bad signature should be told its device is revoked, because
 * that is the fact someone has to act on.
 *
 * The fingerprint check is not redundant with verification. Verification proves *a* key signed it;
 * the fingerprint proves it was the key we enrolled, so a device that quietly rotated to a key we
 * never attested cannot sign in the old device's name.
 */
export function checkSignatureAttestation(args: {
  attestation: DeviceAttestation;
  device: EnrolledDevice | null;
  payload: Buffer;
  now: Date;
}): AttestationResult {
  const { attestation: a, device: d } = args;
  if (!d) {
    return { ok: false, code: "DEVICE_NOT_ENROLLED", reason: `Device ${a.deviceRef} is not enrolled. A signature can only be attested by a device this company enrolled.` };
  }
  if (d.revokedAt || d.suspendedAt || d.status !== "active") {
    return { ok: false, code: "DEVICE_NOT_ACTIVE", reason: `Device ${a.deviceRef} is ${d.revokedAt ? "revoked" : d.suspendedAt ? "suspended" : `not active (${d.status})`}. Revocation takes effect for signatures too, not only for sync.` };
  }
  if (d.keyFingerprint !== a.keyFingerprint) {
    return { ok: false, code: "KEY_FINGERPRINT_MISMATCH", reason: `The signature names key ${a.keyFingerprint.slice(0, 12)}… but ${a.deviceRef} is enrolled with ${d.keyFingerprint.slice(0, 12)}…. A rotated key must be enrolled before it signs.` };
  }
  if (!signatureTimeIsFresh(a.signedAt, args.now)) {
    return { ok: false, code: "SIGNATURE_STALE", reason: "The device signed this more than ten minutes from the server's clock. That is either a stale replay or a device whose clock needs fixing." };
  }
  if (!verifyP256PackageSignature({ publicKeySpkiBase64: d.publicKeySpkiBase64, payload: args.payload, signatureP1363Base64: a.signatureP1363Base64 })) {
    return { ok: false, code: "SIGNATURE_INVALID", reason: "The device signature does not verify against the enrolled public key for this device." };
  }
  return { ok: true };
}

/**
 * The rule this whole design exists for: **no biometric material is ever stored.**
 *
 * The platform biometric unlocks the private key *on the device*. It does not travel, it is not
 * sent, and there is nowhere here to put it. That is not squeamishness: a key can be rotated after
 * a compromise and a fingerprint cannot, so storing a template would create a permanent credential
 * sitting next to the signatures it authorises.
 *
 * The risk is not that someone adds a `fingerprintTemplate` column on purpose. It is that a vendor
 * SDK returns a rich object and somebody persists the whole thing. So this names the shapes, and
 * `deviceSignature.test.ts` runs it across the schema and the signature paths.
 */
export const BIOMETRIC_MATERIAL_PATTERNS: readonly RegExp[] = [
  // `[A-Za-z_]*` so snake_case is caught too: fingerprint_minutiae is the same column as
  // fingerprintMinutiae, and a guard that only reads one casing is half a guard.
  /fingerprint(?!P256|Spki|P1363)[A-Za-z_]*(template|image|data|minutiae|scan|raw|blob|sample)/i,
  /\b(face|facial|iris|retina|voice)[A-Za-z_]*(template|embedding|vector|print|geometry|scan|model)/i,
  /biometric[A-Za-z_]*(template|data|sample|payload|blob|image|vector)/i,
  /\b(minutiae|faceEmbedding|irisCode)\b/i,
];

export function looksLikeBiometricMaterial(name: string): boolean {
  return BIOMETRIC_MATERIAL_PATTERNS.some(r => r.test(name));
}
