# LeaseOS — Remaining Build Register (v22.22, 2026-09-16)

Every item still open across the LeaseOS/FieldRoute portfolio, as **checkpoints with a
definition of done**, in the order they should be built. Where this register says
DONE, the code is on `integration/reconciled-2026-09-16` and the gate proves it.
Where it says a thing needs a device, a licence or a person, no amount of code
completes it — and that is stated rather than papered over.

Ground rules that every checkpoint inherits: inspect before building; additive
changes; one source of truth; provenance on every important value; PROPOSE →
SHOW EVIDENCE → HUMAN CONFIRM → COMMIT; UNKNOWN stays UNKNOWN; the clean-database
gate is green before a checkpoint is called complete.

---

## P0 — reconciliation debt (code exists; it must become one working tree)

| # | Checkpoint | Status | Definition of done |
|---|---|---|---|
| P0.1 | Chat 4 knowledge / HOS tranche (0118–0120) | **DONE** (`4531847`) | licence gate, promotion ledger, verification console, one door to `verified`; 60 tests |
| P0.2 | Chat 5 TDG evidence modules (0121–0122) | **DONE** (`4531847`, `6720087`) | modules wired: coverage authored/approved, aspects derived at issuance, inspector requests; 10 router tests |
| P0.3 | HOS separation of duties (0124) | **DONE** (`6720087`) | `limitPromote` refuses the recorder of an unverified candidate; 5 tests |
| P0.4 | Field-signature design issues | **DONE** (`6720087`) | signed schemas carry no server defaults; refusals are rows; skew reported |
| P0.5 | B28 widget engine onto the branch | **STAGED** (`docs/b28/B28_RECONCILIATION_MATRIX.md`, `archive/b28h-sql/0127–0128`) | the twelve sources resolved (7 as-is, 3 new reads, 1 readiness mount, 1 device-local); apply in the locked phase order; first promotion `myDay`; gate green with `/widgets` served |
| P0.6 | Academy sheet serials (Chat 5 `sheetSerial`, `sheetSerialAllocator`, `academyReadinessBridge`) | OPEN — on `fix/chat5-module-paths-and-vitest` (`54965ee`) | pure modules ported with tests; registry tables as 0125 + guard 0126 (done); the bridge either replaces `readinessComposer`'s academy block or is dropped as a duplicate — **not both** |
| P0.7 | Printable assessment sheets | **DONE (procedures)**: `academy.sheetPrintRun` mints a block under the row lock and registers every sheet (an assessment sheet prints only from an approved item set; practice sheets never become credential evidence); `academy.sheetScanFile` files a returned sheet exactly once (the 0126 trigger refuses a second filing even around the router). The printable HTML (`LEASEOS_FIELD_ASSESSMENT_TICKETS.html` on the fix branch) is still to be served from the Academy portfolio with the s.6.3(1)(c) expiry wording and cached offline for s.6.8 |
| P0.8 | `CA_FEDERAL_NORTH60.daily_on_duty_minutes` | OPEN — STILL CONTESTED in the seed | a verifier with s. 39 open promotes or corrects it through `/hos-verification`; no script |

## P1 — the field runtime must run on a device

| # | Checkpoint | Definition of done |
|---|---|---|
| P1.1 | Android shell (Capacitor) | `client/src/runtime` boots on Android; encrypted SQLite (SQLCipher) behind Android Keystore; the P-256 device key lives in the keystore, never in JS; enrol/activate/push/rotate/revoke exercised on a real device against the 0110 server |
| P1.2 | Camera → sealed evidence | photo bytes hashed on-device before storage; seal recorded; server three-way hash verification passes on push |
| P1.3 | GPS → zone events | fixes queued offline with provenance `gps`; arrival/departure proposed, confirmed by the driver, then committed |
| P1.4 | Biometric signing | platform biometric authorizes a device-key signature; **no fingerprint or face template is ever stored** |
| P1.5 | Pre-departure cache | job, trip, route, tiles, facilities, permits, ERP, SDS cached before departure; `offlineCapability` classes wired; the six UI states (saved locally / queued / syncing / synchronized / failed / conflict) visibly distinct |
| P1.6 | Clock skew UX | the 0124-era refusal text (server time, skew) drives a "fix your clock" prompt instead of a silent retry |
| P1.7 | Native field tests | the 35 server field tests joined by device-side tests run on an emulator in CI |

## P2 — routing runtime and data licensing

| # | Checkpoint | Definition of done |
|---|---|---|
| P2.1 | Province-wide routing service | HERE Routing v8 (approved direction) behind the existing four-axis evaluator (legal / physical / operational / confidence); every result carries dataset version, jurisdiction, verification date; UNKNOWN never rounds to PASS |
| P2.2 | Alberta 511 | API key in env; **commercial use stays BLOCKED** until written permission is stored against `gov-ab-511` in `knowledgeSources` — the source-licence gate enforces this and refuses `rag_ingestion` / `commercial_redisplay` today |
| P2.3 | Bridge / road-ban / municipal truck-route profiles | regulatory profiles loaded as data with source, effective date, version, last verified; routes cite them by version |
| P2.4 | Commercial mapping resources | fuel/cardlock, DEF, water, disposal, scales, weigh stations, parking, washout, repair — each with source and verification state; no fabricated coverage |
| P2.5 | Radio / comms | repeater and dead-zone data only where legally sourced; no invented frequencies; public vs company-private separated |

## P3 — operations completeness (end-to-end chains)

| # | Checkpoint | Definition of done |
|---|---|---|
| P3.1 | Manifest = chain of custody | **PARTIAL**: the `manifests` table (0010 era) references job and unit by id but carries trailer, driver, route, facility as text and scale tickets / evidence / signatures as JSON refs; no trip, load, LSD/UWI, SDS, permit or disposal-ticket foreign keys; no amendment history. Done when every column in the project rule §19 list is a reference to a record, and amendments are rows |
| P3.2 | Field ticket acceptance per line | **DONE**: `closeout.lineDecide` (accepted / disputed, customer quantity and statement kept beside the crew's); `invoicing.draftFromTicket` excludes disputed lines and names them |
| P3.3 | Billing readiness names blockers | **DONE**: `invoicing.draftFromTicket` returns `{ drafted: false, blockers[] }` with named blockers (`invoiceDraft.ts`), including `amended_after_signature`; `closeout.whyTheseHours` explains the hours |
| P3.4 | Signatures + integrity | **DONE**: `fieldTicketSignatures.payloadHash`; supplements carry `siteRevisionHash`; `amended_after_signature` blocks invoicing (`billing.ts`, `invoiceDraft.ts`) |
| P3.5 | Exception Centre completeness | **DONE for the inspector clock** (`0122` → `exceptionCentre.ts`): an open s.6.7 request surfaces from five days out as `high`, becomes `critical` once overdue, names the authority and the due date, deep-links to the request, requires `academy.certificate.issue`, and says when part of the evidence is irrecoverable. The other exception classes in §25 of the project rules were already sources; each still deep-links to its corrective action |
| P3.6 | Tracking numbers | **PARTIAL → engine DONE**: `trackingNumbers.ts` over `trackingSequences` (format is configuration; row-locked counter; 150 numbers across 6 concurrent callers tested). Wired: **FT** and **INV**. Still `ref()`: DLY, SIG, CR, BB, DSP, MF, and every other prefix — one call each; master search is `surfaces.search` |
| P3.7 | Mechanic release | **DONE**: `shop.workOrderRelease` (full / restricted / revoked) is a separate door from `shop.workOrderAdvance`; `evaluateMechanicRelease` gates it; `readinessComposer` consumes the release and refuses to report a unit available on release alone |

## P4 — tenancy, security, governance

| # | Checkpoint | Definition of done |
|---|---|---|
| P4.1 | Multi-company tenant isolation | every core record bound to an organization (0113 started it); the typed-handle audit (`tenantIsolation.test`) extended to every production file; cross-tenant reads refused, tested |
| P4.2 | LoadSense hardware ingestion | gateway frames authenticated (0112/0114 exist); calibration evidence projected; **no weight becomes a legal axle determination without a verified calibration and a stable reading** |
| P4.3 | Contractor / owner-operator payables | **DONE**: `contractorOperations.db.test` drives the 0115–0117 chain through the real router with two organizations — relationship proposed and accepted (never self-accepted), chain numbered from the job code, private rate between exactly the parties, payable prepared from evidence at 10.5 h × $95.00 = $997.50, review before approval, second person approves, both parties see it and a stranger does not; wrong-party rates and salary rates refused by reason |
| P4.4 | AI Secretary corpus | ingestion runs **only** through `repository.ts` behind the source-licence gate; every chunk records its authorizing assessment |
| P4.5 | Legal / licensing | **STARTED**: `LICENSE` (MIT, matching `package.json`; **copyright holder line needs the legal entity's name**); `docs/legal/LEGAL_DOCUMENT_REGISTER.md` lists the twenty instruments drafted in project knowledge with status, owner and the milestone each is needed before — all DRAFT-PK until counsel signs off |
| P4.6 | Privacy & AI governance | 0014/0016/0017 tables get their procedures and UI: device permissions, breach register, agent approvals, regulatory sources + rule versions |

## P5 — showcase, UI, and demos

| # | Checkpoint | Definition of done |
|---|---|---|
| P5.1 | Showcase screens | every screen in the audit's showcase list renders from **records**, not fixtures; a screen backed by a fixture says so on its face |
| P5.2 | Portal shells | driver / dispatcher / office / customer / vendor / facility portals mount only their permitted procedures (7b/7c gates already pin the external counts) |
| P5.3 | Accessibility | the B28h Chromium accessibility suite (48 cases) runs against the real app, three viewports |
| P5.4 | Demo dataset | a seeded, fixture-labelled organization that exercises the full chain end-to-end without touching a real customer or a real regulatory figure |

## P6 — the human-only items (no code completes these)

| # | Item | Who |
|---|---|---|
| P6.1 | Verify the first real HOS figure (`CA_FEDERAL_SOUTH60.daily_drive_minutes`) through `/hos-verification` with the instrument open | a management-role verifier, not the person who seeded it |
| P6.2 | Author and approve the first real s.6.2 coverage mapping for the TDG road course | a course author, then a second person |
| P6.3 | Store written permission (or decline) for 511 Alberta commercial use | Alberta Transportation, then whoever records `permissionDocumentId` |
| P6.4 | Confirm the s.6.7 clock anchor (dated vs received) against the regulation text | counsel or a regulator confirmation, recorded on the regulatory profile |
| P6.5 | Read the northern division's own on-duty section (STILL CONTESTED) | a verifier with s. 39 open |

---

## How to read this register

- **DONE** means committed, migrated, tested and gate-green on the reconciled branch.
- **STAGED** means the plan is exact and the artefacts are in the tree, and the edit itself is a separate checkpoint because the engine's own recipe forbids scripting it.
- **OPEN** means code exists somewhere in the master bundle and has not been reconciled.
- P1–P5 are product work. They are ordered by dependency, not by size, and each row is written so that "complete" can be checked rather than claimed.
- P6 cannot be finished by an AI or a script. Any tool that claims to have done one of these has violated the one invariant the whole architecture exists to hold.
