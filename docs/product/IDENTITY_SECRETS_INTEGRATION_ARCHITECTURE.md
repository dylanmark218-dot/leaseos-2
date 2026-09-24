# LeaseOS Identity, Secrets & Integration Security — Architecture

**Status:** architecture, design only. No production code in this branch.
**Baseline surveyed:** `6f52b5740fcacd3eb61a4b4bd42a212292f665bc` (`main`).
**Scope:** the six credential layers, the contract between them, and the build order.

Everything below is cited to the baseline. Where the survey contradicted the proposed architecture, the contradiction is stated rather than designed around.

---

## 0. The rule this document exists to keep

> **Authentication** answers *who are you*. **Authorization** answers *what may you do*. **Provider credentials** answer *what outside system may LeaseOS talk to*.
> They are never interchangeable, and no single token does two of these jobs.

To which the survey adds a fourth, which was missing from the proposal and already exists in the codebase:

> **Licence** answers *what may LeaseOS do with the response once it has it*.
> Holding a provider's API key does not grant the right to store, cache, or serve its content.

---

## 1. Survey verdict by layer

| # | Layer | State on `main` | Evidence |
|---|---|---|---|
| 1 | External API credentials (511, weather, telematics) | **Absent.** No outbound provider-credential store of any kind. | no `apiKey`/`providerCredential`/`connector` table in `drizzle/schema.ts` |
| 2 | Service-to-service (inbound) | **Strong.** | `integrationClients`: `keyHash`, `scopesJson`, `failedAttempts`, `lockedUntil`, `revokedAt` |
| 2b | Service-to-service (outbound/workers) | **Absent.** Background work runs as a user id, not a service identity. | no worker identity found |
| 3 | User authentication | **Works, but the session is far too long-lived.** | `_core/oauth.ts:62-71` |
| 4 | Authorization (RBAC) | **Strong and deep.** 355 permissions, 652 role-gated procedures, 0 bare `protectedProcedure`. | `recordsAuthorization.ts`, gate 5 |
| 5 | Tenant isolation | **Strong.** `orgScopeWhere`, `ownershipScopeWhere`, `jobKeyedScope`, tested per-domain. | `db.ts:160,784` |
| 6 | High-risk verification | **Partial.** TOTP MFA exists for *external* identities only; JIT record access exists; **no platform-admin boundary**. | `portalRouter.ts:340-360`, `restrictedAccessGrants` |

### 1.1 The five findings that matter

**FINDING-1 — The session is a one-year bearer token.**
```ts
// server/_core/oauth.ts:62
const sessionToken = await sdk.createSessionToken(userInfo.openId, { expiresInMs: ONE_YEAR_MS });
res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
```
There is no short-lived access token, no refresh rotation and no server-side revocation list. A token captured once is valid for a year. This is the hardening item recalled in the brief, now verified rather than repeated.

**FINDING-2 — The session cookie is `sameSite: "none"`.**
`_core/cookies.ts` returns `{ httpOnly: true, path: "/", sameSite: "none", secure: isSecureRequest(req) }`. `httpOnly` is right. `sameSite: "none"` means the cookie is sent on cross-site requests, so the cookie layer contributes nothing against CSRF, and `secure` is computed per-request rather than always true. The OAuth callback does have a proper one-time state/nonce CSRF guard, but that protects login, not authenticated mutations.

**FINDING-3 — No outbound provider credential exists yet, which is the good news.**
Nothing to migrate, and no key has yet been placed anywhere wrong. This architecture lands *before* the first one, which is what the brief asked for.

**FINDING-4 — A credential gate is not a licence gate, and LeaseOS already has the licence gate.**
`knowledgeSources` records, per source, four **independent** authorizations — `ragIngestionAuthorized`, `modelTrainingAuthorized`, `apiProductionAuthorized`, `commercialReuseAuthorized` — with `licenceStatus` defaulting to `unassessed`, which permits nothing. The `_core/knowledge/` subsystem (`sourceGate.ts`, `admission.ts`, `perimeter.ts`) enforces admission.

The schema's own worked example is the one from the brief:

> *"Four independent permissions, because 'can we use this?' is four legal questions. **511 Alberta is the case that proves it: LeaseOS may link to that course today and may not store a sentence of it.**"* — `drizzle/schema.ts:7944-7947`

**This contradicts part of the proposal.** The brief proposes the connector "cache data for offline use". For a source assessed `link_and_metadata_only`, caching the content is exactly what the recorded assessment forbids. The credential design is right; the caching step needs the licence gate to authorize it per source, per use.

That assessment lives in the knowledge/training domain today, so whether it governs *operational road data* from the same publisher is a question for whoever holds the licence file — it is **OD-S1** below, not something this document decides.

**FINDING-5 — One key encrypts two unrelated secret classes, with no rotation.**
`LEASEOS_PORTAL_MFA_KEY` (`externalIdentityPolicy.ts:64`) is used for **portal MFA secrets** (`portalRouter.ts:347`) and **webhook subscription secrets** (`integrationRouter.ts:136`). AES-256-GCM is the right primitive and both call sites **fail closed** with `PRECONDITION_FAILED` when the key is absent — that part is well built. But: one key, two purposes, no key id stored with the ciphertext, no rotation path, and no per-tenant separation.

---

## 2. Target architecture — six credential systems

```
                    ┌─ USER WORLD ────────────────────────────────────────┐
  Device identity → │ Session → User → MFA/step-up → Org → Role →         │ → Action → Audit
                    │ Permission → Resource ownership → Safety gate       │
                    └─────────────────────────────────────────────────────┘

                    ┌─ MACHINE WORLD ─────────────────────────────────────┐
  Service identity →│ Connector → secret REFERENCE → provider credential  │ → Provider
                    │                     ↓                               │
                    │              LICENCE GATE (may we store/serve it?)  │
                    └─────────────────────────────────────────────────────┘
```

The two worlds share only the audit log. **No user credential may reach a provider, and no provider credential may reach a browser.**

### 2.1 Layer 1 — External provider credentials

New table, org-scoped, storing a **reference** and never a secret:

```
integrationConnections
  orgRef            NULL = platform-wide (511, weather); non-null = this company's own account
  providerKey       "alberta_511" | "manitoba_511" | "yukon_511" | ...
  credentialType    "none" | "api_key" | "oauth2" | "hmac"
  secretRef         "integrations/alberta511"    -- a pointer, never the value
  status            "active" | "rotating" | "revoked"
  scopesJson        ["traffic/read"]
  knowledgeSourceId → knowledgeSources.sourceId   -- the LICENCE gate (FINDING-4)
  lastRotatedAt, rotationDueAt, createdByUserId, revokedAt
```

Rules:
- `credentialType: "none"` for open feeds — they still go through the connector, so caching, licence and audit apply uniformly.
- OAuth providers store the **refresh** credential server-side; access tokens are held in memory and never persisted beyond their life.
- `orgRef` non-null gives per-company credentials (Company A's telematics ≠ Company B's). The connector resolves by tenant context; A can never request B's connection.
- **Every read through a connector consults `knowledgeSourceId`'s licence** before storing or serving content. Missing assessment ⇒ `unassessed` ⇒ permitted to do nothing.

### 2.2 Layer 2 — Service accounts

Inbound already exists (`integrationClients`). What is missing is **outbound/worker identity**: background jobs currently act as a user id.

```
serviceIdentities: serviceKey ("leaseos-511-ingestion-worker"), scopesJson, status, orgRef?
```
A worker gets `integration.road_data.read` and nothing else. It cannot read employee records, because it never had that permission to lose.

### 2.3 Layer 3 — User authentication (the FINDING-1 fix)

| | Now | Target |
|---|---|---|
| Access token | 1 year | **≤ 15 min**, in memory |
| Refresh/session | none (the access token *is* the session) | httpOnly cookie, rotating, server-side revocable |
| Revocation | none | `sessionRecords` — revoke on logout, device revoke, permission change, MFA reset |
| CSRF | `sameSite: "none"` | `sameSite: "lax"` + `secure: true` always, or an explicit double-submit token |

Rotation-on-use with reuse detection: a refresh token presented twice means it was stolen, and the whole family is revoked.

### 2.4 Layer 4 — Authorization

**No change of approach — it is the strongest layer.** Keep permissions, never `if (role === "admin") allow`. The only additions are new permissions for the new surfaces (`integration.connection.manage`, `platform.support.elevate`), and **sensitivity classes** for profile data:

| Class | Examples | Gate |
|---|---|---|
| ordinary | name, unit assignment, work phone | domain permission |
| controlled | licence, training, qualification, payroll | domain permission + audit |
| restricted | medical, identity documents, banking, investigation | permission + **purpose** + time-limited grant + MFA |

`restrictedAccessGrants` (`purpose`, `expiresAt`, `revokedAt`) is already the right primitive for the third row — it needs the classification, not a new mechanism. **There is no `profile.read_everything`, and none is to be introduced.**

### 2.5 Layer 5 — Tenant isolation

Keep exactly as built. The one rule to restate: **tenancy is a server predicate, never a UI filter**, and a search must be scoped *before* matching so absence cannot confirm another tenant's record.

### 2.6 Layer 6 — High-risk verification

**Step-up, not constant friction.** Normal login on a trusted registered device is password/passkey. MFA is re-demanded for: changing a company admin, payroll edits, reading restricted-class records, permission changes, resetting another user's MFA, changing integration credentials, full-company export, granting overrides, platform-admin customer access, security-policy changes.

**Device identity** — `fieldDevices`, `deviceKeyEvents`, `deviceSyncNonces` and `device.verifySeal` already exist. The addition is a **revocable device credential** distinct from the user: a lost phone is revoked without deleting the person's account.

**Platform administration — the real gap.** There is no platform-vs-company boundary today (domain roles are `dispatcher`, `driver`, `mechanic`, `office`, `safety`). Target: support staff hold a normal platform account with **no standing customer access**, and elevate per incident —

```
request → reason required → MFA → (two-person approval for restricted class)
        → time-limited grant (≤ 30 min) → audit entry → automatic expiry
```

`restrictedAccessGrants` is the model; this needs a platform-scoped sibling, because a company admin's authority must stop at their own organization. **ABC Admin ≠ LeaseOS Platform Admin.**

---

## 3. Secrets handling

**Never** in source, frontend bundles, APK, committed `.env`, logs or URLs. Today's single env key (FINDING-5) becomes:

- **A reference model**: ciphertext carries a **key id**, so rotation is possible without decrypting everything at once.
- **Separate keys per purpose**: MFA secrets and webhook secrets stop sharing one key.
- **A rotation path**: `status: "rotating"` with a grace window, mirroring the existing `ROTATION_GRACE_MS` in `externalIdentityPolicy.ts`.
- **Secret manager in production**, env only in development.

Webhook **inbound** verification already has the right shape documented at `integrationRouter.ts:137` — HMAC-SHA256 over `timestamp.body`, reject timestamps older than five minutes. That rule generalizes: signature + timestamp + replay window + integration identity + tenant + schema, and never *"it arrived at the webhook URL, so it is genuine."*

---

## 4. Audit

Every privileged action records: **who · what · resource · organization · old → new · time · device · session**. `dispatchAuditEvents` is the pattern. Coverage to add: login, failed login, MFA reset, permission change, credential change, restricted-document read, platform elevation, export/download.

One rule carried from `boardSemantics.ts`: an audit log records **what happened**, and does not merge two records because their prose looks similar.

---

## 5. Build order

Highest risk first, smallest first where risk is equal.

| | Checkpoint | Why |
|---|---|---|
| **S1** | Session hardening (FINDING-1, FINDING-2) | The largest live exposure, and it touches no new subsystem. |
| **S2** | Secret reference + key id + per-purpose keys (FINDING-5) | Must precede the first provider credential. |
| **S3** | `integrationConnections` + connector layer + **licence gate** | The 511 work the brief is aiming at. |
| **S4** | Service identities for workers | Shrinks the blast radius of every later integration. |
| **S5** | Profile sensitivity classes over `restrictedAccessGrants` | Uses an existing primitive. |
| **S6** | Step-up MFA for internal users + device revocation | Builds on the working external TOTP. |
| **S7** | Platform-admin JIT elevation + two-person approval | Largest new concept; safe to be last because no standing access exists to remove. |

**S1 before S3.** Shipping provider credentials while a stolen session is valid for a year would put the new secrets behind the old door.

---

## 6. Owner decisions

**OD-S1 — Does the 511 Alberta `link_and_metadata_only` assessment govern operational road data?**
The recorded assessment sits in the knowledge/training domain and explicitly names 511 Alberta as link-only. The proposed connector caches road closures and restrictions for offline use. Either the operational feed is a separately-licensed product (and needs its own `knowledgeSources` row and assessment), or the caching step is not permitted for this source. **This is a licence question, not an engineering one**, and it blocks S3's caching behaviour for that provider — not S3 itself.

**OD-S2 — Session lifetime and re-login tolerance.** A 15-minute access token with a rotating refresh is the standard shape, but drivers work in poor connectivity. How long may a refresh live, and what happens to a device offline past that window?

**OD-S3 — Two-person approval scope.** Which record classes require it? Proposal: restricted class only (medical, identity, banking, investigation).

**OD-S4 — Per-company vs platform credentials for public feeds.** Should 511-type feeds be one platform credential, or may a company supply its own? The table supports both (`orgRef` nullable); the operational default is a policy choice.

---

## 7. Explicit non-goals

No new permission model. No replacement of the RBAC or tenancy layers — they are the strongest parts of the system. No SSO/SAML in this phase. No secrets-manager vendor selection. No changes to the dispatcher domain, which is mid-flight.
