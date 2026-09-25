# S2 — Secret References & Purpose-Separated Encryption: Design

**Status:** design only. No production code. Baseline `main` = `242b619`.

S1 protects the person entering a credential. S2 protects the credential itself. It is the
prerequisite for every outbound integration — Alberta 511, provincial transportation feeds,
OAuth providers, telematics — because each of those needs LeaseOS to hold a secret it can
present to somebody else.

---

## 1. Threat model

What S2 defends against, in the order these actually happen:

| Threat | Today | After S2 |
|---|---|---|
| **A credential reaches the client** — React bundle, mobile bundle, a tRPC response, a URL handed to a browser | no provider credentials exist yet, so the risk is entirely prospective | structurally prevented: secrets resolve server-side only, behind a boundary with no client import path |
| **One key compromise forces unrelated rotations** | **live defect** — `LEASEOS_PORTAL_MFA_KEY` encrypts both MFA seeds and webhook signing secrets | separate purposes; compromising one class rotates one class |
| **Database read discloses credentials** | ciphertext only, which is correct | unchanged, plus key-id so a leaked old key does not decrypt new rows |
| **Ciphertext of unknown provenance** | **live gap** — envelopes are anonymous `iv.tag.ct`, so nothing records which key or purpose produced them | versioned envelope with explicit `keyId` and `purpose` |
| **A secret lands in a log, audit row or error** | no central redaction exists | centralized redaction plus structural guards |
| **Cross-tenant credential use** | not yet possible | tenant ownership enforced at resolution, fail closed |
| **Encrypting what should be hashed** (or the reverse) | correct today, unprotected by any test | test-pinned per class |

**Explicitly out of scope.** Human passwords: LeaseOS stores none — authentication is
delegated to OAuth (`authArchitecture.test.ts` pins this). S1 refresh verifiers: one-way
SHA-256 and they stay that way. An attacker with the live master key *and* database access
reads secrets; defending that needs an HSM or KMS with separate trust, which §4 leaves a path
to but does not require now.

---

## 2. Secret classification — surveyed from `main`, not assumed

Every production site that stores credential material today:

| Secret | Location | Storage now | Class | Key |
|---|---|---|---|---|
| Portal MFA/TOTP seed | `externalIdentities.mfaSecretEnc` `varchar(400)` | AES-256-GCM, `iv.tag.ct` | **REVERSIBLE** — TOTP verification recomputes codes from the seed | `LEASEOS_PORTAL_MFA_KEY` |
| Webhook signing secret | `webhookSubscriptions.secretEnc` `varchar(400)` NOT NULL | AES-256-GCM, `iv.tag.ct` | **REVERSIBLE** — see below | `LEASEOS_PORTAL_MFA_KEY` |
| Inbound integration key | `integrationClients.keyHash` `varchar(64)` UNIQUE | SHA-256 | **HASH ONLY** — LeaseOS only verifies a presented key | none |
| Portal access / previous / invitation token | `externalIdentities.tokenHash`, `previousTokenHash`, `invitationTokenHash` | SHA-256 | **HASH ONLY** | none |
| S1 refresh verifier | `sessionFamilies.refreshVerifierHash` `varchar(64)` | SHA-256 | **HASH ONLY** | none |
| Fuel-card provider token | `fleetFuelCards.providerToken` `varchar(120)` | **plaintext column** | REVERSIBLE if ever used | none |
| Provider API keys | **do not exist yet.** `externalDataSources.requiresApiKey` boolean anticipates them | — | REVERSIBLE | — |

Two findings worth stating plainly.

**The webhook secret is an outbound signing secret, and reversibility is a protocol
requirement rather than a convenience.** `webhookDispatchService.ts:48` computes
`signPayload(secret, timestamp, body)` and sends it as `x-leaseos-signature`. LeaseOS is the
signer, so it must recover the shared secret; hash-only storage cannot produce an HMAC. This
answers the "evaluate hash-only by actual protocol requirements" question with evidence: no.

**`fleetFuelCards.providerToken` is a plaintext credential column that no production code
reads or writes.** It is declared and unwired. It should be removed or routed through the
secret store *before* anything writes to it — a latent hazard, not a current leak.

---

## 3. Purpose separation

The live defect: `mfaKey()` (`server/_core/externalIdentityPolicy.ts:64`) reads one
environment variable, and both `portalRouter.ts:343` (MFA) and `integrationRouter.ts:132` /
`webhookDispatchService.ts:27` (webhooks) use it. Rotating it because a webhook secret leaked
would re-encrypt every driver's MFA seed, and anyone who can decrypt one class can decrypt the
other.

Four purposes, derived from the survey — not invented:

| Purpose | Protects | Evidence it is a distinct class |
|---|---|---|
| `MFA_SECRET` | TOTP seeds | different blast radius (locks people out), different rotation trigger |
| `WEBHOOK_SECRET` | outbound signing secrets | shared with an external subscriber; rotation is coordinated with them |
| `PROVIDER_CREDENTIAL` | provider API keys, OAuth client secrets, refresh credentials, static bearers | held on behalf of an outside provider; rotation is that provider's schedule |
| `INTEGRATION_SECRET` | machine credentials LeaseOS must **present outbound** | LeaseOS-owned machine identity, rotated on our schedule |

No fifth purpose is proposed. `INTEGRATION_SECRET` deliberately does **not** cover
`integrationClients.keyHash`, which is inbound and stays hashed (§2).

**The rule:** compromise or rotation of one purpose must never require exposing or rotating
another. That is the test, not the count.

---

## 4. Key provider boundary

Application code must never read a master key. One narrow module owns that:

```
encryptSecret(purpose, plaintext) -> Envelope
decryptSecret(purpose, envelope)  -> plaintext
```

Key resolution lives behind it. Nothing else in the codebase reads a master-key environment
variable — enforced as a structural test (§16), because a comment cannot stop the second caller.

**First implementation: environment-backed**, one key per purpose, matching what LeaseOS can
deploy today. `mfaKey()` already validates 64 hex characters (32 bytes) and returns `null`
rather than throwing; that shape is kept.

**The path out is the point of the boundary.** A KMS implementation (AWS KMS, Azure Key Vault,
GCP KMS, Vault) replaces the resolver only. Callers pass a purpose and get ciphertext; they
never learn whether the key came from an environment variable or a network HSM. Concretely,
the resolver interface is `resolveKey(purpose, keyId) -> Buffer | null`, and a KMS backend
implements the same signature with a cache. **No caller may be written in a way that assumes a
local key exists** — no synchronous key access, no `Buffer` in a function signature outside
the boundary.

---

## 5. Ciphertext envelope

The existing primitive is sound and is **kept**: AES-256-GCM, a fresh 12-byte random IV per
encryption, authentication tag (`externalIdentityPolicy.ts:65-66`). Authenticated encryption,
unique nonce, tamper detection — all already true. What it lacks is identity.

The current format is an anonymous three-part string:

```
<iv-b64>.<authTag-b64>.<ciphertext-b64>
```

S2 keeps the dotted, column-friendly shape (existing columns are `varchar(400)`) and prefixes
identity:

```
v1.<purpose>.<keyId>.<iv-b64>.<authTag-b64>.<ciphertext-b64>
```

Rather than JSON: it stays comparable in SQL, stays short, and the existing decrypt path can
recognise a legacy three-part value by field count — which is what makes §10's migration
possible without downtime.

**AAD is the load-bearing part.** `purpose` and `keyId` are passed to GCM as *additional
authenticated data*, so they cannot be edited to redirect decryption: changing either makes
the tag fail. Purpose confusion becomes a cryptographic failure rather than a policy check
somebody can forget.

Fail closed on: unknown `keyId`; `purpose` mismatch against the caller's declared purpose;
unknown `version`; wrong field count; failed authentication tag; absent key for that purpose.
Every one returns a refusal, never a plaintext and never a fallback key.

Plaintext is never stored beside ciphertext — no "last four" column holding real characters
(§11 covers the fingerprint alternative).

---

## 6. Secret reference and metadata model

Two tables. Ordinary domain records hold a **reference**, never secret material.

```
providerCredentials                     -- metadata, safe to read widely
  id, credentialRef (unique)
  providerKey            -- "alberta_511"; joins externalDataSources.sourceKey
  environment            -- production | staging | sandbox
  authScheme             -- see §7
  ownership              -- platform | tenant
  orgRef                 -- NULL when ownership = platform; required when tenant
  externalAccountId      -- provider-side account/client id (NOT secret)
  secretRef              -- pointer into encryptedSecrets; never a value
  status                 -- active | disabled | rotating | revoked | expired
  credentialVersion      -- increments on rotation
  fingerprint            -- SHA-256 prefix of the plaintext, for "is this the key I pasted?"
  createdAt, updatedAt, rotatedAt, expiresAt, lastUsedAt
  createdByUserId, disabledByUserId, disabledReason

encryptedSecrets                        -- the only place ciphertext lives
  id, secretRef (unique)
  purpose                -- MFA_SECRET | WEBHOOK_SECRET | PROVIDER_CREDENTIAL | INTEGRATION_SECRET
  keyId                  -- which key encrypted this row
  envelope               -- the §5 string
  createdAt, rewrappedAt
```

Splitting them is deliberate: metadata is read by dashboards, connector health and audit,
while ciphertext is read by exactly one resolver. A single table would mean every metadata
read also selects ciphertext, and the first `SELECT *` becomes a leak. `providerCredentials`
has **no column capable of holding a secret**.

`fingerprint` is a truncated hash, never plaintext characters — it answers "did I paste the
right key?" without disclosing any of it.

---

## 7. Provider authentication schemes

Declared as an enum so a connector states its scheme instead of LeaseOS assuming `API_KEY`:

`NONE` · `API_KEY` · `STATIC_BEARER` · `OAUTH2_CLIENT_CREDENTIALS` · `OAUTH2_REFRESH` ·
`SIGNED_REQUEST` · `MUTUAL_TLS`

**S2 implements the storage foundation for all of them and the resolution path for
`API_KEY` only.** Each connector checkpoint implements its own scheme when it ships. The two
OAuth grants stay distinct because they differ materially: `OAUTH2_CLIENT_CREDENTIALS` holds a
client secret and re-mints access tokens with no refresh token; `OAUTH2_REFRESH` holds a
refresh credential that must be rotated. Collapsing them means storing a credential that does
not exist or never rotating one that does.

`MUTUAL_TLS` holds a client certificate and key — larger than `varchar(400)`, so
`encryptedSecrets.envelope` is `text`, decided now rather than discovered later.

---

## 8. Platform-managed vs tenant / BYOC

**Platform-managed** (`ownership = platform`, `orgRef` NULL): shared public/government feeds —
provincial 511, weather, public infrastructure. Tenants consume authorized *data*; no tenant
role can reach the credential.

**Tenant / BYOC** (`ownership = tenant`, `orgRef` required): where the provider's contract,
licensing, quota, billing or account model requires the customer's own credential.

Both supported, never mixed: resolution takes the tenant context and matches ownership
exactly. A tenant asking for a credential it does not own gets a refusal — **never a silent
fall back to the platform credential**. Any fallback must be an explicit, documented
per-connector policy, and none is proposed in S2.

---

## 9. Reveal policy — write-only

**A stored secret is never retrievable through an application API after it is written.** Not
for tenant admins, not for platform staff, not "just for support".

The UI shows: configured / not configured · fingerprint · `createdAt` · `rotatedAt` ·
`credentialVersion` · `status` · `expiresAt` · `lastUsedAt`. There is no "show API key"
button, and no endpoint that could back one. Rotation means **providing a replacement**, not
reading the old value.

This is a *write-only secret input*, not a *secret details API*. If some provider ever
genuinely requires recoverable export, that is a separate owner decision with its own
approval, audit and step-up — not a capability S2 builds speculatively.

---

## 10. Migration

Ordered so nothing breaks mid-deploy. **No user-visible reset — nobody re-enrols MFA to
migrate an encryption key.**

**Legacy recognition.** A pre-S2 envelope has 3 dot-separated fields; an S2 envelope has 6 and
starts `v1.`. The decrypt path counts fields, so both are readable during the window. This is
the same discriminator-by-shape technique S1-G used for year-long tokens, and it needs no new
column.

**MFA seeds.** Read with the legacy key, re-encrypt under `MFA_SECRET` with a fresh IV, write
back. Idempotent and resumable; a row already `v1.` is skipped. If the legacy key is absent,
**fail closed and stop** — do not create a row that cannot be decrypted, and do not reset the
seed.

**Webhook secrets.** Same shape under `WEBHOOK_SECRET`. The subscriber never learns that
storage changed: the signing secret's *value* is unchanged, so `x-leaseos-signature` continues
to verify on their side. Signing and storage are separate concerns and only storage moves.

**`fleetFuelCards.providerToken`.** Confirm it holds no production data, then drop the column.
If any row is populated, migrate into `encryptedSecrets` under `PROVIDER_CREDENTIAL` first.

**Compatibility window.** Both formats decrypt until a verification query confirms zero
3-field envelopes remain. Only then is the legacy key retired. Rollback during the window is
safe because the legacy reader is still present.

---

## 11. Rotation

Per purpose, a key list rather than one key:

```
MFA_SECRET:          mfa-v2 (encrypt+decrypt), mfa-v1 (decrypt only)
PROVIDER_CREDENTIAL: provider-v1 (encrypt+decrypt)
```

Exactly one **active** key per purpose; any number of **decrypt-only** predecessors. New
writes use the active key. Existing ciphertext stays readable because each row carries its own
`keyId`.

**Staged, never a bulk simultaneous rewrap.** Add the new key as active → new writes use it →
a rewrap job walks rows and re-encrypts → a query confirms no row references the old `keyId` →
only then retire it. No deployment needs every row rewrapped at once.

**Credential rotation is a different thing from key rotation** and both are supported:
replacing a provider's API key increments `credentialVersion` and sets `rotatedAt`; rotating a
master key changes `keyId` and leaves the credential's value untouched.

---

## 12. Authorization

The existing union (`server/_core/recordsAuthorization.ts`) has `integration.read` and
`integration.deliveries`, and `integrationRouter` gates writes on specific permissions like
`integration.clientRegister` and `integration.webhookSubscribe`. **Nothing there is a
credential-management permission, and nothing is platform-scoped.** So S2 proposes new
permissions rather than reusing a convenient broad one:

| Proposed | Scope | For |
|---|---|---|
| `secrets.platformCredentialManage` | platform | create/rotate/disable platform-owned provider credentials |
| `secrets.platformCredentialRead` | platform | metadata and health only — never a value |
| `secrets.tenantCredentialManage` | tenant | a company managing its own BYOC credential |
| `secrets.tenantCredentialRead` | tenant | metadata for its own credentials only |

All four are **fail-closed / sensitive**. A Company Admin does **not** receive platform
credential management by virtue of being an admin — that is the platform-versus-tenant
boundary the identity architecture already establishes, and this is exactly where it would be
quietly violated.

---

## 13. MFA / step-up interaction

Adding, rotating, disabling a provider credential and changing an OAuth client secret are all
sensitive operations that warrant fresh MFA.

S2 **must not build a competing MFA implementation** — S6 owns step-up. So S2 ships the
integration point and not the mechanism: a single `requireAssurance(ctx, "mfa")` seam that
credential mutations call, which in S2 is a permission check plus a recorded assurance
requirement, and which S6 fills in. S1 already persists the raw material —
`sessionFamilies.authAssurance` (`single_factor` | `mfa`) and `mfaCompletedAt` — so the seam
has something real to read on day one.

**Permission checks are mandatory regardless** and never wait for S6. A client-side
confirmation dialog is not step-up and is not accepted as one.

---

## 14. Logging and redaction

Centralized redaction, applied at the boundaries where secrets could escape:

- API keys, bearer tokens, OAuth client secrets and refresh credentials
- `Authorization` headers
- decrypted credential values in flight
- **provider URLs carrying a credential query parameter** — Alberta 511's documented style
- audit payloads, tRPC error bodies, thrown error messages

Alberta 511 takes its key as a query parameter. The server may place it on the *outbound*
request, but the URL must be redacted before it reaches any log, delivery record or error. The
redactor therefore operates on URLs, not only on named fields — a naive field-based redactor
misses `?apiKey=…` entirely, which is the realistic leak.

**Audit records metadata, never values:** "credential rotated, version 3 → 4" and never
"rotated from ABC to XYZ".

Plaintext lifetime is minimized where Node makes that meaningful: resolve immediately before
the outbound call, never assign to module scope, never place in a closure that outlives the
request. Node strings are immutable and not reliably zeroable, so this is stated honestly as
*minimize scope*, not *guarantee erasure* — claiming the latter would be false.

---

## 15. Licensing interaction

**A credential and the right to use what it returns are different questions**, and the
repository already models the second: `externalDataSources` carries `licenceName`,
`licenceUrl`, `attributionRequired`, `shareAlikeObligation`, `commercialUsePermitted`,
`redistributionPermitted`, `rateLimitCalls`, `rateLimitWindowSeconds` and `status`.

S2 attaches credentials **beside** that table (joined on `providerKey` ↔ `sourceKey`) and does
not merge into it. Connector readiness is therefore multi-dimensional:

```
credentialConfigured            -- S2 answers this
apiProductionAuthorized         -- licensing answers this
persistentCacheAuthorized
commercialReuseAuthorized
offlineRedistributionAuthorized
```

For Alberta 511: a configured key plus authorized API access does **not** imply persistent
commercial caching or offline redistribution. Those stay separately gated, and possession of a
developer key is not evidence of commercial reproduction rights.

---

## 16. Failure behaviour — fail closed, always

Refuse, never degrade, on: master key unavailable for the purpose · unknown `keyId` ·
authentication-tag failure · purpose mismatch · malformed or unknown-version envelope ·
credential `disabled` / `revoked` / `expired` · credential missing · tenant requesting another
tenant's credential · licensing gate withholding production API use.

No silent fallback to another key, another tenant's credential, or the platform credential.
A refusal names the *reason class* to the operator and never the secret.

---

## 17. Structural guards

Enforceable tests, not comments:

1. No client-tree import of the secret resolver or `encryptedSecrets` (`client/**` may not reach them).
2. No tRPC output schema exposes an envelope, plaintext or `envelope` field.
3. No master-key environment variable referenced outside the key-provider module.
4. `MFA_SECRET` keys never encrypt `WEBHOOK_SECRET` or `PROVIDER_CREDENTIAL` material, and vice versa.
5. Existing verifier hashes (`integrationClients.keyHash`, `sessionFamilies.refreshVerifierHash`, portal `tokenHash`) are never migrated to reversible storage.
6. `providerCredentials` has no secret-capable column.
7. No `SELECT *` from `encryptedSecrets` outside the resolver.

---

## 18. Deployment and operations

New environment keys, one per purpose, 64 hex characters each:
`LEASEOS_KEY_MFA_V1` · `LEASEOS_KEY_WEBHOOK_V1` · `LEASEOS_KEY_PROVIDER_V1` ·
`LEASEOS_KEY_INTEGRATION_V1`. Legacy `LEASEOS_PORTAL_MFA_KEY` is retained as decrypt-only
until the migration window closes, then removed.

`assertProductionSecrets` (`server/_core/env.ts`) is the existing startup gate and should
refuse to boot in production when a purpose key is missing *for a purpose that has stored
rows* — absent-but-unused is not a failure, absent-but-needed is. **No master key ever appears
in a SQL migration or a database row.**

---

## 19. Genuine owner decisions

Only what cannot be derived from current requirements:

**OD-S2-1 — Is a managed KMS in scope this year?** §4 leaves a clean path and does not require
one. Environment keys mean an operator with host access can read them. Acceptable now, or is
KMS a prerequisite before real provider keys land?

**OD-S2-2 — Does `fleetFuelCards.providerToken` hold production data?** If empty it should be
dropped. I can confirm emptiness in a live database but cannot know operational intent.

**OD-S2-3 — Who holds `secrets.platformCredentialManage` at launch?** Platform security only,
or platform operations too? §12 proposes the permissions; the assignment is yours.

**OD-S2-4 — BYOC in S2 or deferred?** Every provider LeaseOS has named so far (511 feeds,
weather) is platform-managed. Tenant ownership is designed here and could be schema-only for
now, with the write flow deferred until a provider actually requires it.

**OD-S2-5 — Webhook secret rotation and subscribers.** Rotating a signing secret breaks the
subscriber until they update. Does LeaseOS support an overlap window with two valid secrets
(the `previousTokenHash` pattern already used for portal tokens), or is rotation a coordinated
cutover? This changes the schema, so it is worth deciding before S2-E.
