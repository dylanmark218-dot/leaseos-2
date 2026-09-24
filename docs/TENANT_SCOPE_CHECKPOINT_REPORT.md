# v23.30 — the tenant-scope foundation

Final report for the checkpoint opened from **v23.29 (`e162752`)**, delivered on
`feature/tenant-scope-foundation` at **`c8841e4`**.

The objective was to remove the architectural dependency on
`SINGLE_TENANT_ID = "default"` and establish real tenant scoping, **before** the
AI secretary is built. The security invariant held throughout:

> No LeaseOS caller may receive, infer, mutate, link, synchronize, or authorize
> another organization's data merely because two records share an ID, tracking
> number, reference number, device state, or other business identifier.

---

## 1. Verification

| | |
|---|---|
| Gates on final HEAD | **PASS / PASS / PASS** (`c8841e4`, 187s / 187s / 181s) |
| Test suite | **303 files, 4294 tests, 0 failures, 33 skipped** |
| Mutation campaign | **30 mutations, 30 killed, 0 survivors** |
| Test-file type errors | **0** (gate ceiling is 0) |
| Tables / migrations | 413 / 170 |
| Commits | 18, from `e162752` to `c8841e4` |
| Diff | 57 files, +4808 / −329 |

Gates were run after the release marker was bumped, so the three green runs are
on the exact tree being released. A fourth gate was run before the bump, at
v23.29, so the bump records a verified state rather than an intention.

`scripts/mutation-campaign.sh` runs the whole campaign in one pass on the final
head, rather than trusting the runs done alongside each commit — and that
mattered: see §4.

---

## 2. What changed, by defect

Each was **proven live against a two-tenant database before it was fixed**, not
inferred from reading the code.

| | Defect | Severity | Where |
|---|---|---|---|
| F1 | A link could name any record by guessing its integer id | high | `commercialOfficeRouter` |
| F2 | Dispatch trusted the operator, unit, trailer and job ids it was handed | high | `dispatchRouter` |
| F3 | The scanner took ownership from the reference row, not the subject | high | `scanningRouter` |
| F5 | A multi-organization user could not act at all | blocking | `actingScope` |
| F4 | A member read the commercial book's whole unattributed pool | medium | `commercialOfficeRouter` |
| F6 | A device refusal said whether the device existed | low | `deviceRouter` |
| S1 | A sync package could name any evidence record | high | `deviceRouter` |
| S3 | `syncPackages.packageRef` was a global namespace | medium | `deviceRouter` |
| S4 | `clientCaptureRef` collision returned another tenant's file | high | `routers`/`db` |

Two were found while fixing others rather than by the original survey:

- **The link-conflict disclosure.** `links.set` correctly checks exclusivity
  installation-wide, but its refusal named the *other book's* counterparty and
  link reference. Because the facility directory is deliberately shared, that
  let a caller walk facility ids and read another company's disposal
  relationships without ever holding one of their records.
- **S4**, the worst of the set: an 8-character string the device picks, globally
  unique, used to decide "already uploaded". On a collision the caller received
  another organization's evidence id, storage key and storage URL, while their
  own upload was discarded unstored. One request, a disclosure *and* a data loss.

---

## 3. What the architecture now is

**Scope is derived, never supplied.** `resolveActingScope` reads membership and
refuses ambiguity; a client cannot submit `{ "orgRef": "whatever" }`. A
multi-organization user selects a *membership*, and that selection is
re-validated on **both** columns every request, so it cannot outlive the
membership that justified it. Ambiguity is never resolved by taking the first
row.

**Filtering happens before reading.** The rule the v23.29 webhook work
established now holds on the sync path too: a package's evidence is checked
against the acting scope before a seal is read or a stored object is fetched and
hashed.

**Identity is relative to its owner.** 16 unique indexes are now keyed on an
ownership column — 14 on `orgKey`, plus `evidenceRecords.captureOwnerKey` and
`syncPackages.deviceKey` — where before **no** unique index carried one. Two
organizations may both hold FT-000001; they are different records.

**Refusals do not carry information.** "No such record" and "not yours" are one
answer on the device router, the scanner, dispatch and the commercial book.

**Unknown ownership is not shared ownership.** For a member, `orgScopeWhere` is
strict: own rows only. Unattributed rows are not globally searchable and are not
visible to any member.

### On legacy data — the stop condition

**Nothing was backfilled to `"default"`, and nothing was given an owner it did
not already have.**

- `0171` populates `orgRef` only where the authoritative chain proves it (jobs,
  financial entities, invoice, manifest, jobId-or-entityType=JOB). Every leaf
  whose chain ends in NULL — `calibrationSweeps`, `signatoryAuthorities`,
  `trackingSequences` among them — is left UNATTRIBUTED. The columns are
  nullable; no NOT NULL forces a choice.
- `server/trackingOwnershipMigration.db.test.ts` migrates to 0170 in a database
  of its own, seeds, applies 0171 alone, and asserts that **no touched table
  contains the literal `'default'`** and that the columns are still nullable.
- `0172` and `0173` assign no ownership at all; they only change which columns a
  unique index is keyed on. Rows with a NULL owner share a sentinel bucket,
  which is **stricter** than the NULLs-are-distinct rule they had, never looser.

`ownership_unverifiable` is intact and remains a first-class fail-closed state.

---

## 4. What the mutation campaign caught that the tests did not

Run on the final head, the campaign found **one survivor**, and it was a real
gap rather than an equivalent mutant.

**MUT-F3b** removes `orgScopeWhere` from the scanner's reference lookup, and
every existing test still passed. The test covering that path asserts the other
organization's *identifiers* never appear in the response — and they do not:
with the mutation the answer is `ownership_unverifiable`, which names nothing.

But `ownership_unverifiable` and `none` are different dispositions carrying
different reasons, and a number registered nowhere always answers `none`. The
mutant turned the scanner into an oracle: enter numbers, keep the ones that come
back "I cannot attribute this", and you have learned which numbers are
registered in other companies. Withholding the identifiers was not enough; the
two cases had to *be* the same case. A test now asserts exactly that, and the
mutation dies.

Two mutations had already survived their first attempt earlier in the
checkpoint, for the same underlying reason — a guard that was redundant, and a
test that reached the wrong case — and both are recorded in the commits that
fixed them.

---

## 5. Judgement calls worth reviewing

- **F4 is a split, not a tightening.** `bookOrgRef IS NULL` means two opposite
  things: the seeded platform default on the five tables 0133 seeds, and "never
  attributed" on the five nothing seeds. Making all of them strict fails 17
  tests, because a business that has configured nothing would have no role
  types, no document types and no approval tier. `commercialBookScope.test.ts`
  derives the classification **from the migrations**, so a table that gains or
  loses a seeded default is caught rather than trusted to a comment.
- **S4 is scoped per capturing user, not per organization.** Tighter, and truer:
  idempotency there means one handset retrying, and two people in one company
  carry two handsets. It also needs no ownership inference, because `capturedBy`
  is written from the authenticated caller.
- **The `@hash8(bookOrgRef)` suffix on commercial numbers was kept.** It is now
  redundant with `orgRef`, but removing it would point each book at a fresh
  counter starting at 1 and re-issue numbers already printed. That needs a
  counter migration, not a deletion.
- **A device holds material for exactly one organization at a time.** The sync
  namespace exists *underneath* that rule, so a residue surviving an interrupted
  purge can never be read as the new organization's. Unsent captures refuse the
  switch outright — they belong to the organization they were taken under, and
  evidence is retained, never deleted. That is the only place the contract asks a
  person anything.

---

## 6. Not done, and deliberately so

- **The AI secretary is on hold.** No LLM provider and no AI execution path was
  added.
- **S2, the conflict lookup, is recorded and not fixed.** `lookupServerVersion`
  reads an in-memory `Map` with a test seam — there is no store to leak from.
  The fix belongs with the store; the audit says what it must do when one lands.
- **346 tables without an ownership column were not individually traced.** The
  census covers what `db.ts` reaches; tables reached only by the 22 unscoped
  routers have no verified ownership path and none is claimed for them.
- **Whether the facility directory should be global** is a product question,
  still open.
- **Offline package metadata held on the device** was not examined; this pass
  covers what the server accepts and stores.
- **The other ~230 `.unique()` columns** were not audited. Only those a client
  supplies were in scope.

---

## 7. Artifacts

Packaged for `c8841e4`: `leaseos-v23.30-source.zip`, `leaseos-v23.30.bundle`,
`gate-v23.30.log`, `three-clean-gates.tsv`, `LEASEOS_CURRENT_STATE.md`, and
`SHA256SUMS` over all five.

The v23.29 artifacts are **not** on this container — it was recycled since that
checkpoint, so they could not be re-verified here. The v23.29 commit `e162752`
is in this branch's history and in the bundle, so that checkpoint remains
reconstructible; the v23.28 artifacts remain SUPERSEDED / PROVISIONAL — DO NOT
RELEASE wherever they are held.
