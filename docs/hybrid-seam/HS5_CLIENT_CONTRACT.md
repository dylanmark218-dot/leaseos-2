# HS5 — the shared client contract

Source: `shared/clientContract.ts` (pure, imported by server and every shell).
Enforced: `server/_core/clientContractGate.ts`, mounted in front of `/api/trpc`.
Pinned: `server/clientContract.test.ts`.

LeaseOS ships as one backend and six clients — website (browser), Windows / macOS / Linux
(Tauri), Android / iOS (Capacitor). Installs are not upgraded in lockstep. This contract is what
lets the current website, a new Windows build and an Android install from last quarter use the
same API safely.

## What already existed and is not restated

| Concern | Where it lives |
|---|---|
| Sync states (`saved_locally`, `queued`, `syncing`, `synchronized`, `failed`, `conflict`) | `client/src/runtime/contracts.ts` — "saved on this device" and "synced to the office" are separate states |
| Capture envelope, package, seal and package receipt | `LocalCapture`, `LocalPackage`, `Transport` in the same file |
| Which company a request acts for | `server/_core/actingScope.ts` — decided by the server, never read from input |
| Idempotent upload reference | `SyncEngine` sends `clientCaptureRef = deviceRef:localId` |

## What HS5 adds

### 1. Contract version and headers

| Header | Direction | Value |
|---|---|---|
| `x-leaseos-contract` | request | `<major>.<minor>` — e.g. `1.0` |
| `x-leaseos-client` | request | `<platform>/<shell>/<appVersion>` — e.g. `android/capacitor/1.4.2` |
| `x-leaseos-contract-supported` | response (always) | `<minMajor>-<maxMajor>.<maxMinor>[;drain=<majors>]` |

`major` changes when an older client would misread a response or send something the server can
no longer apply. `minor` is additive only; clients ignore unknown fields.

| Declared | Outcome | Access |
|---|---|---|
| no header (the website) | `unversioned` | full |
| current major | `compatible` | full |
| same major, newer minor | `compatible_older_server` | full — client must not rely on the newer minor |
| retired major listed in `drainOnlyMajors` | `drain_then_upgrade` | only `DRAIN_PROCEDURES` |
| retired major, not drainable | `client_upgrade_required` | refused, 426 |
| future major | `server_upgrade_required` | refused, 426 |
| garbled, or contract without a valid client identity | `malformed` / `malformed_client` | refused, 426 |

**Drain-only is how an old install upgrades without losing offline work**: it may still call
`fieldRoute.evidence.upload`, `records.evidence.seal` and `sync.receivePackage` (plus `auth.me` /
`auth.logout`), and nothing that reads or starts new work. When a major is retired, list it in
`drainOnlyMajors` for a release cycle before removing it.

The gate is a compatibility control, not authorization. Everything it lets through still goes
through authentication and permissions.

### 2. Company scope

The client never sends a company. It receives `SessionScope { userRef, tenantId, derivedFrom }`
and stores cached records and queued work under `localNamespace(scope)`.
`scopeTransition(cached, current)` decides what happens on sign-in / reconnect:

- `keep` — same user and company.
- `switch` — different user or company: new namespace; the old queue is held for its owner and
  never uploaded under the new session.
- `hold` — server unreachable: keep capturing locally, upload nothing until confirmed.
- `revoked` — stop uploading and stop showing cached records; keep the unsent queue sealed for an
  administrator. Offline availability is never permission, and never bypasses dispatch gates.

### 3. Record versions

Editable records carry a server version that increments per accepted write. A write names its
`baseVersion` (as `recordUpdates` already does). `classifyVersionedWrite`:
equal → `apply`; lower → `conflict` (both retained, a person decides); record gone → `missing`;
higher or non-integer → `invalid`.

### 4. Upload receipts

`UploadReceipt { clientCaptureRef, serverId, alreadyUploaded, contentHash }`. A device marks a
capture uploaded only when `checkUploadReceipt` confirms the reference and SHA-256 both match. A
duplicate is a success; a mismatch is `failed` and the local copy is retained.

### 5. Offline queue behaviour

| Failure | Disposition |
|---|---|
| network, 502/503/504, 429 | `retry` with `retryDelayMs` (step doubles from 2 s, cap 15 min, jittered) |
| 401 | `reauth` — hold the queue until sign-in |
| 426 | `upgrade` — hold the queue; drain if allowed |
| lost versioned write | `needs_person` → `conflict` |
| 403, 400/422, hash mismatch, 404 | `failed` — retained with reason |

No disposition deletes local work or resends under another identity or company.

## Known gaps (not closed by HS5)

- **macOS enrolment.** `fieldDevices.platform` (schema + `device.enroll`) has no `macos`; a Mac
  enrols as `other` via `enrolmentPlatform()`, which reports `exact: false`. Closing it needs a
  migration.
- **Headers are not sent yet.** No installed shell exists; `clientContractHeaders()` is the helper
  the Tauri and Capacitor builds must add to the tRPC link. The website correctly sends none.
- **`SyncEngine` does not yet call `checkUploadReceipt`, `queueDisposition` or `retryDelayMs`**; it
  keeps its current retry-by-next-sync behaviour. Wiring it is the next step, with the outbox
  honouring `reauth` / `upgrade` holds.
- **Record versions are a rule, not yet a column** on every editable table; server procedures
  adopt `classifyVersionedWrite` per record type.
- **Session scope handshake** (`SessionScope` returned to the client) is typed, not yet a procedure.
