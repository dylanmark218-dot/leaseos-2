# SPINE item 3 — `offlineCapability` → HS1: survey before wiring

Surveyed on `main` at `240b2dd` (2026-10-01), after SPINE item 2 merged (#89) and main CI went
green. **Survey only.** No code, schema or test is changed by this record, and nothing is deleted.
Item 2 was done the same way: read what exists, name every place that already answers the question,
and let the owner choose before anything is wired.

## What the plan says

`docs/register/SPINE_WIRING_PLAN.md`, ordering item 3:

> **`offlineCapability` → HS1.** It is the device seam and the hybrid plan already covers it.

and in the spine table: `offlineCapability` — field runtime — *not called by the device runtime —
this is the seam HS1 covers*.

## Finding 1 — HS1, as written, does not cover `offlineCapability`

HS1 is defined in two places, and both define the same three tasks:

- `docs/hybrid-seam/HS0_RECONNAISSANCE.md` §5 and its re-spec notes: *"HS1 — shrinks to three
  things"*: (a) a `platform.capabilities()` matrix aggregating the per-binding `available()` probes;
  (b) a grep-based test proving no direct hardware call site outside the adapter; (c) a decision on
  `client/src/showcase/Home.tsx`, the one remaining call site.
- `docs/hybrid-seam/HS_CONTRACTS.md` §1: the only new HS1 surface is `CapabilityMatrix`
  (`localStore`, `fileVault`, `keystore`, `camera`, `location`, `network`) and `capabilities()`.

Neither document names `offlineCapability`, `OfflineClass`, `offlineOutcome` or `envelopeFor`.
The word "capability" means two different things here:

| | HS1 `CapabilityMatrix` | `server/_core/offlineCapability.ts` |
|---|---|---|
| Question | what hardware does this device have? | what may this device do without the server? |
| Side | client runtime | server `_core`, pure |
| Values | six booleans, probed | four declared classes per action |

So the plan's premise, that the hybrid plan already covers item 3, does not hold in the text of
either hybrid document. Completing HS1 as specified would leave `offlineCapability` exactly as
unwired as it is today.

## Finding 2 — what `offlineCapability` is, and who calls it

`server/_core/offlineCapability.ts`, 202 lines, pure, 16 tests in `server/offlineCapability.test.ts`.

- `OfflineClass`: `local_safe | local_capture | local_prepare | server_authoritative`.
- `validateCapability` / `classRiskDisagreements`: each class may carry only certain
  `actionGateway` risk levels, so a class label cannot hide a server decision.
- `offlineOutcome(capability, { online, draftable })`: `execute_locally | capture_locally |
  prepare_and_queue | unavailable`.
- `envelopeFor(record, assessment)`: a device's assessment travels as a claim with its basis;
  a `server_authoritative` record is refused with `DeviceAuthorityRefused`.
- `freshnessOf` / `actionable`: a cached answer with no capture time is `unknown`, never `current`.

**Callers outside tests: none.** It is referenced only by its own tests, the census
(`engineReachability.test.ts`, *"no device runtime calls them yet"*) and the SPINE plan guard. Its
`FieldCapability` type is `CapabilityDefinition & { offlineClass }`, and **no `FieldCapability`
value exists anywhere in the tree**: no real capability has been given an offline class.

## Finding 3 — the same question already has a live answer: `requiresOnline`

`server/_core/actionGateway.ts` declares `CapabilityDefinition.requiresOnline: boolean`, and
`decide()` acts on it:

```ts
if (capability.requiresOnline && !ctx.online) {
  return { decision: "deny", reasons: [`${capability.key} needs the server. Offline, this can be prepared and not performed.`] };
}
```

`decide()` is live: `server/agentRouter.ts` calls it from `agent.requestAction`, with
`online: true` passed unconditionally, so the offline branch never fires today. All six entries in
the agent registry declare `requiresOnline: true`.

This is the item 2 shape. Two pieces of code answer *may this happen offline?*:

| | `actionGateway.requiresOnline` | `offlineCapability.offlineClass` |
|---|---|---|
| Reached by production | yes, through `agentRouter` (offline branch unreachable) | no |
| Shape | one boolean on the definition | four classes, checked against `riskLevel` |
| Offline answer | `deny` | execute, capture, prepare-and-queue, or unavailable |
| "Prepare" | only in the deny message's wording | a real outcome, `prepare_and_queue` |

Wiring `offlineCapability` beside the gateway's boolean would produce two answers for one
capability. As in item 2, choosing the survivor is the actual work.

## Finding 4 — the device's claim already travels as a claim, in another vocabulary

`envelopeFor`'s rule is that a device assessment is a claim, never a verdict. The live sync path
already keeps that rule, in a different shape:

- `client/src/runtime/contracts.ts`: `CaptureAuthorizationClaim = "authorized" | "unauthorized" | "unknown"`
  plus a free-text reason, on every `LocalCapture`.
- `server/deviceRouter.ts` `ITEM`: the same enum, part of the signed payload, stored on
  `syncPackageItems` exactly as sent. No server code derives a decision from it.

This is not a second algorithm, because the router computes nothing from the claim. It is a second
vocabulary for one concept: `SyncEnvelope.deviceAssessment = { claim, basis }` against
`captureAuthorizationClaim` + `captureAuthorizationReason`. `envelopeFor`'s refusal of
`server_authoritative` records has no counterpart on the live path.

## Finding 5 — freshness has no competing implementation

The client runtime has no freshness grading of its own; `commsVault.ts` defers staleness to the
server's `packageStatus`. `freshnessOf` / `actionable` duplicate nothing found.

## Finding 6 — two premises in the hybrid documents are stale on `main`

- **HS3's migration slot.** `HS_CONTRACTS.md` §4 and HS0's re-spec reserve **`0169`** for
  `sync_commands`. `0169` is taken here (`0169_defect_resolution.sql`) and in the sibling
  repository (`0169_trip_stop_provenance.sql`); see
  `docs/register/MIGRATION_0169_RECONCILIATION.md`. HS3 must take the next free number when it is
  built. `HS_CONTRACTS.md` is marked frozen, so it is not edited here.
- **The showcase.** HS0 describes `client/src/showcase/` as having *no route* and being *on the
  deletion list*. On `main`, `client/src/App.tsx` imports and routes `showcase/Home` and
  `showcase/FleetWorkspace`, and the build register's P5.1 treats the showcase screens as
  production screens with per-panel source statements. HS1 task (c), "delete the folder", no
  longer holds. The direct hardware call site HS1 task (b) would refuse is still there:
  `client/src/showcase/Home.tsx:1810`, an `<input type="file">`.

## HS1's own three tasks on `main` today

| Task | State on `main` |
|---|---|
| (a) `capabilities()` matrix | absent: no `CapabilityMatrix` in `client/src` or `shared` |
| (b) no-direct-hardware grep test | absent |
| (c) the showcase call site | present at `Home.tsx:1810`; deleting the folder is no longer the fix |

## Decisions needed before any code

1. **What item 3 means.** HS1's three device-hardware tasks, wiring `offlineCapability`, or both
   as separate pieces. The plan treats them as one; the documents describe two.
2. **The survivor for "may this happen offline?"** Options:
   - keep `offlineClass` as the one declaration, remove `requiresOnline` from
     `CapabilityDefinition`, and have `decide()` call `offlineOutcome`;
   - keep `requiresOnline` and delete `offlineCapability`'s `offlineOutcome`;
   - keep both with one derived from the other, pinned by a test.

   Recommendation: the first. The class is checked against the risk level, and it can tell
   "prepare now, decide later" apart from "unavailable", which the boolean collapses into `deny`.
   It touches the agent action gateway, so it is a gateway change, not only a device change.
3. **The device-claim vocabulary.** Keep the signed `captureAuthorizationClaim` enum as the one
   wire shape and adapt or retire `SyncEnvelope`, or move the wire to `{ claim, basis }`. Changing
   a signed payload shape needs a version path, which is HS5's contract-version header.
4. **HS1 task (c).** Replace the showcase `<input type="file">` with the adapter's `FileVault` /
   camera binding, or exempt it by name in the grep test.

## What this record does not do

It adds no engine, no migration and no test; it deletes nothing; and it does not touch
`HS_CONTRACTS.md`, the census or the SPINE plan. `offlineCapability` stays in `DECLARED_UNWIRED`
with its current reason until the owner rules on the decisions above.
