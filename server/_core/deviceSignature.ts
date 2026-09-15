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
