# B23.1B — the gate CI actually runs, and tests that own their fixtures

This checkpoint was commissioned to fix a problem that did not exist, and found
two that did.

---

## 1. The premise was wrong, and I wrote it

The B23.1A report said:

> "The CI workflow does not run the database tests. Nothing sets `DATABASE_URL`
> or `WIDGET_DB_URL`, so `ci-gate.sh` is the only path that does, and it is
> invoked by hand."

Every clause of that is false. `.github/workflows/ci.yml` has carried a
`mariadb:10.11` service container, `DATABASE_URL`, and `bash scripts/ci-gate.sh`
since the repository's first commit (`6ae3856`). `WIDGET_DB_URL` is derived
inside the gate script, which is why no workflow sets it. I did not open the
file before writing the sentence.

The `26 failures` figure was wrong too, in a way that mattered. 26 is what a
local run produced against a database reused across many runs; most were the
fixture artefact in §3. On a clean database, B23.1 failed **11 tests in 6
files**, all of them authorization:

```
actingScope.test.ts                 1
oosPolicyApi.test.ts                2
recordsApiAuthorization.test.ts     5
tenantScopeRecords.db.test.ts       1
workforce.test.ts                   1
_core/branchGrantLaundering.test.ts 1
Test Files  6 failed | 304 passed (310)
      Tests  11 failed | 4321 passed | 3 skipped (4335)
```

That is run **#52**, on commit `239f7ea`, from 2026-09-21.

## 2. So what was actually broken

**CI caught B23.1 and nobody was watching.** Every run on this branch has been
red:

| Run | Commit | Checkpoint | Result |
|---|---|---|---|
| #40 | `5a3a6f7` | B23.0 | failure |
| #52 | `239f7ea` | B23.1 | failure — the 11 above |
| #81 | `e5b3eeb` | B23.1A | failure — see below |

And **no branch in this repository is protected**, so no status check is
required and red blocks nothing. The gate was working; the enforcement around
it was not.

### The B23.1A run was red because of the guard I added in B23.1A

Gate 6 checked that the pinned authorization suites had run by grepping the
human reporter's output:

```bash
grep -qE "(✓|❯) *server/$suite" /tmp/vitest-gate.out
```

Locally vitest writes ` ✓ server/x.db.test.ts (20 tests)`, which matches. In CI
it detects the runner and colours the line, so it arrives as
`\e[32m✓\e[39m server/x.db.test.ts` — an escape sequence lands between the tick
and the space, the pattern fails, and the gate reported that
`organizationScopedRoles.db.test.ts` "did not run" on a run whose own summary
said `Test Files 312 passed (312)`.

A guard that goes red when the thing it guards is fine is worse than no guard.
It is how people learn that red means nothing — which is exactly the disease
this checkpoint was asked to cure.

**Fixed by not parsing output written for humans.** Gate 6 now emits
`--reporter=json` alongside `--reporter=basic`, and `scripts/verify-gate-run.ts`
reads the report. The logic is pure, in `server/_core/requiredSuites.ts`, and
`server/requiredSuites.test.ts` hands it synthetic reports containing each
failure: a deleted suite, a suite that stood down, a suite that reports passed
while every case inside it was skipped, a suite that failed, and any
`.db.test.ts` that skipped. It also refuses a run in which **zero**
database-backed cases executed, because "nothing failed" is true of that too.

Eleven suites are pinned by path with a reason each, and a test asserts every
path exists — so renaming a suite and leaving the pin behind fails rather than
leaving a check that looks for a file nobody has.

## 3. Tests that depend on records they did not create

`enforcementApi.test.ts` wrote its enforcement events against `unitId: 127`, a
unit it never created. Each event opens a work order; `shopRouter` resolves that
work order through `workOrderInScope`, which asks `coreRecordOwnership` who owns
the unit. The tenant-scope suites create units from the auto-increment and claim
them for an organization. On a database used once the ids never meet. On one
reused across runs they do, and five releases fail with `Work order N not
found` — a tenant refusal that is entirely correct about somebody else's unit,
and that reads exactly like an authorization bug.

Forty-six database-backed suites contain a literal record id, but most are
opaque payload values that never reach a scope lookup. Rather than guess, the
collision was caused on purpose: a squatter organization claimed every low id
the suites hardcode, and the full suite ran. That named the real set — **4
files, 8 tests**:

| Suite | Was | Now |
|---|---|---|
| `enforcementApi.test.ts` | `unitId: 127` | creates a unit in `beforeAll` |
| `productionPath.test.ts` | `const unitId = 127` | creates a unit |
| `fieldroute.test.ts` | `operatorId: 1` ×3 | `FIXTURE_OPERATOR_ID`, created |
| `operationalTruth.test.ts` | `subjectId: 1` | creates the scan's subject |

A fifth file, `manifestCustody.db.test.ts`, failed the first probe and is
**correctly written** — it creates and claims its own operator, and only broke
because the probe had claimed ownership of ids no row held yet, poisoning them
for whoever created them next. The probe was wrong; the test was not. It now
creates the squatter's rows for real.

`scripts/verify-fixture-isolation.sh` is that experiment, kept: gate 6b, one
minute, four suites against a scratch database where the squatter owns units
1,2,3,27,127,142,144,218,500 and operators 1,2,3,7,9,47,99,221. Verified by
reintroducing `subjectId: 1` and watching it fail.

Order independence, each from an empty database:

```
A  alone                    Tests  67 passed (67)
B  after tenant suites      Tests 119 passed (119)
C  before tenant suites     Tests 119 passed (119)
D  full gate from empty     Tests 4383 passed | 3 skipped
```

## 4. Counts

The gate now prints these itself, and classifies a suite as database-backed by
whether it **reads** `DATABASE_URL`, not by whether its name ends `.db.test.ts`.
The filename rule is the convention for suites that stand down without a
database and undercounts badly — it reports 271 where 1,511 cases ran against a
real server.

| | Files | Passed | Failed | Skipped |
|---|---|---|---|---|
| pure | 183 | 2872 | 0 | 0 |
| database-backed | 130 | 1511 | 0 | 3 |
| **total** | **313** | **4383** | **0** | **3** |

The 3 are explicit `it.skip` in `agentRuntimeApi.test.ts`, unrelated to the
database and carrying their own reasons.

## 5. The check to require

**`CI / test`** — workflow `CI`, job `test`, in `.github/workflows/ci.yml`.

Nothing requires it today. Marking it required on the default branch is a
repository setting, not a file, and this checkpoint does not change repository
settings.

No fast-path job was added. The full gate runs in about seven minutes, and a
second, faster check is the specific way a repository ends up with a green tick
that did not run the database — which is the failure mode this checkpoint
exists to prevent.

## 6. What this does not fix

1. **Platform-wide grants still have no revocation path.** Unchanged from
   B23.1A and deliberately out of scope: fixing it means deciding who may hold
   platform authority.
2. **The production `unscoped_legacy` population is still unknown.** The
   diagnostic answers it; it has not been run against production. The
   deployment checklist still requires it before the migration.
3. **The remaining 42 suites with literal record ids.** Proven not to reach a
   scope lookup today, by the squatter experiment. A new procedure that starts
   resolving one of those ids through ownership would make one of them fail,
   and gate 6b only covers the four that were actually affected.
4. **Every branch in this repository is unprotected.** That is the finding
   behind this whole checkpoint, and it is a setting only the owner can change.
