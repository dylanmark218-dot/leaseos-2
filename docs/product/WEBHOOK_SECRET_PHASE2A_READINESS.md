# Webhook secret migration — Phase 2A readiness and production preflight

**Checkpoint:** S2-E Phase 2A — webhook canonical-secret readiness + managed-key production preflight.
**Baseline:** `main` at `b2061c6` (P0-C integrated). **Branch:** `security/s2e-phase2-readiness`.
**Decision:** **BLOCKED** — see §9. Nothing in this checkpoint switches `webhookSubscribe` to canonical
writes, clears legacy ciphertext, removes `LEASEOS_PORTAL_MFA_KEY`, or adds a rotation API.

This document records what was established, in the order the checkpoint asked for it. The code that
answers the questions is `server/webhookCutoverPreflight.ts`; the suites that prove the answers are
`server/webhookCutoverPreflight.db.test.ts`, `server/webhookCutoverPreflight.test.ts` and
`server/webhookSecretBackfillRace.db.test.ts`, alongside the Phase 1 suite
`server/webhookSecretMigration.db.test.ts`.

## 1. Current S2-E state, path by path

| Path | Where | Secret source | `secretRef` understood | Legacy fallback | Broken ref | Secret exposed / logged | Re-reads before signing |
|---|---|---|---|---|---|---|---|
| Create (`webhookSubscribe`) | `integrationRouter.ts` | generates 32 random bytes; **writes `secretEnc` under `LEASEOS_PORTAL_MFA_KEY` only** | not written (Phase 1, pinned by E4/E5/E30) | n/a | n/a | plaintext returned **once** in the response, by design; never logged | n/a |
| Initial delivery | `webhookDispatchService.ts` → `resolveWebhookSigningSecret` | `secretRef` → `encryptedSecrets` under `WEBHOOK_SECRET`; else `secretEnc` under the legacy key | yes | only when `secretRef` is **absent** | **fails closed**: subscription skipped, refusal message logged (no plaintext, no envelope — E21) | no | yes — resolved per subscription per dispatch call, never cached across calls |
| Retry (failed, `nextAttemptAt` due) | same loop, `claimNewAttempt` with `attempt + 1` | same resolver | yes | same | same | no | yes — fresh timestamp and signature every attempt (E16, S2E2-T10) |
| Expired-claim reclaim | same loop, `reclaimExpiredAttempt` (same attempt number) | same resolver | yes | same | same | no | yes — re-signed and the stored signature replaced (E17, S2E2-T11) |
| Migration / backfill | `webhookSecretMigration.ts` | reads `secretEnc` with the legacy key; writes under the provider's active `WEBHOOK_SECRET` key | writes it, only `WHERE secretRef IS NULL` | n/a | n/a (never touches a row with a reference) | failures carry `subscriptionRef` and a message only | n/a |
| Readiness | `webhookSecretReadiness` | none | counts rows by state | n/a | n/a | counts and booleans only (E23) | n/a |
| Disable / error | `webhookSetStatus` (router) and `disableSecret` (store) | none | status only; the router never names `secretRef` | n/a | n/a | no | n/a |

Storage states, as `webhookSecretStorageOf` names them:

| State | `secretEnc` | `secretRef` | Signs from |
|---|---|---|---|
| legacy | present | NULL | legacy ciphertext under the shared key |
| transitional | present | present | the canonical reference; ciphertext is the rollback path |
| canonical | NULL | present | the canonical reference only |
| none (invalid) | NULL | NULL | nothing — refused |

## 2. Phase 1 compatibility — intact

Proved by S2E2-T1..T7 (and E1/E6/E26/E7/E8/E27/E25/E11/E13 before them): legacy-only resolves in
every status; transitional resolves the **canonical** value; canonical-only resolves with **no legacy
key at all**; a broken, wrong-purpose or disabled reference refuses and **never** falls back to the
working legacy ciphertext beside it; both-null refuses. Every signing path — office dispatch, worker
`processEvent`, the heartbeat retry sweep and the expired-claim reclaim — reaches the secret through
the one resolver (`webhookDispatchService.ts:206`), so canonical-only is readable everywhere the
server or worker signs. Mutation M1 (catch-and-fall-back) is caught by E7 and S2E2-T4/T5/T6.

## 3. Retry / reclaim secret freshness — mandatory invariant holds

Legacy rows: E16/E17. Canonical rows: S2E2-T10/T11 repoint `secretRef` from secret A to a new secret
B between attempts. Both paths verify under **B**, fail under **A**, do not re-send the signature
recorded for the previous attempt, and (reclaim) replace the stored signature on the same attempt
row. Nothing on `webhookDeliveries` carries a secret or a reference (pinned structurally). Mutations
M2/M3 (re-send the recorded signature on retry / reclaim) are caught by E16/E17 and T10/T11.

## 4. Backfill on a production-shaped mix

Fixture (one disposable database, two tenants): 3 active legacy-only, 1 paused legacy-only, 1
revoked legacy-only, 1 transitional, 1 both-null (active), 1 broken reference (active, legacy
present), 1 wrong-purpose reference (active, legacy present), 1 disabled canonical secret (paused,
legacy present), 1 corrupt legacy ciphertext (active).

| Property | Result |
|---|---|
| bounded run (`batchSize 2, maxBatches 1`) | scans exactly 2 rows, `complete: false` |
| run to completion (`batchSize 3`) | 5 legacy rows migrated (active, paused and revoked alike); the corrupt row reported by reference; `complete: false` because of it |
| per-batch no-progress break | a batch of only failing rows stops (E24, "never spins") |
| legacy ciphertext | `secretEnc` byte-identical on all 11 rows after both runs |
| migrated plaintext | byte-identical on every migrated row (S2E2-T8) |
| HMAC over the same (timestamp, body) | byte-identical before and after on every row with a secret (S2E2-T9) |
| rows with a reference, both-null, corrupt | untouched (`secretRef` and `secretEnc` as recorded) |
| idempotent | a further run repoints nothing and no duplicate `encryptedSecrets` row appears |
| orphan on a lost race | **defect found and fixed**: the loser's secret was never disabled because `rowsAffected` was read off the driver's result tuple (always `undefined`). Now `affectedRows(updated) === 0` → `disableSecret`. `webhookSecretBackfillRace.db.test.ts` loses the race deterministically and is red on the original line (mutation M9). |

Note for production: the backfill writes through `createSecret`, so **in production it is refused
under the environment provider** exactly as creation would be. The managed provider is a
prerequisite for the Phase 1 backfill in production, not only for Phase 2.

## 5. Readiness report — exact meanings

| Field | Meaning |
|---|---|
| `total` | every `webhookSubscriptions` row, any status |
| `enabled` | rows with `status = 'active'` — the only rows the dispatcher selects |
| `legacyOnly` | `secretEnc` present, `secretRef` NULL |
| `transitional` | both present |
| `canonicalOnly` | `secretRef` only — **must be 0 throughout Release 1**; nothing produces it before E-C |
| `invalidBothNull` | neither present |
| `enabledUnsignable` | enabled AND both-null |
| `enabledLegacyOnly` | enabled AND legacy-only (new in 2A; the count behind the boolean below) |
| `noEnabledLegacyDependence` | `enabledLegacyOnly === 0`. **Database state only. It is not deployment readiness** and the preflight never treats it as such. |

Cutover **data** readiness (`webhookData.ready`): `enabledLegacyOnly = 0`, `enabledUnsignable = 0`,
`canonicalOnly = 0`, and every enabled row resolves under the compatibility reader. Separately,
`existingCanonicalSecrets.resolvable` requires every row carrying a reference — any status — to
resolve; failures are reported by category (`missing_or_wrong_purpose`, `disabled`,
`key_unavailable`, `undecryptable`, `malformed_envelope`, `legacy_key_missing`,
`legacy_undecryptable`, `unsignable`), never by value.

On the representative mix after the backfill: data not ready (one enabled both-null row, one corrupt
legacy row, two enabled broken references), three unresolvable references (broken, wrong-purpose,
disabled) — each named by the preflight as its own blocker.

## 6. Fleet convergence — not provable

> **Superseded by S2-FLEET-A** (`RUNTIME_FLEET_OBSERVABILITY.md`): the mechanism proposed below now
> exists — `server/_core/buildIdentity.ts` (embedded at build time), `runtimeInstances` (migration
> 0213), `server/fleetObservationService.ts`. The fleet component reports `not_observable`,
> `observed_incompatible`, `observed_compatible_external_confirmation_required` or `converged`; the
> last needs external deployment evidence no selected hosting platform yet provides, so the cutover
> remains blocked. The text below is kept as the record of the Phase 2A state.

What exists (at Phase 2A): `/healthz` and `/readyz` answer exactly one `status` field (pinned by the health
tests); the drain worker's heartbeat port carries a worker id and a time, no build; `LEASEOS_RELEASE`
is a file in the repository read by the current-state generator; `deviceRouter.appVersion` describes
mobile devices, not server instances. No table, log line or endpoint reports which build a running
server or worker instance is on.

Therefore the preflight's `fleet` component is `{ state: "not_provable", reason }`, it has **no input**
that can mark the fleet compatible (S2E2-T17, structural and behavioural; mutation M10 caught), and
`cutoverAllowed` cannot be true from current code. The human confirmation block in
`WEBHOOK_SECRET_PHASE1_DEPLOYMENT_EVIDENCE.md` remains where a person records what they established
and how; it is not an input to the preflight.

**Smallest mechanism, proposed only (not implemented):**

1. Build identity: a `server/_core/buildIdentity.ts` whose value is defined at build time
   (`esbuild --define` from the commit SHA, falling back to `LEASEOS_RELEASE`), present in both
   bundles; in development, the SHA of the working tree.
2. Observation: a `runtimeInstances` table — `instanceId`, `role` (`server` | `worker`), `build`,
   `capabilities` JSON (e.g. `["webhook.secretRef"]`), `firstSeenAt`, `lastSeenAt` — written by the
   server from `startup.ts` and by the worker through the existing heartbeat port, every N seconds.
   One migration; slot scan required before claiming it.
3. The fleet component: `compatible` when every instance seen within 3×N declares
   `webhook.secretRef`; `incompatible` when any live instance lacks it; `not_provable` when the
   table is empty or any instance is stale. Nothing else changes.

## 7. Managed key provider — not implemented

| Question | Answer |
|---|---|
| Provider in development | `environmentSecretKeys()` → `createEnvironmentKeyProvider(config)`, `kind: "environment"` |
| Provider in tests | the same, plus test-local managed-shaped fakes (separate implementations of `SecretKeyProvider`) |
| Provider constructed in production today | the same environment provider — `portalRouter.ts`, `_core/trpc.ts`, `webhookDispatchService.ts` all call `environmentSecretKeys()` |
| Real managed KMS / Key Vault / Vault implementation | **none exists in the repository** |
| Production `WEBHOOK_SECRET` active key configured | not evidenced — `LEASEOS_KEY_WEBHOOK_V1` provisioning is the live P3 prerequisite and the deployment evidence form is blank; this session has no access to production configuration |
| Active key id | `webhook-v1` when `LEASEOS_KEY_WEBHOOK_V1` is set |
| Retired decrypt-only keys | supported by the interface (`getDecryptKey`) and the envelope (`keyId` bound in AAD); the environment provider builds none today |
| Can the process decrypt existing `WEBHOOK_SECRET` envelopes | yes, wherever the key is held — decrypt is permitted under any provider kind (A19) |
| Can it create a production `WEBHOOK_SECRET` without the refusal | **no** — `guardProductionWrites` refuses `isProduction && kind === "environment"`; S2E2-T12 proves it through the probe and through the real store (no row written) |

Hardening made in 2A: `createEnvironmentKeyProvider` no longer accepts a `kind` option. The only
code path by which environment-held material could be reported as `"managed"` is gone;
`guardProductionWrites` is unchanged. A structural test pins that no production source constructs a
provider claiming to be managed (mutation M12 caught).

## 8. Production preflight

`probeSecretWrite` (store) / `probeWebhookCanonicalWrite` (service) encrypt and decrypt a throwaway
value under a throwaway reference with `isProduction: true`, persisting nothing. Proven: managed
provider with an active `WEBHOOK_SECRET` key → possible under `webhook-v1`, a real `createSecret`
yields a `sec_` reference whose envelope begins `v1.WEBHOOK_SECRET.webhook-v1.` and which the
resolver reads back with **no legacy key** (S2E2-T13). Refused, fail closed, reported not thrown:
environment provider (T12), no active key (T14), wrong purpose only, provider that cannot decrypt its
own active key, provider unavailable.

## 9. Preflight result on this repository

| Component | Result |
|---|---|
| Fleet | **not provable** — no runtime build identity is observable |
| Webhook data | ready on a clean tenant after the backfill; not ready wherever enabled legacy-only or both-null rows remain |
| Managed key provider | **not ready** — `kind: "environment"`; no managed implementation exists |
| Existing canonical secrets | resolvable where references are intact; each broken one named by category |
| Production canonical write | **refused** — `secret write refused: production requires a managed key provider` |
| `cutoverAllowed` | **false**; `blockers` lists each of the above independently |

**OUTCOME B — BLOCKED.** Primary blocker, in dependency order: no managed production key provider
exists, so neither the Phase 1 backfill nor an E-C write can happen in production; fleet convergence
is not observable; production `LEASEOS_KEY_WEBHOOK_V1` provisioning is not evidenced.

**Narrowest next checkpoint:** *S2-F — managed key provider: a `SecretKeyProvider` implementation
whose material is held by a managed key system, wired by configuration in production only*, followed
by *S2-E Phase 2A.1 — runtime build-identity observation* (§6), and the operator evidence for
`LEASEOS_KEY_WEBHOOK_V1`. Only then does S2-E Phase 2B (E-C canonical-only writes) become eligible.

## 10. E-C delta — designed, not implemented

`webhookSubscribe` changes from *generate → `encryptSecret(secret, mfaKey())` → write `secretEnc`*
to *generate → `createSecret({ purpose: "WEBHOOK_SECRET", plaintext, keys, isProduction, provenance })`
→ write `secretRef`, `secretEnc: null` → return the plaintext once*. The call moves into
`webhookSecretService` (a router never names `secretRef` or imports the store — pinned); the router
drops its `mfaKey()` precondition for creation only; response shape, headers, HMAC algorithm and the
five-minute tolerance are unchanged; no dual-write; no rotation API. The structural pins that will
have to change, deliberately and visibly: E4/E5/E30 in `secretBoundary.test.ts` and the creation
check in `webhookCutoverPreflight.test.ts`. Preconditions: every component in §9 ready.
