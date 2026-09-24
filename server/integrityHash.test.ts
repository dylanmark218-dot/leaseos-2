/**
 * 0187 — hashing decisions (docs/HASH_CLASSIFICATION.md).
 *
 *  - `stableHash` is frozen byte for byte: persisted values are recomputed and
 *    compared (the TDG profile check refuses issuance on a mismatch).
 *  - New integrity values use `sha256HexV1`: 64 lowercase hex, key-order independent.
 *  - New 0187 integrity code does not reach for `stableHash`.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableHash } from "./_core/trainingAcademy";
import { ACADEMY_REGULATORY_PROFILES, regulatoryProfileHash } from "./_core/trainingAcademyRegulatory";
import { CREDENTIAL_POLICIES, policyHash } from "./_core/credentialLifecycle";
import { canonicalJsonV1, isSha256HexV1, sha256HexV1, SHA256_HEX_V1 } from "./_core/integrityHash";

describe("stableHash — legacy byte stability", () => {
  it("returns exactly the values already persisted (goldens)", () => {
    expect(stableHash("")).toBe("811c9dc59e3779b985ebca6bc2b2ae3527d4eb2f165667b1d3a2646cfd7046c5");
    expect(stableHash("LeaseOS")).toBe("-4e1f568423182364-603dd00a73e9533f-478ab322-4b16a8ea-5092bb4-265");
    expect(stableHash({ b: 2, a: [1, "x"] })).toBe("290549f0-50b24c2a-4642a5f3-7d1a36367316fbf26afbaf3b7b483990-6cdd");
  });

  it("the installed regulatory profile and policy hashes still recompute to what the database holds", () => {
    const byRef = Object.fromEntries(ACADEMY_REGULATORY_PROFILES.map(p => [p.profileRef, regulatoryProfileHash(p)]));
    expect(byRef["REG-TDG-ROAD-V1"]).toBe("-7ec38a5a39c754d558518ce62d80fd4428051062-3c2ee1e9046fb74c4996cb");
    expect(byRef["REG-WHMIS-EMPLOYER-V1"]).toBe("1ecc94c41509bcc8-d35c1d8-2ad1e547-49271b26-6d7b65fd3b7e0d07-1162");
    expect(policyHash(CREDENTIAL_POLICIES.find(p => p.policyRef === "POL-WHMIS-EMPLOYER-V1")!)).toBe("59ebe0eb-6cf7e10704003e80-62925d9501722d4a5853b11e-1d823570-8500");
  });

  it("is documented as not a hex format — which is why new code does not use it", () => {
    expect(stableHash("LeaseOS")).toContain("-");
    expect(isSha256HexV1(stableHash("LeaseOS"))).toBe(false);
    expect(isSha256HexV1(regulatoryProfileHash(ACADEMY_REGULATORY_PROFILES[0]!))).toBe(false);
  });
});

describe("sha256HexV1", () => {
  it("is SHA-256 as 64 lowercase hex", () => {
    expect(sha256HexV1("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256HexV1("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    for (const v of ["", "x", { a: 1 }, [1, 2, 3], { nested: { z: 1, a: [{ y: 2, b: 1 }] } }]) expect(sha256HexV1(v)).toMatch(SHA256_HEX_V1);
  });

  it("hashes canonical JSON: key order does not matter, array order does, Dates are ISO", () => {
    expect(sha256HexV1({ a: 1, b: { d: 2, c: 3 } })).toBe(sha256HexV1({ b: { c: 3, d: 2 }, a: 1 }));
    expect(sha256HexV1([1, 2])).not.toBe(sha256HexV1([2, 1]));
    expect(canonicalJsonV1({ at: new Date("2026-01-02T03:04:05.000Z"), b: undefined })).toBe('{"at":"2026-01-02T03:04:05.000Z"}');
  });

  it("the format check accepts only 64 lowercase hex", () => {
    expect(isSha256HexV1("a".repeat(64))).toBe(true);
    expect(isSha256HexV1("A".repeat(64))).toBe(false);
    expect(isSha256HexV1("a".repeat(63))).toBe(false);
    expect(isSha256HexV1(null)).toBe(false);
  });
});

describe("new integrity code does not use stableHash", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  it.each(["./_core/integrityHash.ts", "./_core/complianceOperations.ts", "./renewalOperations.ts"])("%s", file => {
    const src = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bstableHash\b/);
  });

  it("the inspector package hash and a proposed source version's snapshot hash use sha256HexV1", () => {
    const router = read("./trainingAcademyRouter.ts");
    expect(router).toMatch(/const packageHash = sha256HexV1\(/);
    expect(router).toMatch(/snapshotHash: sha256HexV1\(record\)/);
    expect(router).not.toMatch(/createHash\(/);
  });

  it("every stableHash call site is classified in the hash classification document", () => {
    const doc = read("../docs/HASH_CLASSIFICATION.md");
    for (const site of ["regulatoryProfileHash", "policyHash", "moduleHash", "courseSeedHash", "eventHash", "snapshotHash", "questionHash", "payloadHash", "tdgCertificateContents", "questionSetHash", "seedNumber", "routingCompiler", "dispatchAward"]) expect(doc).toContain(site);
  });
});
