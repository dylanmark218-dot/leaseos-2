# Pre-existing security findings — verified and fixed, 2026-09-21

Six findings raised by a ten-dimension review of the codebase (not of the import
work). Each was then verified independently, in its own git worktree, by an agent
told to refute it. Three of the six were partly overstated and the overstatements
are recorded beside the fixes, because a finding that survives with its
exaggerations intact teaches the wrong lesson the next time.

None of these were introduced by this session's work. They are in the tree as
imported.

| # | Finding | Verdict | Reachable today | Severity | Fixed |
|---|---|---|---|---|---|
| 1 | Branch-confined grants laundered into global | partly confirmed | **yes** | high | yes |
| 2 | Passport discloses why private evidence fails | partly confirmed | no¹ | medium | yes |
| 3 | Vault by-id paths skip the org scope | confirmed | no² | medium | yes |
| 4 | Vault mutations outside the fail-closed set | partly confirmed | no³ | low | yes |
| 5 | Untiered vault read serves a row unaudited | partly confirmed | **yes** | low | yes |
| 6 | Client storage keys unvalidated | confirmed | **yes** | low | yes |

¹ Only because every shipped requirement seed is `unverified`, which short-circuits
before credentials are read. No code change is needed to reach it — a controller
loading a verified medical requirement is a documented, supported step.
² Only because `organizationMemberships` has no production writer, so every caller
resolves to the single tenant. It becomes live the moment that table is populated.
³ Requires the authorization-decision insert to fail.

---

## 1. Branch-confined grants were laundered into global ones (high, live)

`authorize()` has a stated fail-closed rule: when the caller has not resolved the
resource's branch — which is every generic gate — a branch-confined grant "does
not apply; only a global grant passes". `roleProcedure` honours it by passing
`RoleGrant[]`, which carries `scopeRef`.

`listActiveUserRoleNames` dropped `scopeRef`, and thirteen call sites fed bare
names back into `authorize({roles})` or `permissionsFor(roles)`.
`normalizeGrants` turns a name into `{ role, scopeRef: null }` — a **global**
grant. Proven by execution, not by reading:

```
authorize({grants:[{role:"safety",scopeRef:"YEG"}], permission:"incident.review"})  -> denied
authorize({roles:["safety"],                        permission:"incident.review"})  -> allowed
```

Same person, opposite answers. The widened grants were the sole content filter
for `surfaces.search`, `chain`, `timeline`, `exceptions` and `inbox`, gated
attachment disclosure on the message board, and fed two **authority ladders** —
`routeApproval`'s spend tiers and `overrideRoleFor`'s dispatch override.

This is precisely the class the structural gates cannot see. Every one of those
procedures *is* behind a `roleProcedure`; the widening happens inside the
handler, after the gate passed, so "0 bare `protectedProcedure`" stays true while
the answer is wrong.

**Fix.** `listActiveUserRoleNames` now returns global roles only, which makes the
projection obey `authorize`'s own rule instead of quietly undoing it. It narrows
and can never open anything that was closed.

The one consumer that genuinely wants every role got a named alternative rather
than being swept along: `readinessComposer` feeds roles into Academy training
bindings, and a driver confined to one branch is still a driver who owes the
driver's courses. Narrowing there would have stopped demanding a required course
— the same class of failure as over-granting, pointed the other way. It now calls
`listRoleNamesAnyScope`, which is documented as not for authorization.

Making the safe projection the *default* is the point: a consumer added later
gets it without knowing any of this.

**Overstated in the original finding:** it read as though any confined user gains
access. They do not — `roleProcedure` already denies a confined-only user at the
gate, so escalation needs the user to also hold some global role that passes it.
And `portalFundingRouter` is navigation, not a boundary.

`server/_core/branchGrantLaundering.test.ts`.

## 2. The passport explained why private evidence failed (medium)

`Credential.privateDetail` was declared and read nowhere — a field shaped like a
filter that filtered nothing, which is worse than no field, because the next
reader assumes it is honoured.

The module's header swears dispatch "never learns why not", and
`medicalFitnessForDispatch` keeps that promise by flattening rejection and expiry
alike to `eligible: "no"`. `evaluateRequirement` did not: it returned
`evidence_rejected`, with the prose "evidence was rejected on review", against a
requirement titled *Commercial medical (45–65: every 3 years)* — for any operator
id a caller names, to any of the ten roles holding `compliance.passport.read`,
drivers and dispatchers among them. That one bit is a medical judgement about a
named person.

**Fix.** `privateDetail` is now load-bearing for the states that disclose *why*.
A private credential that is rejected or unverified yields `evidence_withheld`,
carrying the same effect — dispatch still has to act — and a reason that says the
detail is with the office.

Deliberately narrow: `satisfied`, `expiring` and `expired` keep their dates,
because `compliance.medicalEligibility` already releases that expiry as
`reviewDue` under the same permission. Hiding it here would remove a renewal
reminder without closing anything. Expiry is administrative; rejection is a
judgement.

**Overstated:** the passport does not name the certificate — `loadCredentials`
never selects title, identifier or storage fields into the `Credential` shape —
and the effect ladder was already isomorphic to the sanctioned projection. The
genuine residue was the one bit above.

**Not fixed, and worth its own decision:** `subjectId` is unscoped on
`compliance.passport`, `jobPassport` and `medicalEligibility` alike. That is a
broader question than this finding, and `complianceDocuments` has no `orgRef`
column, so the `scopeWhere`/`orgOf` idiom cannot be applied to it as-is.

`server/compliancePassport.test.ts`, five cases.

## 3. Vault by-id paths skipped the org scope (medium, latent)

`restrictedVaultRouter` defines `scopeWhere` and `orgOf` and applies them on
every list path. Every by-id path resolved `orgRef` and then used it only to
stamp the audit row, never to constrain the lookup — `restrictedRead`,
`grantRevoke` (read and update), `investigationDecide` (read and update).

A by-id lookup missing the predicate is not a smaller version of the same query.
It is a different one, answering about every organization at once.

**Fix.** All five statements now carry `scopeWhere`, matching the list paths in
the same file.

**Overstated:** `breakGlass` writing a grant for an unowned record is real but
inert once `restrictedRead` is scoped — the read returns NOT_FOUND before the
grant is consulted. It remains a junk write into another org's audit stream.

## 4. Vault mutations sat outside the fail-closed set (low)

`roleProcedure` refuses a sensitive action whose authorization row cannot be
written. `restricted.read` was not in `SENSITIVE_PERMISSIONS`, and it gates
break-glass grant creation, revoking another person's grant, and the decision
that opens an internal investigation. Likewise `portal.invitation.accept`, which
activates an external identity and mints a 90-day bearer token, was outside
`EXTERNAL_SENSITIVE_PERMISSIONS` while `portal.credential.manage` — governing the
lesser token rotation — was inside it.

**Fix.** Both added. No permission invented, no grant moved, so nobody's reach
changes.

**Refuted:** the claim that the map is "inverted relative to consequence" because
these mutations map to `restricted.read` rather than `vault.matter.manage`. The
GRANTS table says the opposite — `restricted.read` is held by `management` alone,
while `vault.matter.manage` is held by safety, office and management. The naming
misleads; the reach does not.

`server/_core/vaultFailClosed.test.ts`, verified by removing each membership and
watching the corresponding case fail.

## 5. The untiered vault read served a row unaudited (low, live)

`restrictedRead`'s doc comment says "Logs before it fetches; a refusal is logged
too." For a matter whose tier is INTERNAL or CONFIDENTIAL it returned the whole
row before any of that — so the one path meant to be the audited read was the one
path that wrote no audit row, and `accessHistory`, the surface an auditor
consults, showed nothing.

**Fix.** That arm now writes a `restrictedAccessEvents` row with decision code
`NOT_RESTRICTED_SERVED`, on the same reasoning as `restrictedIndex`: a disclosure
that needs no grant is still a disclosure.

## 6. Client storage keys were unvalidated (low, live)

`normalizeKey` stripped leading slashes and nothing else — no `..` rejection, no
confinement — while `server/storage.ts`'s header states the invariant it assumed:
keys are server-authored.

The finding named three procedures accepting a client key. There are **six**
(seven fields). The inconsistency it flagged is wider than stated too: the sibling
`storageUrl` field carries a refinement on three of the very objects whose
`storageKey` had none.

**Fix.** `server/_core/storageKey.ts` holds a pure predicate: every
slash-separated segment must be an ordinary name and neither `.` nor `..`. All
six inputs use it, and `normalizeKey` enforces it at the last point before a
presign request — making a bad key unconstructable rather than merely unsent.

Two things worth recording. The predicate lives in its own module because nine
suites mock `./storage` with a literal object, and any new export from that file
breaks them at import. And the first draft of the predicate **was wrong**: `.` is
in the character allowlist because real keys have extensions, so the allowlist
alone accepted `..`. The traversal case caught it before it shipped.

`server/_core/storageKey.test.ts`, 16 cases, including every key shape the server
itself mints — a validator that rejects legitimate uploads is worse than none.

---

## Appendix: an intermittent CI failure, not root-caused

`server/bulkFuel.test.ts:169` failed once in CI with `expected 600 to be 300` —
`ifta.quarter` reporting twice the litres it should for one entity.

What was ruled out, by reading rather than assuming:

- **Not a refusal that still writes.** The test's first dispense is expected to be
  refused on a meter mismatch, and a doubled figure would follow if the refusal
  persisted a row anyway. It does not: `fuel.dispenseRecord` performs the meter
  check before any insert.
- **Not a scoping defect.** `loadQuarter` filters `fuelTransactions` by
  `financialEntityId` and by the quarter's bounds. The aggregation is correct.
- **Not this branch's doing.** The failing commit changed a single markdown file,
  and the commits either side of it passed with that suite's code untouched.

What is left is a collision on the fixture's entity id, which the test drew as
`950000 + Math.floor(Math.random() * 40000)` and then used as the key for an
aggregate query. Two fixtures on one id do not read as two tests; they read as
one test that dispensed twice.

The id is now derived from the auto-increment of the unit the same test creates
one line above, so it cannot repeat within a run.

**Stated plainly: this is not a confirmed root cause.** No other suite was found
allocating in that band, so the collision partner is unidentified, and it could
not be reproduced here — the suite needs MariaDB. The change removes the only
mechanism the evidence supports and makes the test deterministic either way. If
it recurs, the cause was something else and this appendix is the record of what
has already been eliminated.
