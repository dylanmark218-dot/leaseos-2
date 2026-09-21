import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalDevicePackage, fingerprintP256Spki, signatureTimeIsFresh, verifyP256PackageSignature } from "./deviceSignature";

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { spki, privateKey };
}

describe("device cryptographic binding", () => {
  it("verifies browser-compatible P1363 ECDSA and rejects tampering", () => {
    const k = keys();
    const input = { deviceRef: "DEV-1", packageRef: "PKG-1", queuedAt: new Date("2026-09-15T02:00:00Z"), signedAt: new Date("2026-09-15T02:00:01Z"), nonce: "nonce-0123456789abcdef", items: [{ evidenceRecordId: 1, declaredContentHash: "a".repeat(64) }], recordUpdates: [] };
    const payload = canonicalDevicePackage(input);
    const sig = sign("sha256", payload, { key: k.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    expect(verifyP256PackageSignature({ publicKeySpkiBase64: k.spki, payload, signatureP1363Base64: sig })).toBe(true);
    expect(verifyP256PackageSignature({ publicKeySpkiBase64: k.spki, payload: Buffer.from(payload.toString()+"x"), signatureP1363Base64: sig })).toBe(false);
  });

  it("derives the fingerprint from key bytes and enforces freshness", () => {
    const k = keys();
    expect(fingerprintP256Spki(k.spki)).toMatch(/^[a-f0-9]{64}$/);
    const now = new Date("2026-09-15T02:10:00Z");
    expect(signatureTimeIsFresh(new Date("2026-09-15T02:01:00Z"), now)).toBe(true);
    expect(signatureTimeIsFresh(new Date("2026-09-15T01:59:00Z"), now)).toBe(false);
  });
});
