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

  it("only the store and the key module import the crypto core by value", () => {
    /*
     * `_core/secretCrypto` is the only module that can produce or open an envelope, and this keeps
     * the list of things that can do so to two: `secretStore`, which makes and opens them, and
     * `_core/secretKeys`, which assembles the keys. A third is a deliberate act with a name on it.
     *
     * TYPE-ONLY IMPORTS ARE NOT COUNTED, and that is a tightening rather than a loophole. The
     * question this guard asks is "who can call `encryptSecret` or `decryptSecret`" — and
     * `import type { SecretKeyProvider }` erases at compile time, so the answer for it is "nobody".
     * Counting a type annotation as access would mean every service that merely passes a provider
     * through has to be listed, and a list that long stops being read.
     *
     * `externalIdentityPolicy.ts` defines its own `encryptSecret`/`decryptSecret` — the legacy pair
     * S2-D reads and a later checkpoint retires — so this matches the import path, not the names.
     */
    const CRYPTO_CORE = /["'](?:\.{1,2}\/)*(?:server\/)?(?:_core\/)?secretCrypto["']/;
    /*
     * Matched over whole `import … from "…"` statements rather than line by line: `secretStore`
     * imports the core across six lines, so a per-line test sees the specifier without the `import`
     * keyword and silently concludes there is no importer. A guard that fails to see its most
     * important subject is worse than no guard.
     */
    const valueImport = (body: string) =>
      [...body.matchAll(/import\s+[\s\S]*?from\s*["'][^"']+["']/g)]
        .filter(m => CRYPTO_CORE.test(m[0]))
        .some(m => !/^import\s+type\b/.test(m[0]));

    const importers = serverSources().filter(p => valueImport(code(p)));
    expect(importers.sort()).toEqual([
      "server/_core/secretKeys.ts",
      "server/secretStore.ts",
    ]);
  });

  it("only named domain services import the store", () => {
    /*
     * One entry per class of secret LeaseOS holds, each owning its own domain's rules:
     *
     *   providerCredentialService — outbound provider credentials (S2-C)
     *   mfaSecretService          — portal MFA/TOTP seeds (S2-D)
     *   mfaSecretMigration        — the one-time backfill that moves them (S2-D)
     *   webhookSecretService      — outbound webhook signing secrets (S2-E)
     *   webhookSecretMigration    — the one-time backfill that moves them (S2-E)
     *
     * A sixth appearing means a new secret class arrived, or an existing domain grew a second entry
     * point into the store — both worth a conversation rather than a silent pass.
     */
    const importers = serverSources().filter(p => /["'](?:\.{1,2}\/)*(?:server\/)?secretStore["']/.test(code(p)));
    expect(importers.sort()).toEqual([
      "server/mfaSecretMigration.ts",
      "server/mfaSecretService.ts",
      "server/providerCredentialService.ts",
      "server/webhookSecretMigration.ts",
      "server/webhookSecretService.ts",
    ]);
  });

  it("no module outside the key provider reads a master-key environment variable", () => {
    /*
     * The design's invariant, now enforceable because S2-D introduces the module it names: "No
     * master-key environment variable referenced outside the key-provider module."
     *
     * `externalIdentityPolicy.ts` is the one legacy exception, and it is listed rather than
     * pattern-matched away so that removing it is a visible edit to this line — which is exactly
     * what the final step of the MFA cutover will be.
     */
    const readers = serverSources().filter(p =>
      /process\.env\.LEASEOS_(?:KEY_|PORTAL_MFA_KEY)/.test(code(p)) || /env\.LEASEOS_(?:KEY_|PORTAL_MFA_KEY)/.test(code(p))
    );
    expect(readers.sort()).toEqual([
      "server/_core/externalIdentityPolicy.ts",
      "server/_core/secretKeys.ts",
    ]);
  });
});

describe("S2-E Phase 1 — the expand release, and the boundary it must not cross", () => {
  /*
   * Release 1 gives every instance the ability to READ a canonical webhook reference. It must not
   * give any instance the ability to WRITE one during normal creation, because an instance still
   * running the previous version cannot read such a row. These guards are what make "expand now,
   * cut over later" a property of the codebase rather than an intention in a document.
   */

  it("E4/E5/E30. webhook creation still writes legacy ciphertext and no canonical reference", () => {
    /*
     * THE RELEASE BOUNDARY, as an executable statement. `webhookSubscribe` must keep writing
     * `secretEnc` and must not write `secretRef` — so normal creation cannot produce a
     * canonical-only row while pre-Release-1 instances are still serving.
     *
     * Asserted on the creation statement itself rather than on a behavioural outcome, because the
     * hazard is a *code* change shipped a release early: an implementation that moved to canonical
     * writes would look perfectly healthy in every functional test, and only a rolling deployment
     * would discover it.
     */
    const router = code("server/integrationRouter.ts");
    const insert = router.match(/\.insert\(webhookSubscriptions\)\.values\(\{[\s\S]*?\}\)/);

    expect(insert, "the webhook subscription insert was not found — has it moved?").not.toBeNull();
    expect(insert![0], "Release 1 must keep writing legacy ciphertext").toMatch(/\bsecretEnc\s*:/);
    expect(
      insert![0],
      "Release 1 must NOT write a canonical reference: an instance running the previous version cannot read such a row"
    ).not.toMatch(/\bsecretRef\s*:/);
  });

  it("no production module decrypts legacy webhook ciphertext outside the compatibility boundary", () => {
    /*
     * `secretEnc` may be opened in exactly one place. A second decrypt site is how "canonical first,
     * fail closed" becomes true in the dispatcher and false in whatever was added next.
     *
     * Matched on the IMPORT rather than the call, because the compatibility boundary itself imports
     * the legacy primitive under an alias (`decryptSecret as legacyDecrypt`). A call-name check
     * found zero offenders here — including the one file that legitimately does it — which is the
     * same blindness a rename would exploit.
     */
    const LEGACY_DECRYPT_IMPORT =
      /import\s*\{[^}]*\bdecryptSecret\b[^}]*\}\s*from\s*["'][^"']*externalIdentityPolicy["']/;
    /*
     * Dynamic imports count too. A mutation that reached the legacy primitive through
     * `(await import("./_core/externalIdentityPolicy")).decryptSecret(...)` slipped past the
     * static-import form entirely — which is the obvious way round a guard that only reads the top
     * of a file, and therefore the first thing it has to cover.
     */
    const LEGACY_DECRYPT_DYNAMIC = /import\s*\(\s*["'][^"']*externalIdentityPolicy["']\s*\)/;
    const offenders = serverSources().filter(p => {
      const body = code(p);
      return /\bsecretEnc\b/.test(body) && (LEGACY_DECRYPT_IMPORT.test(body) || LEGACY_DECRYPT_DYNAMIC.test(body));
    });
    expect(offenders).toEqual(["server/webhookSecretService.ts"]);
  });

  it("the webhook resolver names only WEBHOOK_SECRET", () => {
    const service = code("server/webhookSecretService.ts");
    const migration = code("server/webhookSecretMigration.ts");

    for (const [name, body] of [["service", service], ["migration", migration]] as const) {
      expect(body, `${name} must not reach for another purpose`).not.toMatch(/MFA_SECRET|PROVIDER_CREDENTIAL|INTEGRATION_SECRET/);
      expect(body).toMatch(/WEBHOOK_SECRET/);
    }
  });

  it("no delivery-level signing reference exists", () => {
    /*
     * OD-E2, as schema. A per-delivery signing reference is the shape a frozen-secret implementation
     * would take, and its absence is easier to keep true than its correct use would be.
     */
    const schema = code("drizzle/schema.ts");
    const deliveries = schema.match(/export const webhookDeliveries = mysqlTable\([\s\S]*?\n\}\);/);

    expect(deliveries).not.toBeNull();
    expect(deliveries![0], "a delivery must not carry its own signing-secret reference").not.toMatch(/signingSecretRef|secretRef/);
  });

  it("no router mentions the webhook secret reference", () => {
    // A `secretRef` is a resolver's input. Nothing a client can reach has any use for one.
    const offenders = routerSources().filter(p => /\bsecretRef\b/.test(code(p)));
    expect(offenders).toEqual([]);
  });

  it("the legacy webhook column is still written, so the rollback path survives Release 1", () => {
    /*
     * The backfill must retain `secretEnc`. Clearing it is a separate, separately-approved
     * checkpoint — and until it happens, that column is the only thing that lets Release 1 be
     * rolled back without every webhook consumer reconfiguring.
     */
    const migration = code("server/webhookSecretMigration.ts");
    expect(migration, "Phase 1 must never null the legacy column").not.toMatch(/secretEnc\s*:\s*null/);
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
