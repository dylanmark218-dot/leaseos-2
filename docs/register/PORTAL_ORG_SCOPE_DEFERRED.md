# Organization-aware portals — the work this checkpoint did not do

> **Closed by #64 (auth workspace), merged with main 2026-09-25.** The finding below — an ended membership
> falls through to the single-tenant fallback with its role grants intact — no longer holds on the merged
> branch: `resolveActingScope` now refuses a caller whose memberships are all excluded (`MembershipRevoked`,
> "membership is not active"), and refuses two live memberships until one is chosen. A user who never had a
> membership still gets the fallback. `server/actingScopeMembership.test.ts` and `.db.test.ts` were rewritten
> to the closed state. The analysis below is kept as the record of what was found.

The login and portal-chooser checkpoint stops at the edge of tenancy on purpose.
Everything below is known, reachable from the current code, and deliberately unbuilt.

---

## 1. `defaultWorkspace` is a preference, not a grant

`organizationMemberships.defaultWorkspace` is a `varchar(60)`. Nothing validates it on write, no
migration constrains it to a portal key, and until this checkpoint nothing read it at all.

It is now read, carried through `portals.mine`, and **checked at the point of use** against the
portals the session actually composes (`entryModel.resolvePortalEntry`). A value that is stale,
misspelled, or hostile opens nothing — it produces the chooser and a line saying the saved
workspace is no longer available.

**This must stay true.** The column is writable by whatever administers memberships; if it ever
became sufficient on its own to open a portal, a row edit would be a privilege escalation. The
tests in `server/portalEntryModel.test.ts` pin every branch of that: unheld default, non-canonical
default, empty default, and a default that names a portal only some sessions hold.

## 2. Roles cannot vary by organization

`userRoleAssignments.scopeType` is `global | branch`. There is **no organization scope**, so a
grant of `driver` is a grant of `driver` everywhere that user is a member. `composeSession(roles)`
takes roles and nothing else, which is why portals cannot differ per organization today.

This is the single change that everything else in this document waits on, and it is a tenancy and
authorization change rather than a wiring one.

## 3. Multi-organization membership is refused, not resolved

`resolveActingScope` throws `AmbiguousOrganization` for a user with two live memberships. Its header
gives the reason, and the reason is right:

> A user with active memberships in more than one organization is REFUSED rather than resolved:
> picking one would silently decide which company a request writes into.

This checkpoint **did not change that behaviour**. What changed is how it reaches a person:
`organizationStateFrom` turns that one refusal into a state (`ambiguous`) so the screen renders
`OrganizationSelectionRequired` instead of an error that looks like a server fault. Every other
error still propagates as an error, which `server/portalSession.test.ts` pins.

The screen says organization switching does not exist. It does not offer a selector, because a
selector would imply that choosing is possible and safe, and neither is true while §2 holds.

## 4. What an organization-aware design has to cover

Not implemented. Listed so the next checkpoint starts from the whole chain rather than the first
link of it:

```
user
  → organizationMembership          (exists; carries status and effective dates)
  → organization                    (exists)
  → organization-specific role grants   ← MISSING: scopeType has no "organization"
  → acting organization             (exists, but refuses ambiguity rather than selecting)
  → portal composition              (exists; takes roles only, so cannot vary by org)
  → permission evaluation           (exists; unaware of organization)
  → record scope                    (exists per-domain via orgRef / entityScope)
```

Open questions the design has to answer, none of which is a migration detail:

- **Does an organization-scoped grant replace a global one, or narrow it?** The branch scope
  narrows; an organization scope that behaved differently would make `authorize()` read two ways.
- **What happens to the 36 tables already carrying `orgRef`?** They scope records, not grants, and
  the two must not be confused.
- **What does `SINGLE_TENANT_ID = "default"` become** once organizations are real? Every unowned
  legacy row is visible under it today.
- **Selecting an acting organization is a write of sorts** — it decides which company subsequent
  requests act for. Where is it recorded, and is it auditable?
- **`tenantId` and `orgRef` are two names for one idea.** 19 tables carry `tenantId varchar(40)`;
  36 carry `orgRef`. `MoneyScope = { tenantId: string }` holds an orgRef. That reconciliation
  belongs in the same checkpoint, not after it.

## 5. Why it was deferred

`docs/register/SPINE_WIRING_PLAN.md:3` — *"no new engines until this path is wired"* — and all
thirteen spine engines remain in `DECLARED_UNWIRED`. An organization scope on `userRoleAssignments`
is a migration plus a change to the one resolver every caller inherits, which is tenancy
architecture rather than a router over existing state.

What this checkpoint built instead is entirely a router over what already exists: no migration, no
new table, no new column, no change to `resolveActingScope`, `authorize`, `roleProcedure` or
`composeSession`'s signature.

## 6. Not hidden on the client

The limitation is visible rather than worked around:

- Two live memberships → `OrganizationSelectionRequired`, which states plainly that LeaseOS does
  not yet support choosing between them.
- No database → `unresolved`, which is distinct from `single_tenant_fallback`. "The question could
  not be asked" and "this deployment has no organizations yet" are different facts, and reporting
  the second for the first would claim isolation nothing established.
- No composed portal → `NoPortalAvailable`, naming how many exist that the session does not reach.

None of these is solved by granting something.

---

## 7. `claude/leaseos-auth-workspace-system-t008ad` — SUPERSEDED, do not merge

**SUPERSEDED — do not merge with the canonical portal implementation.**

A second branch implemented the same login/workspace feature more broadly. The owner's decision is that
the narrow implementation on `claude/login-portal-chooser` is canonical, because the broader branch
crosses architectural boundaries that were explicitly deferred.

It has **no pull request open**, so nothing was closed; this entry is the record. **Its history is not
deleted** — the research below is worth keeping, and one of its findings is real.

What it introduced that this checkpoint deliberately does not:

| Its change | Why it is not adopted here |
|---|---|
| A new `sessionProcedure` gate | A second session gate beside `roleProcedure` is a second authorization path. |
| The acting organization in a **cookie**, re-verified per request | A new authority-bearing channel. Even re-verified, establishing it incidentally through a login PR settles a tenancy design nobody reviewed. |
| **Capability-gated** portal composition | It changes what a portal *means*: today a role composes one, and requiring a capability as well is a product decision about visibility, not a wiring fix. |
| `AmbiguousOrganization` → an organization chooser | Offering a choice implies choosing is safe. It is not, while role grants carry no organization scope (§2). |

**We agree on the diagnosis.** That branch reached the same conclusion recorded in §2 — role grants
carry no organization scope — and also recommended that migration as the next checkpoint. The
disagreement is only about what may be built before it.

### Ideas preserved for later checkpoints

- **Membership expiry** — a real finding, investigated and recorded in §8 below.
- **An organization chooser** — belongs with the organization-aware authorization design in §4, not
  before it.
- **A safe post-login return destination** — already implemented here, by allowing one shape rather
  than stripping bad ones: `entryModel.safeReturnPath`. It is stored in session storage rather than
  carried in the URL, and re-sanitised on the way out. Carrying it in the OAuth `state`, as that
  branch does, is a reasonable alternative and not a gap.
- **Capability-aware portal composition** — needs its own design decision first, per the table above.

---

## 8. Does an ended membership lose access? — investigated, with evidence

Asked directly, traced through the canonical path, and answered with tests rather than assumption:
`server/actingScopeMembership.test.ts` (13 cases, the effective-date window against a fake database)
and `server/actingScopeMembership.db.test.ts` (10 cases, the `status` filter and the whole path through
`appRouter.createCaller` → `portals.mine`, against real MariaDB).

### Every invalid membership state IS excluded

`resolveActingScope` filters two ways — `status = 'active'` in SQL, and the effective-date window in
JavaScript. Both work. Proven for: a suspended membership, an ended one, one that has not started, one
whose end date has passed, and the half-open boundary (a membership ending exactly now is already out,
so there is no extra day of access). Two live memberships are still refused rather than resolved.

**Their former organization's records are gone**, because those rows carry its `orgRef` and the caller
no longer resolves to it. The cross-tenant boundary holds.

### What does NOT happen: they are not locked out

A caller with no surviving membership is not refused. They fall through to `single_tenant_fallback`
and act as the deployment's default tenant — **indistinguishable from a user who never had a
membership at all**, which is asserted directly in both suites.

And their authority survives, because ending a membership writes nothing to `userRoleAssignments`:
that table is queried on `revokedAt IS NULL` only. So the grants stand, `roleProcedure` still passes,
and portals still compose. `portals.mine` returns a working session for an ex-employee.

### Is this a security defect?

**It is a real gap, and its severity depends on the deployment.** What survives is reach over rows
that belong to *nobody* — unowned legacy rows from before organizations existed, which the `default`
scope matches. In a deployment with no such rows the practical exposure is small; in one migrated from
the single-tenant era it is not.

The operational rule it implies is worth stating plainly: **offboarding must revoke role grants.
Ending the membership alone does not end access.**

### A smaller thing the investigation turned up

`organizationMemberships.effectiveFrom` and `effectiveTo` are MariaDB `TIMESTAMP`
columns, so their range ends at 2038-01-19 03:14:07 UTC and a membership dated past that
is a rejected INSERT rather than a far-future membership. A membership meant to run
indefinitely therefore has to leave `effectiveTo` NULL; a sentinel far-future date does
not express "no end", it fails in strict mode. `server/actingScopeMembership.db.test.ts`
pins it, so nothing has to rediscover it.

### Why it was not fixed here

The obvious correction is small — distinguish "has no membership row at all" (the legitimate fallback,
for deployments predating organizations) from "has membership rows, none currently live" (refuse). A
few lines inside `resolveActingScope`.

It was not made in this checkpoint because the change is not as small as it looks:

- `resolveActingScope` is read by roughly a hundred tenant-scoped callers. A new refusal reaches every
  one of them, and it would need to be a state the routers can render — as `AmbiguousOrganization`
  now is — rather than a 500.
- It changes who can log in, which is a behavioural change to an authorization boundary and deserves
  its own review rather than riding along inside a login-screen PR.
- The complete answer probably is not in this resolver at all: if ending a membership should end
  access, the grants should end with it, and that is the organization-scoped-role work in §2.

**Recorded as a security finding for a dedicated authorization checkpoint**, not worked around, and
not hidden: the tests above assert the current behaviour, so the day it changes, they say so.
