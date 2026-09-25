# S2-E — webhook secret migration: implementation plan

Companion to `WEBHOOK_SECRET_MIGRATION_DESIGN.md`. **Nothing here is implemented.** Each checkpoint
is separately reviewable and separately revertible.

---

## Preconditions — none of this starts until all four hold

| # | Precondition | Why |
|---|---|---|
| P1 | **OD-E2 answered** (retry signing rule) | It decides whether deliveries need a signing-ref column and how long `previous` must live. Getting it wrong means migrating live signing secrets under a contract nobody agreed. |
| P2 | **OD-E1 answered** (`secretEnc NOT NULL` during rollout) | It decides whether E-A is a nullable-column migration or not. |
| P3 | **OD-E3 settled** (PR #20 ordering) | E-D/E-E modify the function #20 rewrites. |
| P4 | `LEASEOS_KEY_WEBHOOK_V1` provisioning agreed | New subscriptions fail closed without it, exactly as S2-D. |

P1 is the hard one. P3 can be worked around (design §2 fallback) but should not be by default.

---

## Decomposition

The brief proposes E-A … E-G. The survey suggests **one change**: split the rotation state machine
away from the storage migration entirely, and make it optional.

**Why.** S2-D proved that a storage migration which changes no secret value is invisible to its
consumers and therefore safe to ship alone. Rotation is the opposite: it is a coordinated protocol
change with a third party. Bundling them means the low-risk change waits for the high-risk one, and
the shared key cannot retire until both are done. If the goal is retiring `LEASEOS_PORTAL_MFA_KEY`
soonest, E-A…E-C plus guards is a complete, shippable unit (this is **OD-E5**).

### E-A — schema and compatibility reader
* Migration: `currentSecretRef varchar(64) NULL` on `webhookSubscriptions`; `pendingSecretRef` and
  `previousSecretRef` **only if OD-E5 keeps rotation in scope**; `rotationState` likewise.
* `webhookSecretService.ts`: `resolveSigningSecret(subscription, keys)` — ref present → resolve and
  fail closed; ref absent → legacy decrypt. The single call site #20's rebase would move.
* No CHECK constraint (all column combinations legal during a rolling deploy — same reasoning as
  `0193`).
* Tests: E1, E6, E7, E8, E25. Mutations: ME1, ME3.

### E-B — new writes canonical
* `webhookSubscribe` stores under `WEBHOOK_SECRET` and links `currentSecretRef`.
* Legacy `secretEnc` written or not per **OD-E1**.
* Response shape unchanged — the plaintext is still returned exactly once.
* Tests: E4, E5, E20. Mutations: ME2, ME9.

### E-C — backfill and readiness
* `webhookSecretMigration.ts`, modelled on `mfaSecretMigration.ts`: batched, idempotent, resumable,
  read-back verified, fail-closed, counts-only reporting.
* **Per-batch progress break** — see design §8 and ME15.
* Readiness report spanning *both* classes, so the shared-key retirement question has one answer:
  legacy MFA remaining, legacy webhook remaining, canonical refs of each, invalid rows.
* Tests: E2, E3, E9, E10, E11, E12, E13, E23, E24. Mutations: ME4, ME11, ME12, ME15.
* **E3 is the keystone**: identical `(timestamp, body)` → byte-identical HMAC across the migration.

### E-D — rotation state machine *(only if OD-E5 keeps it in S2-E)*
* `prepare` / `activate` / `retire` / `rollback`, atomic guarded transitions, new `integration.*`
  permissions.
* Tests: E14, E15, E16, E17, E26, E27. Mutations: ME5, ME6, ME14.

### E-E — retry and signing-version integration *(depends on OD-E2)*
* Under **B**: record `signingSecretRef` on the delivery row, audit-only.
* Under **A**: the signer resolves the recorded ref, and `previous` retention extends past the
  ≈14.6-hour retry horizon.
* Tests: E28, E29. Mutations: ME7, ME13.

### E-F — structural and leakage guards
* Extend `secretBoundary.test.ts`: `webhookSecretService` joins the named store importers (a
  deliberate line, as S2-D's did); no router resolves a signing secret inline; no secret in logs,
  audit or delivery rows.
* Tests: E18, E19, E21, E22, E30. Mutations: ME8, ME10.

### E-G — full verification
* Focused suites, existing integration/webhook suites, S1, S2-A…S2-D, typecheck, build, full
  clean-DB gate, remote CI on the pushed SHA.
* Local MariaDB is unreliable (issue #46) — verify service health first, use a unique disposable
  database, and compare any failure against unmodified `main` before calling it environmental.

---

## Migration number

**Next safe number: `0194`.**

Scanned at `main` = `d94da0e`: `main`'s head is `0193`; across **every remote branch** the highest
claimed anywhere is `0193`; nothing `≥0194` exists on any branch or open-PR head. PR #20's `0185`
is free on `main` (which carries no `018x` at all) and does not affect this.

**Re-scan immediately before writing the file** — this number is only as current as the scan.

### A gap to correct

`docs/architecture/MIGRATION_COLLISION_REGISTER.md` is the repository's convention for recording
claimed numbers. **`0191`, `0192` and `0193` were never added to it** — an omission in S2-A/B/C and
S2-D. E-A should record all four (0191–0194) in the same commit that claims 0194, so the register
becomes accurate rather than accumulating a longer gap.

---

## Test and mutation counts

| Checkpoint | Tests | Mutations |
|---|---|---|
| E-A | 5 | 2 |
| E-B | 3 | 2 |
| E-C | 10 | 4 |
| E-D | 6 | 3 |
| E-E | 2 | 2 |
| E-F | 5 | 2 |
| **Total** | **31** | **15** |

Storage-only scope (E-A/B/C/F, dropping E-D/E-E per OD-E5): **23 tests, 10 mutations.**

---

## What this plan deliberately does not do

* No change to the external signature protocol: same algorithm, same `timestamp.body`
  canonicalisation, same headers, same 300-second tolerance.
* **No second signature header.** Storage `keyId` is LeaseOS's internal concern; a receiver has no
  business knowing it. If an *external* secret-version identifier would genuinely help coordinated
  rotation, that is a separate versioned-protocol task with its own compatibility analysis.
* No secret-reveal endpoint. The plaintext is returned once at creation and is unrecoverable — a
  property the canonical store makes technically reversible, which is exactly why E20 tests its
  absence rather than relying on nobody having added one.
* No forced rotation for existing consumers. Storage migration preserves the secret value; §7 of
  the design is the line this plan holds.
* No removal of `LEASEOS_PORTAL_MFA_KEY`, and no removal of the legacy readers. Both are later
  operational checkpoints gated on the readiness report.
