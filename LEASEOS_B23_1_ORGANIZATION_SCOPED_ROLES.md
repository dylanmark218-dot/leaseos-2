# LeaseOS B23.1 — Organization-scoped role grants

**Release:** v23.27 · **Migration:** 0170 · **Branch:** `claude/leaseos-auth-workspace-system-t008ad` · **Continues:** `5a3a6f7`

A security checkpoint, not a feature. B23.0 established identity → membership →
tenant → capability → workspace and reported one gap: **role grants carried no
organization**, so a person employed by two companies took their role names
into both. This closes it.

> One person may have one LeaseOS identity and work for several companies.
> That does not mean authority from one company follows them into another.

---

## 1. The migration slot — checked, not assumed

The B23.0 report suggested "migration 0169". **It was wrong, and the check
found it.**

| Lineage | slots ≥ 0168 |
|---|---|
| this branch, `main`, 9 others | `0168_retire_storage_capability_urls` |
| `claude/mobile-hardware-scanner-mzp1e1-v2327` | `0168_movement_permits`, **`0169_print_audit`** |
| `feature/dispatcher-detail-assignment`, `feature/dispatcher-readiness-panel`, `readiness-defect-repair` | **`0169_defect_resolution`** |

So `0169` is occupied by **two different migrations** in other lineages, and
`0168` itself already collides. This branch also carries an existing duplicate:
**`0157`** is used by both `0157_seal_verification_unavailable.sql` and
`0157_signature_device_attestation.sql`.

**Migration head on this branch: `0168`. Allocated: `0170`** — the first slot
free in every lineage.

This matters because `drizzle/meta/_journal.json` has been abandoned since
**0018** (17 entries, snapshots stop at 0007). `scripts/apply-migrations.sh`
globs `drizzle/*.sql | sort`, so the **filename is the entire registry** and a
shared slot lets a merge reorder dependent DDL with nothing noticing.
`server/migrationSlots.test.ts` now pins the one inherited duplicate so a new
one fails the gate.

---

## 2. Survey

### Role assignment schema, before

```
userRoleAssignments(
  userId, role,
  scopeType  enum('global','branch') NOT NULL DEFAULT 'global',
  scopeRef   varchar(64),                -- the branch
  grantedByUserId, grantedAt, revokedByUserId, revokedAt, revokeReason,
  activeGrantKey  AS (CONCAT(userId,':',role,':',COALESCE(scopeRef,'*')))
)
```

**No organization column anywhere.**

### Production readers

| Path | Via |
|---|---|
| `roleProcedure`, `sessionProcedure` | `db.listActiveUserRoles` |
| `recordsRouter` ×4, `widgetsRouter`, `routers.ts` | `db.listActiveUserRoles` |
| `assistantAsk`, `agent`, `portalFunding`, `purchasing`, `surfaces`, `messageBoard` ×4, `dispatch` ×2 | `db.listActiveUserRoleNames` |
| `readinessComposer` | `db.listRoleNamesAnyScope` — **not authorization** (which training a person owes); left alone |
| `_core/commercialApprovalService.decide` | inline query, **no `revokedAt` filter** |
| `commercialOfficeRouter.approvals.requirement` | inline query, **no `revokedAt` filter** |
| `_core/assistantCommitService` | inline query; flattened `scopeType` to a nullable branch |
| `_core/actingScope` | inline query for `branchRefs` / `global` |

Two of those read **revoked grants as live**. Both were fixed here.

### Production writers

| Path | Behaviour before |
|---|---|
| `records.roles.grant` | wrote `scopeType:'global'` whenever no branch was named — i.e. almost always |
| `bootstrapManagementRole` | writes `global` management, once, to open an empty system |
| `workforceRouter.offboardingRevokeAccess` | revoked **every** grant the account held, in every company |
| `db.revokeUserRole` | matched `(userId, role)` only — no scope at all |

There was **no revoke procedure**. Offboarding was the only path.

### The fifteen questions, answered

1. `userRoleAssignments`. 2. `userId`. 3. `scopeType` + `scopeRef`. 4. `global`
meant "everywhere", only because there was nowhere else to write. 5. `branch`
means one branch. 6. **No** — there is no `branches` table; `branchId` is a
bare `varchar(40)` on eight tables with no owner. 7. Only indirectly, through
the holder's membership. 8. No domain role was deliberately platform-level;
`users.role='admin'` is platform but is not a domain role. 9. Yes —
bootstrap. 10–12. Listed above. 13. `permissionsFor` / `authorize`.
14. `workspaceAccess`. 15. None assumed cross-organization roles, because no
fixture had two organizations.

**Decisive finding:** with no `branches` table, a branch cannot tell us its
organization. Deriving one would be exactly the ambiguous relationship §3 warns
about, so a branch grant now names **both**.

---

## 3. The bug, proven

`server/organizationScopedRoles.test.ts`, written before the fix. Dylan drives
for ABC and wrenches for XYZ.

**RED — 20 of 27 failing:**

```
× authorizes the driver at ABC and refuses the mechanic there
  → expected { allowed: true } to match object { allowed: false }
× grants roles.grant at ABC and refuses it at XYZ
  → expected { allowed: true } to match object { allowed: false }
× legal_hold.place: expected { allowed: true } to match object { allowed: false }
```

Acting for **ABC**, an account whose mechanic role was granted only by **XYZ**
could record a mechanic's release. Acting for **XYZ**, an account whose
management role was granted only by **ABC** could grant roles.

**GREEN — 27 of 27**, with the sharper assertion that the other company's role
is not merely outvoted but **absent** from `effectiveRoles`.

---

## 4. Schema — migration `0170`

```sql
scopeType  enum('global','organization','branch','unscoped_legacy')
orgRef     varchar(40) NULL                       -- NEW
activeGrantKey  AS (CONCAT(userId,':',role,':',COALESCE(orgRef,'*'),':',COALESCE(scopeRef,'*')))
INDEX userRoleAssignments_user_org_idx (userId, orgRef)
CHECK userRoleAssignments_scope_shape
```

**The generated key had to be widened or the checkpoint was impossible.**
0021's key is `CONCAT(userId, role, scopeRef)`, so `driver @ ABC` and
`driver @ XYZ` collide on it — the multi-organization case B23.1 exists to
support was *prevented by a uniqueness constraint*. Dropped and re-added
following 0021's own precedent; the column is derived, so no data is lost.

**CHECK, on live rows only** (`revokedAt IS NOT NULL OR …`) — the invariant is
about live authority, and a revoked row was written under the old vocabulary:

| scopeType | orgRef | scopeRef |
|---|---|---|
| `global` | NULL | NULL |
| `organization` | **required** | NULL |
| `branch` | **required** | **required** |
| `unscoped_legacy` | NULL | — |

### Backfill — deterministic, or refused

Classified per **active** grant by the holder's live memberships (active
membership, inside term, active organization — the same definition
`resolveActingScope` uses):

| Category | Treatment |
|---|---|
| **A** — exactly one live membership | attribute to it: `global`→`organization`, `branch`→`branch` |
| **B** — more than one | **`unscoped_legacy`. Never guessed.** Preserved in full, authorizes nothing anywhere, re-granted explicitly |
| **C** — none | `orgRef='default'` (`SINGLE_TENANT_ID`) — what `resolveActingScope` already resolves these callers to. If they later join a real organization the grant stops matching, which is correct |
| **D** — platform | **none created.** The backfill grants `global` to nobody |
| **E** — branch, organization derivable from branch | **does not exist** — no `branches` table. Falls into A/B/C by membership |
| **F** — malformed (`branch` with NULL branch) | quarantined; these read as *unconfined* today |

Category B is the case you singled out, and it is the reason nothing here
guesses: attributing a dual-employed driver's grant would hand real authority
to whichever company the migration picked. Ambiguity is **detectable by query**
rather than silently resolved.

Nothing is dropped, reset or deleted. Revoked rows are history and are left
verbatim — rewriting them into a vocabulary that did not exist when they were
written would make "what could this person reach in March" unanswerable.

---

## 5. How authorization works now

```
request
  ↓ authenticated identity                      (OAuth → users row)
  ↓ verified active organization                 resolveActingScope — membership +
  │                                              organization status + verified selection
  ↓ grants issued BY that organization           grantsInOrganization()
  ↓ branch narrowing, if the grant is confined   authorize(resourceBranch)
  ↓ GRANTS / DENIALS, deny beats grant           authorize()
  ↓ capabilities                                 permissionsFor(scoped roles)
  ↓ workspaces                                   workspacesFor(scoped roles + capabilities)
  ↓ the procedure's own refusal                  roleProcedure
```

**One choke point.** `roleProcedure` now calls
`db.listRoleGrantsInActingOrganization`, which resolves the acting organization
and returns only the grants that company issued. All ~650 gated procedures
inherit the boundary **without one of them being edited** — the same technique
B23.0 used to reach every tenant-scoped reader through `resolveActingScope`.

**Organization is the OUTER axis, checked before branch**, because branch
identifiers are bare strings: `BRANCH-A1` at one company and `BRANCH-A1` at
another are indistinguishable to the branch check. The organization must be
settled first or the branch check defends nothing.

**Universals do not cross it.** Self-scoped permissions (`inbox.read_own`,
`payroll.read_own`, `portal.compose_own`) ride past the *branch* filter as
before, but not the organization filter: holding a grant elsewhere does not
make you somebody here.

**Workspaces are computed from scoped grants, not filtered afterwards** (§13).
The narrowing happens at the top of `resolveSessionContext`, so the response
never carries the other company's authority for a consumer to forget to hide.

### Two silent breakages caught on the way

- `actingScope.global` tested `scopeType === 'global'`. Splitting the enum
  would have made that **false for every administrator**, refusing every
  company-wide policy write. Now `global || organization` — which is what that
  flag has always meant: *not branch-confined*.
- `commercialApprovalService` and `commercialOfficeRouter.approvals.requirement`
  read **revoked grants as live**. A commercial approval is a financial act;
  both now filter revocation and organization.

---

## 6. Write paths

| Path | Now |
|---|---|
| `records.roles.grant` | organization comes from the **actor's verified acting scope**, never the request; target must be a live member of it; writes `scopeType:'organization'` (or `branch`) with `orgRef` |
| `records.roles.revoke` | **new.** Same scoping. A grant another company issued is `NOT_FOUND` here — saying "already revoked" would confirm they hold it elsewhere |
| `db.revokeUserRole` | `organization` is **required**, never defaulted; returns the count revoked |
| `workforceRouter.offboardingRevokeAccess` | revokes only grants **this** organization issued |

An administrator of ABC cannot write a grant into XYZ, because there is no
input for the organization to arrive on.

---

## 7. Security test matrix

| # | Case | Pure | DB |
|---|---|---|---|
| 1 | two orgs, two roles, one account | ✅ | ✅ |
| 2 | forged organization (cookie **and** tRPC input) | ✅ | ✅ |
| 3 | cross-org administrative refusal | ✅ | ✅ |
| 4 | workspace leak + no foreign capability in the response | ✅ | ✅ |
| 5 | branch crossover, incl. identical branch id in another org | ✅ | ✅ |
| 6 | revoked membership, stale role row | ✅ | ✅ |
| 7 | expired membership | ✅ | ✅ |
| 8 | disabled organization | ✅ | ✅ |
| 9 | platform-global, explicit and held by nobody | ✅ | ✅ |
| 10 | malformed scope — DB refuses to represent it | ✅ | ✅ |
| §10 | deny-beats-grant, per organization | ✅ | — |
| §16 | revocation isolation | — | ✅ |
| §21 | request-scoped concurrency | — | ✅ |
| 0170 | same role in two orgs is now insertable | — | ✅ |

---

## 8. Outstanding

**The backfill is unverified against production data.** This sandbox has no
database, so the category counts (A/B/C/F) have not been measured on real rows.
The migration is written so ambiguity is **quarantined rather than resolved**,
which is safe in either direction, but before deploying, run the classification
query against a production snapshot and read the category-B count: those people
lose access until an administrator re-grants them, and they should be told
first.

**`bootstrapManagementRole` still writes `global`.** It runs once, into a
system with no organizations, to open an empty role table; it is gated on
platform admin and closes behind itself. It is the one remaining writer of
platform-wide authority, and it is deliberate. If it is ever run against a
deployment that *already has* organizations, it would create a
platform-wide management grant — worth a follow-up guard.

**`listRoleNamesAnyScope` is deliberately unscoped.** `readinessComposer` uses
it to decide which training a person owes, and a driver confined to one branch
of one company still needs the driver's training. It is not authorization and
is documented as such at both ends.

**Category-C grants use the literal `'default'`.** That matches
`SINGLE_TENANT_ID` and every other single-tenant path in the system, but there
is no `organizations` row for it — as before, because `orgRef` carries no
foreign key anywhere in this schema.

**Role administration has no UI.** Grant and revoke are server procedures; the
screen is B23.2.

---

## 9. Recommended next checkpoint

**B23.2 — organization invitations and employee access administration.**

The backend guarantee this checkpoint just made is what that screen needs to be
safe: an administrator invites someone, assigns Driver + Mechanic, and those
permissions provably cannot escape the company that issued them.
`records.roles.grant` and `records.roles.revoke` are the procedures it drives;
the missing pieces are an invitation record, a membership-creation path, and
the administrative screen itself.

It should also carry the **category-B worklist**: a query of `unscoped_legacy`
grants, per organization, so quarantined access has somewhere to be resolved
rather than sitting unnoticed.

The offline-authorization snapshot (the other B23.2 candidate) should wait —
it is easier to reason about once role administration exists, because the
snapshot has to encode exactly the scoped grant model this checkpoint defined.
