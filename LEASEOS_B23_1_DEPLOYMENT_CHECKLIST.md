# LeaseOS B23.1 — deployment checklist

Migration **0170** changes who is allowed to do what. It is the only migration
in this repository that can take a working person's access away, and for one
category of user it is *designed* to.

Read §1 before scheduling anything.

---

## 1. The one thing to know first

0170 attributes every existing role grant to the company it speaks for. Where
that is unambiguous, nothing changes but the bookkeeping. Where it is
**ambiguous** — the holder already belonged to more than one organization —
the grant is **quarantined**: preserved in full, authorizing nowhere, until an
administrator re-grants it.

**Those people lose access at the moment the migration runs.** That is the safe
direction and it is deliberate: the alternative is guessing which employer's
authority to hand them, which is the bug the whole checkpoint exists to close.
But it is still an outage for them, and they should be told beforehand rather
than discovering it at 5am in a truck.

Run the diagnostic **before** you schedule the window. It tells you exactly who.

---

## 2. Pre-deployment

```bash
# 1. Back up. Authorization data is transformed in place; see §6 on rollback.
mysqldump --single-transaction --routines --triggers "$DB" > pre-0170.sql

# 2. Migration head and collision check.
ls drizzle/*.sql | sed 's|drizzle/||' | sort | tail -3      # expect 0170_...
pnpm exec vitest run server/migrationSlots.test.ts

# 3. Who is affected. Run against PRODUCTION, read-only.
DATABASE_URL=... bash scripts/role-grant-diagnostic.sh
```

The diagnostic on a pre-0170 database predicts the classification without
writing anything:

```
PREDICTED CLASSIFICATION (what 0170 will do — nothing is written by this script):
  A  one live membership     : N   (attributed — authority preserved, now scoped)
  B  several memberships     : N   (QUARANTINED — these lose access)
  C  no live membership      : N   (historical single tenant)
  F  malformed branch grant  : N   (QUARANTINED)

  Users who would be quarantined:
    userId=… role=… memberships=…
```

**Record the category-B and category-F counts.** They are your re-grant
worklist and your go/no-go conversation. If they are non-zero, tell those
people and their administrators before the window, not after.

---

## 3. Staging

```bash
DATABASE_URL=... bash scripts/ci-gate.sh
```

Gate **3b** builds the pre-0170 world in a scratch database, seeds a row of
every legacy shape, applies 0170 alone, and asserts what each row became —
32 assertions, including that no category gained cross-company authority.

Then, against a staging copy of production data:

```bash
bash scripts/apply-migrations.sh
bash scripts/role-grant-diagnostic.sh          # post-0170 shape
pnpm exec vitest run server/organizationScopedRoles.db.test.ts \
                     server/legacyGrantHardening.db.test.ts \
                     server/sessionWorkspace.db.test.ts
```

Check by hand:

- the post-migration counts match what the pre-migration run predicted
- `platform-wide (global) : 0` — the backfill creates none
- a dual-employed person sees a different workspace menu per organization
- `records.roles.bootstrapStatus` reports `platformWideGrants: 0`

---

## 4. Production

```bash
bash scripts/apply-migrations.sh                # forward-only; see §6
bash scripts/role-grant-diagnostic.sh
```

The diagnostic's exit code is the verdict:

| Exit | Meaning |
|---|---|
| **0** | no quarantine, no platform-wide grants — operationally complete |
| **2** | quarantined grants remain — **not complete**, work the list |
| **3** | platform-wide grants exist — the backfill creates none, so confirm they were deliberate |

**While the exit code is 2, the migration is applied but not finished.**

### On exit 3: what a platform-wide grant still does after 0170

`scopeType='global'` reaches every organization in the deployment. 0170 creates
none and nothing in the codebase issues one any more, so any you find predate
this work. Two consequences worth knowing before you decide whether to keep them:

- **An offboarding cannot revoke one.** Offboarding revokes what the acting
  organization issued — that is the fix for a dual-employed worker losing their
  other job — so a platform-wide grant survives it. It is not silently skipped:
  `workforce.offboardingStatus` reports `platformWideGrants` and
  `workforce.offboardingRevokeAccess` returns `platformWideGrantsUntouched`.
  Close is not blocked on it, because no procedure can clear it and a door with
  no key is not a control.
- **It does not close a company's bootstrap.** `countActiveManagementGrants`
  counts that company's own grants only. Counting platform-wide ones would look
  safer and would lock every organization created after the legacy grant out of
  appointing a first administrator — the platform-wide holder cannot appoint one
  for them either, because `records.roles.grant` takes its organization from the
  actor's own membership.

Clear them by hand, deliberately, with the same reasoning you would apply to a
root account.

---

## 5. Resolving the quarantine

Each quarantined grant is resolved by someone with role-management authority
**in the company the grant belongs to**, through:

```
records.roles.resolveLegacy({ legacyGrantId, reason })
```

It issues a properly scoped grant in the **actor's own** organization and
retires the legacy row with a reason naming its replacement, so both stay
answerable. It is safely repeatable: a second call with the same id finds
nothing rather than granting twice.

**Never resolve one with an `UPDATE`.** Setting `orgRef` by hand skips the
membership check, skips the audit row, and leaves the history saying the grant
always belonged to that company.

Re-run the diagnostic until it exits 0.

---

## 6. Rollback

**The migrations are forward-only. There is no down migration, and this one
could not have a useful one.**

What can be undone, and what cannot:

| | |
|---|---|
| **Schema** | Reversible in principle — drop `orgRef`, narrow the enum, restore the old `activeGrantKey`. |
| **The backfill** | **Not reversible.** `global` was overwritten with `organization`/`unscoped_legacy`, and the original value is not recorded anywhere. Reverting the schema leaves every grant with a scope that no longer means what it did. |
| **Revoked history** | Untouched by 0170 and safe either way. |
| **Resolutions made after deployment** | New grants with their own rows; reverting the schema strands them. |

So the rollback plan is **restore the backup**, not reverse the migration. That
loses everything written since, which is why §2 step 1 is not optional and why
the window should be short and quiet.

If something is wrong but not catastrophic, prefer forward fixes: the
quarantine is inert, so a partly-resolved deployment is safe to leave running
while the list is worked.

---

## 7. What this migration does to authority

| Category | Effect |
|---|---|
| A — one live membership | **Preserved**, now scoped to that company |
| B — several memberships | **Quarantined** — authorizes nowhere |
| C — no live membership | **Preserved**, scoped to the historical single tenant |
| F — malformed branch grant | **Quarantined** |
| Revoked rows | **Untouched** — authorized nothing before, nothing after |

**No category gains authority.** Verified on a real database by gate 3b, and in
`legacyGrantHardening.test.ts` for every shape 0170 can leave behind.
