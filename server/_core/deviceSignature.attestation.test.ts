/**
 * P1.4 — a `device_auth` signature that proves which device made it, and the rule that no biometric
 * material is ever stored.
 *
 * Real P-256 keys throughout. A test that stubbed the verifier would pass against a verifier that
 * returned `true` unconditionally, which is the failure most worth catching in a file about
 * signatures.
 */
import { readFileSync, readdirSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalSignaturePayload, checkSignatureAttestation, fingerprintP256Spki,
  looksLikeBiometricMaterial, type EnrolledDevice,
} from "./deviceSignature";

/** A real enrolled device: P-256 keypair, SPKI public key, fingerprint as the server computes it. */
function enrol(over: Partial<EnrolledDevice> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const device: EnrolledDevice = {
    deviceRef: "DEV-7712", keyFingerprint: fingerprintP256Spki(spki), publicKeySpkiBase64: spki,
    status: "active", revokedAt: null, suspendedAt: null, ...over,
  };
  return { device, privateKey };
}

const NOW = new Date("2026-09-18T12:00:00Z");
const payloadFor = (over: Partial<Parameters<typeof canonicalSignaturePayload>[0]> = {}) =>
  canonicalSignaturePayload({
    ticketNumber: "FT-2026-000812", revision: 1, payloadHash: "a".repeat(64),
    signerName: "R. Whitecalf", signedAt: NOW, ...over,
  });

const signWith = (privateKey: ReturnType<typeof enrol>["privateKey"], payload: Buffer) =>
  sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");

describe("a device attestation is checked, not taken on the label", () => {
  it("accepts a signature the enrolled key really made", () => {
    const { device, privateKey } = enrol();
    const payload = payloadFor();
    const r = checkSignatureAttestation({
      device, payload, now: NOW,
      attestation: { deviceRef: device.deviceRef, keyFingerprint: device.keyFingerprint, signatureP1363Base64: signWith(privateKey, payload), signedAt: NOW },
    });
    expect(r.ok).toBe(true);
  });

  it("refuses a signature from a key that is not the enrolled one", () => {
    const { device } = enrol();
    const other = enrol();                       // a real, valid signature — by the wrong key
    const payload = payloadFor();
    const r = checkSignatureAttestation({
      device, payload, now: NOW,
      attestation: { deviceRef: device.deviceRef, keyFingerprint: device.keyFingerprint, signatureP1363Base64: signWith(other.privateKey, payload), signedAt: NOW },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("SIGNATURE_INVALID");
  });

  it("refuses a device that is not enrolled at all", () => {
    const r = checkSignatureAttestation({
      device: null, payload: payloadFor(), now: NOW,
      attestation: { deviceRef: "DEV-UNKNOWN", keyFingerprint: "x", signatureP1363Base64: "y", signedAt: NOW },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("DEVICE_NOT_ENROLLED");
  });

  it("refuses a revoked device, and says revoked rather than invalid", () => {
    // Revocation has to reach signatures, not only sync: a stolen phone signs tickets too. And the
    // refusal must name the actionable fact, not the first check that happened to fail.
    const { device, privateKey } = enrol({ revokedAt: new Date("2026-09-17T00:00:00Z") });
    const payload = payloadFor();
    const r = checkSignatureAttestation({
      device, payload, now: NOW,
      attestation: { deviceRef: device.deviceRef, keyFingerprint: device.keyFingerprint, signatureP1363Base64: signWith(privateKey, payload), signedAt: NOW },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("DEVICE_NOT_ACTIVE");
    expect(r.reason).toMatch(/revoked/);
  });

  it("refuses a key the device rotated to without enrolling it", () => {
    // Verification alone would pass if the row carried the new key; the fingerprint is what ties
    // the signature to the key this company actually attested.
    const { device } = enrol();
    const rotated = enrol();
    const payload = payloadFor();
    const r = checkSignatureAttestation({
      device, payload, now: NOW,
      attestation: { deviceRef: device.deviceRef, keyFingerprint: rotated.device.keyFingerprint, signatureP1363Base64: signWith(rotated.privateKey, payload), signedAt: NOW },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("KEY_FINGERPRINT_MISMATCH");
    expect(r.reason).toMatch(/must be enrolled before it signs/);
  });

  it("refuses a stale signature, so one cannot be replayed hours later", () => {
    const { device, privateKey } = enrol();
    const payload = payloadFor();
    const r = checkSignatureAttestation({
      device, payload, now: new Date("2026-09-18T14:00:00Z"),
      attestation: { deviceRef: device.deviceRef, keyFingerprint: device.keyFingerprint, signatureP1363Base64: signWith(privateKey, payload), signedAt: NOW },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("SIGNATURE_STALE");
  });
});

describe("the payload binds the signature to one act on one version", () => {
  it("does not verify against a different ticket, revision or scope hash", () => {
    const { device, privateKey } = enrol();
    const signed = payloadFor();
    const signature = signWith(privateKey, signed);
    for (const [label, payload] of [
      ["another ticket", payloadFor({ ticketNumber: "FT-2026-000999" })],
      ["a later revision", payloadFor({ revision: 2 })],
      ["a changed scope", payloadFor({ payloadHash: "b".repeat(64) })],
      ["another signer", payloadFor({ signerName: "Someone Else" })],
    ] as const) {
      const r = checkSignatureAttestation({
        device, payload, now: NOW,
        attestation: { deviceRef: device.deviceRef, keyFingerprint: device.keyFingerprint, signatureP1363Base64: signature, signedAt: NOW },
      });
      expect(r.ok, label).toBe(false);
    }
  });
});

describe("no biometric material is ever stored", () => {
  it("recognises the shapes a vendor SDK would hand back", () => {
    for (const n of ["fingerprintTemplate", "faceEmbedding", "irisCode", "biometricData", "voicePrint", "facialGeometry", "fingerprint_minutiae"]) {
      expect(looksLikeBiometricMaterial(n), n).toBe(true);
    }
  });

  it("does not trip on the key material that is legitimate", () => {
    // The device's own key fingerprint is a hash of a public key. Nothing biometric about it, and a
    // guard that flagged it would be turned off within a week.
    for (const n of ["keyFingerprint", "fingerprintP256Spki", "deviceKeyFingerprint", "publicKeySpkiBase64", "signatureP1363Base64"]) {
      expect(looksLikeBiometricMaterial(n), n).toBe(false);
    }
  });

  it("finds no biometric column in the schema", () => {
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    const columns = Array.from(schema.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)).map(m => m[1]!);
    const offenders = Array.from(new Set(columns.filter(looksLikeBiometricMaterial)));
    expect(offenders, "a column that would hold biometric material").toEqual([]);
  });

  it("finds none in the signature or device code either", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() && e.name !== "node_modules" ? walk(`${dir}/${e.name}`)
          : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);
    const offenders: string[] = [];
    for (const f of [...walk("server"), ...walk("client/src")]) {
      if (/deviceSignature(\.attestation)?\.(ts|test\.ts)$/.test(f)) continue;   // the guard and its tests name them in order to forbid them
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{3,40})\b/g)) {
        if (looksLikeBiometricMaterial(m[1]!)) { offenders.push(`${f} → ${m[1]}`); break; }
      }
    }
    expect(offenders, "biometric material named in the code").toEqual([]);
  });
});
