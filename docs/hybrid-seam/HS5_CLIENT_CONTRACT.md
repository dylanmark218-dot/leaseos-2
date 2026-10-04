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
- `hold` — session not confirmed (server unreachable, sign-in needed, or several organizations
  and none chosen): keep capturing locally, upload nothing until confirmed.
- `revoked` — stop uploading and stop showing cached records; keep the unsent queue sealed for an
  administrator. Offline availability is never permission, and never bypasses dispatch gates.

**The handshake already exists.** It is `session.context` (`server/sessionRouter.ts`); HS5 adds no
second one. `observeSession(context)` maps its states: `ready` / `no_workspace` → confirmed;
`organization_required` → unconfirmed, choose an organization; `unauthenticated` → unconfirmed, sign
in; `no_membership` → revoked. A test ties its input type to the server's `SessionContext`, so a
drift fails to compile.

**Wired into `SyncEngine`** through an optional `session` dependency. Before a pass sends anything,
it asks. The first confirmed session binds the queue (`boundScope()`); from then on only that
person, in that company, can hand it over. Any other sign-in gets `scope: "switch"`, and the queue
waits for its owner. The shell opens a separate store for the new sign-in under `localNamespace`. It
asks only when something is queued.

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
| device-side error (vault, missing native binding) | `failed` — retained with reason |

No disposition deletes local work or resends under another identity or company.

`classifySendFailure(e)` turns what a shell actually catches (a tRPC client error, the gate's 426,
a fetch/Node network error) into one of these. Anything it cannot place is `local`, so it fails
visibly instead of retrying forever.

**Wired into `SyncEngine`** (`client/src/runtime/syncEngine.ts`):

- The first device-wide failure (`retry`, `reauth`, `upgrade`) stops the pass. The capture goes back
  to `queued`, and so does every capture already prepared, keeping its server id and seal so the
  retry is idempotent.
- `retry`: a package is still attempted for what was prepared. The engine then records
  `syncNotBefore`, and automatic passes wait until then. `syncOnce({ force: true })` (reconnect,
  "Sync now") skips the wait. A pass the server answers resets the back-off.
- `reauth` / `upgrade`: the queue is held (`hold()`) and no package is sent. Not even a forced pass
  sends until `clearHold()` runs after sign-in or update.
- A failed package send is classified the same way. `syncOnce` no longer throws on it.

## Known gaps (not closed by HS5)

- **macOS enrolment.** `fieldDevices.platform` (schema + `device.enroll`) has no `macos`; a Mac
  enrols as `other` via `enrolmentPlatform()`, which reports `exact: false`. Closing it needs a
  migration.
- **Headers are not sent yet.** No installed shell exists; `clientContractHeaders()` is the helper
  the Tauri and Capacitor builds must add to the tRPC link. The website correctly sends none.
- **Upload receipts carry no hash yet.** `fieldRoute.evidence.upload` returns `{ id, key,
  alreadyUploaded }`, so `checkUploadReceipt` has nothing to compare against at upload time. The
  hash is still verified end to end: the server recomputes it at package time and rejects a
  mismatch per item. Returning the stored hash from the upload is a server change.
- **Nothing calls `clearHold()` yet.** The sign-in and app-update flows of the installed shells
  must call it. Until they exist, a held browser runtime clears when the page reloads (memory store).
- **Record versions are a rule, not yet a column** on every editable table; server procedures
  adopt `classifyVersionedWrite` per record type.
- **No shell passes `session` yet.** `mountBrowserFallbackRuntime(transport, session)` accepts it,
  but nothing mounts that runtime today. Each installed shell must pass
  `() => observeSession(await session.context())`.
- **The queue is bound at the first confirmed send, not at capture.** Captures queued on a device
  that has never confirmed a session go to whoever confirms first. Binding at capture time needs
  the outbox to know the session, which is a shell concern. Until the shells do that, they should
  confirm the session before allowing a capture.
