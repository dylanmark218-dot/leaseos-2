# LeaseOS Security — SEC-1 Checkpoint (tenant and resource authorization)

**Status: MERGED — VERIFIED on main** (see §4 for the evidence and §5 for what "verified" covers).

This checkpoint freezes SEC-1. It records what reached `main`, the evidence that the merged tree is
sound, and the exact boundary with SEC-2. Nothing here is a plan; the plan is
`docs/superpowers/plans/2026-09-23-leaseos-security-sec-1-tenant-resource-authorization.md`, and the
program is `docs/security/LEASEOS_SECURITY_PROGRAM.md`.

## 1. Merge record

| Field | Value |
|---|---|
| Pull request | #114 `claude/leaseos-security-architecture-f2j1vn` → `main` |
| Pre-merge head (gated and CI-green) | `9b02418327ad13b1dbbf098ec055fda7c4bf5a91` |
| Base recorded by the PR | `28647237dc451579deb1eb9bedbdc37fe3c19407` |
| `main` at the moment of merge | `93b9cfcad68d98acff1517aeccdbab1e5f3bbba0` (PR #110, merged 11:52:47Z) |
| Merge commit on `main` | `daf3ec6280813daf48208591a4e285c4378a5dfc` |
| Merged at | 2026-10-03T12:05:19Z |
| Merged by | the repository owner, through GitHub |
| Method | GitHub merge commit ("Merge pull request #114 from …"), the repository's established strategy. No squash, no rebase, no force-push at any point |

**Note on ordering.** PR #110 (operator identity scope hardening) merged twelve and a half minutes before #114,
so the tree at `daf3ec6` — #110 plus SEC-1 — was never built or tested before it reached `main`. Both
sides touch `server/db.ts`. The merge was textually clean; §4 is the evidence that it is also
semantically clean. That gap is why this checkpoint gates the merged `main` itself rather than relying
on the PR's CI.

## 2. What SEC-1 delivered

Every item was re-verified against `main` before code was written; four plan items were already fixed
there by the parallel program and were not touched.

| Plan item | Outcome | Commit |
|---|---|---|
| 1 Assistant draft and commit | `assistant.draft` checks every target (job, trip, unit, trip stop via its trip, financial entity) against the caller's scope **before** the model is called; `proposalInScope` rechecks a committed proposal's anchors and financial-entity target; unanchored proposals resolve only in single-tenant mode | `4d4f145` |
| 2 Compliance router | already fixed on main (F1.2, `344f352`) | — |
| 3 Private credential projection | `projectComplianceDocument` nulls the never-projected fields of any private row on `documents.list` and the exception centre's credential history; the medical rule is main's `isMedicalDocType`, not a second copy | `a2edd17` |
| 4 Approver standing | already fixed on main (B23.1) | — |
| 5 closeout / audit packages / surfaces.search / portal admin / invoicing | already fixed on main (F1, P0-A3) | — |
| 5 Restricted vault | `matterOpen`, `investigationPropose` resolve incidents in scope; break-glass is limited to `incidentMatter` targets that exist in the caller's organization | `eb34837` |
| 5 Exception centre | every source of `loadExceptionSources` now requires and applies a scope; the inbox's approver/resolver queues are scoped | `48db151` |
| 5 Comms packages | `packageFetch` / `packageStatus` scoped; `packageBuild` checks its anchors and scopes its predecessor lookup | `ce6f2ab` |
| 5 Commercial delivery | `deliveryUpdate` checks the document's book organization | `ce70ca0` |
| 5 Field device / sync | `sync.verifySeal` and `sync.resolveConflict` scoped; in `receivePackage` a foreign evidence id is rejected exactly as a nonexistent one (no seal or storage read), so the verdict is not an existence oracle | `d000cee` |
| 6 Security-incident state | state moves split into `securityIncidents.statusChange` under `incident.review`; `timelineAppend` carries notes only; an affected organization must exist | `8ba2652` |
| 7 Evidence capture reference | a capture reference already used by another user is a CONFLICT, never a returned row | `d000cee` |
| 8 Storage-key ownership | **deferred to SEC-6** — latent (no client sends a storage key; no procedure returns bytes for a client-cited key) | — |
| 9 Webhook decrypt-before-filter | already fixed on main (SEC-004) | — |
| found during item 5 | `academy.inspectorRequestCreate/Assemble/List` scoped through the learner | `6012926` |

Cross-boundary answers are NOT_FOUND, never FORBIDDEN, throughout.

### Tests added

Seven database test files, each in its own id band (`server/testIdBands.test.ts`):
`tenantScopeAssistant` (940M), `tenantScopeComplianceDocuments` (941M), `tenantScopeExceptions` (942M),
`tenantScopeVault` (943M), `tenantScopeComms` (944M), `tenantScopeCommercialDelivery` (945M),
`tenantScopeFieldDevice` (946M); plus the unit test `server/_core/complianceProjection.test.ts` and new
cases in `securityIncidents.db.test.ts` and `academyTdgWiring.db.test.ts`. Each fix was shown RED
against the unfixed code before it was made GREEN. No existing authorization or privacy test was
removed or weakened.

### Structural pins after SEC-1 (unchanged by the merge with #110)

| Pin | Value |
|---|---|
| `crossLayerIntegrity` server procedure paths | 953 (+1, `securityIncidents.statusChange`) |
| `procedureAuthorization` operational procedure permissions | 875 (+1) |
| `operationalApiAuthorization` operational procedure permissions | 875 (+1) |
| New permissions | 0 (`statusChange` uses the existing `incident.review`) |
| Migrations added by SEC-1 | 0 (main carries 207 migration files, through `0236`) |

## 3. Static verification of `main` at `daf3ec6`

| Check | Result |
|---|---|
| `9b02418` (SEC-1 head) is an ancestor of `main` | yes |
| Working tree clean after fast-forward | yes |
| Conflict markers in tracked source | none |
| Medical-document rule defined once | yes — `isMedicalDocType` in `server/_core/compliancePassport.ts`; `isPrivateDocType` delegates to it |
| `assistant.draft` validation duplicated | no — one `requireCallerUnits` (main's CP1.5) then one `assistantTargetsInScope` |
| Count pins derived from the merged tree | yes — the gate's typecheck and structural tests read them from source (§4) |

## 4. Gate and CI evidence

### Canonical gate on the merged `main` (`daf3ec6`)

`scripts/ci-gate.sh`, run on the exact tree at `daf3ec6` with the pinned Node (`.nvmrc` 22.23.3,
checksum-verified) and pnpm 10.4.1 (`--frozen-lockfile`), against a database the gate dropped and
recreated. Exit 0, ending `== PASS ==`.

| Stage | Result |
|---|---|
| 0a Runtime version truth | pass (v22.23.3) |
| 0 Reserved migration slots | untouched |
| 1–3 Clean database, all migrations, table parity | pass — 207 migrations, 482 tables |
| 3b Migration 0207 backfill verification | `0170 VERIFIED` |
| 4 Typecheck (`tsc --noEmit`) and test-file typecheck ratchet | clean; test-file type errors 0 (ceiling 0) |
| 5 Procedure census | 958 sites; bare `protectedProcedure` 0; 13 ungated sites, all pinned; `roleProcedure` 898 |
| 6 Full test suite | **502 files; 7,644 passed, 0 failed, 3 skipped** (pure 288 files / 4,923; database-backed 214 files / 2,721) |
| 6b Fixture isolation | `FIXTURE ISOLATION VERIFIED` (4 files, 67 tests) |
| 7 Production build | pass |
| 7a Production-only runtime boot | `dist/index.js` and `dist/worker.js` boot with production dependencies only |
| 7b External gate | 40 `externalProcedure`, pinned |
| 7c Machine gate | 2 `integrationProcedure`, pinned |
| 8 Current-state document | `current` — the committed `LEASEOS_CURRENT_STATE.md` equals the regenerated one (502 test files, 6,781 `it(` cases in source) |

**Skipped tests (3), PRE-EXISTING:** the three `it.skip` cases in `server/agentRuntimeApi.test.ts`
("not reachable from the API since the facts became server-owned"). SEC-1 did not touch that file.

**Failures: none.** Nothing was waived, retried or skipped to obtain this result.

### GitHub CI

| Commit | Run | Workflow / event | Result |
|---|---|---|---|
| `9b02418` (PR head, pre-merge) | 37120624436 (pull_request), 37120621585 (push) | CI | success |
| `daf3ec6` (`main` after merge) | 37121741965 | CI / push to `main` | success (12:05:54Z → 12:17:54Z) |
| `daf3ec6` | 37122214579 | CI / push (branch fast-forwarded to `main`) | success |

## 5. Limitations of this checkpoint

- SEC-1 closed the specific cross-tenant reads and writes the baseline (V1–V23) and the plan named,
  plus those found while fixing them. It is not a proof that no other unscoped query exists: 341 of
  409 tables still carry no organization column (baseline §6), and isolation for them rests on
  reaching rows through scoped parents. A systematic, tool-enforced check is SEC-10/SEC-18 work.
- `proposalInScope` does not recheck a trip-stop target independently; commit ties the stop to the
  proposal's trip, which is checked.
- The facility directory remains shared across organizations by design.
- The security baseline (`LEASEOS_SECURITY_BASELINE.md`) describes `main` at `6f52b57`. Work merged
  since — notably S1 session families (`fc55eb9` onward) and S2-KMS-A — postdates it, so its session
  and key-management rows are stale. They must be re-surveyed before SEC-2 is planned (§7).

## 6. Not implemented — later tranches

SEC-1 implemented none of the following, and nothing in this checkpoint should be read as claiming them:

| Capability | Tranche | State on `main` (not re-audited here) |
|---|---|---|
| Full session lifecycle (device-session inventory, revoke one / revoke all from a UI, compromise response) | SEC-2 | **PARTIAL, pre-existing, not SEC-1**: S1 session families exist (`server/_core/sessionFamily.ts`, `server/sessionFamilyService.ts`, `0175_session_families`) — 15-minute access token, 30-day absolute refresh, rotation with reuse detection, logout revokes the family, `revokeAllForOpenId`. Whether they meet the SEC-2 definition is unverified |
| Idle timeout | SEC-2 | not found in the session-family modules (only the absolute refresh limit and the 15-minute access token) |
| Step-up / privileged elevation | SEC-4 / SEC-5 | not implemented |
| Passkeys / WebAuthn, staff MFA and recovery | SEC-14 (user-proposed order: next after SEC-2) | not implemented for staff (portal TOTP only) |
| Device trust (attestation, office approval of enrolment) | SEC-15 | not implemented (attestation self-declared) |
| Offline device-bound authorization (signed, scoped, expiring capability) | SEC-15 | not implemented |
| KMS / envelope encryption of data at rest | SEC-8 / SEC-9 | **PARTIAL, pre-existing, not SEC-1**: S2-KMS-A managed secret-key bootstrap for stored secrets (and the portal MFA secret is AES-256-GCM); general field- and file-level encryption of data at rest is not implemented |
| Native encrypted SQLite on devices | SEC-15 | not implemented |
| AI / RAG hardening (prompt-injection boundary, model metadata, output validation) | SEC-12 | not implemented (SEC-1 added only the scope check before the model call) |
| Storage-key ownership / server-minted upload intents, MIME sniffing, malware scan | SEC-6 | not implemented (item 8 deferred) |
| Infrastructure hardening, backup and restore | SEC-16 | not implemented |

## 7. The SEC-1 / SEC-2 boundary

- **SEC-1 owns** *which* records an authenticated caller may reach: organization and resource scope
  on reads, writes, proposals, packages, sync items and incident state. It is frozen at `daf3ec6`.
- **SEC-2 owns** *whether* the caller is still authenticated: session issuance, expiry (idle and
  absolute), revocation (one, all, on compromise, on offboarding), and the session's binding to device
  and organization membership.
- SEC-2 begins with a re-survey of the S1 session-family code already on `main` and an updated plan
  that builds on it rather than duplicating it. No SEC-2 code has been written.
- **Numbering to reconcile before SEC-2 is planned.** The tranche numbers in §6 are those of
  `LEASEOS_SECURITY_PROGRAM.md` (SEC-3 perimeter, SEC-4 privileged/step-up, SEC-14 passkeys/MFA). The
  owner's proposed next chain is SEC-2 sessions → passkeys/MFA/recovery → security/profile/device-session
  UI → privileged elevation/step-up. The program table should be renumbered or annotated to match that
  order when SEC-2 is planned; this checkpoint does not change it.
- Any later change to a SEC-1 scope helper (`recordAnchorsInScope`, `assistantTargetsInScope`,
  `proposalInScope`, `complianceDocumentScopeWhere`, `incidentIdInScope`, `projectComplianceDocument`,
  the scoped exception loaders) must keep the SEC-1 test files green; they are the regression fence.
