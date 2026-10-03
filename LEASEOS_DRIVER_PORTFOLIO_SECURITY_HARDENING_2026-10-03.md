# Driver Portfolio — security hardening (2026-10-03)

This is the hardening pass on what #16 (`48a64e1`) landed, before any Wallet UI work starts.
`LEASEOS_RELEASE` is unchanged. The one migration is `0229_compliance_document_recorder.sql`.

## 1. One verification door

`server/credentialVerificationService.ts` → `decideComplianceCredential` is the only code that
changes a `complianceDocuments` row's verification state. The rule itself is
`server/_core/credentialVerificationPolicy.ts`.

| Path | Before | Now |
|---|---|---|
| `compliance.credentialVerify` | enforced the subject rule only | the service |
| `fieldRoute.identity.documents.review` | `db.reviewComplianceDocument`: no separation of duties, no state check, no verifier recorded | the service (the helper is removed) |
| `driverPortfolio.credentialVerify` | checked the subject and the portfolio submitter | the service, narrowed by `accept` to catalogue, non-private operator credentials |
| `workforce.trainingVerify` / `taskVerify` | minted a verified credential with no separation-of-duties check | `assertMayDecide` (the same policy), before minting |

What the service enforces:
- **Scope first.** `requireSubjectInScope` runs first; an out-of-scope credential reads as not found.
- **The subject may not decide it.** That is the operator's user, or the user themselves.
- **The recorder may not decide it.** That means the `recordedByUserId` column, plus the portfolio's own upload row for rows older than the column.
- **Only `needs_review` is decided.** `rejected → verified` is refused. A rejected credential is resubmitted as a new version, which starts again in `needs_review`.
- **Concurrent decisions cannot both land.** The update is conditional on `verificationStatus = 'needs_review'` and must affect exactly one row. Otherwise the call fails with `PRECONDITION_FAILED`.
- **The audit row is the same on every path.** Each decision writes one `driverPortfolioEvents` row naming the reviewer and the path (`… via <path>`). It never includes the identifier, the storage key or the contents.

Structural guard: `server/credentialVerificationGuard.test.ts` fails if any of these appear:
- a second writer to `complianceDocuments`;
- a verified insert outside workforce;
- an insert without a recorder.

## 2. Recorder provenance (0229)

`complianceDocuments.recordedByUserId` is a nullable int. These paths set it:
- `compliance.credentialRecord`;
- `documents.create`;
- `driverPortfolio.submitCredential`;
- the HOS scanned log;
- workforce minting (where the trainer or completer is the recorder).

Historical rows keep NULL; nothing is invented for them. For a NULL row the subject is still refused, scope and state still apply, and any other reviewer may decide it.

The owner, uploader, recorder, submitter and verifier stay distinct facts.

The legacy entry paths (`compliance.credentialRecord`, `documents.create`) now write the same `credential_uploaded` portfolio row as the driver's own submission. Private and medical rows get no portfolio row; the column is their provenance. `documents.create` now marks `medical_fitness` private, as `credentialRecord` already did.

## 3. Equipment authorizations are org-scoped

An authorization counts for an operator only when the book (`financialEntities`) that holds it belongs to the operator's own organization. The helper is `driverPortfolioService.equipmentAuthorizationsInOrg`, and it is used by both:
- `loadPortfolios` (portfolio, wallet, dashboard);
- `readinessComposer` (dispatch).

Another employer's authorization never reaches this organization's portfolio or readiness. An organization with no books has no authorizations, so the check fails closed. Same-org behaviour is unchanged.

## 4. Wallet vs dispatch (Case B: explicit contract)

There is one engine, `evaluateDriverReadiness`, with two questions. The wallet answers the **company baseline only**:
- its headline is renamed `READY FOR WORK` → **`BASELINE MET`**;
- `myWallet` returns `grantsDispatch: false` and `notCovered` (`WALLET_NOT_COVERED`: customer, site, job-type, equipment and job requirements, unit, HOS, medical fitness and overrides).

Only `operatorReadiness` / `composeReadiness` speak for a job. No `canDispatch` exists. A test shows the wallet reading `BASELINE MET` while dispatch blocks a job whose customer demands more.

## 5. Public sharing

These are preserved:
- one credential per share;
- a 7-day maximum;
- a SHA-256-only token;
- a re-check at every redemption;
- revocation and expiry.

Changes:
- **POST, not GET.** `shareRedeem` is now a mutation, so the token travels in the request body. The page a QR code opens should carry the token in its fragment (`/share#<token>`), which browsers never send to the server, and post it. (The UI is not built here.)
- **Bounded attempts.** The repository had no rate-limit infrastructure; `server/_core/attemptLimiter.ts` is in-process, fixed-window and bounded in memory.

  | Budget | Limit |
  |---|---|
  | attempts per address | 60 per 10 minutes |
  | refusals per address | 15 per 10 minutes (once exceeded, even a good token is refused) |
  | redemptions per share | 30 per hour |

  These limits are per process. Behind a proxy, Express needs `trust proxy` for `req.ip`; without it the per-address budget is shared, which fails closed.
- **No durable rows for refusals.** A refusal is one `console.warn("[ShareRedeem] refused", …)` line: the reason, the address and a 12-character hash prefix. A successful redemption writes `share_verified` at most once per share per 15 minutes (`SHARE_AUDIT_EVERY_MS`). Attackers cannot fill the append-only table.
- **The organization must still match.** A share redeems only while the holder's operator is still owned by the organization that issued it.
- **Medical never leaves.** `_core/driverPortfolio.shareableType` is an explicit allowlist: the catalogue's licence, endorsement, safety-ticket, company-training and orientation types. On top of that, a deny pattern (medical, health, fitness, drug/alcohol, criminal, abstract, background, screening) applies whatever `privateDetail` says. It is applied both when a share is issued and at every redemption. `loadPortfolios` also drops `medical_fitness` by type, so a mis-flagged medical row is still withheld.

## 6. Audit

The `driverPortfolioEvents` table stays append-only. It records:
- submitted (and resubmitted after rejection, which names the rejected credential);
- verified;
- rejected;
- superseded;
- share issued;
- share revoked;
- successful redemption (throttled).

No row carries a raw token, an identifier, a storage key or document contents.

## Not in this change

- **Dashboard performance.** `expiryDashboard` and `verificationQueue` each load every in-scope operator's portfolio on each call. This is a separate checkpoint (pagination is already keyset; the cost is the load).
- **Excluded by instruction:**
  - the Wallet UI;
  - receipt capture;
  - expense work;
  - the commercialOffice audit-hash nondeterminism;
  - TypeScript 7 modernization;
  - migration-ledger/schema parity (`schemaMigrations` absent from `schema.ts`);
  - inventory cleanup;
  - `LEASEOS_RELEASE`.
