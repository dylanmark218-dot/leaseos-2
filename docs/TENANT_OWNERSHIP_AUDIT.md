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

#### Resolution

**One helper served two opposite meanings of the same nullable column.** The
finding's framing — "make it strict like `orgScopeWhere`" — turned out to be
half right, and acting on it uniformly would have broken the product. Which
half is decided by the migrations, not by judgement:

| `bookOrgRef IS NULL` means | tables | read |
| --- | --- | --- |
| the **seeded platform default** (0133 inserts it) | `commercialRoleTypes`, `commercialNumberingPolicies`, `commercialSettings`, `commercialApprovalPolicies`, `commercialCategoryTypes` | both layers — `seededConfigLayer` |
| **ownership was never established** (nothing seeds it) | `vendors`, `organizationCommercialRoles`, `facilityStatements`, `commercialGlAccounts`, `commercialGlMappings` | one layer — `myBookOnly` |

`layerFor` and `numberingPolicyFor` *require* both layers in hand for the first
group; a business that has configured nothing must still inherit role types,
document types and approval tiers. Making that group strict fails 17 tests in
`commercialOffice.db.test.ts` — recorded as MUT-F4e, and the reason this is a
split rather than a tightening.

The second group had no default layer to lose. `commercialGlAccounts` and
`commercialGlMappings` are the sharpest case: the schema comment at 0138 says
"nothing seeded", so every NULL row is one company's chart of accounts, and it
was readable by every member and reachable as a posting target for their
revenue.

Two corrections to the finding as written:

- `organizationRecordLinks` was **already** strict at `links.list`; the audit
  named it in error. Its real defect was elsewhere, below.
- `vendors` was the *inconsistency*, not the rule: `server/db.ts:525`
  (`vendorBookWhere`, feeding `listVendors`/`createVendor`) has read and written
  vendors strictly since 0132. The commercial office was the only reader
  disagreeing with the table's own owner. Closing F4 made them agree, and the
  four fixtures that broke were inserting vendors by raw SQL without a book —
  a state `createVendor` cannot produce.

**A second, sharper leak was found while fixing this one.** `links.set` checks
link exclusivity installation-wide, which is correct — a record may carry one
active link, and a per-book check would let two books both claim the same
facility. But the refusal named the *other book's* counterparty and link
reference:

```
facility 2 is already linked to ORG-MFO20KR (OLINK-MUELK22B-UXFS); end that link first
```

Since the facility directory is deliberately shared, a caller could walk the
facility ids, collect a refusal for each, and read another company's disposal
relationships without ever holding one of their records. The conflict is
inherent to exclusivity and is still reported; the identity behind it is now
given only when the open link is the caller's own.

**Guarded against recurrence.** `server/commercialBookScope.test.ts` derives the
classification from the migrations — does any migration insert a
`bookOrgRef IS NULL` row for this table? — and fails if a table is read through
the wrong helper, if a table is read through both, or if a general-purpose
`bookWhere` returns. It parses the SQL with string literals stripped first,
because the seed prose contains both `;` and unbalanced-looking parens
(`'QuickBooks Online (first export target; core is accounting-neutral)'`) and a
naive scan misclassified three seeded tables.

Mutations, all killed: MUT-F4a (vendors overlaid again), MUT-F4b (GL accounts),
MUT-F4c (facility statements), MUT-F4d (conflict always names the foreign
counterparty), MUT-F4e (seeded layer made strict), MUT-F4f (GL mapping falls
back to an unowned account).

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

#### Resolution

Confirmed on two of the four procedures, and **not** on the other two — the
difference is the part worth recording, because it shows why the fix had to be
structural rather than a find-and-replace of the error code:

| procedure | foreign device | nonexistent device | leaked? |
| --- | --- | --- | --- |
| `device.activate` | NOT_FOUND | NOT_FOUND | no |
| `device.rotateKey` | NOT_FOUND | NOT_FOUND | no |
| `device.revoke` | **FORBIDDEN** | NOT_FOUND | **yes** |
| `sync.receivePackage` | **FORBIDDEN** | PRECONDITION_FAILED | **yes** |

`activate` and `rotateKey` escaped only because they check `userId` before the
organization, so a foreign device fell out as "not found for this user" — an
accident of ordering, not a rule, and one a refactor could undo. `revoke` has no
`userId` check on purpose: revoking is an administrative act over the
organization's fleet, which is precisely why the organization was the only
boundary left and why its mismatch became observable.

`sync.receivePackage` was doubly wrong: a `deviceRef` that exists nowhere was
told "Legacy device has no organization binding and must be re-enrolled", which
is both an oracle and untrue.

So the scope moved **into** the lookup — `loadDevice` now takes the acting scope
and applies `orgScopeWhere`, the same helper as the rest of the checkpoint — and
every call site gets a row it is allowed to see or nothing at all. The refusal
cannot be a partial success either: the row is never loaded, so nothing
downstream can act on it by mistake. The legacy "must be re-enrolled" message is
kept for the case it actually describes, a real row with no binding, which only
the caller with no organization can now reach; for a member an unbound device is
unattributed, and unattributed is not shared.

The tests compare the two answers to each other rather than asserting a message,
so they survive rewording, and they also assert the code is `NOT_FOUND` so a
shared-but-wrong answer does not pass. `activate` and `rotateKey` are pinned
too, although they already held, so the ordering that protects them cannot be
silently reversed.

Mutations, all killed: MUT-F6a (`loadDevice` unscoped again), MUT-F6b (missing
device answers FORBIDDEN), MUT-F6c (sync falls through to the legacy message).

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

## 10. The sync, dedup and offline audit

Requested as its own pass over operators, units, jobs, dispatch, documents,
scans, tracking, outbox, device assignments and offline package metadata, with
one question: **which identities in these paths are tenant-owned, and do they
carry tenant context?**

The answer split more sharply than expected. The record tables in that list are
already covered — they go through `orgScopeWhere`, `coreRecordOwnership` or
`entityScope`, and 0171/0172 gave the tracking chain its ownership and its
tenant-relative numbers. What was **not** covered is the part of the system
where the identifier is chosen by the DEVICE and then used to decide whether two
things are the same record. Four findings, three of them live.

### The pattern

A client-supplied string behind a **global unique index**, used for idempotency
or dedup. Each one is three defects at once:

1. a namespace one company can exhaust, denying another;
2. a merge rule that can join two companies' records because their devices
   happened to agree on a string;
3. an oracle, because the collision is observable.

`deviceSyncNonces` had it right from the start — unique on
`(fieldDeviceId, nonce)` — which is the shape the others have now been given.

### S1 — a sync package could name any evidence record (**high**, fixed)

`sync.receivePackage` takes `evidenceRecordId` as a bare integer per item and
nothing scoped it. The server then read that record's seal, fetched the stored
object out of the blob store, hashed its bytes, wrote `syncPackageItems` and
`syncReceipts` rows against it, and returned a **per-item verdict** saying
whether the hash the caller DECLARED matched.

That is a confirmation oracle over another company's sealed evidence content,
and every one of those reads happened before anything could have refused it —
the same ordering mistake the v23.29 webhook work corrected, where the rule was
set: *filter by tenant before reading or processing tenant material.*

Fixed by checking every item with `evidenceInScope` before the first seal read.
That helper already existed in `db.ts` with the authoritative chain — job, else
capturing user, else the single tenant only — so no ownership needed inventing.
It answers null for "no such record" and "not yours" alike, and the refusal
covers the whole package and names no id: saying which item was out of scope
would rebuild the oracle one record at a time.

### S2 — the conflict lookup is unscoped (**latent**, not fixed, deliberately)

`lookupServerVersion(recordType, recordRef)` takes a caller-supplied ref with no
tenant filter, and a conflict row stores `serverValuesJson` — the server's field
values — which the caller's organization can then read.

Not fixed, because it is **not live**: `SERVER_VERSIONS` is an in-memory `Map`
with a test seam, and the code says so ("without a versioned store for every
record type yet"). There is no store to leak from. Recording it rather than
fixing it, because the fix belongs with the store: when a real versioned store
is wired behind that function, it must take the acting scope and resolve the ref
within it, or this becomes S1 again for every record type at once.

### S3 — `syncPackages.packageRef` was globally unique (**medium**, fixed)

Device-chosen, `.unique()`, and the insert had no catch. One tenant taking a
string meant another tenant's device could never sync under it: the insert
raised a duplicate-key error that surfaced as `INTERNAL_SERVER_ERROR`, which the
device retries forever. Proven exactly that way before the fix.

Now unique per device — `(deviceKey, packageRef)` in 0173 — matching the nonce,
and a genuine repeat from the same device answers CONFLICT with a sentence
instead of an internal error.

### S4 — `evidenceRecords.clientCaptureRef` was globally unique (**high**, fixed)

The worst of the four. An 8-to-80 character string the device picks, globally
unique, and the upload path looked it up **with no scope at all** to decide
"already uploaded":

```ts
const existing = await findEvidenceByClientCaptureRef(input.clientCaptureRef);
if (existing) return { id: existing.id, key: existing.storageKey, url: existing.storageUrl, alreadyUploaded: true };
```

On a collision the caller received another organization's evidence id, storage
key and storage URL, while the evidence they were uploading was discarded
unstored. One request, a disclosure and a data loss. The test proved it
literally: tenant B's upload came back as tenant A's record.

Scoped to the capturing **user**, which is tighter than the organization and
also the truer rule — idempotency here means "this handset is retrying", and two
people in one company carry two handsets whose capture counters are unrelated.
It needs no ownership inference either: `capturedBy` is written from the
authenticated caller, so the scope is a fact about the row rather than a chain
to resolve. 0173 makes the index agree.

### Migration note

0173 assigns **no ownership**. It changes two unique indexes from global to
relative, over generated columns (`COALESCE(capturedBy, -1)`,
`COALESCE(fieldDeviceId, -1)`) for the reason 0172 records — MySQL treats NULLs
as distinct inside a unique index, so a composite over the nullable owner would
constrain nothing on the rows that need it most. `capturedBy` and
`fieldDeviceId` are existing columns with existing values; rows where they are
NULL share the sentinel bucket, which is **stricter** than the
NULLs-are-distinct rule they had before, never looser. Nothing is backfilled and
no row is given an owner it did not already have.

### Two fixtures corrected

Both were constructing states the product's own write paths cannot produce, and
both are the same pattern already corrected twice in this checkpoint (`fieldroute`
`operatorId: 1`, `operationalTruth` `subjectId: 1`):

- `fieldDevice.test.ts` sent `evidenceRecordId: 9` with no evidence row behind
  it. Every other test in that file uploads real evidence first; this one now
  does too.
- `commercialOffice.db.test.ts` inserted vendors by raw SQL with no book. See
  F4.

### Mutations

All killed: MUT-S1a (scope gate removed), MUT-S1b (refusal names the offending
id), MUT-S3a (package row loses its device, so every row shares the sentinel
bucket), MUT-S3b (`packageRef` index global again), MUT-S4a (capture lookup
unscoped again), MUT-S4b (`clientCaptureRef` index global again).

### What this pass did not establish

- **S2 is recorded, not fixed.** See above; the fix belongs with the store.
- **`syncConflicts.conflictRef`, `syncReceipts` and the outbox refs are
  server-minted** (`ref()`), so they are not in this class — a collision there
  would be a random one, not one a tenant can choose. They were not otherwise
  audited.
- **Offline package metadata held on the device** was not examined. This pass
  covers what the server accepts and stores, not what the handset keeps.
- **No claim is made about the other ~230 `.unique()` columns.** The census in
  §8 lists them; this pass looked only at those a client supplies.
