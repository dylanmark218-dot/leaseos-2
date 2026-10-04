# SPINE item 3 — `offlineCapability` → HS1, under the owner's ruling (2026-10-03)

The SPINE wiring plan's item 3 reads "`offlineCapability` → HS1. It is the device seam and the hybrid
plan already covers it." The survey (`SPINE_RECONCILIATION_2026-10-03.md` §7) found that HS1, as the
repository defines it, is a **hardware** seam (`docs/hybrid-seam/HS_CONTRACTS.md` §1,
`HS0_RECONNAISSANCE.md:184–189`). `offlineCapability` answered a different question, and wiring it
as-is would have widened what a device may do.

**The owner's ruling:** keep three questions apart.

| Question | Answered by | It can… |
|---|---|---|
| CAN the device do this physically? | HS1: `shared/hardwareCapability.ts` (`CapabilityMatrix`, `missingHardware`), probed by `client/src/runtime/capabilities.ts` `capabilities()` | only narrow availability |
| MAY this run without the server? | `requiresOnline` on `CapabilityDefinition`, read only through `actionGateway.mayRunWithoutServer` | decide offline policy, once |
| MAY this person do it? | the server, on reconnect: session → acting scope → permission → domain validation | decide authority |

Hardware can narrow availability. It never grants authority. Being online satisfies connectivity
and nothing else.

## Before and after

**`offlineCapability` before:**
- `offlineOutcome(FieldCapability, {online, draftable})` returned `execute_locally` for **every** capability whenever `online` was true, including server-authoritative ones such as an out-of-service release.
- Offline, it decided from a **declared** `offlineClass`, which sat beside `requiresOnline` as a second answer to one question, and the class won: a capability declared `local_capture` with `requiresOnline: true` captured locally.
- It had no notion of hardware.
- Its header claimed "a test fails if one side moves alone"; no such test existed.

These were characterized by tests before the change. The characterization file was removed with the function it described, and the defect is re-planted below.

**`offlineCapability` after.** It composes availability and decides no authority.
- `offlineClassOf(def)` derives the class from `requiresOnline` (through `mayRunWithoutServer`) and the gateway risk:
  - server work → `server_authoritative`;
  - `read` → `local_safe`;
  - `prepare` → `local_prepare`;
  - `low_risk_action` → `local_capture`;
  - `approval_required` or `restricted` declared runnable without the server → `ClassRiskMismatch`, a refusal and never a class.
- The switch is exhaustive over `RiskLevel`, so a new risk level fails the typecheck until someone decides what it means offline. The header's claim is now true.
- `runtimeAvailability(op, {hardware, online})` works in this order:
  1. **Hardware first.** Missing hardware gives `unavailable / hardware_missing` with the missing names, online or not.
  2. **Then the class:**
     - local reads → `execute_locally`;
     - captures → `capture_locally`;
     - drafts → `prepare_and_queue / local_draft`;
     - server work → `prepare_and_queue / server_decides` when online or draftable, otherwise `unavailable / server_required_offline`.

  Server work is **never** `execute_locally` or `capture_locally`.
- The four outcome names are the module's existing ones. `reason` keeps a missing camera apart from a server-only act. No result carries a permission, a scope or a claim.
- `offlineClass` survives only as a **derived, descriptive** value, still carried on `LocalRecord` for `envelopeFor`'s refusal. `FieldCapability`, the declared-class type, is gone.

## The runtime call graph

```
quick capture / board / scan
      │
      ▼
Outbox.saveDraft(kind)                    client/src/runtime/outbox.ts
      │  gate.check(kind)
      ▼
captureGate                               client/src/runtime/capabilities.ts
      ├── CAPTURE_OPERATIONS[kind]  ── requiresOnline, requiredHardware   (one declaration per kind)
      ├── capabilities(probes)      ── HS1, adapter probes                (memoryProbes / capacitorProbes)
      └── Connectivity.online()
      ▼
runtimeAvailability                       server/_core/offlineCapability.ts → actionGateway.mayRunWithoutServer
      ▼
refuse (NotOnDeviceError | server-required) — or save: saved_locally → queued → syncing (existing outbox)
      ▼
reconnect: sync.receivePackage / evidence.upload / direct procedure
      ▼
server: session → resolveActingScope (device org binding) → roleProcedure permission → domain → accept / refuse / conflict
```

**Declarations** (`CAPTURE_OPERATIONS`, one per `CaptureKind`):
- **Evidence** captures (inspections, tickets, a photographed out-of-service order, and so on) may run without the server. That is the outbox's existing behaviour: what the evidence permits is decided on sync.
- `board_message`, `board_acknowledgement` and `shift_response` are requests a server procedure decides. They `requiresOnline` and are drafted, never done on the device.
- **Hardware** named per kind:
  - every capture needs the local store;
  - evidence captures also need the vault;
  - `photo` needs the camera;
  - GPS is never required.

**Composition roots:**
- `runtimeBootstrap.mountBrowserFallbackRuntime` builds its `Outbox` with the gate.
- `BoardQueue` accepts one (`deps.gate`).

**Probes:**
- `memoryProbes()`: store, vault, keystore and network are true; camera and location are false, because the browser fallback has no binding for them.
- `capacitorProbes()`: the existing plugin `available()` checks for store, vault and keystore; camera, location and network are false until a binding exists. False means "will throw `NotOnDeviceError`", never "will degrade".

## The six sync states

| State (`contracts.ts:22`) | Meaning | HS1 relevance | `requiresOnline` relevance |
|---|---|---|---|
| `saved_locally` | on the device, a draft | reached only if the gate passed; missing hardware creates **no** capture | both evidence (`capture_locally`) and server requests (`prepare_and_queue`) land here |
| `queued` | complete, waiting for a connection | none | none |
| `syncing` | being sent | none | none; connectivity only |
| `synchronized` | the server verified it | none | the server authorized it on reconnect |
| `failed` | the server refused it, or the hash did not match | **never** set for missing hardware | **never** set by offline policy; a server-required refusal creates no capture |
| `conflict` | the server had a different version | none | none (unreachable today: `markConflict` has no caller, and the engine sends empty `recordUpdates`) |

No state means both "hardware unavailable" and "server refused". Both kinds of `unavailable` stop before the outbox, so no new state was needed and none was added.

## Tests

- **`server/spineItem3OfflineSeam.test.ts`** (22 tests). RED first: none of the surface existed. It covers:
  - **HS1:**
    - present hardware passes;
    - a missing camera or GPS is named;
    - unrelated hardware doesn't block;
    - the result is deterministic;
    - a throwing probe reads as unavailable.
  - **Offline policy:**
    - `requiresOnline` offline never executes;
    - offline with hardware takes the existing path;
    - missing hardware blocks, online or not;
    - online with server work is `prepare_and_queue` and nothing more;
    - the class is derived, and a contradiction refuses;
    - one predicate.
  - **Planted defect:** the pre-item-3 rule "online means execute locally" is rejected by the same property check that the corrected rule passes.
  - **Authority:**
    - full hardware plus a connection grants no permission: the gateway still answers `Missing enforcement.release`;
    - no result carries a permission, scope or claim.
  - **The runtime path:**
    - every kind is declared;
    - a camera capture without a camera is refused before anything is stored;
    - evidence is saved offline with the claim still `unknown`;
    - an open-work response is saved for the server;
    - the outbox without a gate is unchanged.
- **`server/spineItem3Reconnect.db.test.ts`** (3 tests). These run through the real `SyncEngine` and router, with captures claiming `"authorized"`:
  - a worker still permitted is accepted, and the claim is stored as history, neither upgraded nor used;
  - a worker whose organization changed offline is refused (`FORBIDDEN`, "Device is not bound to the active organization"), the capture goes back to `queued`, and nothing is accepted;
  - a worker whose permission was revoked offline is refused, and no evidence or package is received.

  Mutation check: removing the device-organization binding fails the second test.
- **`server/offlineCapability.test.ts`:** migrated to the derived class. The one test that asserted the defect ("behaves normally once there is signal" → `execute_locally`) now asserts `prepare_and_queue / server_decides`.

## Structural guard: `server/spineItem3Structure.test.ts` (AST, not text)

1. Hardware is reached only through `client/src/runtime/adapters/`. That rules out Capacitor imports, computed `import()`, `navigator.mediaDevices`/`geolocation`, `getUserMedia` and `<input type="file">` anywhere else. This is HS0 criterion (b).
2. `requiresOnline` is read (`.requiresOnline`) only in `actionGateway.ts`.
3. Each seam function is declared once, in its canonical file. `offlineOutcome` is gone, and no production code declares an `offlineClass`.
4. No server code other than the composition imports HS1 or the composition, so authorization cannot depend on them.
5. Every client `Outbox` that saves drafts is constructed with a gate.

Mutation checks: a direct `navigator.geolocation` in the runtime, a second `requiresOnline` reader, and an ungated outbox each fail the guard.

## HS1's own acceptance criteria (`HS0_RECONNAISSANCE.md:184–189`)

| | Criterion | State |
|---|---|---|
| (a) | `capabilities()` matrix aggregating the per-binding probes | **done**: `capabilities(probes)`, with `memoryProbes` and `capacitorProbes` |
| (b) | a test proving no direct hardware call site outside the adapter | **done**: guard 1 |
| (c) | a decision on `client/src/showcase/Home.tsx`'s file input | **owner's decision, pinned**. The showcase is now mounted under `/showcase/*`, so deleting it is a product decision. The guard allows exactly that one input and fails on a second. |

## Engine reachability: contract wired, runtime not activated

`offlineCapability` stays in `DECLARED_UNWIRED`, with its reason rewritten:
- the device runtime's gate calls `runtimeAvailability` through `Outbox`, and the browser-fallback root passes it;
- that root has no caller, and there is no native shell;
- the census counts server importers only.

Marking it reached would claim a production caller that does not exist. It leaves the list when a production device runtime is mounted. **SPINE item 3 required the seam, and the seam is what this checkpoint delivers.**

## Not done here (outside item 3)

- The native shell itself: camera, GPS, biometric, notification and connectivity bindings; the encrypted SQLite vault; the hardware keystore.
- The HS3 command ledger. `conflict` stays unreachable until it exists.
- HS5 (#120). It touches `syncEngine.ts`, `runtimeBootstrap.ts` and `HS_CONTRACTS.md`. This checkpoint changes one line of `runtimeBootstrap.ts` and does not touch `HS_CONTRACTS.md`: the frozen `CapabilityMatrix` it specifies is implemented as written.
