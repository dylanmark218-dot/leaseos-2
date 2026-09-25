# S2-E — webhook signing secret migration

Survey and design. **No production code is proposed for implementation until this is approved.**

Surveyed against `main` at `d94da0e` (the S2-D merge). Every claim below is cited to a file and
line read during the survey; nothing here is inferred from a name.

---

## 0. The one sentence that makes this different from S2-D

An MFA seed protects an **inbound** check LeaseOS performs on itself. A webhook secret signs
**outbound** messages a *third party* verifies. Nothing about an MFA seed's storage is observable
outside LeaseOS; a webhook secret's behaviour is a contract with someone else's code, running on
someone else's schedule, which we cannot deploy.

That asymmetry is why storage migration and credential rotation must stay separate here, and why
the retry question in §9 is the decision that has to be settled before any code is written.

---

## 1. Current webhook flow

### 1.1 Creation — `server/integrationRouter.ts:126-139`

`webhookSubscribe`, gated by `roleProcedure("integration.webhookSubscribe")`.

```
secret        = randomBytes(32).toString("base64url")     // 43 chars
subscriptionRef = ref("WH")
insert webhookSubscriptions { orgRef, subscriptionRef, name, url,
                              secretEnc: encryptSecret(secret, mfaKey()), … }
return { subscriptionRef, secret, note: "Shown once. …" }
```

Three facts that constrain the design:

* The plaintext secret is returned **exactly once**, at creation, and never again. There is no
  "show secret" endpoint anywhere in the router — confirmed by reading every procedure in
  `integrationRouter.ts`.
* `mfaKey()` (`server/_core/externalIdentityPolicy.ts:64`) reads `LEASEOS_PORTAL_MFA_KEY`. The same
  function and the same key protect MFA seeds. This is the defect S2 exists to undo.
* `https` is enforced at creation (`integrationRouter.ts:133`), URL only.

### 1.2 Storage — `drizzle/schema.ts:5570-5581`

```
webhookSubscriptions
  secretEnc   varchar(400) NOT NULL        -- iv.tag.ct, base64, legacy envelope
  status      enum('active','paused','revoked') default 'active'
  url, name, eventTypesJson, orgRef, subscriptionRef, createdByUserId, createdAt
```

`secretEnc` is `NOT NULL`. That matters: unlike `mfaSecretEnc`, it cannot simply be nulled after
migration without a schema change, and a new subscription cannot be created without writing
*something* into it. §7 addresses this directly — it is the sharpest difference from S2-D.

### 1.3 Signing — `server/_core/integrationGateway.ts:17-25`

```
signPayload(secret, timestamp, body) = HMAC_SHA256(secret, `${timestamp}.${body}`) → hex
```

Headers sent (`webhookDispatchService.ts:50`):

| Header | Value |
|---|---|
| `x-leaseos-timestamp` | `Math.floor(now/1000)`, seconds |
| `x-leaseos-signature` | the hex HMAC |
| `x-leaseos-event` | event type |
| `x-leaseos-delivery` | `${subscriptionRef}:${eventId}:${attempt}` |

`verifySignature` enforces a **300-second** tolerance and compares with `timingSafeEqual`.
The documented consumer contract is in the creation response itself: *"Verify deliveries with
HMAC-SHA256 over `timestamp.body` using this secret; reject timestamps older than five minutes."*

### 1.4 Delivery and retry — `server/webhookDispatchService.ts:23-67`

`dispatchWebhooks` is the only sender. Per active subscription, per outbox event:

1. tenant check — `ev.tenantId !== s.orgRef` skips (`:40`);
2. event-type match (`:41`);
3. prior attempts read, newest first (`:42`);
4. `delivered`/`dead` → skip; `failed` before `nextAttemptAt` → skip (`:44-45`);
5. `attempt = last.attempt + 1` (`:46`);
6. body rebuilt from the outbox row (`:47`);
7. **`timestamp = now`** (`:48`);
8. **`signature = signPayload(secret, timestamp, body)`** (`:49`);
9. POST; a `webhookDeliveries` row is inserted recording `signature` and `requestHash` (`:52`).

`sweepWebhookRetries` (`:60-66`) collects `status='failed'` event ids and calls
**`dispatchWebhooks` again** — the identical path.

Backoff `1, 5, 30, 120, 720` minutes, `MAX_ATTEMPTS = 6`
(`integrationGateway.ts:13-15`). Full horizon: 876 minutes ≈ **14.6 hours**.

### 1.5 The three findings that decide the design

**F1 — a retry re-signs from scratch with the secret that is current at retry time.**
`dispatchWebhooks` re-reads subscriptions (`:29-31`) and decrypts per subscription (`:37`) on every
invocation, including sweeps. There is no frozen signing state.

**F2 — the stored signature is never read back.** `webhookDeliveries.signature` is written at `:52`
and read nowhere. Every other `.signature` reference in the repository belongs to field-ticket or
device-package signing — verified by reading each hit. So retries cannot and do not reuse it.

**F3 — the 300-second tolerance makes signature reuse impossible anyway.** Retries occur 1 to 720
minutes later; the original timestamp would be outside tolerance and refused. Since the HMAC covers
`timestamp.body`, a fresh timestamp *compels* a fresh signature. **"Replay the original signed
bytes" is not an option the protocol permits.** The only live question is *which secret* signs the
fresh timestamp — §9.

### 1.6 Rotation today

**There is none.** No procedure changes `secretEnc` after creation; `webhookSetStatus` changes only
`status`. Re-subscribing is the only way to obtain a new secret, and it produces a *different*
`subscriptionRef`, so it is not rotation — it is replacement, and the consumer must be reconfigured
with both a new URL target and a new secret.

---

## 2. PR #20 interaction — recommendation: **D, #20 merges first**

[PR #20](https://github.com/dylanmark218-dot/leaseos-2/pull/20) — *"security: make webhook delivery
claiming atomic"*, branch `claude/sec-004-webhook-delivery-integrity`, head `1df0516`, base
`6f52b57`.

**Overlap, by measurement:** it changes `server/webhookDispatchService.ts` by **+182/−12** — the
exact function S2-E must modify. It decomposes the send into `claimNewAttempt`,
`reclaimExpiredAttempt`, `finishClaimedAttempt`, adds migration `0185` (`claimedAt`, `claimedBy`),
a 5-minute claim lease, and `WEBHOOK_ATTEMPT_TIMEOUT_MS`.

**It also changes secret-handling directly.** Its own description: *"One subscription whose secret
could not be decrypted aborted webhook dispatch for every tenant, because all secrets were
decrypted up front. Now a secret is decrypted only when needed, and a failure skips just that
subscription."* That is precisely the failure semantic S2-E's fail-closed rule must define. Two
independent designs of the same behaviour would be a merge conflict with a security consequence.

**Recommendation — D: PR #20 merges before S2-E implementation begins.** Not merely "branch after".
S2-E's read path is a modification of the function #20 rewrites; building it on the current
`dispatchWebhooks` would mean writing code against a loop that is being replaced, then resolving a
conflict in a signing path, which is the worst place to resolve one.

**But #20 is not mergeable as it stands, and this is not S2-E's to fix:**

* its base `6f52b57` is **80 commits behind** current `main`;
* `mergeable_state` reads `unknown`;
* its gate evidence is from `1df0516` — 335 test files, 410 tables, 170 migrations — against a
  `main` that now has **344 files, 413 tables, 174 migrations**. That evidence is stale.

Its migration `0185` is **still free on `main`** (verified: `main` carries no `018x` migration at
all), so no renumber is forced by `main`. It may collide with other open branches, which the
collision register is the place to settle.

**Sequencing proposed:** #20 refreshed against `main` and merged → S2-E branches from that →
S2-E's read path is written against the claim/send/finish decomposition from the start.

**If #20 will not land soon**, the fallback is S2-E built on today's `dispatchWebhooks` with the
secret resolution isolated behind one function (`resolveSigningSecret(subscription)`) so that #20's
rebase has exactly one call site to move. That is second-best and should be a deliberate choice,
not a default.

---

## 3. Legacy storage and what still depends on the shared key

`webhookSubscriptions.secretEnc`, AES-256-GCM, envelope `iv.tag.ct` (base64), under
`LEASEOS_PORTAL_MFA_KEY`.

**Webhook secrets are NOT the only remaining production user of that key.** Complete list of
call sites reading the key's *material* on `main` at `d94da0e`:

| Site | Purpose | Retires when |
|---|---|---|
| `integrationRouter.ts:131` | encrypt a new webhook secret at subscribe | S2-E ships new-write |
| `webhookDispatchService.ts:26` | decrypt to sign | S2-E backfill completes + reader removed |
| `mfaSecretService.ts` via `legacyMfaKey()` | decrypt **un-migrated** MFA seeds | MFA cutover completes |
| `_core/externalIdentityPolicy.ts:64` | the `mfaKey()` accessor itself | last consumer goes |

So retirement needs **legacy MFA = 0 AND legacy webhook = 0 AND both compatibility readers
removed** — exactly the conjunction §13 requires. S2-E alone does not retire the key.

---

## 4. Target storage

Canonical: `encryptedSecrets`, purpose **`WEBHOOK_SECRET`**, through the S2-A key provider
(`LEASEOS_KEY_WEBHOOK_V1`, already named in `_core/secretKeys.ts` and in the env inventory).
Never `MFA_SECRET`. Never a new value written into `secretEnc`.

### 4.1 Proposed fields — deliberately fewer than the brief suggests

The brief offers `currentSecretRef` / `pendingSecretRef` / `previousSecretRef` and instructs not to
adopt them until the runtime survey proves which states are required. The survey (F1–F3) says:

* **`currentSecretRef` — required.** The signer.
* **`pendingSecretRef` — required.** Staged rotation needs a replacement that exists but does not
  sign, or "prepare" and "activate" collapse into one step.
* **`previousSecretRef` — required, but NOT for signing.** See §9: under the recommended retry rule
  LeaseOS never signs with it. It exists so activation is reversible, and so the readiness report
  can show what a receiver may still be accepting.

Plus `rotationState` and timestamps, so the state machine is inspectable rather than inferred from
which columns are null.

### 4.2 Transitional states

| State | `secretEnc` | `currentSecretRef` | Meaning |
|---|---|---|---|
| legacy | set | NULL | not yet migrated |
| migrated | set | set | migrated, inside rollback window |
| new | set¹ | set | created after S2-E |
| — | NULL | any | **impossible**: `secretEnc` is `NOT NULL` |

¹ **The `NOT NULL` problem.** Unlike `mfaSecretEnc`, `secretEnc` cannot be left empty. A new
subscription must write something. Three options, with the recommendation:

* **(a) Make it nullable in the same migration.** Cleanest end state. But during a rolling
  deployment the *old* code still `INSERT`s without it and still reads it unconditionally
  (`webhookDispatchService.ts:37`) — a row with `NULL` would throw in the old version. Rejected for
  the rollout window.
* **(b) Keep `NOT NULL`; new subscriptions write a tombstone sentinel.** A non-secret marker such
  as `"migrated:v2"` that the legacy decrypt path would fail on. Rejected: it is a value that looks
  like ciphertext and is not, and the old code would fail confusingly rather than clearly.
* **(c) ✅ Keep `NOT NULL` and keep writing real legacy ciphertext during the compatibility
  window, while ALSO writing the canonical ref.** New subscriptions are "migrated" from birth. The
  old deployed version keeps working unchanged; the new version prefers the ref. The legacy column
  is dropped to nullable and cleared in the same later checkpoint that clears migrated rows.

(c) conflicts with the brief's §10 ("should not create fresh legacy `secretEnc` values") and that
conflict is **a genuine owner decision — see §18 OD-E1.** The brief's rule is right as an end
state; the question is whether it applies *during* the rollout window, when `NOT NULL` and the old
reader are both still live. Recommending (c) for the window and the brief's rule immediately after.

---

## 5. Runtime read behaviour

Identical in shape to S2-D, because the hazard is identical:

```
currentSecretRef present → resolve under WEBHOOK_SECRET; FAIL CLOSED on any failure
currentSecretRef absent  → decrypt secretEnc with the legacy key
neither usable           → this subscription sends nothing
```

**Never "resolve → catch → fall back to legacy."** If a canonical ref were present but unresolvable
and we fell back, whoever damaged the canonical record would choose which secret signs LeaseOS's
outbound traffic. Fallback is permitted only where the ref is *absent*.

**Scope of "fail closed" — one subscription, not the fleet.** Adopting PR #20's fix: a subscription
whose secret cannot be resolved is skipped and reported; other tenants' deliveries proceed. That is
still fail-closed in the sense that matters — **nothing unsigned is ever sent** — while not letting
one broken row silence every tenant.

---

## 6. Rotation state machine

```
        ┌──────────────────────────────── rollback ──────────────────────────┐
        ▼                                                                    │
   ┌─────────┐   prepare    ┌──────────┐   activate    ┌──────────┐   retire │
   │ STEADY  │ ───────────► │ PENDING  │ ────────────► │ OVERLAP  │ ─────────┴──► STEADY
   └─────────┘              └──────────┘               └──────────┘
   current signs            current STILL signs        current = new secret
   no pending               pending exists, silent     previous retained, never signs
```

| Transition | Who | Signs new deliveries | In-flight / queued | Retries | On failure | Audit |
|---|---|---|---|---|---|---|
| **prepare** | `integration.webhookRotatePrepare` (new) | unchanged `current` | unaffected | unchanged | nothing changes; pending discarded | `webhook.rotation.prepared` |
| **activate** | `integration.webhookRotateActivate` (new) | `pending` → becomes `current` | unaffected — queue holds no signed bytes, only outbox rows | **see §9** | atomic single `UPDATE`; either all three refs move or none | `webhook.rotation.activated` |
| **retire** | scheduled or explicit | `current` | — | — | idempotent | `webhook.rotation.previous_retired` |
| **rollback** | explicit, during OVERLAP only | `previous` → `current` again | unaffected | — | refuse if previous already retired | `webhook.rotation.rolled_back` |

**Exactly one CURRENT at all times.** `pending` is never consulted by the signer — that is what
makes "prepare" safe to do at any time, and it is what ME5 in §17 mutates.

**Activation is one atomic statement**, guarded on the expected `rotationState`, so two concurrent
activations cannot produce two CURRENTs (ME6).

---

## 7. Storage migration ≠ credential rotation

Kept rigidly separate, because conflating them would force every existing webhook consumer to
reconfigure merely because LeaseOS changed how it encrypts at rest.

| | Secret value | Consumer action | Mechanism |
|---|---|---|---|
| **Storage migration** | **unchanged** | **none** | backfill, §8 |
| **Credential rotation** | replaced | must be reconfigured | state machine, §6 |

E2/E3 in §16 are the tests that hold this line: the same `(timestamp, body)` must produce a
**byte-identical HMAC** before and after the storage migration.

---

## 8. Backfill

Directly analogous to `mfaSecretMigration.ts`, which is in production and mutation-tested:

1. select `secretEnc IS NOT NULL AND currentSecretRef IS NULL`, bounded by `batchSize`;
2. decrypt with the legacy key;
3. `createSecret({ purpose: "WEBHOOK_SECRET", provenance: { sourceTable: "webhookSubscriptions",
   sourceColumn: "secretEnc" } })`;
4. resolve it back and require **byte-identical**;
5. repoint `currentSecretRef`, guarded by `WHERE currentSecretRef IS NULL` so concurrent runs cannot
   both claim a row;
6. **leave `secretEnc` intact** — rollback path.

Idempotent and resumable by construction: a migrated row stops matching the predicate. No cursor,
no state table.

**Carry forward the defect S2-D's tests found:** the no-progress break must compare progress **per
batch**, not a running total. The first version of that loop compared the cumulative migrated count
against zero, so a batch with one healthy and one permanently-broken row spun on the broken row
forever. The same loop shape is proposed here, so the same bug is available to write again.

Refuses to start at all if either key is missing. Reports counts and subscription refs — never a
secret, never an envelope.

---

## 9. ⚠ Retry semantics — the decision this design turns on

**Question:** when attempt *n>1* is sent during or after a rotation, which secret signs it?

**What the protocol already forecloses.** Per F3, the 300-second tolerance versus a 1–720-minute
backoff means a retry *must* carry a fresh timestamp, and the HMAC covers the timestamp. Reusing
the originally signed bytes is impossible. The stored `signature` column cannot serve as a frozen
artefact, and F2 confirms nothing reads it. So the choice is only:

**Option A — freeze the *secret* at delivery creation.** Record `signingSecretRef` per delivery;
every retry resolves that ref.

* Requires `previous` to survive the **entire retry horizon** (≈14.6 h) plus any dead-letter
  requeue — so secret retirement becomes coupled to queue drain, a condition that is hard to
  observe and easy to get wrong.
* Produces a half-frozen contract: frozen secret, fresh timestamp. The delivery is immutable in one
  respect and not the other, which is the kind of distinction that gets lost in a later refactor.
* Genuine benefit: "which secret signed attempt 3" is answerable from the row, deterministically.

**Option B — the secret that is CURRENT at each attempt.** ✅ **Recommended.**

* **It is what the code does today** (F1). Changing it is itself a behaviour change to the outbound
  contract, which §8 of the brief rightly says should not ride along with a storage migration.
* Secret retirement depends only on the *coordination* window with the receiver, not on how deep
  the delivery queue happens to be.
* A receiver mid-rotation must accept either secret for a bounded window regardless — that is
  inherent to single-header staged rotation — and once it does, B is strictly simpler for it.
* Consequence worth stating plainly: during OVERLAP, attempt 1 of an event may be signed with the
  old secret and attempt 2 with the new one. This is safe because receivers verify **per request**;
  none caches "delivery X uses secret Y". But it must be documented in the rotation runbook, because
  it will look surprising in a receiver's logs.

**Recommended: B, plus record `signingSecretRef` on the delivery row for AUDIT only.** That keeps
A's forensic benefit — every attempt says which secret signed it — without making the recorded ref
an input to signing. E7/E16 pin that the recorded value is *observed*, never *consulted*; ME7
mutates exactly this by making the signer read it back.

**A consequence that simplifies §6:** under B, LeaseOS **never signs with `previous`**. So
`previous` exists only to make activation reversible and to tell an operator what a receiver may
still accept. If the owner prefers Option A, `previous` becomes load-bearing for signing and its
retention rule must change to "retry horizon + margin". **This is OD-E2 in §18 and should be
settled before any code is written.**

---

## 10. Create / update / disable

| Operation | Today | Under S2-E |
|---|---|---|
| **subscribe** | generate, encrypt to `secretEnc`, return plaintext once | generate, store canonically under `WEBHOOK_SECRET`, link `currentSecretRef`, **plus legacy ciphertext during the window** (§4.2c, OD-E1); return plaintext once, unchanged response shape |
| **URL / name / eventTypes update** | *no such procedure exists* | if added, **must not touch any secret ref** (E19) |
| **`webhookSetStatus`** | `active`/`paused`/`revoked` | unchanged; `revoked` is terminal and already refuses reactivation |
| **rotate prepare / activate** | — | new, §6 |

**No secret-reveal endpoint is proposed, and none exists today.** The plaintext is returned exactly
once at creation and is unrecoverable afterwards. That is a property worth preserving explicitly:
the canonical store *could* resolve it, which is precisely why the absence must be a tested
boundary (E20) rather than an accident of nobody having written the endpoint.

**Disable:** on `revoked`, the subscription must stop signing and stop delivering. `pending` and
`previous` refs should be disabled in the canonical store so nothing resolvable is left behind;
`current` is retained only as long as audit requires. ME8 mutates delivery-after-revoke.

---

## 11. Authorization

**Unchanged.** Webhook subscriptions are tenant resources under
`integration.webhookSubscribe` / `webhookSetStatus` / `webhookDispatch` / `deliveries`, scoped by
`resolveActingScope(...).tenantId`.

The two new rotation procedures should take **new `integration.*` permissions**
(`integration.webhookRotatePrepare`, `integration.webhookRotateActivate`), not
`secrets.platformCredentialManage`. The canonical store is infrastructure shared by several
domains; sharing storage must not merge authorization. A tenant administrator rotating their own
webhook secret is not exercising platform credential authority, and S2-3 forbids granting that to
any tenant role in any case.

---

## 12. Audit

Metadata only. Events: `storage_migrated`, `rotation_prepared`, `rotation_activated`,
`previous_retired`, `rolled_back`, `subscription_revoked`.

Each carries subscription ref, action, actor, timestamp, reason, and secret **reference**
identifiers. Never plaintext, never an envelope, never key material. `secretRef` is opaque and
carries no information about the value — that is why it is safe here and why it is still withheld
from ordinary listings.

---

## 13. Logging and redaction

Dispatch already records `error: r.error.slice(0, 400)` from the transport
(`webhookDispatchService.ts:52`) — a remote error string, stored and shown through
`integration.deliveries`.

* The signing secret must never reach a log, an error, an audit payload or a delivery row. A
  structural test should assert the dispatch path cannot interpolate it.
* Outbound `authorization`-style headers, if ever added, must be redacted before any capture.
* The HMAC itself is **not** the secret and is already stored (`signature` column). It stays, but
  should not be echoed into user-facing error text.

---

## 14. Failure semantics

Fail closed — send nothing for that subscription — when: the canonical ref is present but
unresolvable; the purpose is wrong; the webhook key is unconfigured; the legacy key is missing for
a legacy-only row; `pending` is missing at activation; the subscription is not `active`; signing
throws.

**Never send an unsigned or differently-signed webhook because secret resolution failed.**
Per §5, the blast radius is one subscription.

---

## 15. Deployment and cutover

1. Provision `LEASEOS_KEY_WEBHOOK_V1` **before** deploying — new subscriptions refuse without it,
   by the same fail-closed rule as `LEASEOS_KEY_MFA_V1` in S2-D.
2. Deploy. Existing subscriptions keep signing from `secretEnc`; nothing changes for consumers.
3. Run the backfill. Signatures remain byte-identical (E3), so no consumer notices.
4. Readiness reports `legacyOnly: 0` for webhooks.
5. Rollback window elapses.
6. Separate checkpoint: make `secretEnc` nullable and clear it.
7. Separate checkpoint: remove the legacy compatibility readers.
8. `LEASEOS_PORTAL_MFA_KEY` retires **only** once §3's conjunction holds — webhook *and* MFA.

Rotation (§6) is a per-subscription operational activity available after step 3, independent of the
cutover sequence.

---

## 16. Test plan — E1–E25 plus what the survey added

E1–E25 as specified in the authorization. The survey justifies adding:

* **E26** — a retry after `prepare` (not yet activated) still signs with `current`.
* **E27** — a retry after `activate` signs per the §9 rule, asserted by *identity* against both the
  old and new secret so a wrong choice names the value it returned.
* **E28** — `signingSecretRef` recorded on the delivery row matches the secret actually used, and
  changing the recorded value does **not** change what signs the next attempt (the audit-only
  property).
* **E29** — a fresh timestamp is used on every attempt, and the stored signature from attempt *n*
  is never reused for attempt *n+1*.
* **E30** — one subscription with an unresolvable secret does not stop another tenant's delivery
  (PR #20's fix, preserved).

E3 is the keystone: same `(timestamp, body)`, byte-identical HMAC across the storage migration.

## 17. Mutation plan

ME1–ME12 as specified, plus:

* **ME13** — the signer reads `signingSecretRef` back from the delivery row (converts recommended B
  into A silently) → E28 must fail.
* **ME14** — `prepare` writes `currentSecretRef` instead of `pendingSecretRef` → E14/E17 must fail.
* **ME15** — the backfill's no-progress break compares a cumulative total rather than per-batch
  progress → the mixed healthy/broken-batch test must hang or fail. This is the defect S2-D's suite
  actually caught; it is available to write again in the same loop shape.

---

## 18. Remaining owner decisions

Only questions the current code cannot answer.

**OD-E1 — may a new subscription write legacy `secretEnc` during the rollout window?**
`secretEnc` is `NOT NULL` and the currently deployed reader uses it unconditionally. §4.2 recommends
(c): keep writing it during the window so a rolling deployment is safe, then stop and clear it in
the cutover checkpoint. This deviates from the brief's §10 for the duration of the window only.
*Confirm, or choose (a) — make it nullable now and accept that an old instance reading a NULL row
throws during the rollout.*

**OD-E2 — retry signing rule: Option A or Option B?** §9 recommends **B** (current secret at each
attempt), matching today's behaviour, with `signingSecretRef` recorded for audit only. Option A
(freeze per delivery) couples secret retirement to queue drain over a ≈14.6-hour horizon.
*This is the decision that must be deterministic before live webhook secrets move.*

**OD-E3 — PR #20 ordering.** §2 recommends **D**: refresh and merge #20 first. Its base is 80
commits behind and its gate evidence is stale, so it needs work that is not S2-E's.
*Confirm the ordering, and who refreshes #20.*

**OD-E4 — `previous` retention window.** Under B, `previous` is only for rollback, so a short window
(hours) suffices. Under A it must exceed the retry horizon. Dependent on OD-E2.

**OD-E5 — is a rotation API in S2-E's scope at all?** §6 could be deferred to a later checkpoint,
leaving S2-E as storage migration only — which is the smaller, safer change and mirrors S2-D
exactly. *Recommended if the goal is to retire the shared key soonest.*
