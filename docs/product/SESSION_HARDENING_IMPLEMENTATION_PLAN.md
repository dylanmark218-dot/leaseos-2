# S1 — Session Hardening: Implementation Plan

**Status:** plan only. No production code until approved.
**Architecture:** `IDENTITY_SECRETS_INTEGRATION_ARCHITECTURE.md` (same directory).
**Surveyed at:** `6f52b5740fcacd3eb61a4b4bd42a212292f665bc`.
**Branch policy:** fresh branch from then-current `main`. Migration slot: next free is **`0175`** (0174 is the last taken; 0172/0173 are claimed elsewhere — re-verify at implementation time).

**Totals: 8 checkpoints · 34 tests · 14 mutations.**

---

## 1. Consumer survey — every session reader on `main`

Done before planning, because a cookie-only fix would have missed two of these.

| # | Consumer | File | Note |
|---|---|---|---|
| 1 | OAuth callback issues the session | `_core/oauth.ts:62-71` | `expiresInMs: ONE_YEAR_MS`, cookie `maxAge: ONE_YEAR_MS` |
| 2 | Token minting default | `_core/sdk.ts:190` | `options.expiresInMs ?? ONE_YEAR_MS` — **the default is a year** |
| 3 | Token verification | `_core/sdk.ts:204-245` | stateless HS256 `jwtVerify`; **appId binding** at :238 |
| 4 | Request authentication | `_core/sdk.ts:278-296` | cookie first, **then `Authorization: Bearer`** |
| 5 | Cron sessions | `_core/sdk.ts:299,343` | `cron_` openId prefix, separate branch |
| 6 | Auto-provisioning | `_core/sdk.ts:310-325` | unknown user synced from OAuth on first call |
| 7 | Cookie policy | `_core/cookies.ts:42-47` | `httpOnly`, `path:"/"`, `sameSite:"none"`, `secure` per-request |
| 8 | Logout | `routers.ts:384-389` | clears the cookie only — no server-side revocation |
| 9 | **Client Bearer mirror** | `client/src/main.tsx:47-72` | `sessionStorage["manus-cookie"]` → Bearer; `credentials:"include"` |
| 10 | Portal identities (separate) | `_core/externalIdentityPolicy.ts:13` | `TOKEN_TTL_MS` 90d, `ROTATION_GRACE_MS` 10m, tokens stored as SHA-256 |
| 11 | Existing tests | `auth.logout.test.ts`, `_core/sessionAppId.test.ts` | none assume a long lifetime — no test rewrite needed |
| 12 | Shared constant | `shared/const.ts:2` | `ONE_YEAR_MS`, also re-exported to the client |

**No session/device table exists** (`grep` over `schema.ts`), so revocation is impossible today. **Websockets/SSE: none** — nothing to migrate there.

---

## 2. Current flow vs target flow

**Current**
```
OAuth callback → createSessionToken(openId, 1 YEAR) → httpOnly cookie (1 year)
                                                    ↘ sessionStorage mirror → Bearer header
every request → cookie OR Bearer → jwtVerify (stateless, appId checked) → user
logout → clearCookie          ← token copied out of the browser stays valid ~1 year
```

**Target**
```
OAuth callback → create session FAMILY (row) → access JWT (15 min) + refresh verifier (opaque, hashed at rest)
every request → access JWT → jwtVerify (stateless, appId checked)      [unchanged chokepoint]
access expired → POST refresh → verify hash → ROTATE → new access + new refresh
reused refresh → REUSE DETECTED → revoke entire family → re-login
logout / revoke device / revoke all → family.revokedAt set → next refresh refused
```

Access tokens stay stateless and cryptographically verifiable — no global revocation list on the hot path. **Revocation bites at refresh**, bounding residual authority to ≤ 15 minutes.

---

## 3. Schema (migration `0175`)

```
sessionFamilies
  id, familyRef (unique)
  openId, appId                     -- appId stored, so a family is bound to one surface
  tenantContext            NULL     -- reserved; acting scope stays resolved per request
  refreshVerifierHash               -- SHA-256 of the verifier. NEVER the raw token.
  rotationCounter          int      -- increments per rotation
  authAssurance            enum("password","mfa")     -- S6 extends; S1 only records
  mfaCompletedAt           timestamp NULL
  deviceRef                NULL     -- reserved for S4/S6
  createdAt, lastUsedAt
  absoluteExpiresAt                 -- createdAt + 30 days, never extended
  revokedAt, revokeReason  enum("logout","revoked_all","device_revoked",
                                "reuse_detected","credential_change","admin","expired")
  userAgentHash, ipHash    NULL     -- hashed, optional, privacy-consistent
```

Index `(openId, revokedAt)` for revoke-all; unique on `familyRef`.

**Raw refresh tokens are never stored** — `refreshVerifierHash` follows the precedent already set for portal bearer tokens (`externalIdentityPolicy.ts`: *"a bearer token is stored only as its SHA-256"*). A database leak alone yields no usable credential.

---

## 4. Checkpoints

### S1-A — Session persistence
`0175`, `sessionFamilies` in `schema.ts`, and `_core/sessionFamily.ts` (pure: verifier generation, hashing, rotation arithmetic, absolute-expiry check). **No wiring yet.**
**Tests (6):** raw token never persisted · hash verifies · absolute expiry computed from `createdAt` · rotation increments · revoked family refuses · expiry not extendable by rotation.

### S1-B — Short-lived access issuance
Change the **default** at `sdk.ts:190` (FINDING-1c), not just the OAuth call site. `ACCESS_TOKEN_TTL_MS = 15 min` exported from `shared/const.ts` beside `ONE_YEAR_MS`, which stays only for the legacy window in S1-G.
**Tests (3):** access token expires at 15 min · OAuth callback issues 15 min not a year · no caller can mint a year-long user session.

### S1-C — Refresh rotation and reuse detection
New endpoint (`auth.refresh`), rotating on every use. Reuse of a retired verifier revokes the family — the standard stolen-token signal.
**Tests (5):** refresh works once · rotation replaces the verifier · old verifier refused · **reuse revokes the family** · refresh refused past `absoluteExpiresAt`.

### S1-D — Logout and revocation
`auth.logout` revokes the family (not just the cookie). Add `auth.revokeSession`, `auth.revokeAll`. Credential-change hooks revoke families.
**Tests (5):** logout revokes family · revoke-all kills every family for the account · another user's family cannot be revoked · revoked family refused at refresh · residual access ≤ 15 min, asserted explicitly.

### S1-E — Cookie and CSRF
**`sameSite` cannot simply become `lax`** (FINDING-2): the app runs embedded and the client sends `credentials: "include"`. So:
- `secure: true` **always** (stop computing it per-request), `httpOnly`, narrow `Path` for the refresh cookie (`/api/auth`) so it is not sent on every request.
- **CSRF solved independently of SameSite**: double-submit token on cookie-authenticated state-changing calls, and origin checking on the refresh endpoint.
- The OAuth `state` nonce stays as-is — it protects login, not mutations.
- The refresh cookie, unlike the access token, **may** be `sameSite: "lax"` if embedded refresh is not required — pending **OD-S5**.

**Tests (4):** `Secure`+`HttpOnly` set · refresh cookie path narrow · state-changing call without CSRF protection refused · cross-origin refresh refused.

### S1-F — App binding and assurance
Preserve `sdk.ts:238` exactly, and carry `appId` into the family so a refresh cannot cross surfaces. Record `authAssurance`/`mfaCompletedAt` — **S1 records, S6 enforces**.
**Tests (4):** one appId cannot authenticate as another (regression on the existing invariant) · a family issued for app A cannot refresh as app B · assurance recorded at login · session with MFA distinguishable from one without.

### S1-G — Legacy transition
Existing year-long tokens **must not stay valid for the rest of their year**.

Strategy: a **cutover instant** `LEGACY_SESSION_CUTOFF`. A token with no `familyRef` claim is accepted only if issued before the cutoff **and** within a short grace window (proposed **7 days**), during which its bearer is silently upgraded to a family on next use. After the window, legacy tokens are refused and the user logs in again. The grace exists so the fleet is not logged out mid-shift; it is bounded, and it is a window, not a year.
**Tests (4):** legacy token inside the window is accepted and upgraded · legacy token past the window refused · upgraded session gets a real family · a forged "legacy" token (bad signature) refused regardless.

### S1-H — Security, mutation, full verification
**Tests (3):** cross-tenant authority is not conferred by a session (identity only; permissions still looked up) · **no provider API credential ever appears in session claims** · cron sessions still authenticate.

Then the 14-mutation battery and the complete clean-DB `scripts/ci-gate.sh` on a uniquely named database.

---

## 5. Mutations (14)

| Mutation | Test that must fail |
|---|---|
| raw refresh token stored instead of hash | A1 |
| absolute expiry extended on rotation | A6 |
| access TTL reverted to `ONE_YEAR_MS` | B1 |
| default at `sdk.ts:190` left at a year | B3 |
| old verifier accepted after rotation | C3 |
| reuse detected but family not revoked | C4 |
| logout clears cookie without revoking | D1 |
| revoke-all scoped to one family | D2 |
| revocation check skipped at refresh | D4 |
| `secure` made conditional again | E1 |
| CSRF check removed | E3 |
| appId comparison removed (`sdk.ts:238`) | F1 |
| refresh allowed to cross appId | F2 |
| legacy grace window unbounded | G2 |

Each restored byte-for-byte and verified by digest. A surviving mutation is a test gap to investigate.

---

## 6. File inventory

**New (6):** `drizzle/0175_session_families.sql` · `_core/sessionFamily.ts` + test · `server/sessionFamily.db.test.ts` · `server/sessionCsrf.test.ts` · `server/sessionLegacyTransition.db.test.ts`.

**Edited (7):** `drizzle/schema.ts` · `_core/sdk.ts` · `_core/oauth.ts` · `_core/cookies.ts` · `server/routers.ts` (logout + refresh/revoke) · `shared/const.ts` · `client/src/main.tsx` (refresh handling; Bearer mirror per OD-S5).

**Not touched:** RBAC, tenancy, dispatcher domain, portal/external identity system, MFA implementation, provider connectors.

---

## 7. Risks

1. **Logging the fleet out.** Mitigated by S1-G's bounded grace window rather than an instant cutover.
2. **Embedded contexts.** The Bearer mirror is why `sameSite: "none"` exists; changing it blindly breaks WebView use. Held as **OD-S5** rather than guessed.
3. **`authenticateRequest` is the single chokepoint** — a mistake there is total. Mitigated by keeping the access-token path stateless and unchanged in shape, and adding state only at refresh.
4. **Cron and auto-provisioning branches** are easy to overlook; S1-H pins cron explicitly.
