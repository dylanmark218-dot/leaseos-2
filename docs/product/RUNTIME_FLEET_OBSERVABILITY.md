# Runtime build identity and fleet observability (S2-FLEET-A)

Branch `security/s2-fleet-runtime-identity`, from `main` `2a76920`. Decision at the end.

## 1. Why

The S2-E Phase 2B cutover (canonical-only webhook secret writes) is safe only when every running
server and worker understands the canonical `secretRef`. Phase 2A's preflight could not know what was
running: `/healthz` and `/readyz` answer one `status` field by contract, the drain worker's heartbeat
carried a worker id and a time, and `LEASEOS_RELEASE` is a file in the repository. Its fleet component
was therefore `not_provable`, with no input that could change it (`WEBHOOK_SECRET_PHASE2A_READINESS.md`
§6). This checkpoint builds the smallest mechanism that lets the preflight observe the fleet — and is
explicit about what observation cannot prove.

## 2. Build identity

| Question | Answer |
|---|---|
| Module | `server/_core/buildIdentity.ts` — the one canonical reader |
| Value | `{ sha, release, shaSource }`: a full lower-case 40-hex commit id, the `LEASEOS_RELEASE` name, and whether the sha came from `git` or an explicit `LEASEOS_BUILD_SHA` |
| Embedded by | `scripts/build-server.mjs` (esbuild `define` of `__LEASEOS_BUILD_IDENTITY__`), one call bundling `dist/index.js` and `dist/worker.js` together, so both carry the same identity by construction |
| Determined by | `scripts/build-identity.mjs` at **build** time: `LEASEOS_BUILD_SHA` when set (must be the full commit id), else `git rev-parse HEAD`; a build that can establish neither fails |
| At runtime | never reads `process.env`, never calls git, needs no `.git` and no `git` executable (Gate 7a boots the artifact on a PATH holding `node` alone) |
| Missing | `runtimeBuild()` reports `unbuilt` (tsx, vitest); production refuses to start (`requireBuildIdentity`) |
| Malformed | throws `BuildIdentityError`; an identity that is present but wrong is never recorded |
| Environment override | impossible: `FLEET-M1` (behavioural, on a real esbuild bundle) and the smoke's decoy `LEASEOS_BUILD_SHA` |
| Local builds | deterministic for one commit: same sha, same release, same embedded value |
| CI | the gate builds from the checkout, so the identity is the actual commit; the smoke compares the reported sha with `git rev-parse HEAD` of the checkout |

`pnpm build` is now `vite build && node scripts/build-server.mjs`. The esbuild options are the ones the
command line used; `productionDependencyBoundary.test.ts` pins them in the script.

## 3. Capability vocabulary

`server/_core/runtimeCapabilities.ts`. Closed, central, one entry:

| Capability | Meaning | Required by |
|---|---|---|
| `webhook-secret-ref-read` | the signing path understands `webhookSubscriptions.secretRef`; a present reference is the authority and wins over legacy ciphertext; a present reference that does not resolve fails closed (`webhookSecretService.resolveWebhookSigningSecret`, S2-E Phase 1) | the Phase 2B cutover, of every live instance |

No free-text capability, no feature flag, no environment read. A string not in the vocabulary is
reported as unknown and never counted. Compatibility is judged on capabilities and a known build —
never on a particular sha, so two compatible builds running side by side are both compatible.

## 4. Runtime instance identity and registry

| Field | Value |
|---|---|
| `instanceRef` | `rt_` + random UUID minted at process start; not the pid, not the hostname (neither is unique across a fleet, and the hostname is not stored at all) |
| `runtimeKind` | `server` (dist/index.js, which also embeds a worker) or `worker` (dist/worker.js) |
| `buildSha`, `buildRelease`, `buildSource` | from the embedded identity; `NULL`/`unbuilt` for a process run from sources — recorded, never counted compatible |
| `capabilitiesJson` | the vocabulary this build declares |
| `startedAt`, `lastHeartbeatAt`, `stoppedAt` | database-clock timestamps |

Migration **`0213_runtime_instances.sql`** (`runtimeInstances`), tenant-neutral by design — no `orgRef`.
Slot chosen by re-scanning `main` and every remote branch at claim time: `0210`–`0212` are held by
`claude/driver-portfolio-credential-wallet-ya8928`, so `0213` was the first number free everywhere; the
register's earlier "next free: 0210" was stale and is corrected in the same commit
(`docs/architecture/MIGRATION_COLLISION_REGISTER.md`).

`server/_core/runtimeRegistry.ts`:

* `registerRuntimeInstance` — INSERT only. A duplicate `instanceRef` fails on the unique index; there is
  no upsert, so a later process cannot relabel an earlier one.
* `heartbeatRuntimeInstance` — `SET lastHeartbeatAt = CURRENT_TIMESTAMP` where not stopped. Nothing else.
* `stopRuntimeInstance` — `SET stoppedAt = CURRENT_TIMESTAMP` once. Nothing is deleted.
* `registerThisRuntime(kind, { production })` — the entrypoint call.

**Heartbeat and TTL.** `RUNTIME_HEARTBEAT_INTERVAL_MS = 15 000`, `RUNTIME_LIVE_TTL_MS = 60 000` (four
missed beats). Chosen against the worker's conventions: well above its 0.5–2 s poll cadence, and below
the 120 s workflow claim lease, so a vanished worker reads as stale before its claims expire. Liveness
is judged entirely on the database clock (`CURRENT_TIMESTAMP` on write, `TIMESTAMPDIFF` on read).

**Lifecycle.** Register → heartbeat → (SIGTERM) → marked stopped. A crash never reaches the stop and
expires by TTL instead: it is listed as stale, excluded from live counts.

## 5. Startup order

Server (`startup.ts`): probes registered → `assertProductionSecrets` → `bootstrapSecretKeys` (S2-KMS-A)
→ **`registerThisRuntime("server")`** → embedded worker → API → frontend → port bound → ready. In
production an unbuilt process, a missing database or a rejected registration throws before the port is
bound, so `/readyz` never says ready. Shutdown: not ready → worker drained → server closed → **instance
marked stopped**.

Worker (`worker.ts`): `bootstrapSecretKeys` → **`registerThisRuntime("worker")`** → drain loop; close
marks stopped. Both entrypoints go through the one module (`fleetWiring.test.ts`, FLEET-M2).

Outside production (`NODE_ENV=development`), no database or a failed registration is logged and the
process runs unobserved, so `pnpm dev` without a database still works. **Operational note:** a
production server now requires `DATABASE_URL` to start (it already required one to serve anything).

## 6. Fleet observation

`server/fleetObservationService.ts` reads `runtimeInstances` (rows not stopped) and reports:

| | |
|---|---|
| live servers, live workers | heartbeat younger than the TTL |
| distinct live builds | informational |
| live capability coverage | per required capability: live count, declaring count |
| live incompatible instances | with every reason: missing capability, unknown build, unreadable declaration |
| stale instances | never stopped, heartbeat at or past the TTL |
| external confirmation | `none` today |

### Convergence states — and what each one is allowed to claim

| State | Meaning |
|---|---|
| `not_observable` | no live instance has registered; nothing can be said |
| `observed_incompatible` | at least one live instance lacks a required capability or has no known build |
| `observed_compatible_external_confirmation_required` | every live instance observed is compatible; **whether those are all the instances that exist cannot be established from inside the deployment** |
| `converged` | the above **and** an authoritative deployment inventory confirms the observed set is the whole fleet |

`converged` has exactly one source: `deploymentEvidence()`, a parameterless function inside the
service that today returns `{ kind: "none" }` because no hosting platform is selected
(`HOSTING_TARGET` unknown, S2-KMS-A) and so no inventory exists to confirm against. It is not a flag, an
environment variable, a row or a parameter (`fleetWiring.test.ts` FLEET-M7/M8; `summarizeFleet` takes
rows and a TTL and nothing else). The preflight reads `observeFleet()` and constructs no fleet state of
its own (S2E2-T17, rewritten).

**The old-instance case.** A server deployed from a build older than this registry never registers,
and nothing here can see it. That is why "every instance observed is compatible" is a different claim
from "the fleet is converged", and why the mandatory test (`fleetObservation.db.test.ts` and the
preflight suite) plants a compatible server and a compatible worker and asserts: observed
compatibility yes, convergence no, cutover blocked.

## 7. Preflight integration

`webhookCutoverPreflight.fleet` is now the observation's projection (`state`, `reason`, live counts,
builds, incompatible list, stale count, required capabilities, `externalConfirmation`). The blocker is
lifted only when `fleet.state === "converged"`. `cutoverAllowed` remains the conjunction of the
components; `PreflightArgs` carries no fleet attestation.

Result on this repository with a compatible server and worker registered and every other component
ready: `fleet: observed_compatible_external_confirmation_required`, **S2-E cutover: BLOCKED**, one
blocker, naming the missing external confirmation.

## 8. Gate 7a extension

`scripts/prod-runtime-smoke.sh` now also: refuses a runtime directory containing `.git`; builds a PATH
that resolves `node` alone and proves `git` is not on it; checks both bundles carry an embedded identity
and mention neither `LEASEOS_BUILD_SHA` nor `rev-parse`; boots server and worker with a decoy
`LEASEOS_BUILD_SHA`; requires both to log `[build] sha=… source=artifact`, equal to each other and (in a
git checkout) to `git rev-parse HEAD`; requires both to log their registration; reads the registry row
back through the artifact's own `mysql2` (live, this build) and again after SIGTERM (stopped). No
devDependency was added; esbuild was already one and is used only at build time.

## 9. Authority

No tRPC procedure, router or script can register, heartbeat, stop, set a build, set capabilities or
assert convergence. The writers are `startup.ts`, `worker.ts` and the registry module; no router
imports the registry or the observation service; the preflight script only reads the preflight
(`fleetWiring.test.ts` FLEET-M10). No read procedure is exposed in this checkpoint.

## 10. Census and counts

No authorized procedure was added, so the operational permission census (682) and its pin are
untouched. Tables 429 → 430, migrations 186 → 187, role-authorized procedures unchanged (702).

## 11. Decision

**RUNTIME OBSERVABILITY READY — FULL CONVERGENCE EXTERNALLY BLOCKED.**

Next: production hosting/platform selection, then the S2-KMS-B vendor adapter and an authoritative
deployment inventory that `deploymentEvidence()` can read. S2-E Phase 2B proceeds only when both the
managed provider and authoritative convergence are ready.
