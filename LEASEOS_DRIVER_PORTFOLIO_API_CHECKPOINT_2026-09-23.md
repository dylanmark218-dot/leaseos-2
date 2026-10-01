# LeaseOS — Driver Portfolio API and authorization (0212)


> **Migration numbers (2026-10-01):** `main` merged Live Assist's `0202`/`0203` first, so this work's
> migrations are now **`0210_driver_portfolio`**, **`0211_driver_portfolio_events_append_only`** and
> **`0212_driver_portfolio_api`** (formerly 0202–0204, before that 0175–0177, before that 0169 and 0170).
> Numbers below that name 0175/0176/0177 or 0202/0203/0204 refer to the same files under their earlier numbers.
**Branch:** `claude/driver-portfolio-api-ya8928`, stacked on PR #16 (the model checkpoint).
**Release label:** unreleased, on `v23.25`. `LEASEOS_RELEASE` is unchanged.

This checkpoint adds the API over the model and the authorization around it. It adds **no UI**, and
it does not start receipt capture.

## Built on what exists

The survey came before any code. Every mechanism below is the repository's own:

| Need | Reused | Not created |
|---|---|---|
| Authentication, permission, audit of the decision | `roleProcedure` + `OPERATIONAL_PROCEDURE_PERMISSIONS` + `GRANTS` | no parallel gate |
| Tenant | `actingScopeFor` (never client input), `ownershipScopeWhere` / `coreRecordOwnership` for operators, `orgScopeWhere` for `orgRef` rows; out of scope is **NOT_FOUND**, never FORBIDDEN | no tenant parameter |
| Credentials | `complianceDocuments` (owner decision D-05) | no credential table |
| Equipment | `operatorEquipmentAuthorizations` | — |
| Dispatch decision | `composeReadiness()` → `evaluateDispatchReadiness()`, with `assertReadinessSubjectInScope` | no `portfolioCanDispatch()`, no second algorithm |
| Separation of duties | the workforce precedent (`workforceRouter`: "may not verify") | — |
| Share tokens | `externalIdentityPolicy.newToken()` (32 random bytes) + `sha256`, the portal invitation pattern | **the model's HMAC token was removed**: no ad-hoc signing and no new secret |
| Offline freshness | the model's `validUntil`, now in `shared/driverWallet.ts` so the phone runs the same rule | — |
| Errors | `NOT_FOUND` / `FORBIDDEN` / `PRECONDITION_FAILED` / `BAD_REQUEST` / `CONFLICT`, plain sentences | — |
| Pagination | the repository's capped `limit` (1–200, default 50); keyset `beforeId` for audit; an opaque keyset cursor for the dashboard | no offset paging |

## Routes

tRPC procedures under `driverPortfolio.*`. The conceptual REST route is given where the brief named one.

| Procedure | Conceptual route | Permission | Who |
|---|---|---|---|
| `myWallet` | `GET /driver-portfolio/me/wallet` | `portfolio.read_own` (universal, self-scoped) | the driver |
| `myCredentialHistory` | `GET /driver-portfolio/me/credentials/:code/history` | `portfolio.read_own` | the driver |
| `myShares` | `GET /driver-portfolio/me/shares` | `portfolio.read_own` | the driver |
| `submitCredential` | `POST /driver-portfolio/me/credentials` | `portfolio.submit_own` (universal, sensitive) | the driver |
| `shareIssue` / `shareRevoke` | `POST/DELETE /driver-portfolio/me/shares` | `portfolio.share_own` (universal, sensitive) | the driver |
| `operatorReadiness` | `GET /dispatch/operators/:operatorId/readiness` | `dispatch.read` (reused) | dispatcher, office, management, auditor |
| `portfolio` | `GET /driver-portfolio/operators/:id` | `portfolio.read` | safety, HR, management |
| `auditHistory` | `GET /driver-portfolio/operators/:id/audit` | `portfolio.read` | safety, HR, management |
| `expiryDashboard` | `GET /driver-portfolio/expirations` | `portfolio.read` | safety, HR, management |
| `verificationQueue` | `GET /driver-portfolio/verifications` | `portfolio.read` | safety, HR, management |
| `credentialVerify` | `POST /driver-portfolio/credentials/:id/verification` | `compliance.credential.verify` (reused, sensitive) | shop lead, safety, office, management, HR |
| `requirementList` / `requirementGet` | `GET /driver-portfolio/requirements` | `portfolio.read` | safety, HR, management |
| `requirementCreate` / `requirementUpdate` / `requirementRetire` | `POST/PATCH/… /driver-portfolio/requirements` | `portfolio.requirement.manage` (sensitive) | safety, management |
| `shareRedeem` | `GET /share/:token` | **public** | whoever holds the token |

Permissions:
- **Added:** five, all in `recordsAuthorization.ts`:
  - `portfolio.read_own`, `portfolio.submit_own`, `portfolio.share_own`: universal
  - `portfolio.read`
  - `portfolio.requirement.manage`

  The `_own` three read the operator linked to `ctx.user.id` and accept no operator id. Of the five, `submit_own`, `share_own` and `requirement.manage` are **sensitive**: the call is refused if its authorization row cannot be written.
- **Reused:** `dispatch.read` and `compliance.credential.verify`.

### What each view exposes

- **Wallet** (the driver):
  - a status of `READY FOR WORK` / `ACTION REQUIRED` / `NOT READY` / `STALE`
  - cards with the requirement kind and code, name, state, expiry, warning tier, verification state, mandatory/informational/optional, and the blocker reason
  - requirements that apply only to some work (customer, site, job type, equipment, job), each named by binding
  - upcoming expirations, equipment qualifications, and the driver's own credential metadata (never storage keys or URLs)
  - `cache` metadata
  - Private credentials (medical fitness) are not in it.
- **Dispatch:** `composeReadiness()`'s verdict and explanation unchanged, a licence tick, `dispatchView` requirement lines, and operator findings. No certificate numbers, documents, providers, private detail or HR file. A test asserts the verdict and explanation equal `dispatch.readiness` for the same subject.
- **Safety:**
  - each credential type's current record and full history, with the reason each is no longer current
  - unrecognised documents
  - a *count* of withheld private credentials (not their contents, which stay on HR's `compliance.private.read` path)
  - equipment, the company baseline evaluation, expiry warnings, and recent audit events
  - Opening it writes a `portfolio_viewed` event.
- **Share redemption (public):**
  - `valid`, the reason, holder name, credential label, state, expiry and verification dates, the last four characters of the certificate number, and the share's own expiry
  - Nothing else: no other credential, no organization, no document.

## Semantics carried from the model

- **Blocking:**
  - Mandatory and missing, rejected, expired, lapsing before `workEndsAt`, wrong licence class, or not authorized on the equipment: **blocking**, never overridable.
  - Mandatory and unverified, or with no expiry recorded: **UNKNOWN**. Under D-02 this blocks (`APPROVED_POLICY_ONLY`).
  - Informational: never a blocker.
- **Renewals:** a verified renewal supersedes the ticket that was in force. That ticket stays in the history as `superseded`, and its expiry warning leaves the dashboard. An unverified renewal does neither, and the warning says one is waiting (`pendingRenewal`).

## Credential workflow

1. **Submit:** `submitCredential` enters a `complianceDocuments` row as `needs_review` and writes `credential_uploaded`, with the operator as actor.
2. **Verify or reject:** `credentialVerify`, by a verifier in the same organization. The verifier may record the certificate's actual expiry and issue dates.
3. **Refused:**
   - verifying your own credential (the operator's linked user): FORBIDDEN, "You may not verify your own credential"
   - verifying one you submitted: FORBIDDEN
   - a credential that is not `needs_review`: PRECONDITION_FAILED
   - a credential in another organization: NOT_FOUND
4. **Effect:** readiness changes immediately. The wallet, the dispatch check and the award fingerprint all read the same row.
5. **Audit:** `credential_verified` or `credential_rejected`, and `credential_superseded` for the ticket a renewal replaced.

## Requirements

- **Create:** validated by `bindingProblem()` (known catalogue code, `*` for company scope, class 1–6). The `orgRef` is the caller's scope.
- **Update:** never edits in place. It retires the binding and creates a successor that records `supersedesBindingRef`, in one transaction. A concurrent change fails with CONFLICT, and a retired binding cannot be updated.
- **Retire:** sets `active=false`, with who and when, and requires a reason. Nothing is deleted.
- **Audit:** every mutation writes `requirement_bound`, `requirement_modified` or `requirement_retired`, with `orgRef` and actor. `operatorId` is NULL for these organization-level events.

## Offline contract

`myWallet.cache` carries:
- `generatedAt`
- `validUntil`
- `offlineAllowanceHours` (24)
- `limitedBy` (`offline_allowance` or `credential_expiry`)
- `limitingCredential` (the required ticket whose expiry shortened the window)

`shared/driverWallet.walletStatusAt(wallet, now)` is the rule both sides run:
- past `validUntil`, READY FOR WORK and ACTION REQUIRED read **STALE**
- NOT READY stays NOT READY
- an unreadable `validUntil` reads STALE

## Sharing

- **Issue:**
  - one credential, the caller's own, verified and currently valid
  - never private, never outside the catalogue (so never medical fitness)
  - for a named audience, 24 hours by default and at most 168
  - the token is returned once and only its SHA-256 is stored, in `driverCredentialShares`
- **Redeem** (public) re-reads the credential now and returns one of:
  - `not_found`
  - `revoked`
  - `expired`
  - the credential's current state (`rejected`, `expired`, `superseded` when a verified renewal replaced it, …) with `valid:false`
  - valid
- **Audit:** `credential_shared`, `share_revoked`, and `share_verified` on each redemption of a live share.

## Migration 0177

The first slot free on main and on every open branch; the collision register is updated.
- `driverPortfolioEvents`:
  - `+orgRef`
  - `operatorId` becomes nullable (organization-level events)
  - the event enum gains `credential_superseded`, `requirement_modified` and `share_revoked`
  - new index `(orgRef, operatorId, id)`
  - It stays append-only: 0176's triggers are untouched, and ALTER fires no row trigger. A test re-checks this on the new column.
- `driverRequirementBindings`: `+supersedesBindingRef`.
- `driverCredentialShares`: new table (`tokenHash` unique, `revokedAt`).

## A defect the API tests found in the model checkpoint, fixed here

With no job named, `composeReadiness()` took the work's organization to be the historical single
tenant. So an organization's company-wide requirements never reached the dispatch check of its own
operator. The tenant is now the job's organization, or, with no job, the operator's owner
(`coreRecordOwnership`). The "agrees with `dispatch.readiness`" test caught it.

The wallet now also lists unsatisfied **mandatory** cards before informational ones. Previously a
missing informational card could be listed first.

## Tests

- **`server/driverPortfolioApi.db.test.ts` (17):** every call goes through `appRouter.createCaller` with real roles, memberships and ownership.
  - **Wallet:** the driver's own wallet only; READY → STALE past `validUntil`; `validUntil` shortened by a lapsing required ticket; unverified stays ACTION REQUIRED; a user without an operator is NOT_FOUND.
  - **Driver refusals:** another driver's portfolio, the dashboard and requirement management are all FORBIDDEN.
  - **Dispatch:** agrees with `dispatch.readiness`; no certificate numbers, private credentials or storage fields on the wire; cannot browse the portfolio. Expired mandatory blocks, missing blocks, unknown stays unknown, informational never blocks.
  - **Cross-organization:** org B's dispatcher, Safety and verifier get NOT_FOUND. Org B cannot read, get, update, retire or list org A's requirements.
  - **Requirements:** retire and supersede without deletion; invalid bindings refused; the audit trail of bound → modified → retired.
  - **Verification:** submit → verify → readiness changes, audited; the driver cannot verify; a Safety lead who is also the driver cannot verify their own; re-verifying is refused; rejection blocks.
  - **Renewal:** removes the expiry warning and keeps the superseded history.
  - **Dashboard:** window, verification, readiness-impact and credential filters; cursor pagination; malformed cursor refused; another organization sees nothing.
  - **Shares:** minimum fields and a masked number; hash-only storage; revoked, expired, superseded and rejected all read not valid; another driver's, private, unverified or over-7-day shares are refused; revoking someone else's share is NOT_FOUND.
  - **Audit:** cannot be updated or deleted.
- **`server/_core/driverPortfolio.test.ts` (31):** share tests rewritten for the token-hash design; offline rule; unverified-expiry alerts.
- **Pinned counts this branch adds** (on `main` as merged at `416ac93`):
  - operational procedures 682 → 699 (+17)
  - mounted paths 752 → 770 (+18: the 17 plus the public `shareRedeem`)
  - public procedures 4 → 5 (`procedureAuthorization.test.ts` also counts `driverPortfolioRouter.ts`, and pins `shareRedeem` by name; the procedure census pin lists it too)
  - the universal-permission list
  - migration head 0209 → 0212 (`migrationSlots.test.ts`)

## Unresolved, named

- **The legacy verify path.** `compliance.credentialVerify` (complianceRouter, pre-existing) still verifies without separation of duties or organization scoping. The portfolio path is the separated one. Closing the legacy path changes an existing API and is left for the owner.
- **No recorder column.** `complianceDocuments` does not record who entered a row. The submitter rule relies on the portfolio's own `credential_uploaded` event, so a credential entered through another path is checked only against "not your own".
- **Public redemption has no rate limit.** The token is 256-bit and only live shares write an audit row. A rate limit belongs to the HTTP edge, which has none yet.
- **The dashboard computes in memory** over the organization's operators. That is fine at fleet scale; it would need SQL-side filtering before it reached thousands of drivers.
- **Another wallet exists.** `claude/training-academy-workforce-q3mdse` builds a separate training wallet on `workerQualifications`, which D-05 says must not remain independent. The owner should reconcile it before either reaches drivers.
- **Not built:** the UI, the QR rendering, document image retrieval (that goes through the evidence vault), `used_for_dispatch` events at award time, and receipt capture (the checkpoint after the wallet UI).
