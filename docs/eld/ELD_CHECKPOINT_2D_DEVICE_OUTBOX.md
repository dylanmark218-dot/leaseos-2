# ELD Checkpoint 2d — the device-side ELD event outbox

**Branch:** `claude/eld-compliance-intelligence-ramlrd`. **Start:** `c731c69`. **Main merged:** `a61ff29`
(merge commit `18d66b5`). **Scope:** a durable, offline-first path from the driver application to the
canonical ELD ledger: event creation on the device, an atomic local commit, a hash chain that follows
creation order, signed delivery through `eld.eventsAppend`, and per-event acknowledgement. No migration.
No diagnostics, compliance scoring, readiness, dispatch, job-board eligibility, daily verdicts or UI. HOS
behaviour is unchanged: `HOS_DAY_RULE_UNVERIFIED` and every other answer are exactly as in 2c.

## 1. What the repository had (the survey)

| Question | Finding |
|---|---|
| Driver/mobile app | One React client (`client/src`) with a field runtime in `client/src/runtime/`: `Outbox` (six capture states), `SyncEngine` (evidence upload → seal → signed package), `BoardQueue` (direct sends). |
| Device storage | `LocalStore` is a key-value interface with **no transaction primitive**. The native encrypted SQLite binding (`adapters/capacitor.ts`) is a stub that throws `NotOnDeviceError`. The running app (`portal/runtimeBootstrap.ts`) mounts `MemoryStore`: nothing survives closing the tab. There is no IndexedDB or SQLite library in the repository. |
| Enrollment / signing | `device.enroll` + `device.activate`; a P-256 device key in the `Keystore`; batches signed IEEE-P1363 over a sorted-key canonical envelope. Reused unchanged. |
| Session | The signed-in user and acting organization (`CaptureScope`, as `BoardQueue` uses it). |
| Sync acknowledgements | Evidence packages return item verdicts; `eld.eventsAppend` already returns `inserted` / `replayed` / `conflict` per event and structured refusals. |
| Retry / backoff | None. `BoardQueue` resumes interrupted sends on start and stops a flush when the link fails. |
| Network state | `Connectivity.online()`, fed by `online`/`offline` window events in the browser. |
| `hos_event` | A `CaptureKind` and a sync priority. **Nothing in the client creates one.** |
| Duty-status UI | `showcase/TripOperationsWorkspace.tsx` calls `fieldRoute.dutyRecords.create` online — the legacy table `hos.status` reads. |
| Unit context | No trustworthy driver↔unit session. `assignedUnitId` exists only on dispatch roles and fuel cards. |
| Motion | No engine/ECM source. |

## 2. Event creation flow

`EldOutbox.recordDutyStatus({ status, actionKey, unitNumber?, gps?, annotation? })` → `record()`:

1. The observation time is read from the device clock **once**, before anything else.
2. Under the outbox's in-process lock: the enrolled `deviceRef` and the signed-in scope are required
   (no device or nobody signed in → refused, nothing stored).
3. If the `actionKey` already produced an event on this device, that event is returned — one UI action,
   one canonical identity, however often the handler runs (double tap, re-render, retried promise).
4. `eventRef` = UUID v4 from the platform (`crypto.randomUUID`), minted once.
5. The head (the device's committed event with the highest sequence) gives `deviceSequence = head + 1`
   (0 for the first) and `previousEventHash = head.eventHash` (null for the first).
6. The `EldEventInput` is built from the shared contract's fields only, validated with
   `validateEldEventShape`, and hashed with `canonicalEldEventJson` + `eldEventHashPreimage` (eld-h1).
7. `store.insertEvent` commits it. `sequence_taken` (another writer won) → re-read the head and retry
   with the same eventRef and observation time; `event_ref_taken` → refuse.

## 3. Sequence allocation and the atomic commit

There is no separate sequence counter. **The committed event is the sequence advance.** The store's one
correctness primitive is an atomic insert-if-absent keyed by `(deviceRef, deviceSequence)` and by
`eventRef`. Consequences:

* "Sequence advanced, event missing" cannot happen: a failed write leaves the head where it was, and the
  next event takes the same sequence with no gap (test 30).
* Two writers cannot share a sequence: the loser's insert answers `sequence_taken` (tests 5).
* The sequence survives restart, logout/login, offline periods and any delivery outcome, because it is
  read from committed events, never from time, randomness, array positions or server order.

**The missing primitive, reported rather than faked:** no durable store in this repository implements
`insertEvent`. `MemoryEldEventStore` implements the contract for tests and the browser fallback and is
honest about being memory. The tests prove the outbox over a serialized stand-in "disk" (the
`boardQueueDurable.test.ts` precedent); they do not prove a device store exists. The native binding must
implement `insertEvent` as one SQLite statement under `UNIQUE(deviceRef, deviceSequence)` and
`UNIQUE(eventRef)` (or IndexedDB `add()` on those keys). Follow-up F-10.

## 4. Hash chain

The predecessor is the last **committed** event on the device, delivered or not. Delivery is never a
prerequisite for linking. Events may reach the server in any order: event 1 arriving before event 0 is
accepted with `predecessor_missing`, and the link verifies when event 0 arrives (DB test).

`assessDeviceChain` moved, unchanged, from `server/_core/eld/ledger.ts` to `shared/eld/chain.ts` (the
server re-exports it) so the device judges its local chain with the server's own function:
`EldOutbox.integrity()` reports gaps, links, and **clock regressions** (`timingInconsistencies`: a later
sequence with an earlier device clock — recorded as observed, never reordered).

## 5. Immutable event, mutable delivery

| Record | Mutability | Content |
|---|---|---|
| `LocalEldEvent` | written once | `deviceRef`, the hashed `EldEventInput`, `payloadHash`, `eventHash`, `hashVersion`; plus two local-only fields never hashed or sent: `scope` (who recorded it, under which organization) and `actionKey` |
| `EldDelivery` | changes | `state`, `attempts`, `lastBatchRef`, `lastAttemptAt`, `outcome`, `code`, `reason`, `serverEventId`, `conflictRef`, `acknowledgedAt` |

A missing delivery record means `pending`, so an event committed just before a crash is pending, not
lost. Acknowledged events are kept (the device's local log); nothing is deleted.

| State | Meaning | Leaves by |
|---|---|---|
| `pending` | committed, not yet acknowledged | a flush |
| `in_flight` | in a batch whose answer has not arrived | the answer; or `hydrate()` after a crash → `pending` |
| `acknowledged` | the server holds it: `accepted` (new) or `idempotent` (already on record) | never |
| `conflict` | the server holds different content under this UUID or sequence | a person (not resent, not rewritten) |
| `rejected` | refused by the server, with its code | `requeue()` by a person after fixing the cause — same identity |
| `quarantined` | the stored record no longer hashes to what was committed | `requeue()` by a person |

## 6. Delivery, retry and acknowledgement

A flush takes the pending events of **this** device recorded in **this** session, in sequence order, at most
500, re-derives both hashes (a mismatch → quarantined, never sent), marks them `in_flight`, signs
`canonicalEldBatchText` (byte-identical to the server's `canonicalEldBatch` — tested), and calls
`eld.eventsAppend` with `deviceClockAt` so a device whose clock is off by under a day can still deliver.

| Server answer | Device state |
|---|---|
| `inserted` | `acknowledged`, outcome **accepted** |
| `replayed` | `acknowledged`, outcome **idempotent** |
| `conflict_event_ref` / `conflict_device_sequence` | `conflict`, with the server's `conflictRef`; the event is untouched |
| refusal naming events (`schema_invalid`, `declared_hash_mismatch`, `unit_unknown`, `unit_not_in_organization`, …) | those events `rejected`; the rest of the batch back to `pending` (nothing in a refused batch is written) and resent unchanged |
| refusal naming none (`operator_ambiguous`, `operator_unresolved`, `device_not_active`, `device_not_admitted`, `signature_invalid`, …) | every event in the batch `rejected` with that code |
| `signature_stale` | `pending` (a clock matter, not a judgment of the events), backed off |
| thrown tRPC refusal (`FORBIDDEN`, `BAD_REQUEST`, …) | `rejected`, code `server_<code>` |
| thrown transient (`UNAUTHORIZED`, `CONFLICT`, `TIMEOUT`, `5xx`) or no answer (network) | `pending`, backed off |

Retry is the same event: same UUID, sequence, predecessor, hash; only `batchRef` and `nonce` are new. A
lost acknowledgement is harmless — the resend comes back `replayed`. Backoff: 30 s, 1, 2, 4, 8 min, then
15 min, from an injected clock with no jitter (`eldRetryDelayMs`); being offline is not a failure, is not
counted, and makes no request. `hydrate()` returns interrupted `in_flight` sends to `pending` on start.

One server change: `appendEldEvents` now names the events a unit refusal is about (`problems`), so a
device can hold exactly those and resend the rest. Previously `unit_unknown` and
`unit_not_in_organization` named none.

## 7. Driver, organization and unit

* **Driver.** The device names no operator. The server resolves it from the enrolled device's user
  through `operators.userId`; two operator records for one user → `operator_ambiguous`, every event
  rejected and kept (DB test). A second operator with the same name in the same organization changes
  nothing (DB test). No name is read anywhere.
* **Organization.** The server takes it from `fieldDevices.orgRef` and requires the caller to be acting
  for it. An `orgRef` or `operatorId` written into an event is refused by the strict schema; an `orgRef`
  beside the batch is refused by the input schema; a device used while the user acts for another
  organization is `FORBIDDEN` (all DB tests). The device's local `scope` is never sent.
* **Session.** An event is sent only while the person who recorded it is signed in, under the same
  organization key; anyone else's session leaves it pending.
* **Unit.** `unitNumber` is accepted only from the caller, documented as needing an authoritative unit
  session; LeaseOS has none, so the default is null. The server resolves a stated number and refuses
  one it cannot place in the device's organization. Prerequisite: a driver↔unit session (F-11).

## 8. Duty statuses and driving

`recordDutyStatus` accepts OFF DUTY, SLEEPER BERTH and ON DUTY. DRIVING is refused: it is recorded
automatically from engine data, and LeaseOS has no engine/ECM source. No motion threshold is encoded and
no phone movement, GPS speed or timer is treated as driving. Prerequisite: an ECM/telematics integration
(F-12). `record()` remains available for other structural event types the contract defines.

## 9. Timestamps

`eventAtMs` is the device's observation time and is never replaced; the server stores its own
`receivedAt`. `eventUtcOffsetMinutes` is the device's offset at that instant. Tested: online; offline and
sent hours later; either side of midnight; across the 1 November 2026 fall-back (offsets −300 then −360,
sequence continuous); after restart; with the clock set back.

## 10. The old `hos_event` capture

Retired as a source of duty events: `Outbox.saveDraft` refuses `kind: "hos_event"` and points to
`EldOutbox.recordDutyStatus`. Nothing created one before, so no data changes. A driver action now has
exactly one canonical identity — the ELD event. The kind stays in the `CaptureKind` union and the sync
priority table so a package from an older client still syncs as sealed evidence; it is never interpreted.

## 11. Privacy

The event carries only the contract's fields: event type, duty status, origin, time and offset, an
optional unit number, location (when the caller passes a fix), jurisdiction, odometer/engine hours/speed
(none of which this checkpoint supplies), an optional driver annotation, and the chain. No profile,
certificate, payroll, job or personal data; a test pins the wire keys.

## 12. Limitations

* **No durable device store** (F-10): see §3. The browser fallback is memory, as for every other
  capture; the guarantee holds on a device only once the native binding implements `insertEvent`.
* **Not wired to the UI**: the duty-status button still calls `dutyRecords.create`, which `hos.status`
  and readiness read; switching it is a UI and dispatch decision outside this checkpoint (F-11).
* **No unit session** (F-11), **no ECM** (F-12).
* `actionKey` de-duplication is per device process plus the store; across processes it relies on the
  store's lock-free list, so two processes handling one tap could each commit (each with its own
  identity). A native binding should add `UNIQUE(deviceRef, actionKey)`.
* Events recorded under an older `deviceRef` (before a re-enrollment) are not sent by the new device
  key; they stay pending and visible.

## 13. Tests

`server/eldOutbox.test.ts` (32, pure, over the stand-in disk and a fake server built from the real
`canonicalEldBatch`, `verifyP256PackageSignature` and `prepareEldBatch`) and nine cases added to
`server/eldLedger.db.test.ts` against the real router and MariaDB. Mutation checks during development:
breaking the chain link fails 6 cases, declaring the wrong hash fails 14, treating a conflict as
acknowledged fails 2, and reverting the unit-refusal `problems` fails the DB case.

## 14. Gate

One authoritative run of `scripts/ci-gate.sh` against a freshly dropped and recreated database, Node
22.23.3 (tz 2026c), no other database-backed run overlapping it: **PASS**.

| Step | Result |
|---|---|
| Migrations from empty, 0170 verification | PASS |
| Typecheck | PASS |
| Procedure census, external and machine gates | PASS (819 role-authorized procedures; no new procedure in 2d) |
| Full test suite | PASS — 484 files, 7438 passed, 3 skipped (the three long-standing skips), 0 failed |
| — ELD suites inside it | `eldOutbox.test.ts` 32, `eldLedger.db.test.ts` 43, `eldDutyDay` 23, `eldHos` 24, `eldLedger` 24, `eldCanonicalVectors` 31: all passed |
| Fixture isolation | PASS — 4 files, 67 passed |
| Production build and production-only boot | PASS |
| Current-state document | current |

Exploratory runs before the gate (separate scratch database `leaseos_precheck`, since dropped): the DB
suite passed 43/43 and the pure suite 32/32 at their first full run; the mutation checks in §13 were
deliberate failures, reverted before the gate. No pre-existing failure was observed.
