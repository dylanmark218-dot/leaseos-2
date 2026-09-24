# LeaseOS Identity, Secrets & Integration Security — Architecture

**Status:** architecture, design only. No production code in this branch.
**Baseline surveyed:** `6f52b5740fcacd3eb61a4b4bd42a212292f665bc` (`main`).
**Scope:** the six credential layers, the contract between them, and the build order.

Everything below is cited to the baseline. Where the survey contradicted the proposed architecture, the contradiction is stated rather than designed around.

---

## 0a. Owner decisions — recorded

| | Decision |
|---|---|
| **S1 · 511 licensing** | Connector auth = developer API key, server-side only. **API access and transient processing may proceed** on a valid credential. **Persistent caching, offline redistribution and commercial reuse stay BLOCKED** until Alberta's terms explicitly authorize LeaseOS's commercial use. Possession of a developer key is *not* proof of redistribution rights. A training/RAG assessment is **not** automatically applied to operational traffic data — the assessment must name the actual dataset and its terms. |
| **S2 · Sessions** | 15-minute access credential; rotating, server-tracked refresh with a 30-day absolute lifetime; reuse of a rotated refresh revokes the family. Offline Field Mobile is a **device-bound** model, never a longer bearer token. |
| **S3 · Two-person approval** | Exceptional **platform-level** actions on customer Restricted data only — platform JIT access, bulk Restricted export, extraordinary security recovery. Not for routine authorized tenant work. |
| **S4 · Provider credentials** | Platform-managed by default for shared public/government feeds; tenant BYOC only where contract, licensing, quota, billing or provider policy requires it. Both models supported, never mixed. |

### The four credentials, and the boundaries between them

| Credential | Authenticates | Carries LeaseOS user authority? |
|---|---|---|
| **Provider API key / token** | LeaseOS server → outside provider | **Zero.** None. Ever. |
| **Human session** | person → LeaseOS | identity only — permissions are looked up server-side |
| **Machine identity** | authorized service/integration → LeaseOS | narrow scopes only; never `admin:everything` |
| **Webhook secret** | verifies a webhook message | not reusable as MFA or provider-encryption material |
| **MFA secret** | authentication-factor verification only | not an authorization token |

**Secret classes stay cryptographically separated** — separate keys, each with a key id.

---

## 0b. Source-policy model (S1 decision, expressed)

A provider's policy record must express these **independently**, because they are different legal questions:

```
apiAccessAuthorized              -- may we call it at all
transientProcessingAuthorized    -- may we use the response in-flight
persistentCachingAuthorized      -- may we store it
offlineRedistributionAuthorized  -- may we ship it to a device
commercialReuseAuthorized        -- may we use it in a paid product
```

Alberta 511 at this baseline: **apiAccess = yes** (developer key), **transientProcessing = yes**, **persistentCaching / offlineRedistribution / commercialReuse = blocked pending documented permission**. Documented rate limit: **10 requests / 60 seconds** — a connector-level constraint, recorded beside the credential.

`knowledgeSources` remains the right *shape*, but its existing 511 row concerns training/course content. Operational road data needs **its own assessment row naming that feed**; the training decision is not inherited.

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

**FINDING-1b — The session token is also mirrored into `sessionStorage` and sent as a Bearer header.**
```ts
// client/src/main.tsx:54 — "Preview auto-login fallback"
const raw = sessionStorage.getItem("manus-cookie");
… return { Authorization: `Bearer ${token}` };
// server/_core/sdk.ts:286 — cookie first, then this header
```
This path exists because embedded contexts (Safari ITP, private browsing, iOS/Android WebView) block iframe cookies. Its consequence is that the **`httpOnly` protection does not hold on that path**: a one-year token sits in `sessionStorage`, readable by any script on the page. Any session fix that changes only the cookie would miss it entirely — which is why the consumer survey came before the plan.

**FINDING-1c — `ONE_YEAR_MS` is the *default*, not just the OAuth call site.**
`sdk.ts:190` — `const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS`. Changing `oauth.ts` alone would leave every other caller minting year-long tokens.

**FINDING-2 — The session cookie is `sameSite: "none"`, and that is load-bearing.**
`_core/cookies.ts` returns `{ httpOnly: true, path: "/", sameSite: "none", secure: isSecureRequest(req) }`. `httpOnly` is right. `sameSite: "none"` means the cookie is sent on cross-site requests, so the cookie layer contributes nothing against CSRF, and `secure` is computed per-request rather than always true. The OAuth callback does have a proper one-time state/nonce CSRF guard, but that protects login, not authenticated mutations.

**It cannot simply be switched to `lax`.** FINDING-1b shows the app runs embedded, and the client sends `credentials: "include"`. `sameSite: "lax"` would break authenticated use in every iframe/WebView context. So CSRF must be solved **independently of SameSite** (§S1-E of the plan), not by tightening the cookie and hoping.

**FINDING-2b — There is no session table, so revocation is currently impossible.**
`verifySession` (`sdk.ts:204`) is a stateless HS256 `jwtVerify` with no server lookup. Logout clears the cookie (`routers.ts:387`) — but a token already copied out of the browser stays valid for the rest of its year. `grep` finds no `*session*` table in `drizzle/schema.ts`.

**FINDING-2c — A better model already exists next door.**
External/portal identities use `TOKEN_TTL_MS = 90 days` with `ROTATION_GRACE_MS = 10 minutes` (`externalIdentityPolicy.ts:13`) and store bearer tokens **as SHA-256 only**. S1 should follow this precedent rather than invent one.

**FINDING-2d — Cron sessions are a third consumer.**
`sdk.ts:299` branches on a `cron_` openId prefix before the normal user path. Any session change must keep that branch working.

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
  authScheme        see the seven below
  secretRef         "integrations/alberta511"    -- a pointer, never the value
  status            "active" | "rotating" | "revoked"
  scopesJson        ["traffic/read"]
  knowledgeSourceId → knowledgeSources.sourceId   -- the LICENCE gate (FINDING-4)
  lastRotatedAt, rotationDueAt, createdByUserId, revokedAt
```

#### The declared authentication schemes

A connector **declares** its scheme; LeaseOS never assumes one. An earlier draft of this
document collapsed these into four values, which lost a distinction that matters — see the
rule below the table.

| Scheme | What LeaseOS holds | Lifecycle LeaseOS owns |
|---|---|---|
| `NONE` | nothing | — open feed; still goes through a connector |
| `API_KEY` | a long-lived key | rotation only |
| `STATIC_BEARER` | a long-lived token | rotation only |
| `OAUTH2_CLIENT_CREDENTIALS` | client id + secret | **mints** access tokens; there is no refresh token |
| `OAUTH2_REFRESH` | a refresh credential | rotates refresh, mints access |
| `SIGNED_REQUEST` | a signing secret | per-request signature, never transmitted |
| `MUTUAL_TLS` | a client certificate + key | certificate renewal, not token rotation |

**Only the schemes a shipping connector actually needs get implemented.** The enum exists so
that adding one is a connector change rather than a redesign; building all seven during S2
is explicitly out of scope.

Rules:
- `authScheme: NONE` for open feeds — they still go through the connector, so caching, licence and audit apply uniformly.
- **The two OAuth grants are not one scheme.** `OAUTH2_CLIENT_CREDENTIALS` issues an access token and *no* refresh token — LeaseOS re-mints from the client secret when it expires. `OAUTH2_REFRESH` issues both, and the refresh credential is the thing that must be stored and rotated. Treating them alike means either storing a refresh token that does not exist, or never rotating one that does. Earlier drafts of this section said "OAuth providers store the refresh credential server-side" without qualification, which is wrong for the client-credentials grant.
- `SIGNED_REQUEST` and `MUTUAL_TLS` hold material that is **never sent as a bearer value** — a signature is computed per request, a client certificate is presented during the handshake. Neither belongs in a header the way an API key does, and neither is rotated on the token schedule.
- Access tokens under either OAuth grant are held in memory and never persisted beyond their life.
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

**OD-S1 through OD-S4 are CLOSED** — recorded in §0a and reflected throughout §0b, §2.1, §2.3 and §2.6.

### Genuine decisions still open

**OD-S5 — Does the embedded/preview Bearer path survive S1?**
FINDING-1b's `sessionStorage` mirror exists to keep the product working inside iframes and WebViews where cookies are blocked. A 15-minute access credential makes it far less dangerous, but it is still a token readable by page scripts. Either it stays (accepted risk, now short-lived), or embedded contexts move to a different mechanism. **This is a product-surface question** — which embedded contexts must keep working — not a security one, and it shapes S1-E.

**OD-S6 — Refresh lifetime split between Web and Field Mobile.**
S2 sets a 30-day absolute maximum. Web may want shorter. Field Mobile's offline window is governed by the device-bound model (S4/S6), not by the refresh token — but the *maximum disconnected period* before a device must re-authenticate is an operational call.

**OD-S7 — Which feed is Alberta 511's operational dataset, and under what terms?**
§0b requires the assessment to name the actual dataset. Somebody has to identify the operational traffic feed and its licence, separately from the existing training-content row. This blocks S3's caching, not S3's API access.

---

## 7. Explicit non-goals

No new permission model. No replacement of the RBAC or tenancy layers — they are the strongest parts of the system. No SSO/SAML in this phase. No secrets-manager vendor selection. No changes to the dispatcher domain, which is mid-flight.
