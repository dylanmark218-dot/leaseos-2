/**
 * S2-E Phase 2A — the parts of the cutover preflight that need no database: the production write
 * probe under every provider shape the design names, and the structural facts that keep the
 * preflight honest.
 *
 * The probe tests are the production preflight in miniature. `probeWebhookCanonicalWrite` runs the
 * same `encryptSecret` the real `createSecret` runs, with the same production guard, so a provider
 * that passes here will pass there and one refused here is refused there — without a row ever being
 * written to find out.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeWebhookCanonicalWrite, probeWebhookSigningSecret } from "./webhookSecretService";
import { createEnvironmentKeyProvider, type KeyDescriptor, type SecretKeyProvider, type SecretPurpose } from "./_core/secretCrypto";
import { environmentSecretKeys } from "./_core/secretKeys";

const hexKey = (seed: string) => seed.repeat(64).slice(0, 64);

/** A managed-shaped provider: a separate implementation, its own key table. See the db suite. */
function managedFake(
  config: Partial<Record<SecretPurpose, { keyId: string; hex: string }>>,
  behaviour: { decryptOwnKey?: boolean; unavailable?: boolean } = {}
): SecretKeyProvider {
  const held = new Map<string, KeyDescriptor>();
  for (const [purpose, k] of Object.entries(config)) held.set(`${purpose}:${k.keyId}`, { keyId: k.keyId, key: Buffer.from(k.hex, "hex") });
  return {
    kind: "managed",
    getActiveKey: purpose => {
      if (behaviour.unavailable) throw new Error("key management service unreachable");
      return [...held.entries()].find(([k]) => k.startsWith(`${purpose}:`))?.[1] ?? null;
    },
    getDecryptKey: (purpose, keyId) => {
      if (behaviour.unavailable) throw new Error("key management service unreachable");
      if (behaviour.decryptOwnKey === false) return null;
      return held.get(`${purpose}:${keyId}`) ?? null;
    },
  };
}

const WEBHOOK = { keyId: "webhook-v1", hex: hexKey("7") };

describe("S2E2-T12..T14 — the production write probe", () => {
  it("S2E2-T12. an environment provider is refused in production — including the one production builds today", () => {
    const explicit = probeWebhookCanonicalWrite(createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: WEBHOOK } }));
    expect(explicit).toMatchObject({ possible: false, reason: expect.stringMatching(/production requires a managed key provider/) });

    const asProduction = environmentSecretKeys({ LEASEOS_KEY_WEBHOOK_V1: hexKey("7") });
    expect(asProduction.kind).toBe("environment");
    expect(probeWebhookCanonicalWrite(asProduction).possible).toBe(false);
  });

  it("S2E2-T13. a managed provider with an active WEBHOOK_SECRET key can write, under that key id", () => {
    expect(probeWebhookCanonicalWrite(managedFake({ WEBHOOK_SECRET: WEBHOOK }))).toEqual({ possible: true, keyId: "webhook-v1" });
  });

  it("S2E2-T14. a managed provider with no active WEBHOOK_SECRET key fails closed", () => {
    expect(probeWebhookCanonicalWrite(managedFake({}))).toMatchObject({ possible: false, reason: expect.stringMatching(/no active key configured for WEBHOOK_SECRET/) });
  });

  it("a managed provider holding only another purpose's key fails closed", () => {
    const wrongPurposeOnly = managedFake({ MFA_SECRET: { keyId: "mfa-v1", hex: hexKey("9") } });
    expect(probeWebhookCanonicalWrite(wrongPurposeOnly)).toMatchObject({ possible: false, reason: expect.stringMatching(/WEBHOOK_SECRET/) });
  });

  it("a managed provider that cannot decrypt under its own active key fails closed", () => {
    // Encrypts, then cannot read it back: a key system that hands out an encrypt handle it cannot
    // honour on the way back is a write that would succeed and a secret that would be lost.
    const halfBroken = managedFake({ WEBHOOK_SECRET: WEBHOOK }, { decryptOwnKey: false });
    expect(probeWebhookCanonicalWrite(halfBroken)).toMatchObject({ possible: false, reason: expect.stringMatching(/no key "webhook-v1" configured/) });
  });

  it("an unavailable managed provider is reported as refused, never thrown through the preflight", () => {
    const down = managedFake({ WEBHOOK_SECRET: WEBHOOK }, { unavailable: true });
    expect(() => probeWebhookCanonicalWrite(down)).not.toThrow();
    expect(probeWebhookCanonicalWrite(down)).toEqual({ possible: false, reason: "key management service unreachable" });
  });

  it("a refusal carries neither key material nor the probe value", () => {
    const refused = probeWebhookCanonicalWrite(createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: WEBHOOK } }));
    expect(refused.possible).toBe(false);
    const text = JSON.stringify(refused);
    expect(text).not.toContain(hexKey("7"));
    expect(text).not.toMatch(/sec_[A-Za-z0-9_-]{8}/);
  });
});

describe("refusal categories the preflight reports", () => {
  const keys = createEnvironmentKeyProvider({ WEBHOOK_SECRET: { active: WEBHOOK } });

  it("both-null is 'unsignable'", async () => {
    expect(await probeWebhookSigningSecret({ secretEnc: null, secretRef: null }, { keys, legacyKey: null })).toEqual({ resolvable: false, refusal: "unsignable" });
  });

  it("legacy ciphertext with no legacy key is 'legacy_key_missing'", async () => {
    expect(await probeWebhookSigningSecret({ secretEnc: "aaaa.bbbb.cccc", secretRef: null }, { keys, legacyKey: null })).toEqual({ resolvable: false, refusal: "legacy_key_missing" });
  });

  it("a successful probe says only that it succeeded", async () => {
    const { encryptSecret } = await import("./_core/externalIdentityPolicy");
    const legacy = Buffer.from(hexKey("8"), "hex");
    const probe = await probeWebhookSigningSecret({ secretEnc: encryptSecret("the-secret", legacy), secretRef: null }, { keys, legacyKey: legacy });
    expect(probe).toEqual({ resolvable: true });
    expect(JSON.stringify(probe)).not.toContain("the-secret");
  });
});

describe("S2E2-T17 and the key-material boundary — structural", () => {
  const strip = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = (p: string) => strip(readFileSync(p, "utf8"));

  it("S2E2-T17. the preflight has no input that can mark the fleet converged, and derives its verdict", () => {
    const preflight = code("server/webhookCutoverPreflight.ts");
    const args = preflight.match(/export type PreflightArgs = \{[\s\S]*?\n\};/)![0];
    expect(args, "no caller-supplied fleet attestation").not.toMatch(/fleet|converged|attest|evidence|inventory/i);
    // S2-FLEET-A: the fleet component is READ from the observation service. The preflight constructs
    // no fleet state of its own — not the blocked ones and above all not `converged`.
    expect(preflight, "the fleet is observed, never received").toMatch(/fleetComponent\(await observeFleet\(\)\)/);
    expect(preflight).not.toMatch(/state:\s*"(?:converged|observed_compatible_external_confirmation_required|observed_incompatible|not_observable|not_provable|compatible|incompatible)"/);
    expect(preflight, "only the service's converged state lifts the fleet blocker").toMatch(/if \(fleet\.state !== "converged"\) blockers\.push/);
    expect(preflight).not.toMatch(/fleetConverged|converged:\s*true/);
    expect(preflight, "the verdict is the conjunction of the components, not a field").toMatch(/cutoverAllowed: blockers\.length === 0/);
    expect(preflight).not.toMatch(/cutoverAllowed: true/);
    expect(preflight).not.toMatch(/releaseTwoReady|safeToCutover/);
  });

  it("no production module can label an environment provider 'managed'", () => {
    /*
     * The relabelling option is gone from `createEnvironmentKeyProvider`, and the provider it builds
     * says so literally. A managed provider can only be a separate implementation.
     */
    const core = code("server/_core/secretCrypto.ts");
    expect(core).toMatch(/kind: "environment",/);
    expect(core).not.toMatch(/options\.kind|kind\?: "environment" \| "managed"/);
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap(entry => {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) return entry === "node_modules" ? [] : walk(p);
        return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
      });
    // S2-KMS-A: the managed bootstrap is the one module that may say "managed", and only after
    // every unwrap has succeeded (`managedSecretKeys.test.ts` KMS-T3/T8).
    const offenders = [...walk("server"), ...walk("scripts")].filter(p => p !== "server/_core/managedSecretKeys.ts" && /kind:\s*["']managed["']/.test(code(p)));
    expect(offenders, "a production source constructs a provider that claims to be managed").toEqual([]);
  });

  it("the production provider wiring is the one accessor, and no vendor implementation is present", () => {
    /*
     * S2-KMS-A: call sites ask `secretKeyProvider()`, which serves the bootstrapped provider — the
     * environment one unless `LEASEOS_SECRET_KEYS_SOURCE=managed`, in which case a managed backend
     * must have unwrapped the keys at startup. No vendor adapter exists; the production backend
     * registry is empty (`secretKeyWiring.test.ts`).
     */
    const keysModule = code("server/_core/secretKeys.ts");
    expect(keysModule).toMatch(/return createEnvironmentKeyProvider\(config\);/);
    const wiring = ["server/webhookDispatchService.ts", "server/portalRouter.ts", "server/_core/trpc.ts"].map(code);
    for (const body of wiring) expect(body).toMatch(/secretKeyProvider\(\)/);
    for (const body of wiring) expect(body).not.toMatch(/environmentSecretKeys\(/);
    for (const body of wiring) expect(body).not.toMatch(/kms|keyVault|vault/i);
  });

  it("the write probe persists nothing and the preflight reaches the store only through the webhook service", () => {
    const store = code("server/secretStore.ts");
    const probe = store.match(/export function probeSecretWrite[\s\S]*?\n\}/)![0];
    expect(probe).not.toMatch(/database\(\)|db\.|insert|update/);
    expect(probe).not.toMatch(/console\./);

    const preflight = code("server/webhookCutoverPreflight.ts");
    expect(preflight).not.toMatch(/["'][^"']*secretStore["']/);
    expect(preflight).not.toMatch(/^import\s+(?!type)[^;]*["'][^"']*secretCrypto["']/m);
    expect(preflight).not.toMatch(/console\./);
    expect(preflight).not.toMatch(/process\.env\.LEASEOS/);
  });

  it("creation is untouched: webhookSubscribe still writes legacy ciphertext only, and does not dual-write", () => {
    const router = code("server/integrationRouter.ts");
    const insert = router.match(/\.insert\(webhookSubscriptions\)\.values\(\{[\s\S]*?\}\)/)![0];
    expect(insert).toMatch(/\bsecretEnc\s*:/);
    expect(insert).not.toMatch(/\bsecretRef\s*:/);
    expect(router).not.toMatch(/createSecret|secretStore|WEBHOOK_SECRET/);
  });
});
