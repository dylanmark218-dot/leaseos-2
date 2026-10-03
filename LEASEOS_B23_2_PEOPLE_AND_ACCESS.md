# B23.2 — People & Access: design

B23.0 resolved an identity into a company. B23.1 made a role speak only for the
company that issued it. Both were built on `organizationMemberships`, and the
survey found the hole underneath them:

> **Nothing in the product has ever created a membership row.** Organizations
> can be created, memberships can be read, `defaultWorkspace` can be written.
> The only thing that has ever inserted a membership is a test fixture.

So this is not an administrative convenience on top of the authorization chain.
It is the chain's missing first link.

---

## 1. What already exists, and is therefore not rebuilt

| Need | Already in the tree |
|---|---|
| Identity | `users.openId` (unique), upserted by `oauth.ts` on every sign-in |
| Membership | `organizationMemberships` — `status active/suspended/ended`, `effectiveFrom`/`effectiveTo`, `defaultWorkspace`, `membershipType` |
| Membership liveness | `membershipIsLive()`, already fail-closed on status, org status and term |
| Role grant / revoke | `records.roles.grant` / `.revoke`, organization-scoped since B23.1 |
| Grantable role list | `GRANTABLE_ROLES` in `recordsRouter.ts` (10 roles; finance roles deliberately absent) |
| Role → workspace | `PORTALS` + `workspacesFor()` + `capabilitiesInWorkspace()` |
| Default workspace | honoured by `workspaceAccess.ts` **only if in the member's open set** |
| Legacy quarantine resolution | `records.roles.resolveLegacy` (B23.1A) |
| Org-scoped offboarding | `workforce.offboardingRevokeAccess` (corrected in B23.1A) |
| Last-admin counting | `countActiveManagementGrants(org)` (B23.1A) |
| Secure token primitive | `_core/externalIdentityPolicy.ts` — `newToken()`, `sha256()`, `INVITATION_TTL_MS`, pure `invitationCheck()` |
| Audit | `authorizationDecisions`, written by every gated procedure |

**No new permission is introduced.** Every People & Access procedure maps to the
existing `roles.grant`, which `authorize()` grants to `management` alone and
which is already in `SENSITIVE_PERMISSIONS` (audit-before-action, fail-closed).

That is deliberately conservative. `personnel.read` reaches dispatcher, office,
HR and payroll_admin, and a roster of who-can-do-what is an access-administration
question rather than an HR-record one. Widening it later is a decision with an
owner; starting wide is not reversible in practice.

---

## 2. Identity binding — the decision the survey forced

`GetUserInfoResponse` is `{ openId, projectId, name, email?, platform?, loginMethod? }`.

**There is no `emailVerified` flag.** The OAuth provider does not tell LeaseOS
whether the address it hands over has been proved. `users.email` is therefore a
display hint and nothing more.

So an invitation is **not** claimed by matching an email address. It is claimed by:

```
authenticated openId  (from the session, already proved by OAuth)
        +
the invitation token  (32 random bytes, shown once, stored only as SHA-256)
```

`emailHint` is stored so an administrator can see who they meant to invite and
so the link can be sent somewhere. It is never consulted when deciding whether
acceptance is allowed. A person who has the token and is signed in joins; a
person whose address happens to match does not.

This is the same construction `externalIdentities` already uses for the customer
portal, and it reuses that module's `newToken`/`sha256`/`invitationCheck` rather
than inventing a second one.

### Consequences

- **Existing LeaseOS user invited by a second company** — acceptance binds to
  `ctx.user.id`, which the session already resolved from `openId`. A second
  membership row appears. No second identity, because nothing creates a user
  except the OAuth upsert keyed on `openId`.
- **A person who has never signed in** — they authenticate first (OAuth upserts
  their `users` row), then present the token. The invitation simply waits. No
  pending-user row, no fake identity, no password.
- **Acceptance cannot be a `roleProcedure`.** The accepter holds nothing in the
  target organization yet — that is the point. B23.0 built `sessionProcedure`
  for exactly this case ("the one gate an account holding nothing can pass"),
  its list is closed in code and pinned by the census, so acceptance is added
  there as `session.acceptInvitation` and the pin moves deliberately.

---

## 3. Organization isolation

Every read and every mutation takes its organization from the actor's verified
acting scope (`actingScopeFor` → `resolveActingScope`), never from an input.
There is no `orgRef` parameter on any People & Access procedure. A cross-boundary
reference answers **NOT_FOUND**, never FORBIDDEN, matching the rule the rest of
the tenant surface already follows: a refusal is not a directory of other
companies.

`organizationInvitations.orgRef` is written from the acting scope at creation and
re-read inside the acceptance transaction.

---

## 4. Last-admin protection

An organization whose final `management` grant is removed cannot appoint anyone:
`records.roles.grant` requires `roles.grant`, and `bootstrapManagementRole`
refuses once any management grant exists — but it is also keyed to the target's
membership, so it is not a general recovery path.

**Invariant:** the last live `management` grant in an organization cannot be
revoked, and the membership carrying it cannot be ended.

Enforced inside the same transaction as the write, with the candidate rows
locked `FOR UPDATE`, so two administrators removing each other concurrently
cannot both pass the check and leave zero. A client-side warning would not do
this; the count and the write must be one atomic act.

This is a refusal, not a redirect: the message names what would be left and asks
for another administrator to be appointed first.

---

## 5. Branch scope is out of scope

B23.1 established there is **no `branches` table** — `branchId` is a bare
varchar on several tables with no canonical source. B23.2 therefore exposes no
branch selector and writes no branch-scoped grants. `records.roles.grant` keeps
its existing `scopeRef` semantics for callers that already use it; People &
Access simply never supplies one. Recorded as a gap for a future checkpoint.

---

## 6. Platform-wide authority is not manageable here

Every grant this surface writes is `scopeType: "organization"` with
`orgRef = acting.tenantId`. There is no input that could select `global`, and
`GRANTABLE_ROLES` contains no platform role. A quarantined `unscoped_legacy`
grant is resolved into the actor's own organization or not at all.

Platform governance remains its own checkpoint (B23.1A/B23.1B risk, unchanged).

---

## 7. Access Needs Resolution — what an Org A administrator may see

An `unscoped_legacy` grant has `orgRef IS NULL`: it belongs to no company, which
is exactly why it authorizes nowhere. The listing shown to an Org A
administrator is therefore **not** "grants belonging to Org A" — there is no such
thing — but:

> live quarantined grants **held by a person who is a live member of Org A**.

That is the same predicate `records.roles.resolveLegacy` already enforces before
resolving. It leaks nothing: the administrator already knows this person works
for them, and the row shows only the role name and when it was granted. It does
not say which other company might have issued it, or that another company exists.

Resolution stays one row at a time. B23.1 quarantined these precisely because
automatic attribution was unsafe; a "resolve all" button would reintroduce the
guess it exists to prevent.

---

## 8. Schema — migration 0175

Slot chosen by enumerating every lineage, not by adding one to this branch's head:

```
0168: movement_permits, retire_storage_capability_urls          COLLISION
0169: defect_resolution, driver_portfolio, print_audit          COLLISION
0170: dispatch_role_types, driver_portfolio_events_append_only,
      organization_scoped_role_grants (this branch)             COLLISION
0171: dispatch_role_assignment_events
0172: training_wallet_renewal_handoff
0173: wallet_history_guards
0174: dispatch_override_provenance                              origin/main
0175: free in every lineage                                     <- allocated
```

Two tables, because §42 is right that an initial-role set is not a JSON blob:

```
organizationInvitations
  id, invitationRef (unique), orgRef, emailHint, displayNameHint,
  tokenDigest (unique, sha256 hex), status(pending|accepted|cancelled),
  expiresAt, invitedByUserId, invitedAt,
  acceptedAt, acceptedByUserId, cancelledAt, cancelledByUserId, cancelReason,
  defaultWorkspace, createdAt, updatedAt

organizationInvitationRoles
  id, invitationId, role, UNIQUE(invitationId, role)
```

`status` is stored for pending/accepted/cancelled only. **Expired is derived**
from `expiresAt` rather than stored, because a stored "expired" needs a sweeper
to be true and is wrong in the window before it runs. `invitationCheck()` already
decides expiry from the timestamp.

A partial-unique index cannot be expressed in MariaDB, so "one live invitation
per (org, email)" is enforced by a generated column that is NULL unless the row
is pending — the same trick 0021/0170 already use for `activeGrantKey`.

---

## 9. Audit

No new audit table. Every mutation is a gated procedure, so
`authorizationDecisions` already records actor, permission, outcome and the
acting organization. Each People & Access mutation additionally writes a
`detail` naming the subject and the change, and `subjectType`/`subjectId`.

**No raw token is ever written** — not to the database, not to a log, not to an
audit row. The digest is stored; the raw value is returned exactly once, to the
administrator who created it.

---

## 10. UI

Under the existing `management` portal, through the existing `PortalShell`
route (`/portal/:portal/*?`). No second application, no new router.

- **People & Access** — Active People, Pending Invitations, Access Needs
  Resolution, Former.
- **Person detail** — membership, roles (from `GRANTABLE_ROLES`, never a second
  frontend registry), resulting workspaces previewed through `workspacesFor`,
  default workspace restricted to workspaces actually held.

The client never decides anything. It previews what the server would compute and
the server recomputes it on every write.

---

## 11. Deferred, with reasons

| Deferred | Why |
|---|---|
| Email delivery | No mail infrastructure exists. Inventing SMTP config is worse than returning the link to the administrator once and letting them send it. A delivery adapter boundary is left where one belongs. |
| Branch assignment | No canonical branch entity (§5). |
| Bulk legacy resolution | Reintroduces the guess B23.1 removed. |
| Platform authority | Its own checkpoint. |
| Reactivating an ended membership | Needs its own authorization story; a new invitation achieves the same thing safely today. |
