# LeaseOS — v20.13 Checkpoint: P3 Typed Commit Boundary (candidate promoted)

| | Previous | New |
|---|---|---|
| Version | v20.12.2 | **v20.13** (promoted from `v20.13-dev1`) |
| Tables | 131 | **132** |
| Migrations | 23 | **24** |
| Procedures (role-authorized) | 142 | **142** |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 864 | **886** |
| Test files | 36 | **40** |
| Parity | 131/131 | **132/132** |
| Typecheck | clean | **clean** |
| Build | clean | **clean** — 380.5 kb |

---

## Verdict: the candidate passes and is promoted

The candidate arrived with an explicit and correct request — run it through the
real gate, because the authoring environment had no `node_modules`, no pnpm
registry and no MariaDB, and it declined to fabricate a pass. That was the right
call, and it was worth honouring properly rather than taking the claims on trust.

**Checksum verified** — `a18ec5f0…438563`, matching exactly.

**Structural claims verified before running anything:**

| Claim | Measured |
|---|---|
| 132 tables | **132** in schema, 132 `CREATE TABLE`, 132 live |
| 24 migrations | **24** |
| Static parity 132/132 | **confirmed**, and again against a live database |
| 39 test files | **39** as received |
| Slots 0016/0017 reserved | **untouched** — journal runs 0015 → 0018 |
| Zero bare `protectedProcedure` | **0** |

Nothing was overwritten. The authorization model, universal permissions, verified
source registry and reserved slots all survived intact.

---

## What the gate found

**875 of 878 passed on the first run.** The three failures were exactly the three
DB-backed integration tests the candidate flagged as needing execution — written
but never run.

All three failed on the same thing:

```
You have an error in your SQL syntax ... near 'precision, source, confidence, status)'
```

**`precision` is a reserved word in MariaDB.** The column lives in
`proposalFields`, from migration **0014** — pre-existing trunk, not the
candidate's doing. Drizzle quotes identifiers, so the ORM path works perfectly
and only hand-written SQL breaks. The new test wrote raw SQL and hit it.

One-line fix: backtick the identifier inside the template literal (escaped, since
a bare backtick terminates the string).

**With that fixed, all three pass.** Which means the substantive work —
typed commit adapters, the receipt spine, idempotency replay, the second
authorization gate, destination-record locking — **actually functions against a
real database.** The code was sound; the test's SQL was not.

---

## The improvement: this class of bug, closed

That is the second reserved-word incident. `procedure` was caught in B20.2 and
renamed before release; `precision` shipped in 0014 and lay dormant for months
because nothing had written raw SQL against that table yet.

So I audited **all 1,801 columns across all 132 tables** — not against a keyword
list transcribed from memory, which is exactly the sort of thing that is subtly
wrong, but by asking the running server whether each column parses unquoted.

**Two offenders, in 1,801 columns:**

| Column | Table | Status |
|---|---|---|
| `precision` | `proposalFields` | bit us today |
| `separator` | `trackingSequences` | **has not bitten yet** — it will, the moment anyone writes raw SQL against tracking sequences |

Both predate B20 and both are in released migrations, so they are grandfathered
rather than renamed — altering an applied migration to rename a column is a
larger and riskier change than quoting the call sites.

`reservedWordColumns.test.ts` now holds the line two ways:

- **The DB-backed test re-derives the set from the live server** and asserts it
  equals the grandfathered pair. A new reserved-word column fails the build, so
  it gets renamed *before* release instead of being lived with forever.
- **A source scanner** checks raw SQL literals for unquoted references.

---

## A bug in my own guard, found and fixed

The first version of the scanner flagged `geofence.ts` and `aiProposal.ts`.
Neither contains a single line of SQL — one mentions "precision" in a doc
comment, the other has a TypeScript property called `precision`. The regex was
matching prose near a SQL-ish keyword.

That is the third helper I have written in this project that produced a
confidently wrong answer, and the pattern is consistent: a scanner or harness
that is too loose reports success or failure for the wrong reason. A guard that
cries wolf gets muted, which is worse than not having one.

Rewritten to strip comments and scan **only string literals that actually contain
SQL DML**, with two tests pinning both directions: the two innocent files
produce zero SQL literals, and a deliberately unquoted `INSERT INTO
proposalFields (proposalId, precision)` is still caught while its backticked
twin is not.

---

## Assessment of the candidate's own work

Reviewed and kept as-is:

- **The typed commit boundary is the right shape.** Lock proposal → check
  idempotency receipt → re-run the gate → build an allowlisted typed write →
  **re-read the caller's roles** → independently check the destination permission
  → lock and validate the destination → write → hash provenance → receipt → mark
  committed. The second authorization check matters: `assistant.commit` alone is
  not authority to write a trip stop.
- **No generic write interface.** Two real adapters against forms that exist, and
  no "AI writes whatever table it wants" escape hatch.
- **Refusing to invent identifiers.** `"TRIP-42 unload stop"` is not accepted as
  a database id, and `"10:15"` is not converted to a timestamp without a local
  date and UTC offset — hence `targetRecordId`, `eventDateLocal` and
  `utcOffsetMinutes`, with midnight crossing handled explicitly. That is the same
  discipline as the measurement ladder, applied to time.
- **The receipt spine.** Field provenance including measurement method is hashed
  into the receipt so it does not vanish merely because `tripStops` has no column
  for it.
- **Four pre-existing P3 defects corrected** — persisted proposals rebuilding
  questions from an empty proposal, colliding proposal IDs, `waitMinutes` not
  precision-sensitive, and out-of-schema enums surviving human correction.

---

## Files changed by me

| File | Change |
|---|---|
| `server/assistantCommitService.test.ts` | Backtick the reserved-word column (escaped in template literal) |
| `server/reservedWordColumns.test.ts` | **New** — 8 tests, empirical audit + source scanner |
| `LEASEOS_B20_11_P3_TYPED_COMMIT.md` | Candidate's report, retained |

No schema change by me. Parity unchanged at 132/132.

---

## Genuine blockers — unchanged

**P0** — Spatial Navigation, LoadSense and Integrated Operations source still
never supplied. Slots 0016/0017 reserved and untouched by this candidate.

**AER ST37, ST102, Alberta 511** — inspection-only until written commercial and
offline-redistribution permission.

**P9** — no authoritative tax/HOS/retention rule loaded; determinations correctly
return UNKNOWN.

---

## Exact next tranche

**v20.14 — P3 continued, on top of the boundary that now exists.**

Order: document/photo/PDF extraction and OCR into proposed fields → persistent
question queue → merchant memory → duplicate and document fingerprint detection →
home-base distance → auto-filing into the Evidence Vault → then new forms and
adapters for `expense_receipt`, `disposal_ticket`, loads and manifests.

OCR and AI stay proposal-producing throughout. The typed boundary is what makes
that safe to build against: an extracted value now has one audited, allowlisted,
independently authorized route into an operational record, and no other.
