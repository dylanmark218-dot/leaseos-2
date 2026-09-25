/**
 * S2 — the boundaries the secret store only has value if nothing crosses.
 *
 * Everything in `secretCrypto.test.ts`, `secretStore.db.test.ts` and
 * `providerCredentialService.db.test.ts` proves the store behaves correctly when it is asked. None
 * of it can prove that the *wrong caller never asks* — that no client bundle imports a resolver,
 * that no router hands a decrypted value back down the wire, that a verifier which should only ever
 * be compared does not quietly become something readable.
 *
 * Those are structural facts about the shape of the repository, so these tests read the source. They
 * strip comments first: several of the files below discuss the very things being searched for, and a
 * guard that cannot tell a citation from a call fails on its own documentation. That idiom, and
 * `walk`/`strip` themselves, follow `authArchitecture.test.ts`.
 *
 * WHEN ONE OF THESE FAILS, the fix is almost never to widen the assertion. Each pins a list that is
 * currently exhaustive; a new entry means a new way for a secret to reach somewhere it should not,
 * and the entry has to be justified before the list grows.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_PURPOSES } from "./_core/secretCrypto";

const strip = (body: string) =>
  body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "node_modules" ? [] : walk(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });

const code = (p: string) => strip(readFileSync(p, "utf8"));

const clientSources = () => walk("client/src");
const serverSources = () => walk("server");
/** Routers are the only server modules a browser can reach, so they get their own rules. */
const routerSources = () => serverSources().filter(p => /Router\.ts$/.test(p));
/** Everything a build can ship or a query can touch. `drizzle/schema.ts` is the column inventory. */
const productionSources = () => [...serverSources(), ...clientSources(), "drizzle/schema.ts"];

/** The S2 modules. Any of them in a client bundle is a finding on its own. */
const SECRET_MODULES = /["'](?:\.{1,2}\/)*(?:server\/)?(?:_core\/secretCrypto|secretStore|providerCredentialService)["']/;

describe("the client cannot reach secret material", () => {
  it("no client source imports a secret module", () => {
    /*
     * The bundler resolves imports transitively, so a single client file importing `secretStore`
     * would put the resolver — and, with it, the key-provider interface — into a file served to a
     * browser. Nothing else in this repository stops that; this test is the thing that stops it.
     */
    const importers = clientSources().filter(p => SECRET_MODULES.test(code(p)));
    expect(importers, "a browser bundle must not contain the secret store").toEqual([]);
  });

  it("no client source names a resolver or a key", () => {
    // Belt and braces: an import is the likely route, but a copied helper or a fetch to a
    // hand-written endpoint would not show up as one.
    const forbidden = [
      /\bresolveForOutbound\b/,
      /\bresolveSecret\b/,
      /\bdecryptSecret\b/,
      /\bencryptSecret\b/,
      /\bcreateEnvironmentKeyProvider\b/,
      /LEASEOS_[A-Z_]*KEY\b/,
    ];
    const offenders = clientSources().flatMap(p => {
      const body = code(p);
      return forbidden.filter(r => r.test(body)).map(r => `${p} matches ${r}`);
    });
    expect(offenders).toEqual([]);
  });

  it("no client source names a secret reference or an envelope", () => {
    /*
     * A `secretRef` is the single input a resolver needs. A UI has no use for one, so its presence
     * in client code means a DTO somewhere started carrying it — which is the leak, one step before
     * anyone tries to use it.
     */
    const offenders = clientSources().filter(p => /\bsecretRef\b|\bv1\.PROVIDER_CREDENTIAL\b/.test(code(p)));
    expect(offenders).toEqual([]);
  });
});

describe("resolution happens in services, never in a router body", () => {
  it("no router resolves a secret inline", () => {
    /*
     * Not a ban on routers using secrets — webhook signing and portal MFA legitimately need them.
     * The rule is *where*: resolution belongs in a service module (as `webhookDispatchService`
     * already does), because a router body is where a value is one keystroke away from being put in
     * the response object next to the data it was used to fetch.
     *
     * The list is empty today. S2-D and S2-E must keep it empty by resolving inside a service.
     */
    const inline = routerSources().filter(p => /\bresolve(?:Secret|ForOutbound)\s*\(/.test(code(p)));
    expect(inline, "move the resolve into a service and return only what the client needs").toEqual([]);
  });

  it("no router mentions a secret reference or the ciphertext table", () => {
    /*
     * Matched on `encryptedSecrets` and the envelope prefix rather than the bare word "envelope":
     * `deviceRouter` refuses a mismatched sync package with the phrase "package envelope", which is
     * an unrelated use of an ordinary word. A guard that cannot tell those apart teaches people to
     * widen it, and a widened guard catches nothing.
     */
    const offenders = routerSources().filter(p =>
      /\bsecretRef\b|\bencryptedSecrets\b|v1\.(?:MFA_SECRET|WEBHOOK_SECRET|PROVIDER_CREDENTIAL|INTEGRATION_SECRET)/.test(code(p))
    );
    expect(offenders).toEqual([]);
  });

  it("the store and the credential service are the only importers of the crypto core", () => {
    /*
     * `_core/secretCrypto` is the only module that can produce or open an envelope. Keeping its
     * importers to a named pair means a third caller is a deliberate act with a name on it, rather
     * than something that accreted.
     *
     * `externalIdentityPolicy.ts` defines its own `encryptSecret`/`decryptSecret` — the legacy pair
     * S2-D and S2-E will retire — so this matches on the import path, not on the function names.
     */
    const importers = serverSources().filter(p => /["'](?:\.{1,2}\/)*(?:server\/)?_core\/secretCrypto["']/.test(code(p)));
    expect(importers.sort()).toEqual([
      "server/providerCredentialService.ts",
      "server/secretStore.ts",
    ]);
  });

  it("the credential service is the only importer of the store", () => {
    const importers = serverSources().filter(p => /["'](?:\.{1,2}\/)*(?:server\/)?secretStore["']/.test(code(p)));
    expect(importers).toEqual(["server/providerCredentialService.ts"]);
  });
});

describe("fleetFuelCards.providerToken gains no production caller", () => {
  /*
   * A plaintext varchar(120) credential column, declared long ago and never wired to anything. It
   * is exactly the mistake `providerCredentials` exists not to repeat, and the owner's instruction
   * is explicit: deprecate and guard it, do not drop it, do not guess what it was for.
   *
   * So this does not assert that the column is gone. It asserts that nothing has started using it —
   * which is the only claim the evidence supports, and the one that matters.
   */
  it("is referenced by the schema declaration and nothing else", () => {
    const references = productionSources().filter(p => /\bproviderToken\b/.test(code(p)));

    expect(
      references,
      `providerToken acquired a caller. It is unencrypted storage: route the value through ` +
        `providerCredentials/encryptedSecrets instead. Current references: ${references.join(", ")}`
    ).toEqual(["drizzle/schema.ts"]);
  });

  it("is declared but carries no read or write anywhere in the application", () => {
    // Distinct from the file-level check above: catches a reference that reaches the column through
    // the Drizzle table object rather than by name.
    const usages = productionSources().filter(p => /fleetFuelCards\s*\.\s*providerToken|providerToken\s*[:=]/.test(code(p)));
    expect(usages).toEqual(["drizzle/schema.ts"]);
  });
});

describe("verifiers stay one-way", () => {
  /*
   * A refresh verifier, an API key hash and a portal token hash are all things the server only ever
   * *compares*. Moving any of them into the reversible store would be a downgrade dressed as
   * consolidation: it would make readable, in one place, a set of values that currently cannot be
   * read at all — and the store would happily oblige, because it has no way to know it is being
   * misused.
   */
  const ONE_WAY = [
    "refreshVerifierHash", // sessionFamilies — S1's rotating refresh family
    "keyHash", //             integrationClients — API key
    "tokenHash", //           externalIdentities — portal session token
    "invitationTokenHash", // externalIdentities — portal invitation
    "previousTokenHash", //   externalIdentities — the rotated-out token
  ];

  it("every one-way column is a 64-character hex field", () => {
    /*
     * The width is the structural part. A SHA-256 hex digest is exactly 64 characters; an envelope
     * is `v1.<purpose>.<keyId>.<iv>.<authTag>.<ciphertext>` and cannot fit in 64. A migration that
     * widened one of these to hold something reversible has to change this line first.
     */
    const schema = code("drizzle/schema.ts");
    for (const column of ONE_WAY) {
      const declaration = new RegExp(`\\b${column}: varchar\\("${column}", \\{ length: (\\d+) \\}\\)`);
      const match = schema.match(declaration);
      expect(match, `${column} is no longer declared as a varchar`).not.toBeNull();
      expect(Number(match![1]), `${column} was widened past a SHA-256 digest`).toBe(64);
    }
  });

  it("no module that touches a one-way column imports the reversible store", () => {
    const pattern = new RegExp(`\\b(?:${ONE_WAY.join("|")})\\b`);
    const offenders = serverSources().filter(
      p => pattern.test(code(p)) && /["'](?:\.{1,2}\/)*(?:server\/)?(?:secretStore|_core\/secretCrypto)["']/.test(code(p))
    );
    expect(
      offenders,
      "a verifier belongs in a hash comparison, not in a store that can give the value back"
    ).toEqual([]);
  });

  it("the purpose list admits no verifier", () => {
    /*
     * Every secret the store can hold must declare a purpose, so the purpose list is the complete
     * inventory of what is reversible. Pinning it means adding a verifier purpose cannot happen
     * without editing this assertion and reading the paragraph above it.
     */
    expect([...SECRET_PURPOSES]).toEqual([
      "MFA_SECRET",
      "WEBHOOK_SECRET",
      "PROVIDER_CREDENTIAL",
      "INTEGRATION_SECRET",
    ]);

    for (const purpose of SECRET_PURPOSES) {
      expect(purpose, "a hash, verifier or digest is compared, never decrypted").not.toMatch(
        /HASH|VERIFIER|DIGEST/
      );
    }
  });
});

describe("the legacy inline ciphertext is untouched by S2-A through S2-C", () => {
  /*
   * The owner's migration boundary: A-C build the new store and must NOT rewrite
   * `externalIdentities.mfaSecretEnc` or `webhookSubscriptions.secretEnc`. That migration is S2-D
   * and S2-E, staged deliberately. This pins that no new module has started reading or writing the
   * legacy columns in the meantime.
   */
  it("no S2 module reads or writes the legacy columns", () => {
    const s2Modules = [
      "server/_core/secretCrypto.ts",
      "server/secretStore.ts",
      "server/providerCredentialService.ts",
    ];
    const offenders = s2Modules.filter(p => /\bmfaSecretEnc\b|\bsecretEnc\b/.test(code(p)));
    expect(offenders, "S2-D and S2-E own the legacy migration; A-C must not pre-empt it").toEqual([]);
  });

  it("the legacy columns still exist, so nothing has been migrated early", () => {
    const schema = code("drizzle/schema.ts");
    expect(schema).toMatch(/\bmfaSecretEnc\b/);
    expect(schema).toMatch(/\bsecretEnc\b/);
  });
});
