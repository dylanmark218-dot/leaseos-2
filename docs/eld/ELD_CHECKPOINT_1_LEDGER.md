# ELD Checkpoint 1 — the canonical event ledger (migration 0220, originally 0170)

**Branch:** `claude/eld-compliance-intelligence-ramlrd`. **Design:** `ELD_COMPLIANCE_INTELLIGENCE_DESIGN.md` (commit `ab87f5f`).
**Scope of this checkpoint:** trustworthy ELD event capture and nothing after it. No HOS mechanics, no
diagnostics tables, no compliance findings, no dispatch, no analytics, no UI. `server/_core/hos.ts`,
`readinessComposer.ts` and `dispatchReadiness.ts` are untouched.

## 1. Migration number

Written as `0170_eld_event_ledger.sql`: at implementation time the highest migration on both this branch
and `origin/main` was `0169_defect_resolution.sql`. Main then merged the dispatch role model, which owns
0170, 0171 and 0174, and open branches claim 0172–0178 (see `docs/architecture/MIGRATION_COLLISION_REGISTER.md`
on main). Under the register's rule the merged branch keeps its number and every other claimant takes the
first number free everywhere, so the hardening checkpoint renumbered this file to `0179_eld_event_ledger.sql`
with no other change. On 2026-09-24 PR #17 merged `0179_trip_stop_provenance.sql` to main, and the file
moved again, to `0187_eld_event_ledger.sql`. On 2026-10-01 the training-academy branch held 0187 and
claims reached 0219, so it moved a final time to **`0220_eld_event_ledger.sql`**. The register records
every number and why.
The migration is a single file: two tables, indexes, and four single-statement triggers (the 0061/0062
form, so the runner needs no `DELIMITER` handling).

## 2. The design correction: two ledgers, not one weakened one

The design asked for global UUID idempotency, `(device, sequence)` idempotency, harmless replay, and
preservation of a duplicate that carries *different* content. Those cannot all live on one table with
unique keys, so:

| Table | Holds | Uniqueness |
|---|---|---|
| `eldEvents` | exactly one canonical accepted event per identity | `eventRef` UNIQUE; `(fieldDeviceId, deviceSequence)` UNIQUE |
| `eldEventIngestConflicts` | every attempt that collided with a canonical row while carrying different content | `conflictRef` UNIQUE; `(canonicalEventId, attemptedEventHash)` UNIQUE, so the same conflicting copy re-sent is recorded once |

The conflict row keeps the attempt whole: the attempted canonical JSON, both of its hashes, the
predecessor hash it claimed, the collision kind, which canonical row it hit and that row's hashes,
the device, the organization, who submitted it and when. The canonical row is never touched. Both
tables are immutable at the database (§6).

The name `eldEventIngestConflicts` was kept: the repository already has `syncConflicts` for
record-version conflicts, and "ingest conflict" says which boundary this one belongs to.

## 3. Device infrastructure: reused, not duplicated

An ELD-capable device in this checkpoint **is** a `fieldDevices` row. Nothing was added to it.

- Identity: `device.enroll` / `device.activate` (0035/0110) as today; the ledger stores `fieldDeviceId`.
- Transport: `eld.eventsAppend` uses the same discipline as `sync.receivePackage` — P-256 signature
  over a canonical batch (`canonicalEldBatch`, the same sorted-key form as `canonicalDevicePackage`),
  single-use nonce in `deviceSyncNonces` (with `packageRef` = the batch ref), freshness by the device's
  clock (`signatureFreshness`), and `admitPackage` for status, key history and user binding.
- Tenant: `fieldDevices.orgRef` is the batch's organization; the caller's acting scope must match it.

No new device-authentication mechanism exists. The design's `eldDevices` registry (for third-party
providers and hardware ELDs) is deferred until an integration path is built; `eldEvents.fieldDeviceId`
is nullable and `sourceKind` names the source so that path can be added without a schema change to
the ledger.

## 4. The canonical event

`shared/eld/eldEvent.ts` defines the contract for both sides. The ledger row (`eldEvents`):

identity `eventRef` (device-minted UUID v4), `fieldDeviceId`, `deviceSequence` · resolved
`orgRef` (NOT NULL), `operatorId`, `unitId` · content `eventType`, `eventCode`, `dutyStatus`,
`recordOrigin`, `eventAt` + `eventUtcOffsetMinutes` (the device's clock, kept even if wrong),
location, `jurisdiction` (claim), `odometerKm`, `engineHours`, `vehicleSpeedKph`, `annotation`,
`supersedesEventRef` · provenance `sourceKind`, `sourceRef`, `submittedByUserId`, `receivedAt` ·
integrity `canonicalJson`, `payloadHash`, `previousEventHash`, `eventHash`, `hashVersion`.

**Not on the row, by design:** anything a later process would update — no active flag, no review
state, no hours remaining, no verdict. "Active" is derived: an event is active while no correction
names it in `supersedesEventRef`.

`eventType` is a varchar validated in code (an extensible structural vocabulary), not a database enum,
so a new type is a contract change rather than a migration. The structural rules encoded are only:
a `duty_status_change` carries a duty status and nothing else does; a `correction` carries
`supersedesEventRef` and nothing else does; an event cannot supersede itself; a device may only
originate `automatic` or `driver` records. No timing, threshold or interval constant exists anywhere
in this checkpoint.

## 5. Identity and tenancy

- The organization is the enrolled device's. The router input is `.strict()` and the event schema is
  `.strict()`, so a client that sends `orgRef`, `operatorId`, `operatorName`, `operatorRef`, `driver`
  or `fieldDeviceId` is refused (batch refused whole, nothing written), not ignored.
- The operator is `operators.userId = fieldDevices.userId`, then `recordBelongsToOrganization(org,
  "operator", id)`. Two operator rows for one user is a refusal (`operator_ambiguous`), not a guess.
  A duty-status event from a user with no operator record is refused (`operator_unresolved`); a
  non-duty observation (engine power, motion) is recorded with `operatorId = NULL`.
- A stated `unitNumber` (a stable, device-visible identifier; the hardening checkpoint replaced the
  database id) must name a unit that exists and is owned by the device's organization (`unit_unknown`,
  `unit_not_in_organization`).
- The legacy `eld_duty_status` integration feed, which matches `operators.name`, is left as it is and
  is not connected to the ledger. The ledger has no path that reads a name.

## 6. Append-only enforcement

Four triggers in the ledger migration, all `SIGNAL SQLSTATE '45000'`:
`eldEvents_immutable_update`, `eldEvents_immutable_delete`, `eldEventIngestConflicts_immutable_update`,
`eldEventIngestConflicts_immutable_delete`. The store is the only writer and only inserts. A
correction is represented today as a `correction` event with `supersedesEventRef`; the accept/reject
workflow, driver acceptance and recertification are not built.

## 7. Hashing and canonicalization (`eld-h1`) — SUPERSEDED by the hardening checkpoint

> The definition below was Checkpoint 1's and depended on JavaScript's `JSON.stringify`. The hardening
> checkpoint (`ELD_CHECKPOINT_1A_HARDENING.md`) redefined `eld-h1` as an implementation-independent
> canonical form before any row existed outside test databases; the current specification is
> `ELD_CANONICAL_FORM.md`. What follows is kept as history.

Existing primitives were inspected: `evidenceSeal.canonicalManifest` (explicitly ordered object,
`JSON.stringify`), `deviceSignature.canonical` (sorted keys, for signatures), `auditPackage.canonicalJson`
(sorted keys, Dates as ISO), `client/src/runtime/crypto.canonicalJson` (sorted keys, WebCrypto
SHA-256). The event hash follows the **explicitly ordered** form of `canonicalManifest` so a reader
can see exactly what participates; the batch signature follows the sorted-key form of
`canonicalDevicePackage` because it signs arbitrary submitted objects.

| | |
|---|---|
| Algorithm | SHA-256, lowercase hex (node:crypto on the server; WebCrypto on a device) |
| Canonical representation | `JSON.stringify(canonicalEldEvent(deviceRef, event))`: explicit key order, every participating field present (`null` when absent), `eventAt` normalized to UTC ISO-8601 with milliseconds |
| Participating fields, in order | `hashVersion`, `deviceRef`, `eventRef`, `deviceSequence`, `eventType`, `eventCode`, `dutyStatus`, `recordOrigin`, `eventAt`, `eventUtcOffsetMinutes`, `unitId`, `latitude`, `longitude`, `locationAccuracyM`, `locationSource`, `jurisdiction`, `odometerKm`, `engineHours`, `vehicleSpeedKph`, `annotation`, `supersedesEventRef` |
| Excluded on purpose | row id, `orgRef`, `operatorId`, `receivedAt`, `sourceRef`, `submittedByUserId` — server-assigned, so a device can recompute both hashes from its own store |
| `payloadHash` | SHA-256(canonicalJson) |
| `eventHash` | SHA-256(`"eld-h1\n" + (previousEventHash ?? "") + "\n" + payloadHash`) |
| `previousEventHash` | the device's claim: the `eventHash` of its previous event (sequence − 1), null for its first event. Per device, not per operator |
| `declaredEventHash` | optional; when present and different from what the bytes hash to, the batch is refused (`declared_hash_mismatch`) |
| Version | `hashVersion` stored on every row and every conflict row; a future `eld-h2` coexists |

Known limit: both sides are JavaScript today. A non-JS device must reproduce `JSON.stringify`'s
number and string formatting exactly; this is documented in the contract file and is a reason to keep
`declaredEventHash` in the protocol.

## 8. Offline and out-of-order delivery

The store accepts any well-formed event whose identity is free, regardless of whether its
predecessor has arrived. `assessDeviceChain` (pure) reports, per device: sequence gaps (inclusive
ranges), verified links, unverifiable links (predecessor not yet on record), chain mismatches (the
device's claim differs from the predecessor's stored hash), a first event that claims a predecessor,
and device-clock regressions against the sequence. It is returned with every accepted batch and by
`eld.deviceIntegrity`. Nothing is stored for it and nothing is filled in: when the missing
predecessor arrives, the same function turns the unverifiable link into a verified one or a
mismatch, with no row rewritten.

## 9. Idempotency semantics (all tested against MariaDB)

| Case | Result |
|---|---|
| exact UUID replay | no second row; `replayed` with the existing row id and hash |
| UUID collision, different content | canonical row byte-identical before and after; conflict row (`event_ref`); `conflict_event_ref` returned with the conflict ref |
| exact (device, sequence) replay in a later delivery | `replayed`; one row for that sequence |
| (device, sequence) collision, different content | canonical row unchanged; conflict row (`device_sequence`); the same copy re-sent returns the same conflict ref and no second row |

The store never prefers the most recently received copy. A concurrent duplicate-key race is handled
by re-reading and classifying against what the other writer committed.

## 10. The ingest service

`appendEldEvents(db, { device, claimedUserId, events, receivedAt, sourceRef?, withinTransaction? })`
in `server/_core/eld/eldLedgerStore.ts` is the only writer. In order: device/user binding, organization
present, status active → batch validated and hashed whole (`prepareEldBatch`) → **one transaction**:
operator resolution and ownership, unit ownership, per-event lock-classify-insert, conflict rows,
`withinTransaction` hook, chain assessment. Refusals are returned with a reason code and the offending
events; only infrastructure errors throw. `withinTransaction` is the extension point for a later
outbox emission and is what the atomicity test uses to prove a failure after the writes leaves no
canonical or conflict row.

Reason codes: `inserted`, `replayed`, `conflict_event_ref`, `conflict_device_sequence`,
`schema_invalid`, `batch_internal_duplicate`, `declared_hash_mismatch`, `device_unknown`,
`device_not_active`, `device_no_organization`, `device_not_callers`, `operator_unresolved`,
`operator_ambiguous`, `operator_not_in_organization`, `unit_unknown`, `unit_not_in_organization`;
transport: `device_unknown`, `device_no_organization`, `device_legacy_key`, `signature_stale`,
`signature_invalid`, `device_not_admitted`.

## 11. The existing `hos_event` capture path — NOT connected, and why

A projector from verified `hos_event` sync items into `appendEldEvents` was evaluated against the five
conditions. Three hold (authenticated device identity via `sync.receivePackage`; tenant from
`fieldDevices.orgRef`; no name matching would be needed). Two do not:

1. **Event identity is not deterministic in the required sense.** A `LocalCapture.localId` is
   `Date.now().toString(36)` plus a random suffix (`client/src/runtime/outbox.ts:13`), not a UUID, and
   no capture carries a device-local sequence. The ledger's `(device, sequence)` identity and the
   per-device chain cannot be derived from a capture without inventing a sequence.
2. **The capture has no defined meaning.** No client code constructs an `hos_event` capture; the
   `fields` of one are an untyped `Record<string, unknown>` with no schema. Turning it into a
   `duty_status_change` would require deciding what its fields mean, which is inventing regulatory
   meaning from an undefined form.

The prerequisite is a device-side ELD outbox that mints `eventRef` as a UUID, keeps a durable
per-device `deviceSequence`, computes `eld-h1` hashes against `shared/eld/eldEvent.ts`, and pushes
through `eld.eventsAppend`. That is client-runtime work and is not in this checkpoint. The existing
`hos_event` evidence path remains exactly as it was: sealed evidence, never interpreted.

## 12. Legacy `dutyRecords` — left intact; the later backfill plan

Nothing in this checkpoint reads, writes, alters or copies `dutyRecords`. Both of its writers
(`fieldRoute.dutyRecords.create`, the `eld_duty_status` feed) still write it. A later backfill would:

- **orgRef**: resolve through `coreRecordOwnership` for `("operator", dutyRecords.operatorId)`; an
  operator with no ownership row maps to the single-tenant `"default"` organization, exactly as
  `recordBelongsToOrganization` treats it today. Never inferred from the `source` string.
- **operator identity**: `dutyRecords.operatorId` as it stands. Rows whose operator no longer exists
  are backfilled with `operatorId = NULL` and the original id kept in `sourceRef`.
- **vehicle identity**: from `trips.unitId` through `dutyRecords.tripId` when present; otherwise
  `unitId = NULL`. Never from `source` text.
- **marked as legacy**: `recordOrigin = 'legacy'`, `sourceKind = 'migration'`, `sourceRef =
  'dutyRecords:<id>'`, `fieldDeviceId = NULL`, `deviceSequence = NULL`, `previousEventHash = NULL`.
  With no device there is no chain, and `assessDeviceChain` is never run over migration rows.
- **must remain unknown**: device identity, sequence, predecessor hash, `eventUtcOffsetMinutes`,
  `locationAccuracyM`, `locationSource` (the row has coordinates with no stated source → `NULL`, not
  `gps`), `engineHours`, `odometerKm`, `vehicleSpeedKph`. `receivedAt` = `dutyRecords.createdAt`,
  which is the closest fact on record and is labelled as such in `sourceRef`.
- **deterministic UUIDs**: UUID v5-style derivation from a fixed namespace and
  `dutyRecords:<id>:start` (and `:end` for the closing marker of a row with `endedAt`), so the same
  row always yields the same `eventRef` and a re-run is a replay, not a second insert.
- **idempotent**: the `eventRef` UNIQUE constraint makes a re-run classify as `replayed`; the
  migration is written as insert-or-recognize and records its own run in `schemaMigrations` like
  every other migration.
- **never device-originated certified ELD events**: `recordOrigin = 'legacy'` and `sourceKind =
  'migration'` are the only values a backfill may write; the engine and every reader treat those rows
  as a lower trust tier, and no `hashVersion` chain exists for them. A later "certified ELD" label (a
  `fieldDevices` row plus a verified technical-standard profile) can never attach to a row whose
  `fieldDeviceId` is NULL.

## 13. What was deliberately not encoded

- Any HOS figure, any duty-day mechanic, any motion threshold, any intermediate-location interval,
  any diagnostic/malfunction code list, any personal-conveyance or yard-move meaning, any
  certification rule. Every seeded HOS profile remains unverified and untouched.
- Whether Canadian ELD Technical Standard 1.3.1 exists or is in force (unverified; see the design
  §18). No technical-standard profile table was created in this checkpoint.
