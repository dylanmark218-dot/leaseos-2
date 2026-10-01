# SPINE item 3 — `offlineCapability` → HS1: the device runtime asks the engine

The SPINE wiring plan's item 3 (`docs/register/SPINE_WIRING_PLAN.md`): *"`offlineCapability` → HS1.
It is the device seam and the hybrid plan already covers it."* The census reason it carried until now
was *"offline capability classes for the field device; no device runtime calls them yet"*.

Checked against `main` at `b35bac4` (2026-10-01, CI run 663 green; items 1 and 2 complete).

## What was true before

- `server/_core/offlineCapability.ts` is pure, has 16 tests, and has no importer outside its test.
- The device runtime (`client/src/runtime/`: `Outbox`, `SyncEngine`) kept the engine's rule by habit
  and under its own words:
  - every package item is evidence;
  - `captureAuthorizationClaim` is "historical evidence, not server authorization";
  - `recordUpdates` is always empty.
- Nothing declared what each `CaptureKind` is. The portal's quick capture handed the outbox
  `a.kind as never`, so a kind outside `CaptureKind` would have been saved and synced.
- HS1 (`docs/hybrid-seam/HS0_RECONNAISSANCE.md` re-spec) was three things, none of them started:
  - (a) a `capabilities()` matrix;
  - (b) a guard proving no direct hardware call site outside the adapter;
  - (c) a decision on the one call site HS0 found, `client/src/showcase/Home.tsx:1810`.

## What changed

### The engine is called by the device runtime

`client/src/runtime/offlinePolicy.ts` declares every `CaptureKind` as a `FieldCapability`
(`CAPTURE_CAPABILITIES`):

- **All eighteen are `local_capture` / `low_risk_action`.** Recording an out-of-service order releases
  nothing. A job acceptance is the worker's statement; the assignment stays the server's. A defect is an
  observation; whether the unit may run is the server's. No capture kind today is a server decision.
- **Each names `evidence.upload`**, the permission the server checks when the evidence arrives.
- **It is exhaustive by type** (`{ [K in CaptureKind]: FieldCapability }`). A new kind without a
  declaration does not compile.

The runtime asks the engine at three points:

| Where | Engine call | Refuses |
|---|---|---|
| `Outbox.saveDraft` | `captureCapability` | an undeclared kind, before the vault or the store is touched |
| `Outbox.queue` | `offlineOutcome(…, { online: false, draftable: false })` via `assertQueueable` | a server-authoritative kind (`DeviceAuthorityRefused`). Queuing is judged as offline whatever the signal, because the queue *is* the offline path. |
| `SyncEngine.syncOnce`, before upload | `envelopeFor` via `captureEnvelope` | a server-authoritative kind that reached the queue: marked `failed` with the engine's reason, retained, nothing uploaded |

With the shipped declarations none of these refuses anything a worker does today. Behaviour is
unchanged, and the refusals are proven with a policy that marks `oos_order` server-authoritative.
The policy is injectable (`Outbox`'s fourth argument, `SyncEngine`'s `deps.policy`) for that reason
only.

`QuickCaptureAction.kind` is now `CaptureKind`, and the `as never` in `runtimeBootstrap.ts` is
gone.

The engine is shipped to the client. It imports nothing but types (`import type` from
`actionGateway`), and a test pins that, so the bundle carries no server code.

### HS1

- **(a) `client/src/runtime/capabilities.ts`.** It provides `CapabilityMatrix` exactly as frozen in
  `HS_CONTRACTS.md` §1, plus `capabilities(probes)` and `nativeProbes(connectivity)`.
  - **One deliberate change to the frozen signature:** it takes its probes. The network entry has to
    be the runtime's own `Connectivity`, the flag the sync engine obeys. A browser global would let
    the matrix and the engine disagree about whether the device is online.
  - A probe that throws, or answers anything but `true`, is `false`.
  - New available-only probes: `capacitorCamera()` and `capacitorGeolocation()`. No camera or GPS
    interface exists in `contracts.ts`, so these open nothing.
  - `NotOnDeviceError` stays the one error name.
- **(b) `server/deviceHardwareBoundary.test.ts`.** It scans every non-test source under `client/src`,
  except `runtime/adapters/`, for direct hardware access: `navigator.geolocation`,
  `navigator.mediaDevices`, `getUserMedia`, `type="file"`, `capture=`, and `@capacitor` imports.
- **(c) The showcase is not deleted.** HS0 called `client/src/showcase/` unrouted and proposed
  deleting it. It is routed (`/showcase` in `client/src/App.tsx`). Its file picker is the guard's
  one named exception, pinned at exactly one. The exception fails if the count grows, and also if the
  call site is removed without removing the exception. **Owner decision owed:** should that demo
  route capture through the outbox, or keep the picker?

### The census

`server/engineReachability.test.ts` now treats `client/src/runtime/` as an application root, beside
the routers.

- **Only value imports of `server/_core` count.** An `import type` erases at compile time, and the
  runtime's sibling imports are client modules, not engines.
- `offlineCapability` leaves `DECLARED_UNWIRED`, and the unwired pin goes 73 → 72.
- `server/spineWiringPlan.test.ts` counts the same root, so the plan's spine engines stay accounted
  for.

**Reached is not running.** In this repository nothing mounts the device runtime in the browser:
`mountBrowserFallbackRuntime` has no caller, and the production client bundle contains no outbox
code. The native shell that mounts it on a device is not in the tree. What this item proves is that
the code which runs on the truck calls the engine. It does not prove that a truck runs it.

## Tests

- `server/offlineCapabilityRuntime.test.ts` (13 tests):
  - the declarations: all eighteen kinds, keys, no disagreement, no server-authoritative kind, the
    permission named;
  - outbox refusals: an undeclared kind leaves the store and vault empty, and a server-authoritative
    kind stays `saved_locally`;
  - every shipped kind queues;
  - the sync engine fails a server-authoritative capture with no transport call and retains it;
  - the envelope is evidence with no device verdict;
  - the engine imports only types.
- `server/deviceHardwareBoundary.test.ts` (5 tests): the hardware guard, the exception's reason, and
  `capabilities()` for pass-through, a throwing or non-boolean probe, and no native shell with network
  following the runtime's flag.
- **Mutations.** Each of these fails exactly one test:
  - removing `assertQueueable` from `Outbox.queue`;
  - removing `captureEnvelope` from `syncOnce`;
  - removing `captureCapability` from `saveDraft`.
- **Gates run locally:**
  - `tsc --noEmit` is clean on both configs, and the test-file ratchet is at 0;
  - `pnpm build` passes;
  - `LEASEOS_CURRENT_STATE.md` was regenerated (443 test files);
  - in the full Vitest run, the only failures are 19 database suites (no `DATABASE_URL` here) and three
    suites that fail identically on unmodified `main` in this container
    (`fieldroute.test.ts`, `canadianTransportProviders.test.ts`, `transportDateContract.test.ts`;
    the last two need tzdata 2026c, and this Node has 2025c).

## Not done here

- **No server-side change.** `deviceRouter.ts` (`sync.receivePackage`) already treats every item as
  evidence. The server ledger is HS3, not item 3.
- **`freshnessOf` / `actionable` are not called yet.** Their consumer is the pre-departure cache
  (`preDepartureCache`, departure), which is SPINE item 4.
- **HS2–HS5 are untouched.**

## Next on the SPINE

Item 4, the rest of the spine in path order: dispatch gate → routing → departure → capture →
stop timing → job close.
