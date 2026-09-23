# LeaseOS tenant ownership audit

Measured against `e162752` (release v23.29). Every count in this document was
produced by parsing the tree, not estimated. The parser is
`scripts/tenant-census.cjs`; re-run it before trusting any number here again.

This is the survey that precedes the tenant-scope foundation work. It changes no
behaviour.

---

## 1. The headline

LeaseOS is **not** a system where every user is `"default"`. That description,
which this audit set out to confirm, turned out to be wrong in an important way.

`resolveActingScope` (`server/_core/actingScope.ts`) already:

- derives the acting organization from `organizationMemberships`, filtered to
  `status = 'active'` and the effective-date window;
- **refuses** a user with live memberships in more than one organization, by
  throwing `AmbiguousOrganization`, rather than silently picking one;
- never reads a tenant, branch or terminal from client input;
- enforces branch scope for policy writes through `mayScopePolicyTo`.

So the chain the next checkpoint wants —

```
authenticated principal → membership → acting organization → authorization → scoped query
```

— already exists at the top. `"default"` is the value returned when a user has
**no** membership at all.

The real gaps are narrower and more specific than "everything is default", and
they are listed in §7.

---

## 2. What `"default"` actually is

`SINGLE_TENANT_ID = "default"` is an **in-memory sentinel meaning "this caller
belongs to no organization"**. It is mostly not a stored value.

It has two different encodings on disk, which is itself a finding:

| Column family | Tables | "unowned" is encoded as |
|---|---|---|
| `orgRef` / `bookOrgRef` | 37 + 13 | **`NULL`** |
| `tenantId` | 19 | **the literal string `"default"`** |

Every write site follows the same shape:

```ts
orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId
```

and every read the mirror of it. `orgScopeWhere` (`server/db.ts:160`)
defensively accepts both encodings for the unowned case:

```ts
or(isNull(table.orgRef), eq(table.orgRef, SINGLE_TENANT_ID))
```

`"default"` reaches disk in exactly two ways:

1. Into a `tenantId` column, whenever the acting caller has no membership — so
   `acting.tenantId` *is* `"default"`. All 19 `tenantId` tables can hold it; the
   four `NOT NULL` ones (`domainEventOutbox`, `operationalTasks`,
   `workflowInstances`, `workflowNotifications`) always do for such a caller.
2. `server/customerAlertService.ts:33`, the only site that names the fallback
   explicitly rather than inheriting it: `tenantId: args.tenantId ?? SINGLE_TENANT_ID`.

### Classification of every production reader

| Site | Classification |
|---|---|
| `_core/actingScope.ts:43,102` — the definition and the no-membership return | **LEGITIMATE_DEFAULT** |
| `db.ts` (~30 sites) — `orgScopeWhere`, `ownershipScopeWhere`, insert-owner choice, the `*InScope` helpers | **LEGACY_COMPATIBILITY** |
| `_core/coreRecordOwnership.ts:23` — an unowned record belongs to the default scope | **LEGACY_COMPATIBILITY** |
| `_core/entityScope.ts:22,33` — financial entities | **LEGACY_COMPATIBILITY** |
| `_core/commercialApprovalService.ts:29` — `bookOrgRef` null-mapping | **LEGACY_COMPATIBILITY** |
| `hosRouter.ts:148`, `scanningRouter.ts:107`, `printingRouter.ts:29`, `workforceRouter.ts:48`, `restrictedVaultRouter.ts:38`, `commercialOfficeRouter.ts:28`, `automationPolicyRouter.ts` (×5) | **LEGACY_COMPATIBILITY** |
| `customerAlertService.ts:33` — writes the fallback into a `NOT NULL` tenant column for an external recipient | **MUST_BE_TENANT_SCOPED** |

Against the options in the brief, the answer is **(F), a mixture** — and
specifically **(E) an accidental single-tenant shortcut that was later made
explicit and honest**, now serving as **(D) a migration compatibility shim**. It
is not a seeded organization: there is no `organizations` row with
`orgRef = 'default'`, and nothing creates one.

**It must not be removed yet.** It is the only thing standing between a
membership-less caller and a `NOT NULL` constraint violation, and it is what
makes the historical unowned rows readable at all.

---

## 3. Canonical vocabulary

Both terms are real and they mean different things. Neither should be renamed.

| Term | Layer | Meaning | Unowned |
|---|---|---|---|
| `tenantId` | **acting context** — `ActingScope.tenantId`, `TenantScope.tenantId` | who the caller is acting as, right now | `"default"` |
| `orgRef` | **database ownership** — the stored owner of a row | which organization owns this record | `NULL` |
| `bookOrgRef` | **commercial book ownership** | which organization's *book* a commercial record lives in — a second axis, not a synonym | `NULL` |

The boundary is: `tenantId` is what the server decides about a caller;
`orgRef` is what is written on a row. The conversion happens at exactly one
shape, the `=== SINGLE_TENANT_ID ? null : tenantId` ternary, repeated at ~45
sites.

`organizationId`, `organisationId` and `companyId` appear **nowhere** in the
schema. No third term exists and none should be introduced.

`bookOrgRef` deserves emphasis: it is *not* a duplicate of `orgRef`. On
`vendors` both columns exist and mean different things — `bookOrgRef` is the
owning book (and is what scopes vendor reads, `db.ts:497`), while `orgRef` is
the counterparty organization the vendor *is*. Conflating them would be a real
defect.

---

## 4. Ownership census

412 tables. **66 carry a direct ownership column; 346 do not.**

| Column | Tables | NOT NULL | Nullable |
|---|---|---|---|
| `orgRef` | 37 | 12 | 25 |
| `bookOrgRef` | 13 | 0 | 13 |
| `tenantId` | 19 | 4 | 15 |
| `contractorOrgRef` | 1 | 0 | 1 |

And one property that holds across all 412: **243 `.unique()` declarations, and
no unique index anywhere includes an organization column.** Every business
identifier is unique installation-wide. §8 covers what follows from that.

The 346 without a column are not all unprotected. Most are **reachable only
through a parent that is owned**, and `server/db.ts` implements those paths
explicitly rather than by convenient joins:

| Indirection | Mechanism | Covers |
|---|---|---|
| `coreRecordOwnership` | `(recordType, recordId) → orgRef`, types `unit \| operator \| load \| financial_entity` | units, trailers, equipment, operators, work orders, defects, safety plans |
| `jobKeyedScope` | `jobId IN (jobs the scope owns)` | evidence, tickets, loads, charge lines |
| `tripKeyedScope` / `tripRefScope` | `tripId IN (trips the scope owns)` | stops, zone events |
| `trackingScopeSubqueries` | tracking number ∈ {trips, jobs, manifests, field tickets, loads} the scope owns | transfer acknowledgements |
| `documentSubjectOwner` | polymorphic owner → its organization | compliance documents |
| `scanSubjectOwnerOrg` | `CASE subjectType` → ownership or `jobs.orgRef` | scan audits |

### Per-subsystem

Enforcement is measured as: does the router derive an acting scope, and does it
use an org-scoped read?

| Subsystem | Authoritative tenant source | DB column | Scope enforcement | Risk |
|---|---|---|---|---|
| users / memberships | `organizationMemberships` | `orgRef` NOT NULL | `userInScope` — member-of-org, or no-membership for default | **low** |
| device / sync | `fieldDevices.orgRef`, bound at enrollment | `orgRef`, `deviceSyncNonces.orgRef` NOT NULL | every op asserts `d.orgRef === actingOrgRef`; legacy devices refused | **low** (best in tree) |
| webhooks | event `tenantId` | `orgRef` | SQL-scoped subscription query before decrypt (v23.29) | **corrected** |
| jobs / trips / manifests | own `orgRef` | `orgRef` nullable | `orgScopeWhere` | **low** |
| units / operators | `coreRecordOwnership` | none (indirect) | `ownershipScopeWhere` correlated subquery | **low** |
| paperwork / documents | subject's owner | none (indirect) | `documentSubjectOwner`, refuses foreign subject | **low** |
| scanner | scan session → subject | none | fail-closed `ownership_unverifiable` (v23.29) | **high, deliberate** |
| tracking | subject behind the number | **none** | `trackingSubjectInScope` exists but the scanner does not use it | **high** |
| commercial book | `bookOrgRef` | `bookOrgRef` nullable | `bookWhere` — **fail-open to the unowned pool** | **medium** |
| dispatch | none | none | **none — every lookup is by id** | **high** |
| facility directory | none | `orgRef` present, unread | **none** (28 procedures) | **medium, probably intentional** |
| portal (external) | `externalIdentities` → `customerAccountId` | `customerAccountId` | every read scoped to the account; refuses NOT_FOUND | **low, different axis** |
| HOS | acting scope | `hosAttestations.orgRef` | scoped | **low** |
| workflow / outbox / tasks | acting scope | `tenantId` NOT NULL | written from `acting.tenantId`; **drain is global by design** | **medium** |
| AI (agentRuns, assistantQueries, knowledgePassages, retrieval*) | acting scope | `tenantId` nullable | written from `acting.tenantId` | **medium** |

### Router enforcement, counted

53 routers expose procedures.

- 31 derive an acting scope
- 10 use an org-scoped read helper
- **22 have neither**
- 2 accept an organization in their input — both legitimately (see §6)

The 22 without a tenant path, by procedure count:

```
36 portalRouter          ← false positive: scoped on customerAccountId instead
28 facilityDirectoryRouter
14 geoRouter             13 complianceRouter     12 insuranceRouter
11 cashRouter            10 assetRouter          10 portalFundingRouter
 9 projectRouter          9 purchasingRouter      8 dispatchRouter
 7 commercialRouter       7 fuelOpsRouter         7 iftaRouter
 7 invoicingRouter        7 requirementRouter     7 telematicsRouter
 6 auditRouter            6 surfacesRouter        5 gstRouter
 5 movementPermitRouter   3 periodRouter
```

---

## 5. The tracking tables

Both are reached by the scanner, and they are **coupled** — this is the part of
the brief that asked for proof before a migration, and the proof changes the
answer.

### `trackingReferences` (`drizzle/0010`)

```
trackingNumber varchar(64)  UNIQUE  ← globally unique, across all organizations
entityType     varchar(40)
entityId       int
jobId          int NULL
```

It **has** an authoritative ownership path: `(entityType, entityId)`, plus
`jobId`. It does not need an `orgRef` column to answer "who owns this".

### `trackingSequences` (`drizzle/0010`)

```
UNIQUE (sequenceType, branch, periodKey)   ← no organization dimension
```

`nextTrackingNumber` (`server/_core/trackingNumbers.ts`) locks the counter row
on `(sequenceType, branch, periodKey)`. Two organizations on one deployment
therefore share:

- **one counter** — Tenant A minting `FIELD_TICKET` consumes numbers from the
  same run as Tenant B, so each can infer the other's volume from the gaps;
- **one format** — "the stored row's format wins", so whichever organization
  seeds the type first fixes the prefix, separator and width for everyone else,
  and a later organization's `format` argument is silently ignored.

### Why they are coupled

The shared counter is currently **what prevents collisions** against
`trackingReferences.trackingNumber UNIQUE`. Giving `trackingSequences` an
`orgRef` in isolation would make two organizations mint the same number and the
second insert would fail on the unique key.

So the options in the brief do not apply to each table independently:

| Option | Verdict |
|---|---|
| A — `orgRef` on `trackingSequences` alone | **unsafe.** Creates duplicate-key failures against the existing global unique index. |
| A′ — `orgRef` on both, unique becomes `(orgRef, trackingNumber)` | Possible, but `orgRef` must be nullable for legacy rows, and MySQL treats NULLs as distinct in a unique index — this **weakens** uniqueness for the unowned pool, which is where every existing row lives. |
| B — ownership indirectly through `(entityType, entityId)` | **Already true** for `trackingReferences`, and costs nothing. Does not fix the shared counter. |
| C — global on purpose | Defensible for `trackingReferences` (globally unique numbers are a feature on paper). Not defensible for the shared *format*. |
| D — replace | Not justified by anything found. |
| E — fail closed until later | Where the scanner is today. |

This is an **owner decision**, recorded in §8, because the two viable paths have
genuinely different product consequences for customer-visible numbers.

---

## 6. Things that turned out to be fine

Recorded so the next reader does not re-investigate them.

- **`commercialOffice.roles.assign`** and **`securityIncidents.organizationAffect`**
  accept an `orgRef` in their input. Neither lets a caller *become* that
  organization: the acting book still comes from `bookFor(ctx.user.id)` →
  `resolveActingScope`, and the input names a **counterparty** organization as
  data. `roles.assign` additionally verifies the organization exists.
- **`portalRouter`** has no acting scope because it is not on that axis. Every
  one of its 36 procedures scopes to `externalIdentities → customerAccountId`
  and refuses with `NOT_FOUND` ("No such ticket on this account").
- **Refusal style.** `server/db.ts:806` states the rule explicitly: *"'Not
  found' is the only answer for one it may not — never 'forbidden'."* The §12
  information-disclosure requirement is already the established convention on
  the `db.ts` paths.
- **The outbox drain is global on purpose.** `workflowRuntime.claimBatch` takes
  any eligible event regardless of tenant. That is correct for a worker; the
  tenant boundary belongs in what the handler then *does*, and in webhook
  dispatch, where v23.29 put it.

---

## 7. Findings

Ordered by severity. None of these are fixed by this document.

### F1 — `commercialOffice.links.set` mutates a record by id, unscoped (**high**)

`server/commercialOfficeRouter.ts:238`. The target record is fetched by primary
key with **no scope predicate**:

```ts
const record = (await db.select({ id: table.id }).from(table)
  .where(eq(table.id, input.recordId)).limit(1))[0];
```

and then updated inside the transaction. A caller holding
`commercialOffice.linkSet` in book A can pass the integer id of a book-B
`vendor`, `facility`, `customerAccount` or `job` and rewrite it.

Calibration, because the severity is not uniform: the column written is the
*counterparty* column, not always the scoping column. For `vendors` reads are
scoped by `bookOrgRef` and the write sets `orgRef`; for `jobs` reads are scoped
by `orgRef` and the write sets `customerOrgRef`. So this is a **cross-tenant
write and link**, and a direct-id attack — it is not, by itself, a cross-tenant
*read*. It still violates "A cannot mutate B" and "A cannot link to B".

The guard that exists checks the *counterparty* holds the right role in the
caller's book. Nothing checks the *record*.

### F2 — `dispatchRouter` has no tenant path at all (**high**)

`server/dispatchRouter.ts`. `dispatchEligibilityChecks`, `dispatchPostings` and
`dispatchOverrides` are each fetched by id with no org predicate, and awards are
written from them. This is §11's "a dispatcher cannot assign B's operator or
unit", unmet, and a direct-id attack surface.

### F3 — the scanner cannot prove tracking ownership, but the proof exists (**high, and cheap**)

`scanningRouter.existingLinkFor` returns `ownership_unverifiable` for any
tracking number that already exists, because it cannot establish the owner.
But `db.ts:963 trackingSubjectInScope(trackingNumber, scope)` **already
resolves exactly that**, through trip → job → manifest → field ticket → load,
each with a real ownership path. The scanner was never wired to it.

This is the §13 upgrade, and it is mostly a wiring change, not new
architecture. `ownership_unverifiable` stays as the fallback for numbers whose
chain does not resolve.

### F4 — commercial book scope is fail-open to the unowned pool (**medium**)

`server/commercialOfficeRouter.ts:30`:

```ts
bookOrgRef ? or(isNull(t.bookOrgRef), eq(t.bookOrgRef, bookOrgRef)) : isNull(t.bookOrgRef)
```

A **member** organization sees its own rows *and every unowned row*. Compare
`orgScopeWhere`, where a member sees strictly `eq(orgRef, tenantId)`. For
reference tables (`commercialRoleTypes`, where unowned means built-in) that is
intended. It is applied uniformly, including to `organizationCommercialRoles`
and `organizationRecordLinks`, which hold real tenant data.

### F5 — no way to *select* an acting organization (**medium, blocks multi-org**)

`resolveActingScope` throws `AmbiguousOrganization` for a user with two live
memberships. That is the correct fail-closed behaviour and must not be replaced
by "pick the first". But it means a genuinely multi-org user — the contractor
administrator, the consultant, the auditor — **cannot use the system at all**.

The schema is nearly sufficient: `organizationMemberships` already supports many
rows per user and carries `defaultWorkspace`. What is missing is a server-owned
record of *which* membership is currently selected, and a procedure to change
it. Nothing about this can be inferred from the existing schema — it is the one
place this audit recommends adding state.

### F6 — device refusals leak existence (**low**)

`deviceRouter` answers `FORBIDDEN` with "Device organization binding does not
match the active organization", where the `db.ts` convention is `NOT_FOUND`. A
caller can distinguish "this device exists and is another organization's" from
"no such device". Inconsistent with §12 and with the repo's own stated rule.

### F7 — two encodings of "unowned" (**low, but a trap**)

`NULL` in `orgRef`, the string `"default"` in `tenantId`. `orgScopeWhere`
already has to accept both. Any new scoped table inherits the ambiguity.

---

## 8. The identifier namespace is global, and that settles the tracking question

The tracking tables are not special. They are one instance of a system-wide
property that the census found only when the cross-tenant fixtures could not be
written:

> **`drizzle/schema.ts` carries 243 `.unique()` declarations, and not one
> unique index anywhere in the schema includes `orgRef` or `tenantId`.**

Every business identifier is unique across the whole installation:
`jobs.jobCode`, `units.unitNumber`, `fieldTickets.ticketNumber`,
`invoices.invoiceNumber`, `manifests.manifestNumber`, `trips.tripNumber`,
`loads.loadNumber`, `disposalTickets.ticketNumber`,
`employeePayrollProfiles.employeeNumber`, `trackingReferences.trackingNumber`,
and ~230 more.

### What this means

Two organizations on one deployment **cannot both have a ticket `T-000001`**.
Not "should not" — the database refuses it.

That has one sharp consequence for testing, which is how it was found: the
cross-tenant matrix in §11 of the brief asks for "the same ticket number, the
same unit number text, the same job number" in both tenants. **That is not
expressible.** The matrix therefore collides on every business value that is
*not* constrained — customer name, location, operator name, vendor name,
document filename, unit description — and pins the unique-identifier property
itself, so it cannot change silently.

### Why this is not a security defect

The brief's invariant is:

> No LeaseOS caller may … merely because two records share an ID, tracking
> number, reference number, device state, or other business identifier.

A global unique namespace **satisfies** that invariant rather than threatening
it. The requirement is that *ownership* decides access, never the identifier. A
globally unique identifier simply means a number names exactly one record; who
may see that record is still a separate question, answered by `orgRef` /
`coreRecordOwnership`. The defect would be *inferring ownership from the
identifier*, which is precisely what the scanner refuses to do (F3) and what
F1 and F2 currently get wrong.

### The tracking decision, resolved

Against this evidence, **Option 1 is the only proportionate answer** and the
audit no longer treats it as open:

- `trackingSequences` gains an organization dimension for its **format and
  counter** so one business's prefix and width stop being imposed on another,
  and volume stops leaking through shared gaps.
- `trackingReferences.trackingNumber` **keeps its global UNIQUE**. Nothing
  already printed changes meaning, and no uniqueness is weakened.
- The minted number must therefore stay globally distinct, which the
  organization-scoped prefix already achieves.

Option 2 — per-organization sequences counting 1, 2, 3 — would require making
uniqueness composite not on two columns but across the ~237 identifier columns
that share this property, or accepting an inconsistent namespace where some
numbers identify a record and others need an organization alongside them. That
is a system-wide re-architecture, not a checkpoint.

### What remains an owner decision

Only this, and it is a product question rather than a blocking one:

> Is a **shared, globally sequential** numbering run acceptable to the
> business — where Tenant A's ticket numbers contain gaps because Tenant B
> consumed them — provided each organization controls its own prefix and
> format?

If the answer is no, per-organization counters are still reachable under
Option 1 by giving each organization a distinct prefix and its own counter row,
which keeps numbers globally unique *and* locally sequential. That is the
implementation this checkpoint will take unless told otherwise, because it
satisfies both properties at once.

Until the scanner's chain resolves, it stays fail-closed on ownership it cannot
prove, which is correct regardless.

---

## 8b. Tracking dependency list, re-audited before migration

The owner's decision is per-organization counters, with the canonical identity
of a tracking reference becoming `(orgRef, trackingNumber)` rather than a
globally unique `trackingNumber`. Re-auditing immediately before touching the
schema found the change is **not confined to the two tracking tables**.

### Who mints

`nextTrackingNumber` has **12 production call sites** across 8 routers, and
each writes its result into a different table's globally unique column:

| Sequence | Call site | Lands in | That column | Ownership column |
|---|---|---|---|---|
| `CR` | invoicingRouter:107, cashRouter:186 | `customerCredits.creditRef` | UNIQUE | **none** |
| `BB` | invoicingRouter:154 | `billingBooks.bookNumber` | UNIQUE | **none** |
| `INV` | invoicingRouter:158 | `invoices.invoiceNumber` | UNIQUE | **none** |
| `CSW` | requirementRouter:76 | `calibrationSweeps.sweepRef` | UNIQUE | **none** |
| `MRO` | manifestCustodyRouter:165 | `manifestReconciliationOverrides.overrideRef` | UNIQUE | **none** |
| `WO` | cashRouter:225 | `writeOffRequests.requestRef` | UNIQUE | **none** |
| `DSP` | commercialRouter:158 | `disposalTickets.ticketNumber` | UNIQUE | **none** |
| `FT` | closeoutRouter:140 | `fieldTickets.ticketNumber` | UNIQUE | **none** |
| `DLY` | closeoutRouter:223 | `delayEvents.delayRef` | UNIQUE | **none** |
| `SIG` | closeoutRouter:237 | `signatoryAuthorities.authorityRef` | UNIQUE | **none** |
| `ORG` | commercialOfficeRouter:115 | `organizations.orgRef` | UNIQUE | *is* the tenant key |

### What follows

**A per-organization counter cannot be implemented in isolation.** Two
organizations each counting from 1 both mint `INV-2026-000001`, and the second
`INSERT` fails on `invoices_invoiceNumber_unique`. The same for field tickets,
disposal tickets, billing books, credits, write-offs, delays, sweeps and
custody overrides. That is production breakage in invoicing, cash, closeout,
commercial and manifest custody — not a security improvement.

**`ORG` is the one sequence that must stay installation-wide.** It mints
`organizations.orgRef`, which *is* the tenant key: a per-organization counter
for it would need an acting organization in order to create one.

### The ordering constraint

This is the part that decides the shape of the work, and getting it backwards
would introduce the exact defect this checkpoint exists to remove:

> **Every lookup-by-value must be tenant-scoped BEFORE uniqueness is relaxed.**

While `invoiceNumber` is globally unique, `eq(invoices.invoiceNumber, x)`
returns one row and it is unambiguous. The moment two organizations may both
hold `INV-2026-000001`, that same unscoped lookup returns whichever row the
database happens to yield — a cross-tenant read *created by* the change.

Measured reader surface: 34 lookups-by-value across the nine columns
(`invoiceNumber` 16, `ticketNumber` 13, `requestRef` 4, `creditRef` 1), out of
~370 total references.

### Therefore, two phases

**Phase A — ownership, no behaviour change.** Add `orgRef` to the twelve
affected tables, backfill only where the authoritative chain proves it, and
scope every lookup-by-value. Uniqueness stays global and the counter stays
shared throughout, so numbering does not move and nothing can collide. This
phase is pure hardening and cannot break a flow.

**Phase B — the flip.** Replace global uniqueness with `(orgRef, <number>)`
and make the counter per-organization. Small diff, and every reader it affects
was already scoped in Phase A.

Each table's backfill path, from its own authoritative chain:

| Table | Proven through | Legacy rows without it |
|---|---|---|
| `fieldTickets`, `disposalTickets`, `billingBooks`, `delayEvents` | `jobId → jobs.orgRef` | UNATTRIBUTED |
| `invoices`, `customerCredits` | `financialEntityId → financialEntities.orgRef` | UNATTRIBUTED |
| `writeOffRequests` | `invoiceId → invoices.orgRef` | UNATTRIBUTED |
| `manifestReconciliationOverrides` | `manifestId → manifests.orgRef` | UNATTRIBUTED |
| `trackingReferences` | `jobId → jobs.orgRef`, else the subject chain | UNATTRIBUTED |
| `calibrationSweeps` | no ownership chain exists | all UNATTRIBUTED |
| `signatoryAuthorities` | `customerAccountId` is the counterparty, not the owner | all UNATTRIBUTED |
| `trackingSequences` | configuration, owned by nobody historically | all UNATTRIBUTED |

`NULL` means UNATTRIBUTED and nothing else. Per the owner's §5 it is **not**
readable by an ordinary acting organization — unknown ownership is not shared
ownership.

## 9. What this audit did not establish

Kept explicitly, rather than quietly assumed:

- **The 346 tables without an ownership column were not individually traced.**
  The six indirection mechanisms in §4 cover the ones `db.ts` reaches. Tables
  reached only by the 22 unscoped routers have **no** verified ownership path,
  and this audit does not claim one for them.
- **No runtime cross-tenant test has been run.** Every finding here is from
  reading the tree. F1 and F2 are read from the code path and have not yet been
  demonstrated against a live two-tenant database. That is the next step, and it
  is how they should be confirmed before they are fixed.
- **Whether the facility directory is meant to be global** is a product
  question. It is recorded as "probably intentional" because a regulator-approved
  disposal facility list is plausibly shared reference data, not tenant data.
  Nobody has confirmed that.
- **`bookOrgRef` vs `orgRef` on `vendors`** was resolved by reading two call
  sites. The rest of the 13 `bookOrgRef` tables were not audited individually.
