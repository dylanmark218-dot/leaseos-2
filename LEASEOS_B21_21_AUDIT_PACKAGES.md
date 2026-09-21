# LeaseOS — v21.21 Checkpoint: Audit Package Builder

| | v21.20 | **v21.21** |
|---|---|---|
| Tables | 243 | **246** (+3) |
| Migrations | 55 | **56** |
| Role-authorized procedures | 336 | **342** (+6, `auditRouter.ts`) |
| Externally-gated procedures | 33 | **33** |
| Integration-gated procedures | 2 | **2** |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 84 | **86** (+2) |
| Tests | 1,428 | **1,434** (+6, `auditPackage.test.ts`) |
| Test files | 75 | **76** |
| Parity | 243/243 | **246/246 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots 0016/0017 untouched.

---

## A package asserts nothing new

An audit package is a manifest over records the chain already holds. Six
kinds: **vehicle** (credentials, work orders, defects, mechanic releases,
tires, faults, recall status), **driver** (credentials, verified training,
competencies, duty records), **job** and **customer** (the ticket, its
events, revisions, signatures, rendered documents, adjustments, loads and
disposal tickets), **incident**, and **tax** (finalized or filed GST/HST and
IFTA returns, reviewed CCA schedules). Each item carries its source table,
its reference and its **content hash** — a stored document's own hash is
carried, not recomputed — and the manifest is canonical JSON whose hash is
the package. The cover PDF renders the manifest, its withholdings and its
gaps, and says in its last line what the package is: nothing beyond the
records it names.

## Redactions are listed; gaps are named

Each kind has a **redaction policy** that removes fields and withholds
whole items, and every removal is written on the item that lost it. A job
package and a customer package of the same ticket differ by exactly what the
customer may not see — the restock withheld as *company activity*, the
clocks and the internal ids redacted and listed — and by their manifest
hash. A driver package withholds the medical fitness document **by name**,
with the reason that HR releases it separately; the licence stays. Each kind
has a **completeness rule**, and what should be present and is not is a
named gap: *Disposal ticket for every load — not on file*.

## Released by a second person, with the gaps acknowledged

Preparing is safety's, the office's, the controller's or legal's. Releasing
is the controller's, management's or legal's — **never the preparer's** —
and an incomplete package is released only with **each gap named in the
release note**; a note that acknowledges gaps without naming them is refused.
A prepared package cannot be downloaded; a released one can, and every view,
release and download is a row with its purpose. A released package does
not change: a re-preparation names the old one and, when released,
supersedes it, the old manifest and hash untouched. Withdrawal is a row,
not an edit.

---

## Files

**New:** `0057_audit_packages.sql` (3 tables) · `auditPackage.ts` ·
`auditRouter.ts` (6) · `auditPackage.test.ts` (6)

**Changed:** `recordsAuthorization.ts` (3 permissions, 2 sensitive, 6
mapped) · `routers.ts` · `schema.ts` · drift guards · inventory · generator

## Not built, and named

COR and insurance package kinds (the policies and completeness rules are the
pattern; the item gathers are not written). Package bundles as archives —
the manifest and the cover are stored; the items are referenced by their
storage keys, not copied into a zip. Sending a package by a channel (the
release is the record; delivery is by the person who released it).

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
