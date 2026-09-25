# S2 — Secret Management: Implementation Plan

**Status:** plan only. Awaiting approval. Baseline `main` = `242b619`.
Companion to `SECRET_MANAGEMENT_DESIGN.md`.

Ten checkpoints, each with its own commit and its own gate run. Deliberately **not** one
enormous commit: S2-D and S2-E each rewrite live ciphertext, and those need to be revertible
independently of the crypto core.

Every checkpoint is TDD — tests written first, proved RED, then implementation. Mutations are
planted after each checkpoint is green and committed, then restored byte-for-byte.

---

## S2-A — Purpose-aware crypto core

**Files:** `server/_core/secretCrypto.ts`, `server/_core/secretCrypto.test.ts`

The envelope and key provider. Keeps the proven AES-256-GCM primitive from
`externalIdentityPolicy.ts:65-66`; adds `version`, `purpose`, `keyId`, and binds the last two
as GCM **additional authenticated data** so purpose confusion is a cryptographic failure rather
than a forgettable policy check.

```
encryptSecret(purpose, plaintext) -> envelope string
decryptSecret(purpose, envelope)  -> plaintext
```

`resolveKey(purpose, keyId)` is the only reader of master-key material. Key lists per purpose:
one active, any number of decrypt-only.

**Tests (≈22):** round trip per purpose · two encryptions of identical plaintext differ (fresh
IV) · wrong purpose refused · unknown `keyId` refused · tampered ciphertext refused · tampered
`purpose` field refused *by the auth tag*, not by a string compare · tampered `keyId` likewise
· unknown version refused · wrong field count refused · missing key for purpose refused ·
decrypt-only key decrypts · active key is chosen for new writes · legacy 3-field envelope
recognised as legacy, not misparsed.

**Mutations:** AAD dropped → purpose-tamper test goes red · fixed IV → distinctness test red ·
unknown `keyId` falls back to active key → refusal test red.

---

## S2-B — Encrypted secret store

**Files:** `server/secretStore.ts`, `server/secretStore.db.test.ts`, migration for `encryptedSecrets`

`putSecret(purpose, plaintext) -> secretRef` and `getSecret(purpose, secretRef) -> plaintext`.
The only module that touches `encryptedSecrets`.

**Tests (≈14):** a stored secret's plaintext appears nowhere in the row · `getSecret` with the
wrong purpose refuses · unknown `secretRef` refuses (and does not distinguish "no such ref"
from "wrong purpose", so refs cannot be probed) · rewrap preserves plaintext and changes
`keyId` · `envelope` is `text`, sized for `MUTUAL_TLS` material.

**Mutation:** store writes plaintext into a second column → the "plaintext never stored" test
goes red.

---

## S2-C — Provider credential metadata

**Files:** `server/providerCredentialService.ts` + tests, migration for `providerCredentials`

Metadata and ownership. Platform (`orgRef` NULL) versus tenant (`orgRef` required), resolution
matching ownership exactly.

**Tests (≈18):** platform credential resolvable without tenant context · tenant credential
resolvable only by its owner · **another tenant's credential refused, with no fallback to the
platform credential** · disabled / revoked / expired all refused separately · `fingerprint` is
a hash prefix and never plaintext characters · the table has no secret-capable column
(structural).

---

## S2-D — Migrate MFA secrets

**Files:** `scripts/migrate-secret-purposes.mjs`, `server/secretMigration.db.test.ts`

Re-encrypt `externalIdentities.mfaSecretEnc` from the shared legacy key to `MFA_SECRET`.

**Tests (≈12):** a seed encrypted with the legacy key still verifies a TOTP code after
migration — **the test that matters, because nobody re-enrols** · idempotent (a `v1.` row is
skipped) · resumable after interruption · **fails closed and writes nothing when the legacy key
is absent** · a legacy row and a migrated row are both readable during the window.

**Mutation:** migration writes a row it cannot decrypt → the TOTP-still-verifies test goes red.

---

## S2-E — Migrate webhook secrets

**Files:** same migration script extended, `server/webhookSecretMigration.db.test.ts`

Move `webhookSubscriptions.secretEnc` to `WEBHOOK_SECRET`.

**Tests (≈10):** `signPayload` produces the **same signature** before and after migration for
the same body and timestamp — the subscriber's verification is unaffected because the secret's
*value* does not change, only its storage · dispatch still delivers · a `WEBHOOK_SECRET`
envelope cannot be decrypted with the `MFA_SECRET` key (the purpose separation, proved) ·
absent legacy key fails closed without sending unsigned traffic.

**Blocked on OD-S2-5** (rotation overlap window) only if the answer changes the schema.

---

## S2-F — Credential write / rotate / revoke APIs

**Files:** `server/secretsRouter.ts` + tests, permission additions

`create` · `rotate` · `disable` · `list` (metadata only) · `health`. Gated on the four new
permissions from design §12. Calls the `requireAssurance` seam.

**Tests (≈20):** no query returns an envelope or plaintext · rotation increments
`credentialVersion` and sets `rotatedAt` · **there is no endpoint that returns a stored
secret** (structural, over the router's output schemas) · tenant role cannot manage a platform
credential · Company Admin alone does not get platform management · unauthenticated refused ·
the audit row says "rotated v3 → v4" and contains neither value.

---

## S2-G — Logging and redaction guards

**Files:** `server/_core/redact.ts` + tests, structural guards

**Tests (≈16):** a submitted key is absent from logs · a provider error echoing the request
does not expose the key · **a URL carrying `?apiKey=…` is redacted** — the realistic Alberta
511 leak, which a field-name-only redactor misses entirely · audit payloads carry metadata only
· tRPC error bodies carry no secret · `client/**` cannot import the resolver · no master-key
variable is read outside the key provider · no `SELECT *` from `encryptedSecrets` outside it.

---

## S2-H — Licensing / connector readiness contract

**Files:** `server/_core/connectorReadiness.ts` + tests

Joins `providerCredentials` to the licensing columns already on `externalDataSources`
(`commercialUsePermitted`, `redistributionPermitted`, `rateLimitCalls`, …) and answers the five
dimensions separately.

**Tests (≈14):** a configured credential with `apiProductionAuthorized` does **not** imply
`persistentCacheAuthorized` · an unassessed source permits nothing · a withdrawn source refuses
despite a valid credential · rate limit surfaced from the source row, not hardcoded.

---

## S2-I — Alberta 511 readiness, **not wired**

**Files:** seed/fixture rows, `server/alberta511Readiness.test.ts`

Prepares the metadata row and proves the path end to end **with a fixture credential**. No
outbound call, no connector. Wiring the real connector is a later, separately approved
checkpoint.

**Tests (≈10):** resolution yields plaintext **only** inside the server boundary · a simulated
outbound request carries the key while the recorded/logged URL does not · the client-facing
response contains no credential · caching stays refused while licensing withholds it.

---

## S2-J — Mutation, security and full verification

The complete mutation battery (~14 mutations across A–I), the full clean-database
`scripts/ci-gate.sh`, regenerated `LEASEOS_CURRENT_STATE.md`, and a written report of which
assertion caught each mutation.

---

## Proposed migrations — numbers only, not created

`0175` and `0179` are taken; `0176`–`0178` appear free locally but may be claimed by open
branches, so the collision register must be re-scanned immediately before writing any file.

| Intended | Table | Notes |
|---|---|---|
| S2-B | `encryptedSecrets` | `secretRef` UNIQUE, index `(purpose, keyId)` for rewrap scans, `envelope` `text` |
| S2-C | `providerCredentials` | `credentialRef` UNIQUE; UNIQUE `(providerKey, environment, ownership, orgRef)`; index `(providerKey, status)` |
| S2-D/E | none | data migration by script, no DDL |
| late | drop `fleetFuelCards.providerToken` | only after OD-S2-2 confirms it is unused |

No master key appears in any migration or row.

---

## Sequencing and risk

A→B→C are additive and carry no risk to existing behaviour. **D and E are the only checkpoints
that touch live ciphertext** and each is independently revertible, with the legacy reader still
present. F→I are additive again.

The riskiest step is S2-D, because a bug there locks users out of MFA. Its mitigations are the
byte-level ones: re-encrypt only after a successful legacy decrypt, never write an
undecryptable row, fail closed when the legacy key is absent, and prove a real TOTP code still
verifies afterwards rather than asserting the ciphertext merely changed shape.

---

## What this plan deliberately does not do

No connector ships. No outbound provider call is made. No KMS is required (OD-S2-1 open). No
step-up mechanism is built — only the seam S6 fills. No existing hash-only credential becomes
reversible. No user re-enrols anything.
