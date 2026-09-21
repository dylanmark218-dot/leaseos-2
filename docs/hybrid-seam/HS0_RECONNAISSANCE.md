# HS0 — reconnaissance and contract freeze

Against `e7178e8b4`. No production code, no dependencies, no migrations, as the checkpoint requires.

**Headline: five of the seven assumptions are wrong, and all five are wrong in the same direction —
the seam largely exists.** `client/src/runtime/` is a platform adapter layer with a durable outbox
and a sync engine, built at v20.20/P4 under the name "Secure Field Runtime". HS1 is substantially
built, HS3's client half is substantially built, and HS4's Exception Centre integration is partly
built. The plan's own rule applies: the finding wins and the checkpoint is re-specced.

## Verdicts

| # | Assumption | Verdict |
|---|---|---|
| A1 | Session auth is cookie-based and same-origin | **CORRECTED** — cookie-based yes, same-origin no: `sameSite: "none"` already, and a Bearer path already exists |
| A2 | tRPC client resolves the API via a relative path | **CONFIRMED**, with a correction — relative `/api/trpc`, but it already sends a Bearer header |
| A3 | There is no durable offline write queue today | **CORRECTED — there is one** |
| A4 | Hardware is called directly from components | **CORRECTED** — it is behind an adapter; one stray call site remains |
| A5 | Slots 0016/0017/0018 reserved; HS3 takes 0019 | **CORRECTED** — the tail is `0168`; next free is **`0169`** |
| A6 | `roleProcedure` is the canonical authorization wrapper | **CONFIRMED** |
| A7 | Exception Centre is state-derived across thirteen sources, no schema to add one | **CORRECTED** — twenty-one sources, and sync is already two of them |

---

## 1. Auth — A1 CORRECTED

Cookies are set in `server/_core/cookies.ts:43-46`: `httpOnly: true`, `sameSite: "none"`,
`secure: isSecureRequest(req)`. `sameSite: "none"` means the session cookie is **already** declared
cross-site, so the "same-origin" half of A1 is wrong today, before any wrapper exists.

**A Bearer path already exists on both ends.** `server/_core/sdk.ts:273` accepts
`Authorization: Bearer …`, and `client/src/main.tsx:47-60` sends it — a documented fallback for when
"the browser blocks iframe cookies (Safari ITP / private browsing / WebView)", mirroring the session
from `sessionStorage`. Its comment states the intended precedence: *"The regular OAuth cookie flow
keeps working and takes priority server-side."*

That is invariant 2 — one session, two presentations — already implemented as a fallback rather than
as a transport. **HS2 therefore shrinks to hardening and proving what exists**, not building it: does
the Bearer path resolve to the identical session record, does it reach exactly the same procedures,
and is the parity test-pinned? None of that is currently asserted anywhere.

Two facts HS2 must not inherit uncritically: the session JWT is signed for 365 days with no
server-side revocation (audit SEC-02), and there is no CSRF/Origin middleware in the repo to pair
with `sameSite: "none"` (SEC-03). A wrapper build widens the blast radius of both.

## 2. tRPC client — A2 CONFIRMED with a correction

`client/src/main.tsx:42-60`: `createTRPCReact<AppRouter>()` (`client/src/lib/trpc.ts:4`) with links
`[showcaseGuardLink(), httpBatchLink({ url: "/api/trpc", transformer: superjson, headers() {…} })]`.

The URL is a relative literal, so A2's premise holds and HS2's env-driven base URL is a real change.
The `headers()` callback is the Bearer path above. `superjson` is the transformer — HS3's canonical
payload hashing must account for it, since superjson's wire form is not `JSON.stringify` of the input.

## 3. Authorization — A6 CONFIRMED

`roleProcedure` is canonical: 646 role-authorized call sites, and `scripts/ci-gate.sh` step 7 asserts
**zero** bare `protectedProcedure` routes, with separate pinned counts for the portal gate
(`externalProcedure`, 36) and the machine gate (`integrationProcedure`, 2). A procedure with no
permission mapping is refused at wiring time. `PROCEDURE_AUTHORIZATION_INVENTORY.md` plus
`procedureAuthorization.test.ts` are where it is pinned.

Tenant scoping is **not** a settled property — `server/tenantIsolation.test.ts` opens by stating that
organization-wide isolation is not a property this system has, while the register calls P4.1 done
(audit RB-02/DOC-04). **HS2's "tenant scoping holds identically across both transports" can only
prove parity, not correctness**: if cookie-path scoping is incomplete, a passing parity test means
the token path is incomplete in exactly the same way. Worth stating in the HS2 report rather than
discovering later.

## 4. Offline — A3 CORRECTED, and this is the largest finding

`client/src/runtime/` (917 lines) is a working offline runtime:

| File | What it is |
|---|---|
| `contracts.ts` | `SyncState`, `LocalCapture`, `LocalPackage`, and the `LocalStore` / `FileVault` / `Keystore` / `Transport` / `Connectivity` / `Clock` interfaces, plus `NotOnDeviceError` |
| `outbox.ts` | **the durable outbox** — "A capture is saved the moment it exists… Nothing is deleted by the outbox" |
| `syncEngine.ts` | the device half of the v20.20 protocol: upload → seal → signed package, key rotation, revoked-device handling, and `captureSyncPriority` |
| `adapters/memory.ts` | the browser/test implementation |
| `adapters/capacitor.ts` | native bindings, each throwing `NotOnDeviceError` when its plugin is absent |
| `crypto.ts`, `safetyLatch.ts`, `commsVault.ts` | canonical JSON + sha256, the safety latch, the comms vault |

Server side: `syncPackages`, `syncPackageItems`, `syncReceipts`, `syncConflicts`,
`deviceSyncNonces`, `fieldDevices`, `deviceKeyEvents`, `deviceSafetyLatches`.

`captureSyncPriority` already encodes a rule HS3's "ordered per-entity" does not: safety and legal
evidence outranks bulk media, so "500 old photos can never starve a newly queued HOS event", with
`roadside_enforcement` and `oos_order` above everything. HS3's large-payload concern is answered by a
priority tier rather than by separate upload queues.

**HS3 is therefore an extension, not a build**, exactly as A3's "if false" column says. What is
genuinely absent is the **server-side idempotency ledger**: there is no `sync_commands` table and no
`commandId` replay semantics. The existing protocol is idempotent per *capture* by device reference
and per *package* by seal; it does not give the `APPLIED` / `REJECTED` / `IN_DOUBT` /
`COMMAND_ID_COLLISION` state machine HS3 specifies. That machine is the real deliverable, and it must
extend `syncPackages`/`syncReceipts` rather than sit beside them — a second sync vocabulary is the
defect this repository keeps catching.

## 5. Hardware — A4 CORRECTED

**One** direct call site in the client: `client/src/showcase/Home.tsx:1810`, an `<input type="file">`.
`client/src/showcase/` is the ComponentShowcase — 1,440 lines with no route, already on the deletion
list in the standing backlog. No `navigator.geolocation`, no `watchPosition`, no
`navigator.mediaDevices` anywhere in `client/src`.

Camera, GPS, keystore, encrypted store and file vault are already interfaces in `contracts.ts` with
two implementations. **HS1's migration step is one file, and that file is a deletion candidate.**
What HS1 can still add: a `platform.capabilities()` matrix, which `contracts.ts` does not expose —
`capacitor.ts` has per-binding `available()` probes but nothing aggregates them.

One naming decision for HS1: invariant 1 names the error `CapabilityUnavailable`; the tree has
`NotOnDeviceError` doing exactly that job, thrown by every native stub. **Use the existing name.**
Introducing a second error type for one behaviour is the same defect as a second `resolveRate`.

## 6. Provenance — the vocabulary HS3 must extend

Do not invent a capture-source enum. `proposalFields` already carries three orthogonal axes:

```
source:    driver_voice | driver_typed | gps | photo_ocr | system_inferred | imported | human_corrected
status:    proposed | confirmed | rejected | corrected
precision: exact | approximate
```

plus `sourceUtterance` and `correctedFrom`. `assistantCommitReceipts` binds a proposal to the record
it wrote via `targetType` + `targetRecordId` + a hashed `fieldManifest`.

`LocalCapture` already separates device time from server time and carries a
`CaptureAuthorizationClaim` (`authorized | unauthorized | unknown`) explicitly documented as *"what
the device knew at the moment of capture… historical evidence, not server authorization."* That is
invariant 3 already implemented at the capture layer.

Related, and stricter than invariant 3: `_core/interEngineStatus.ts` defines
`PASS | REVIEW | BLOCKED | UNKNOWN | NOT_EVALUATED` with a required reason on `NOT_EVALUATED` and a
rule that it never rounds up to `PASS`. HS3's `IN_DOUBT` is the same idea; consider whether it should
*be* `NOT_EVALUATED` rather than a parallel word.

## 7. Migrations — A5 CORRECTED

165 `.sql` files, 164 distinct numeric prefixes, range `0000`–`0168`.

- **Next free slot: `0169`.** Not `0019`.
- Gaps at **16, 17, 94, 95, 98** — so A5's "0016 and 0017 are reserved" is half right in outcome and
  wrong in reason: they are unused, not reserved for P0 spatial/routing. Filling a historical gap
  would be wrong regardless; the ledger keys by filename and applies in lexical order.
- One duplicated prefix: `0157_seal_verification_unavailable.sql` and
  `0157_signature_device_attestation.sql` (audit CI-02). No gate checks prefix uniqueness.
- Counting files or taking `max(prefix)` both give the wrong answer here. **Read the tail.**

## 8. Exception Centre — A7 CORRECTED

`ExceptionSources` (`server/_core/exceptionCentre.ts:59`) is a plain TypeScript type with
**twenty-one** fields, not thirteen. Adding a source is a field plus a case in `deriveExceptions`
and a loader in `surfacesService.ts` — **no schema change**, so A7's "if false → HS4 grows a
migration" does not trigger.

**Two of the twenty-one are already sync sources:** `syncConflicts` and `revokedDevicesWithQueue`
(the latter being a revoked device holding queued captures — invariant 7's concern, already
surfaced). So HS4's registration work is extending two existing sources, not adding a new one.

Note for HS4: `openCalibrationSweeps` and `inspectorRequests` were made **required** fields at v23.06
precisely so a caller could not omit a source and silently lose its exceptions. A new field should be
required for the same reason.

## 9. CI — baseline

`scripts/ci-gate.sh`, MariaDB 10.11 / Node 22 / pnpm 10.4.1, on a dropped-and-recreated database:
reserved migration slots → migrations → table parity → source typecheck → test-file typecheck ratchet
(**pinned at 0**) → zero bare `protectedProcedure` → Vitest → production build → portal gate (36) →
machine gate (2) → current-state regeneration diff.

**Baseline at `e7178e8b4`: PASS — 296 test files, 4,110 tests, 33 skipped, 408 tables, 165
migrations, 646 role-authorized procedures, 0 test-file type errors.**

Two things HS1–HS5 will meet: the **test-file typecheck ratchet is pinned at zero**, so every new
test file must typecheck under `tsconfig.tests.json`; and `tsconfig.json` sets **no `target`**, so
production compiles as ES5 — a `Map`/`Set` iterator or a spread of either is `TS2802`. Both have
caught real errors this week.

---

## Re-spec notes

**HS1 — shrinks to three things.** The adapter exists. What remains: (a) a
`platform.capabilities()` matrix aggregating the per-binding `available()` probes; (b) the grep-based
test proving no direct hardware call site outside the adapter, which passes today except for
`showcase/Home.tsx:1810`; (c) a decision on that file — deleting `client/src/showcase/` closes it and
is already proposed. **Do not introduce `CapabilityUnavailable`; `NotOnDeviceError` is the existing
name for that behaviour.**

**HS2 — shrinks to hardening and proving.** Both the Bearer path and the cross-site cookie exist. The
work is the env-driven base URL, the CORS allowlist, token lifetime/refresh/revocation semantics, and
above all the **parity suite**, which does not exist in any form. Report explicitly that parity is not
correctness while RB-02 is open.

**HS3 — the server ledger is the deliverable; the client queue mostly exists.** Build
`sync_commands` at slot **`0169`** and wire it into the existing `syncPackages`/`syncReceipts`
protocol rather than beside it. Reuse the `proposalFields` provenance vocabulary. Consider
`NOT_EVALUATED` in place of a new `IN_DOUBT` word. Account for **superjson** when canonicalising the
payload hash.

**HS4 — extend two existing Exception Centre sources**, no migration. Make any new field required.

**HS5 — unchanged.** No version header exists on either side today; this is a genuine build.

**§3, the six-vs-eight state question.** `contracts.ts:22` already ships the six as
`SyncState`, and `LocalPackage.state` already carries `queued | sent | accepted | rejected | partial`
— so `rejected` exists at package granularity but not at capture granularity. The owner decision is
therefore narrower than the plan frames it: not "add two new states" but "promote `rejected` from the
package to the capture, and decide whether `in_doubt` is a new word or `NOT_EVALUATED`."
