# LeaseOS security baseline — SEC-0

**Inspected commit:** `6f52b5740fcacd3eb61a4b4bd42a212292f665bc` (`origin/main`, 2026-09-23).
**Branch carrying this document:** `claude/leaseos-security-architecture-f2j1vn`, started from that commit with no
other changes. Working tree was clean at inspection; no history was rewritten; no user work was reset.

This is a *measurement*, not a design. Every row is labelled with one of
`IMPLEMENTED · PARTIAL · STUB · DOCUMENTED ONLY · MISSING · UNKNOWN`, and every claim cites the file and line it
was read from. Nothing marked UNKNOWN has been promoted to IMPLEMENTED anywhere in this document. Where the
repository's own documentation disagrees with the code, the code wins and the disagreement is recorded.

How it was produced: six independent read-only surveys of the tree (authentication and perimeter; authorization and
tenancy; data protection, audit and supply chain; AI paths; offline, mobile and export channels; secrets, workers,
medical vault and incident workflow), then a second reading of the lines behind every finding ranked high or
critical. No code was executed: `node_modules` is absent in the inspection container, so anything that depends on a
library's runtime default is marked as unverified rather than assumed.

Companion documents: the design (`docs/superpowers/specs/2026-09-23-leaseos-zero-trust-security-design.md`), the
program decomposition (`docs/security/LEASEOS_SECURITY_PROGRAM.md`) and the first tranche's implementation plan
(`docs/superpowers/plans/2026-09-23-leaseos-security-sec-1-tenant-resource-authorization.md`).

---

## 1. Exact inspected SHA and forensic baseline

| Item | Value |
|---|---|
| Repository | `/home/user/leaseos-2` → `https://github.com/dylanmark218-dot/leaseos-2` |
| Canonical main | `origin/main` = `6f52b57` ("SPINE item 1: per-boundary confirmation — resolver and chain rule (#10)") |
| Working tree | clean (`git status --short` empty) before any document was written |
| Release row | v23.25 (`LEASEOS_RELEASE`) |
| Generated counts | 410 tables, 169 migration files, 652 `roleProcedure`, 36 `externalProcedure`, 2 `integrationProcedure`, 0 bare `protectedProcedure`, 355 permissions in the generated table — **an undercount**: the generator's pattern `/"([a-z_.]+)"/` skips the six camelCase permissions (`device.verifySeal`, `geo.locationVerifyFromGrid`, `hos.recordScannedLog`, `timeOff.decide`, `timeOff.request`, `timeOff.schedulingRead`) and counts one word quoted in a comment (`valid`); the union holds **360** unique names, with `commercial.read` and `hos.read` each declared twice (§4), 125 sensitive, 13 universal, 319 test files / 4,347 `it(` (`LEASEOS_CURRENT_STATE.md:7-20`) |
| Migration head on main | `0174_dispatch_override_provenance.sql`; gaps at 0094, 0095, 0098, 0172, 0173; `0157` used twice; 0016/0017 reserved (`docs/architecture/MIGRATION_COLLISION_REGISTER.md`) |
| Superseded work not to be re-merged | `claude/leaseos-auth-workspace-system-t008ad` (`docs/register/PORTAL_ORG_SCOPE_DEFERRED.md` §7) |
| Related branches NOT on main | ELD ledger `shared/eld/eldEvent.ts` (branch `claude/eld-compliance-intelligence-ramlrd`); webhook tenant test `server/webhookTenantIsolation.db.test.ts` and fix `3c4f997` (branch `feature/tenant-scope-foundation`); AI fencing `server/_core/ai/` (PR #7 branch) |

The work order suggested `security/zero-trust-architecture` as a branch name. This session is bound to the branch
named above by its own mandate and may not push elsewhere; the branch is the isolation the work order asks for.

---

## 2. Authentication inventory

Four authentication paths exist. There is no local password anywhere: `server/authArchitecture.test.ts:60-80`
asserts no password column, no bcrypt/argon2/scrypt.

| Path | Entry point | Identity source | Credential | Validation | Expiry | Rotation | Revocation | MFA | Lockout | Rate limit | Audit | Failure behaviour | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Staff OAuth** | `GET /api/oauth/callback` (`server/_core/oauth.ts:19`); login starts in `client/src/const.ts:15-31` | Manus WebDev auth service (`ExchangeToken`, `GetUserInfo`, `sdk.ts:32-34`) via `OAUTH_SERVER_URL` | Session JWT HS256, claims `openId, appId, name, exp` only (`sdk.ts:194-201`), signed with `JWT_SECRET` | `state.nonce` must equal `__Host-oauth_state` cookie (`oauth.ts:31-38`, `shared/const.ts:11`); token verified per request in `verifySession` (`sdk.ts:204-252`) incl. `appId` equality when `ENV.appId` set (`:238-241`) | **365 days** (`shared/const.ts:2`, `oauth.ts:62-71`) | none | **none** — no session table, logout only clears the cookie (`routers.ts:385-389`; `audit/hardening-2026-09-21/REMEDIATION.md` SEC-3) | none | none | none | login not audited; every `roleProcedure` decision audited afterwards | callback errors → 500 with generic body (`oauth.ts:74-77`); `createContext` swallows auth errors to `user=null` (`context.ts:16-21`) | IMPLEMENTED (login), MISSING (lifecycle) |
| **Bearer mirror of the same JWT** | `Authorization: Bearer` accepted in every environment when no cookie (`sdk.ts:286-291`); client reads `sessionStorage["manus-cookie"]` (`client/src/main.tsx:53-62`) | same | same token, readable by page script | same | same | same | same | none | none | none | same | writer of the sessionStorage key is not in this repo (Manus runtime presumed) | IMPLEMENTED; exposure recorded as SEC-2 in the hardening audit, unfixed |
| **Cron session** | same cookie/bearer path, `openId` prefixed `cron_` (`sdk.ts:299-306, 343`) | Manus scheduler via `getUserInfoWithJwt` (`:254-276`) | platform-minted JWT (nothing in this repo mints one) | `appId` check first, then platform `taskUid` required (`:301-304`; `sessionAppId.test.ts:133-160`) | platform | platform | platform | n/a | n/a | none | none | user id −1, role `user`, no grants → every `roleProcedure` denies (`recordsAuthorization.ts:1985-2006`); reaches only the 3 public procedures | PARTIAL; whether the platform token carries this `appId` and a `name` claim is an open external prerequisite (`REMEDIATION.md` "External deployment prerequisites") |
| **Portal external identity** (customer / vendor / facility) | `externalProcedure` (`server/_core/trpc.ts:156-210`), header `x-portal-token` or `Authorization: Portal` | `externalIdentities` row bound to exactly one account (`drizzle/schema.ts:4871-4899`) | 32 random bytes base64url; stored as **unsalted SHA-256** (`externalIdentityPolicy.ts:20-21`); invitation token likewise | hash lookup → `credentialCheck` (status, accepted, expiry, lock) (`externalIdentityPolicy.ts:23-31`) → kind permission map (`recordsAuthorization.ts:2980-2984`) | invitation 7 d, bearer **90 d** (`externalIdentityPolicy.ts:12-13`) | `portal.tokenRotate`, previous hash honoured 10 min (`portalRouter.ts:366-376`; `db.ts:1491-1499`) | `portalAdmin.identityRevoke` sets status revoked (`commercialRouter.ts:124-133`); gate refuses | TOTP SHA-1/30 s/6 digits/±1 step, secret AES-256-GCM under `LEASEOS_PORTAL_MFA_KEY`; enforced **only** on the 10 sensitive external permissions and only when the identity enabled it (`trpc.ts:186-196`) | 5 failures → 15 min (`:15-16`), but incremented **only on MFA failure**; an unknown bearer increments nothing (`trpc.ts:180-193`) | none | every decision, allowed or refused, → `authorizationDecisions` with `actorUserId=null` (`trpc.ts:165-168, 201`); sensitive writes fail closed if the audit row cannot be written (`:202-204`) | refusals are named ("locked until <iso>") | IMPLEMENTED with gaps: TOTP compared with `===` (`externalIdentityPolicy.ts:55`), no last-used-step so a code replays within its window, `identityInvite`/`identityRevoke` not org-scoped (`commercialRouter.ts:113, 129`) |
| **Integration client (machine)** | `integrationProcedure` (`trpc.ts:227-252`), header `x-integration-key` | `integrationClients` row with `orgRef` (`schema.ts:5494-5510`; `0111`) | 32 random bytes, unsalted SHA-256 `keyHash` (`integrationRouter.ts:99-104`) | hash lookup; refuse without `orgRef`, not active, or locked (`trpc.ts:242-244`) | none | none (revoke and re-register) | `integration.clientRevoke`, org-scoped (`integrationRouter.ts:108-115`) | n/a | columns exist and are read, **never written** (no writer of `failedAttempts`/`lockedUntil`) | none | every decision audited; `inbound.ingest` fails closed | replay handled only by `(clientId, idempotencyKey)`; no timestamp, nonce or HMAC on inbound (`integrationRouter.ts:187-188`) | IMPLEMENTED; lockout PARTIAL |
| **Field device (P-256)** | `device.enroll/activate/rotateKey`, `sync.receivePackage` (`server/deviceRouter.ts`) | device row bound to user **and** acting org (`deviceRouter.ts:55, 186-189`) | ECDSA P-256 public key, SHA-256 fingerprint (`_core/deviceSignature.ts:27-39`) | signature over canonical package, ±10 min, unique nonce (`deviceRouter.ts:211-245`) | key rotated by client every 30 d; retired key honoured 72 h (`_core/fieldDevice.ts:55, 97-110`) | yes | `device.revoke` (`device.manage`, sensitive) sets revoked and closes key events; **does not** end the user's session or invalidate received packages (`deviceRouter.ts:109-128`) | n/a | n/a | none | key events, `deviceSyncNonces`, `syncPackages` | a device never replaces the user: `roleProcedure` still needs a session and `admitPackage` requires device.user == session user (`fieldDevice.ts:71-73`) | IMPLEMENTED server-side; attestation is **self-declared** (`deviceRouter.ts:43, 52-54`); no device limit; self-activation with no office approval |

**Not present anywhere:** WebAuthn/passkeys, magic links, refresh tokens, recovery codes, account recovery flow, local
passwords, SMS. (Searched `webauthn|passkey|fido|navigator.credentials|magic|refresh_token|recovery`.)

**Admin platform role.** `users.role='admin'` is set only when the OAuth `openId` equals `OWNER_OPEN_ID`
(`server/db.ts:126-128`), on every login and every authenticated request (`oauth.ts:54`; `sdk.ts:316, 334`). No
procedure writes `users.role`; changing the environment variable does not demote the previous admin. The role
unlocks exactly three procedures (§4).

---

## 3. Session inventory

| Property | Value | Evidence | Status |
|---|---|---|---|
| Creation | HS256 JWT after OAuth callback | `sdk.ts:171-202`, `oauth.ts:62` | IMPLEMENTED |
| Claims | `openId, appId, name, exp`; **no** `iat, iss, aud, sub, jti` | `sdk.ts:194-201` | PARTIAL |
| Absolute lifetime | **1 year**, cookie `maxAge` equal | `shared/const.ts:2`; `oauth.ts:62-71` | IMPLEMENTED (as designed, not as required) |
| Idle timeout | none | — | MISSING |
| Step-up / recent-auth timeout | none | — | MISSING |
| Cookie | `app_session_id`; `httpOnly`, `path=/`, **`sameSite=none`**, `secure` only if request or `x-forwarded-proto` is https; no domain | `_core/cookies.ts:11-47` | PARTIAL |
| CSRF posture | no CSRF token, no Origin/Referer check; OAuth start protected by `__Host-` nonce cookie. tRPC is JSON-POST, so a cross-site form cannot reach it without a preflight, and **no CORS middleware exists** — that absence is currently the only thing making `SameSite=None` survivable | `server/_core/index.ts:45-59`; no `cors` in `package.json` | PARTIAL (accidental) |
| Bearer header fallback | accepted everywhere | `sdk.ts:286-291` | IMPLEMENTED (weakens httpOnly) |
| Verification per request | signature, three non-empty claims, `appId` equality | `sdk.ts:204-252` | IMPLEMENTED |
| Write on every request | `lastSignedIn` upsert | `sdk.ts:334-337` | IMPLEMENTED |
| Logout | clears cookie (`maxAge:-1`) and the sessionStorage mirror; token stays valid until `exp` | `routers.ts:385-389`; `useAuth.ts:45-47` | PARTIAL |
| Revoke one / revoke all | none; no session table | `drizzle/schema.ts:3-13` is the only identity table | MISSING |
| Password-reset consequence | n/a (no passwords) | — | n/a |
| Termination consequence | `workforce.offboardingRevokeAccess` revokes role grants and devices (`workforceRouter.ts:239-251`); **the session itself survives until `exp`**; ending an org membership without revoking grants leaves a working session with `single_tenant_fallback` reach (`docs/register/PORTAL_ORG_SCOPE_DEFERRED.md` §8) | | PARTIAL |
| Privileged-session handling | none; admin and management sessions are ordinary sessions | — | MISSING |
| Device binding of the session | none | — | MISSING |
| Client-side copies | `sessionStorage["manus-cookie"]` (token), `localStorage["manus-runtime-user-info"]` (full `users` row incl. email; overwritten with `"null"` on logout, not removed) | `main.tsx:53-62`; `useAuth.ts:53-57` | PRESENT |
| Portal sessions | stateless bearer, 90 d, rotation with 10-min grace, revocation by status | §2 | IMPLEMENTED |

**Verified:** the year-scale session the work order asked about **still exists** and is the only staff session
mechanism. Not changed here.

---

## 4. Authorization inventory

### 4.1 Gate builders (`server/_core/trpc.ts`)

| Builder | Checks | Adds to ctx | Audit | Fail-closed | Uses | Status |
|---|---|---|---|---|---|---|
| `publicProcedure` (:11) | nothing | — | none | — | 3: `auth.me`, `auth.logout` (`routers.ts:384-385`), `system.health` (`_core/systemRouter.ts:6`) | IMPLEMENTED |
| `protectedProcedure` (:13-28) | logged in | `user` | none | — | **0** live uses; gate 5 and `procedureAuthorization.test.ts` keep it at 0 | retired |
| `adminProcedure` (:30-45) | `users.role === "admin"` | `user` | **none** | — | 3: `system.notifyOwner`, `records.roles.bootstrapManagement`, `records.roles.bootstrapStatus` | IMPLEMENTED, unaudited |
| `roleProcedure(name)` (:71-136) | permission resolved at wiring time (throws if unmapped); per request `listActiveUserRoles` → `authorize()` with **no `resourceBranch`** | `roles` | every decision → `authorizationDecisions` (:90-102) | allowed + audit-write-failed + sensitive → 500 refusal (:111-117); ordinary reads proceed unrecorded | 652 | IMPLEMENTED |
| `externalProcedure(name)` (:156-210) | §2 | `external{identityId, kind, accountId}` | every decision | sensitive external writes | 36 (all `portalRouter.ts`) | IMPLEMENTED |
| `integrationProcedure(name)` (:227-252) | §2 | `integration{orgRef, scopes}` | every decision | `inbound.ingest` | 2 | IMPLEMENTED |

Context carries only `user`; roles are resolved per gate, tenant per handler (`context.ts`).

### 4.2 Permission model (`server/_core/recordsAuthorization.ts`)

- 15 `DomainRole`s (:26-43), explicit per-role `GRANTS` (:349-1667) with no inheritance; explicit `DENIALS`
  (:1702-1730) that beat grants. Grant counts: management 242, office 155, controller 146, safety 116, dispatcher 104,
  shop_lead 84, driver 77, bookkeeper 67, mechanic 60, auditor 49, hr 34, tax_preparer 29, legal 24,
  external_accountant 24, payroll_admin 16.
- `Permission` union: 360 unique literals (`commercial.read` and `hos.read` declared twice); 337 used by procedure
  maps; `payroll.bank.read` and `payroll.tax_identifier.read` held by **no role by design** (:1709-1721).
- `SENSITIVE_PERMISSIONS` 125 (:1737-1920); `UNIVERSAL_PERMISSIONS` 13 self-scoped (:1668-1691);
  `EXTERNAL_SENSITIVE_PERMISSIONS` 10 (:3036); `INTEGRATION_SENSITIVE_PERMISSIONS` 1 (:3058).
- `authorize()` (:1978-2057): unauthenticated → denied; bare role names normalise to **global** grants; a
  branch-confined grant is out of scope unless the caller resolved `resourceBranch` (fail closed, :2009-2016); deny
  beats grant; then GRANTS. **No production caller passes `resourceBranch`**, so branch grants satisfy only the 13
  universal permissions today.
- Role-grant readers: `listActiveUserRoles` (`db.ts:1209-1227`, `revokedAt IS NULL`), `listActiveUserRoleNames`
  (global only, pinned by `_core/branchGrantLaundering.test.ts`), `listRoleNamesAnyScope` (documented "not for
  authorization"; one caller). **Two readers bypass all three and ignore `revokedAt` and scope:**
  `_core/commercialApprovalService.ts:30` and `commercialOfficeRouter.ts:207` — revoked or branch-confined grants
  count toward approver standing for cash and purchasing approvals.
- Granting: `records.roles.grant` (`recordsRouter.ts:1009-1034`; `roles.grant`, management only, sensitive;
  `userInScope` check) — input enum allows only the 10 original roles, so **no production path grants the five
  finance roles**; no self-grant or privilege-ceiling check. Bootstrap: `roles.bootstrapManagement`
  (`adminProcedure`) grants global management to any user id with no org check, closes once **any** management grant
  exists anywhere (`db.ts:1275-1288`), logged to `roleBootstrapEvents`. Revocation exists only inside
  `workforce.offboardingRevokeAccess`; no standalone `roles.revoke`.
- `userRoleAssignments` (`schema.ts:3071-3092`): `scopeType global|branch`, unique active key (`0021`). **No
  organization scope** — the single change every tenancy item waits on (`PORTAL_ORG_SCOPE_DEFERRED.md` §2).

### 4.3 The chain each procedure must complete

```
ROUTE → AUTHENTICATION → TENANT → ROLE → PERMISSION → RESOURCE CHECK → AUDIT
```

| Link | Provided by | Coverage on main |
|---|---|---|
| Authentication | `createContext` + gate | all 693 gated procedures |
| Role, permission, audit | `roleProcedure` / `externalProcedure` / `integrationProcedure` | all 690 non-public, non-admin procedures |
| Tenant | `resolveActingScope` / `actingScopeFor` **inside each handler** (97 + 80 call sites) | **not structural**: a handler that forgets it is indistinguishable from one that has it |
| Resource check | per-domain `*InScope` helpers, `scopeWhere`, `authorizeRecordScope` | uneven; see 4.4 |

The `adminProcedure` trio completes none of tenant, permission or audit.

### 4.4 Procedures that cannot complete the chain (confirmed by reading)

| Procedure(s) | Missing link | Evidence |
|---|---|---|
| `fieldRoute.assistant.draft` | tenant on client-supplied `tripId`, `jobId`, `unitId`, `targetRecordId` | `routers.ts:677-682, 720-725`; `proposalInScope` checks jobId first and returns `true` for an absent proposal (`db.ts:916-925`) |
| `fieldRoute.assistant.commit` | tenant on the target rows it writes | `assistantCommitAdapters.ts:361-661` (no tenant check on `tripStops`, `units`, `financialEntities`) |
| `compliance.passport`, `jobPassport`, `medicalEligibility`, `credentialRecord`, `credentialVerify` | tenant on `subjectId`/`operatorId`/document id | `complianceRouter.ts:50-58, 66-104, 106-138`; `audit/security-2026-09-21/FINDINGS.md:108-111` |
| `audit.packageList/packagePrepare/…/packageDownload` | tenant (no org column on `auditPackages`) | `auditRouter.ts:268-272`; `schema.ts:5800-5829` |
| `closeout.documentRender` | resource (`fieldTicketInScope` present on siblings, absent here) | `closeoutRouter.ts:327-360` |
| `invoicing.render`, `invoicing.send` | tenant | `invoicingRouter.ts:58-78, 119-134` (no acting-scope call in file) |
| `restrictedVault.matterOpen`, `investigationPropose` | tenant on `incidentReports` (table has no `orgRef`) | `restrictedVaultRouter.ts:57, 154` |
| `restrictedVault.breakGlass` | resource existence and tenant of the target record | `restrictedVaultRouter.ts:226-252` |
| `surfaces.chain` hops; `surfaces.search` | tenant (14 unscoped queries; permission filter only) | `surfacesService.ts:206-246, 339-395` |
| `surfaces.exceptions`, `myDay` loaders | tenant on open security incidents and compliance document titles and proposals awaiting read-back | `surfacesService.ts:68-72, 307-318` |
| `device.verifySeal`, `sync.resolveConflict`; `sync.receivePackage` item ids | tenant | `deviceRouter.ts:274-305, 362-424` |
| `comms.packageFetch`, `packageStatus` | tenant (no org column on `communicationPackages`) | `commsRouter.ts:747-758`; `0076:14-46` |
| `portalAdmin.identityInvite`, `identityRevoke` | tenant | `commercialRouter.ts:113, 129` |
| `commercialOffice.deliveryUpdate` | tenant (sibling `documentDeliveryRecord` checks book org) | `commercialOfficeRouter.ts:645-654` |
| `securityIncidents.timelineAppend` | permission (state changes under `incident.create`, which drivers hold) | `securityIncidentsRouter.ts:69-71`; `recordsAuthorization.ts:2322-2330` |
| `securityIncidents.organizationAffect` | resource (any `orgRef` string accepted) | `securityIncidentsRouter.ts:77-82` |
| `fieldRoute.evidence.upload` duplicate path | resource (global `clientCaptureRef` lookup returns another user's record id and key) | `db.ts:202-207`; `routers.ts:427-430` |
| Six client-supplied `storageKey` inputs | resource ownership (shape check only) | `_core/storageKey.ts:37-43`; `routers.ts:462,1529,1618`; `recordsRouter.ts:104`; `hosRouter.ts:76`; `commercialOfficeRouter.ts:554,577` |
| `documents.list` | resource classification (returns medical rows' `title`, `identifier`, `storageKey` under `compliance.read`) | `routers.ts:1521`; `db.ts:717-726` |
| Worker rules and enforcement handler | role/permission (write directly under `actorSource: "system"`) | `workflowRuntime.ts:183, 413-420`; `enforcementOutbox.ts:76-110` |

Export, print and background-worker authorization are covered in §11 and §13.

---

## 5. Tenant-boundary inventory

| Surface | Mechanism | Status |
|---|---|---|
| Acting tenant derivation | `resolveActingScope` (`_core/actingScope.ts:65-103`): active membership within effective dates → that org; two → `AmbiguousOrganization` thrown; none → `SINGLE_TENANT_ID="default"` (`single_tenant_fallback`) | IMPLEMENTED; the fallback is the designed hole (§5 note) |
| Tenant from request body | not used for the acting tenant in any router checked; `tenantIsolation.test.ts:98-125` pins three routers; `orgRef` inputs name counterparties only | IMPLEMENTED (by convention + partial test) |
| Row scoping idioms | `orgScopeWhere` (20 uses), `ownershipScopeWhere`, `scopeWhere/orgOf` (vault), `bookWhere` (commercial), `userInScope` (**ignores effective dates**, `db.ts:817-822`) | PARTIAL |
| Column coverage | `orgRef` 39 tables, `tenantId` 19, `bookOrgRef` 13, **none on 341 of 409** | PARTIAL |
| Per-tenant tables without an org column | `complianceDocuments` (derived via CASE, `user`/`carrier` owners fall to NULL), `units`, `operators` (ownership table), `workOrders`, `fieldTickets` (via parent), `incidentReports`, `invoices`, `loads`, `disposalTickets`, `nearMissReports`, `legalHolds`, `externalIdentities`, `auditPackages`, `communicationPackages`, `userRoleAssignments`, `authorizationDecisions` | PARTIAL / MISSING |
| Database reads | per handler (§4.4 lists the confirmed misses) | PARTIAL |
| Database writes | same | PARTIAL |
| Object storage | keys are opaque; no tenant prefix; client-supplied keys checked for shape only | MISSING |
| Attachments | `attachmentAuthorization` pure checks + per-kind resolvers; `exists` checks unscoped; `scopeNote` claims `jobs` has no org column but `jobs.orgRef` exists (`schema.ts:18`) | PARTIAL |
| Search | `surfaces.search` 14 queries unscoped, permission-filtered only | MISSING |
| Knowledge retrieval | `assistantAsk.ask` tenant-filtered in SQL and via `contextAdmission.admitSource` (`assistantAskRouter.ts:138-142, 242-256`) | IMPLEMENTED |
| AI proposals | draft/commit unscoped (§4.4) | MISSING |
| Exports / reports | audit packages unscoped; evidence/payroll exports scoped but produce no bytes | PARTIAL |
| Queues / outbox | `domainEventOutbox.tenantId` written in-transaction; worker tasks inherit it | IMPLEMENTED |
| Webhooks | delivery filtered `ev.tenantId === s.orgRef`; but every active subscription's secret is decrypted before the filter when no `orgRef` argument (`webhookDispatchService.ts:29-40`); tenant test and fix exist only on another branch | PARTIAL |
| Notifications | in-app only, tenant from outbox | IMPLEMENTED |
| Caches | none server-side; client caches are per-browser | n/a |
| Offline sync | device bound to acting org; package item ids unscoped | PARTIAL |
| Portals | identity bound to one account; scope from binding never request | IMPLEMENTED |
| Backups | no backup exists in the repository to scope | UNKNOWN |
| Ended membership | grants survive; user falls to `default` tenant with full role reach over unowned rows | PARTIAL (documented, `PORTAL_ORG_SCOPE_DEFERRED.md` §8) |

**Unknown tenancy today does not fail closed.** `single_tenant_fallback` is, by design, the answer for a deployment
that predates organizations; it is also the answer for a user whose memberships all ended. Tests
(`actingScopeMembership*.test.ts`) pin the current behaviour so that its change is visible.

Isolation tests on main: `tenantIsolation.test.ts` (16), twelve `tenantScope*.db.test.ts` suites, `actingScope*`
(9 + 13 + 11), `inboxIsolation`, `roleIsolation`, `scopeGuard.db`.

---

## 6. Sensitive-data inventory

Legend for the policy columns: **R** read gate, **Enc** encryption beyond disk, **Exp** export policy, **Prt** print
policy, **Off** offline policy, **AI** AI eligibility, **Ret** retention, **Aud** audit coverage.

| Category | Where stored | Classification (as the code treats it) | Custodian | R | Enc | Exp | Prt | Off | AI | Ret | Aud |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Employee / operator identity, licence, emergency contact | `users` (openId, email); `operators.licenseNumber/licenseClass/restrictions/emergencyContact` (`schema.ts:120-135`) | operational | company | `personnel.read` (5 roles) returns full rows (`db.ts:1020-1028`) | none | none | none | none | not sent to any model | policy-only (`retentionPolicy.ts`) | gate decisions only |
| Medical fitness | `complianceDocuments` `docType=medical_fitness` + `privateDetail` + file pointer (`schema.ts:180-210`); `applicantScreenings.kind=medical_fitness` (`:5677-5688`) | intended RESTRICTED (`privateDetail`), **not enforced on `documents.list`** | company (spec says driver) | dispatch projection yes/no/unknown (`compliancePassport.ts:273-279`); metadata to 9 roles via `documents.list` | none | withheld from driver audit packages (`auditPackage.ts:22,57`) | none | none | not sent | policy-only | gate decisions only |
| Emergency medical profile | not modelled (spec only) | — | — | — | — | — | — | — | — | — | — |
| Payroll, pay rates, tax | `employeePayrollProfiles`, `payRates`, `payrollEarningEvents`… (`schema.ts:3268-3430`) | sensitive permissions (`payroll.*` all sensitive) | company | `payroll.*` roles; `bank.read`/`tax_identifier.read` unheld | none | `payroll.export` returns `{exported:true}` only | none | none | not sent | policy-only | gate decisions, fail-closed |
| Banking | `bankAccounts.institution/lastFour` (`:4674-4684`); `vendors.accountNumberRef` (`:826`) | sensitive | company | `banking.*` | none (only last four stored) | none | none | none | not sent | policy-only | gate decisions |
| Government identifiers (SIN, business number) | **no column found** | — | — | — | — | — | — | — | — | — | — |
| Signatures | `signatureAudits` (`:363-374`); `fieldTicketSignatures` incl. signer phone, image key, lat/long, device signature (`:1226-1270`) | operational | company | closeout roles | none | rendered into PDFs | no log | none | not sent | policy-only | insert-only by convention |
| Legal holds, investigations | `legalHolds` (no org column); `incidentMatters` tiered INTERNAL/CONFIDENTIAL/RESTRICTED (`_core/restrictedVault.ts:23-48`) | RESTRICTED for internal investigations | management | `restricted.read` (management only, sensitive) | none | `EXPORT`/`PRINT` actions loggable in `restrictedAccessEvents` | same | none | not sent | policy-only | **logged before content** (`restrictedVaultRouter.ts:255-313`) |
| WCB / workers' compensation, insurance | `subcontractors` WCB fields; insurance tables (`insurance.*` permissions) | sensitive for claims | company | `insurance.*` | none | none | none | none | not sent | policy-only | gate decisions |
| Security and privacy incidents | `securityIncidents*`, `privacyBreachAssessments`, `incidentNotificationObligations` (`0131`) | reviewed by `incident.review` | safety/management | `incident.read_investigation` | none | none | none | none | not sent | policy-only | timeline append-only by convention |
| Customer confidential (rate cards, contracts, quotes) | commercial tables with `bookOrgRef` | `commercial.*`; `margin.view` sensitive | company | commercial roles | none | portal download hashed and logged | none | none | not sent | policy-only | `externalAccessLog` for portal |
| GPS / location history | lat/long in 32 tables (`tripBreadcrumbs`, `drivingEvents`, `evidenceRecords`, `dutyRecords`…) | operational; collection notice in `monitoringNotices` (`:8800-8820`) | company | domain read permissions | none | none | none | cached only in demo snapshot | not sent | policy-only | gate decisions |
| HOS / logbooks | `dutyRecords`, `dailyLogs` | operational | company | `hos.*` | none | none | none | none | not sent | policy-only | gate decisions |
| Communications | `commsRouter` channels; message board with attachment gating | operational | company | `comms.*` | none | none | none | comm package unscoped | not sent | policy-only | gate decisions |
| Video | `drivingEvents.videoStorageKey` hashed pointer | sensitive (`safety.video.read`) | company | purpose required; `videoAccessLog` before URL (`telematicsRouter.ts:76-84`) | none | signed URL, lifetime UNKNOWN (Forge) | none | none | not sent | policy-only | logged |
| Biometrics | **none stored**; name-pattern guard `BIOMETRIC_MATERIAL_PATTERNS` (`_core/deviceSignature.ts:171-193`) + tests | — | — | — | — | — | — | — | — | — | — |
| Portal TOTP secrets, webhook secrets | `externalIdentities.mfaSecretEnc`, `webhookSubscriptions.secretEnc` | secret | server | never returned | AES-256-GCM, **one shared key, no key id** | — | — | — | — | — | — |
| API credentials, tokens | portal/integration token hashes (unsalted SHA-256) | secret | server | never returned | hash | — | — | — | — | — | — |
| Session tokens | browser cookie + sessionStorage mirror | secret | user agent | — | HS256 signature | — | — | — | — | 1 year | none |
| AI transcripts | `assistantProposals.transcript` (`schema.ts:2182-2233`) | operational | company | `assistant.*` | none | — | — | — | **is the model input** | policy-only | proposal rows |

**No field-level encryption of any personal data exists** (searched `createCipheriv|bcrypt|argon|scrypt|pbkdf2|subtle.encrypt`
outside the two secret columns). No column-level data classification exists; the closest equivalents are
`privateDetail` (boolean on compliance documents), `sensitivityTier` (vault matters), `NEVER_ATTACHABLE`
(attachments) and the `SENSITIVE_PERMISSIONS` set (actions, not data).

---

## 7. Encryption inventory

| Layer | State | Evidence | Status |
|---|---|---|---|
| TLS in transit (browser → app) | not enforced by the app; `secure` cookie flag follows `x-forwarded-proto`; no HSTS, no redirect | `_core/cookies.ts:11-22`; `index.ts` | UNKNOWN (platform) |
| TLS app → database | no `ssl` option anywhere; depends entirely on `DATABASE_URL` parameters, none documented | `db.ts:88-96`; `productionWorker.ts:13`; `scripts/migrate.ts:15` | UNKNOWN |
| TLS app → Forge / OAuth | HTTPS URLs from environment; hard-coded https fallback for LLM | `llm.ts:220-223` | IMPLEMENTED (by URL) |
| Database encryption at rest | not visible from the repository | — | UNKNOWN |
| Object storage at rest | Forge/S3; not visible | — | UNKNOWN |
| Application-level secret encryption | AES-256-GCM, 12-byte random IV, no AAD, raw 32-byte key from env, **no key id/version, no rotation path**, one key for two secret classes | `externalIdentityPolicy.ts:63-66`; `integrationRouter.ts:132-136` | PARTIAL |
| Application-level PII encryption | none | §6 | MISSING |
| Envelope encryption (DEK/KEK) | designed for the device vault only: per-file AES-256-GCM key wrapped by the device key (`client/src/runtime/crypto.ts:36-47`); memory-only implementation | | STUB on device; MISSING on server |
| KMS / HSM | none | — | MISSING |
| Session signing | HS256 single shared secret ≥32 bytes enforced at boot | `env.ts:55-91` | IMPLEMENTED |
| Device signatures | ECDSA P-256 / SHA-256, P1363; canonical-form reconstruction (client never sends exact wire bytes) | `deviceRouter.ts:222-240`; `syncEngine.ts:181-185` | IMPLEMENTED |
| Webhook signatures | HMAC-SHA256 over `timestamp.body`, constant-time verify with 300 s window (verify used only in tests) | `_core/integrationGateway.ts:16-24` | IMPLEMENTED (outbound) |
| Content integrity | SHA-256 manifests: evidence seals, audit packages, commit receipts, migration ledger; academy audit hash chain (previous hash read without lock) | `evidenceSeal.ts`; `auditPackage.ts`; `assistantCommitService.ts:323-336`; `migrationLedger.ts:26-31`; `trainingAcademyRouter.ts:83-89` | IMPLEMENTED |
| Backups encrypted | no backup mechanism in repo | — | MISSING |
| Custom cryptography | none found; primitives are Node `crypto`, WebCrypto, `jose` | | — |

Documentation mismatches: the post-recovery checkpoint says the browser device key is "non-exported"; it is created
`extractable: true` (`adapters/memory.ts:33`). It says both sync hashes are server-recomputed; only the content hash
is (`deviceRouter.ts:290-295` echoes the declared manifest hash).

---

## 8. Secrets inventory

Values are never reproduced. Location class: ENV = runtime environment variable; CLIENT = shipped in the browser
bundle; DB-ENC = encrypted column; DB-HASH = hashed column; NONE = not present.

| Secret | Purpose | Location class | Required at boot | Rotation status | Client exposure risk |
|---|---|---|---|---|---|
| `JWT_SECRET` | session signing | ENV | yes, ≥32 bytes (`env.ts:64-77`) | UNKNOWN; single key, no ring, rotation invalidates every session | none |
| `DATABASE_URL` (with password) | app, worker, migrations | ENV | not asserted; worker silently skips if unset (`productionWorker.ts:12`) | UNKNOWN; production account privileges UNKNOWN; CI uses passwordless root | none; password appears on the `mysql` CLI line in `scripts/apply-migrations.sh:16` |
| `BUILT_IN_FORGE_API_KEY` | LLM, **object storage**, maps, notifications, voice, images, data API — one key for all | ENV | not asserted (lazy per consumer) | UNKNOWN | none directly |
| `VITE_FRONTEND_FORGE_API_KEY` | Maps proxy | **CLIENT** (`client/src/components/Map.tsx:13, 25`, in a script URL) | no | UNKNOWN | **by design shipped**; whether it equals the backend key or has AI/storage scope is UNKNOWN |
| `LEASEOS_PORTAL_MFA_KEY` | AES key for TOTP secrets and webhook secrets | ENV | no (fail closed at use) | MISSING path (no key id) | none |
| `OWNER_OPEN_ID` | grants platform admin | ENV | no | n/a | none |
| `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`, `VITE_APP_ID` | identifiers | ENV / CLIENT | `VITE_APP_ID` yes | n/a | identifiers, not secrets |
| Portal bearer / invitation tokens | external identities | DB-HASH (unsalted SHA-256) | — | 90 d / rotation procedure | shown once; client keeps in memory only |
| Integration client keys | machine auth | DB-HASH | — | none (revoke + re-register) | shown once |
| Webhook signing secrets | outbound HMAC | DB-ENC (shared key) | — | none | none |
| Device private keys | package signing | on device only; browser fallback in memory, extractable | — | 30 d client rotation | never leaves device |
| Alberta 511, mapping, email, push, payment credentials | not present; feed credentials would come from `credentialEnvVar` names (`feedHttp.ts:72`, redacted in records) | NONE | — | — | — |
| Committed secrets | none: no `.env*`, `.pem`, `.key` tracked; `audit/SECRET_SCAN.md` 0 high-confidence; fresh pattern scan 0 hits outside synthetic fixtures | NONE | — | — | — |
| Secret manager integration | none | MISSING | — | — | — |
| `.env.example`, Dockerfile, compose, deployment manifest | none | MISSING | — | — | — |

`vite.config.ts:164` sets `envDir` to the repository root, so the server `.env` and the client build read the same
file; only `VITE_`-prefixed values reach the bundle. `main.tsx:88` passes the whole `import.meta.env` to analytics.

---

## 9. Restricted Records Vault assessment

| Invariant asked | Enforced? | Evidence | Status |
|---|---|---|---|
| Admin role alone is not access | yes: `users.role='admin'` reaches only three bootstrap/notify procedures; vault needs `restricted.read`, held by `management` only | `recordsAuthorization.ts:983-984, 2532-2540` | IMPLEMENTED |
| Record-specific grants | `restrictedAccessGrants` bound to user + recordType + recordId | `_core/restrictedVault.ts:98-136` | IMPLEMENTED |
| Purpose-bound | purpose ≥20 chars, not a bare category word, stored on grant and every event | `restrictedVault.ts:139-151` | IMPLEMENTED |
| Expiration | 5–480 min, default 60 | `restrictedVaultRouter.ts:226-233` | IMPLEMENTED |
| Revocation | `grantRevoke`, scoped | `restrictedVaultRouter.ts` | IMPLEMENTED |
| Logging before content | `serveRestricted` writes the event first; denials logged; untiered reads now logged `NOT_RESTRICTED_SERVED` | `restrictedVaultRouter.ts:255-313`; `audit/security-2026-09-21/FINDINGS.md` §5 | IMPLEMENTED |
| Sensitivity tiers | INTERNAL / CONFIDENTIAL / RESTRICTED / HIGHLY_RESTRICTED; only `INTERNAL_INVESTIGATION` maps to RESTRICTED; **nothing maps to HIGHLY_RESTRICTED** | `restrictedVault.ts:23-48` | PARTIAL |
| Structured denial | `evaluateRestrictedAccess` returns a decision code; refusals are `DENIED` events | `restrictedVault.ts:98-136` | IMPLEMENTED |
| Fail closed | `restricted.read` is sensitive: an audit-write failure refuses the action | `recordsAuthorization.ts` §4 fix; `_core/vaultFailClosed.test.ts` | IMPLEMENTED |
| Org scoping of vault rows | `scopeWhere` on all list and by-id paths since the 2026-09-21 fix | `FINDINGS.md` §3 | IMPLEMENTED |
| Break-glass is self-service | **yes**: the same `restricted.read` holder mints their own grant for any `recordType`/`recordId`, with no existence or org check of the target, no second person, no step-up; the control is the purpose text and the log | `restrictedVaultRouter.ts:226-252` | PARTIAL — a strong audit control, not an access control |
| Break glass ≠ permanent | grants expire; nothing converts them | | IMPLEMENTED |
| Incident lookups feeding the vault | `incidentReports` by id, unscoped (table has no `orgRef`) | `restrictedVaultRouter.ts:57, 154` | MISSING |
| Audit immutability | `restrictedAccessEvents` has no trigger, no GRANT model, no hash chain; append-only by convention | `schema.ts:8785-8798`; no `CREATE TRIGGER` on it | PARTIAL |

Verdict: the vault's model is sound and worth preserving as the single restricted-record authorization system. The
design in the companion spec extends it (classification, HIGHLY_RESTRICTED mapping, step-up for break glass, target
validation) rather than replacing it.

---

## 10. Medical / private-vault assessment

The specification `docs/knowledge/source/LEASEOS_DRIVER_MEDICAL_QUALIFICATION_VAULT.md` (v1.0, "owner decisions
captured 2026-09-17", though §16 still lists eight decisions as open) defines three layers with the driver as
custodian of medical content and no company read "not even by break-glass".

| Spec element | On main | Evidence | Status |
|---|---|---|---|
| Layer 1 — licence and qualification facts | `operators.licenseClass/restrictions`; `complianceDocuments` validity | `schema.ts:120-135, 180-210` | PARTIAL |
| Layer 2 — human-authored fitness determination `FIT / FIT_WITH_LIMITATIONS / ASSESSMENT_REQUIRED / TEMP_UNFIT / MEDICAL_REVIEW / UNKNOWN` (`NOT_FIT` is not in the spec) with functional restrictions | 0 hits; code has only `eligible: yes | no | unknown` (`compliancePassport.ts:273-279`) | | MISSING |
| Layer 3 — driver-custodied documents, Mode A / Mode B disclosures, `driverVaultDocuments`, `driverDisclosures`, `taskClearances`, `operatorLicenceConditions` | no tables (`ROADMAP_2026-09-21.md:102` "No medical table") | | DOCUMENTED ONLY |
| Dispatch receives status and restrictions only, never the reason | `medicalFitnessForDispatch` flattens to yes/no/unknown + `reviewDue`; passport withholds rejection reasons for private credentials (`evidence_withheld`) | `compliancePassport.ts:170-209, 273-279` | IMPLEMENTED (narrow) |
| Company admin cannot reach medical source material | **metadata leaks**: `documents.list` returns full rows including `title`, `identifier`, `storageKey`, `storageUrl`, `source` of `medical_fitness` documents to holders of `compliance.read` (9 roles) with no `privateDetail` filter; `documents.create` cannot set `privateDetail`, so documents created through it are not private. File bytes cannot be fetched (no signed-URL procedure for compliance documents) | `routers.ts:1521-1543`; `db.ts:717-726`; `compliancePassport.ts:282` | PARTIAL — the projection rule exists in one module and is bypassed in another |
| Subject scoping | `subjectId`/`operatorId` unscoped on passport, jobPassport, medicalEligibility; `credentialVerify` updates any id | `complianceRouter.ts:50-58, 94-104, 129-138` | MISSING (recorded unfixed in `FINDINGS.md:108-111`) |
| `compliance.private.read` | declared, sensitive, held by hr, **mapped to no procedure** | `recordsAuthorization.ts:1253, 1860` | STUB |
| AI never derives fitness | no AI path reads compliance documents (§12) | | IMPLEMENTED by absence, not by control |
| Emergency medical profile | free-text `operators.emergencyContact` returned under `personnel.read` | `db.ts:1020-1028` | MISSING (as a protected profile) |
| Driver wallet / portfolio | `shared/driverWallet.ts` not on main (branch only) | | MISSING |

Verdict: the separation the work order requires (qualification facts / functional restrictions / medical source
material) exists as a specification and as one narrow projection function. It is not an enforced boundary today.

---

## 11. Offline / mobile assessment

| Capability | Status | Evidence |
|---|---|---|
| Native shell (Capacitor, Android, iOS project) | MISSING — no `@capacitor/*` dependency, no `android/`, `ios/`, manifest or plist | `package.json`; `pnpm-lock.yaml` 0 hits |
| Encrypted SQLite | STUB — `capacitorStore().open` throws unconditionally | `client/src/runtime/adapters/capacitor.ts:35` |
| Hardware keystore / Keychain / Secure Enclave | STUB — always throws | `capacitor.ts:42` |
| Native encrypted file vault | STUB — always throws | `capacitor.ts:49` |
| Biometric signing, camera, GPS, notifications | MISSING — named in `NATIVE_ONLY_CAPABILITIES`, no binding | `capacitor.ts:53` |
| Browser fallback runtime | IMPLEMENTED in code, **never mounted** (`mountBrowserFallbackRuntime` has no caller); memory-only; header says "Nothing here is at-rest protection" | `runtimeBootstrap.ts:20`; `adapters/memory.ts:4-7` |
| Envelope crypto (per-file AES-GCM wrapped by device key) | IMPLEMENTED in library, tested only in Node | `runtime/crypto.ts:36-47` |
| Non-extractable device key | MISSING — browser key `extractable: true` | `memory.ts:33` |
| Hardware attestation | MISSING — `keystoreAttestation` is self-declared; only `"failed"` refused | `deviceRouter.ts:43, 52-54` |
| Device registration bound to user + org, key history, 72 h grace, compromised-key refusal, nonce ledger | IMPLEMENTED | `deviceRouter.ts`; `_core/fieldDevice.ts`; `0110` |
| Device revocation | PARTIAL — refuses future sync and signatures; does not end the session, does not invalidate received packages; `suspended` status has no setter; office approval of enrolment absent | `deviceRouter.ts:109-128`; `fieldDevice.ts:77-79` |
| Offline authorization (capture-time claim, scoped capability) | PARTIAL — `captureAuthorizationClaim` is the device's own claim, stored as given (`0079`; `deviceRouter.ts:303`); no signed, scoped, expiring offline capability; `offlineCapability` and `preDepartureCache` engines declared unwired | `engineReachability.test.ts:51, 61` |
| Sync authority re-check | PARTIAL — re-checked on `evidence.upload` and `evidence.seal`, not in `receivePackage`; item ids unscoped | `deviceRouter.ts:274-305`; `recordsRouter.ts:95-124` |
| Conflict detection | STUB — test-seeded in-memory map | `deviceRouter.ts:441-447` |
| Cached credentials on device | session token in `sessionStorage`; user row in `localStorage` | `main.tsx:53-62`; `useAuth.ts:53-57` |
| Cached job data | none (no IndexedDB / service worker); demo snapshot in `localStorage` | `showcase/Home.tsx:846-859` |
| Offline communication package | contents are radio/coverage data with record references; no tenant column; no expiry or policy version; client and server contract mismatch; not encrypted at rest | `commsRouter.ts:747-805`; `0076:14-46`; `commsVault.ts:27-38` |
| App backups, clipboard, screenshot/app-switcher protection, certificate pinning | MISSING (no native project) | — |
| Third-party screenshot library in every build | `modern-screenshot` via `vite-plugin-manus-runtime`, enabled in all modes; runtime behaviour UNKNOWN | `vite.config.ts:153`; lockfile |

Verdict: **current offline storage is not production-safe** for anything beyond what a browser tab already holds,
because the on-device protection layer is interface-only.

---

## 12. AI-security assessment

Exactly one path sends anything to a language model.

| Path | Caller gate | Tenant | Permission | Data sent to model | Reads DB | Can modify | Human confirmation | Output validated | Status |
|---|---|---|---|---|---|---|---|---|---|
| `fieldRoute.assistant.draft` → `invokeLLM` (`server/_core/llm.ts`) | `roleProcedure` (`routers.ts:670`) | **none** on input ids | `assistant.use` (6 roles) | system prompt (form title, slot list, client `targetRef` unescaped) + raw transcript ≤8000 chars; **no DB rows, no documents** | proposal tables only | inserts proposal rows | n/a | provider JSON schema; local parse casts without runtime type check (`assistantExtraction.ts:177-199`) | IMPLEMENTED (no client UI calls it) |
| `assistant.answer/readBack/setStatus/acknowledge/reject` | `roleProcedure` | `proposalInScope` (job-first) | `assistant.use` / `assistant.review` | none | proposal rows | proposal rows | this is the confirmation | — | IMPLEMENTED |
| `assistant.commit` | `roleProcedure`, sensitive | `proposalInScope` only; **no tenant check on target rows** | `assistant.commit` + target permission re-authorized inside the transaction (`assistantCommitService.ts:190-208`) | none | targets | **yes**: `tripStops`, `maintenanceDefects`, `expenseRecords`, `fuelTransactions`, `disposalTickets` | required: acknowledged read-back, no gaps (`aiProposal.ts:621-648`); edit clears acknowledgement; drafter may be acknowledger (no SoD) | typed adapters re-validate; SHA-256 receipt | IMPLEMENTED; target scoping PARTIAL |
| `assistantAsk.ask` (no model) | `roleProcedure` | SQL filter + `contextAdmission.admitSource` | `assistant.ask` | — | `knowledgePassages` | writes `assistantQueries` | n/a | lexical grounding | IMPLEMENTED |
| `agent.*` | `roleProcedure` | `tenantId` on runs | `agent.*` | — | agent tables | decision rows only; "Deliberately absent: any capability that executes" (`agentRouter.ts:16-19`) | `decideApproval` | zod | PARTIAL (no executor) |
| `contextAssembly` data-labelling ("The following is DATA") | — | refuses mixed-tenant context | — | — | — | — | — | — | DOCUMENTED ONLY — no production caller |
| `voiceTranscription` (fetches any `audioUrl` — SSRF if wired), `imageGeneration`, `modelGateway` | none | — | — | — | — | — | — | — | STUB / unwired (`engineReachability.test.ts:62, 81, 89`) |
| OCR (`documentExtraction`) | none | — | — | — | — | — | designed | — | STUB (no engine, no caller) |
| RAG / embeddings / vector store | none, by design ("No embedding column", `0101:14-15`) | — | — | — | — | — | — | — | MISSING (intentional) |

Findings:
- **Tool calling / function execution: MISSING.** No model output is executed. `invokeLLM` supports `tools` but the one
  caller passes none.
- **AI can reach restricted data: NO.** No AI module reads `restrictedVault`, compliance documents, payroll or
  security incidents; the only model input is user-typed transcript. This is true by absence, not by a policy
  gate; nothing prevents the next caller from passing records.
- **Prompt injection posture:** untrusted document/OCR/email content reaches no prompt today. The transcript is
  unfenced and a client string is interpolated into the system role (`assistantExtraction.ts:118`). Pattern-flag
  tests exist (`contextAssembly.test.ts:96-118`); no test mocks `invokeLLM` or exercises `assistant.draft`.
- **Model credential:** `BUILT_IN_FORGE_API_KEY`, the same key as object storage; no timeout or abort on the call;
  hard-coded vendor fallback host; provider error bodies included in thrown errors (`llm.ts:220-223, 416-420`).
- **Audit:** proposals, fields, receipts and queries are recorded; **model name, tokens, raw request/response and
  latency are not** (`routers.ts:702` discards `result.model`/`usage`).
- **Documentation drift:** `LEASEOS_ASSISTANT_ENGINE.md:88-92` says `llm.ts` is not wired (it is);
  `docs/register/AI_RUNTIME_TERMINOLOGY.md` describes `server/_core/ai/` and `LLM_API_KEY`, neither on main.

---

## 13. Logging / audit assessment

| Event class | Recorded | Where | Status |
|---|---|---|---|
| Authorization decision (every gate, allowed and denied) | yes | `authorizationDecisions` (no org column; no reader for alerting) | IMPLEMENTED |
| Login success / failure | no (only `lastSignedIn` upsert) | — | MISSING |
| MFA enrol / remove, passkey, recovery | portal MFA enrol/confirm pass through the audited gate; no dedicated event; no passkeys | | PARTIAL |
| Device registration / revocation | key events table | `deviceRouter.ts:69, 103-104, 120-123` | IMPLEMENTED |
| Session creation / revocation | no | — | MISSING |
| Role changes | grant row + gate decision + `roleBootstrapEvents`; no revoke event beyond `revokedAt` | | PARTIAL |
| Restricted reads / exports / prints / break glass | `restrictedAccessEvents` before content | | IMPLEMENTED |
| Video, audit package, portal document access | `videoAccessLog`, `auditPackageAccess`, `externalAccessLog` | | IMPLEMENTED |
| Printing in general | no print channel exists; PDF renders are not access-logged | | MISSING |
| AI proposals / commits | proposal rows, receipts | | IMPLEMENTED (model metadata MISSING) |
| Mass export | no export produces bytes except PDFs and CSV of public facility data | | n/a |
| Secrets / key administration | none | — | MISSING |
| Tenant-boundary denial | appears as a gate `denied_scope` row or as NOT_FOUND from `*InScope` helpers (the latter unrecorded) | | PARTIAL |
| Security configuration changes | none | — | MISSING |
| Session/device identity in audit rows | no session id exists; device only on sync rows | | MISSING |
| Immutability | no trigger, no GRANT model on any audit table; app code updates none of them; CI runs as root | `drizzle/*.sql` triggers only on manifests/academy | PARTIAL (convention) |
| What must never be logged | no token, password or key logging found; whole-error logs at `oauth.ts:75`, `db.ts:138` (user upsert incl. name/email), `sdk.ts:325`, `notification.ts:99-109`; drizzle error text may include bound values — unverified | | PARTIAL |
| Request logging / observability / error reporting | none (`morgan`, `pino`, Sentry, OTel absent) | | MISSING |
| Health endpoint | public tRPC `system.health` always `{ok:true}`; no DB or worker check | `_core/systemRouter.ts:6-14` | STUB |
| Detection (brute force, MFA failures, mass export, repeated denials) | none reads the decision trail | | MISSING |

---

## 14. Incident-response assessment

`server/securityIncidentsRouter.ts` over migration `0131` is the existing workflow and should be **extended, not
replaced**.

| Requirement | On main | Status |
|---|---|---|
| Lifecycle | statuses `open, triaging, contained, investigating, recovering, monitoring, closed`; `investigating` reachable only via `reopened`; `monitoring` **unreachable** (no setter); no transition order enforced | PARTIAL |
| Who may change state | `timelineAppend` needs only `incident.create`, which **drivers hold** → a driver can mark contained/recovering and reopen a closed incident in their org; the DB test covers only `breachAssess` | PARTIAL (permission defect) |
| Tenant scoping | `ownedIncident` and `list` scoped; **exception-centre loader unscoped** (`surfacesService.ts:307-318`) leaks open incident titles across tenants; `organizationAffect` accepts any `orgRef` | PARTIAL |
| Evidence integrity / chain of custody | `evidenceRecordId` is a bare pointer: no existence, org or hash check; no use of `sealState`/`legalHold` | MISSING |
| Timestamps | `occurredAt`, `discoveredAt`, `sentAt`, `closedAt` caller-supplied; only `createdAt` server-set | PARTIAL |
| Accountable responders | every write records `ctx.user.id`; `incidentOwnerUserId` column is never written | PARTIAL |
| Actions taken | timeline events, insert-only by convention; sequence = max+1 outside a transaction (unique key rejects races) | IMPLEMENTED |
| Privacy assessment | `privacyBreachAssessments` with `notificationDecision pending/not_required/required/uncertain`, recorded only by an `incident.review` human; **no code derives it** (statutory decision stays human) | IMPLEMENTED |
| Statutory clocks | `dueAt` person-set; not encoded | MISSING |
| Close gate | blocked while a required notification is unsent or a PI assessment is missing/uncertain | IMPLEMENTED |
| Recovery verification | no field or state | MISSING |
| Automatic feeds (repeated denials → incident) | none | MISSING |
| Fail-closed writes | no `incident.*` permission is in `SENSITIVE_PERMISSIONS` | MISSING |
| Relation to vault investigations | separate objects over `incidentReports` (operational incidents); `incidentReports` lookups unscoped | PARTIAL |
| AI role | none; consistent with "AI must not decide notification obligations" | IMPLEMENTED by absence |

---

## 15. CI / security-gate assessment

Package manager pnpm (sha512-pinned), Vite + esbuild build, GitHub Actions on push and PR, MariaDB 10.11 service,
MIT licence (`LICENSE`). Deployment architecture: **not represented in the repository**
(no Dockerfile, compose, manifest, or runbook).

| Gate | Enforces | Security value | Status |
|---|---|---|---|
| 0 | reserved migration slots 0016/0017 | — | IMPLEMENTED |
| 1–3 | clean DB, migrations apply, table parity | schema integrity | IMPLEMENTED |
| 4 | `tsc`; test-file type-error ratchet pinned at 0 | typed security decisions | IMPLEMENTED |
| 5 | 0 bare `protectedProcedure` (glob misses `server/_core/systemRouter.ts`) | every mounted procedure is permission-mapped | IMPLEMENTED (vitest pin covers the gap) |
| 6 | full vitest; a skipped `.db.test.ts` fails the gate | the isolation suites actually run | IMPLEMENTED |
| 7 | production build | — | IMPLEMENTED |
| 7b / 7c | portal mounts only `externalProcedure`; inbound only `integrationProcedure` (counts printed, pinned in vitest) | gate-kind invariants | IMPLEMENTED |
| 8 | `LEASEOS_CURRENT_STATE.md` regenerated, not claimed | numbers are measurements | IMPLEMENTED |
| Structural tests | `procedureAuthorization`, `authArchitecture`, `tenantIsolation`, `engineReachability` (57 unwired pinned), `branchGrantLaundering`, `vaultFailClosed`, `storageCapability`, `degradationSuite`, biometric guard | invariants as tests | IMPLEMENTED |
| SAST | none | | MISSING |
| Dependency scanning | none in CI; one-off audit: critical 2 (`tar` reachable at runtime through the `vite` import in `dist/index.js`; `vitest` dev-only), high 39 | | MISSING |
| Lockfile check | `--frozen-lockfile` | | IMPLEMENTED |
| Secret scanning | none in CI; pattern scan document only | | MISSING |
| SBOM, provenance, artifact signing | none | | MISSING |
| Actions pinning | by tag (`@v4`), not SHA | | PARTIAL |
| Duplicate migration prefix check | none (two `0157`) | | MISSING |
| Tenant-isolation tests | 12 db suites + unit pins | | IMPLEMENTED (coverage partial) |
| Authorization / auth-bypass / IDOR tests | per-router `*InScope` tests exist for many routers; none for the §4.4 list | | PARTIAL |
| Upload tests | key shape, capability removal | | PARTIAL |
| Prompt-injection, RAG isolation, cross-tenant AI tests | pattern flags only; `assistantAsk` admission tests | | PARTIAL |
| Security headers / rate limiting / CORS | absent from the app | | MISSING |
| Runtime dependency surface | production bundle imports five devDependencies through `server/_core/vite.ts` (`REMEDIATION.md` DEP-3) | | PARTIAL |

---

## 16. Current strengths (preserve)

1. **One gate builder per caller kind, every mounted procedure permission-mapped at wiring time, pinned by test and CI.**
   `roleProcedure` refuses to build for an unmapped name; `procedureAuthorization.test.ts` pins 634 + 18 + 36 + 2.
2. **Every authorization decision is an audit row, denials included, with fail-closed refusal when a sensitive
   action's row cannot be written** — across human, portal and machine gates.
3. **Explicit deny-beats-grant permission model with no inheritance**, unheld-by-design permissions for bank and
   tax identifiers, and a branch-scope rule that fails closed.
4. **Restricted Records Vault**: record-bound, purpose-bound, expiring grants; log-before-content; org-scoped;
   fail-closed.
5. **Portal and machine identities never say whose data they want**; scope comes from the binding. Tokens and keys are
   stored hashed and shown once; portal TOTP secrets are encrypted.
6. **Device sync is cryptographically bound**: P-256 keys, org and user binding, canonical signing, nonce replay
   ledger, retired-key grace, compromised-key refusal, no grandfathering of fingerprint-only devices.
7. **AI is proposal-only**: no tool execution, no DB rows in prompts, typed adapters, human read-back before commit,
   commit re-authorized inside the transaction with a hashed receipt.
8. **Knowledge retrieval is admitted per source with a tenant check**, and there is no vector store to leak through.
9. **Boot refuses a production server without a ≥32-byte session secret and an app id.**
10. **Structural tests turn conventions into failures**: no bare procedures, no password columns, unwired-engine
    census, storage-capability removal, biometric-material guard, current-state regeneration.
11. **OAuth login CSRF** is closed with a `__Host-` nonce cookie.
12. **Migration ledger with checksums and drift refusal.**

---

## 17. Confirmed vulnerabilities and gaps

Severity reflects reachability on main today. "Confirmed" means the code was read at the cited lines; none was
executed.

| # | Finding | Severity | Evidence |
|---|---|---|---|
| V1 | Staff session is a one-year bearer JWT with no server-side revocation; logout, offboarding and device revocation leave it valid; the token is also accepted as a Bearer header and mirrored into `sessionStorage`, defeating `httpOnly` against any script on the page | **High** | §3 |
| V2 | Cross-tenant write path through the assistant: client-supplied `tripId/jobId/unitId/targetRecordId` stored unscoped; `proposalInScope` checks only the first present id; commit adapters check no tenant on target rows | **High** (needs `assistant.use` + `assistant.commit` in the attacker's own org) | §4.4 |
| V3 | Compliance router unscoped: any operator's medical eligibility, passport and credential verification by id | **High** (medical judgement about a named person; `compliance.passport.read` held by 10 roles) | `complianceRouter.ts:50-138` |
| V4 | `documents.list` returns medical documents' title, identifier and storage key to 9 roles, bypassing `PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED` | **High** | `routers.ts:1521`; `db.ts:717-726` |
| V5 | Ended membership without grant revocation leaves a user with full role reach under `single_tenant_fallback` (documented, tested as current behaviour) | High in migrated deployments | `PORTAL_ORG_SCOPE_DEFERRED.md` §8 |
| V6 | Approver standing reads all role rows ignoring `revokedAt` and scope (cash, purchasing approvals) | Medium-High | `commercialApprovalService.ts:30`; `commercialOfficeRouter.ts:207` |
| V7 | No CORS, no security headers, no rate limiting, no CSRF token with `SameSite=None`; 50 MB body limit; JSON-only tRPC plus the absence of CORS is the only CSRF barrier | Medium | §3, §15 |
| V8 | Audit packages, invoicing render/send, `closeout.documentRender`, `surfaces.search`, chain hops, exception loaders, comm packages, portal-admin invite/revoke, `deliveryUpdate`, `device.verifySeal`, `sync.resolveConflict` — unscoped by tenant | Medium (each) | §4.4 |
| V9 | Security-incident state changeable under `incident.create` (drivers); open incidents leak across tenants via the exception centre; `incident.*` not fail-closed | Medium | §14 |
| V10 | Break-glass is self-minted with no target validation, no second person, no step-up | Medium | §9 |
| V11 | Global `clientCaptureRef` duplicate lookup returns another user's evidence id and storage key | Medium | `db.ts:202-207`; `routers.ts:427-430` |
| V12 | Client-supplied storage keys validated for shape only; uploads trust client MIME; no content sniffing or malware scanning | Medium | §6, `_core/storageKey.ts` |
| V13 | One AES key for two secret classes with no key id and no rotation path; `JWT_SECRET` single key; storage credential shared with LLM/maps; a Forge credential ships in the client bundle with unknown scope | Medium | §8 |
| V14 | TOTP compared with `===` and no last-used-step (replay within window); portal lockout counts MFA failures only; integration lockout never written | Medium | §2 |
| V15 | Webhook dispatch decrypts every tenant's secret before filtering (fix exists on an unmerged branch); no re-queue; no SSRF host controls; `now` caller-supplied on office dispatch | Medium | §5 |
| V16 | Sync manifest hash echoed rather than recomputed; conflict detection stubbed; device attestation self-declared; no office approval; revoke does not end sessions | Medium | §11 |
| V17 | No dependency, secret or SAST scanning in CI; `tar` critical reachable at runtime; Express 4 advisories; actions pinned by tag | Medium | §15 |
| V18 | Audit tables mutable at the database level (no triggers, no GRANT model, CI as root); no session or device identity in audit rows; no login events; nothing reads the decision trail | Medium | §13 |
| V19 | `roles.grant` has no self-grant/ceiling check; no standalone revoke; bootstrap unscoped; finance roles ungrantable in production | Low-Medium | §4.2 |
| V20 | Health endpoint always ok; no error reporting; whole-error logging may include PII; worker skips secret assertion; `DATABASE_URL`/MFA key not asserted | Low | §13, §8 |
| V21 | AI call has no timeout, a hard-coded fallback host, no model/usage audit, client string in system prompt, unfenced transcript | Low today (single path, no records) | §12 |
| V22 | `voiceTranscription` fetches any URL (SSRF) — inert while unwired | Low (latent) | `voiceTranscription.ts:99` |
| V23 | Documentation drift: "non-exported" device key, "server-recomputed manifest hash", "4 native bindings", "`llm.ts` not wired", 36 vs 39 `orgRef` tables; and the generated permission count (355) is itself wrong — `scripts/current-state.sh` misses six camelCase permissions and counts a comment word, so gate 8 pins a mis-measurement | Low (misleads the next reader) | §1, §7, §11, §12 |

**Highest-risk weakness:** V1. A single session token — obtainable by any script on the page, any device that once
held the cookie, or any log that ever captured a Bearer header — is a year of the holder's full authority with no
way to end it. Every other control in the system assumes the session is the person.

---

## 18. Uncertain areas requiring verification

| Area | Why unknown | How to settle |
|---|---|---|
| Production TLS to the database and at-rest encryption for DB and object storage | not in repository | inspect `DATABASE_URL` parameters and hosting configuration |
| Forge presigned URL lifetime | set by Forge | measure with one presign call in a non-production environment |
| Scope of `VITE_FRONTEND_FORGE_API_KEY` (same value as backend? AI/storage access?) | shipped by design; value not visible | compare in the deployment; request a maps-only credential |
| Cron token `appId` and `name` claims | minted by the platform | one scheduled-task invocation against staging |
| Production database account privileges and auth plugin | CI uses root | `SELECT user, host, plugin FROM mysql.user` (already listed in `REMEDIATION.md`) |
| Rotation history of every deployed secret | undocumented | ask the operator; record in the runbook the design calls for |
| tRPC error formatting under `NODE_ENV=staging` (stack or provider error bodies to clients) | `node_modules` absent | run one failing procedure in a staging build |
| Whether drizzle error messages include bound parameters (affects `db.ts:138` logging) | same | reproduce a failed upsert |
| `vite-plugin-manus-runtime` / `modern-screenshot` runtime behaviour | plugin code not in repo | read the package or disable it in production builds |
| Who writes `sessionStorage["manus-cookie"]` | not in repo | confirm with the platform; decide the preview path's fate (SEC-2 open item) |
| The eight open owner decisions in the medical vault spec §16 | recorded as "captured" without content | owner |
| Cross-tenant assistant commit path | read, not executed | the first-tranche plan's RED test |

---

## 19. Threat model

Trust boundaries in the running system: browser ↔ Express (cookie/bearer); portal client ↔ `externalProcedure`
(token); machine ↔ `integrationProcedure` (key); device ↔ `sync.receivePackage` (signature); app ↔ Forge (bearer:
storage, LLM, maps); app ↔ Manus OAuth; app ↔ MariaDB (single credential); worker ↔ outbox (no identity); tenant ↔
tenant (per-handler predicates); AI model ↔ app (JSON in, JSON out, no tools).

| # | Actor | Asset | Entry point | Boundary crossed | Attack | Current control | Gap | Proposed control (spec §) | Detection | Blast radius today | Recovery today |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 | External attacker | any tenant's records | `/api/trpc` unauthenticated | browser→app | credential-less probing, CSRF, DoS via 50 MB bodies | gates deny without session; JSON-only tRPC + no CORS blocks classic CSRF | no rate limit, no headers, no body cap per route, `system.health` public | perimeter hardening, per-route limits, headers, CORS deny-list (§16) | none | availability | restart |
| T2 | Credential thief (stolen cookie / bearer) | everything the user may do | same | browser→app | replay the one-year JWT from any client | signature + appId | no revocation, no device binding, no step-up | server-side sessions, idle/absolute timeouts, step-up (§4, §5) | none (no login events) | full user authority for up to a year | rotate `JWT_SECRET` (logs everyone out) |
| T3 | Malicious or compromised employee | data within their grants; medical metadata; other tenants via §4.4 | authenticated procedures | app→tenant | use unscoped procedures; `documents.list`; assistant commit with foreign ids | per-handler scoping where present; deny lists | §4.4 list; V4; V6 | structural scope requirement, classification-driven projections (§7, §8) | gate rows exist but unread | one tenant plus the unscoped paths | manual |
| T4 | Compromised administrator (`management` or `users.role=admin`) | vault, roles, payroll, break glass | `roles.grant`, `breakGlass`, bootstrap | privilege | self-mint grants; grant global management; open any restricted record with a 20-char purpose | log-before-content; purpose; audit rows | no step-up, no two-person, no ceiling, no target validation | privileged elevation with step-up and second person for grants/break-glass (§5, §9) | `restrictedAccessEvents` (unread) | all restricted records in org; all roles | revoke grants manually |
| T5 | Lost / stolen field device | cached token, user row, captures in memory | device | device→app | reuse the session; push signed packages | key revocation refuses future sync | session survives revocation; nothing at rest encrypted on device; no attestation | device revocation ends sessions; native vault; attestation (§6, §11) | key events | that user's authority until `exp` | revoke device + rotate `JWT_SECRET` |
| T6 | Malicious portal user | their account's documents; other accounts | `externalProcedure` | portal→records | token guessing (256-bit, infeasible); TOTP replay; MFA-bypass on non-sensitive reads | hashed tokens, kind permission map, binding-derived scope | `===` compare, replay window, lockout only on MFA | timing-safe compare, last-used step, lockout on bad bearer (§4) | `authorizationDecisions` | one account | revoke identity |
| T7 | Cross-tenant attacker (member of tenant A) | tenant B rows | §4.4 procedures; storage keys; `clientCaptureRef` | tenant | supply B's ids | none on those paths | V2, V3, V8, V11, V12 | SEC-1 tranche: scope every listed path with RED tests (§7) | none | reads of B's audit packages, invoices, compliance, incidents; writes via assistant commit | manual |
| T8 | Malicious uploaded document | server, viewers, model | `evidence.upload`; portal downloads | untrusted content | polyglot/HTML/SVG with client MIME; oversized base64 | filename cleaned; size cap | MIME trusted; no sniffing; no AV; `data:` URI download in portal | sniff + allow-list + scan hook + `Content-Disposition` (§8) | none | viewer XSS via served type; storage cost | delete object (no API) |
| T9 | Prompt-injection payload | proposal correctness; future tool use | transcript; future OCR/doc paths | data→instruction | "ignore previous instructions…" in transcript or, later, in documents | no tools; human read-back; typed adapters; JSON schema | transcript unfenced; client string in system prompt; no injection tests; fencing module unwired | fence + label all untrusted content, forbid system-role interpolation, `UNTRUSTED_CONTENT_CANNOT_GRANT_AUTHORITY` tests (§13) | `overreachFlags` | one proposal (human must still acknowledge) | reject proposal |
| T10 | Compromised AI / integration provider | transcripts sent; storage (shared key) | outbound Forge calls | app→provider | exfiltrate inputs; return malicious JSON | schema-constrained parse; no records sent | one key for storage + LLM; no timeout; fallback host | separate credentials per service, timeouts, allow-listed hosts (§10, §12) | none | transcripts; storage read/write | rotate Forge key |
| T11 | Leaked API credential (integration key, Forge key, frontend key) | inbound feeds; storage | `x-integration-key`; Forge API | machine→app | ingest forged events; presign any key | hashed key; scopes; idempotency; org binding | no lockout writer; no inbound signature/timestamp; Forge key scope unknown | HMAC + timestamp on inbound, lockout, per-service keys, rotation (§10) | decision rows | one client's feeds → proposals; all storage if Forge key | revoke client; rotate Forge key |
| T12 | Supply-chain / dependency compromise | build and runtime | `pnpm install`, actions | build→prod | malicious transitive package; unpinned action | frozen lockfile; pnpm sha | no scanning, tag-pinned actions, `tar` critical at runtime, devDeps in prod bundle | scanning, SHA pins, SBOM, remove `vite` from prod import (§15) | none | whole server | rebuild from known-good lock |
| T13 | Compromised machine / device identity | sync stream; feeds | signature / key | device→app | replay (blocked by nonce), forge packages with a stolen private key | nonce ledger, ±10 min, org+user binding | attestation self-declared; manifest hash echoed; revoke doesn't end session | attestation verification, recompute manifest, revoke→session (§6) | key events | one device's captures | revoke |
| T14 | Compromised backup / storage credential | every object; every row | Forge key; DB credential | infra | read everything | none beyond the credential | no PII encryption; no backup at all; no DB TLS visible | envelope encryption for HIGHLY_RESTRICTED, per-service credentials, encrypted verified backups (§9, §17) | none | total | none (no backup) |

The cross-cutting point: today the session *is* the person, the tenant is a per-handler courtesy, and encryption
stops at the two secret columns. Those three facts are what SEC-1, SEC-2 and SEC-9 in the program address first.

---

## 20. Prioritized remediation plan

Order is by (reachability × blast radius) ÷ (owner decisions needed). Full tranche definitions live in
`docs/security/LEASEOS_SECURITY_PROGRAM.md`; only the first has an implementation plan.

| Priority | Tranche | Closes | Needs owner decision? | Migration? |
|---|---|---|---|---|
| 1 | **SEC-1 Tenant and resource authorization hardening** | V2, V3, V4, V6, V8, V9 (scope + permission), V11, V12 (ownership), V15 (port the tenant fix) | no | no |
| 2 | **SEC-2 Session lifecycle and revocation** | V1, part of V5, V18 (session id in audit) | yes: timeout values; fate of the Bearer/preview path | yes (session table) |
| 3 | **SEC-3 Perimeter and secure defaults** | V7, V14, V20, parts of V17 | small (rate limits per route) | no |
| 4 | **SEC-4 Privileged access and step-up** | V10, V19, T4 | yes: which operations require step-up / two-person | yes (assurance events) |
| 5 | **SEC-5 Organization-scoped grants and membership lifecycle** | V5 | yes (the deferred design questions) | yes |
| 6 | **SEC-6 Data classification and Restricted Records consolidation** | HIGHLY_RESTRICTED mapping, projection rules, export/print/offline/AI eligibility | yes | yes |
| 7 | **SEC-7 Medical / private vault** | §10 entirely | yes (the eight open decisions) | yes |
| 8 | **SEC-8 Encryption and key management** | V13, T14 | yes (KMS availability) | yes |
| 9 | **SEC-9 Secrets and service identities** | V13, V11, T10 | platform | no |
| 10 | **SEC-10 CI/CD secure-development gates** | V17, prefix gate, SHA pins | no | no |
| 11 | **SEC-11 Audit integrity and detection** | V18, V20 | small | yes (triggers / DB roles) |
| 12 | **SEC-12 AI and prompt-injection hardening** | V21, V22, T9 | no | no |
| 13 | **SEC-13 Incident response extension** | §14 gaps | small | yes |
| 14 | **SEC-14 Identity, passkeys, MFA and recovery** | staff MFA, passkeys | yes (identity provider) | yes |
| 15 | **SEC-15 Mobile / offline / device** | §11 | yes (native shell decision) | yes |
| 16 | **SEC-16 Infrastructure, backup and deployment** | T14, runbooks | platform | no |
| 17 | **SEC-17 Adversarial testing** | — | procurement | no |
| 18 | **SEC-18 Production security acceptance gate** | — | owner | no |

Why SEC-1 before the session work: it needs no decision, no migration, and no new mechanism — every fix is a
predicate the codebase already has an idiom for, with a database test in the idiom the repository already uses.
It also closes the two confirmed cross-tenant writes and the two medical disclosures, which are the findings a
penetration tester would reach first. The session redesign is second because it is the highest-risk single
weakness but requires product decisions and a schema change that deserve their own review.
