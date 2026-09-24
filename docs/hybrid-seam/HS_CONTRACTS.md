# HS contracts — frozen interfaces for HS1–HS5

Frozen at `e7178e8b4`. **Most of this is not new.** The platform adapter, the capture envelope and
the sync-state enum already exist in `client/src/runtime/contracts.ts`; this file points at them and
names only what is genuinely being added. A contracts file that restates existing types under new
names would create the second vocabulary this repository keeps catching.

## 1. Platform adapter — EXISTS, `client/src/runtime/contracts.ts`

Authoritative today: `LocalStore`, `FileVault`, `Keystore`, `Transport`, `Connectivity`, `Clock`,
with `adapters/memory.ts` (browser/test) and `adapters/capacitor.ts` (native, throwing).

**The unavailable-capability error is `NotOnDeviceError`** (`contracts.ts:116`), not
`CapabilityUnavailable`. Invariant 1 is already implemented by it: every native binding throws rather
than approximating. HS1 must not introduce a second name.

Added by HS1 — the only new surface:

```ts
/** What this runtime can actually do, probed rather than assumed. */
export type CapabilityMatrix = {
  localStore: boolean;      // encrypted SQLite on device; memory adapter in a browser
  fileVault: boolean;
  keystore: boolean;
  camera: boolean;
  location: boolean;
  network: boolean;
};

/**
 * Aggregates the per-binding `available()` probes that `adapters/capacitor.ts`
 * already exposes. A false entry means the capability will throw
 * NotOnDeviceError, never that it will degrade.
 */
export function capabilities(): Promise<CapabilityMatrix>;
```

## 2. Capture envelope — EXISTS, extended by HS3

`LocalCapture` (`contracts.ts:35`) is the envelope: `localId`, `kind`, `formKey`, `title`,
`category`, `fields`, `files[]` (vault-referenced, never inlined), `capturedAt`, `gps`, `jobId`,
`unitId`, `captureAuthorizationClaim`, `captureAuthorizationReason`. `LocalPackage` (`:71`) batches
them with a `packageRef`, a receipt and an attempt count.

HS3 adds the **ledger identity** only — the fields the server needs to make replay exactly-once:

```ts
export type CommandEnvelope = {
  /** Client-generated ULID. The unique index on this is the lock. */
  commandId: string;
  /** Device identity, already enrolled via fieldDevices. */
  deviceId: string;
  /** sha256 over the canonical payload. NOTE: superjson is the tRPC transformer,
   *  so canonicalisation must match what the wire actually carries. */
  requestHash: string;
  /** The device clock, stored byte-identical to what was sent. Never corrected. */
  capturedAt: string;
};
```

`receivedAt` and `clockSkewMs` are server-stamped and never appear in the envelope.

## 3. Sync state — EXISTS as six, owner decision pending

```ts
// contracts.ts:22 — shipped today
export type SyncState =
  "saved_locally" | "queued" | "syncing" | "synchronized" | "failed" | "conflict";

// LocalPackage.state — shipped today, package granularity
"queued" | "sent" | "accepted" | "rejected" | "partial";
```

So `rejected` already exists, one level up. The §3 decision is therefore **narrower than the plan
states**: promote `rejected` from package to capture granularity, and decide whether `in_doubt` is a
new word or whether the existing `NOT_EVALUATED` from `_core/interEngineStatus.ts` covers it — that
enum already means *"it did not pass, it did not fail, it was not asked"*, carries a required reason,
and is pinned never to round up to `PASS`.

**Not frozen until the owner rules.** HS4 builds what is approved.

## 4. Server ledger — NEW, the real HS3 deliverable

Migration slot **`0169`** (the tail is `0168`; `0019` from the plan is long since taken).

The table is as specified in the plan, with two bindings to what exists:

- it extends the `syncPackages` / `syncPackageItems` / `syncReceipts` protocol rather than standing
  beside it — one sync vocabulary, not two;
- the capture-source value extends `proposalFields.source`
  (`driver_voice | driver_typed | gps | photo_ocr | system_inferred | imported | human_corrected`)
  rather than inventing an enum.

State machine, unchanged from the plan and to be pinned per state:
`accepted` → `applied` | `rejected` | `conflict`, with a row stuck at `accepted` reported as
in-doubt and a differing hash on a known `commandId` refused as `COMMAND_ID_COLLISION`.

## 5. Auth — EXISTS as a fallback, hardened by HS2

Cookie: `httpOnly`, `sameSite: "none"`, `secure` when the request is HTTPS
(`server/_core/cookies.ts:43`). Bearer: accepted at `server/_core/sdk.ts:273`, sent from
`client/src/main.tsx:47`.

HS2 freezes what is currently undocumented: token lifetime, refresh rotation, revocation, and the
CORS allowlist. The parity rule stands as invariant 2 and is currently asserted nowhere.

## 6. What HS5 adds — genuinely new

No contract-version header exists on either side. HS5 defines it; nothing to reconcile.

**Defined:** `shared/clientContract.ts`, enforced by `server/_core/clientContractGate.ts`; see
[`HS5_CLIENT_CONTRACT.md`](./HS5_CLIENT_CONTRACT.md) for the rules and the gaps still open.

---

**Rule for HS1–HS5.** Before adding a type here, search for it. Five of seven HS0 assumptions were
wrong because the seam was already built under another name, and every one of this session's worst
defects — two `resolveRate`s, a second `osmLoad`, a projector whose only consumer was itself — came
from building beside something that already existed.
