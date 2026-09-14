# LeaseOS — B20.2 Checkpoint: Server-Enforced Domain Authorization

**Date:** 2026-09-07
**Base:** v20.5 (103 tables · 569 tests)
**Output:** v20.6 — 105 tables · 20 migrations · **606 tests**

---

## 1. The gap this closes

I went to expose B20 through tRPC and found the prerequisite missing.

**There was no server-side domain authorization anywhere in the application.** Every operational
procedure in `routers.ts` uses `protectedProcedure`, which asks one question: *is someone logged in*.
`users.role` is `('user','admin')`. `dispatchRoles` is a job-posting concept — a role code on a
posting, not a grant to a person. Nothing else in 103 tables carried a permission.

So a shop account and an office account were the same account as far as the server was concerned. The
role separation the records vault assumes — shop staff walled off from billing, dispatch not reading
injury details — existed in the design document and in task assignees, and nowhere in the request
path. Invariant #14 says dispatch must be server-enforced and never rely on disabled buttons; the
same is true of every category boundary B20 introduced.

Building the records procedures on top of that would have shipped an authorization model that was
documentation.

---

## 2. Completed

**`userRoleAssignments`** — ten domain roles (`driver`, `dispatcher`, `mechanic`, `shop_lead`,
`safety`, `office`, `management`, `hr`, `legal`, `auditor`), granted and **revoked rather than
deleted**, so *"what could this person do in March"* stays answerable.

**`authorizationDecisions`** — every decision recorded, **denials included**. A refused attempt to
open an incident investigation is exactly what an audit wants and exactly what a permissive system
never captures.

**`recordsAuthorization.ts`** — the pure decision engine:

- **Fails closed.** Unrecognized role strings are discarded, not trusted. A typo, or a role from a
  migration that has not shipped, grants nothing.
- **Deny beats grant, across combined roles.** Someone who is both a mechanic and an auditor still
  cannot read billing — collecting roles must not launder a denial.
- **Grants written out per role**, not composed from inheritance. An inheritance graph is where a
  permission ends up somewhere nobody intended and nobody notices.
- **Named refusals.** `"mechanic is explicitly denied billing.read"`, not `"Not permitted"`.

**`roleProcedure()`** in `trpc.ts` — enforces a permission server-side, writes the audit row, and
throws `FORBIDDEN` with the named reason.

---

## 3. Boundaries now enforced rather than assumed

| Boundary | Enforced |
|---|---|
| Shop staff reach prior defects and inspections but **not customer billing** | explicit denial overriding a broad read grant |
| Dispatch knows a unit is unavailable, **not why the operator is in hospital** | `incident.read_summary` granted, `incident.read_investigation` denied |
| A driver reaches **their own** records only | `authorizeRecordScope` — unowned is not "yours" |
| A release is signed by **the technician who performed it** | `authorizeMechanicRelease` — no signing on someone's behalf |
| Management can **revoke** a release but not **grant** one | signing off ≠ performing the work |
| Management can **place** a legal hold but only legal can **release** one | release is deliberately narrower |
| Payroll is **HR alone** | see below |
| An auditor can read and export, and **write nothing** | asserted across every write permission |

---

## 4. Bugs found

### 4.1 `procedure` is a reserved word in MariaDB

The audit column was named `procedure`. Drizzle quotes identifiers so inserts worked, and the schema
applied cleanly — but any raw SQL touching the column fails with a syntax error, which is how it
surfaced. Renamed to `procedureName` before 0020 went anywhere. A migration that only breaks for the
next person to write a hand-rolled query is a landmine, not a working migration.

### 4.2 A test of mine encoded a careless assumption

I wrote a test asserting management inherits `payroll.read`. It failed — the grants don't include it,
and **the grants were right**. Seniority is not a reason to widen a data category; needing it for the
job is, and management doesn't. The test was corrected to assert payroll is HR alone, which is the
stronger claim. Noting it because the rule is not to make a failing test green — it's to work out
which side is wrong first, and this time it was the test.

---

## 5. Files changed

| File | Change |
|---|---|
| `drizzle/0020_domain_role_assignments.sql` | **New** — 2 tables |
| `drizzle/schema.ts` | +2 tables, +2 insert types |
| `server/_core/recordsAuthorization.ts` | **New** — permission engine + procedure map |
| `server/_core/trpc.ts` | `roleProcedure()` — server-side enforcement + audit |
| `server/db.ts` | role grant / revoke / resolve, audit write |
| `server/_core/recordsAuthorization.test.ts` | **New** — 30 tests |
| `server/recordsAuthorizationDb.test.ts` | **New** — 7 DB-backed tests |

Slots `0016` / `0017` remain reserved for the spatial and LoadSense branches.

---

## 6. Verification — full gate, clean database

| Step | Result |
|---|---|
| 20 migrations, fresh DB | PASS — 105 tables |
| `verify-parity.sh` | PASS — 105 / 105 |
| `tsc --noEmit` | PASS — clean |
| `vitest run` | PASS — **606 / 606**, 29 / 29 files |
| `pnpm build` | PASS — `dist/index.js` 201.4 kb |

569 → 606 (**+37**). No existing test modified.

---

## 7. Remaining gaps — read this before assuming the API is secure

- **The records procedures themselves are not written yet.** `roleProcedure()` and the permission map
  exist and are tested; the router that uses them does not. `RECORDS_PROCEDURE_PERMISSIONS` currently
  declares intent for 17 procedures, and a test asserts every one maps to a permission some role can
  hold — but no procedure is wired.
- **The ~200 existing procedures in `routers.ts` still use `protectedProcedure`.** Nothing in this
  build changed them. Billing, dispatch, operators and compliance documents remain
  authenticated-only. Migrating them is a larger, separate piece of work and should not be assumed
  done because the mechanism now exists.
- **No role is assigned to anyone.** `userRoleAssignments` is empty. With fail-closed semantics, every
  `roleProcedure` denies until roles are granted — correct, and it means bootstrapping the first
  management grant needs a deliberate path.
- **Encrypted device storage, Audit Package Builder, OCR filing, duplicate detection** — still
  designed, not built.
- **Spatial + LoadSense and Integrated Operations branches** — still not supplied.

---

## 8. Next recommended step

**Write the records router against `roleProcedure`, then migrate `routers.ts` off
`protectedProcedure`.**

The second half matters more than it sounds. Right now the system has a correct, audited gate
protecting zero procedures, sitting beside two hundred that check only for a login. Until that is
addressed, the honest description of the API is *authenticated-only with an authorization mechanism
available* — not *authorized*.

I'd sequence it: bootstrap grant path → records router → highest-sensitivity existing procedures
(billing, payroll-adjacent, compliance documents) → the rest.
