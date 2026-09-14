# LeaseOS — B20.3 Checkpoint: Authorization Enforcement + Records API

**Date:** 2026-09-07
**Base:** v20.6 (105 tables · 606 tests)
**Output:** v20.7 — **106 tables · 20 migration files · 650 tests · 31 files**

---

## 1. Exact numbers requested

| | |
|---|---|
| Tables | **106** |
| Migration files | **20** (0000–0015, 0018–0021; 0016/0017 still reserved) |
| Tests | **650** |
| Test files | **31** |
| Typecheck | **clean** |
| Production build | **clean** — `dist/index.js` 263.3 kb |
| Records procedures role-authorized | **17 / 17** |
| `protectedProcedure` remaining in `routers.ts` | **85** |

That last number was estimated at "~200" in the previous checkpoint. Measured, it is 85. Reporting
the count rather than carrying the estimate forward.

---

## 2. Active role uniqueness — confirmed broken, then fixed

Demonstrated before touching it:

```sql
INSERT ... (7001,'mechanic',NULL);
INSERT ... (7001,'mechanic',NULL);
SELECT COUNT(*) WHERE userId=7001 AND revokedAt IS NULL;  -- 2
```

`UNIQUE(userId, role, scopeRef, revokedAt)` was inert for exactly the rows it existed to protect: an
active grant is the row where `revokedAt IS NULL`, and MySQL permits unlimited NULLs in a unique
index.

**Fix (0021):** a persistent generated column, NULL for revoked rows and a collision key for active
ones, with uniqueness on the key.

```sql
activeGrantKey AS (CASE WHEN revokedAt IS NULL
  THEN CONCAT(userId,':',role,':',COALESCE(scopeRef,'*')) ELSE NULL END) PERSISTENT
```

Now: `Duplicate entry '7001:mechanic:*'`. Application-level duplicate checks were not used — two
concurrent grants both pass a read-then-write check.

Verified: duplicate refused · revoked row retained with NULL key · regrant allowed · `GP` and `EDM`
independently valid · same branch twice still a duplicate.

---

## 3. The architectural adjustment, taken

B20.2 gave the shop `evidence.read_all` and subtracted billing with a denial. You were right that
this decays — every new sensitive category needs someone to remember the subtraction, and the failure
mode is silent and permissive.

`evidence.read_all` is **gone**, replaced by six categories:

`read_maintenance` · `read_job_operational` · `read_safety_summary` · `read_commercial` ·
`read_personnel` · `read_legal`

A mechanic now holds maintenance and job-operational reads and **has no commercial or personnel read
to be denied**. Denials remain as defence in depth, not as the mechanism. A test asserts each
category is held by someone and not by everyone, and that personnel and legal reads stay off every
operational role.

---

## 4. Definition of done

| Requirement | Status |
|---|---|
| Active-role uniqueness truly enforced | Database-enforced, demonstrated both ways |
| Bootstrap management path | `bootstrapManagementRole` — closes behind itself |
| All 17 records procedures exist | 17 |
| All 17 use role/scope authorization | 17, asserted by static test |
| Driver ownership server-derived | `ownerOperatorId` never an input |
| Roadside returns allowlisted DTO only | purpose-built, `withheldCount` returned |
| Mechanic release verifies actual technician | caller must be the named technician |
| Legal hold release legal-only | management denied, pinned |
| Denials audited | pinned, including roles-held-at-decision |
| Sensitive actions audited | fail-closed policy below |
| Revocation immediate | next request denied, no cached claims |
| Branch scope enforced | cross-branch denied, borrowing across branches denied |
| API-level negative tests | 28 through the real router |
| No records endpoint on bare `protectedProcedure` | 0, statically asserted |

---

## 5. Decisions worth flagging

**Subject spoofing is structurally impossible, not filtered.** `ownerOperatorId`, `defectSeverity`,
`severity`, `unitHeld` and `dangerousGoodsVerified` are absent from the input schemas. The server
loads the operator relationship, reads severity from the defect, derives incident severity from the
reported facts, and leaves `dangerousGoodsVerified` false. A driver sealing a record cannot inject an
`operator` relationship — the server adds its own from the session.

**Audit failure policy, stated rather than accidental.** Sensitive permissions (`roles.grant`,
`legal_hold.*`, `retention.dispose`, `maintenance.*_release`, `evidence.amend`, `evidence.export`)
**fail closed** if the authorization row cannot be written — acting irreversibly with no record of
who authorized it is worse than refusing. Ordinary reads proceed; losing a log line is not a reason
to take the vault offline, and the gap stays visible as an absent row.

**Both pinned security tests are in.** Unknown role + real permission → denied. And a procedure with
no declared permission mapping → `roleProcedure` **throws at wiring time**, so the module fails to
construct. `newSensitiveThing: protectedProcedure` cannot quietly bypass the system.

**Branch semantics.** A global grant reaches everywhere. A branch grant reaches its own branch. When
a resource has no branch, a branch grant still applies — there is no other branch to cross into. A
dispatcher in GP holding office in EDM cannot use the EDM grant to read commercial data about a GP
resource; `effectiveRoles` comes back `["dispatcher"]`.

**Platform admin stayed separate.** `users.role` was not converted into the domain model. An admin is
not automatically a mechanic, HR or legal. Bootstrap is the only transition.

---

## 6. Drift guard

`PROCEDURE_AUTHORIZATION_INVENTORY.md` is committed, with the migration priority order. A test holds
the counts: **85 unreviewed, 2 public, 17 role-authorized**. Adding a bare `protectedProcedure` fails
the build with a message telling the author to gate it or classify it deliberately. The number is
expected to go down; if it goes up, this is what noticed.

---

## 7. Files changed

| File | Change |
|---|---|
| `drizzle/0021_active_role_uniqueness.sql` | **New** — uniqueness fix + `roleBootstrapEvents` |
| `server/_core/recordsAuthorization.ts` | Rewritten — categories, branch scope, sensitivity set |
| `server/_core/trpc.ts` | Branch-aware grants, audit fail-closed policy |
| `server/db.ts` | Scoped role resolution, management count, bootstrap |
| `server/recordsService.ts` | **New** — server-side subject resolution |
| `server/recordsRouter.ts` | **New** — 17 gated procedures |
| `server/routers.ts` | Mounts `records` |
| `PROCEDURE_AUTHORIZATION_INVENTORY.md` | **New** |
| 4 test files | +44 tests |

Two pre-existing tests were updated where the deliberate API change made them obsolete
(`evidence.read_all` removed; role resolution now returns scoped grants). Neither was altered to make
a failure disappear.

---

## 8. Remaining gaps

- **85 procedures in `routers.ts` remain authenticated-only.** Billing, dispatch, operators and
  compliance documents included. This is the security-critical remainder.
- **Bootstrap is a service function, not yet a tRPC procedure.** It cannot be reached over the API at
  all, which is safe but means the first grant is a deliberate server-side act.
- **`queueSend` declares placeholder hashes.** Real per-record hashes need the seal rows joined in;
  the package/ownership/idempotency logic is correct, the declared hashes are not yet the stored ones.
- **Encrypted device storage, Audit Package Builder, OCR filing, duplicate detection** — designed,
  not built.
- **Retention rows still carry no verified statutory source.**
- **Spatial + LoadSense and Integrated Operations branches** — still not supplied.

---

## 9. Next recommended step

**Migrate `routers.ts` in the committed priority order, starting with role administration and
billing.** The mechanism is proven and the inventory names the order. Each procedure needs a
permission, a scope rule and a sensitivity judgement — not a mechanical substitution.

The honest one-line status: *the records surface is authorized; the rest of the API is authenticated
with a working mechanism available and 85 procedures still to move.*
