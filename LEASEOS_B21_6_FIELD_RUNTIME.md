# LeaseOS — v21.6 Checkpoint: Secure Field Runtime — the client half that can be proven here

| | Previous | New |
|---|---|---|
| Version | v21.5 | **v21.6** |
| Tables | 182 | **182** (`evidenceRecords` extended) |
| Migrations | 41 | **42** |
| Procedures (role-authorized) | 224 | **224** — no new API; two existing ones fixed |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,287 | **1,297** |
| Test files | 59 | **60** |
| Parity | 182/182 | **182/182 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## The strategy change, accepted

The direction document is right: the backend is far enough ahead that another
twenty tables would be worth less than making what exists usable. No new
backend family in this tranche. This is the field client — and an exact
account of what this container can prove about it.

**What is here and proven.** `client/src/runtime/` — a dependency-free
TypeScript library: the contracts every platform piece sits behind; envelope
encryption on WebCrypto with per-file keys wrapped by the device key; the
durable outbox with the six states the master directive requires the UI to
show; the sync engine that speaks the v20.20 device protocol; in-memory
adapters for tests and as the honest browser fallback; and the native binding
boundary, which loads its plugins at runtime and throws `NotOnDeviceError`
without them.

**What is not, and is not claimed.** The Capacitor shell, the encrypted SQLite
file, the hardware keystore, camera, GPS, biometrics, local notifications.
`adapters/capacitor.ts` names each, states what must be true on the device,
and cannot be exercised here. The browser fallback says of itself that it is
not at-rest protection.

---

## The golden scenario, against the real server

A driver enrols and activates from the tablet — activation is the device's
own step, not the office's — then loses signal at 05:30. Pre-trip, a load
photo with a GPS fix, a fuel receipt, a disposal ticket, a defect: five
captures over eight hours, each saved first, encrypted, queued. Sync while
offline does nothing and says why; the oldest evidence not on the server is
450 minutes old. At 13:30 signal returns and drops after two uploads: two
synchronize, three fail *with the reason*, nothing is lost. The retry
re-sends the same capture references: **the server returns the same ids and
creates nothing twice** — five records, each once, each sealed, the fuel
receipt's `capturedAt` still 09:40 beside a `createdAt` hours later. Both
packages are admitted under the device's fingerprint with every item
verified. Then: a tampered upload fails the right capture and only that one;
a 45-day-old key rotates before the push and the push is admitted under the
new one; a revoked device is told once, keeps its captures as failed with the
reason, and stops trying.

---

## Three things the server half needed, found by building the client half

**The upload was not idempotent, and it lied about time.** A sync retried
after a dropped connection would have created duplicate evidence records, and
every record's `capturedAt` was the server's *now*. `clientCaptureRef` makes
the upload return the existing id; `capturedAt` is the device's, `createdAt`
the server's.

**The receipt gave counts, not verdicts.** *Verified 3, rejected 1* left a
device unable to say which capture failed. Per-item verdicts are on the
receipt now.

**The server verified the seal against the device's word.** The package item
carries `computedContentHash`, and the router took it from the device and
compared the seal to it — a tampered upload would have passed. `storageRead`
exists now; the server recomputes from the bytes it stored, and a record
with nothing in storage cannot verify. P4's own life-cycle fixture had relied
on the hole — it pushed packages for evidence ids with no bytes anywhere —
and now uploads real bytes.

And one rule the vault already had that the client now honours early: *a
sealed record must relate to at least one entity*. The outbox refuses to
queue a capture with no job or unit, so the worker hears "which job is this
for?" at capture, not the sync engine hours later.

---

## Files

**New:** `client/src/runtime/` — `contracts.ts`, `crypto.ts`, `outbox.ts`,
`syncEngine.ts`, `adapters/memory.ts`, `adapters/capacitor.ts`, `index.ts` ·
`0043_offline_capture_ref.sql` · `server/fieldRuntime.test.ts` (10)

**Changed:** `routers.ts` (`evidence.upload` idempotent, device-timed) ·
`db.ts` · `deviceRouter.ts` (recompute from storage; item verdicts) ·
`storage.ts` (`storageRead`) · `recordsRouter.ts` (capturer owns the record
at seal) · `fieldDevice.test.ts` (real bytes) · `schema.ts`

---

## What this tranche does to the roadmap

The client's logic is written and proven against the server; the platform
bindings are a boundary, named. **v21.6 is done only when the native shell is
built and the same golden scenario runs on a tablet** — with a real camera, a
real GPS loss, a process kill mid-sync, and a key rotation on hardware. That
is device work and it is next on this line, alongside the portal shell
(v21.7), which builds against the five surfaces exactly as they are.

**P9 stands as the parallel workstream that only a person can run.** Every
rule the engine holds is still unverified; every passport, every work
authorization, every IFTA return and every dispatch verdict says UNKNOWN
where it cannot prove otherwise, and the loading paths are controller-only
and ready.
