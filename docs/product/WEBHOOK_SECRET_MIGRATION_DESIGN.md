# S2-E — webhook signing secret migration

**Approved design.** Scope is **storage migration only**: move webhook signing secrets off the
shared `LEASEOS_PORTAL_MFA_KEY` and into canonical `WEBHOOK_SECRET` storage, without changing any
customer's secret value and without a single receiver reconfiguring anything.

Surveyed against `main` after SEC-004 (PR #20) landed. Every claim is cited to a file and line read
during the survey; nothing here is inferred from a name.

Owner decisions **OD-E1 … OD-E5** are incorporated and marked where they bind.

---

## 0. The one sentence that makes this different from S2-D

An MFA seed protects an **inbound** check LeaseOS performs on itself. A webhook secret signs
**outbound** messages a *third party* verifies. Nothing about an MFA seed's storage is observable
outside LeaseOS; a webhook secret's behaviour is a contract with someone else's code, running on
someone else's schedule, which we cannot deploy.

That asymmetry produces the two rules this design exists to hold: **the secret value never changes**
(§7), and **no deployment ever writes a representation an already-running instance cannot read**
(§4).

---

## 1. Current webhook flow, after SEC-004

### 1.1 Creation — `server/integrationRouter.ts`

`webhookSubscribe`, gated by `roleProcedure("integration.webhookSubscribe")`:

```
secret = randomBytes(32).toString("base64url")            // 43 chars
insert webhookSubscriptions { secretEnc: encryptSecret(secret, mfaKey()), … }
return { subscriptionRef, secret, note: "Shown once. …" }
```

* The plaintext is returned **exactly once** and never again. There is **no secret-reveal endpoint**
  anywhere in the router — confirmed by reading every procedure.
* `mfaKey()` reads `LEASEOS_PORTAL_MFA_KEY` — the same key and the same function that protect MFA
  seeds. That collision is the defect S2 exists to undo.
* `https` is enforced at creation.

### 1.2 Storage — `drizzle/schema.ts`

```
webhookSubscriptions
  secretEnc   varchar(400) NOT NULL       -- iv.tag.ct, base64, legacy envelope
  status      enum('active','paused','revoked')
  url, name, eventTypesJson, orgRef, subscriptionRef, createdByUserId, createdAt
```

`secretEnc` is **`NOT NULL`**, unlike `mfaSecretEnc`. That single fact drives §4.

### 1.3 Signing — `server/_core/integrationGateway.ts`

```
signPayload(secret, timestamp, body) = HMAC_SHA256(secret, `${timestamp}.${body}`) → hex
```

Headers: `x-leaseos-timestamp` (seconds), `x-leaseos-signature`, `x-leaseos-event`,
`x-leaseos-delivery` (`subscriptionRef:eventId:attempt`). `verifySignature` enforces a **300-second**
tolerance with `timingSafeEqual`. Backoff `1, 5, 30, 120, 720` minutes, `MAX_ATTEMPTS = 6` — a
**14.6-hour** retry horizon.

### 1.4 Dispatch — claim → send → finish (SEC-004)

`dispatchWebhooks` re-reads active subscriptions on **every** invocation, and
`sweepWebhookRetries` calls that same function. Per subscription:

```ts
let secret: string | null | undefined;
const secretFor = () => {
  if (secret === undefined) {
    try { secret = decryptSecret(s.secretEnc, key); }
    catch { secret = null; console.warn(`[webhooks] ${s.subscriptionRef}: … skipped`); }
  }
  return secret;
};
```

then, per event:

```ts
const signingSecret = secretFor();
if (signingSecret === null) continue;              // this subscription only
const timestamp = Math.floor(now.getTime() / 1000); // FRESH
const signature = signPayload(signingSecret, timestamp, body);  // FRESH
// CLAIM  → claimNewAttempt | reclaimExpiredAttempt   (records requestHash + signature)
// SEND   → poster(...)                               (outside any transaction)
// FINISH → finishClaimedAttempt                      (guarded by claim token)
```

### 1.5 The findings the design rests on

**F1 — every attempt resolves the subscription's secret at send time.** The subscription row is
re-read per invocation and `secretFor()` decrypts from it. There is no frozen signing state.

**F2 — the recorded signature is never read back as authority.** `webhookDeliveries.signature` is
written by `claimNewAttempt` and `reclaimExpiredAttempt` and consulted nowhere. Every other
`.signature` reference in the repository belongs to field-ticket or device-package signing.

**F3 — the 300-second tolerance makes signature reuse impossible.** Retries land 1–720 minutes
later, so the original timestamp is outside tolerance, and the HMAC covers the timestamp.
**Replaying the original signed bytes is not an option the protocol permits.**

**F4 — a reclaimed attempt re-signs.** `reclaimExpiredAttempt` receives a freshly computed
`{ requestHash, signature, at }`. Even crash recovery signs with the current secret.

**F5 — an unreadable secret skips one subscription, not the fleet.** `secretFor()` catches and
returns `null`; the event loop `continue`s. Nothing unsigned is ever sent.

**F6 — `secretFor()` is the single seam.** One function, one call site. Replacing its body with the
compatibility resolver is the entire read-path change S2-E needs.

### 1.6 Rotation today

**There is none.** No procedure changes `secretEnc` after creation. Re-subscribing produces a
*different* `subscriptionRef`, so it is replacement, not rotation.

---

## 2. Owner decisions, and where they bind

| | Decision | Binds |
|---|---|---|
| **OD-E1** | Two-deployment expand/cutover. **No dual-write.** | §4 |
| **OD-E2** | Retries use the secret **current at retry time**. No `signingSecretRef` as signing authority. | §5 |
| **OD-E3** | PR #20 merges first. | done |
| **OD-E4** | No `pendingSecretRef` / `previousSecretRef` schema. | §3 |
| **OD-E5** | Rotation API deferred to its own checkpoint. | §8 |

**A correction to the previous revision of this document.** It recommended writing each new
subscription's secret into *both* representations during the rollout window, to satisfy `NOT NULL`
while the old reader was still live. That was wrong, and OD-E1 is the better answer: dual-writing
would mint **new** secret material encrypted under the very shared key this checkpoint exists to
escape, for the entire length of the window. The expand/cutover sequence in §4 achieves the same
rolling-deployment safety and never creates new legacy-encrypted material.

---

## 3. Target storage — the minimum that works

**One new field.** Per OD-E4, nothing speculative.

```
webhookSubscriptions
  secretEnc     varchar(400) NULL     -- was NOT NULL; legacy, read-only after cutover
  secretRef     varchar(64)  NULL     -- canonical: encryptedSecrets, purpose WEBHOOK_SECRET
```

No `pendingSecretRef`. No `previousSecretRef`. No `rotationState`. No signing-secret column on
`webhookDeliveries`. Those belong to the rotation checkpoint (§8) and would be schema for an API
that does not exist.

### 3.1 Legal states

| `secretEnc` | `secretRef` | State | Reachable from |
|---|---|---|---|
| set | NULL | **legacy** | before backfill |
| set | set | **transitional** | after backfill, inside the rollback window |
| NULL | set | **canonical** | phase 3 onward only |
| NULL | NULL | **invalid** on an enabled subscription → fail closed | never written |

**No CHECK constraint.** Three of the four combinations are legal and the fourth must fail at
resolve time with a reason, not at write time with a constraint violation — and a constraint that
forbade `NULL, NULL` would also have to be satisfied by both application versions during a rolling
deploy. Same reasoning as `0193`.

### 3.2 Why `secretEnc` becomes nullable in phase 1, not phase 3

The column must already be nullable *before* the first canonical-only row exists. Making it nullable
is safe in phase 1 precisely because **nothing writes NULL in phase 1** — old instances and phase-1
instances both still supply legacy ciphertext. The schema gains the capability one deployment before
anything exercises it. That ordering is the whole trick.

---

## 4. Rollout — expand, converge, cut over (OD-E1)

The invariant, stated once: **no deployment ever writes a representation that an
already-running instance cannot read.**

### Phase 1 — expand (deployment 1)

* Migration: add `secretRef`; relax `secretEnc` to `NULL`.
* `secretFor()` becomes the compatibility resolver (§5).
* **Writes are unchanged**: new subscriptions still create legacy `secretEnc` only.
* No canonical-only row exists yet.

Old instances still running are unaffected: every row still has `secretEnc`, which is all they read.

### Phase 2 — fleet convergence

* Deploy phase 1 everywhere. Confirm no pre-phase-1 instance remains.
* Both representations readable. Nothing has changed for any receiver.
* This phase is an **operational gate, not a code change** — and it is the phase that makes phase 3
  safe. It must be explicitly confirmed, not assumed from a deploy timestamp.

### Phase 3 — cutover (deployment 2)

* `webhookSubscribe` writes canonical only: `encryptedSecrets` under `WEBHOOK_SECRET`, `secretRef`
  set, **`secretEnc` left NULL**.
* First point at which a canonical-only row can exist — and by now every instance understands
  `secretRef`.
* During this rolling deploy, remaining phase-1 instances may still create legacy-only rows. Phase-3
  readers handle those through the legacy fallback. Both directions are covered.

### Phase 4 — backfill

* Convert legacy rows in bounded, idempotent, restart-safe batches (§6).
* Catches any straggler legacy rows created by phase-1 instances during the phase-3 rollout.
* Legacy ciphertext is **retained** — it is the rollback path.

### Phase 5 — contract

1. Prove `legacyOnly = 0`.
2. Remove legacy **write** code (already gone at phase 3; this is the structural guard that keeps it
   gone).
3. Later deployment: remove legacy **read** compatibility.
4. Only then may `LEASEOS_PORTAL_MFA_KEY` become removable — and only if §9's MFA conditions also
   hold.

Clearing `secretEnc` values is a **separate, separately-approved** checkpoint. Nothing in S2-E nulls
them.

---

## 5. Runtime read behaviour, and the retry rule (OD-E2)

`secretFor()` becomes:

```
secretRef present → resolve under WEBHOOK_SECRET; FAIL CLOSED on any failure
secretRef absent  → decrypt secretEnc with the legacy key
neither usable    → this subscription sends nothing
```

**Never "resolve → catch → fall back to legacy."** If a canonical ref were present but unresolvable
and we fell back, whoever damaged the canonical record would choose which secret signs LeaseOS's
outbound traffic. Fallback is permitted only where the ref is **absent**.

**Blast radius: one subscription** (F5), preserved from SEC-004.

### The retry rule

**Every attempt — first or retry — signs with the secret the subscription resolves to at that
moment.** This is what the code already does (F1, F4) and what OD-E2 approves.

* A retry must carry a fresh timestamp (F3), so the signed material is never frozen anyway.
* `webhookDeliveries.signature` is **not** signing authority (F2) and must never become one.
* **No `signingSecretRef` column is added.** If a later audit requirement needs "which secret
  produced attempt *n*", it may be recorded as non-secret metadata, but it must not influence signer
  selection.

The operational consequence, stated plainly because it will appear in a receiver's logs: if a
subscription's secret changes between attempt 1 and attempt 2 of the same event, those two attempts
carry signatures under different secrets. This is safe — receivers verify **per request**, and none
caches "delivery X uses secret Y" — but it belongs in the rotation runbook when §8 is built.

---

## 6. Backfill

Modelled on `mfaSecretMigration.ts`, which is in production and mutation-tested.

1. Select `secretEnc IS NOT NULL AND secretRef IS NULL`, bounded by `batchSize`.
2. Decrypt with the legacy key.
3. `createSecret({ purpose: "WEBHOOK_SECRET", provenance: { sourceTable: "webhookSubscriptions",
   sourceColumn: "secretEnc" } })`.
4. Resolve it back; require **byte-identical**.
5. Repoint `secretRef`, guarded by `WHERE secretRef IS NULL` so concurrent runs cannot both claim a
   row.
6. **Leave `secretEnc` intact.**

**Invariants:** idempotent and resumable *by construction* — a migrated row stops matching the
predicate, so no cursor or state table can desync. Refuses to start if either key is missing. Reports
counts and subscription refs only — never a secret, never an envelope.

**Carry forward the defect S2-D's tests caught:** the no-progress break must compare progress **per
batch**, not a running total. The first version compared the cumulative migrated count against zero,
so a batch holding one healthy and one permanently-broken row spun on the broken row forever. The
same loop shape is proposed here, so the same bug is available to write again — ME-extra in §11
plants exactly it.

---

## 7. Storage migration ≠ credential rotation

| | Secret value | Receiver action | Mechanism |
|---|---|---|---|
| **Storage migration** (this checkpoint) | **unchanged** | **none** | §6 |
| **Credential rotation** (§8, deferred) | replaced | must be reconfigured | later |

E3 is the keystone: the same `(timestamp, body)` must produce a **byte-identical HMAC** before and
after the storage migration. No customer rotates merely because LeaseOS changed how it encrypts at
rest.

---

## 8. Rotation — deferred (OD-E5)

Not in S2-E. A later dedicated checkpoint defines
`CURRENT → PENDING → ACTIVATE → PREVIOUS → RETIRE`, its bounded `PREVIOUS` retention, its
authorization, and its runbook — **on top of** the canonical storage this checkpoint delivers.

Deferring it shrinks the live-secret migration surface and lets the shared key retire sooner, which
is the actual security goal.

Under OD-E2 the future rotation design inherits a useful simplification: because LeaseOS always signs
with the current secret, `PREVIOUS` is needed for **receiver tolerance and rollback**, not for
LeaseOS's own signing. Its retention window is therefore a coordination question, not a function of
queue depth.

---

## 9. Legacy shared key retirement — the complete condition

`LEASEOS_PORTAL_MFA_KEY` may be retired only when **all** of the following hold:

**MFA (S2-D)**
1. backfill complete;
2. legacy MFA count = 0;
3. the deployed MFA reader no longer requires legacy decrypt.

**AND Webhooks (S2-E)**
4. backfill complete;
5. legacy webhook count = 0;
6. canonical-write cutover complete (phase 3 everywhere);
7. the deployed webhook reader no longer requires legacy decrypt.

Retirement is a later explicit operational checkpoint. **S2-E does not remove the variable**, and
cannot: the MFA compatibility reader still needs it for un-migrated identities.

The readiness report spans **both** classes, so this conjunction has one place to be answered.

---

## 10. Authorization, audit, logging, failure

**Authorization — unchanged.** Webhook subscriptions stay tenant resources under the existing
`integration.*` permissions, scoped by `resolveActingScope(...).tenantId`. Not
`secrets.platformCredentialManage`: the canonical store is shared infrastructure, and sharing
storage must not merge authorization.

**Audit — metadata only.** Events: `storage_migrated`, `subscription_revoked`. Subscription ref,
action, actor, timestamp, reason, secret *reference* identifiers. Never plaintext, never an
envelope, never key material.

**Logging.** Dispatch already stores `error: r.error.slice(0, 400)` from the transport and surfaces
it through `integration.deliveries`. The signing secret must never reach a log, an error, an audit
payload or a delivery row; a structural test asserts the dispatch path cannot interpolate it. The
HMAC itself is not the secret and is already stored.

**Fail closed** — send nothing for that subscription — when: `secretRef` present but unresolvable;
wrong purpose; the webhook key is unconfigured; the legacy key is missing for a legacy-only row; the
subscription is not `active`; signing throws. **Never send an unsigned or differently-signed webhook
because secret resolution failed.**

**Protocol unchanged.** Same algorithm, same `timestamp.body` canonicalisation, same header names,
same timestamp format, same 300-second tolerance. **No second signature header** — storage `keyId` is
LeaseOS's internal concern and a receiver has no business knowing it.

---

## 11. Tests and mutations

### The mandatory acceptance test

> **Create a webhook under secret A → attempt 1 fails → change the subscription's secret to B →
> retry/reclaim → prove the outbound request verifies under B and not under A, and that the
> previously recorded signature was not consulted.**

This is the test that turns OD-E2 from an architectural observation into a permanent regression
barrier. It must assert by **identity** — verifying under A must *fail* — so that a silent freeze
cannot pass it. It must exercise both the ordinary retry path and `reclaimExpiredAttempt`, since F4
is a separate code path that also re-signs. Since S2-E ships no rotation API, the test changes the
secret by writing the subscription directly, which is exactly what a future rotation will do.

### Tests — E1 … E25 (as approved), plus:

* **E26** — the acceptance test above, ordinary retry path.
* **E27** — the acceptance test above, `reclaimExpiredAttempt` path.
* **E28** — a fresh timestamp on every attempt; the stored signature from attempt *n* is never
  reused for *n+1*.
* **E29** — one subscription with an unresolvable secret does not stop another tenant's delivery
  (SEC-004's fix, preserved).
* **E30** — phase-1 behaviour: with the compatibility reader deployed, creation still writes legacy
  and **no canonical-only row is produced**.

### Mutations — ME1 … ME10 (as approved), plus:

* **ME11** — the backfill's no-progress break compares a cumulative total rather than per-batch
  progress → the mixed healthy/broken-batch test must hang or fail.
* **ME12** — phase 3 lands without phase 1 having been deployed (canonical-only row read by a
  legacy-only reader) → E30 must fail.

**Counts: 30 tests, 12 mutations.**

---

## 12. Migration number and the register

The next number is **re-scanned at the moment of claiming**, across `main`, every remote branch and
every open-PR head — never taken from a document.

**The register is part of the checkpoint, not an afterthought.** `0191`, `0192` and `0193` were
merged without being entered in `MIGRATION_COLLISION_REGISTER.md` — a bookkeeping defect from the S2
work, corrected during the SEC-004 reconciliation along with the `0185` double-claim. S2-E's
migration is recorded **in the same commit that claims the number**. These are precisely the
omissions that become painful several migrations later, when the register is the only record of
which numbers were verified free and when.

---

## 13. Remaining owner decisions

**None blocking.** OD-E1 … OD-E5 are settled and incorporated. The implementation plan carries the
acceptance gate; nothing in this design awaits an answer.
