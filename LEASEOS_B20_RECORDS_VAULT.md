# LeaseOS — B20 Checkpoint: Records, Evidence & Compliance Vault

**Date:** 2026-09-06
**Base:** v20.3 (87 tables · 488 tests)
**Output:** v20.4 — 103 tables · 18 migration files · **553 tests**

---

## 1. Completed

The evidence spine underneath field paperwork, incidents and the maintenance chain. Backend and
engines only — UI stays deferred per the established strategy.

| Requested | Built |
|---|---|
| File manager for field paperwork, photos, logs, bills, manifests, disposal + load tickets | `evidenceRecords` extended + relationship graph |
| Sealed with send-to-office prompt | `evidenceSeal.ts` — canonical manifest, SHA-256, server re-verification |
| Auto-send once back in service | `evidenceSync.ts` — 8-state machine, bounded retry, no operator action |
| 14 days on the device for DOT / scale stops | `retentionPolicy.ts` — device clock + roadside scope allowlist |
| Operator can delete their own copy | `evaluateDeviceDeletion()` — five named blockers |
| Office sealed file, keyed to employee #, name, unit, job, ticket | `evidenceRelationships` — 19 entity types |
| Auto-catalogue on receipt, not on open | Verification gate precedes review; opening means *reviewed*, not *filed* |
| 10-year portfolios for Transport Canada audits | Company retention policy, `MAX()` resolution |
| **Incident + near miss reports** (previously unprogrammed) | `incidentReport.ts` + 4 tables |
| Driver request → management → shop → back in service → office | `mechanicRelease.ts` + `workOrderReleases` |

**Nothing was duplicated.** `evidenceRecords`, `workOrders`, `maintenanceDefects`, `safetyEvents`,
`complianceDocuments` and `recordAmendments` already existed. `evidenceRecords` was **extended in
place** (5 columns) rather than replaced by a parallel table, because an evidence object has one
identity, not two.

---

## 2. Two real bugs found

### 2.1 Nothing could legitimately return a unit to service

`dispatchReadiness.ts` has consumed `mechanicReleaseRequired` / `mechanicReleaseGiven` since B14 —
but **no schema or engine could ever set them**. `workOrders` had a `closed` status, a `technician`
*string*, and no release record at all. The downstream gate existed with nothing legitimate upstream
of it, so in practice `closed` was the only available proxy for "fit for service."

Closing a work order is an administrative act. A release is a named, authenticated technician
asserting a specific defect is corrected. Conflating them is how an unrepaired truck gets dispatched.

Fixed with `workOrderReleases` (append-only sibling — the work order is not mutated) and
`evaluateMechanicRelease()`, which scales evidence requirements to defect severity: a critical defect
needs an authenticated technician, corrective action, test procedure, passing result **and** a road
test; an advisory defect needs none of the last three. `closureImpliesRelease()` returns `false` for
anything above advisory and is pinned by test.

### 2.2 A collision held the unit and told nobody who schedules it

Caught by my own test during this build, and the code was wrong — not the test. `planEscalation()`
set `holdUnit: true` for a collision, but added `dispatch` to the notify list only via a separately
listed *damage* condition. A collision with no damage recorded yet held the unit while dispatch
carried on scheduling it.

Fixed by deriving the notification from `holdUnit` itself, so a hold reason added later cannot forget
to notify. Regression test asserts every hold reason reaches both dispatch and maintenance.

---

## 3. The retention correction you should know about

You asked for everything to stay on the device 14 days "for DOT stops and weigh scale inspections."
Built — but **not** as a claim that it is the law, because it isn't quite.

The current-day-plus-14 figure is the **ELD roadside-production requirement for hours-of-service
records**. It is not a blanket rule that every field document must live on a phone for 14 days.
Carrier HOS retention and dangerous-goods shipping-document retention are separate requirements with
different periods again.

So both numbers are configured as **company policy intended to meet or exceed applicable minimums**:

- `COMPANY_DEFAULT_DEVICE_RETENTION_DAYS = 14`
- `COMPANY_DEFAULT_OFFICE_RETENTION_MONTHS = 120`

`statutoryMinimumMonths` stays **null and `unverified`** until an authoritative source is loaded. The
engine applies company policy and attaches a caveat — *"statutory compliance not asserted"* — rather
than implying legal backing it cannot evidence. A recorded-but-unverified statutory minimum is
**ignored even when it is longer**; only a `verified` source can win the `MAX()`. Both behaviours are
test-pinned.

The 14-day figure appears in exactly one place where it legitimately belongs:
`hosProductionWindow()` in the roadside inspection scope. LeaseOS presenting those records does not
make it a certified ELD, and nothing here claims otherwise.

---

## 4. Things added that you didn't ask for

- **Roadside inspection scope is an allowlist, not a denylist.** An operator handing a tablet to an
  officer must not be handing over customer billing, payroll, other employees' records or incident
  investigations. A denylist leaks whatever category someone adds next; the allowlist closes new
  categories by default. `buildInspectionView()` reports `withheldCount` rather than silently dropping.
- **Sealing refuses a record related to nothing.** An evidence object filed into no portfolio is
  unfindable at audit, so it is rejected at seal time rather than becoming an orphan.
- **"Waiting for service" is never shown as an error.** A driver 80 km out of coverage has not failed
  at anything. Only a genuine integrity rejection is operator-actionable.
- **Drafts are never swept into a send package** — transmitting one would send something the operator
  never confirmed.
- **A verified hash releases the device copy, not a 200 response.** Received-but-unverified is its own
  state and does not release anything.
- **Storage relief ordering:** map cache is sacrificed first; mandatory retention records never.
- **AI structures, never rewrites.** `applyAiSummary()` returns the operator's statement
  byte-identical, and that is an assertion in a test rather than a comment. An unverified UN number
  stays `usableForRegulatoryPurposes: false`.
- **Severity is derived from facts, not a dropdown.** Asking an operator to self-rate severity right
  after an event produces noise; asking what happened produces evidence.
- **Near miss stays three questions long** and converts to an incident on injury, carrying the
  original statement — the operator retypes nothing.

---

## 5. Schema / migrations

**Migration `0019_records_evidence_vault.sql`.** Slots `0016` and `0017` remain reserved for the
spatial and LoadSense branches — this migration deliberately does not consume them.

16 new tables: `evidenceRelationships` · `evidenceVersions` · `evidenceSeals` · `retentionPolicies` ·
`recordRetentionState` · `legalHolds` · `legalHoldRecords` · `syncPackages` · `syncPackageItems` ·
`syncReceipts` · `incidentReports` · `incidentPeople` · `incidentActions` · `nearMissReports` ·
`workOrderReleases` · `evidenceAccessEvents`

`ALTER TABLE evidenceRecords` adds `trackingNumber`, `recordType`, `sealState`, `currentVersion`,
`legalHold`. No applied migration was modified.

> **Note on the number:** the trunk is now **103 tables** — the same total the v21 checkpoint claimed,
> for entirely different reasons. These are B20 records tables. The spatial + LoadSense tables are
> still absent. Do not read 103 as evidence that branch landed.

---

## 6. Verification — full gate, clean database

| Step | Result |
|---|---|
| 18 migrations applied in order, fresh DB | PASS — 103 tables |
| `verify-parity.sh` | PASS — 103 / 103 |
| `tsc --noEmit` | PASS — clean |
| `vitest run` | PASS — **553 / 553**, 26 / 26 files |
| `pnpm build` | PASS — `dist/index.js` 199.9 kb |

488 → 553 (**+65**), all in `evidenceVault.test.ts` and `incidentMaintenance.test.ts`. No existing
test was modified.

---

## 7. Remaining gaps

- **No UI.** Driver Field Vault and Office Records Vault are unbuilt by design.
- **No tRPC procedures or authorization wiring.** Engines are pure; endpoints are next.
- **Not wired into the B17 workflow engine.** `planEscalation()` and `unitServiceStateAfterRelease()`
  return what *should* happen; nothing emits domain events yet. That wiring is the natural next build.
- **Encrypted device storage is unimplemented.** A real 14-day guarantee needs encrypted SQLite plus a
  native file store; browser storage is not a retention guarantee.
- **Audit Package Builder, duplicate detection, OCR auto-filing, safety-meeting attendee records** —
  designed, not built.
- **Spatial + LoadSense and Integrated Operations branches** — still not supplied.

---

## 8. External data

No regulatory values were invented. Every retention policy row ships `statutorySourceStatus:
'unverified'` with a null minimum. Loading verified Transport Canada / provincial / TDG retention
periods with source URL, version and verification date is outstanding work, and until it happens the
system says so out loud instead of implying compliance.

---

## 9. Next recommended step

**Wire B20 into the B17 workflow engine.** The engines decide correctly and emit nothing. Connecting
`planEscalation()` → outbox → tasks/notifications, and `unitServiceStateAfterRelease()` → dispatch
re-evaluation, closes the loop end to end: *sealed incident → management notified → shop → release →
dispatch recalculated → office archive*, provable by integration test the way B19 proved the defect
path. That reuses existing orchestration rather than adding a parallel one.
