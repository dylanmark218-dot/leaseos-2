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
