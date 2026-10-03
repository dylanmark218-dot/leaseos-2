# SPINE item 3 — `offlineCapability` → HS1

The SPINE wiring plan's item 3 (`docs/register/SPINE_WIRING_PLAN.md`): *"`offlineCapability` → HS1.
It is the device seam and the hybrid plan already covers it."* The reconciliation of 2026-10-03
(`SPINE_RECONCILIATION_2026-10-03.md` §7) found it the earliest incomplete item and not unambiguous.
The owner ruled on the three open questions the same day; this record is what was built under those
rulings, on `main` at `60de8c2`.

## The rulings

1. **One offline policy, enforced on both sides.** The client needs it because, offline, there is no
   server to ask (UX and offline correctness). The server needs it because the client is not an
   authorization boundary (authority). One implementation, not two. The census's server-only walk
   does not decide where a cross-runtime policy lives.
2. **Keep `/showcase`, with no hardware bypass.** It is routed in production, so it obeys the same
   rules as everything else and goes through the runtime's own interface.
3. **Item 3 lands before PR #120 (HS5).** The later layer adapts to the frozen earlier contract.

## Four questions, kept apart

| Question | Answered by |
|---|---|
| What can this device physically do? | HS1 `capabilities()` — `client/src/runtime/capabilities.ts` |
| May this class of operation run or queue while disconnected? | `shared/offlinePolicy.ts` |
| May this person do it? | the server: authenticated actor → `resolveActingScope()` → `roleProcedure` permission |
| May the system do it unattended? | `automationPolicy.ts` |

None answers another's question. A device that can take a photograph has not been allowed to commit
anything, and an operation that may be queued offline has not been authorized.

## What was built

**HS1, exactly to the frozen contract** (`docs/hybrid-seam/HS_CONTRACTS.md` §1).
`CapabilityMatrix` has the six frozen booleans (`localStore`, `fileVault`, `keystore`, `camera`,
`location`, `network`) and `capabilities(): Promise<CapabilityMatrix>` aggregates the per-binding
`available()` probes in `adapters/capacitor.ts`. The camera and location bindings gained probe-only
entries in the existing pattern (`open` throws `NotOnDeviceError`). Only a probe answering exactly
`true` counts; a throwing probe reads unavailable without taking the others down; the matrix is
frozen. `network` means a network transport exists (`fetch`), not that a connection is up (that is
`Connectivity.online()`). No `CapabilityUnavailable` was introduced: `NotOnDeviceError` stays the one
name.

**The canonical policy moved to `shared/offlinePolicy.ts`**, the layer `driverWallet.ts` already
uses for code both runtimes run. `server/_core/offlineCapability.ts` is now an adapter: it re-exports
the shared policy with the gateway-bound `FieldCapability` type, and adds the two things only the
server can do (read an item's kind from the seal manifest it built; fold the policy into the sync
verdicts). `RiskLevel` moved to `shared/riskLevel.ts` and `actionGateway.ts` re-exports it, so there
is still one risk ladder. New in the shared policy: `FIELD_OPERATIONS`, one row per capture kind, and
two fail-closed entry points, `decideFieldOperation` (client) and `revalidatePackagedOperation`
(server).

**How field operations are classified.** Every capture kind is `local_capture` (an observation:
pre-trip, tickets, receipts, photos, defects, incidents, HOS events, TDG documents, roadside and OOS
*documents*, scans) or `local_prepare` (a draft someone else decides: `job_accept`, whose award is
`dispatch.award`'s; and the three board kinds, sent to their own procedure). Nothing a device does is
`server_authoritative`; an OOS *release* is not a field operation at all and is refused by being
absent. Anything not in the catalogue is refused, online or off, on the device and at the server.
`outbox.ts` holds a compile-time check that every `CaptureKind` has a row.

**Field-runtime consumer: `Outbox.queue()`** (`client/src/runtime/outbox.ts`), the gate every
capture passes to become `queued`, used by the routed board panel through `BoardQueue` and by the
sync runtime. It asks the shared policy with the capture's kind and the outbox's connectivity (none
known → treated as offline). A refused or unavailable operation throws `FieldOperationRefused` and the
draft stays `saved_locally`. The capture's own fields are never read for a class.

**Authoritative server consumer: `sync.receivePackage`** (`server/deviceRouter.ts`), where queued field
work becomes authoritative. After admission (device, user, revocation, key), acting scope (device
bound to the active organization) and the three-way hash checks, each item's kind is read from the
seal manifest the **server** built at seal time, and the same policy is applied. An item with no seal
or an unknown kind is rejected as a row with its reason (`syncReceipts.failureDetail`, "Refused by the
offline field policy: …"). The policy can only reject; it never promotes an item to verified, and it
never stands in for admission or scope, which run first. No package field — no class, no "allowed"
flag — is consulted; the package schema has none. The per-item state is stored as the existing
`mismatch` with `matched = false`: no enum change, no migration.

**Showcase.** `client/src/showcase/Home.tsx` no longer has a file input. It acquires files through
`BrowserFilePickerScanner`, a `DocumentScanner` adapter in `client/src/runtime/adapters/` — the
existing device interface for acquiring a page, with every quality signal null because a picker
measures nothing. `/showcase/*` is intentionally production-routable (no environment gate);
`ShowcaseFrame` refuses mutations client-side, which is UX only, and every procedure it calls is still
`roleProcedure`-gated on the server, so it has no special backend authority.

## Proof the client cannot grant authority

- The server reads the operation from its own seal, never from the package (`recordTypeOfSealManifest`).
- A capture written straight into the device queue past the outbox, with fields claiming
  `offlineClass: local_capture, offlineAllowed: true`, is refused at the server and kept as `failed`
  with the reason (`server/fieldRuntime.test.ts`).
- A policy-allowed photo pushed by someone the device is not enrolled to is refused at admission —
  offline eligibility never stands in for who may act (`server/fieldRuntime.test.ts`).
- An unsealed item is refused rather than verified (`server/fieldDevice.test.ts`).
- Mutation checks: removing the server's policy call fails 2 database tests; removing the outbox's
  fails 2 client tests.

## Tests

- `server/offlinePolicy.test.ts` (23): catalogue completeness and class/risk agreement; decisions;
  fail-closed revalidation; manifest reading; verdict folding; the outbox consumer; one implementation
  (the policy is defined only in `shared/offlinePolicy.ts`; the adapter holds no algorithm; client and
  server both import it; no client file imports the server engine).
- `server/hs1Capabilities.test.ts` (14): the frozen six keys; supported, unsupported, non-boolean and
  throwing probes; frozen result; determinism; no offline or authorization meaning; the hardware guard
  (no file input, geolocation or media call outside `client/src/runtime/adapters/`, non-vacuous);
  showcase routed and through the adapter.
- `server/fieldRuntime.test.ts` (+2 database cases) and `server/fieldDevice.test.ts` (fixtures now
  seal their uploads as a device does; +1 unsealed-refusal assertion).
- `server/offlineCapability.test.ts` unchanged and green against the adapter.

## Census

`offlineCapability` leaves `DECLARED_UNWIRED`: `sync.receivePackage` imports it, a real server route
(73 → 72 unwired). The shared policy is outside the server-only census by design; its two consumers
and its single implementation are pinned by `server/offlinePolicy.test.ts` instead. The
`boundaryConfirmation` reason, stale since `0179`, now says its reader exists and its missing caller
is item 4.

## Not done here

No migration; no change to the frozen HS1 contract; no item-4 work; no change to PR #120; nothing
ported to `leaseos`. `capabilities()` has no production consumer yet: no catalogue operation requires
a hardware capability at queue time (the bytes are already captured), and the first consumer arrives
with device-binding work. The open-branch migration collisions (0224, 0228, 0229, 0233) are recorded
in the reconciliation and left to the collision register.

## Next

SPINE item 4, the rest of the spine in path order — dispatch gate → routing → departure → capture →
stop timing → job close — starting with the dispatch gate (`jurisdiction`).
