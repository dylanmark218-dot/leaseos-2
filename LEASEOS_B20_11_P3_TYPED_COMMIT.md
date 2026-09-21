# LeaseOS — v20.13-dev1 Checkpoint: P3 Typed Assistant Commit Boundary

> **Gate-pending candidate, not a released checkpoint.**
>
> Base: v20.12.2 (131 tables · 23 migrations · 142 role-authorized procedures ·
> 0 bare `protectedProcedure` · 864 passing tests as reported by the base).
>
> This environment does not contain the repository's `node_modules`, pnpm, or
> MariaDB client/server, and outbound package installation is unavailable.
> Therefore the full project CI gate could not be executed here. The pure
> TypeScript modules compile with the available global TypeScript compiler,
> custom regression harnesses pass, the changed TypeScript files transpile
> without syntax diagnostics, and static schema/migration parity is 132/132.
> Promote to **v20.13** only after the full gate in §9 passes.

## 1. What this slice closes

The Assistant already had typed extraction, gaps, minimum questions, read-back,
acknowledgement, persistence, and a sensitive `assistant.commit` procedure. The
last step was not actually a domain commit: it returned a committed field set,
marked the proposal committed, and stopped there.

This slice turns that final boundary into an explicit allowlisted write path for
the two forms that exist in the trunk today:

| Form | Typed target | Second permission |
|---|---|---|
| `unload_stop` | update one existing `tripStops` row | `trip.write` |
| `defect_report` | create one `maintenanceDefects` row | `maintenance.write_defect` |

There is deliberately **no generic record writer**. An unknown form fails closed
until somebody writes and tests an adapter for it.

## 2. New commit architecture

`assistantCommitAdapters.ts` is a pure planner. It validates the committed
fields and turns an allowed form into one typed intent. It does not touch the
database.

`assistantCommitService.ts` executes that intent transactionally:

1. locks the proposal;
2. returns an existing receipt on retry;
3. rehydrates the persisted fields and re-runs the proposal commit gate;
4. plans the typed target write;
5. re-reads current role grants inside the transaction;
6. independently authorizes the **target-domain permission**;
7. records that authorization decision;
8. locks and validates the target row;
9. writes the target;
10. stores a SHA-256 provenance receipt;
11. marks the proposal committed.

One proposal can create/update its target once because
`assistantCommitReceipts.proposalId` is database-unique and the proposal is
locked before the receipt check.

The outer `assistant.commit` permission and the target permission are separate
on purpose. Today `office` can perform both supported target writes;
`management` can perform `assistant.commit` + `trip.write` but does not hold
`maintenance.write_defect`, so a management attempt to commit a defect is
refused by the second gate.

## 3. Write-context schema added

A human-readable string such as `TRIP-42 unload stop` is not a database key, and
`10:15` is not a timestamp without a date and UTC offset. Migration `0025`
therefore adds to `assistantProposals`:

- `targetRecordId`
- `eventDateLocal` (`YYYY-MM-DD`)
- `utcOffsetMinutes`

and creates `assistantCommitReceipts` with:

- proposal/form/action/target identity;
- required target permission and authorization-decision id;
- adapter version;
- canonical field manifest + SHA-256;
- actor and committed time.

For unload-stop times, one backwards clock transition is interpreted as a
midnight rollover. More than one rollover is refused because the compact form
cannot prove a >24-hour sequence.

## 4. Provenance / no-invention rules

The target adapter refuses to guess a trip-stop id, trip id, event date, or UTC
offset.

A value whose target column cannot preserve approximation is refused while it
is still approximate. `waitMinutes` is now precision-sensitive because it can
become paid/billable time and `tripStops.waitMinutes` has no approximation
channel.

`measurementMethod` is revalidated against the form options and remains in the
commit receipt. It is **not invented as a `tripStops` field** because that table
has no such column in this trunk. A future billing consumer of Assistant-written
trip-stop quantity must use the receipt/provenance rather than treating the raw
quantity as certified measurement.

A defect adapter records the operator's observation and creates the defect at
`advisory` severity. It does not diagnose a cause or promote the observation to
`critical`/`inspection_required`. The structured `unitId` is re-resolved from
`units` and must match the proposal's human-readable `unitNumber`.

Enums are revalidated at this final boundary even if a prior human correction
stored an out-of-schema value.

## 5. Bugs found and fixed while wiring it

### 5.1 Persisted proposal gaps were stale

`loadProposal()` loaded the real stored fields, but its gaps/questions came from
`buildProposal(form, targetRef, [])` — an empty proposal. A complete persisted
proposal could therefore reopen as incomplete and fail read-back/commit.

`assistantPersistence.ts` now rebuilds fields first and recomputes
`detectGaps()` / `minimumQuestions()` from the persisted field set. Unknown
persisted forms fail closed.

### 5.2 Proposal ids could collide across different reports

The deterministic id seed used the form, target label and **field names**, not
the field values. Two different defect reports on the same unit with the same
set of fields could resolve to the same `proposalId` and collide on the unique
index.

Persistent server captures now supply `P-${randomUUID()}`. The pure-engine
fallback also includes sorted field values/source utterances so different
content does not collapse onto the same fallback id.

### 5.3 Wait time was not precision-sensitive

Voice extraction defaults to approximate, but `waitMinutes` did not ask the
precision question even though the value can affect trip/billing records. It is
now precision-sensitive and the existing test was deliberately changed to hold
that stronger rule.

### 5.4 Human correction could bypass enum options

`answerField()` can store a corrected string without revalidating the enum
options. That broader proposal API remains unchanged in this slice, but the
operational write boundary now revalidates `system`, `measurementMethod`, and
`delayReason`, so an invalid corrected value cannot enter the target table.

## 6. Files added / changed

Added:

- `drizzle/0025_assistant_commit_receipts.sql`
- `server/_core/assistantPersistence.ts`
- `server/_core/assistantPersistence.test.ts`
- `server/_core/assistantCommitAdapters.ts`
- `server/_core/assistantCommitAdapters.test.ts`
- `server/_core/assistantCommitService.ts`
- `server/assistantCommitService.test.ts`
- `LEASEOS_B20_11_P3_TYPED_COMMIT.md`

Changed:

- `drizzle/schema.ts`
- `server/_core/aiProposal.ts`
- `server/_core/aiProposal.test.ts`
- `server/routers.ts`

## 7. Candidate counts

These are **static candidate counts, not a claim that the full suite passed**:

| Metric | v20.12.2 base | v20.13-dev1 candidate |
|---|---:|---:|
| Tables | 131 | **132** |
| Migration files | 23 | **24** |
| Role-authorized procedures | 142 | **142** |
| Bare `protectedProcedure` | 0 | **0** (no new bare procedure added) |
| Permissions | 104 | **104** |
| Sensitive permissions | 31 | **31** |
| Test definitions | 864 | **878** |
| Test files | 36 | **39** |
| Static schema / CREATE TABLE parity | 131/131 | **132/132** |

## 8. Verification actually performed here

PASS:

- pure TypeScript compile of `aiProposal.ts`, `assistantPersistence.ts`, and
  `assistantCommitAdapters.ts` under `--strict`;
- persistence regression harness: complete stored proposal reloads with zero
  false gaps and enters read-back;
- commit-adapter regression: midnight rollover, no measurement-method flattening;
- enum-boundary regression;
- proposal-id content/override regression;
- wait-time precision regression;
- TypeScript syntax/transpile check across all changed TS/test/schema files;
- static invariants: proposal lock, receipt idempotency, second authorization,
  trip target cross-check, unit target cross-check, unknown-adapter refusal;
- static schema / migration table count: **132 / 132**.

NOT RUN HERE:

- MariaDB migration execution;
- `verify-parity.sh` against a live database;
- full `tsc --noEmit` with repository dependencies;
- Vitest full suite / DB-backed commit-service tests;
- production Vite/esbuild build.

## 9. Promotion gate — required before naming this v20.13

Run from a clean database, in the same order used by the existing CI:

```bash
pnpm install --frozen-lockfile
bash scripts/apply-migrations.sh
bash scripts/verify-parity.sh
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm build
```

Expected structural targets before test discovery changes:

- 24 migrations apply cleanly;
- 132 tables;
- parity 132/132;
- 39 test files / 878 test definitions;
- zero bare `protectedProcedure` regression.

Do **not** call the checkpoint released if the DB-backed
`assistantCommitService.test.ts` has not run. It specifically proves target
mutation, receipt replay/idempotency, unit cross-check, and the second target
permission.

## 10. P3 still remaining after this slice

This is not all of P3. Remaining in the planned sequence:

1. document image/PDF extraction + OCR ingestion into proposed fields;
2. persistent question queue (not only derived in-memory questions);
3. merchant memory for recurring expense classification suggestions;
4. duplicate/document fingerprint matching;
5. home-base distance evidence and review flow;
6. auto-filer into Evidence Vault / expense/document portfolios;
7. additional typed adapters as corresponding forms are introduced:
   `expense_receipt`, `disposal_ticket`, and later load/manifest forms;
8. scanner/API negative tests proving OCR/AI output can propose but cannot
   self-certify billing, TDG, tax, safety, or maintenance conclusions.

After P3: P4 encrypted device storage, then the UI tranche. P5 spatial import is
still held for the missing Spatial/LoadSense branch and the three unresolved
AER/Alberta 511 licence confirmations.
