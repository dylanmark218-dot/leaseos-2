# S2-E — implementation plan (storage migration only)

Companion to `WEBHOOK_SECRET_MIGRATION_DESIGN.md`. **Nothing here is implemented.**

Scope per **OD-E5**: move webhook signing secrets off the shared key into canonical
`WEBHOOK_SECRET` storage. **No rotation API.** Each checkpoint is separately reviewable and
separately revertible.

---

## 1. Frozen pre-S2-E state

Frozen at the SEC-004 merge. Implementation starts from **exactly this state**, not from "current
`main`", so that any later divergence is visible rather than absorbed.

| | |
|---|---|
| `main` SHA | `2fbba6cdc2647db44b4667941282c6710047f89b` (PR #20 merge) |
| Migration head | `0193_mfa_secret_ref.sql` |
| Migration count | **175** |
| Table count | **413** |
| Test files / cases | **345 / 4722** |
| Next free migration number | **`0194`** — free on `main` and on every remote branch at this scan; **re-scan at claim time** |
| Known unrelated failure | `widgetPersistence.db.test.ts`, local timeout only — issue #46. Remote CI passes it on `main`. **Not S2-E's, and not to be "fixed" inside S2-E.** |

---

## 2. Preconditions

| # | Precondition | State |
|---|---|---|
| P1 | OD-E1 … OD-E5 settled | ✅ settled |
| P2 | SEC-004 (PR #20) merged | ✅ `2fbba6c` |
| P3 | `LEASEOS_KEY_WEBHOOK_V1` provisioning agreed | ⚠ **operational — must be provisioned before phase 3, and before phase 1 in any environment where a new subscription might be created** |
| P4 | Register corrected (`0191`–`0193`, `0185` collision) | ✅ landed with the SEC-004 reconciliation |

P3 is the one live prerequisite. It mirrors S2-D's `LEASEOS_KEY_MFA_V1`: creation fails closed
without it, by design, and that must not be softened.

---

## 3. Checkpoints

Each maps to a rollout phase in design §4. **The phase boundaries are deployment boundaries** — E-A
and E-C must not ship together, or the expand/cutover guarantee is lost.

### E-A — expand: schema + compatibility reader *(deployment 1)*

* Migration: add `webhookSubscriptions.secretRef varchar(64) NULL`; relax `secretEnc` to `NULL`.
  Record the number in `MIGRATION_COLLISION_REGISTER.md` **in the same commit**.
* Replace the body of `secretFor()` with the compatibility resolver: `secretRef` first, fail closed
  on a present-but-broken ref; legacy only when the ref is **absent**.
* **No write-path change.** Creation still writes legacy `secretEnc` only.
* New module `server/webhookSecretService.ts` so the resolver has one home, joining the named store
  importers in `secretBoundary.test.ts` — a deliberate line, as S2-D's was.
* Tests: E1, E6, E7, E8, E9, E24, E30. Mutations: ME1, ME3, ME12.

**Why no write change here:** a canonical-only row must be impossible until every instance can read
one. E30 pins that E-A produces none.

### E-B — backfill + readiness *(operational, after phase 2 convergence)*

* `server/webhookSecretMigration.ts`, modelled on `mfaSecretMigration.ts`: bounded, idempotent,
  resumable, read-back verified byte-identical, fail-closed, counts-only reporting, legacy retained.
* **Per-batch** no-progress break (design §6).
* Readiness report spanning **both** secret classes, so design §9's conjunction has one answer.
* Tests: E2, E3, E10, E11, E12, E13, E14, E22, E23. Mutations: ME4, ME9, ME10, ME11.
* **E3 is the keystone**: identical `(timestamp, body)` → byte-identical HMAC across the migration.

### E-C — cutover: canonical writes *(deployment 2)*

* `webhookSubscribe` writes canonical only — `WEBHOOK_SECRET`, `secretRef` set, `secretEnc` left
  NULL. Response shape unchanged; plaintext still returned exactly once.
* **Gated on phase 2 being confirmed**, not assumed.
* Tests: E4, E5, E19. Mutations: ME2, ME7.

### E-D — dispatch and signing verification

* Prove the post-SEC-004 dispatch path resolves through the single compatibility service, for
  canonical, legacy and transitional rows alike.
* **The mandatory acceptance test** (design §11) lands here: secret A → failed attempt → secret
  changed to B → retry and reclaim both verify under B, not A, without consulting the recorded
  signature.
* Tests: E15, E16, E17, E18, E21, E26, E27, E28, E29. Mutations: ME5, ME6.

### E-E — legacy cleanup readiness

* Operational report: legacy-only, transitional, canonical-only, invalid, plus S2-D's remaining
  legacy MFA.
* **Does not clear anything.** Clearing `secretEnc` is a separate, separately-approved checkpoint.
* Tests: E22 (extended). Mutations: none.

### E-F — structural and leakage guards

* No raw secret in responses, logs, audit or delivery rows.
* **No new legacy writer after cutover** — the guard that keeps E-C from being undone.
* No `MFA_SECRET` purpose from webhook code.
* No direct legacy decrypt outside the compatibility boundary.
* Tests: E20, E25. Mutations: ME8.

### E-G — full verification

Focused suites, webhook/integration suites, SEC-004's claim suite, S1, S2-A…S2-D, typecheck,
`git diff --check`, migration parity, build, full clean-DB gate, remote CI on the pushed SHA.

Verify DB health first and use a unique disposable database — issue #46 stands, and any failure is
compared against unmodified `main` before being called environmental.

---

## 4. Deployment sequence — the part that must not be reordered

```
E-A  ──deploy──►  phase 1: every instance reads both; nothing writes canonical
                      │
                      ▼
                  phase 2: CONFIRM fleet convergence   ← operational gate, not a commit
                      │
E-C  ──deploy──►  phase 3: creation writes canonical only
                      │
E-B  ──run────►   phase 4: backfill legacy rows (may also run earlier; catches phase-3 stragglers)
                      │
E-E  ──report─►   phase 5: prove legacyOnly = 0 → remove legacy write → later, legacy read
```

**The invariant:** no deployment ever writes a representation an already-running instance cannot
read. Shipping E-A and E-C together breaks it — a canonical-only row could reach an instance that
only understands `secretEnc`. ME12 exists to make that failure visible in CI rather than in
production.

---

## 5. Counts

| Checkpoint | Tests | Mutations |
|---|---|---|
| E-A | 7 | 3 |
| E-B | 9 | 4 |
| E-C | 3 | 2 |
| E-D | 9 | 2 |
| E-E | 1 | 0 |
| E-F | 2 | 1 |
| **Total** | **30** (E1–E30, some spanning checkpoints) | **12** (ME1–ME12) |

---

## 6. Acceptance gate — required before implementation is accepted

0. **The mandatory acceptance test, stated in full**, because it is the one that turns OD-E2 from an
   observation into a permanent regression barrier:

   > Create a webhook subscription under secret **A**. Let attempt 1 fail. Change the
   > subscription's stored secret to **B**. Let the delivery retry, and separately let a claim
   > expire and be reclaimed. Prove the outbound request of each later attempt verifies under **B**
   > and **not** under A, and that the signature recorded with the earlier attempt was not
   > consulted.

   Two cases, not one: `reclaimExpiredAttempt` is a distinct code path that also re-signs
   (design F4), and a freeze could survive in one while the other stayed correct. Both assert by
   **identity** — verification under A must *fail* — so a silent freeze cannot pass by accident.

1. **The mandatory acceptance test passes** on both paths, asserting by identity that verification
   under the superseded secret **fails**.
2. **E3 passes**: byte-identical HMAC across the storage migration — no receiver reconfigures.
3. **E30 and ME12 pass**: E-A produces no canonical-only row, and a phase-3-without-phase-1
   deployment is caught.
4. **All 12 mutations caught**, files restored byte-for-byte and verified by checksum.
5. Full clean-DB gate green except the known #46 timeout, and **remote CI green on the pushed SHA**.
6. The migration number is recorded in the register **in the commit that claims it**.

---

## 7. What this plan deliberately does not do

* **No dual-write.** OD-E1. New secret material is never encrypted under the shared key during the
  migration window.
* **No `signingSecretRef` as signing authority.** OD-E2. Metadata only, if ever.
* **No `pendingSecretRef` / `previousSecretRef` / `rotationState`.** OD-E4. Schema for an API that
  does not exist is schema that will be wrong when the API arrives.
* **No rotation API.** OD-E5.
* **No external protocol change.** Same algorithm, canonicalisation, headers, tolerance. No second
  signature header.
* **No secret-reveal endpoint.** The plaintext is returned once at creation and is unrecoverable —
  a property the canonical store makes technically reversible, which is exactly why E20 tests its
  absence rather than relying on nobody having added one.
* **No clearing of `secretEnc`**, and **no removal of `LEASEOS_PORTAL_MFA_KEY`**. Both are later
  operational checkpoints, and the key cannot go while the MFA compatibility reader needs it.
* **No fix for issue #46** inside this branch.
