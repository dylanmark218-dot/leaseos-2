# LeaseOS B23.0 — Identity, organization, capability, workspace

**Release:** v23.26 · **Migrations added:** none · **Branch:** `claude/leaseos-auth-workspace-system-t008ad`

One LeaseOS identity. One authentication boundary. Then tenant resolution,
then capability resolution, then workspace routing — in that order, each a
separate question, each answered by the server.

This checkpoint is an authorization architecture, not a login screen. The
login screen is the smallest part of it and the only part that is not
security.

---

## 1. The five words, and why they are not the same word

| Word | Question | Answered by | Lives in |
|---|---|---|---|
| **Identity** | Who are you? | The OAuth provider, then `users.openId` | `server/_core/sdk.ts` |
| **Tenant** | Which company are you acting for? | Your live memberships, plus a verified selection | `server/_core/actingScope.ts` |
| **Role** | What is your job called? | `userRoleAssignments` | `drizzle/schema.ts` |
| **Capability** | What may you do? | `GRANTS` / `DENIALS` → `authorize()` | `server/_core/recordsAuthorization.ts` |
| **Workspace** | Which interface should you see? | Roles ∩ capabilities, over the portal registry | `server/_core/workspaceAccess.ts` |

A role leads to capabilities. Capabilities decide operations. A workspace is a
**window** onto some of them. Collapsing any two of these produces the bug the
whole design exists to avoid:

- Role = workspace → a person who drives and wrenches needs two accounts.
- Workspace = capability → editing client state becomes privilege escalation.
- Tenant = role → "I manage somewhere, therefore let me manage here."

---

## 2. The flow

```
                LeaseOS Account
                      │
               Authentication              (OAuth → session cookie → users row)
                      │
                 Membership                (organizationMemberships, status + term)
                      │
                 Tenant Scope              (resolveActingScope → one orgRef, or a refusal)
                      │
             Capability Resolver           (userRoleAssignments → permissionsFor)
                      │
           ┌──────────┴──────────┐
           │                     │
      one workspace        multiple workspaces
           │                     │
     enter directly       Choose Workspace
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
                  Field       Mechanic     Dispatch
                    │            │            │
                    └──── server authorization ────┘
                                 │
                        roleProcedure(name)
                    capability + branch + tenant
                       + audit row, every time
```

Every arrow above is a place the server can say no, and every one of them
does. The chooser is the only arrow a person sees.

---

## 3. What is new, and what was already there

### Reused, not rebuilt

| Existing system | Used for |
|---|---|
| `users` + OAuth (`sdk.authenticateRequest`) | The single authentication boundary. No second user table, no second session model. |
| `organizations` / `organizationMemberships` (0086) | Tenancy. `defaultWorkspace` had been in that table since 0086 and unused; it is now the remembered preference. |
| `userRoleAssignments` (0020/0021) | Roles. Granted and revoked, never deleted, so "what could they reach in March" stays answerable. |
| `recordsAuthorization.ts` | Capabilities. 355 permissions, deny-beats-grant, fail-closed on unknown roles. Untouched except for one new declaration map. |
| `portalComposition.ts` (`PORTALS`) | The workspace registry. A workspace IS a portal; there is no second list of screens. |
| `roleProcedure` + `authorizationDecisions` | Enforcement and audit. Sign-in, sign-out and every session decision now write to the same table. |
| `TenantScope` + `*InScope` helpers in `server/db.ts` | Cross-tenant refusal. Unchanged; this checkpoint adds tests over it rather than a second mechanism. |
| shadcn/ui + semantic tokens | The screens. Light and dark come from the existing theme, not from new colours. |

### Added

| File | What it is |
|---|---|
| `server/_core/workspaceAccess.ts` | Pure resolver: memberships + grants → organizations, workspaces, active workspace, capabilities, refusal reason. |
| `server/_core/organizationSelection.ts` | The request-scoped organization *claim* (cookie → AsyncLocalStorage). Carries no authority. |
| `server/sessionRouter.ts` | `session.context`, `session.selectOrganization`, `session.selectWorkspace`. |
| `server/_core/trpc.ts` → `sessionProcedure` | Authenticated-but-role-free gate, audited, with a closed list of permitted procedure names. |
| `shared/_core/redirect.ts` | `safeRedirectPath` — one implementation, used by both the server's `Location` header and the client. |
| `client/src/session/*` | Sign-in, choosers, refusals (pure views) and `SessionGate` (the tRPC wiring). |

---

## 4. The two conditions on a workspace

A workspace is offered when **both** hold:

1. the caller holds a role that composes it (`PortalSurface.composedFrom`), and
2. the caller holds **at least one** capability it is built around (`PortalSurface.builtAround`).

Condition 1 is what the shell did before. Condition 2 is what makes the
capability load-bearing: narrow a role's grants and the workspace goes with
them, even though the role name survives.

Adding condition 2 can only ever *remove* a workspace relative to the old
role-only composition. `workspaceAccess.test.ts` asserts that directly, for
every role and every portal it composes — nobody gains a screen from this
change.

**Any-of, not all-of.** A workspace is a window onto a set of capabilities;
holding none means there is nothing behind the window. Holding some is
ordinary — a bookkeeper and a payroll administrator both belong in Finance and
hold different halves of it.

**A personal workspace is not a job.** "My LeaseOS" composes from every role,
so it is present for everyone. It is excluded from the count that decides
whether to ask: a driver holding Field and My LeaseOS does one job and goes
straight in.

**Capabilities are reported per workspace, not per account.** `session.context`
returns the capabilities effective in the *active* workspace, the same rule
`roleActor.ts` applies to widget boards: the driver screen left on a dash mount
or handed to a roadside officer carries the driver's capabilities, not the
dispatcher's, even when one person holds both.

---

## 5. Where a selection lives, and why the two differ

**Organization → an httpOnly cookie.** Around a hundred tenant-scoped readers
call `resolveActingScope(db, userId)` with no parameter to pass a selection
through, and a selection those readers cannot see is a selection that does not
work. The cookie is read once per request into an `AsyncLocalStorage` and
**re-verified against the membership table on every request**. A forged cookie
therefore names an organization the caller has already been proved to belong
to, or it names nothing.

`actingScope.ts` said in its own comment that it would be "the one function
that changes, and every caller inherits the fix". This is that change; no call
site was edited.

**Workspace → the route, plus a remembered preference.** The URL already names
it (`/portal/<key>`), the client sends it as an input, and the server checks
it. What persists is `organizationMemberships.defaultWorkspace` — written only
*after* the selection is authorized, and re-checked against live access before
it is ever honoured, so a stored preference cannot outlive the grant that
justified it.

Neither value is ever proof of anything.

---

## 6. Refusals

| Situation | Result |
|---|---|
| No session | `UNAUTHORIZED`; the sign-in screen; nothing about who exists |
| Every membership ended or suspended | `MembershipRevoked` → `FORBIDDEN`. Access ends with the membership, not the grant |
| Organization suspended or closed | Same. A company an administrator stopped opens for nobody |
| Two live memberships, no valid selection | `AmbiguousOrganization` → `PRECONDITION_FAILED` and the organization chooser — never a guess |
| Member, no role grant | `no_workspace`, with a sentence naming what to ask for |
| Unrecognized role string | Grants nothing (`isDomainRole` fails closed) |
| Workspace not held | `FORBIDDEN` from `session.selectWorkspace`; the screen was never drawn either |
| Workspace not a workspace | `BAD_REQUEST`, named, so a mistyped URL is legible |
| Record in another tenant | `NOT_FOUND` — never `FORBIDDEN`, which would confirm it exists |
| Authorization not evaluable | The client's gate renders `authorization_unavailable`; no screen opens |

No refusal names an organization, a record or the roles that would have
worked. A refusal is not a directory.

---

## 7. What changed about `resolveActingScope`

Three things, all in one function:

1. **Organization status is consulted.** `organizations.status` must be
   `active`. A membership row pointing at no organization resolves as
   `closed`, not as permissive.
2. **An ex-employee is refused rather than dropped into the single-tenant
   fallback.** Someone who *never* had a membership still falls back — that
   path exists for deployments predating organizations and removing it would
   lock out every such user. Someone whose memberships all ended does not.
3. **A verified selection resolves a multi-organization caller**, in place of
   the unconditional `AmbiguousOrganization`. The refusal remains for a caller
   who has selected nothing or selected something that is not theirs.

`AmbiguousOrganization` and `MembershipRevoked` are translated once, in
`roleProcedure`, into `PRECONDITION_FAILED` and `FORBIDDEN`. Before this, an
ambiguous organization surfaced as a 500 — a correct refusal reported as a
broken system.

---

## 8. Audit

Through `authorizationDecisions`, the table every other security decision
already uses. No second logging system, no new table, no migration.

| Event | `procedureName` | Outcome |
|---|---|---|
| Sign-in | `auth.login` | `allowed`, with the method name |
| Sign-out | `auth.logout` | `allowed` / `denied_unauthenticated` |
| Session context read | `session.context` | `allowed` / `denied_unauthenticated` |
| Organization selected | `session.selectOrganization` | as above |
| Workspace selected or refused | `session.selectWorkspace` | as above |
| Every gated operation | its own name | `allowed` or one of four denials |

No token, secret, password or credential is written. The login row records the
actor, the method and the moment.

---

## 9. Tests

**Pure (`server/workspaceAccess.test.ts`, 36 cases, no database):** the
registry projection; roles → capabilities → workspaces; the narrowing
guarantee; capability revocation closing a workspace; per-workspace
capability scoping; single- vs multi-workspace routing; remembered-preference
expiry; organization selection and forgery; every refusal state; redirect
safety.

**Adversarial (`server/sessionWorkspace.db.test.ts`, database-backed):** the
same questions asked with no client at all — `appRouter.createCaller` with a
bare user id. Cross-tenant refusal by id and by list, a forged organization
cookie, a workspace never offered, an ex-employee holding every grant they
ever had, a suspended company, a revoked role, and the anonymous caller.

**Client (`client/src/session/session.dom.test.tsx`, 15 cases):** the screens
render only what the server sent, mark the current choice without relying on
colour, and fail closed on any error code they do not recognize.

**Accessibility:** the sign-in, chooser and refusal screens run the real axe
WCAG A/AA rules at three viewport widths, in the existing suite.

**Census:** `procedureAuthorization.test.ts` pins the `sessionProcedure` name
list, so the one gate an account with no role can pass cannot be used to mount
a fourth procedure unnoticed.

---

## 10. Outstanding — stated, not hidden

**Role grants are not organization-scoped.** `userRoleAssignments.scopeType` is
`global | branch`. A person who is a live member of two companies takes their
role *names* into both. Membership and the tenant-scoped queries isolate the
**data** — the cross-tenant tests prove that — but a dispatcher at company A
who is also a driver at company B currently reads as a dispatcher in both.
Closing it means a migration adding `organization` to `scopeType` plus an
`orgRef` column, and backfilling existing grants against each holder's single
membership. This checkpoint deliberately does not do that, because a migration
that mis-assigns a grant is worse than a documented gap.

**Offline authorization is unchanged, on purpose.** `offlineCapability.ts`
already states the rule — the device is the source of truth for what it
*observed*, never for what that observation *permits* — and this checkpoint
does not weaken it. No authorization snapshot is cached, no workspace is
resolvable without the server, and `AccessDeniedView` carries an
`offline_authorization_unavailable` state so a server-authoritative action
refuses legibly instead of appearing broken. An offline device gains no
privilege from the server being unreachable. A real offline session (a signed,
short-lived, device-bound authorization snapshot with an explicit expiry) is a
checkpoint of its own and is not implied by anything here.

**Session cookies are `SameSite=None`.** Pre-existing, and the organization
selection cookie follows the session cookie's attributes deliberately rather
than inventing its own. The exposure it adds is bounded — the cookie can only
ever select among organizations the caller is a live member of, and every
request re-verifies — but a cross-site request can still steer *which* of a
multi-organization user's companies a request acts in. Tightening `SameSite`
is a deployment-wide decision affecting the existing OAuth flow.

**Invitations are architecture, not UI.** `organizationMemberships` +
`userRoleAssignments` + `records.roles.grant` already support "invite an
employee, grant Driver + Mechanic, they get Field + Mechanic" server-side, and
role assignment is administrative and server-only: nothing in the session
surface can grant a role, and `roles.grant` is held by `management` alone. The
administrator-facing screen for it is not built.

**Two workspaces have no capability difference from a broader role.** `office`
holds everything `safety` does, so the registry's `composedFrom` — not a
capability — is what keeps an office account out of the Safety workspace. That
is the existing registry's design and is preserved rather than widened; see
§4 on why condition 1 was kept.

---

## 11. Recommended next checkpoint

**B23.1 — organization-scoped role grants.** Migration `0169`: add
`organization` to `userRoleAssignments.scopeType` and an `orgRef` column;
backfill each active grant to its holder's single live membership; refuse a
grant whose scope does not match a membership the granter can see; extend
`authorize()`'s scope axis from `branch` to `(organization, branch)`; and
extend `sessionWorkspace.db.test.ts` so a dispatcher at A reads as a driver at
B. That is the one remaining gap between this design and a system that is
multi-tenant in its *authority* as well as in its data.
