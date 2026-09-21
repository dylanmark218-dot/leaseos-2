# Organization-aware portals — the work this checkpoint did not do

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
